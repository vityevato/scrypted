import { Lock, LockState, Readme, ScryptedDeviceBase, ScryptedInterface } from "@scrypted/sdk";
import { HikvisionDoorbellAPI } from "./doorbell-api";
import type { HikvisionCameraDoorbell } from "./main";
import * as fs from 'fs/promises';
import { join } from 'path';

export class HikvisionLock extends ScryptedDeviceBase implements Lock, Readme {

    constructor (public camera: HikvisionCameraDoorbell, nativeId: string, public doorNumber: string = '1') {
        super (nativeId);
        this.lockState = this.lockState || LockState.Unlocked;
    }

    async getReadmeMarkdown(): Promise<string> 
    {
        const fileName = join (process.cwd(), 'LOCK_README.md');
        return fs.readFile (fileName, 'utf-8');
    }

    async lock(): Promise<void>
    {
        const capabilities = await this.getClient().getDoorControlCapabilities();
        const command = capabilities.availableCommands.includes ('close') ? 'close' : 'resume';
        await this.getClient().controlDoor (this.doorNumber, command);
        this.lockState = LockState.Locked;
    }

    async unlock(): Promise<void>
    {
        await this.getClient().controlDoor (this.doorNumber, 'open');
        this.lockState = LockState.Unlocked;
    }

    private getClient(): HikvisionDoorbellAPI {
        return this.camera.getClient();
    }

    static deviceInterfaces: string[] = [
        ScryptedInterface.Lock,
        ScryptedInterface.Readme
    ];
}
