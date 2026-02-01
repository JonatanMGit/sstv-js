/**
 * FFT helper for finding peak frequency in audio windows
 */

import FFT from 'fft.js';

/**
 * Generate Hann window coefficients
 */
export function hannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
}

/**
 * Barycentric peak interpolation for sub-bin frequency resolution
 */
export function barycentricPeakInterp(magnitudes: Float32Array, peakIndex: number): number {
    if (peakIndex <= 0 || peakIndex >= magnitudes.length - 1) {
        return peakIndex;
    }

    const y1 = magnitudes[peakIndex - 1];
    const y2 = magnitudes[peakIndex];
    const y3 = magnitudes[peakIndex + 1];

    const denom = y1 + y2 + y3;
    if (denom === 0) {
        return peakIndex;
    }

    const offset = 0.5 * (y3 - y1) / (2 * y2 - y1 - y3);
    return peakIndex + offset;
}

/**
 * Find peak frequency in audio data using FFT
 */
export class FFTPeakFinder {
    private fft: FFT;
    private fftInput: Float64Array;
    private fftOutput: Float64Array;
    private magnitudes: Float32Array;
    private sampleRate: number;

    constructor(fftSize: number, sampleRate: number) {
        this.fft = new FFT(fftSize);
        this.fftInput = new Float64Array(fftSize);
        this.fftOutput = new Float64Array(fftSize * 2); // Complex output
        this.magnitudes = new Float32Array(fftSize / 2 + 1);
        this.sampleRate = sampleRate;
    }

    /**
     * Find the dominant frequency in the given audio data
     */
    findPeakFrequency(data: Float32Array): number {
        const len = data.length;
        const window = hannWindow(len);

        // Apply window and copy to FFT input, padding with zeros
        this.fftInput.fill(0);
        for (let i = 0; i < len; i++) {
            this.fftInput[i] = data[i] * window[i];
        }

        // Perform FFT
        this.fftOutput.fill(0);
        this.fft.realTransform(this.fftOutput, this.fftInput);

        // Calculate magnitudes and find peak
        let maxMag = -1;
        let peakBin = 0;

        for (let i = 0; i < this.magnitudes.length; i++) {
            const real = this.fftOutput[2 * i];
            const imag = this.fftOutput[2 * i + 1];
            const mag = Math.sqrt(real * real + imag * imag);
            this.magnitudes[i] = mag;

            if (mag > maxMag) {
                maxMag = mag;
                peakBin = i;
            }
        }

        // Refine peak using barycentric interpolation
        const refinedBin = barycentricPeakInterp(this.magnitudes, peakBin);

        // Convert bin to frequency
        return refinedBin * this.sampleRate / this.fft.size;
    }

    /**
     * Convert frequency to pixel value (SSTV standard)
     */
    static frequencyToPixel(freq: number): number {
        const value = Math.round((freq - 1500) / 3.1372549);
        return Math.min(Math.max(value, 0), 255);
    }
}
