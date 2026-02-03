/**
 * Martin Modes: M1, M2
 * 
 * All Martin modes share the same structure:
 *   Sync -> Porch -> Green -> Sep -> Blue -> Sep -> Red -> Sep
 * 
 * Martin modes are synchronous with sync at line start.
 */

import { ColorFormat, ChromaSubsampling, SSTVMode } from '../types';

/**
 * Abstract base class for all Martin modes.
 * Subclasses only need to define: id, name, scanTime, and windowFactor.
 */
abstract class MartinMode implements SSTVMode {
    // Common properties for all Martin modes
    readonly colorFormat = ColorFormat.RGB;
    readonly chromaSubsampling = ChromaSubsampling.Full;
    readonly width = 320;
    readonly height = 256;

    // Martin modes use ~4.862ms sync and ~0.572ms separators
    readonly syncPulse = 0.004862;
    readonly syncPorch = 0.000572;

    readonly channelCount = 3;
    readonly channelOrder: readonly number[] = [1, 2, 0]; // Green, Blue, Red

    // Martin modes have sync at line start (no mid-line sync)
    readonly hasStartSync = false;

    // All separators are the same duration
    readonly separatorPulses: readonly number[] = [0.000572, 0.000572, 0.000572];

    abstract readonly id: number;
    abstract readonly name: string;
    abstract readonly scanTime: number;
    abstract readonly windowFactor: number;

    /**
     * Scan times array (all channels have same scan time in Martin modes)
     */
    get scanTimes(): readonly number[] {
        return [this.scanTime, this.scanTime, this.scanTime];
    }

    /**
     * Total line time including all components.
     * Martin structure: Sync + Porch + (Channel + Sep) × 3
     */
    get lineTime(): number {
        return this.syncPulse + this.syncPorch +
            (this.scanTime + this.separatorPulses[0]) * 3;
    }

    /**
     * Calculate channel offset from sync pulse.
     * 
     * Martin uses line-start sync with standard layout:
     *   Sync -> Porch -> Green -> Sep -> Blue -> Sep -> Red -> Sep
     * 
     * @param line - Line number (unused, all lines have same structure)
     * @param channel - Channel index in transmission order (0=Green, 1=Blue, 2=Red)
     * @returns Offset in seconds from sync pulse start
     */
    getChannelOffset(line: number, channel: number): number {
        let offset = this.syncPulse + this.syncPorch;

        for (let i = 0; i < channel; i++) {
            offset += this.scanTime + this.separatorPulses[i];
        }

        return offset;
    }

    /**
     * Get scan time for a channel.
     * All Martin channels have the same scan time.
     */
    getScanTime(line: number, channel: number): number {
        return this.scanTime;
    }
}

/**
 * Martin M1 Mode (VIS: 44)
 * 320x256 RGB
 */
export class MartinM1 extends MartinMode {
    readonly id = 44;
    readonly name = 'Martin M1';
    readonly scanTime = 0.146432;
    readonly windowFactor = 2.95;
}

/**
 * Martin M2 Mode (VIS: 40)
 * 320x256 RGB
 */
export class MartinM2 extends MartinMode {
    readonly id = 40;
    readonly name = 'Martin M2';
    readonly scanTime = 0.073216;
    readonly windowFactor = 5.9;
}
