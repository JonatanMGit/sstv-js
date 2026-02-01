/**
 * Streaming SSTV Decoder
 * 
 * This decoder processes audio samples incrementally, allowing real-time
 * decoding from SDR streams or other continuous audio sources.
 * 
 * Unlike the batch decoder, this class:
 * - Accepts audio chunks via process()
 * - Maintains state between calls
 * - Emits events as lines are decoded
 * - Supports cancellation
 * 
 * @example
 * ```typescript
 * const decoder = new StreamingDecoder({ sampleRate: 48000 });
 * 
 * decoder.on('line', (event) => {
 *   console.log(`Line ${event.line} decoded`);
 *   // event.pixels contains RGB data for the line
 * });
 * 
 * decoder.on('imageComplete', (image) => {
 *   // Save or display the complete image
 * });
 * 
 * // Feed audio chunks as they arrive
 * sdrStream.on('data', (samples) => {
 *   decoder.process(samples);
 * });
 * 
 * // Optionally cancel
 * decoder.cancel();
 * ```
 */

import { EventEmitter } from 'events';
import {
    SSTVMode,
    DecodedImage,
    ColorFormat
} from './types';
import { Demodulator, SyncPulseWidth } from './utils/demodulator';
import { getModeByVIS } from './modes';
import * as CONST from './constants';
import { FFTPeakFinder } from './utils/fft-helper';
import {
    VISCandidate,
    categorizeModesBySyncPulse,
    calculateMean,
    calculateStdDev,
    detectModeFromTiming,
    SyncHistoryTracker,
    VISDecoder,
    ImageChannelBuffer,
    LinePixelDecoder,
    isPDMode
} from './decoder-core';

/**
 * Options for the streaming decoder
 */
export interface StreamingDecoderOptions {
    /** Sample rate of input audio (Hz) - required */
    sampleRate: number;

    /** Maximum buffer size in seconds (default: 10 seconds) */
    maxBufferSeconds?: number;

    /** FFT size for frequency analysis (default: 4096) */
    fftSize?: number;

    /** Force a specific mode by VIS code (skip auto-detection) */
    forceMode?: number;

    /** Whether to output raw/noise lines when no sync is detected (default: true) */
    outputNoise?: boolean;
}

/**
 * State of the streaming decoder
 */
export enum DecoderState {
    /** Searching for SSTV signal */
    Searching = 'searching',
    /** Decoding VIS code */
    DecodingVIS = 'decoding-vis',
    /** Decoding image lines */
    DecodingImage = 'decoding-image',
    /** Decoder was cancelled */
    Cancelled = 'cancelled'
}

/**
 * Event emitted when a line is decoded
 */
export interface LineEvent {
    /** Line number (0-indexed) */
    line: number;
    /** RGB pixel data for this line (width * 3 bytes) */
    pixels: Uint8Array;
    /** Whether this is noise/raw data (no sync detected) */
    isNoise: boolean;
    /** Image width */
    width: number;
    /** Expected image height (may be 0 if mode not yet detected) */
    height: number;
    /** Mode name if detected */
    modeName?: string;
    /** Total lines decoded so far */
    linesDecoded: number;
}

/**
 * Event emitted when a complete image is available
 */
export interface ImageCompleteEvent {
    /** The complete decoded image */
    image: DecodedImage;
    /** RGB pixel data (width * height * 3 bytes) */
    rgbData: Uint8Array;
}

/**
 * Event emitted when mode is detected
 */
export interface ModeDetectedEvent {
    /** Detected SSTV mode */
    mode: SSTVMode;
    /** VIS code */
    visCode: number;
    /** Detection method: 'vis' for VIS code, 'timing' for sync timing */
    method: 'vis' | 'timing';
}

/**
 * Events emitted by StreamingDecoder
 */
export interface StreamingDecoderEvents {
    /** Emitted for each decoded line */
    'line': (event: LineEvent) => void;
    /** Emitted when a complete image is decoded */
    'imageComplete': (event: ImageCompleteEvent) => void;
    /** Emitted when mode is detected */
    'modeDetected': (event: ModeDetectedEvent) => void;
    /** Emitted when searching for signal */
    'searching': (bufferedSeconds: number) => void;
    /** Emitted on errors */
    'error': (error: Error) => void;
    /** Emitted when decoder state changes */
    'stateChange': (state: DecoderState) => void;
    /** Emitted when decoder is reset (new image starting) */
    'reset': () => void;
}

/**
 * Streaming SSTV Decoder
 * 
 * Processes audio samples incrementally and emits events as lines are decoded.
 */
export class StreamingDecoder extends EventEmitter {
    // Configuration
    private readonly sampleRate: number;
    private readonly maxBufferSamples: number;
    private readonly outputNoise: boolean;
    private readonly forcedMode: number | undefined;

    // Audio buffer (ring buffer style, but we use shift for simplicity)
    private sampleBuffer: Float32Array;
    private bufferWritePos: number = 0;

    // Signal processing
    private readonly demodulator: Demodulator;
    private readonly fftPeakFinder: FFTPeakFinder;

    // Mode detection
    private readonly syncPulse5msModes: SSTVMode[];
    private readonly syncPulse9msModes: SSTVMode[];
    private readonly syncPulse20msModes: SSTVMode[];

    // Sync tracking (using shared classes)
    private readonly sync5ms: SyncHistoryTracker;
    private readonly sync9ms: SyncHistoryTracker;
    private readonly sync20ms: SyncHistoryTracker;

    // Decoder state
    private state: DecoderState = DecoderState.Searching;
    private currentMode: SSTVMode | null = null;
    private lastSyncPulseIndex: number = 0;
    private currentScanLineSamples: number = 0;
    private lastFrequencyOffset: number = 0;
    private cancelled: boolean = false;

    // Image data (using shared class)
    private readonly imageBuffer: ImageChannelBuffer;

    // VIS detection candidates
    private visCandidates: VISCandidate[] = [];

    // VIS decoder and line decoder (using shared classes)
    private readonly visDecoder: VISDecoder;
    private readonly lineDecoder: LinePixelDecoder;

    // Timing constants
    private readonly scanLineMinSamples: number;
    private readonly scanLineToleranceSamples: number;
    private leaderBreakIndex: number = 0;

    constructor(options: StreamingDecoderOptions) {
        super();

        this.sampleRate = options.sampleRate;
        this.maxBufferSamples = Math.floor((options.maxBufferSeconds ?? 10) * this.sampleRate);
        this.outputNoise = options.outputNoise ?? true;
        this.forcedMode = options.forceMode;

        // Allocate sample buffer
        this.sampleBuffer = new Float32Array(this.maxBufferSamples);

        // Initialize signal processing
        this.demodulator = new Demodulator(this.sampleRate);
        this.fftPeakFinder = new FFTPeakFinder(options.fftSize ?? 4096, this.sampleRate);

        // Initialize shared decoders
        this.visDecoder = new VISDecoder(this.sampleRate, this.fftPeakFinder);
        this.lineDecoder = new LinePixelDecoder(this.sampleRate, this.fftPeakFinder);
        this.imageBuffer = new ImageChannelBuffer();

        // Categorize modes by sync pulse width (using shared function)
        const { pulse5ms, pulse9ms, pulse20ms } = categorizeModesBySyncPulse();
        this.syncPulse5msModes = pulse5ms;
        this.syncPulse9msModes = pulse9ms;
        this.syncPulse20msModes = pulse20ms;

        // Initialize sync tracking (using shared class)
        this.sync5ms = new SyncHistoryTracker();
        this.sync9ms = new SyncHistoryTracker();
        this.sync20ms = new SyncHistoryTracker();

        // Calculate timing constants
        this.scanLineMinSamples = Math.round(0.05 * this.sampleRate);
        this.scanLineToleranceSamples = Math.round(0.001 * this.sampleRate);

        // If forced mode, set it up
        if (this.forcedMode !== undefined) {
            const mode = getModeByVIS(this.forcedMode);
            if (mode) {
                this.setMode(mode, 'vis');
            }
        }
    }

    /**
     * Get current decoder state
     */
    getState(): DecoderState {
        return this.state;
    }

    /**
     * Get current mode if detected
     */
    getMode(): SSTVMode | null {
        return this.currentMode;
    }

    /**
     * Get number of lines decoded
     */
    getLinesDecoded(): number {
        return this.imageBuffer.linesDecoded;
    }

    /**
     * Get current buffer fill level in seconds
     */
    getBufferedSeconds(): number {
        return this.bufferWritePos / this.sampleRate;
    }

    /**
     * Process audio samples
     * 
     * Call this method repeatedly with audio chunks from your SDR or audio source.
     * The decoder will emit events as lines are decoded.
     * 
     * @param samples Audio samples (mono, -1.0 to 1.0)
     * @returns true if processing should continue, false if cancelled
     */
    process(samples: Float32Array): boolean {
        if (this.cancelled) {
            return false;
        }

        // Temporary buffer for demodulator output
        const demodOutput = new Float32Array(samples.length);

        // Process through demodulator
        const result = this.demodulator.process(samples, demodOutput);

        // Store raw samples in buffer (we need raw audio for FFT-based decoding)
        for (let i = 0; i < samples.length; i++) {
            if (this.bufferWritePos >= this.maxBufferSamples) {
                // Shift buffer to make room
                this.shiftBuffer(Math.floor(this.maxBufferSamples / 2));
            }
            this.sampleBuffer[this.bufferWritePos++] = samples[i];
        }

        // Handle sync pulse detection
        if (result.syncPulseDetected && result.syncPulseWidth !== undefined) {
            const syncPulseIndex = this.bufferWritePos + (result.syncPulseOffset || 0) - samples.length;
            this.handleSyncPulse(result.syncPulseWidth, syncPulseIndex, result.frequencyOffset || 0);
        }

        // Check VIS candidates
        this.checkVisCandidates();

        // If we have a mode, decode lines based on expected timing when we have enough samples
        // This handles both sync pulse fallback AND noise passthrough
        if (this.currentMode && this.imageBuffer.linesDecoded < this.currentMode.height) {
            this.decodeLinesByTiming();
        }

        // Emit searching event periodically when no mode detected
        if (!this.currentMode && this.state === DecoderState.Searching) {
            this.emit('searching', this.getBufferedSeconds());
        }

        return !this.cancelled;
    }

    /**
     * Handle detected sync pulse
     */
    private handleSyncPulse(width: SyncPulseWidth, index: number, freqOffset: number): void {
        let modes: SSTVMode[];
        let syncTracker: SyncHistoryTracker;

        // Select appropriate sync tracker based on pulse width
        switch (width) {
            case SyncPulseWidth.FiveMilliSeconds:
                modes = this.syncPulse5msModes;
                syncTracker = this.sync5ms;
                break;
            case SyncPulseWidth.NineMilliSeconds:
                modes = this.syncPulse9msModes;
                syncTracker = this.sync9ms;
                this.leaderBreakIndex = index;
                this.visCandidates.push({ index, freqOffset });
                break;
            case SyncPulseWidth.TwentyMilliSeconds:
                modes = this.syncPulse20msModes;
                syncTracker = this.sync20ms;
                this.leaderBreakIndex = index;
                this.visCandidates.push({ index, freqOffset });
                break;
            default:
                return;
        }

        // Update sync history using shared tracker
        syncTracker.update(index, freqOffset);

        // Try to process the sync pulse
        this.processSyncPulse(modes, syncTracker, index);
    }

    /**
     * Process sync pulse and potentially decode a line
     */
    private processSyncPulse(
        modes: SSTVMode[],
        syncTracker: SyncHistoryTracker,
        latestSyncIndex: number
    ): void {
        // Check if we have valid scan line data
        if (!syncTracker.hasValidData()) return;

        // Calculate mean scan line length
        const mean = calculateMean(syncTracker.scanLines);
        const scanLineSamples = Math.round(mean);

        if (scanLineSamples < this.scanLineMinSamples) return;

        // Calculate standard deviation to check consistency
        const stdDev = calculateStdDev(syncTracker.scanLines, mean);
        if (stdDev > this.scanLineToleranceSamples) return;

        // Detect mode from scan line timing if not already locked
        let modeChanged = false;
        if (!this.currentMode) {
            const detectedMode = detectModeFromTiming(modes, scanLineSamples, this.sampleRate);
            if (detectedMode) {
                this.setMode(detectedMode, 'timing');
                modeChanged = true;
            }
        } else {
            // Verify scan line matches current mode
            if (Math.abs(scanLineSamples - this.currentScanLineSamples) > this.scanLineToleranceSamples) {
                return;
            }
        }

        // Calculate frequency offset mean
        const frequencyOffset = calculateMean(syncTracker.freqOffsets);

        // If mode changed or first line, we may need to extrapolate previous lines
        if (modeChanged && syncTracker.syncPulses[0] >= scanLineSamples) {
            const endPulse = syncTracker.syncPulses[0];
            const extrapolate = Math.floor(endPulse / scanLineSamples);
            const firstPulse = endPulse - extrapolate * scanLineSamples;
            for (let pulseIndex = firstPulse; pulseIndex < endPulse; pulseIndex += scanLineSamples) {
                this.decodeLineAt(pulseIndex, scanLineSamples, false);
            }
        }

        // Decode lines up to current sync
        const startIdx = modeChanged ? 0 : syncTracker.scanLines.length - 1;
        for (let i = startIdx; i < syncTracker.scanLines.length; i++) {
            this.decodeLineAt(syncTracker.syncPulses[i], syncTracker.scanLines[i], false);
        }

        this.lastSyncPulseIndex = latestSyncIndex;
        this.currentScanLineSamples = scanLineSamples;
        this.lastFrequencyOffset = frequencyOffset;

        // Clean up buffer - shift to keep only what we need
        const keepSamples = this.currentScanLineSamples * 2;
        if (this.lastSyncPulseIndex > keepSamples) {
            this.shiftBuffer(this.lastSyncPulseIndex - keepSamples);
        }
    }

    /**
     * Check pending VIS candidates
     */
    private checkVisCandidates(): void {
        if (this.currentMode) return; // Mode already found

        const requiredSamples = this.visDecoder.getRequiredSamples();

        // Check each candidate
        for (let i = this.visCandidates.length - 1; i >= 0; i--) {
            const candidate = this.visCandidates[i];

            if (this.bufferWritePos >= candidate.index + requiredSamples) {
                // Try to decode VIS using shared decoder
                const mode = this.visDecoder.tryDecode(
                    this.sampleBuffer,
                    this.bufferWritePos,
                    candidate.index,
                    candidate.freqOffset
                );
                if (mode) {
                    this.setMode(mode, 'vis');
                    this.visCandidates = [];

                    // Calculate start of image data
                    this.lastSyncPulseIndex = this.visDecoder.calculateImageStartIndex(candidate.index);
                    this.currentScanLineSamples = Math.floor(mode.lineTime * this.sampleRate);
                    this.lastFrequencyOffset = candidate.freqOffset;

                    // Pre-populate sync pulse history using shared tracker
                    this.populateSyncHistoryFromVIS(mode);

                    return;
                } else {
                    // Remove failed candidate
                    this.visCandidates.splice(i, 1);
                }
            }
        }

        // Limit candidate list size
        while (this.visCandidates.length > 10) {
            this.visCandidates.shift();
        }
    }

    /**
     * Pre-populate sync pulse history after VIS detection
     */
    private populateSyncHistoryFromVIS(mode: SSTVMode): void {
        // Determine which sync tracker to populate based on sync pulse width
        const syncMs = mode.syncPulse * 1000;
        let syncTracker: SyncHistoryTracker;

        if (Math.abs(syncMs - 5) < 1) {
            syncTracker = this.sync5ms;
        } else if (Math.abs(syncMs - 9) < 1) {
            syncTracker = this.sync9ms;
        } else {
            syncTracker = this.sync20ms;
        }

        // Use shared method to populate history
        syncTracker.populateFromVIS(this.lastSyncPulseIndex, this.currentScanLineSamples, this.lastFrequencyOffset);
    }

    /**
     * Set the current mode
     */
    private setMode(mode: SSTVMode, method: 'vis' | 'timing'): void {
        this.currentMode = mode;
        this.currentScanLineSamples = Math.floor(mode.lineTime * this.sampleRate);

        // Allocate image channels using shared buffer
        this.imageBuffer.allocate(mode);

        // Update state
        this.setState(DecoderState.DecodingImage);

        // Emit mode detected event
        this.emit('modeDetected', {
            mode,
            visCode: mode.id,
            method
        } as ModeDetectedEvent);
    }

    /**
     * Decode a line at the given position
     */
    private decodeLineAt(syncPulseIndex: number, scanLineSamples: number, isNoise: boolean): void {
        if (!this.currentMode) return;
        if (this.imageBuffer.linesDecoded >= this.currentMode.height) return;
        if (syncPulseIndex < 0 || syncPulseIndex + scanLineSamples > this.bufferWritePos) return;

        const mode = this.currentMode;
        const line = this.imageBuffer.linesDecoded;

        // Check if this is a PD mode (4 channels)
        const isPD = isPDMode(mode);

        // Decode channels
        if (isPD) {
            // PD modes: 2 lines per sync
            this.decodePDLine(syncPulseIndex, line, isNoise);
        } else {
            // Standard modes
            this.decodeStandardLine(syncPulseIndex, line, scanLineSamples, isNoise);
        }
    }

    /**
     * Decode lines based on expected timing
     * This is called when we have enough samples to decode one or more lines
     * regardless of whether sync pulses are detected
     */
    private decodeLinesByTiming(): void {
        if (!this.currentMode) return;
        if (this.currentScanLineSamples === 0) return;

        // Calculate how many complete lines we can decode
        const samplesAfterLastSync = this.bufferWritePos - this.lastSyncPulseIndex;
        const linesToDecode = Math.floor(samplesAfterLastSync / this.currentScanLineSamples);

        if (linesToDecode <= 0) return;

        // Decode each complete line
        for (let i = 0; i < linesToDecode; i++) {
            if (this.imageBuffer.linesDecoded >= this.currentMode.height) break;

            const lineStartIndex = this.lastSyncPulseIndex + i * this.currentScanLineSamples;
            const lineEndIndex = lineStartIndex + this.currentScanLineSamples;

            // Only decode if we have the full line in buffer
            if (lineEndIndex <= this.bufferWritePos) {
                this.decodeLineAt(lineStartIndex, this.currentScanLineSamples, false);
            }
        }

        // Update lastSyncPulseIndex to point after decoded lines
        if (linesToDecode > 0) {
            this.lastSyncPulseIndex += linesToDecode * this.currentScanLineSamples;

            // Shift buffer if needed
            const keepSamples = this.currentScanLineSamples * 2;
            if (this.lastSyncPulseIndex > keepSamples) {
                this.shiftBuffer(this.lastSyncPulseIndex - keepSamples);
            }
        }
    }

    /**
     * Decode a standard mode line
     */
    private decodeStandardLine(syncPulseIndex: number, line: number, scanLineSamples: number, isNoise: boolean): void {
        if (!this.currentMode) return;

        const mode = this.currentMode;
        const width = mode.width;
        const channels = this.imageBuffer.getChannels();

        // Decode each channel using shared line decoder
        this.lineDecoder.decodeStandardLine(
            this.sampleBuffer,
            this.bufferWritePos,
            mode,
            line,
            syncPulseIndex,
            channels
        );

        this.imageBuffer.linesDecoded++;
        this.emitLine(line, isNoise);

        // Check if image is complete
        if (this.imageBuffer.linesDecoded >= mode.height) {
            this.emitImageComplete();
        }
    }

    /**
     * Decode a PD mode line (2 lines per sync)
     */
    private decodePDLine(syncPulseIndex: number, linePair: number, isNoise: boolean): void {
        if (!this.currentMode) return;

        const mode = this.currentMode;
        const evenLine = linePair;
        const oddLine = linePair + 1;

        if (oddLine >= mode.height) return;

        const channels = this.imageBuffer.getChannels();

        // Decode PD line pair using shared line decoder
        this.lineDecoder.decodePDLinePair(
            this.sampleBuffer,
            this.bufferWritePos,
            mode,
            evenLine,
            syncPulseIndex,
            channels
        );

        this.imageBuffer.linesDecoded += 2;
        this.emitLine(evenLine, isNoise);
        this.emitLine(oddLine, isNoise);

        // Check if image is complete
        if (this.imageBuffer.linesDecoded >= mode.height) {
            this.emitImageComplete();
        }
    }

    /**
     * Emit a line event with RGB data
     */
    private emitLine(line: number, isNoise: boolean): void {
        if (!this.currentMode) return;

        const mode = this.currentMode;
        const width = mode.width;
        const rgbLine = new Uint8Array(width * 3);

        // Convert to RGB using shared buffer
        this.imageBuffer.convertLineToRGB(line, rgbLine);

        this.emit('line', {
            line,
            pixels: rgbLine,
            isNoise,
            width,
            height: mode.height,
            modeName: mode.name,
            linesDecoded: this.imageBuffer.linesDecoded
        } as LineEvent);
    }

    /**
     * Emit image complete event
     */
    private emitImageComplete(): void {
        if (!this.currentMode) return;

        const mode = this.currentMode;

        // Build RGB data using shared buffer
        const rgbData = this.imageBuffer.toRGB();

        // Build DecodedImage using shared buffer
        const image = this.imageBuffer.toDecodedImage();

        if (image) {
            this.emit('imageComplete', {
                image,
                rgbData
            } as ImageCompleteEvent);
        }

        // Reset for next image
        this.resetForNextImage();
    }

    /**
     * Reset decoder for next image (keeps mode)
     */
    private resetForNextImage(): void {
        if (this.currentMode) {
            // Reset image buffer using shared class
            this.imageBuffer.reset();
        }

        this.emit('reset');
    }

    /**
     * Shift the sample buffer
     */
    private shiftBuffer(amount: number): void {
        if (amount <= 0 || amount > this.bufferWritePos) return;

        // Shift buffer contents
        this.sampleBuffer.copyWithin(0, amount, this.bufferWritePos);
        this.bufferWritePos -= amount;

        // Adjust indices
        this.lastSyncPulseIndex -= amount;
        this.leaderBreakIndex -= amount;

        // Adjust sync trackers using shared method
        this.sync5ms.adjustIndices(amount);
        this.sync9ms.adjustIndices(amount);
        this.sync20ms.adjustIndices(amount);

        // Adjust VIS candidates
        for (const candidate of this.visCandidates) {
            candidate.index -= amount;
        }
        this.visCandidates = this.visCandidates.filter(c => c.index >= 0);
    }

    /**
     * Set decoder state
     */
    private setState(newState: DecoderState): void {
        if (this.state !== newState) {
            this.state = newState;
            this.emit('stateChange', newState);
        }
    }

    /**
     * Cancel the decoder
     */
    cancel(): void {
        this.cancelled = true;
        this.setState(DecoderState.Cancelled);
    }

    /**
     * Flush remaining buffered content and finalize the current image
     * 
     * Call this when the stream ends to ensure all buffered data is processed
     * and any partial image is completed.
     * 
     * @returns The completed image if available, or null if no image is ready
     */
    flush(): ImageCompleteEvent | null {
        if (this.cancelled || !this.currentMode) {
            return null;
        }

        // Try to decode any remaining lines with whatever data we have
        if (this.currentScanLineSamples > 0 && this.imageBuffer.linesDecoded < this.currentMode.height) {
            // Decode remaining lines even if we don't have full scan line length
            while (this.imageBuffer.linesDecoded < this.currentMode.height) {
                const lineStartIndex = this.lastSyncPulseIndex;
                const availableSamples = this.bufferWritePos - lineStartIndex;

                // Need at least half a line of samples
                if (availableSamples < this.currentScanLineSamples / 2) {
                    break;
                }

                // Decode with whatever samples we have
                const lineSamples = Math.min(this.currentScanLineSamples, availableSamples);
                this.decodeLineAt(lineStartIndex, lineSamples, false);

                // Move to next expected line position
                this.lastSyncPulseIndex += this.currentScanLineSamples;
            }
        }

        // If we have a complete image, return it
        if (this.imageBuffer.linesDecoded >= this.currentMode.height) {
            return this.buildImageCompleteEvent();
        }

        // If we have partial data (at least 50%), return it
        if (this.imageBuffer.linesDecoded > 0 && this.imageBuffer.linesDecoded >= this.currentMode.height * 0.5) {
            return this.buildImageCompleteEvent();
        }

        return null;
    }

    /**
     * Build an ImageCompleteEvent from current state
     */
    private buildImageCompleteEvent(): ImageCompleteEvent {
        // Use shared buffer methods
        const rgbData = this.imageBuffer.toRGB();
        const image = this.imageBuffer.toDecodedImage()!;

        return {
            image,
            rgbData
        };
    }

    /**
     * Check if decoder is cancelled
     */
    isCancelled(): boolean {
        return this.cancelled;
    }

    /**
     * Reset the decoder completely
     */
    reset(): void {
        this.cancelled = false;
        this.currentMode = null;
        this.bufferWritePos = 0;
        this.lastSyncPulseIndex = 0;
        this.currentScanLineSamples = 0;
        this.lastFrequencyOffset = 0;
        this.leaderBreakIndex = 0;
        this.visCandidates = [];

        // Reset image buffer
        this.imageBuffer.reset();

        // Reset sync trackers
        this.sync5ms.reset();
        this.sync9ms.reset();
        this.sync20ms.reset();

        this.demodulator.reset();
        this.setState(DecoderState.Searching);

        // If forced mode, set it up again
        if (this.forcedMode !== undefined) {
            const mode = getModeByVIS(this.forcedMode);
            if (mode) {
                this.setMode(mode, 'vis');
            }
        }

        this.emit('reset');
    }

    /**
     * Get current partial image RGB data
     * Useful for displaying progress
     */
    getPartialImage(): Uint8Array | null {
        if (!this.currentMode || this.imageBuffer.linesDecoded === 0) return null;

        // Use shared buffer method to get RGB data up to decoded lines
        return this.imageBuffer.toRGB();
    }
}


// Type declarations for EventEmitter with our events
export declare interface StreamingDecoder {
    on<K extends keyof StreamingDecoderEvents>(event: K, listener: StreamingDecoderEvents[K]): this;
    once<K extends keyof StreamingDecoderEvents>(event: K, listener: StreamingDecoderEvents[K]): this;
    emit<K extends keyof StreamingDecoderEvents>(event: K, ...args: Parameters<StreamingDecoderEvents[K]>): boolean;
    off<K extends keyof StreamingDecoderEvents>(event: K, listener: StreamingDecoderEvents[K]): this;
    removeListener<K extends keyof StreamingDecoderEvents>(event: K, listener: StreamingDecoderEvents[K]): this;
}
