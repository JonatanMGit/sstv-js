/**
 * PD Modes
 * 
 * PD modes transmit 2 lines of Y for every 1 line of chroma
 * Structure: Sync -> Porch -> Y(odd) -> R-Y -> B-Y -> Y(even)
 */

import { ColorFormat, ChromaSubsampling, SSTVMode } from '../types';

abstract class PDMode implements SSTVMode {
    colorFormat = ColorFormat.YCrCb;
    chromaSubsampling = ChromaSubsampling.Quarter; // 4:2:0

    syncPulse = 0.020;
    syncPorch = 0.00208;

    channelCount = 4; // Y(odd), R-Y, B-Y, Y(even)
    channelOrder: readonly number[] = [0, 1, 2, 0]; // Y, Cr, Cb, Y

    abstract readonly id: number;
    abstract readonly name: string;
    abstract readonly width: number;
    abstract readonly height: number;
    abstract readonly scanTime: number; // All components have same scan time in PD modes
    abstract readonly windowFactor: number;

    get scanTimes(): readonly number[] {
        return [this.scanTime, this.scanTime, this.scanTime, this.scanTime];
    }

    get separatorPulses(): readonly number[] {
        return [0, 0, 0, 0]; // No separators in PD modes
    }

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

    getScanTime(line: number, channel: number): number {
        return this.scanTime;
    }
}

/**
 * PD 50 Mode (VIS: 93)
 * 320x256 YCrCb 4:2:0
 */
export class PD50 extends PDMode {
    readonly id = 93;
    readonly name = 'PD 50';
    readonly width = 320;
    readonly height = 256;
    readonly scanTime = 0.09152;
    readonly windowFactor = 3.7;
}

/**
 * PD 90 Mode (VIS: 99)
 * 320x256 YCrCb 4:2:0
 */
export class PD90 extends PDMode {
    readonly id = 99;
    readonly name = 'PD 90';
    readonly width = 320;
    readonly height = 256;
    readonly scanTime = 0.17024;
    readonly windowFactor = 2.0;
}

/**
 * PD 120 Mode (VIS: 95)
 * 640x496 YCrCb 4:2:0
 */
export class PD120 extends PDMode {
    readonly id = 95;
    readonly name = 'PD 120';
    readonly width = 640;
    readonly height = 496;
    readonly scanTime = 0.12160;
    readonly windowFactor = 5.6;
}

/**
 * PD 160 Mode (VIS: 98)
 * 512x400 YCrCb 4:2:0
 */
export class PD160 extends PDMode {
    readonly id = 98;
    readonly name = 'PD 160';
    readonly width = 512;
    readonly height = 400;
    readonly scanTime = 0.195584;
    readonly windowFactor = 2.8;
}

/**
 * PD 180 Mode (VIS: 96)
 * 640x496 YCrCb 4:2:0
 */
export class PD180 extends PDMode {
    readonly id = 96;
    readonly name = 'PD 180';
    readonly width = 640;
    readonly height = 496;
    readonly scanTime = 0.18304;
    readonly windowFactor = 3.7;
}

/**
 * PD 240 Mode (VIS: 97)
 * 640x496 YCrCb 4:2:0
 */
export class PD240 extends PDMode {
    readonly id = 97;
    readonly name = 'PD 240';
    readonly width = 640;
    readonly height = 496;
    readonly scanTime = 0.24448;
    readonly windowFactor = 2.8;
}

/**
 * PD 290 Mode (VIS: 94)
 * 800x616 YCrCb 4:2:0
 */
export class PD290 extends PDMode {
    readonly id = 94;
    readonly name = 'PD 290';
    readonly width = 800;
    readonly height = 616;
    readonly scanTime = 0.22880;
    readonly windowFactor = 3.7;
}
