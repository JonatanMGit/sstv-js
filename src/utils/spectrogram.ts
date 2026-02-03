/**
 * Short Time Fourier Transform (STFT) for Spectrogram Visualization
 * 
 * Based on the Robot36 Android app's ShortTimeFourierTransform.java
 * Produces power spectrum data suitable for waterfall display
 */

import FFT from 'fft.js';
import { hannWindow } from './fft-helper';

/**
 * Low-pass filter kernel for smoothed weighting
 */
function lowPassWeight(bandwidth: number, length: number, index: number, totalLength: number): number {
    const center = (totalLength - 1) / 2;
    const x = index - center;
    if (x === 0) return bandwidth / length;
    const t = (Math.PI * bandwidth * x) / length;
    return (Math.sin(t) / (Math.PI * x));
}

/**
 * Short Time Fourier Transform for spectrogram generation
 * 
 * Uses overlapping windows with Hann weighting and low-pass filtering
 * for smooth, high-quality spectrogram output.
 */
export class ShortTimeFourierTransform {
    private readonly fft: FFT;
    private readonly fftSize: number;
    private readonly overlap: number;
    private readonly prevReal: Float32Array;
    private readonly prevImag: Float32Array;
    private readonly foldReal: Float32Array;
    private readonly foldImag: Float32Array;
    private readonly fftInput: Float64Array;
    private readonly fftOutput: Float64Array;
    private readonly weights: Float32Array;
    private index: number = 0;

    /** Power spectrum output (updated after each successful push()) */
    public readonly power: Float32Array;

    /**
     * Create a new STFT processor
     * @param fftSize FFT length (should be power of 2)
     * @param overlap Number of overlapping segments (typically 2-4)
     */
    constructor(fftSize: number, overlap: number = 3) {
        this.fftSize = fftSize;
        this.overlap = overlap;
        this.fft = new FFT(fftSize);

        const totalLength = fftSize * overlap;
        this.prevReal = new Float32Array(totalLength);
        this.prevImag = new Float32Array(totalLength);
        this.foldReal = new Float32Array(fftSize);
        this.foldImag = new Float32Array(fftSize);
        this.fftInput = new Float64Array(fftSize);
        this.fftOutput = new Float64Array(fftSize * 2);
        this.power = new Float32Array(fftSize);

        // Precompute weights: low-pass filter * Hann window
        this.weights = new Float32Array(totalLength);
        const hannWin = hannWindow(totalLength);
        for (let i = 0; i < totalLength; i++) {
            this.weights[i] = lowPassWeight(1, fftSize, i, totalLength) * hannWin[i];
        }
    }

    /**
     * Push a new complex sample and compute spectrum if ready
     * @param real Real part of the sample
     * @param imag Imaginary part of the sample (0 for real audio)
     * @returns true if a new spectrum was computed
     */
    push(real: number, imag: number = 0): boolean {
        this.prevReal[this.index] = real;
        this.prevImag[this.index] = imag;
        this.index = (this.index + 1) % this.prevReal.length;

        // Only compute when we've accumulated enough samples
        if (this.index % this.fftSize !== 0) {
            return false;
        }

        // Fold overlapping segments with weights
        this.foldReal.fill(0);
        this.foldImag.fill(0);

        let readIndex = this.index;
        for (let i = 0; i < this.fftSize; i++) {
            this.foldReal[i] = this.prevReal[readIndex] * this.weights[i];
            this.foldImag[i] = this.prevImag[readIndex] * this.weights[i];
            readIndex = (readIndex + 1) % this.prevReal.length;
        }

        for (let seg = 1; seg < this.overlap; seg++) {
            const weightOffset = seg * this.fftSize;
            for (let i = 0; i < this.fftSize; i++) {
                const w = this.weights[weightOffset + i];
                this.foldReal[i % this.fftSize] += this.prevReal[readIndex] * w;
                this.foldImag[i % this.fftSize] += this.prevImag[readIndex] * w;
                readIndex = (readIndex + 1) % this.prevReal.length;
            }
        }

        // Perform FFT on the folded data (real input only for audio)
        for (let i = 0; i < this.fftSize; i++) {
            this.fftInput[i] = this.foldReal[i];
        }
        this.fft.realTransform(this.fftOutput, this.fftInput);

        // Compute power spectrum
        for (let i = 0; i < this.fftSize; i++) {
            const re = this.fftOutput[2 * i];
            const im = this.fftOutput[2 * i + 1];
            this.power[i] = re * re + im * im;
        }

        return true;
    }

    /**
     * Push an array of real samples
     * @param samples Audio samples
     * @param callback Called each time a new spectrum is ready
     */
    pushSamples(samples: Float32Array, callback: (power: Float32Array) => void): void {
        for (let i = 0; i < samples.length; i++) {
            if (this.push(samples[i])) {
                callback(this.power);
            }
        }
    }

    /**
     * Get frequency for a given bin index
     * @param binIndex Bin index
     * @param sampleRate Sample rate in Hz
     * @returns Frequency in Hz
     */
    binToFrequency(binIndex: number, sampleRate: number): number {
        return (binIndex * sampleRate) / this.fftSize;
    }

    /**
     * Get bin index for a given frequency
     * @param frequency Frequency in Hz
     * @param sampleRate Sample rate in Hz
     * @returns Bin index (may be fractional)
     */
    frequencyToBin(frequency: number, sampleRate: number): number {
        return (frequency * this.fftSize) / sampleRate;
    }

    /**
     * Get the FFT size
     */
    getFFTSize(): number {
        return this.fftSize;
    }

    /**
     * Reset the STFT state
     */
    reset(): void {
        this.index = 0;
        this.prevReal.fill(0);
        this.prevImag.fill(0);
    }
}

/**
 * Spectrogram renderer for generating RGBA visualization data
 */
export class SpectrogramRenderer {
    private readonly stft: ShortTimeFourierTransform;
    private readonly sampleRate: number;
    private readonly width: number;
    private readonly height: number;
    private readonly buffer: Uint8Array;
    private readonly lineBuffer: Uint8Array;
    private line: number = 0;

    // Frequency range for SSTV (show 0-3000 Hz typically)
    private minFreq: number = 500;
    private maxFreq: number = 2500;

    /** Frequency markers in Hz (VIS bits, sync, etc.) */
    public readonly markers = [1100, 1200, 1300, 1500, 1900, 2300];

    constructor(sampleRate: number, width: number = 256, height: number = 128) {
        // Calculate FFT size based on desired frequency resolution (~10 Hz)
        const fftSize = Math.pow(2, Math.ceil(Math.log2(sampleRate / 10)));
        this.stft = new ShortTimeFourierTransform(fftSize, 3);
        this.sampleRate = sampleRate;
        this.width = width;
        this.height = height;
        this.buffer = new Uint8Array(width * height * 4); // RGBA
        this.lineBuffer = new Uint8Array(width * 4);
    }

    /**
     * Set the frequency range to display
     */
    setFrequencyRange(minFreq: number, maxFreq: number): void {
        this.minFreq = minFreq;
        this.maxFreq = maxFreq;
    }

    /**
     * Convert power value to rainbow color (similar to Robot36)
     */
    private rainbow(value: number): [number, number, number, number] {
        const v = Math.max(0, Math.min(1, value));
        const t = 4 * v - 2;
        const a = Math.min(4 * v, 1);
        let r = Math.max(0, Math.min(1, t)) * a;
        let g = Math.max(0, Math.min(1, 1 - Math.abs(t))) * a;
        let b = Math.max(0, Math.min(1, -t)) * a;

        // Gamma correction
        r = Math.sqrt(r);
        g = Math.sqrt(g);
        b = Math.sqrt(b);

        return [
            Math.round(r * 255),
            Math.round(g * 255),
            Math.round(b * 255),
            Math.round(a * 255)
        ];
    }

    /**
     * Process audio samples and update spectrogram
     * @param samples Audio samples
     * @returns Array of new line data (RGBA bytes, width*4 per line) to draw
     */
    process(samples: Float32Array): Uint8Array[] {
        const newLines: Uint8Array[] = [];
        const fftSize = this.stft.getFFTSize();
        const minBin = Math.floor(this.stft.frequencyToBin(this.minFreq, this.sampleRate));
        const maxBin = Math.ceil(this.stft.frequencyToBin(this.maxFreq, this.sampleRate));
        const binRange = maxBin - minBin;

        this.stft.pushSamples(samples, (power) => {
            const lowest = Math.log(1e-9);
            const highest = Math.log(1);
            const range = highest - lowest;

            // Map power spectrum to line buffer
            for (let x = 0; x < this.width; x++) {
                const bin = minBin + Math.floor((x * binRange) / this.width);
                const normalizedPower = (Math.log(power[bin] + 1e-12) - lowest) / range;
                const [r, g, b, a] = this.rainbow(normalizedPower);

                const offset = x * 4;
                this.lineBuffer[offset] = r;
                this.lineBuffer[offset + 1] = g;
                this.lineBuffer[offset + 2] = b;
                this.lineBuffer[offset + 3] = a;
            }

            // Add frequency markers
            for (const freq of this.markers) {
                if (freq >= this.minFreq && freq <= this.maxFreq) {
                    const x = Math.floor(((freq - this.minFreq) / (this.maxFreq - this.minFreq)) * this.width);
                    if (x >= 0 && x < this.width) {
                        const offset = x * 4;
                        // White markers
                        this.lineBuffer[offset] = 255;
                        this.lineBuffer[offset + 1] = 255;
                        this.lineBuffer[offset + 2] = 255;
                        this.lineBuffer[offset + 3] = 255;
                    }
                }
            }

            // Copy line buffer to result
            const lineCopy = new Uint8Array(this.lineBuffer);
            newLines.push(lineCopy);
        });

        return newLines;
    }

    /**
     * Get spectrogram width
     */
    getWidth(): number {
        return this.width;
    }

    /**
     * Get spectrogram height
     */
    getHeight(): number {
        return this.height;
    }

    /**
     * Reset the spectrogram state
     */
    reset(): void {
        this.stft.reset();
        this.line = 0;
        this.buffer.fill(0);
    }
}
