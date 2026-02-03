/**
 * Base mode implementation for SSTV modes
 */

import { SSTVMode, ColorFormat, ChromaSubsampling } from '../types';

/**
 * Abstract base class for SSTV modes
 */
export abstract class BaseSSTVMode implements SSTVMode {
    abstract id: number;
    abstract name: string;
    abstract colorFormat: ColorFormat;
    abstract chromaSubsampling: ChromaSubsampling;
    abstract width: number;
    abstract height: number;
    abstract syncPulse: number;
    abstract syncPorch: number;
    abstract channelCount: number;
    abstract channelOrder: readonly number[];
    abstract scanTimes: readonly number[];
    abstract separatorPulses: readonly number[];
    abstract lineTime: number;
    abstract hasStartSync: boolean;
    abstract windowFactor: number;
    syncChannel?: number;

    /**
     * Default implementation: calculate offsets sequentially
     */
    getChannelOffset(line: number, channel: number): number {
        let offset = this.syncPulse + this.syncPorch;

        for (let i = 0; i < channel; i++) {
            offset += this.scanTimes[i] + this.separatorPulses[i];
        }

        return offset;
    }

    /**
     * Default implementation: return scan time for channel
     */
    getScanTime(line: number, channel: number): number {
        return this.scanTimes[channel];
    }

    /**
     * Get pixel duration for a given channel
     */
    getPixelTime(channel: number): number {
        return this.scanTimes[channel] / this.width;
    }
}
