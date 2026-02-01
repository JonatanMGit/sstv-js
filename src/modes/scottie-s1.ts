/**
 * Scottie S1 Mode (VIS: 60)
 * 320x256 RGB, Non-interlaced
 * Structure: Sep -> Green -> Sep -> Blue -> Sync -> Porch -> Red
 * Note: First line has a 9ms start sync
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class ScottieS1 extends BaseSSTVMode {
    id = 60;
    name = 'Scottie S1';
    colorFormat = ColorFormat.RGB;
    chromaSubsampling = ChromaSubsampling.Full;
    width = 320;
    height = 256;

    syncPulse = 0.009;
    syncPorch = 0.0015;

    channelCount = 3;
    channelOrder = [1, 2, 0]; // Green, Blue, Red
    scanTimes = [0.138240, 0.138240, 0.138240];
    separatorPulses = [0.0015, 0.0015, 0]; // No separator after Red
    windowFactor = 2.48;

    hasStartSync = true; // First line has 9ms start sync
    syncChannel = 2; // Sync comes between Blue (channel 1) and Red (channel 2)

    get lineTime(): number {
        // Separator + Green + Separator + Blue + Sync + Porch + Red
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

        // Green follows Red (after Sep0) -> Sep0 is index 0 in separatorPulses?
        // Wait, the spec says: Sep -> Green -> Sep -> Blue -> Sync -> Porch -> Red
        // But we are aligning to Sync.
        // So effectively: Sync -> Porch -> Red -> Sep -> Green -> Sep -> Blue

        const greenOffset = redOffset + this.scanTimes[2] + this.separatorPulses[0];
        if (channel === 0) { // Green
            return greenOffset;
        }

        // Blue follows Green (after Sep1)
        return greenOffset + this.scanTimes[0] + this.separatorPulses[1];
    }
}
