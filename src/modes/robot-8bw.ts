/**
 * Robot 8 BW Mode (VIS: 2)
 * 160x120 Grayscale
 * Simple monochrome mode
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class Robot8BW extends BaseSSTVMode {
    id = 2;
    name = 'Robot 8 BW';
    colorFormat = ColorFormat.Grayscale;
    chromaSubsampling = ChromaSubsampling.Full; // N/A for grayscale
    width = 160;
    height = 120;

    syncPulse = 0.010;
    syncPorch = 0.002;

    channelCount = 1; // Y only (luminance/grayscale)
    channelOrder = [0];
    scanTimes = [0.060];
    separatorPulses = [0];
    windowFactor = 5.13;

    hasStartSync = false;

    get lineTime(): number {
        return this.syncPulse + this.syncPorch + this.scanTimes[0];
    }
}
