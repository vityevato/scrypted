import { HikvisionCamera } from "../../hikvision/src/main"
import sdk, { Camera, Device, DeviceCreatorSettings, DeviceInformation, FFmpegInput, Intercom, MediaObject, MediaStreamOptions, Reboot, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, LockState, Readme } from "@scrypted/sdk";
import { PassThrough } from "stream";
import { RtpPacket } from '../../../external/werift/packages/rtp/src/rtp/rtp';
import { createRtspMediaStreamOptions, RtspProvider, UrlMediaStreamOptions } from "../../rtsp/src/rtsp";
import { startRtpForwarderProcess } from '../../webrtc/src/rtp-forwarders';
import { HikvisionDoorbellAPI, HikvisionDoorbellEvent } from "./doorbell-api";
import { SipManager, SipRegistration } from "./sip-manager";
import { parseBooleans, parseNumbers } from "xml2js/lib/processors";
import { once, EventEmitter } from 'node:events';
import { timeoutPromise } from "@scrypted/common/src/promise-utils";
import { HikvisionLock } from "./lock"
import { HikvisionEntrySensor } from "./entry-sensor"
import { HikvisionTamperAlert } from "./tamper-alert"
import * as fs from 'fs/promises';
import { join } from 'path';
import { makeDebugConsole, DebugController } from "./debug-console";

const { mediaManager, deviceManager } = sdk;

const PROVIDED_DEVICES_KEY: string = 'providedDevices';


const SIP_MODE_KEY: string = 'sipMode';
const SIP_CLIENT_CALLID_KEY: string = 'sipClientCallId';
const SIP_CLIENT_USER_KEY: string = 'sipClientUser';
const SIP_CLIENT_PASSWORD_KEY: string = 'sipClientPassword';
const SIP_CLIENT_PROXY_IP_KEY: string = 'sipClientProxyIp';
const SIP_CLIENT_PROXY_PORT_KEY: string = 'sipClientProxyPort';
const SIP_SERVER_PORT_KEY: string = 'sipServerPort';
const SIP_SERVER_ROOM_NUMBER_KEY: string = 'sipServerRoomNumber';
const SIP_SERVER_PROXY_PHONE_KEY: string = 'sipServerProxyPhone';
const SIP_SERVER_DOORBELL_PHONE_KEY: string = 'sipServerDoorbellPhone';
const SIP_SERVER_BUTTON_NUMBER_KEY: string = 'sipServerButtonNumber';

const DEFAULT_ROOM_NUMBER: string = '5871';
const DEFAULT_PROXY_PHONE: string = '10102';
const DEFAULT_DOORBELL_PHONE: string = '10101';
const DEFAULT_BUTTON_NUMBER: string = '1';

const OPEN_LOCK_AUDIO_NOTIFY_DURASTION: number = 3000  // mSeconds
const UNREACHED_REPEAT_TIMEOUT: number = 10000  // mSeconds

function channelToCameraNumber(channel: string) {
    if (!channel)
        return;
    return channel.substring(0, channel.length - 2);
}

enum SipMode {
    Off = "Don't Use SIP",
    Client = "Connect to SIP Proxy", 
    Server = "Emulate SIP Proxy"
}

export class HikvisionCameraDoorbell extends HikvisionCamera implements Camera, Intercom, Reboot, Readme {
    locks: Map<string, HikvisionLock> = new Map();
    entrySensors: Map<string, HikvisionEntrySensor> = new Map();
    tamperAlert?: HikvisionTamperAlert;
    sipManager?: SipManager;

    private controlEvents: EventEmitter = new EventEmitter();
    private doorOpenDurationTimeout: NodeJS.Timeout;
    private debugController: DebugController;

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);

        this.debugController = makeDebugConsole (this.console);
        // Set debug mode from storage
        const debugEnabled = this.storage.getItem ('debug');
        this.debugController.setDebugEnabled (debugEnabled === 'true');
        
        this.updateSip();
    }

    destroy(): void
    {
        this.sipManager?.stop();
        this.getEventApi()?.destroy();
    }

    async getReadmeMarkdown(): Promise<string> 
    {
        const fileName = join (process.cwd(), 'DOORBELL_README.md');
        return fs.readFile (fileName, 'utf-8');
    }
    
    updateSip() {
        (async () => {

            if (this.sipManager) {
                this.sipManager.stop();
                delete this.sipManager;
            }
            const mode = this.getSipMode();
            if (mode !== SipMode.Off)
            {
                this.sipManager = new SipManager (this.getIPAddress(), this.console, this.storage);

                switch (mode) {
                    case SipMode.Client:
                        await this.sipManager.startClient (this.getSipClientCreds())
                        break;
                
                    default:
                        let port = parseInt (this.storage.getItem (SIP_SERVER_PORT_KEY));
                        if (port) {
                            await this.sipManager.startGateway (port);    
                        }
                        else {
                            await this.sipManager.startGateway();    
                        }
                        this.installSipSettingsOnDevice();
                        break;
                }
            }
        })();
    }

    getHttpPort(): string {
        return this.storage.getItem('httpPort') || '80';
    }

    override async listenEvents() 
    {
        let motionTimeout: NodeJS.Timeout;
        const api = this.getEventApi();
        const events = await api.listenEvents();

        let ignoreCameraNumber: boolean;

        let motionPingsNeeded = parseInt(this.storage.getItem('motionPings')) || 1;
        const motionTimeoutDuration = (parseInt(this.storage.getItem('motionTimeout')) || 10) * 1000;
        let motionPings = 0;
        events.on('event', async (event: HikvisionDoorbellEvent, doorNo: string) => {

            if (event === HikvisionDoorbellEvent.CaseTamperAlert)
            {
                if (this.tamperAlert) {
                    this.tamperAlert.turnOn();
                }
                else {
                    event = HikvisionDoorbellEvent.Motion;
                }
            }
            if (event === HikvisionDoorbellEvent.Motion) 
            {
                motionPings++;
                this.motionDetected = motionPings >= motionPingsNeeded;
                clearTimeout(motionTimeout);
                // motion seems to be on a 1 second pulse
                motionTimeout = setTimeout(() => {
                    this.motionDetected = false;
                    motionPings = 0;
                }, motionTimeoutDuration);
            }
            else if (event === HikvisionDoorbellEvent.TalkInvite) 
            {
                this.binaryState = true;
                setImmediate( () =>{
                    this.controlEvents.emit (event.toString());
                });
            }
            else if (event === HikvisionDoorbellEvent.TalkHangup) 
            {
                this.binaryState = false;
                setImmediate( () =>{
                    this.controlEvents.emit (event.toString());
                });
            }
            else if (event === HikvisionDoorbellEvent.Unlock 
                || event === HikvisionDoorbellEvent.Lock)
            {
                // Update specific lock based on doorNo
                const lockNativeId = `${this.nativeId}-lock-${doorNo}`;
                const lock = this.locks.get (lockNativeId);
                
                if (lock) {
                    const isUnlock = event === HikvisionDoorbellEvent.Unlock;
                    lock.lockState = isUnlock ? LockState.Unlocked : LockState.Locked;
                    this.console.info (`Door ${doorNo} ${isUnlock ? 'unlocked' : 'locked'}`);
                    
                    clearTimeout (this.doorOpenDurationTimeout);
                    
                    if (isUnlock) {
                        const timeout = (await this.getClient().getDoorOpenDuration (doorNo)) * 1000;
                        this.doorOpenDurationTimeout = setTimeout ( async () => {
                            lock.lockState = LockState.Locked;
                            this.console.info (`Door ${doorNo} locked automatically after duration: ${timeout}ms`);
                        }, timeout);
                        
                        setTimeout(() => this.stopRinging(), OPEN_LOCK_AUDIO_NOTIFY_DURASTION);
                    }
                } else {
                    this.console.warn (`Lock for door ${doorNo} not found`);
                }
            }
            else if (
                (event === HikvisionDoorbellEvent.DoorOpened 
                || event === HikvisionDoorbellEvent.DoorClosed)
            ) 
            {
                // Update specific entry sensor based on door state and doorNo
                const sensorNativeId = `${this.nativeId}-entry-${doorNo}`;
                const entrySensor = this.entrySensors.get (sensorNativeId);
                
                if (entrySensor) {
                    const isOpen = event === HikvisionDoorbellEvent.DoorOpened;
                    entrySensor.binaryState = isOpen;
                    this.console.info (`Door ${doorNo} sensor: ${isOpen ? 'opened' : 'closed'}`);
                } else {
                    this.console.warn (`Entry sensor for door ${doorNo} not found`);
                }
            }
        })

        return events;
    }

    override createClient() {
        return new HikvisionDoorbellAPI(this.getIPAddress(), this.getHttpPort(), this.getUsername(), this.getPassword(), this.console, this.storage);
    }

    override getClient(): HikvisionDoorbellAPI {
        if (!this.client)
            this.client = this.createClient();
        return this.client as HikvisionDoorbellAPI;
    }

    override async getConstructedVideoStreamOptions(): Promise<UrlMediaStreamOptions[]> {
        if (!this.detectedChannels) {
            const client = this.getClient();
            this.detectedChannels = (async () => {
                const isOld = await this.isOld();

                const defaultMap = new Map<string, MediaStreamOptions>();
                const camNumber = this.getCameraNumber() || '1';
                defaultMap.set(camNumber + '01', undefined);
                defaultMap.set(camNumber + '02', undefined);

                if (isOld) {
                    this.console.error('Old NVR. Defaulting to two camera configuration');
                    return defaultMap;
                } else {
                    try {
                        return await this.getClient().getVideoChannels (camNumber);
                    }
                    catch (e) {
                        this.console.error('error retrieving channel ids', e);
                        this.detectedChannels = undefined;
                        return defaultMap;
                    }
                }
            })();
        }
        const detectedChannels = await this.detectedChannels;
        const params = this.getRtspUrlParams();

        // due to being able to override the channel number, and NVR providing per channel port access,
        // do not actually use these channel ids, and just use it to determine the number of channels
        // available for a camera.
        const ret = [];
        let index = 0;
        const cameraNumber = this.getCameraNumber();
        for (const [id, channel] of detectedChannels.entries()) {
            if (cameraNumber && channelToCameraNumber(id) !== cameraNumber)
                continue;
            const mso = createRtspMediaStreamOptions(this.getClient().rtspUrlFor(this.getRtspAddress(), id, params), index++);
            Object.assign(mso.video, channel?.video);
            mso.tool = 'scrypted';
            ret.push(mso);
        }

        return ret;
    }

    override updateDevice() 
    {
        const twoWayAudio = this.storage.getItem ('twoWayAudio') === 'true';

        const providedDevices = JSON.parse(this.storage.getItem(PROVIDED_DEVICES_KEY) || '[]') as string[];

        const interfaces = this.provider.getInterfaces();
        if (twoWayAudio) {
            interfaces.push (ScryptedInterface.Intercom);
        }
        interfaces.push (ScryptedInterface.BinarySensor);
        interfaces.push (ScryptedInterface.Readme);
        
        if (!!providedDevices?.length) {
            interfaces.push(ScryptedInterface.DeviceProvider);
        }
        
        this.provider.updateDevice (this.nativeId, this.name, interfaces, ScryptedDeviceType.Doorbell);
    }

    override async reportDevices()
    {
        const providedDevices = JSON.parse (this.storage.getItem (PROVIDED_DEVICES_KEY) || '[]') as string[];
        const devices: Device[] = [];

        if (providedDevices?.includes ('Locks')) {
            try {
                const lockDevices = await this.createLockDevices();
                devices.push (...lockDevices);
            } catch (error) {
                this.console.warn (`Failed to create lock devices: ${error}`);
            }
        }

        if (providedDevices?.includes ('Contact Sensors')) {
            try {
                const sensorDevices = await this.createEntrySensorDevices();
                devices.push(...sensorDevices);
            } catch (error) {
                this.console.warn (`Failed to create entry sensor devices: ${error}`);
            }
        }

        if (providedDevices?.includes ('Tamper Alert')) {
            const alertNativeId = `${this.nativeId}-alert`;
            const alertDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} (Doorbell Tamper Alert)`,
                nativeId: alertNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.OnOff,
                    ScryptedInterface.Readme
                ],
                type: ScryptedDeviceType.Switch,
            };
            devices.push (alertDevice);
        }
        sdk.deviceManager.onDevicesChanged ({
            providerNativeId: this.nativeId,
            devices,
        });
    }

    private async createLockDevices(): Promise<Device[]>
    {
        const devices: Device[] = [];
        
        try {
            const client = this.getClient();
            const doorRange = await client.getDoorControlCapabilities();
            
            for (let doorNo = doorRange.doorMinNo; doorNo <= doorRange.doorMaxNo; doorNo++) {
                const lockNativeId = `${this.nativeId}-lock-${doorNo}`;
                const lockDevice: Device = {
                    providerNativeId: this.nativeId,
                    name: doorRange.doorMaxNo > 1 ? `${this.name} (Door Lock ${doorNo})` : `${this.name} (Door Lock)`,
                    nativeId: lockNativeId,
                    info: {
                        ...this.info,
                    },
                    interfaces: [
                        ScryptedInterface.Lock,
                        ScryptedInterface.Readme
                    ],
                    type: ScryptedDeviceType.Lock,
                };
                devices.push (lockDevice);
            }
        } catch (error) {
            this.console.error (`Failed to get door capabilities: ${error}`);
            // Fallback to single lock device
            const lockNativeId = `${this.nativeId}-lock-1`;
            const lockDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} (Door Lock)`,
                nativeId: lockNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.Lock,
                    ScryptedInterface.Readme
                ],
                type: ScryptedDeviceType.Lock,
            };
            devices.push (lockDevice);
        }
        
        return devices;
    }

    private async createEntrySensorDevices(): Promise<Device[]>
    {
        const devices: Device[] = [];
        
        try 
        {
            const client = this.getClient();
            const doorRange = await client.getDoorControlCapabilities();
            
            for (let doorNo = doorRange.doorMinNo; doorNo <= doorRange.doorMaxNo; doorNo++) {
                const sensorNativeId = `${this.nativeId}-entry-${doorNo}`;
                const sensorDevice: Device = {
                    providerNativeId: this.nativeId,
                    name: doorRange.doorMaxNo > 1 ? `${this.name} (Contact Sensor ${doorNo})` : `${this.name} (Contact Sensor)`,
                    nativeId: sensorNativeId,
                    info: {
                        ...this.info,
                    },
                    interfaces: [
                        ScryptedInterface.BinarySensor,
                        ScryptedInterface.Readme
                    ],
                    type: ScryptedDeviceType.Sensor,
                };
                devices.push (sensorDevice);
            }
        } catch (error) {
            this.console.error (`Failed to get door capabilities: ${error}`);
            // Fallback to single entry sensor device
            const sensorNativeId = `${this.nativeId}-entry-1`;
            const sensorDevice: Device = {
                providerNativeId: this.nativeId,
                name: `${this.name} (Contact Sensor)`,
                nativeId: sensorNativeId,
                info: {
                    ...this.info,
                },
                interfaces: [
                    ScryptedInterface.BinarySensor,
                    ScryptedInterface.Readme
                ],
                type: ScryptedDeviceType.Sensor,
            };
            devices.push (sensorDevice);
        }
        
        return devices;
    }


    async getDevice (nativeId: string): Promise<any>
    {
        if (nativeId.includes ('-lock-')) {
            let lock = this.locks.get (nativeId);
            if (!lock) {
                // Extract door number from nativeId (format: deviceId-lock-doorNo)
                const doorNo = nativeId.split ('-lock-')[1];
                lock = new HikvisionLock (this, nativeId, doorNo);
                this.locks.set (nativeId, lock);
            }
            return lock;
        }
        if (nativeId.includes ('-entry-')) {
            let entrySensor = this.entrySensors.get (nativeId);
            if (!entrySensor) {
                // Extract door number from nativeId (format: deviceId-entry-doorNo)
                const doorNo = nativeId.split ('-entry-')[1];
                entrySensor = new HikvisionEntrySensor (this, nativeId, doorNo);
                this.entrySensors.set (nativeId, entrySensor);
            }
            return entrySensor;
        }
        if (nativeId.endsWith ('-alert')) {
            this.tamperAlert ||= new HikvisionTamperAlert (this, nativeId);
            return this.tamperAlert;
        }
        return super.getDevice (nativeId);
    }

    async releaseDevice (id: string, nativeId: string)
    {
        if (nativeId.includes ('-lock-'))
            this.locks.delete (nativeId);
        else if (nativeId.includes ('-entry-'))
            this.entrySensors.delete (nativeId);
        else if (nativeId.endsWith ('-alert'))
            delete this.tamperAlert;
        else
            return super.releaseDevice (id, nativeId);
    }

    override async putSetting(key: string, value: string) {
        this.client = undefined;
        this.detectedChannels = undefined;

        // remove 0 port for autoselect port number
        if (key === SIP_SERVER_PORT_KEY && value === '0') { 
            value = '';
        }

        if (key === 'debug') {
            // Handle both string and boolean values
            const debugEnabled = typeof value === 'boolean' ? value : value === 'true';
            this.debugController?.setDebugEnabled(debugEnabled);
        }

        super.putSetting(key, value);

        this.updateSip();
    }

    override async getSettings(): Promise<Setting[]> 
    {
        // we need override this method for removing `noaudio`, `doorbellType`, `twoWayAudio` property, 
        // which does not work properly.

        let ret = await super.getSettings();
        let idx = ret.findIndex((el) => { return el.key === 'noAudio'; });
        if (idx !== -1) {
            ret.splice(idx, 1);
        }
        idx = ret.findIndex((el) => { return el.key === 'doorbellType'; });
        if (idx !== -1) {
            ret.splice(idx, 1);
        }
        idx = ret.findIndex((el) => { return el.key === 'twoWayAudio'; });
        if (idx !== -1) {
            ret.splice(idx, 1);
        }
        return ret;
    }

    override async getOtherSettings(): Promise<Setting[]> 
    {
        const ret = await super.getOtherSettings();

        // Remove existing providedDevices entry if it exists
        const existingIndex = ret.findIndex(setting => setting.key === PROVIDED_DEVICES_KEY);
        if (existingIndex !== -1) {
            ret.splice(existingIndex, 1);
        }
        const providedDevices = JSON.parse(this.storage.getItem(PROVIDED_DEVICES_KEY) || '[]') as string[];
        ret.unshift(
            {
                key: PROVIDED_DEVICES_KEY,
                subgroup: 'Advanced',
                title: 'Provided devices',
                description: 'Additional devices provided by this doorbell',
                value: providedDevices,
                choices: [
                    'Locks',
                    'Contact Sensors',
                    'Tamper Alert',
                ],
                multiple: true,
            }
        );

        ret.unshift(
            {
                title: 'SIP Mode',
                value: `<p>Setting up a way to interact with the doorbell in order to receive calls. 
                Read more about how in this device description.</p>
                <p><b>Warning: Be careful! Switch to "Emulated SIP Proxy" mode leads to automatic configuration of settings on the doorbell device.</b></p>
                `,
                type: 'html',
                readonly: true,
            },
            {
                key: SIP_MODE_KEY,
                choices: Object.values (SipMode),
                combobox: true,
                value: this.storage.getItem (SIP_MODE_KEY) || SipMode.Off,
                type: 'string'
            }
        );

        ret.unshift (...this.sipSettings());

        ret.unshift({
                subgroup: 'Advanced',
                key: 'motionTimeout',
                title: 'Motion Timeout',
                description: 'Duration to report motion after the last motion ping.',
                value: parseInt(this.storage.getItem('motionTimeout')) || 10,
                type: 'number',
            },
            {
                subgroup: 'Advanced',
                key: 'motionPings',
                title: 'Motion Ping Count',
                description: 'Number of motion pings needed to trigger motion.',
                value: parseInt(this.storage.getItem('motionPings')) || 1,
                type: 'number',
            },
        );

        return ret;
    }


    override async startIntercom(media: MediaObject): Promise<void> {

        await this.stopRinging();
        
        const channel = this.getRtspChannel() || '1';
        let codec: string;
        let format: string;

        try {
            codec = await this.getClient().twoWayAudioCodec(channel);
        }
        catch (e) {
            this.console.error('Failure while determining two way audio codec', e);
        }

        if (codec === 'G.711ulaw') {
            codec = 'pcm_mulaw';
            format = 'mulaw'
        }
        else if (codec === 'G.711alaw') {
            codec = 'pcm_alaw';
            format = 'alaw'
        }
        else {
            if (codec) {
                this.console.warn('Unknown codec', codec);
                this.console.warn('Set your audio codec to G.711ulaw.');
            }
            this.console.warn('Using fallback codec pcm_mulaw. This may not be correct.');
            // seems to ship with this as defaults.
            codec = 'pcm_mulaw';
            format = 'mulaw'
        }

        const buffer = await mediaManager.convertMediaObjectToBuffer(media, ScryptedMimeTypes.FFmpegInput);
        const ffmpegInput = JSON.parse(buffer.toString()) as FFmpegInput;

        const passthrough = new PassThrough();
        const put = this.getClient().openTwoWayAudio(channel, passthrough);

        let available = Buffer.alloc(0);
        this.activeIntercom?.kill();
        const forwarder = this.activeIntercom = await startRtpForwarderProcess(this.console, ffmpegInput, {
            audio: {
                onRtp: rtp => {
                    const parsed = RtpPacket.deSerialize(rtp);
                    available = Buffer.concat([available, parsed.payload]);
                    if (available.length > 1024) {
                        const data = available.subarray(0, 1024);
                        passthrough.push(data);
                        available = available.subarray(1024);
                    }
                },
                codecCopy: codec,
                encoderArguments: [
                    '-ar', '8000',
                    '-ac', '1',
                    '-acodec', codec,
                ]
            }
        });

        forwarder.killPromise.finally(() => {
            console.debug('audio finished');
            passthrough.end();
            this.stopIntercom();
        });
        
        put.finally(() => forwarder.kill());
    }

    override async stopIntercom(): Promise<void> {
        this.activeIntercom?.kill();
        this.activeIntercom = undefined;

        await this.getClient().closeTwoWayAudio(this.getRtspChannel() || '1');
    }

    private getEventApi()
    {
        return (this.provider as HikvisionDoorbellProvider).createSharedClient(
            this.getIPAddress(), 
            this.getHttpPort(), 
            this.getUsername(), 
            this.getPassword(), 
            this.console,
            this.storage);
    }

    private async stopRinging ()
    {
        if (!this.binaryState) return;

        if (this.sipManager)
        {
            try 
            {
                const hup = timeoutPromise (5000, once (this.controlEvents, HikvisionDoorbellEvent.TalkHangup.toString()));
                await Promise.all ([hup, this.sipManager.answer()])
            } catch (error) {
                this.console.error (`Stop SIP ringing error: ${error}`);
            }
        }
        else {
            await this.getClient().stopRinging();
        }
    }

    /// Installs fake SIP settings on physical device automatically
    /// when SIP Proxy mode is enabled
    private installSipSettingsOnDeviceTimeout: NodeJS.Timeout;
    private async installSipSettingsOnDevice()
    {
        clearTimeout (this.installSipSettingsOnDeviceTimeout);
        if (this.getSipMode() === SipMode.Server
            && this.sipManager) 
        {
            const ip = this.sipManager.localIp;
            const port = this.sipManager.localPort;
            const roomNumber = this.storage.getItem (SIP_SERVER_ROOM_NUMBER_KEY) || DEFAULT_ROOM_NUMBER;
            const proxyPhone = this.storage.getItem (SIP_SERVER_PROXY_PHONE_KEY) || DEFAULT_PROXY_PHONE;
            const doorbellPhone = this.storage.getItem (SIP_SERVER_DOORBELL_PHONE_KEY) || DEFAULT_DOORBELL_PHONE;
            const buttonNumber = this.storage.getItem (SIP_SERVER_BUTTON_NUMBER_KEY) || DEFAULT_BUTTON_NUMBER;
            
            try {
                await this.getClient().setFakeSip (ip, port, roomNumber, proxyPhone, doorbellPhone, buttonNumber)
                this.console.info (`Installed fake SIP settings on doorbell. Address: ${ip}, port: ${port}, room: ${roomNumber}, proxy phone: ${proxyPhone}, doorbell phone: ${doorbellPhone}, button: ${buttonNumber}`);
            } catch (e) {
                this.console.error (`Error installing fake SIP settings: ${e}`);
                // repeat if unreached
                this.installSipSettingsOnDeviceTimeout = setTimeout (() => this.installSipSettingsOnDevice(), UNREACHED_REPEAT_TIMEOUT);
            }
        }
    }

    private sipSettings(): Setting[]
    {
        switch (this.getSipMode()) {
            case SipMode.Client:
                return [
                    {
                        subgroup: 'Connect to SIP Proxy',
                        key: SIP_CLIENT_PROXY_IP_KEY,
                        title: 'Proxy IP Address',
                        description: 'IP address of the SIP proxy to which this plugin (device) will join as a SIP telephony subscriber',
                        value: this.storage.getItem(SIP_CLIENT_PROXY_IP_KEY) || '',
                        type: 'string',
                    },
                    {
                        subgroup: 'Connect to SIP Proxy',
                        key: SIP_CLIENT_PROXY_PORT_KEY,
                        title: 'Proxy Port',
                        description: 'SIP proxy port to which this plugin (device) will join as a SIP telephony subscriber',
                        value: parseInt(this.storage.getItem(SIP_CLIENT_PROXY_PORT_KEY)) || 5060,
                        type: 'number',
                    },
                    {
                        subgroup: 'Connect to SIP Proxy',
                        key: SIP_CLIENT_USER_KEY,
                        title: 'Username',
                        description: 'Username for registration on SIP proxy',
                        value: this.storage.getItem(SIP_CLIENT_USER_KEY),
                        placeholder: 'Username',
                        type: 'string',
                    },
                    {
                        subgroup: 'Connect to SIP Proxy',
                        key: SIP_CLIENT_PASSWORD_KEY,
                        title: 'Password',
                        description: 'Password for registration on SIP proxy',
                        value: this.storage.getItem(SIP_CLIENT_PASSWORD_KEY) || '',
                        type: 'password',
                    },
                    {
                        subgroup: 'Connect to SIP Proxy',
                        key: SIP_CLIENT_CALLID_KEY,
                        title: 'Caller ID',
                        description: 'Caller ID for registration on SIP proxy',
                        value: this.storage.getItem(SIP_CLIENT_CALLID_KEY),
                        placeholder: 'CallId',
                        type: 'string',
                    },
                ];
        
            case SipMode.Server:
                return [
                    {
                        subgroup: 'Emulate SIP Proxy',
                        title: 'Information',
                        description: '',
                        value: `<p>SIP proxy is emulated on this plugin. 
                        It allows intercepting and handling SIP calls from the doorbell device.
                        It is used for SIP call control and monitoring. 
                        It is not related to SIP telephony.</p>
                        <p><b>Enabling this mode will automatically configure the necessary settings on the doorbell device!</b></p>`,
                        type: 'html',
                        readonly: true,
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: 'sipServerIp',
                        title: 'Interface IP Address',
                        description: 'Address of the interface on which the fake SIP proxy listens. Readonly property, for information.',
                        value: this.sipManager?.localIp || 'localhost',
                        type: 'string',
                        readonly: true
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: SIP_SERVER_PORT_KEY,
                        title: 'Port',
                        description: 'Specify the desired port. If you leave the field blank, the port will be assigned automatically. In this case, the selected port will be displayed in the field placeholder.',
                        value: parseInt (this.storage.getItem (SIP_SERVER_PORT_KEY)),
                        type: 'integer',
                        placeholder: `Port ${this.sipManager?.localPort || 0} is selected automatically`
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: SIP_SERVER_ROOM_NUMBER_KEY,
                        title: 'Room Number',
                        description: 'Room number to be configured on the doorbell device. Must be between 1 and 9999. This room number will represent this fake SIP proxy',
                        value: this.storage.getItem (SIP_SERVER_ROOM_NUMBER_KEY),
                        type: 'integer',
                        placeholder: DEFAULT_ROOM_NUMBER
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: SIP_SERVER_PROXY_PHONE_KEY,
                        title: 'SIP Proxy Phone Number',
                        description: 'Phone number that will represent this fake SIP proxy',
                        value: this.storage.getItem (SIP_SERVER_PROXY_PHONE_KEY),
                        type: 'integer',
                        placeholder: DEFAULT_PROXY_PHONE
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: SIP_SERVER_DOORBELL_PHONE_KEY,
                        title: 'Doorbell Phone Number',
                        description: 'Phone number that will represent the doorbell',
                        value: this.storage.getItem (SIP_SERVER_DOORBELL_PHONE_KEY),
                        type: 'integer',
                        placeholder: DEFAULT_DOORBELL_PHONE
                    },
                    {
                        subgroup: 'Emulate SIP Proxy',
                        key: SIP_SERVER_BUTTON_NUMBER_KEY,
                        title: 'Button Number',
                        description: 'Number of the call button. Used when doorbell has multiple call buttons. Must be between 1 and 99.',
                        value: this.storage.getItem (SIP_SERVER_BUTTON_NUMBER_KEY),
                        type: 'integer',
                        placeholder: DEFAULT_BUTTON_NUMBER
                    },
                ];

            default:
                break;
        }
        return []
    }

    private getSipMode() {
        return this.storage.getItem (SIP_MODE_KEY) || SipMode.Off;
    }

    private getSipClientCreds(): SipRegistration
    {
        return {
            user: this.storage.getItem (SIP_CLIENT_USER_KEY) || '',
            password: this.storage.getItem (SIP_CLIENT_PASSWORD_KEY) || '',
            ip: this.storage.getItem (SIP_CLIENT_PROXY_IP_KEY) || '',
            port: parseNumbers (this.storage.getItem (SIP_CLIENT_PROXY_PORT_KEY) || '5060'),
            callId: this.storage.getItem (SIP_CLIENT_CALLID_KEY) || ''
          }
    }
}

export class HikvisionDoorbellProvider extends RtspProvider
{
    static CAMERA_NATIVE_ID_KEY: string = 'cameraNativeId';
    
    clients: Map<string, HikvisionDoorbellAPI>;

    constructor() {
        super();
    }

    getScryptedDeviceCreator(): string {
        return 'Hikvision Doorbell';
    }

    override getAdditionalInterfaces() {
        return [
            ScryptedInterface.Reboot,
            ScryptedInterface.Camera,
            ScryptedInterface.MotionSensor,
        ];
    }

    createSharedClient (ip: string, port: string, username: string, password: string, console: Console, storage: Storage) 
    {
        if (!this.clients)
            this.clients = new Map();

        const key = `${ip}#${port}#${username}#${password}`;
        const check = this.clients.get(key);
        if (check) 
            return check;
        
        const client = new HikvisionDoorbellAPI (ip, port, username, password, console, storage);
        this.clients.set (key, client);
        return client;
    }

    override createCamera(nativeId: string) {
        return new HikvisionCameraDoorbell(nativeId, this);
    }

    override async createDevice(settings: DeviceCreatorSettings, nativeId?: string): Promise<string> {
        let info: DeviceInformation = {};

        const username = settings.username?.toString();
        const password = settings.password?.toString();
        const skipValidate = settings.skipValidate?.toString() === 'true';
        let twoWayAudio: string;
        if (!skipValidate) {
            const api = new HikvisionDoorbellAPI(`${settings.ip}`, `${settings.httpPort || '80'}`, username, password, this.console, this.storage);
            try {
                const deviceInfo = await api.getDeviceInfo();

                settings.newCamera = deviceInfo.deviceName;
                info.model = deviceInfo.deviceModel;
                // info.manufacturer = 'Hikvision';
                info.mac = deviceInfo.macAddress;
                info.firmware = deviceInfo.firmwareVersion;
                info.serialNumber = deviceInfo.serialNumber;
            }
            catch (e) {
                this.console.error('Error adding Hikvision camera', e);
                throw e;
            }

            try {
                if (await api.checkTwoWayAudio()) {
                    twoWayAudio = 'true';
                }
            }
            catch (e) {
                this.console.warn('Error probing two way audio', e);
            }
        }
        settings.newCamera ||= 'Hikvision Camera';

        nativeId = await super.createDevice(settings, nativeId);

        const device = await this.getDevice(nativeId) as HikvisionCameraDoorbell;
        device.info = info;
        device.putSetting('username', username);
        device.putSetting('password', password);
        device.setIPAddress(settings.ip?.toString());
        device.setHttpPortOverride(settings.httpPort?.toString());
        if (twoWayAudio)
            device.putSetting('twoWayAudio', twoWayAudio);
        device.updateSip();
        device.updateDeviceInfo();
        return nativeId;
    }
}

export default new HikvisionDoorbellProvider();
