/**
 * Robot 72 Mode (VIS: 12)
 * 320x240 YCrCb 4:2:2
 * Every line: Y + V (R-Y) + U (B-Y)
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class Robot72 extends BaseSSTVMode {
    id = 12;
    name = 'Robot 72';
    colorFormat = ColorFormat.YCrCb;
    chromaSubsampling = ChromaSubsampling.HalfHorizontal; // 4:2:2
    width = 320;
    height = 240;

    syncPulse = 0.009;
    syncPorch = 0.003;

    channelCount = 3; // Y, V, U
    channelOrder = [0, 1, 2]; // Y, V (R-Y), U (B-Y)
    scanTimes = [0.138, 0.069, 0.069]; // Y full, chroma half
    separatorPulses = [0.0045, 0.0045, 0]; // After Y and V
    windowFactor = 4.88;

    hasStartSync = false;

    get lineTime(): number {
        // Sync + Porch + Y + Sep + Porch(1900Hz) + V + Sep(2300Hz) + Porch(1500Hz) + U
        return this.syncPulse + this.syncPorch +
            this.scanTimes[0] + this.separatorPulses[0] + 0.0015 + // Y + sep + porch
            this.scanTimes[1] + this.separatorPulses[1] + 0.0015 + // V + sep + porch
            this.scanTimes[2];
    }

    getChannelOffset(line: number, channel: number): number {
        if (channel === 0) { // Y
            return this.syncPulse + this.syncPorch;
        } else if (channel === 1) { // V (R-Y)
            return this.syncPulse + this.syncPorch + this.scanTimes[0] +
                this.separatorPulses[0] + 0.0015; // Porch at 1900Hz
        } else { // U (B-Y)
            return this.syncPulse + this.syncPorch + this.scanTimes[0] +
                this.separatorPulses[0] + 0.0015 +
                this.scanTimes[1] + this.separatorPulses[1] + 0.0015; // Porch at 1500Hz
        }
    }

    getScanTime(line: number, channel: number): number {
        return this.scanTimes[channel];
    }
}
