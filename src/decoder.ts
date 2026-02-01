/**
 * Batch SSTV Decoder with FM demodulation
 * 
 * This decoder processes complete audio files and returns decoded images.
 * For streaming/real-time decoding, use StreamingDecoder instead.
 */

import { EventEmitter } from 'events';
import {
    SSTVMode,
    DecoderOptions,
    DecodedImage,
    ColorFormat
} from './types';
import { Demodulator, SyncPulseWidth } from './utils/demodulator';
import * as CONST from './constants';
import { FFTPeakFinder } from './utils/fft-helper';
import {
    InternalImageData,
    VISCandidate,
    categorizeModesBySyncPulse,
    calculateMean,
    detectModeFromTiming,
    denormalizeFrequency,
    SyncHistoryTracker,
    VISDecoder,
    isPDMode,
    hasMidSync,
    imageDataToRGB
} from './decoder-core';

/**
 * Main batch SSTV decoder class using FM demodulation
 */
export class SSTVDecoder extends EventEmitter {
    private readonly samples: Float32Array;
    private readonly sampleRate: number;
    private readonly demodulator: Demodulator;
    private readonly options: DecoderOptions;
    private readonly fftPeakFinder: FFTPeakFinder;

    private mode: SSTVMode | null = null;

    // Demodulated frequency buffer (for sync detection)
    private readonly scanLineBuffer: Float32Array;
    private currentSample: number = 0;

    // Mode detection arrays (readonly after initialization)
    private readonly syncPulse5msModes: SSTVMode[];
    private readonly syncPulse9msModes: SSTVMode[];
    private readonly syncPulse20msModes: SSTVMode[];

    // Sync tracking using shared class
    private readonly sync5ms: SyncHistoryTracker;
    private readonly sync9ms: SyncHistoryTracker;
    private readonly sync20ms: SyncHistoryTracker;

    // State tracking
    private lastSyncPulseIndex: number = 0;
    private currentScanLineSamples: number = 0;
    private lastFrequencyOffset: number = 0;

    // VIS code detection
    private leaderBreakIndex: number = 0;
    private visCandidates: VISCandidate[] = [];
    private readonly visDecoder: VISDecoder;

    // Detected sync pulses for image reconstruction
    private detectedSyncPulses: number[] = [];

    // Cached constants
    private readonly scanLineToleranceSeconds = 0.001 as const;

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

        // Initialize VIS decoder
        this.visDecoder = new VISDecoder(this.sampleRate, this.fftPeakFinder);

        // Initialize mode lists by sync pulse width (using shared function)
        const { pulse5ms, pulse9ms, pulse20ms } = categorizeModesBySyncPulse();
        this.syncPulse5msModes = pulse5ms;
        this.syncPulse9msModes = pulse9ms;
        this.syncPulse20msModes = pulse20ms;

        // Initialize sync tracking using shared class
        this.sync5ms = new SyncHistoryTracker();
        this.sync9ms = new SyncHistoryTracker();
        this.sync20ms = new SyncHistoryTracker();
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

        const requiredSamples = this.visDecoder.getRequiredSamples();

        // Iterate backwards to allow removing
        for (let i = this.visCandidates.length - 1; i >= 0; i--) {
            const candidate = this.visCandidates[i];

            if (this.currentSample >= candidate.index + requiredSamples) {
                // We have enough data, try to decode
                const visMode = this.visDecoder.tryDecodeFromDemodulated(
                    this.scanLineBuffer,
                    this.currentSample,
                    candidate.index,
                    candidate.freqOffset
                );
                if (visMode) {
                    this.mode = visMode;
                    this.emit('headerFound', candidate.index);
                    this.emit('modeDetected', this.mode, this.mode.id);
                    this.emit('decodingStarted', this.mode);

                    // Set start point slightly back (0.1s) to ensure alignSync catches the first sync pulse
                    const safetyMargin = Math.floor(0.1 * this.sampleRate);
                    this.lastSyncPulseIndex = this.visDecoder.calculateImageStartIndex(candidate.index) - safetyMargin;

                    this.currentScanLineSamples = Math.floor(this.mode.lineTime * this.sampleRate);
                    this.lastFrequencyOffset = candidate.freqOffset;

                    // Clear candidates
                    this.visCandidates = [];
                    return;
                } else {
                    // Failed to decode, remove candidate
                    this.visCandidates.splice(i, 1);
                }
            }
        }
    }

    /**
     * Handle detected sync pulse
     */
    private async handleSyncPulse(width: SyncPulseWidth, index: number, freqOffset: number): Promise<void> {
        let modes: SSTVMode[];
        let syncTracker: SyncHistoryTracker;

        // Select appropriate arrays based on pulse width
        switch (width) {
            case SyncPulseWidth.FiveMilliSeconds:
                modes = this.syncPulse5msModes;
                syncTracker = this.sync5ms;
                break;
            case SyncPulseWidth.NineMilliSeconds:
                modes = this.syncPulse9msModes;
                syncTracker = this.sync9ms;
                this.leaderBreakIndex = index; // Could be VIS code
                break;
            case SyncPulseWidth.TwentyMilliSeconds:
                modes = this.syncPulse20msModes;
                syncTracker = this.sync20ms;
                this.leaderBreakIndex = index; // Could be VIS code
                break;
            default:
                return;
        }

        // Try VIS code detection for 9ms and 20ms pulses
        if (width !== SyncPulseWidth.FiveMilliSeconds) {
            // Store potentially valid horizontal sync pulses (9ms for Robot36)
            if (width === SyncPulseWidth.NineMilliSeconds && this.mode) {
                this.detectedSyncPulses.push(index);
            }

            // Queue potential VIS candidate
            this.visCandidates.push({ index, freqOffset });
        }

        // Update sync pulse history using shared tracker
        syncTracker.update(index, freqOffset);

        // Detect mode from scan line timing
        const meanScanLine = calculateMean(syncTracker.scanLines);
        const detectedMode = detectModeFromTiming(modes, Math.round(meanScanLine), this.sampleRate, this.scanLineToleranceSeconds);

        if (detectedMode && (!this.mode || detectedMode === this.mode)) {
            if (!this.mode) {
                this.mode = detectedMode;
                this.emit('modeDetected', this.mode, this.mode.id);
                this.emit('decodingStarted', this.mode);
                this.lastSyncPulseIndex = index;
            }
            this.currentScanLineSamples = Math.floor(this.mode.lineTime * this.sampleRate);
            this.lastFrequencyOffset = freqOffset;
        }
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

        // Adjust sync trackers
        this.sync5ms.adjustIndices(shift);
        this.sync9ms.adjustIndices(shift);
        this.sync20ms.adjustIndices(shift);

        // Adjust stored sync pulses
        for (let i = 0; i < this.detectedSyncPulses.length; i++) {
            this.detectedSyncPulses[i] -= shift;
        }
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
        const isPD = isPDMode(this.mode);

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
        const hasMidLineSync = hasMidSync(this.mode);

        // For modes with start sync, align to END of start sync
        if (this.mode.hasStartSync) {
            const aligned = this.alignSync(seqStart, false); // false = end of sync
            if (aligned !== null) {
                seqStart = aligned;
            }
        }

        if (isPD) {
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
        } else if (hasMidLineSync) {
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


// Re-export imageDataToRGB from decoder-core for backwards compatibility
export { imageDataToRGB } from './decoder-core';
