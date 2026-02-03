/**
 * Scottie Modes: S1, S2, DX
 * 
 * All Scottie modes share the same structure:
 *   Sep -> Green -> Sep -> Blue -> Sync -> Porch -> Red
 * 
 * The sync pulse appears mid-line (between Blue and Red).
 */

import { ColorFormat, ChromaSubsampling, SSTVMode } from '../types';

/**
 * Abstract base class for all Scottie modes.
 * Subclasses only need to define: id, name, scanTime, and windowFactor.
 */
abstract class ScottieMode implements SSTVMode {
    // Common properties for all Scottie modes
    readonly colorFormat = ColorFormat.RGB;
    readonly chromaSubsampling = ChromaSubsampling.Full;
    readonly width = 320;
    readonly height = 256;

    readonly syncPulse = 0.009;
    readonly syncPorch = 0.0015;

    readonly channelCount = 3;
    readonly channelOrder: readonly number[] = [1, 2, 0]; // Green, Blue, Red

    // Scottie modes have sync between Blue and Red (channel 2)
    readonly hasStartSync = true;
    readonly syncChannel = 2;

    // Common separator pulses
    readonly separatorPulses: readonly number[] = [0.0015, 0.0015, 0]; // No separator after Red

    abstract readonly id: number;
    abstract readonly name: string;
    abstract readonly scanTime: number;
    abstract readonly windowFactor: number;

    /**
     * Scan times array (all channels have same scan time in Scottie modes)
     */
    get scanTimes(): readonly number[] {
        return [this.scanTime, this.scanTime, this.scanTime];
    }

    /**
     * Total line time including all components.
     * Scottie structure: Sep + Green + Sep + Blue + Sync + Porch + Red
     */
    get lineTime(): number {
        return this.separatorPulses[0] + this.scanTime +
            this.separatorPulses[1] + this.scanTime +
            this.syncPulse + this.syncPorch + this.scanTime;
    }

    /**
     * Calculate channel offset from sync pulse.
     * 
     * Scottie uses mid-line sync, so we calculate forward from sync:
     *   Sync -> Porch -> Red -> Sep -> Green -> Sep -> Blue
     * 
     * @param line - Line number (unused, all lines have same structure)
     * @param channel - Channel index (0=Green, 1=Blue, 2=Red in display order)
     * @returns Offset in seconds from sync pulse start
     */
    getChannelOffset(line: number, channel: number): number {
        const redOffset = this.syncPulse + this.syncPorch;

        // Channel 2 is Red (immediately after sync + porch)
        if (channel === 2) {
            return redOffset;
        }

        // Channel 0 is Green (after Red + separator)
        const greenOffset = redOffset + this.scanTime + this.separatorPulses[0];
        if (channel === 0) {
            return greenOffset;
        }

        // Channel 1 is Blue (after Green + separator)
        return greenOffset + this.scanTime + this.separatorPulses[1];
    }

    /**
     * Get scan time for a channel.
     * All Scottie channels have the same scan time.
     */
    getScanTime(line: number, channel: number): number {
        return this.scanTime;
    }
}

/**
 * Scottie S1 Mode (VIS: 60)
 * 320x256 RGB
 */
export class ScottieS1 extends ScottieMode {
    readonly id = 60;
    readonly name = 'Scottie S1';
    readonly scanTime = 0.138240;
    readonly windowFactor = 3.1;
}

/**
 * Scottie S2 Mode (VIS: 56)
 * 320x256 RGB
 */
export class ScottieS2 extends ScottieMode {
    readonly id = 56;
    readonly name = 'Scottie S2';
    readonly scanTime = 0.088064;
    readonly windowFactor = 4.8;
}

/**
 * Scottie DX Mode (VIS: 76)
 * 320x256 RGB
 */
export class ScottieDX extends ScottieMode {
    readonly id = 76;
    readonly name = 'Scottie DX';
    readonly scanTime = 0.345600;
    readonly windowFactor = 1.25;
}
