/**
 * PD Mode Base Class
 * PD modes transmit 2 lines of Y for every 1 line of chroma
 * Structure: Sync -> Porch -> Y(odd) -> R-Y -> B-Y -> Y(even)
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export abstract class PDMode extends BaseSSTVMode {
    colorFormat = ColorFormat.YCrCb;
    chromaSubsampling = ChromaSubsampling.Quarter; // 4:2:0

    syncPulse = 0.020;
    syncPorch = 0.00208;

    channelCount = 4; // Y(odd), R-Y, B-Y, Y(even)
    channelOrder = [0, 1, 2, 0]; // Y, Cr, Cb, Y

    abstract scanTime: number; // All components have same scan time in PD modes

    get scanTimes(): number[] {
        return [this.scanTime, this.scanTime, this.scanTime, this.scanTime];
    }

    get separatorPulses(): number[] {
        return [0, 0, 0, 0]; // No separators in PD modes
    }

    abstract windowFactor: number;

    hasStartSync = false;

    get lineTime(): number {
        // PD modes transmit 2 Y lines + chroma per line pair
        return this.syncPulse + this.syncPorch + (this.scanTime * 4);
    }

    getChannelOffset(line: number, channel: number): number {
        let offset = this.syncPulse + this.syncPorch;
        for (let i = 0; i < channel; i++) {
            offset += this.scanTime;
        }
        return offset;
    }
}

/**
 * PD 50 Mode (VIS: 93)
 * 320x256 YCrCb 4:2:0
 */
export class PD50 extends PDMode {
    id = 93;
    name = 'PD 50';
    width = 320;
    height = 256;
    scanTime = 0.09152;
    windowFactor = 3.7;
}

/**
 * PD 90 Mode (VIS: 99)
 * 320x256 YCrCb 4:2:0
 */
export class PD90 extends PDMode {
    id = 99;
    name = 'PD 90';
    width = 320;
    height = 256;
    scanTime = 0.17024;
    windowFactor = 2.0;
}

/**
 * PD 120 Mode (VIS: 95)
 * 640x496 YCrCb 4:2:0
 */
export class PD120 extends PDMode {
    id = 95;
    name = 'PD 120';
    width = 640;
    height = 496;
    scanTime = 0.12160;
    windowFactor = 5.6;
}

/**
 * PD 160 Mode (VIS: 98)
 * 512x400 YCrCb 4:2:0
 */
export class PD160 extends PDMode {
    id = 98;
    name = 'PD 160';
    width = 512;
    height = 400;
    scanTime = 0.195584;
    windowFactor = 2.8;
}

/**
 * PD 180 Mode (VIS: 96)
 * 640x496 YCrCb 4:2:0
 */
export class PD180 extends PDMode {
    id = 96;
    name = 'PD 180';
    width = 640;
    height = 496;
    scanTime = 0.18304;
    windowFactor = 3.7;
}

/**
 * PD 240 Mode (VIS: 97)
 * 640x496 YCrCb 4:2:0
 */
export class PD240 extends PDMode {
    id = 97;
    name = 'PD 240';
    width = 640;
    height = 496;
    scanTime = 0.24448;
    windowFactor = 2.8;
}

/**
 * PD 290 Mode (VIS: 94)
 * 800x616 YCrCb 4:2:0
 */
export class PD290 extends PDMode {
    id = 94;
    name = 'PD 290';
    width = 800;
    height = 616;
    scanTime = 0.22880;
    windowFactor = 3.7;
}
