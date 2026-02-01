/**
 * Robot 36 Mode (VIS: 8)
 * 320x240 YCrCb 4:2:0
 * Even lines: Y + V (R-Y)
 * Odd lines: Y + U (B-Y)
 * Chroma alternates between lines
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class Robot36 extends BaseSSTVMode {
    id = 8;
    name = 'Robot 36';
    colorFormat = ColorFormat.YCrCb;
    chromaSubsampling = ChromaSubsampling.Quarter; // 4:2:0
    width = 320;
    height = 240;

    syncPulse = 0.009;
    syncPorch = 0.003;

    channelCount = 2; // Y and one chroma channel (alternating)
    channelOrder = [0, 1]; // Y, Chroma
    scanTimes = [0.088, 0.044]; // Y is full width, chroma is half
    separatorPulses = [0, 0]; // Handled specially in encoder (needs 4.5ms + 1.5ms before chroma)
    windowFactor = 7.7; // Sampling window size relative to pixel time

    hasStartSync = false;

    get lineTime(): number {
        // Sync + Porch + Y + 4.5ms Sep + 1.5ms Porch + Chroma
        return this.syncPulse + this.syncPorch + this.scanTimes[0] +
            0.0045 + 0.0015 + this.scanTimes[1];
    }

    getChannelOffset(line: number, channel: number): number {
        if (channel === 0) { // Y channel
            return this.syncPulse + this.syncPorch;
        } else { // Chroma channel  
            // After Y + 4.5ms separator + 1.5ms porch
            return this.syncPulse + this.syncPorch + this.scanTimes[0] + 0.0045 + 0.0015;
        }
    }

    getScanTime(line: number, channel: number): number {
        return this.scanTimes[channel];
    }
}
