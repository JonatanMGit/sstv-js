/**
 * Streaming SSTV Decoder with FM demodulation
 */

import { EventEmitter } from 'events';
import {
    SSTVMode,
    DecoderOptions,
    DecodedImage,
    ColorFormat
} from './types';
import { Demodulator, SyncPulseWidth } from './utils/demodulator';
import { getModeByVIS, getAllModes } from './modes';
import { frequencyToPixel } from './constants';
import * as CONST from './constants';
import { yCrCbToRgb, yuvToRgb, interpolateChroma } from './utils/colorspace';
import { FFTPeakFinder } from './utils/fft-helper';

/**
 * Internal image data structure during decoding
 */
interface InternalImageData {
    mode: SSTVMode;
    width: number;
    height: number;
    channels: Uint8Array[];
    linesDecoded: number;
    slantCorrection: number;
}

/**
 * Main streaming SSTV decoder class using FM demodulation
 */
export class SSTVDecoder extends EventEmitter {
    private samples: Float32Array;
    private sampleRate: number;
    private demodulator: Demodulator;
    private mode: SSTVMode | null = null;
    private options: DecoderOptions;

    // Demodulated frequency buffer (for sync detection)
    private scanLineBuffer: Float32Array;
    private currentSample: number = 0;

    // FFT peak finder for pixel decoding
    private fftPeakFinder: FFTPeakFinder;

    // Mode detection arrays
    private syncPulse5msModes: SSTVMode[] = [];
    private syncPulse9msModes: SSTVMode[] = [];
    private syncPulse20msModes: SSTVMode[] = [];

    // Sync tracking
    private lastSyncPulseIndex: number = 0;
    private currentScanLineSamples: number = 0;
    private lastFrequencyOffset: number = 0;

    // Recent sync pulses and scan lines for mode detection
    private last5msSyncPulses: number[] = [];
    private last9msSyncPulses: number[] = [];
    private last20msSyncPulses: number[] = [];
    private last5msScanLines: number[] = [];
    private last9msScanLines: number[] = [];
    private last20msScanLines: number[] = [];

    // VIS code detection
    private leaderBreakIndex: number = 0;
    private visCandidates: Array<{ index: number, freqOffset: number }> = [];

    // Detected sync pulses for image reconstruction
    private detectedSyncPulses: number[] = [];

    // Constants
    private readonly scanLineMaxSeconds = 7;
    private readonly scanLineMinSeconds = 0.05;
    private readonly scanLineToleranceSeconds = 0.001;
    private readonly syncPulseToleranceSeconds = 0.03;

    constructor(samples: Float32Array, options: DecoderOptions) {
        super();

        this.samples = samples;
        this.sampleRate = options.sampleRate;
        this.options = options;

        // Create FM demodulator
        this.demodulator = new Demodulator(this.sampleRate);

        // Allocate scan line buffer for demodulated signal (used for sync detection)
        this.scanLineBuffer = new Float32Array(this.samples.length);

        // Initialize FFT peak finder with 4096 size
        // Provides ~11.7Hz resolution at 48kHz
        this.fftPeakFinder = new FFTPeakFinder(4096, this.sampleRate);

        // Initialize mode lists by sync pulse width
        this.initializeModes();

        // Initialize sync tracking arrays
        const syncPulseCount = 5;
        const scanLineCount = 4;
        this.last5msSyncPulses = new Array(syncPulseCount).fill(0);
        this.last9msSyncPulses = new Array(syncPulseCount).fill(0);
        this.last20msSyncPulses = new Array(syncPulseCount).fill(0);
        this.last5msScanLines = new Array(scanLineCount).fill(0);
        this.last9msScanLines = new Array(scanLineCount).fill(0);
        this.last20msScanLines = new Array(scanLineCount).fill(0);
    }

    /**
     * Initialize mode lists categorized by sync pulse width
     */
    private initializeModes(): void {
        const allModes = getAllModes();

        for (const mode of allModes) {
            const syncMs = mode.syncPulse * 1000;

            if (Math.abs(syncMs - 5) < 1) {
                this.syncPulse5msModes.push(mode);
            } else if (Math.abs(syncMs - 9) < 1) {
                this.syncPulse9msModes.push(mode);
            } else if (Math.abs(syncMs - 20) < 2) {
                this.syncPulse20msModes.push(mode);
            }
        }
    }

    /**
     * Start decoding - returns decoded image or null if no SSTV signal found
     */
    async decode(): Promise<DecodedImage | null> {
        try {
            // Process audio in chunks
            const chunkSize = Math.floor(0.1 * this.sampleRate); // 100ms chunks
            const demodOutput = new Float32Array(chunkSize);

            for (let pos = 0; pos < this.samples.length; pos += chunkSize) {
                const end = Math.min(pos + chunkSize, this.samples.length);
                const chunk = this.samples.slice(pos, end);
                const output = demodOutput.subarray(0, chunk.length);

                // Demodulate chunk
                const result = this.demodulator.process(chunk, output);

                // Store demodulated values
                for (let i = 0; i < output.length; i++) {
                    this.scanLineBuffer[this.currentSample++] = output[i];

                    // Never shift buffer - keep all samples for decoding
                    // (Memory usage is acceptable for typical SSTV signals)
                }

                // Check for sync pulse
                if (result.syncPulseDetected && result.syncPulseWidth !== undefined) {
                    const syncPulseIndex = this.currentSample + (result.syncPulseOffset || 0) - output.length;
                    await this.handleSyncPulse(result.syncPulseWidth, syncPulseIndex, result.frequencyOffset || 0);
                }

                // Check pending VIS candidates
                await this.checkVisCandidates();

                this.emit('searching', pos / this.sampleRate);
            }

            // If we have a mode and decoded data, return it
            if (this.mode) {
                const image = await this.decodeImageData(this.lastSyncPulseIndex);
                this.emit('decodingComplete', image);
                return image;
            }

            this.emit('error', new Error('No SSTV signal found'), false);
            return null;
        } catch (error) {
            this.emit('error', error as Error, false);
            return null;
        }
    }

    /**
     * Check pending VIS candidates to see if we have enough data
     */
    private async checkVisCandidates(): Promise<void> {
        if (this.mode) return; // Mode already found

        const visCodeBitSamples = Math.floor(0.03 * this.sampleRate);
        const leaderToneSamples = Math.floor(0.3 * this.sampleRate);
        const leaderToneToleranceSamples = Math.floor(0.06 * this.sampleRate);
        const visCodeSamples = Math.floor(0.3 * this.sampleRate);

        // Iterate backwards to allow removing
        for (let i = this.visCandidates.length - 1; i >= 0; i--) {
            const candidate = this.visCandidates[i];
            const requiredSamples = candidate.index + leaderToneSamples + leaderToneToleranceSamples + visCodeSamples;

            if (this.currentSample >= requiredSamples) {
                // We have enough data, try to decode
                const visMode = await this.tryDecodeVIS(candidate.index, candidate.freqOffset);
                if (visMode) {
                    this.mode = visMode;
                    this.emit('headerFound', candidate.index);
                    this.emit('modeDetected', this.mode, this.mode.id);
                    this.emit('decodingStarted', this.mode);

                    const visDuration = 0.300;
                    // Last sync pulse index points to the end of the VIS code (start of image data)
                    // Sequence: Break (10ms) -> Leader (300ms) -> VIS (300ms)
                    const breakSamples = Math.floor(CONST.CALIB_BREAK * this.sampleRate);
                    const leaderSamples = Math.floor(CONST.CALIB_LEADER_2 * this.sampleRate);

                    // Set start point slightly back (0.1s) to ensure alignSync catches the first sync pulse
                    // consistently. This prevents slanting on the first few lines.
                    const safetyMargin = Math.floor(0.1 * this.sampleRate);

                    this.lastSyncPulseIndex = candidate.index + breakSamples + leaderSamples + Math.round(visDuration * this.sampleRate) - safetyMargin;

                    this.currentScanLineSamples = Math.floor(this.mode.lineTime * this.sampleRate);
                    this.lastFrequencyOffset = candidate.freqOffset;

                    // Clear candidates
                    this.visCandidates = [];
                    return;
                } else {
                    // Failed to decode, remove candidate
                    this.visCandidates.splice(i, 1);
                }
            } else {
                // Not enough data yet, keep candidate
                // Assuming candidates are ordered by index, earlier ones might be ready
            }
        }
    }

    /**
     * Handle detected sync pulse
     */
    private async handleSyncPulse(width: SyncPulseWidth, index: number, freqOffset: number): Promise<void> {
        let modes: SSTVMode[];
        let syncPulses: number[];
        let scanLines: number[];

        // Select appropriate arrays based on pulse width
        switch (width) {
            case SyncPulseWidth.FiveMilliSeconds:
                modes = this.syncPulse5msModes;
                syncPulses = this.last5msSyncPulses;
                scanLines = this.last5msScanLines;
                break;
            case SyncPulseWidth.NineMilliSeconds:
                modes = this.syncPulse9msModes;
                syncPulses = this.last9msSyncPulses;
                scanLines = this.last9msScanLines;
                this.leaderBreakIndex = index; // Could be VIS code
                break;
            case SyncPulseWidth.TwentyMilliSeconds:
                modes = this.syncPulse20msModes;
                syncPulses = this.last20msSyncPulses;
                scanLines = this.last20msScanLines;
                this.leaderBreakIndex = index; // Could be VIS code
                break;
            default:
                return;
        }

        // Try VIS code detection for 9ms and 20ms pulses
        if (width !== SyncPulseWidth.FiveMilliSeconds) {
            // Store potentially valid horizontal sync pulses (9ms for Robot36)
            // We store all of them and filter during image reconstruction
            if (width === SyncPulseWidth.NineMilliSeconds && this.mode) {
                this.detectedSyncPulses.push(index);
            }

            // Queue potential VIS candidate to act on when enough data available
            this.visCandidates.push({ index, freqOffset });
        }

        // Update sync pulse history
        this.updateSyncHistory(syncPulses, scanLines, index);

        // Detect mode from scan line timing
        const meanScanLine = this.calculateMean(scanLines);
        const detectedMode = this.detectMode(modes, Math.round(meanScanLine));

        if (detectedMode && (!this.mode || detectedMode === this.mode)) {
            if (!this.mode) {
                this.mode = detectedMode;
                this.emit('modeDetected', this.mode, this.mode.id);
                this.emit('decodingStarted', this.mode);
                // Only set lastSyncPulseIndex when first detecting the mode
                this.lastSyncPulseIndex = index;
            }
            this.currentScanLineSamples = Math.floor(this.mode.lineTime * this.sampleRate);
            this.lastFrequencyOffset = freqOffset;
        }
    }

    /**
     * Update sync pulse history
     */
    private updateSyncHistory(syncPulses: number[], scanLines: number[], newIndex: number): void {
        // Shift arrays
        for (let i = 1; i < syncPulses.length; i++) {
            syncPulses[i - 1] = syncPulses[i];
        }
        syncPulses[syncPulses.length - 1] = newIndex;

        for (let i = 1; i < scanLines.length; i++) {
            scanLines[i - 1] = scanLines[i];
        }
        scanLines[scanLines.length - 1] = syncPulses[syncPulses.length - 1] - syncPulses[syncPulses.length - 2];
    }

    /**
     * Try to decode VIS code
     */
    private async tryDecodeVIS(breakIndex: number, freqOffset: number): Promise<SSTVMode | null> {
        // Check if we have enough data for VIS code
        const visCodeBitSamples = Math.floor(0.03 * this.sampleRate);
        const leaderToneSamples = Math.floor(0.3 * this.sampleRate);
        const breakSamples = Math.floor(CONST.CALIB_BREAK * this.sampleRate);
        const leaderToneToleranceSamples = Math.floor(0.06 * this.sampleRate);
        const visCodeSamples = Math.floor(0.3 * this.sampleRate);

        if (breakIndex < visCodeBitSamples + leaderToneToleranceSamples) return null;
        if (this.currentSample < breakIndex + leaderToneSamples + leaderToneToleranceSamples + visCodeSamples) {
            return null;
        }

        // Check leader tone before break
        let preBreakFreq = 0;
        for (let i = 0; i < leaderToneToleranceSamples; i++) {
            preBreakFreq += this.scanLineBuffer[breakIndex - visCodeBitSamples - leaderToneToleranceSamples + i];
        }
        preBreakFreq = this.denormalizeFrequency(preBreakFreq / leaderToneToleranceSamples);

        if (Math.abs(preBreakFreq - CONST.FREQ_LEADER) > 100) return null;

        // Decode VIS bits
        const visBeginIndex = breakIndex + leaderToneSamples + breakSamples; // Keep breakSamples
        const visBitFreqs: number[] = [];

        for (let bit = 0; bit < 10; bit++) {
            let freq = 0;
            const start = visBeginIndex + bit * visCodeBitSamples + 5; // Skip transitions
            const end = start + visCodeBitSamples - 10;
            for (let i = start; i < end && i < this.currentSample; i++) {
                freq += this.scanLineBuffer[i];
            }
            // Correct for frequency offset derived from calibration break/sync
            freq = (freq / (visCodeBitSamples - 10)) - freqOffset;
            freq = this.denormalizeFrequency(freq);
            visBitFreqs.push(freq);
        }

        // Decode VIS code
        let visCode = 0;
        for (let i = 1; i < 9; i++) {
            visCode |= (visBitFreqs[i] < 1250 ? 1 : 0) << (i - 1);
        }
        visCode &= 127;

        // Find mode
        return getModeByVIS(visCode);
    }

    /**
     * Denormalize frequency from [-1, 1] to Hz
     */
    private denormalizeFrequency(normalized: number): number {
        const scanLineBandwidth = CONST.FREQ_WHITE - CONST.FREQ_BLACK;
        const centerFrequency = (1000 + 2800) / 2;
        return normalized * scanLineBandwidth / 2 + centerFrequency;
    }

    /**
     * Detect mode from scan line length
     */
    private detectMode(modes: SSTVMode[], scanLineSamples: number): SSTVMode | null {
        const tolerance = Math.floor(this.scanLineToleranceSeconds * this.sampleRate);
        let bestMode: SSTVMode | null = null;
        let bestDist = Infinity;

        for (const mode of modes) {
            const expectedSamples = Math.floor(mode.lineTime * this.sampleRate);
            const dist = Math.abs(scanLineSamples - expectedSamples);
            if (dist <= tolerance && dist < bestDist) {
                bestDist = dist;
                bestMode = mode;
            }
        }

        return bestMode;
    }

    /**
     * Calculate mean of array
     */
    private calculateMean(arr: number[]): number {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    /**
     * Shift scan line buffer
     */
    private shiftSamples(shift: number): void {
        if (shift <= 0 || shift > this.currentSample) return;
        this.scanLineBuffer.copyWithin(0, shift, this.currentSample);
        this.currentSample -= shift;
        this.lastSyncPulseIndex -= shift;
        this.leaderBreakIndex -= shift;

        // Adjust stored sync pulses
        for (let i = 0; i < this.detectedSyncPulses.length; i++) {
            this.detectedSyncPulses[i] -= shift;
        }
        // Remove pulses that shifted out of buffer (negative index)
        this.detectedSyncPulses = this.detectedSyncPulses.filter(idx => idx >= 0);
    }

    /**
     * Align to sync pulse
     * Searches for frequency > 1350Hz to find end of sync pulse
     */
    private alignSync(alignStart: number, startOfSync: boolean = true): number | null {
        if (!this.mode) return null;

        const syncWindow = Math.round(this.mode.syncPulse * 1.4 * this.sampleRate);
        const alignStop = this.samples.length - syncWindow;

        if (alignStop <= alignStart) {
            return null;
        }

        // Search for frequency > 1350Hz (end of sync pulse)
        let currentSample;
        for (currentSample = alignStart; currentSample < alignStop; currentSample++) {
            const sectionEnd = currentSample + syncWindow;
            const searchSection = this.samples.subarray(currentSample, sectionEnd);

            const freq = this.fftPeakFinder.findPeakFrequency(searchSection);
            if (freq > 1350) {
                break;
            }
        }

        const endSync = currentSample + Math.floor(syncWindow / 2);

        if (startOfSync) {
            return endSync - Math.round(this.mode.syncPulse * this.sampleRate);
        } else {
            return endSync;
        }
    }

    /**
     * Decode image data (line-by-line sync)
     * Special handling for PD modes which decode 2 lines per sync pulse
     */
    private async decodeImageData(startSample: number): Promise<DecodedImage> {
        if (!this.mode) {
            throw new Error('No mode detected');
        }

        // Check if this is a PD mode (4 channels = Y-even, V, U, Y-odd)
        const isPDMode = this.mode.channelCount === 4 && this.mode.colorFormat === ColorFormat.YCrCb;

        const imageData: InternalImageData = {
            mode: this.mode,
            width: this.mode.width,
            height: this.mode.height,
            channels: new Array(this.mode.channelCount).fill(null).map(() =>
                new Uint8Array(this.mode!.width * this.mode!.height)
            ),
            linesDecoded: 0,
            slantCorrection: 1.0
        };

        let seqStart = startSample;

        // Check if this is a Scottie-style mode (sync in the middle of line)
        const hasMidSync = this.mode.syncChannel !== undefined && this.mode.syncChannel > 0;

        // For modes with start sync, align to END of start sync
        if (this.mode.hasStartSync) {
            const aligned = this.alignSync(seqStart, false); // false = end of sync
            if (aligned !== null) {
                seqStart = aligned;
            }
        }

        if (isPDMode) {
            // PD modes: decode 2 lines per sync pulse
            // Each scan line contains: Y-even, V, U, Y-odd
            for (let linePair = 0; linePair < this.mode.height / 2; linePair++) {
                if (linePair > 0) {
                    seqStart += Math.round(this.mode.lineTime * this.sampleRate);
                }

                // Align to sync pulse (even for first line pair to fix VIS timing errors)
                const aligned = this.alignSync(seqStart, true);
                if (aligned !== null) {
                    seqStart = aligned;
                } else if (linePair > 0) {
                    this.emit('warning', 'Reached end of audio');
                    break;
                }

                const evenLine = linePair * 2;
                const oddLine = linePair * 2 + 1;

                // Decode all 4 channels from this sync pulse
                for (let ch = 0; ch < 4; ch++) {
                    const channelOffset = this.mode.getChannelOffset(evenLine, ch);
                    const channelStart = seqStart + Math.floor(channelOffset * this.sampleRate);
                    const scanTime = this.mode.getScanTime(evenLine, ch);

                    const pixelTime = scanTime / this.mode.width;
                    const centerWindowTime = (pixelTime * this.mode.windowFactor) / 2;
                    const pixelWindow = Math.round(centerWindowTime * 2 * this.sampleRate);

                    for (let pixel = 0; pixel < this.mode.width; pixel++) {
                        const centerPos = channelStart + (pixel * pixelTime) * this.sampleRate;
                        const windowStart = Math.floor(centerPos - centerWindowTime * this.sampleRate);
                        const windowEnd = Math.min(windowStart + pixelWindow, this.samples.length);

                        if (windowEnd > windowStart && windowStart >= 0) {
                            const audioWindow = this.samples.subarray(windowStart, windowEnd);
                            const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                            const value = FFTPeakFinder.frequencyToPixel(peakFreq);

                            // PD channel layout: 0=Y-even, 1=V, 2=U, 3=Y-odd
                            if (ch === 0) {
                                // Y-even channel
                                imageData.channels[0][evenLine * this.mode.width + pixel] = value;
                            } else if (ch === 1) {
                                // V channel - shared by both lines
                                imageData.channels[1][evenLine * this.mode.width + pixel] = value;
                                imageData.channels[1][oddLine * this.mode.width + pixel] = value;
                            } else if (ch === 2) {
                                // U channel - shared by both lines
                                imageData.channels[2][evenLine * this.mode.width + pixel] = value;
                                imageData.channels[2][oddLine * this.mode.width + pixel] = value;
                            } else if (ch === 3) {
                                // Y-odd channel
                                imageData.channels[0][oddLine * this.mode.width + pixel] = value;
                            }
                        }
                    }
                }

                imageData.linesDecoded = oddLine + 1;
                this.emit('lineDecoded', oddLine, null, imageData);
            }
        } else if (hasMidSync) {
            // Scottie-style modes: sync is in the middle of the line (between Blue and Red)
            // For line 0 with hasStartSync, adjust seq_start backwards
            if (this.mode.hasStartSync && this.mode.syncChannel !== undefined) {
                const syncChannelOffset = this.mode.getChannelOffset(0, this.mode.syncChannel);
                const syncChannelScanTime = this.mode.getScanTime(0, this.mode.syncChannel);
                seqStart -= Math.round((syncChannelOffset + syncChannelScanTime) * this.sampleRate);
            }

            for (let line = 0; line < this.mode.height; line++) {
                // Decode each channel
                for (let ch = 0; ch < this.mode.channelCount; ch++) {
                    // Re-align to sync at syncChannel
                    if (ch === this.mode.syncChannel) {
                        if (line > 0 || ch > 0) {
                            seqStart += Math.round(this.mode.lineTime * this.sampleRate);
                        }

                        const aligned = this.alignSync(seqStart, true);
                        if (aligned !== null) {
                            seqStart = aligned;
                        } else if (line > 0) {
                            this.emit('warning', 'Reached end of audio');
                            break;
                        }
                    }

                    const channelOffset = this.mode.getChannelOffset(line, ch);
                    const channelStart = seqStart + Math.floor(channelOffset * this.sampleRate);
                    const scanTime = this.mode.getScanTime(line, ch);

                    // Calculate pixel time and window parameters
                    const pixelTime = scanTime / this.mode.width;
                    const centerWindowTime = (pixelTime * this.mode.windowFactor) / 2;
                    const pixelWindow = Math.round(centerWindowTime * 2 * this.sampleRate);

                    // Decode pixels for this channel
                    for (let pixel = 0; pixel < this.mode.width; pixel++) {
                        const centerPos = channelStart + (pixel * pixelTime) * this.sampleRate;
                        const windowStart = Math.floor(centerPos - centerWindowTime * this.sampleRate);
                        const windowEnd = Math.min(windowStart + pixelWindow, this.samples.length);

                        if (windowEnd > windowStart && windowStart >= 0) {
                            const audioWindow = this.samples.subarray(windowStart, windowEnd);
                            const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                            const value = FFTPeakFinder.frequencyToPixel(peakFreq);

                            const actualChannel = this.mode.channelOrder[ch];
                            imageData.channels[actualChannel][line * this.mode.width + pixel] = value;
                        }
                    }
                }

                imageData.linesDecoded = line + 1;
                this.emit('lineDecoded', line, null, imageData);
            }
        } else {
            // Regular modes: decode line by line (sync at start of each line)
            for (let line = 0; line < this.mode.height; line++) {
                // Align to sync pulse for each line (fixing VIS start offset)
                if (line > 0) {
                    seqStart += Math.round(this.mode.lineTime * this.sampleRate);
                }

                const aligned = this.alignSync(seqStart, true);
                if (aligned !== null) {
                    seqStart = aligned;
                } else if (line > 0) {
                    this.emit('warning', 'Reached end of audio');
                    break;
                }

                // Decode each channel
                for (let ch = 0; ch < this.mode.channelCount; ch++) {
                    const channelOffset = this.mode.getChannelOffset(line, ch);
                    const channelStart = seqStart + Math.floor(channelOffset * this.sampleRate);
                    const scanTime = this.mode.getScanTime(line, ch);

                    // Calculate pixel time and window parameters
                    const pixelTime = scanTime / this.mode.width;
                    const centerWindowTime = (pixelTime * this.mode.windowFactor) / 2;
                    const pixelWindow = Math.round(centerWindowTime * 2 * this.sampleRate);

                    // Decode pixels for this channel
                    for (let pixel = 0; pixel < this.mode.width; pixel++) {
                        // Calculate window position
                        // Window center is at: channelStart + pixel * pixelTime
                        // Window should be centered around this point
                        const centerPos = channelStart + (pixel * pixelTime) * this.sampleRate;
                        const windowStart = Math.floor(centerPos - centerWindowTime * this.sampleRate);
                        const windowEnd = Math.min(windowStart + pixelWindow, this.samples.length);

                        if (windowEnd > windowStart && windowStart >= 0) {
                            // Extract raw audio window and use FFT to find peak frequency
                            const audioWindow = this.samples.subarray(windowStart, windowEnd);
                            const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                            const value = FFTPeakFinder.frequencyToPixel(peakFreq);

                            const actualChannel = this.mode.channelOrder[ch];
                            imageData.channels[actualChannel][line * this.mode.width + pixel] = value;
                        }
                    }
                }

                imageData.linesDecoded = line + 1;
                this.emit('lineDecoded', line, null, imageData);
            }
        }

        return this.createDecodedImage(imageData);
    }

    /**
     * Convert InternalImageData to DecodedImage
     */
    private createDecodedImage(imageData: InternalImageData): DecodedImage {
        // Convert flat channels to 3D array [line][channel][pixel]
        const data: number[][][] = [];

        for (let line = 0; line < imageData.height; line++) {
            const lineData: number[][] = [];
            for (let ch = 0; ch < imageData.mode.channelCount; ch++) {
                const channelData: number[] = [];
                for (let pixel = 0; pixel < imageData.width; pixel++) {
                    channelData.push(imageData.channels[ch][line * imageData.width + pixel]);
                }
                lineData.push(channelData);
            }
            data.push(lineData);
        }

        return {
            mode: imageData.mode,
            data,
            width: imageData.width,
            height: imageData.height,
            linesDecoded: imageData.linesDecoded,
            slantCorrection: imageData.slantCorrection
        };
    }
}


/**
 * Convert decoded SSTV image to RGB byte array
 */
export function imageDataToRGB(decoded: DecodedImage): Uint8Array {
    const { mode, data, width, height } = decoded;
    const rgb = new Uint8Array(width * height * 3);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;

            if (mode.colorFormat === ColorFormat.RGB) {
                rgb[idx] = data[y][0][x];
                rgb[idx + 1] = data[y][1][x];
                rgb[idx + 2] = data[y][2][x];
            } else if (mode.colorFormat === ColorFormat.YCrCb) {
                const yVal = data[y][0][x];

                if (mode.channelCount === 2) {
                    // Robot 36 (Even=V, Odd=U)
                    const chroma = interpolateChroma(y, height, data, width);
                    // Pass correct order: y, u, v
                    // InterpolateChroma returns v (red diff) and u (blue diff)
                    const [r, g, b] = yuvToRgb(yVal, chroma.u[x], chroma.v[x]);
                    rgb[idx] = r;
                    rgb[idx + 1] = g;
                    rgb[idx + 2] = b;
                } else if (mode.channelCount === 3) {
                    // Robot 72 - 4:2:2
                    // Channels are: 0=Y, 1=V(Cr), 2=U(Cb)
                    // yuvToRgb expects (y, u, v) order
                    const vVal = data[y][1][x];  // V (Cr)
                    const uVal = data[y][2][x];  // U (Cb)
                    const [r, g, b] = yuvToRgb(yVal, uVal, vVal);
                    rgb[idx] = r;
                    rgb[idx + 1] = g;
                    rgb[idx + 2] = b;
                } else if (mode.channelCount === 4) {
                    // PD modes - channels are: 0=Y, 1=V(Cr), 2=U(Cb)
                    // Function signature is (y, u, v)
                    const vVal = data[y][1][x];  // V = Cr
                    const uVal = data[y][2][x];  // U = Cb
                    const [r, g, b] = yuvToRgb(yVal, uVal, vVal);
                    rgb[idx] = r;
                    rgb[idx + 1] = g;
                    rgb[idx + 2] = b;
                }
            } else if (mode.colorFormat === ColorFormat.Grayscale) {
                const gray = data[y][0][x];
                rgb[idx] = gray;
                rgb[idx + 1] = gray;
                rgb[idx + 2] = gray;
            }
        }
    }

    return rgb;
}

