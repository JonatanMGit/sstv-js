/**
 * Martin M2 Mode (VIS: 40)
 * 320x256 RGB, Non-interlaced
 * Structure: Sync -> Porch -> Green -> Sep -> Blue -> Sep -> Red -> Sep
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class MartinM2 extends BaseSSTVMode {
    id = 40;
    name = 'Martin M2';
    colorFormat = ColorFormat.RGB;
    chromaSubsampling = ChromaSubsampling.Full;
    width = 320;
    height = 256;

    syncPulse = 0.004862;
    syncPorch = 0.000572;

    channelCount = 3;
    channelOrder = [1, 2, 0]; // Green, Blue, Red
    scanTimes = [0.073216, 0.073216, 0.073216]; // Faster than M1
    separatorPulses = [0.000572, 0.000572, 0.000572];
    windowFactor = 4.68;

    hasStartSync = false;

    get lineTime(): number {
        return this.syncPulse + this.syncPorch +
            (this.scanTimes[0] + this.separatorPulses[0]) * 3;
    }
}
