/**
 * Scottie DX Mode (VIS: 76)
 * 320x256 RGB, Non-interlaced
 * Structure: Sep -> Green -> Sep -> Blue -> Sync -> Porch -> Red
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class ScottieDX extends BaseSSTVMode {
    id = 76;
    name = 'Scottie DX';
    colorFormat = ColorFormat.RGB;
    chromaSubsampling = ChromaSubsampling.Full;
    width = 320;
    height = 256;

    syncPulse = 0.009;
    syncPorch = 0.0015;

    channelCount = 3;
    channelOrder = [1, 2, 0]; // Green, Blue, Red
    scanTimes = [0.345600, 0.345600, 0.345600];
    separatorPulses = [0.0015, 0.0015, 0]; windowFactor = 0.98;
    hasStartSync = true;
    syncChannel = 2;

    get lineTime(): number {
        return this.separatorPulses[0] + this.scanTimes[0] +
            this.separatorPulses[1] + this.scanTimes[1] +
            this.syncPulse + this.syncPorch + this.scanTimes[2];
    }

    /**
     * Scottie modes have structure:
     * Sync -> Porch -> Red -> Sep -> Green -> Sep -> Blue
     * We look forward from the sync pulse.
     */
    getChannelOffset(line: number, channel: number): number {
        const redOffset = this.syncPulse + this.syncPorch;
        if (channel === 2) { // Red - immediately after sync
            return redOffset;
        }

        // Green follows Red (after Sep0)
        const greenOffset = redOffset + this.scanTimes[2] + this.separatorPulses[0];
        if (channel === 0) { // Green
            return greenOffset;
        }

        // Blue follows Green (after Sep1)
        return greenOffset + this.scanTimes[0] + this.separatorPulses[1];
    }
}
