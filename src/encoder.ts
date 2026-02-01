/**
 * SSTV Encoder - Convert images to SSTV audio signals
 */

import {
    SSTVMode,
    EncoderOptions,
    ColorFormat
} from './types';
import { getModeByVIS } from './modes';
import { pixelToFrequency } from './constants';
import * as CONST from './constants';
import { rgbToYUV } from './utils/colorspace';

/** Two times PI for phase calculations */
const TWO_PI = 2 * Math.PI;

/**
 * Optimized sine wave generator that writes directly to an output buffer
 * Maintains phase continuity between calls
 */
class PhaseAccumulator {
    private phase: number = 0;
    private readonly sampleRate: number;
    private readonly twoPiOverSampleRate: number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
        this.twoPiOverSampleRate = TWO_PI / sampleRate;
    }

    /**
     * Generate a sine wave tone directly into the buffer at the specified offset
     * @param buffer Target buffer
     * @param offset Starting offset in buffer
     * @param frequency Frequency in Hz
     * @param samples Number of samples to generate
     * @returns New offset after writing
     */
    generateTone(buffer: Float32Array, offset: number, frequency: number, samples: number): number {
        const phaseIncrement = frequency * this.twoPiOverSampleRate;
        let phase = this.phase;

        for (let i = 0; i < samples; i++) {
            buffer[offset + i] = Math.sin(phase);
            phase += phaseIncrement;
        }

        // Normalize phase to prevent floating point drift
        this.phase = phase % TWO_PI;
        if (this.phase < 0) this.phase += TWO_PI;

        return offset + samples;
    }

    /**
     * Generate pixel data for a scanline directly into the buffer
     * @param buffer Target buffer
     * @param offset Starting offset
     * @param pixelData Array of pixel values (0-255)
     * @param scanTime Total scan time in seconds
     * @returns New offset after writing
     */
    generatePixelLine(buffer: Float32Array, offset: number, pixelData: number[], scanTime: number): number {
        const width = pixelData.length;
        const totalSamples = Math.floor(scanTime * this.sampleRate);
        const samplesPerPixel = totalSamples / width;

        for (let pixel = 0; pixel < width; pixel++) {
            const freq = pixelToFrequency(pixelData[pixel]);
            const phaseIncrement = freq * this.twoPiOverSampleRate;

            const startSample = Math.floor(pixel * samplesPerPixel);
            const endSample = Math.min(Math.floor((pixel + 1) * samplesPerPixel), totalSamples);

            for (let s = startSample; s < endSample; s++) {
                buffer[offset + s] = Math.sin(this.phase);
                this.phase += phaseIncrement;
            }
        }

        // Normalize phase
        this.phase = this.phase % TWO_PI;
        if (this.phase < 0) this.phase += TWO_PI;

        return offset + totalSamples;
    }

    /**
     * Reset phase accumulator
     */
    reset(): void {
        this.phase = 0;
    }
}

/**
 * SSTV Image Encoder
 * 
 * Encodes RGB image data to SSTV audio signals.
 * Supports all major SSTV modes including RGB and YCrCb color spaces.
 */
export class SSTVEncoder {
    private readonly mode: SSTVMode;
    private readonly sampleRate: number;
    private readonly addCalibrationHeader: boolean;
    private readonly addVoxTones: boolean;
    private readonly phaseAccumulator: PhaseAccumulator;

    constructor(options: EncoderOptions) {
        const sampleRate = options.sampleRate ?? CONST.DEFAULT_SAMPLE_RATE;

        if (typeof options.mode === 'number') {
            const mode = getModeByVIS(options.mode);
            if (!mode) {
                throw new Error(`Invalid mode VIS code: ${options.mode}`);
            }
            this.mode = mode;
        } else {
            this.mode = options.mode;
        }

        this.sampleRate = sampleRate;
        this.addCalibrationHeader = options.addCalibrationHeader ?? true;
        this.addVoxTones = options.addVoxTones ?? false;
        this.phaseAccumulator = new PhaseAccumulator(sampleRate);
    }

    /**
     * Calculate the total number of samples needed for encoding
     */
    private calculateTotalSamples(height: number): number {
        let totalDuration = 0;

        // VOX tones: 100ms tone + 100ms silence + 100ms tone + 100ms silence
        if (this.addVoxTones) {
            totalDuration += 0.4;
        }

        // Calibration header
        if (this.addCalibrationHeader) {
            totalDuration += CONST.CALIB_HEADER_DURATION;
            // VIS code: 8 data bits + 1 stop bit = 9 * 30ms
            totalDuration += 9 * CONST.VIS_BIT_DURATION;
        }

        // Start sync for Scottie modes
        if (this.mode.hasStartSync) {
            totalDuration += 0.009;
        }

        // Image data - check if PD mode (4 channels)
        const isPDMode = this.mode.channelCount === 4 && this.mode.colorFormat === ColorFormat.YCrCb;

        if (isPDMode) {
            // PD modes: one lineTime per 2 image lines
            totalDuration += (height / 2) * this.mode.lineTime;
        } else {
            totalDuration += height * this.mode.lineTime;
        }

        // Add small buffer for rounding
        return Math.ceil(totalDuration * this.sampleRate) + 1000;
    }

    /**
     * Encode RGB image data to SSTV audio
     * @param imageData RGB image data (width * height * 3 bytes)
     * @param width Image width
     * @param height Image height
     * @returns Audio samples as Float32Array
     */
    encode(imageData: Uint8Array, width: number, height: number): Float32Array {
        // Reset phase for new encoding
        this.phaseAccumulator.reset();

        // Validate and resize image if needed
        if (width !== this.mode.width || height !== this.mode.height) {
            imageData = this.resizeImage(imageData, width, height, this.mode.width, this.mode.height);
            width = this.mode.width;
            height = this.mode.height;
        }

        // Convert to mode's color space
        const channels = this.convertToColorSpace(imageData, width, height);

        // Pre-allocate output buffer
        const totalSamples = this.calculateTotalSamples(height);
        const buffer = new Float32Array(totalSamples);
        let offset = 0;

        // Add VOX tones if requested
        if (this.addVoxTones) {
            offset = this.writeVoxTones(buffer, offset);
        }

        // Add calibration header
        if (this.addCalibrationHeader) {
            offset = this.writeCalibrationHeader(buffer, offset);
            offset = this.writeVISCode(buffer, offset);
        }

        // Generate image data
        offset = this.writeImageData(buffer, offset, channels);

        // Return trimmed buffer
        return buffer.subarray(0, offset);
    }

    /**
     * Resize image using nearest neighbor interpolation
     */
    private resizeImage(
        src: Uint8Array,
        srcWidth: number,
        srcHeight: number,
        dstWidth: number,
        dstHeight: number
    ): Uint8Array {
        const dst = new Uint8Array(dstWidth * dstHeight * 3);
        const xRatio = srcWidth / dstWidth;
        const yRatio = srcHeight / dstHeight;

        for (let y = 0; y < dstHeight; y++) {
            const srcY = Math.floor(y * yRatio);
            const srcRowOffset = srcY * srcWidth * 3;
            const dstRowOffset = y * dstWidth * 3;

            for (let x = 0; x < dstWidth; x++) {
                const srcX = Math.floor(x * xRatio);
                const srcIdx = srcRowOffset + srcX * 3;
                const dstIdx = dstRowOffset + x * 3;

                dst[dstIdx] = src[srcIdx];
                dst[dstIdx + 1] = src[srcIdx + 1];
                dst[dstIdx + 2] = src[srcIdx + 2];
            }
        }

        return dst;
    }

    /**
     * Convert RGB image to mode's color space
     */
    private convertToColorSpace(imageData: Uint8Array, width: number, height: number): number[][][] {
        const channels: number[][][] = Array(this.mode.channelCount).fill(null).map(() =>
            Array(height).fill(null).map(() =>
                Array(width).fill(0)
            )
        );

        for (let y = 0; y < height; y++) {
            const rowOffset = y * width * 3;

            for (let x = 0; x < width; x++) {
                const idx = rowOffset + x * 3;
                const r = imageData[idx];
                const g = imageData[idx + 1];
                const b = imageData[idx + 2];

                if (this.mode.colorFormat === ColorFormat.RGB) {
                    channels[0][y][x] = r;
                    channels[1][y][x] = g;
                    channels[2][y][x] = b;
                } else if (this.mode.colorFormat === ColorFormat.YCrCb) {
                    const [yVal, v, u] = rgbToYUV(r, g, b);
                    channels[0][y][x] = yVal;

                    if (this.mode.channelCount === 2) {
                        // Robot 36: Even lines = V, Odd lines = U
                        channels[1][y][x] = (y % 2 === 0) ? v : u;
                    } else if (this.mode.channelCount >= 3) {
                        // Robot 72 and PD modes
                        channels[1][y][x] = v;
                        channels[2][y][x] = u;
                    }
                } else if (this.mode.colorFormat === ColorFormat.Grayscale) {
                    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                    channels[0][y][x] = gray;
                }
            }
        }

        return channels;
    }

    /**
     * Helper to convert duration to samples
     */
    private durationToSamples(duration: number): number {
        return Math.floor(duration * this.sampleRate);
    }

    /**
     * Write VOX tones to buffer
     */
    private writeVoxTones(buffer: Float32Array, offset: number): number {
        const toneSamples = this.durationToSamples(0.1);
        const silenceSamples = this.durationToSamples(0.1);

        offset = this.phaseAccumulator.generateTone(buffer, offset, 1900, toneSamples);
        offset += silenceSamples; // Silence (buffer already zeroed)
        offset = this.phaseAccumulator.generateTone(buffer, offset, 1900, toneSamples);
        offset += silenceSamples;

        return offset;
    }

    /**
     * Write calibration header to buffer
     */
    private writeCalibrationHeader(buffer: Float32Array, offset: number): number {
        // Leader tone 1: 1900Hz for 300ms
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_LEADER,
            this.durationToSamples(CONST.CALIB_LEADER_1));

        // Break: 1200Hz for 10ms
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_SYNC,
            this.durationToSamples(CONST.CALIB_BREAK));

        // Leader tone 2: 1900Hz for 300ms
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_LEADER,
            this.durationToSamples(CONST.CALIB_LEADER_2));

        // VIS start bit: 1200Hz for 30ms
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_VIS_START,
            this.durationToSamples(CONST.CALIB_VIS_START));

        return offset;
    }

    /**
     * Write VIS code to buffer
     */
    private writeVISCode(buffer: Float32Array, offset: number): number {
        const visCode = this.mode.id;
        const bitSamples = this.durationToSamples(CONST.VIS_BIT_DURATION);

        // Extract 7 data bits (LSB first) and calculate even parity
        let parityCount = 0;
        for (let i = 0; i < 7; i++) {
            const bit = (visCode >> i) & 1;
            parityCount += bit;
            const freq = bit === 1 ? CONST.FREQ_VIS_BIT1 : CONST.FREQ_VIS_BIT0;
            offset = this.phaseAccumulator.generateTone(buffer, offset, freq, bitSamples);
        }

        // Parity bit (even parity)
        const parityBit = parityCount % 2;
        const parityFreq = parityBit === 1 ? CONST.FREQ_VIS_BIT1 : CONST.FREQ_VIS_BIT0;
        offset = this.phaseAccumulator.generateTone(buffer, offset, parityFreq, bitSamples);

        // Stop bit: 1200Hz for 30ms
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_VIS_START, bitSamples);

        return offset;
    }

    /**
     * Write image data to buffer
     */
    private writeImageData(buffer: Float32Array, offset: number, channels: number[][][]): number {
        const height = channels[0].length;

        // Check if this is a PD mode (4 channels = Y-even, V, U, Y-odd)
        const isPDMode = this.mode.channelCount === 4 && this.mode.colorFormat === ColorFormat.YCrCb;

        // Start sync for Scottie modes
        if (this.mode.hasStartSync) {
            offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_SYNC,
                this.durationToSamples(0.009));
        }

        if (isPDMode) {
            // PD modes: encode 2 lines per sync pulse
            for (let linePair = 0; linePair < height / 2; linePair++) {
                offset = this.writePDLinePair(buffer, offset, channels, linePair);
            }
        } else {
            // Regular modes: encode line by line
            for (let line = 0; line < height; line++) {
                offset = this.writeLine(buffer, offset, channels, line);
            }
        }

        return offset;
    }

    /**
     * Write a PD mode line pair (2 image lines from 1 sync pulse)
     */
    private writePDLinePair(buffer: Float32Array, offset: number, channels: number[][][], linePair: number): number {
        const evenLine = linePair * 2;
        const oddLine = linePair * 2 + 1;
        const width = this.mode.width;

        // Sync pulse
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_SYNC,
            this.durationToSamples(this.mode.syncPulse));

        // Porch
        offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_PORCH,
            this.durationToSamples(this.mode.syncPorch));

        // Y-even channel
        offset = this.phaseAccumulator.generatePixelLine(buffer, offset, channels[0][evenLine],
            this.mode.getScanTime(evenLine, 0));

        // V channel (averaged from both lines)
        const avgV = new Array(width);
        for (let x = 0; x < width; x++) {
            avgV[x] = Math.round((channels[1][evenLine][x] + channels[1][oddLine][x]) / 2);
        }
        offset = this.phaseAccumulator.generatePixelLine(buffer, offset, avgV,
            this.mode.getScanTime(evenLine, 1));

        // U channel (averaged from both lines)
        const avgU = new Array(width);
        for (let x = 0; x < width; x++) {
            avgU[x] = Math.round((channels[2][evenLine][x] + channels[2][oddLine][x]) / 2);
        }
        offset = this.phaseAccumulator.generatePixelLine(buffer, offset, avgU,
            this.mode.getScanTime(evenLine, 2));

        // Y-odd channel
        offset = this.phaseAccumulator.generatePixelLine(buffer, offset, channels[0][oddLine],
            this.mode.getScanTime(oddLine, 3));

        return offset;
    }

    /**
     * Write a single scanline
     */
    private writeLine(buffer: Float32Array, offset: number, channels: number[][][], line: number): number {
        // Sync pulse (for most modes, except Scottie which has it in the middle)
        if (this.mode.syncChannel === undefined || this.mode.syncChannel === 0) {
            offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_SYNC,
                this.durationToSamples(this.mode.syncPulse));
            offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_PORCH,
                this.durationToSamples(this.mode.syncPorch));
        }

        // Generate each channel
        for (let ch = 0; ch < this.mode.channelCount; ch++) {
            const channelIndex = this.mode.channelOrder[ch];

            // Special separator handling for Robot modes
            if (this.mode.id === 8 && ch === 1) {
                // Robot 36: 4.5ms separator + 1.5ms porch before chroma
                const sepFreq = (line % 2 === 0) ? CONST.FREQ_SEPARATOR_EVEN : CONST.FREQ_SEPARATOR_ODD;
                offset = this.phaseAccumulator.generateTone(buffer, offset, sepFreq,
                    this.durationToSamples(0.0045));
                offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_LEADER,
                    this.durationToSamples(0.0015));
            } else if (this.mode.id === 12 && ch > 0) {
                // Robot 72: separator handling
                const sepFreq = (ch === 1) ? CONST.FREQ_SEPARATOR_EVEN : CONST.FREQ_SEPARATOR_ODD;
                const porchFreq = (ch === 1) ? CONST.FREQ_LEADER : CONST.FREQ_SEPARATOR_EVEN;
                offset = this.phaseAccumulator.generateTone(buffer, offset, sepFreq,
                    this.durationToSamples(0.0045));
                offset = this.phaseAccumulator.generateTone(buffer, offset, porchFreq,
                    this.durationToSamples(0.0015));
            } else if (this.mode.separatorPulses[ch] > 0) {
                offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_PORCH,
                    this.durationToSamples(this.mode.separatorPulses[ch]));
            }

            // Generate channel pixel data
            offset = this.phaseAccumulator.generatePixelLine(buffer, offset, channels[channelIndex][line],
                this.mode.getScanTime(line, ch));

            // Sync pulse in the middle (Scottie modes)
            if (this.mode.syncChannel === ch + 1) {
                offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_SYNC,
                    this.durationToSamples(this.mode.syncPulse));
                offset = this.phaseAccumulator.generateTone(buffer, offset, CONST.FREQ_PORCH,
                    this.durationToSamples(this.mode.syncPorch));
            }
        }

        return offset;
    }
}
