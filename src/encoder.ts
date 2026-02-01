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
import { rgbToYUV, rgbToYCrCb } from './utils/colorspace';

/**
 * Generate a sine wave tone with phase continuity
 * @param frequency Frequency in Hz
 * @param duration Duration in seconds
 * @param sampleRate Sample rate
 * @param startPhase Starting phase in radians
 * @returns Object with buffer and ending phase
 */
function generateTone(
    frequency: number,
    duration: number,
    sampleRate: number,
    startPhase: number = 0
): { buffer: Float32Array; endPhase: number } {
    const samples = Math.floor(duration * sampleRate);
    const buffer = new Float32Array(samples);
    const phaseIncrement = (2 * Math.PI * frequency) / sampleRate;

    let phase = startPhase;
    for (let i = 0; i < samples; i++) {
        buffer[i] = Math.sin(phase);
        phase += phaseIncrement;
    }

    // Normalize phase to [0, 2π)
    phase = phase % (2 * Math.PI);
    if (phase < 0) phase += 2 * Math.PI;

    return { buffer, endPhase: phase };
}

/**
 * SSTV Image Encoder
 */
export class SSTVEncoder {
    private mode: SSTVMode;
    private sampleRate: number;
    private addCalibrationHeader: boolean;
    private addVoxTones: boolean;
    private phase: number = 0; // Phase accumulator for continuity

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
        this.phase = 0;

        // Validate and resize image if needed
        if (width !== this.mode.width || height !== this.mode.height) {
            imageData = this.resizeImage(imageData, width, height, this.mode.width, this.mode.height);
            width = this.mode.width;
            height = this.mode.height;
        }

        // Convert to mode's color space
        const channels = this.convertToColorSpace(imageData, width, height);

        // Build audio buffer
        const buffers: Float32Array[] = [];

        // Add VOX tones if requested
        if (this.addVoxTones) {
            buffers.push(this.generateVoxTones());
        }

        // Add calibration header
        if (this.addCalibrationHeader) {
            buffers.push(this.generateCalibrationHeader());
            buffers.push(this.generateVISCode());
        }

        // Generate image data
        buffers.push(this.generateImageData(channels));

        // Concatenate all buffers
        return this.concatenateBuffers(buffers);
    }

    /**
     * Resize image using nearest neighbor
     */
    private resizeImage(
        src: Uint8Array,
        srcWidth: number,
        srcHeight: number,
        dstWidth: number,
        dstHeight: number
    ): Uint8Array {
        const dst = new Uint8Array(dstWidth * dstHeight * 3);

        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = Math.floor(x * srcWidth / dstWidth);
                const srcY = Math.floor(y * srcHeight / dstHeight);

                const srcIdx = (srcY * srcWidth + srcX) * 3;
                const dstIdx = (y * dstWidth + x) * 3;

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
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 3;
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
                        // Robot 36
                        // Even lines (1500Hz sep): V (red chroma)
                        // Odd lines (2300Hz sep): U (blue chroma)
                        channels[1][y][x] = (y % 2 === 0) ? v : u;
                    } else if (this.mode.channelCount >= 3) {
                        // Robot 72 and PD modes
                        channels[1][y][x] = v;
                        channels[2][y][x] = u;
                    }
                } else if (this.mode.colorFormat === ColorFormat.Grayscale) {
                    // Convert to grayscale
                    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
                    channels[0][y][x] = gray;
                }
            }
        }

        return channels;
    }

    /**
     * Generate VOX tones
     */
    private generateVoxTones(): Float32Array {
        const buffers: Float32Array[] = [];

        // 1900Hz for 100ms, silence for 100ms, repeated
        let result = generateTone(1900, 0.1, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        buffers.push(new Float32Array(Math.floor(0.1 * this.sampleRate)));

        result = generateTone(1900, 0.1, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        buffers.push(new Float32Array(Math.floor(0.1 * this.sampleRate)));

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate calibration header
     */
    private generateCalibrationHeader(): Float32Array {
        const buffers: Float32Array[] = [];

        // Leader tone 1: 1900Hz for 300ms
        let result = generateTone(CONST.FREQ_LEADER, CONST.CALIB_LEADER_1, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        // Break: 1200Hz for 10ms
        result = generateTone(CONST.FREQ_SYNC, CONST.CALIB_BREAK, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        // Leader tone 2: 1900Hz for 300ms
        result = generateTone(CONST.FREQ_LEADER, CONST.CALIB_LEADER_2, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        // VIS start bit: 1200Hz for 30ms
        result = generateTone(CONST.FREQ_VIS_START, CONST.CALIB_VIS_START, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate VIS code
     */
    private generateVISCode(): Float32Array {
        const visCode = this.mode.id;
        const buffers: Float32Array[] = [];

        // Convert VIS code to binary (LSB first)
        const bits: number[] = [];
        for (let i = 0; i < 7; i++) {
            bits.push((visCode >> i) & 1);
        }

        // Calculate even parity
        const parity = bits.reduce((a, b) => a + b, 0) % 2 === 0 ? 0 : 1;
        bits.push(parity);

        // Generate bit tones
        for (const bit of bits) {
            const freq = bit === 1 ? CONST.FREQ_VIS_BIT1 : CONST.FREQ_VIS_BIT0;
            const result = generateTone(freq, CONST.VIS_BIT_DURATION, this.sampleRate, this.phase);
            buffers.push(result.buffer);
            this.phase = result.endPhase;
        }

        // Stop bit: 1200Hz for 30ms
        const result = generateTone(CONST.FREQ_VIS_START, CONST.VIS_STOP_BIT_DURATION, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate image data
     * Special handling for PD modes which encode 2 lines per sync pulse
     */
    private generateImageData(channels: number[][][]): Float32Array {
        const buffers: Float32Array[] = [];
        const height = channels[0].length;

        // Check if this is a PD mode (4 channels = Y-even, V, U, Y-odd)
        const isPDMode = this.mode.channelCount === 4 && this.mode.colorFormat === ColorFormat.YCrCb;

        // Start sync for Scottie modes
        if (this.mode.hasStartSync) {
            const result = generateTone(CONST.FREQ_SYNC, 0.009, this.sampleRate, this.phase);
            buffers.push(result.buffer);
            this.phase = result.endPhase;
        }

        if (isPDMode) {
            // PD modes: encode 2 lines per sync pulse
            // Structure: Sync + Porch + Y-even + V + U + Y-odd
            for (let linePair = 0; linePair < height / 2; linePair++) {
                buffers.push(this.generatePDLinePair(channels, linePair));
            }
        } else {
            // Regular modes: encode line by line
            for (let line = 0; line < height; line++) {
                buffers.push(this.generateLine(channels, line));
            }
        }

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate a PD mode line pair (2 image lines from 1 sync pulse)
     * Structure: Sync + Porch + Y-even + V + U + Y-odd
     * V and U are averaged from both even and odd lines
     */
    private generatePDLinePair(channels: number[][][], linePair: number): Float32Array {
        const buffers: Float32Array[] = [];
        const evenLine = linePair * 2;
        const oddLine = linePair * 2 + 1;

        // Sync pulse
        let result = generateTone(CONST.FREQ_SYNC, this.mode.syncPulse, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        result = generateTone(CONST.FREQ_PORCH, this.mode.syncPorch, this.sampleRate, this.phase);
        buffers.push(result.buffer);
        this.phase = result.endPhase;

        // Y-even channel (channel 0, even line)
        buffers.push(this.generateChannel(channels[0][evenLine], 0, evenLine));

        // V channel (channel 1, averaged from both lines)
        const avgV = new Array(this.mode.width);
        for (let x = 0; x < this.mode.width; x++) {
            avgV[x] = Math.round((channels[1][evenLine][x] + channels[1][oddLine][x]) / 2);
        }
        buffers.push(this.generateChannel(avgV, 1, evenLine));

        // U channel (channel 2, averaged from both lines)
        const avgU = new Array(this.mode.width);
        for (let x = 0; x < this.mode.width; x++) {
            avgU[x] = Math.round((channels[2][evenLine][x] + channels[2][oddLine][x]) / 2);
        }
        buffers.push(this.generateChannel(avgU, 2, evenLine));

        // Y-odd channel (channel 0, odd line)
        buffers.push(this.generateChannel(channels[0][oddLine], 0, oddLine));

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate a single scanline
     */
    private generateLine(channels: number[][][], line: number): Float32Array {
        const buffers: Float32Array[] = [];

        // Sync pulse (for most modes, except Scottie which has it in the middle)
        if (this.mode.syncChannel === undefined || this.mode.syncChannel === 0) {
            let result = generateTone(CONST.FREQ_SYNC, this.mode.syncPulse, this.sampleRate, this.phase);
            buffers.push(result.buffer);
            this.phase = result.endPhase;

            result = generateTone(CONST.FREQ_PORCH, this.mode.syncPorch, this.sampleRate, this.phase);
            buffers.push(result.buffer);
            this.phase = result.endPhase;
        }

        // Generate each channel
        for (let ch = 0; ch < this.mode.channelCount; ch++) {
            // Get the actual channel index based on channelOrder
            // channelOrder maps: transmit position -> channel index
            const channelIndex = this.mode.channelOrder[ch];

            // Separator before channel (for some modes)
            if (this.mode.id === 8 && ch === 1) {
                // Robot 36 channel 1: needs 4.5ms separator + 1.5ms porch
                // Separator frequency alternates: 1500 Hz (even lines), 2300 Hz (odd lines)
                const sepFreq = (line % 2 === 0) ? CONST.FREQ_SEPARATOR_EVEN : CONST.FREQ_SEPARATOR_ODD;
                let result = generateTone(sepFreq, 0.0045, this.sampleRate, this.phase);
                buffers.push(result.buffer);
                this.phase = result.endPhase;

                result = generateTone(CONST.FREQ_LEADER, 0.0015, this.sampleRate, this.phase);
                buffers.push(result.buffer);
                this.phase = result.endPhase;
            } else if (this.mode.separatorPulses[ch] > 0) {
                const result = generateTone(CONST.FREQ_PORCH, this.mode.separatorPulses[ch], this.sampleRate, this.phase);
                buffers.push(result.buffer);
                this.phase = result.endPhase;
            }

            // Generate channel data
            buffers.push(this.generateChannel(channels[channelIndex][line], ch, line));

            // Sync pulse in the middle (Scottie modes)
            if (this.mode.syncChannel === ch + 1) {
                let result = generateTone(CONST.FREQ_SYNC, this.mode.syncPulse, this.sampleRate, this.phase);
                buffers.push(result.buffer);
                this.phase = result.endPhase;

                result = generateTone(CONST.FREQ_PORCH, this.mode.syncPorch, this.sampleRate, this.phase);
                buffers.push(result.buffer);
                this.phase = result.endPhase;
            }
        }

        return this.concatenateBuffers(buffers);
    }

    /**
     * Generate a single channel scanline with continuous phase
     */
    private generateChannel(pixelData: number[], channel: number, line: number): Float32Array {
        const scanTime = this.mode.getScanTime(line, channel);
        const totalSamples = Math.floor(scanTime * this.sampleRate);
        const buffer = new Float32Array(totalSamples);

        const samplesPerPixel = totalSamples / this.mode.width;

        for (let pixel = 0; pixel < this.mode.width; pixel++) {
            const value = pixelData[pixel];
            const freq = pixelToFrequency(value);
            const phaseIncrement = (2 * Math.PI * freq) / this.sampleRate;

            const startSample = Math.floor(pixel * samplesPerPixel);
            const endSample = Math.min(Math.floor((pixel + 1) * samplesPerPixel), totalSamples);

            for (let s = startSample; s < endSample; s++) {
                buffer[s] = Math.sin(this.phase);
                this.phase += phaseIncrement;
            }
        }

        // Normalize phase
        this.phase = this.phase % (2 * Math.PI);
        if (this.phase < 0) this.phase += 2 * Math.PI;

        return buffer;
    }

    /**
     * Concatenate multiple Float32Arrays
     */
    private concatenateBuffers(buffers: Float32Array[]): Float32Array {
        const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
        const result = new Float32Array(totalLength);

        let offset = 0;
        for (const buffer of buffers) {
            result.set(buffer, offset);
            offset += buffer.length;
        }

        return result;
    }
}
