/**
 * FFT and frequency analysis utilities
 * 
 * This module provides a higher-level frequency analyzer that
 * builds on the FFTPeakFinder for more advanced analysis.
 */

import FFT from 'fft.js';
import { hannWindow, quadraticPeakInterp } from './fft-helper';

// Re-export createHannWindow for backwards compatibility
export { hannWindow as createHannWindow } from './fft-helper';

/**
 * Quadratic peak interpolation for sub-bin frequency estimation
 * @deprecated Use quadraticPeakInterp from fft-helper instead
 */
export function barycentricPeakInterpolation(bins: Float32Array, peakIndex: number): number {
    return quadraticPeakInterp(bins, peakIndex);
}

/**
 * FFT-based frequency analyzer
 * 
 * Uses preallocated buffers and cached Hann window for performance.
 */
export class FrequencyAnalyzer {
    private readonly fft: FFT;
    private readonly fftSize: number;
    private readonly sampleRate: number;
    private readonly freqPerBin: number;
    private readonly inputBuffer: Float32Array;
    private readonly outputBuffer: Float32Array;
    private readonly magnitudes: Float32Array;

    constructor(fftSize: number, sampleRate: number) {
        this.fftSize = fftSize;
        this.sampleRate = sampleRate;
        this.freqPerBin = sampleRate / fftSize;
        this.fft = new FFT(fftSize);
        this.inputBuffer = new Float32Array(fftSize);
        this.outputBuffer = new Float32Array(fftSize * 2);
        this.magnitudes = new Float32Array(fftSize / 2 + 1);
    }

    /**
     * Analyze a chunk of audio and return the peak frequency
     */
    getPeakFrequency(samples: Float32Array): number {
        const len = Math.min(samples.length, this.fftSize);
        const window = hannWindow(len);

        // Apply window and copy to input buffer
        this.inputBuffer.fill(0);
        for (let i = 0; i < len; i++) {
            this.inputBuffer[i] = samples[i] * window[i];
        }

        // Perform FFT
        this.fft.realTransform(this.outputBuffer, this.inputBuffer);

        // Calculate magnitudes and find peak
        let maxMagnitude = -1;
        let peakBin = 0;
        const magLen = this.magnitudes.length;

        for (let i = 0; i < magLen; i++) {
            const real = this.outputBuffer[2 * i];
            const imag = this.outputBuffer[2 * i + 1];
            const magnitude = real * real + imag * imag; // Use squared magnitude for comparison
            this.magnitudes[i] = magnitude;

            if (magnitude > maxMagnitude) {
                maxMagnitude = magnitude;
                peakBin = i;
            }
        }

        // Convert to linear magnitude for interpolation (only around peak)
        if (peakBin > 0 && peakBin < magLen - 1) {
            this.magnitudes[peakBin - 1] = Math.sqrt(this.magnitudes[peakBin - 1]);
            this.magnitudes[peakBin] = Math.sqrt(this.magnitudes[peakBin]);
            this.magnitudes[peakBin + 1] = Math.sqrt(this.magnitudes[peakBin + 1]);
        }

        // Interpolate for sub-bin accuracy using quadratic interpolation
        const interpolatedBin = quadraticPeakInterp(this.magnitudes, peakBin);

        // Convert bin to frequency
        return interpolatedBin * this.freqPerBin;
    }

    /**
     * Get frequency resolution (Hz per bin)
     */
    getFrequencyResolution(): number {
        return this.freqPerBin;
    }

    /**
     * Get magnitude at a specific frequency
     */
    getMagnitudeAtFrequency(samples: Float32Array, targetFreq: number): number {
        const len = Math.min(samples.length, this.fftSize);
        const window = hannWindow(len);

        this.inputBuffer.fill(0);
        for (let i = 0; i < len; i++) {
            this.inputBuffer[i] = samples[i] * window[i];
        }

        this.fft.realTransform(this.outputBuffer, this.inputBuffer);

        const bin = Math.round(targetFreq / this.freqPerBin);
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
