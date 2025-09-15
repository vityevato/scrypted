import { EntrySensor, Readme, ScryptedDeviceBase, ScryptedInterface } from "@scrypted/sdk";
import { HikvisionDoorbellAPI } from "./doorbell-api";
import type { HikvisionCameraDoorbell } from "./main";
import * as fs from 'fs/promises';
import { join } from 'path';

export class HikvisionEntrySensor extends ScryptedDeviceBase implements EntrySensor, Readme {

    constructor(public camera: HikvisionCameraDoorbell, nativeId: string) {
        super (nativeId);
        this.entryOpen = this.entryOpen || false;
    }

    async getReadmeMarkdown(): Promise<string> 
    {
        const fileName = join (process.cwd(), 'ENTRY_SENSOR_README.md');
        return fs.readFile (fileName, 'utf-8');
    }


    private getClient(): HikvisionDoorbellAPI {
        return this.camera.getClient();
    }

    static deviceInterfaces: string[] = [
        ScryptedInterface.EntrySensor,
        ScryptedInterface.Readme
    ];
}
