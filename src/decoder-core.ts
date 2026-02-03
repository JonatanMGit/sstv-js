/**
 * Decoder Core - Shared utilities for SSTV decoding
 * 
 * This module contains common functionality used by both the batch decoder
 * (SSTVDecoder) and the streaming decoder (StreamingDecoder).
 */

import { SSTVMode, ColorFormat, DecodedImage } from './types';
import { getAllModes, getModeByVIS } from './modes';
import * as CONST from './constants';
import { yuvToRgb, interpolateChroma, yuvToRgbInPlace } from './utils/colorspace';
import { FFTPeakFinder } from './utils/fft-helper';

/**
 * Internal image data structure during decoding
 */
export interface InternalImageData {
    readonly mode: SSTVMode;
    readonly width: number;
    readonly height: number;
    readonly channels: Uint8Array[];
    linesDecoded: number;
    slantCorrection: number;
}

/**
 * VIS candidate for mode detection
 */
export interface VISCandidate {
    index: number;
    freqOffset: number;
}

/**
 * Result of mode categorization by sync pulse width
 */
export interface ModesByPulseWidth {
    pulse5ms: SSTVMode[];
    pulse9ms: SSTVMode[];
    pulse20ms: SSTVMode[];
}

/**
 * Categorize all supported modes by their sync pulse width.
 * Used for efficient mode detection during decoding.
 */
export function categorizeModesBySyncPulse(): ModesByPulseWidth {
    const pulse5ms: SSTVMode[] = [];
    const pulse9ms: SSTVMode[] = [];
    const pulse20ms: SSTVMode[] = [];

    const allModes = getAllModes();

    for (const mode of allModes) {
        const syncMs = mode.syncPulse * 1000;

        if (Math.abs(syncMs - 5) < 1) {
            pulse5ms.push(mode);
        } else if (Math.abs(syncMs - 9) < 1) {
            pulse9ms.push(mode);
        } else if (Math.abs(syncMs - 20) < 2) {
            pulse20ms.push(mode);
        }
    }

    return { pulse5ms, pulse9ms, pulse20ms };
}

/**
 * Calculate mean of a numeric array
 */
export function calculateMean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Calculate standard deviation of a numeric array
 */
export function calculateStdDev(arr: number[], mean?: number): number {
    if (arr.length === 0) return 0;
    const m = mean ?? calculateMean(arr);
    const squaredDiffs = arr.map(x => (x - m) * (x - m));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / arr.length);
}

/**
 * Detect mode from scan line sample count
 */
export function detectModeFromTiming(
    modes: SSTVMode[],
    scanLineSamples: number,
    sampleRate: number,
    toleranceSeconds: number = 0.001
): SSTVMode | null {
    const tolerance = Math.floor(toleranceSeconds * sampleRate);
    let bestMode: SSTVMode | null = null;
    let bestDist = Infinity;

    for (const mode of modes) {
        const expectedSamples = Math.floor(mode.lineTime * sampleRate);
        const dist = Math.abs(scanLineSamples - expectedSamples);
        if (dist <= tolerance && dist < bestDist) {
            bestDist = dist;
            bestMode = mode;
        }
    }

    return bestMode;
}

/**
 * Denormalize frequency from [-1, 1] to Hz
 */
export function denormalizeFrequency(normalized: number): number {
    const scanLineBandwidth = CONST.FREQ_WHITE - CONST.FREQ_BLACK;
    const centerFrequency = (1000 + 2800) / 2;
    return normalized * scanLineBandwidth / 2 + centerFrequency;
}

/**
 * Sync history tracker for managing sync pulse detection arrays
 */
export class SyncHistoryTracker {
    public readonly syncPulses: number[];
    public readonly scanLines: number[];
    public readonly freqOffsets: number[];

    constructor(
        syncPulseCount: number = 5,
        scanLineCount: number = 4
    ) {
        this.syncPulses = new Array(syncPulseCount).fill(0);
        this.scanLines = new Array(scanLineCount).fill(0);
        this.freqOffsets = new Array(syncPulseCount).fill(0);
    }

    /**
     * Update history with a new sync pulse
     */
    update(newIndex: number, freqOffset: number): void {
        // Shift sync pulses
        for (let i = 1; i < this.syncPulses.length; i++) {
            this.syncPulses[i - 1] = this.syncPulses[i];
            this.freqOffsets[i - 1] = this.freqOffsets[i];
        }
        this.syncPulses[this.syncPulses.length - 1] = newIndex;
        this.freqOffsets[this.freqOffsets.length - 1] = freqOffset;

        // Shift scan lines
        for (let i = 1; i < this.scanLines.length; i++) {
            this.scanLines[i - 1] = this.scanLines[i];
        }
        this.scanLines[this.scanLines.length - 1] =
            this.syncPulses[this.syncPulses.length - 1] - this.syncPulses[this.syncPulses.length - 2];
    }

    /**
     * Adjust all indices after buffer shift
     */
    adjustIndices(offset: number): void {
        for (let i = 0; i < this.syncPulses.length; i++) {
            this.syncPulses[i] -= offset;
        }
    }

    /**
     * Reset all tracking arrays
     */
    reset(): void {
        this.syncPulses.fill(0);
        this.scanLines.fill(0);
        this.freqOffsets.fill(0);
    }

    /**
     * Check if we have valid data (first scan line is non-zero)
     */
    hasValidData(): boolean {
        return this.scanLines[0] !== 0;
    }

    /**
     * Get the latest sync pulse index
     */
    getLatestSync(): number {
        return this.syncPulses[this.syncPulses.length - 1];
    }

    /**
     * Fill with expected values after VIS detection
     */
    populateFromVIS(lastSyncIndex: number, scanLineSamples: number, freqOffset: number): void {
        const oldestSyncPulseIndex = lastSyncIndex - (this.syncPulses.length - 1) * scanLineSamples;
        for (let i = 0; i < this.syncPulses.length; i++) {
            this.syncPulses[i] = oldestSyncPulseIndex + i * scanLineSamples;
            this.freqOffsets[i] = freqOffset;
        }
        for (let i = 0; i < this.scanLines.length; i++) {
            this.scanLines[i] = scanLineSamples;
        }
    }
}

/**
 * VIS Code Decoder
 * Handles detection and decoding of SSTV VIS codes
 */
export class VISDecoder {
    private readonly sampleRate: number;
    private readonly fftPeakFinder: FFTPeakFinder;

    public readonly visCodeBitSamples: number;
    public readonly leaderToneSamples: number;
    public readonly leaderToneToleranceSamples: number;
    public readonly visCodeSamples: number;
    public readonly breakSamples: number;

    constructor(sampleRate: number, fftPeakFinder: FFTPeakFinder) {
        this.sampleRate = sampleRate;
        this.fftPeakFinder = fftPeakFinder;

        this.visCodeBitSamples = Math.round(0.03 * sampleRate);
        this.leaderToneSamples = Math.round(0.3 * sampleRate);
        this.leaderToneToleranceSamples = Math.round(0.06 * sampleRate);
        this.visCodeSamples = Math.round(0.3 * sampleRate);
        this.breakSamples = Math.floor(CONST.CALIB_BREAK * sampleRate);
    }

    /**
     * Get required sample count after break index for VIS decoding
     */
    getRequiredSamples(): number {
        return this.leaderToneSamples + this.leaderToneToleranceSamples + this.visCodeSamples;
    }

    /**
     * Try to decode VIS code from raw audio samples
     */
    tryDecode(
        sampleBuffer: Float32Array,
        bufferLength: number,
        breakIndex: number,
        freqOffset: number
    ): SSTVMode | null {
        if (breakIndex < this.visCodeBitSamples + this.leaderToneToleranceSamples) {
            return null;
        }

        const requiredEnd = breakIndex + this.leaderToneSamples + this.leaderToneToleranceSamples + this.visCodeSamples;
        if (bufferLength < requiredEnd) {
            return null;
        }

        // Check leader tone before break
        let preBreakFreq = 0;
        const startIdx = breakIndex - this.visCodeBitSamples - this.leaderToneToleranceSamples;
        let validSamples = 0;

        for (let i = 0; i < this.leaderToneToleranceSamples; i++) {
            const idx = startIdx + i;
            if (idx >= 0 && idx < bufferLength) {
                const windowSize = Math.min(256, bufferLength - idx);
                if (windowSize > 32) {
                    const window = sampleBuffer.subarray(idx, idx + windowSize);
                    preBreakFreq += this.fftPeakFinder.findPeakFrequency(window);
                    validSamples++;
                }
            }
        }

        if (validSamples === 0) return null;
        preBreakFreq /= validSamples;

        if (Math.abs(preBreakFreq - CONST.FREQ_LEADER) > 100) {
            return null;
        }

        // Decode VIS bits
        const visBeginIndex = breakIndex + this.leaderToneSamples + this.breakSamples;
        const visBitFreqs: number[] = [];

        for (let bit = 0; bit < 10; bit++) {
            const bitStart = visBeginIndex + bit * this.visCodeBitSamples + 5;
            const bitEnd = bitStart + this.visCodeBitSamples - 10;

            if (bitEnd >= bufferLength) return null;

            const window = sampleBuffer.subarray(bitStart, Math.min(bitEnd, bitStart + 512));
            const freq = this.fftPeakFinder.findPeakFrequency(window);
            visBitFreqs.push(freq);
        }

        // Validate start bit (bit 0) and stop bit (bit 9) - should be ~1200 Hz
        const startBitTolerance = 100;
        if (Math.abs(visBitFreqs[0] - 1200) > startBitTolerance ||
            Math.abs(visBitFreqs[9] - 1200) > startBitTolerance) {
            return null;
        }

        // Validate data bits - should be either ~1100 Hz (1) or ~1300 Hz (0)
        const dataBitTolerance = 100;
        for (let i = 1; i <= 8; i++) {
            const freq = visBitFreqs[i];
            if (Math.abs(freq - 1100) > dataBitTolerance && Math.abs(freq - 1300) > dataBitTolerance) {
                return null;
            }
        }

        // Decode VIS code with parity validation
        let visCode = 0;
        let parity = false;
        for (let i = 1; i <= 7; i++) {
            const bit = visBitFreqs[i] < 1250 ? 1 : 0;
            visCode |= bit << (i - 1);
            if (bit) parity = !parity;
        }

        // Bit 8 is parity bit (even parity)
        const parityBit = visBitFreqs[8] < 1250 ? 1 : 0;
        if (parityBit) parity = !parity;

        // Parity should be even (false)
        if (parity) {
            // Try single-bit error correction
            const corrected = this.tryParityCorrection(visCode);
            if (corrected !== null) {
                return getModeByVIS(corrected);
            }
            return null;
        }

        return getModeByVIS(visCode);
    }

    /**
     * Attempt single-bit error correction when parity fails
     * Tries flipping each bit to see if it produces a valid mode
     */
    private tryParityCorrection(originalCode: number): number | null {
        for (let i = 0; i < 7; i++) {
            const testCode = originalCode ^ (1 << i);
            const mode = getModeByVIS(testCode);
            if (mode) {
                // Found a valid mode by flipping bit i
                return testCode;
            }
        }
        return null;
    }

    /**
     * Try to decode VIS code from demodulated (normalized) samples
     */
    tryDecodeFromDemodulated(
        demodBuffer: Float32Array,
        bufferLength: number,
        breakIndex: number,
        freqOffset: number
    ): SSTVMode | null {
        if (breakIndex < this.visCodeBitSamples + this.leaderToneToleranceSamples) {
            return null;
        }

        const requiredEnd = breakIndex + this.leaderToneSamples + this.leaderToneToleranceSamples + this.visCodeSamples;
        if (bufferLength < requiredEnd) {
            return null;
        }

        // Check leader tone before break
        let preBreakFreq = 0;
        const startIdx = breakIndex - this.visCodeBitSamples - this.leaderToneToleranceSamples;

        for (let i = 0; i < this.leaderToneToleranceSamples; i++) {
            preBreakFreq += demodBuffer[startIdx + i];
        }
        preBreakFreq = denormalizeFrequency(preBreakFreq / this.leaderToneToleranceSamples);

        if (Math.abs(preBreakFreq - CONST.FREQ_LEADER) > 100) {
            return null;
        }

        // Decode VIS bits
        const visBeginIndex = breakIndex + this.leaderToneSamples + this.breakSamples;
        const visBitFreqs: number[] = [];

        for (let bit = 0; bit < 10; bit++) {
            let freq = 0;
            const start = visBeginIndex + bit * this.visCodeBitSamples + 5;
            const end = start + this.visCodeBitSamples - 10;
            for (let i = start; i < end && i < bufferLength; i++) {
                freq += demodBuffer[i];
            }
            freq = (freq / (this.visCodeBitSamples - 10)) - freqOffset;
            freq = denormalizeFrequency(freq);
            visBitFreqs.push(freq);
        }

        // Validate start bit (bit 0) and stop bit (bit 9) - should be ~1200 Hz
        const startBitTolerance = 100;
        if (Math.abs(visBitFreqs[0] - 1200) > startBitTolerance ||
            Math.abs(visBitFreqs[9] - 1200) > startBitTolerance) {
            return null;
        }

        // Validate data bits - should be either ~1100 Hz (1) or ~1300 Hz (0)
        const dataBitTolerance = 100;
        for (let i = 1; i <= 8; i++) {
            const freq = visBitFreqs[i];
            if (Math.abs(freq - 1100) > dataBitTolerance && Math.abs(freq - 1300) > dataBitTolerance) {
                return null;
            }
        }

        // Decode VIS code with parity validation
        let visCode = 0;
        let parity = false;
        for (let i = 1; i <= 7; i++) {
            const bit = visBitFreqs[i] < 1250 ? 1 : 0;
            visCode |= bit << (i - 1);
            if (bit) parity = !parity;
        }

        // Bit 8 is parity bit (even parity)
        const parityBit = visBitFreqs[8] < 1250 ? 1 : 0;
        if (parityBit) parity = !parity;

        // Parity should be even (false)
        if (parity) {
            // Try single-bit error correction
            const corrected = this.tryParityCorrection(visCode);
            if (corrected !== null) {
                return getModeByVIS(corrected);
            }
            return null;
        }

        return getModeByVIS(visCode);
    }

    /**
     * Calculate the start of image data after VIS detection
     */
    calculateImageStartIndex(breakIndex: number, visDuration: number = 0.300): number {
        const leaderSamples = Math.floor(CONST.CALIB_LEADER_2 * this.sampleRate);
        return breakIndex + this.breakSamples + leaderSamples + Math.round(visDuration * this.sampleRate);
    }
}

/**
 * Image Channel Buffer
 * Manages storage and conversion of decoded image channels
 */
export class ImageChannelBuffer {
    private channels: Uint8Array[] = [];
    private mode: SSTVMode | null = null;
    public linesDecoded: number = 0;
    private allocatedHeight: number = 0;  // Actual buffer capacity

    /**
     * Allocate channels for a mode with extra capacity for non-standard transmissions
     */
    allocate(mode: SSTVMode): void {
        this.mode = mode;
        // Allocate extra capacity (128 lines) for encoders that send more than spec
        this.allocatedHeight = mode.height + 128;
        this.channels = new Array(mode.channelCount).fill(null).map(() =>
            new Uint8Array(mode.width * this.allocatedHeight)
        );
        this.linesDecoded = 0;
    }

    /**
     * Get the maximum number of lines that can be stored
     */
    getMaxLines(): number {
        return this.allocatedHeight;
    }

    /**
     * Get channel data array
     */
    getChannels(): Uint8Array[] {
        return this.channels;
    }

    /**
     * Get a specific channel
     */
    getChannel(index: number): Uint8Array {
        return this.channels[index];
    }

    /**
     * Set pixel value
     */
    setPixel(channel: number, line: number, pixel: number, value: number): void {
        if (!this.mode) return;
        if (line >= this.allocatedHeight) return;  // Bounds check
        this.channels[channel][line * this.mode.width + pixel] = value;
    }

    /**
     * Get pixel value
     */
    getPixel(channel: number, line: number, pixel: number): number {
        if (!this.mode) return 0;
        if (line >= this.allocatedHeight) return 0;  // Bounds check
        return this.channels[channel][line * this.mode.width + pixel];
    }

    /**
     * Convert a single line to RGB
     */
    convertLineToRGB(line: number, output: Uint8Array): void {
        if (!this.mode) return;

        const width = this.mode.width;
        const colorFormat = this.mode.colorFormat;
        const channelCount = this.mode.channelCount;

        if (colorFormat === ColorFormat.RGB || colorFormat === ColorFormat.GBR) {
            const ch0 = this.channels[0];
            const ch1 = this.channels[1];
            const ch2 = this.channels[2];
            for (let x = 0; x < width; x++) {
                const idx = x * 3;
                const srcIdx = line * width + x;
                output[idx] = ch0[srcIdx];     // R
                output[idx + 1] = ch1[srcIdx]; // G
                output[idx + 2] = ch2[srcIdx]; // B
            }
        } else if (colorFormat === ColorFormat.YCrCb) {
            const yChannel = this.channels[0];

            if (channelCount === 2) {
                // Robot 36: simplified chroma for streaming
                const chromaChannel = this.channels[1];
                const isEvenLine = line % 2 === 0;
                for (let x = 0; x < width; x++) {
                    const idx = x * 3;
                    const srcIdx = line * width + x;
                    const y = yChannel[srcIdx];
                    const u = isEvenLine ? chromaChannel[srcIdx] : 128;
                    const v = isEvenLine ? 128 : chromaChannel[srcIdx];
                    yuvToRgbInPlace(y, u, v, output, idx);
                }
            } else {
                // Robot 72, PD modes: 0=Y, 1=V(Cr), 2=U(Cb)
                const vChannel = this.channels[1];
                const uChannel = this.channels[2];
                for (let x = 0; x < width; x++) {
                    const idx = x * 3;
                    const srcIdx = line * width + x;
                    yuvToRgbInPlace(yChannel[srcIdx], uChannel[srcIdx], vChannel[srcIdx], output, idx);
                }
            }
        } else if (colorFormat === ColorFormat.Grayscale) {
            const grayChannel = this.channels[0];
            for (let x = 0; x < width; x++) {
                const idx = x * 3;
                const gray = grayChannel[line * width + x];
                output[idx] = gray;
                output[idx + 1] = gray;
                output[idx + 2] = gray;
            }
        }
    }

    /**
     * Convert all decoded lines to RGB
     */
    toRGB(): Uint8Array {
        if (!this.mode) return new Uint8Array(0);

        const width = this.mode.width;
        const height = this.linesDecoded;
        const rgbData = new Uint8Array(width * height * 3);

        for (let line = 0; line < height; line++) {
            const lineRgb = new Uint8Array(width * 3);
            this.convertLineToRGB(line, lineRgb);
            rgbData.set(lineRgb, line * width * 3);
        }

        return rgbData;
    }

    /**
     * Convert to DecodedImage format
     */
    toDecodedImage(): DecodedImage | null {
        if (!this.mode) return null;

        const data: number[][][] = [];
        const height = this.linesDecoded;

        for (let line = 0; line < height; line++) {
            const lineData: number[][] = [];
            for (let ch = 0; ch < this.mode.channelCount; ch++) {
                const channelData: number[] = [];
                for (let pixel = 0; pixel < this.mode.width; pixel++) {
                    channelData.push(this.channels[ch][line * this.mode.width + pixel]);
                }
                lineData.push(channelData);
            }
            data.push(lineData);
        }

        return {
            mode: this.mode,
            data,
            width: this.mode.width,
            height,
            linesDecoded: height,
            slantCorrection: 1.0
        };
    }

    /**
     * Reset the buffer
     */
    reset(): void {
        this.linesDecoded = 0;
        if (this.mode) {
            this.channels = new Array(this.mode.channelCount).fill(null).map(() =>
                new Uint8Array(this.mode!.width * this.mode!.height)
            );
        }
    }

    /**
     * Clear completely
     */
    clear(): void {
        this.channels = [];
        this.mode = null;
        this.linesDecoded = 0;
    }

    /**
     * Check if buffer is allocated
     */
    isAllocated(): boolean {
        return this.mode !== null && this.channels.length > 0;
    }

    /**
     * Get the current mode
     */
    getMode(): SSTVMode | null {
        return this.mode;
    }
}

/**
 * Line Pixel Decoder
 * Extracts pixel values from audio samples using FFT
 */
export class LinePixelDecoder {
    private readonly sampleRate: number;
    private readonly fftPeakFinder: FFTPeakFinder;

    constructor(sampleRate: number, fftPeakFinder: FFTPeakFinder) {
        this.sampleRate = sampleRate;
        this.fftPeakFinder = fftPeakFinder;
    }

    /**
     * Decode pixels for a single channel of a standard mode line
     */
    decodeChannel(
        sampleBuffer: Float32Array,
        bufferLength: number,
        mode: SSTVMode,
        line: number,
        channel: number,
        syncPulseIndex: number,
        output: Uint8Array,
        outputOffset: number
    ): void {
        const sampleRate = this.sampleRate;
        const width = mode.width;
        const channelOffset = mode.getChannelOffset(line, channel);
        const channelStart = syncPulseIndex + Math.floor(channelOffset * sampleRate);
        const scanTime = mode.getScanTime(line, channel);

        // Hoist loop-invariant calculations
        const pixelTimeSamples = (scanTime / width) * sampleRate;
        const centerWindowSamples = (scanTime / width) * mode.windowFactor * 0.5 * sampleRate;
        const pixelWindow = Math.round(centerWindowSamples * 2);

        for (let pixel = 0; pixel < width; pixel++) {
            const centerPos = channelStart + pixel * pixelTimeSamples;
            const windowStart = Math.floor(centerPos - centerWindowSamples);
            const windowEnd = Math.min(windowStart + pixelWindow, bufferLength);

            if (windowEnd > windowStart && windowStart >= 0 && windowEnd <= bufferLength) {
                const audioWindow = sampleBuffer.subarray(windowStart, windowEnd);
                const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                const value = FFTPeakFinder.frequencyToPixel(peakFreq);
                output[outputOffset + pixel] = value;
            }
        }
    }

    /**
     * Decode a full standard mode line (all channels)
     * @param sampleOffset Optional sample offset for slant correction (in samples)
     */
    decodeStandardLine(
        sampleBuffer: Float32Array,
        bufferLength: number,
        mode: SSTVMode,
        line: number,
        syncPulseIndex: number,
        imageChannels: Uint8Array[],
        sampleOffset: number = 0
    ): void {
        const width = mode.width;
        const sampleRate = this.sampleRate;
        // Apply slant correction offset
        const correctedSyncIndex = syncPulseIndex + Math.round(sampleOffset);

        for (let ch = 0; ch < mode.channelCount; ch++) {
            const channelOffset = mode.getChannelOffset(line, ch);
            const channelStart = correctedSyncIndex + Math.floor(channelOffset * sampleRate);
            const scanTime = mode.getScanTime(line, ch);

            // Hoist loop-invariant calculations
            const pixelTimeSamples = (scanTime / width) * sampleRate;
            const centerWindowSamples = (scanTime / width) * mode.windowFactor * 0.5 * sampleRate;
            const pixelWindow = Math.round(centerWindowSamples * 2);
            const lineOffset = line * width;
            const actualChannel = mode.channelOrder[ch];
            const channelData = imageChannels[actualChannel];

            for (let pixel = 0; pixel < width; pixel++) {
                const centerPos = channelStart + pixel * pixelTimeSamples;
                const windowStart = Math.floor(centerPos - centerWindowSamples);
                const windowEnd = Math.min(windowStart + pixelWindow, bufferLength);

                if (windowEnd > windowStart && windowStart >= 0 && windowEnd <= bufferLength) {
                    const audioWindow = sampleBuffer.subarray(windowStart, windowEnd);
                    const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                    const value = FFTPeakFinder.frequencyToPixel(peakFreq);
                    channelData[lineOffset + pixel] = value;
                }
            }
        }
    }

    /**
     * Decode a PD mode line pair (2 lines per sync)
     * @param sampleOffset Optional sample offset for slant correction (in samples)
     */
    decodePDLinePair(
        sampleBuffer: Float32Array,
        bufferLength: number,
        mode: SSTVMode,
        evenLine: number,
        syncPulseIndex: number,
        imageChannels: Uint8Array[],
        sampleOffset: number = 0
    ): void {
        const width = mode.width;
        const sampleRate = this.sampleRate;
        const oddLine = evenLine + 1;
        // Apply slant correction offset
        const correctedSyncIndex = syncPulseIndex + Math.round(sampleOffset);
        // Pre-compute line offsets
        const evenOffset = evenLine * width;
        const oddOffset = oddLine * width;
        const ch0 = imageChannels[0];
        const ch1 = imageChannels[1];
        const ch2 = imageChannels[2];

        for (let ch = 0; ch < 4; ch++) {
            const channelOffset = mode.getChannelOffset(evenLine, ch);
            const channelStart = correctedSyncIndex + Math.floor(channelOffset * sampleRate);
            const scanTime = mode.getScanTime(evenLine, ch);

            // Hoist loop-invariant calculations
            const pixelTimeSamples = (scanTime / width) * sampleRate;
            const centerWindowSamples = (scanTime / width) * mode.windowFactor * 0.5 * sampleRate;
            const pixelWindow = Math.round(centerWindowSamples * 2);

            for (let pixel = 0; pixel < width; pixel++) {
                const centerPos = channelStart + pixel * pixelTimeSamples;
                const windowStart = Math.floor(centerPos - centerWindowSamples);
                const windowEnd = Math.min(windowStart + pixelWindow, bufferLength);

                if (windowEnd > windowStart && windowStart >= 0 && windowEnd <= bufferLength) {
                    const audioWindow = sampleBuffer.subarray(windowStart, windowEnd);
                    const peakFreq = this.fftPeakFinder.findPeakFrequency(audioWindow);
                    const value = FFTPeakFinder.frequencyToPixel(peakFreq);

                    // PD channel layout: 0=Y-even, 1=V, 2=U, 3=Y-odd
                    if (ch === 0) {
                        ch0[evenOffset + pixel] = value;
                    } else if (ch === 1) {
                        ch1[evenOffset + pixel] = value;
                        ch1[oddOffset + pixel] = value;
                    } else if (ch === 2) {
                        ch2[evenOffset + pixel] = value;
                        ch2[oddOffset + pixel] = value;
                    } else {
                        ch0[oddOffset + pixel] = value;
                    }
                }
            }
        }
    }
}

/**
 * Check if mode is a PD mode (4 channel YCrCb)
 */
export function isPDMode(mode: SSTVMode): boolean {
    return mode.channelCount === 4 && mode.colorFormat === ColorFormat.YCrCb;
}

/**
 * Check if mode has mid-line sync (Scottie-style)
 */
export function hasMidSync(mode: SSTVMode): boolean {
    return mode.syncChannel !== undefined && mode.syncChannel > 0;
}

/**
 * Convert DecodedImage to RGB byte array
 * 
 * Optimized version that handles all color formats
 */
export function imageDataToRGB(decoded: DecodedImage): Uint8Array {
    const { mode, data, width, height } = decoded;
    const rgb = new Uint8Array(width * height * 3);
    const colorFormat = mode.colorFormat;
    const channelCount = mode.channelCount;

    for (let y = 0; y < height; y++) {
        const lineOffset = y * width * 3;
        const lineData = data[y];

        if (colorFormat === ColorFormat.RGB) {
            const ch0 = lineData[0];
            const ch1 = lineData[1];
            const ch2 = lineData[2];
            for (let x = 0; x < width; x++) {
                const idx = lineOffset + x * 3;
                rgb[idx] = ch0[x];
                rgb[idx + 1] = ch1[x];
                rgb[idx + 2] = ch2[x];
            }
        } else if (colorFormat === ColorFormat.YCrCb) {
            const yChannel = lineData[0];

            if (channelCount === 2) {
                // Robot 36: interpolate chroma
                const chroma = interpolateChroma(y, height, data, width);
                for (let x = 0; x < width; x++) {
                    const idx = lineOffset + x * 3;
                    yuvToRgbInPlace(yChannel[x], chroma.u[x], chroma.v[x], rgb, idx);
                }
            } else {
                // Robot 72, PD modes: 0=Y, 1=V(Cr), 2=U(Cb)
                const vChannel = lineData[1];
                const uChannel = lineData[2];
                for (let x = 0; x < width; x++) {
                    const idx = lineOffset + x * 3;
                    yuvToRgbInPlace(yChannel[x], uChannel[x], vChannel[x], rgb, idx);
                }
            }
        } else if (colorFormat === ColorFormat.Grayscale) {
            const grayChannel = lineData[0];
            for (let x = 0; x < width; x++) {
                const idx = lineOffset + x * 3;
                const gray = grayChannel[x];
                rgb[idx] = gray;
                rgb[idx + 1] = gray;
                rgb[idx + 2] = gray;
            }
        }
    }

    return rgb;
}
