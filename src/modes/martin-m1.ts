/**
 * Martin M1 Mode (VIS: 44)
 * 320x256 RGB, Non-interlaced
 * Structure: Sync -> Porch -> Green -> Sep -> Blue -> Sep -> Red -> Sep
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class MartinM1 extends BaseSSTVMode {
    id = 44;
    name = 'Martin M1';
    colorFormat = ColorFormat.RGB;
    chromaSubsampling = ChromaSubsampling.Full;
    width = 320;
    height = 256;

    syncPulse = 0.004862;
    syncPorch = 0.000572;

    channelCount = 3;
    channelOrder = [1, 2, 0]; // Green, Blue, Red
    scanTimes = [0.146432, 0.146432, 0.146432]; // Same for all channels
    separatorPulses = [0.000572, 0.000572, 0.000572];
    windowFactor = 2.34;

    hasStartSync = false;

    get lineTime(): number {
        return this.syncPulse + this.syncPorch +
            (this.scanTimes[0] + this.separatorPulses[0]) * 3;
    }
}
