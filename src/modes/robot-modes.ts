/**
 * Robot Modes: 36, 72, 8 BW
 * 
 * Robot modes use YCrCb color space with various chroma subsampling:
 * - Robot 36: YCrCb 4:2:0 (chroma alternates between lines)
 * - Robot 72: YCrCb 4:2:2 (full chroma every line)
 * - Robot 8 BW: Grayscale
 */

import { ColorFormat, ChromaSubsampling, SSTVMode } from '../types';

/**
 * Robot 36 Mode (VIS: 8)
 * 320x240 YCrCb 4:2:0
 * 
 * Even lines: Y + V (R-Y)
 * Odd lines: Y + U (B-Y)
 * Chroma alternates between lines (4:2:0 subsampling)
 */
export class Robot36 implements SSTVMode {
    readonly id = 8;
    readonly name = 'Robot 36';
    readonly colorFormat = ColorFormat.YCrCb;
    readonly chromaSubsampling = ChromaSubsampling.Quarter; // 4:2:0

    readonly width = 320;
    readonly height = 240;
    readonly syncPulse = 0.009;
    readonly syncPorch = 0.003;
    readonly hasStartSync = false;

    readonly channelCount = 2; // Y and one chroma channel (alternating)
    readonly channelOrder: readonly number[] = [0, 1]; // Y, Chroma
    readonly scanTimes: readonly number[] = [0.088, 0.044]; // Y is full width, chroma is half
    readonly separatorPulses: readonly number[] = [0, 0]; // Handled specially (4.5ms + 1.5ms)
    readonly windowFactor = 7.7;

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

/**
 * Robot 72 Mode (VIS: 12)
 * 320x240 YCrCb 4:2:2
 * 
 * Every line: Y + V (R-Y) + U (B-Y)
 * Full chroma on every line (4:2:2 subsampling)
 */
export class Robot72 implements SSTVMode {
    readonly id = 12;
    readonly name = 'Robot 72';
    readonly colorFormat = ColorFormat.YCrCb;
    readonly chromaSubsampling = ChromaSubsampling.HalfHorizontal; // 4:2:2

    readonly width = 320;
    readonly height = 240;
    readonly syncPulse = 0.009;
    readonly syncPorch = 0.003;
    readonly hasStartSync = false;

    readonly channelCount = 3; // Y, V, U
    readonly channelOrder: readonly number[] = [0, 1, 2]; // Y, V (R-Y), U (B-Y)
    readonly scanTimes: readonly number[] = [0.138, 0.069, 0.069]; // Y full, chroma half
    readonly separatorPulses: readonly number[] = [0.0045, 0.0045, 0]; // After Y and V
    readonly windowFactor = 4.88;

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

/**
 * Robot 8 BW Mode (VIS: 2)
 * 160x120 Grayscale
 * 
 * Simple monochrome mode
 */
export class Robot8BW implements SSTVMode {
    readonly id = 2;
    readonly name = 'Robot 8 BW';
    readonly colorFormat = ColorFormat.Grayscale;
    readonly chromaSubsampling = ChromaSubsampling.Full; // N/A for grayscale

    // Smaller dimensions for 8 BW
    readonly width = 160;
    readonly height = 120;

    // Slightly different sync timing
    readonly syncPulse = 0.010;
    readonly syncPorch = 0.002;
    readonly hasStartSync = false;

    readonly channelCount = 1; // Y only
    readonly channelOrder: readonly number[] = [0];
    readonly scanTimes: readonly number[] = [0.060];
    readonly separatorPulses: readonly number[] = [0];
    readonly windowFactor = 5.13;

    get lineTime(): number {
        return this.syncPulse + this.syncPorch + this.scanTimes[0];
    }

    getChannelOffset(line: number, channel: number): number {
        return this.syncPulse + this.syncPorch;
    }

    getScanTime(line: number, channel: number): number {
        return this.scanTimes[0];
    }
}
