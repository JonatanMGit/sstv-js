/**
 * Wraase SC2-180 Mode (VIS: 55)
 * 320x256 RGB
 * Structure: Sync -> Porch -> Red -> Green -> Blue
 */

import { ColorFormat, ChromaSubsampling } from '../types';
import { BaseSSTVMode } from './base';

export class WraaseSC2180 extends BaseSSTVMode {
    id = 55;
    name = 'Wraase SC2-180';
    colorFormat = ColorFormat.RGB;
    chromaSubsampling = ChromaSubsampling.Full;
    width = 320;
    height = 256;

    syncPulse = 0.0055225;
    syncPorch = 0.0005;

    channelCount = 3;
    channelOrder = [0, 1, 2]; // Red, Green, Blue
    scanTimes = [0.235, 0.235, 0.235];
    separatorPulses = [0, 0, 0]; // No separators
    windowFactor = 1.0;

    hasStartSync = false;

    get lineTime(): number {
        return this.syncPulse + this.syncPorch +
            this.scanTimes[0] + this.scanTimes[1] + this.scanTimes[2];
    }

    getChannelOffset(line: number, channel: number): number {
        let offset = this.syncPulse + this.syncPorch;
        for (let i = 0; i < channel; i++) {
            offset += this.scanTimes[i];
        }
        return offset;
    }
}
