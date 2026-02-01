/**
 * FFT and frequency analysis utilities
 */

import FFT from 'fft.js';

/**
 * Hann window function for FFT
 */
export function createHannWindow(length: number): Float32Array {
    const window = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    }
    return window;
}

/**
 * Barycentric peak interpolation for sub-bin frequency estimation
 */
export function barycentricPeakInterpolation(bins: Float32Array, peakIndex: number): number {
    if (peakIndex <= 0 || peakIndex >= bins.length - 1) {
        return peakIndex;
    }

    const y1 = bins[peakIndex - 1];
    const y2 = bins[peakIndex];
    const y3 = bins[peakIndex + 1];

    const denom = y3 + y2 + y1;
    if (denom === 0) return peakIndex;

    return (y3 - y1) / denom + peakIndex;
}

/**
 * FFT-based frequency analyzer
 */
export class FrequencyAnalyzer {
    private fft: FFT;
    private fftSize: number;
    private sampleRate: number;
    private inputBuffer: Float32Array;
    private outputBuffer: Float32Array;
    private magnitudes: Float32Array;
    private window: Float32Array;

    constructor(fftSize: number, sampleRate: number) {
        this.fftSize = fftSize;
        this.sampleRate = sampleRate;
        this.fft = new FFT(fftSize);
        this.inputBuffer = new Float32Array(fftSize);
        this.outputBuffer = new Float32Array(fftSize * 2);
        this.magnitudes = new Float32Array(fftSize / 2 + 1);
        this.window = createHannWindow(fftSize);
    }

    /**
     * Analyze a chunk of audio and return the peak frequency
     */
    getPeakFrequency(samples: Float32Array): number {
        const len = Math.min(samples.length, this.fftSize);

        // Apply window and copy to input buffer
        this.inputBuffer.fill(0);
        for (let i = 0; i < len; i++) {
            this.inputBuffer[i] = samples[i] * this.window[i];
        }

        // Perform FFT
        this.fft.realTransform(this.outputBuffer, this.inputBuffer);

        // Calculate magnitudes and find peak
        let maxMagnitude = -1;
        let peakBin = 0;

        for (let i = 0; i < this.magnitudes.length; i++) {
            const real = this.outputBuffer[2 * i];
            const imag = this.outputBuffer[2 * i + 1];
            const magnitude = Math.sqrt(real * real + imag * imag);
            this.magnitudes[i] = magnitude;

            if (magnitude > maxMagnitude) {
                maxMagnitude = magnitude;
                peakBin = i;
            }
        }

        // Interpolate for sub-bin accuracy
        const interpolatedBin = barycentricPeakInterpolation(this.magnitudes, peakBin);

        // Convert bin to frequency
        return interpolatedBin * this.sampleRate / this.fftSize;
    }

    /**
     * Get frequency resolution (Hz per bin)
     */
    getFrequencyResolution(): number {
        return this.sampleRate / this.fftSize;
    }

    /**
     * Get magnitude at a specific frequency
     */
    getMagnitudeAtFrequency(samples: Float32Array, targetFreq: number): number {
        const len = Math.min(samples.length, this.fftSize);

        this.inputBuffer.fill(0);
        for (let i = 0; i < len; i++) {
            this.inputBuffer[i] = samples[i] * this.window[i];
        }

        this.fft.realTransform(this.outputBuffer, this.inputBuffer);

        const bin = Math.round(targetFreq * this.fftSize / this.sampleRate);
        if (bin < 0 || bin >= this.magnitudes.length) return 0;

        const real = this.outputBuffer[2 * bin];
        const imag = this.outputBuffer[2 * bin + 1];
        return Math.sqrt(real * real + imag * imag);
    }
}

/**
 * Zero-crossing rate calculation for frequency estimation
 * Useful as a faster alternative to FFT for pure tones
 */
export function zeroCrossingRate(samples: Float32Array, sampleRate: number): number {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
        if ((samples[i - 1] < 0 && samples[i] >= 0) ||
            (samples[i - 1] >= 0 && samples[i] < 0)) {
            crossings++;
        }
    }

    // Frequency = crossings / 2 / duration
    const duration = samples.length / sampleRate;
    return (crossings / 2) / duration;
}
