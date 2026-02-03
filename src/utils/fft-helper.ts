/**
 * FFT helper for finding peak frequency in audio windows
 */

import FFT from 'fft.js';

// LRU cache for Hann window coefficients by size
// Limits memory growth when using dynamic window sizes
const MAX_HANN_CACHE_SIZE = 20;
const hannWindowCache = new Map<number, Float32Array>();
const hannWindowLRU: number[] = [];

/**
 * Generate or retrieve cached Hann window coefficients
 * Uses LRU eviction when cache exceeds MAX_HANN_CACHE_SIZE
 * 
 * @param size Window size
 * @returns Cached Float32Array with Hann window coefficients
 */
export function hannWindow(size: number): Float32Array {
    let window = hannWindowCache.get(size);
    if (!window) {
        window = new Float32Array(size);
        const factor = (2 * Math.PI) / (size - 1);
        for (let i = 0; i < size; i++) {
            window[i] = 0.5 * (1 - Math.cos(factor * i));
        }

        // LRU eviction if cache is full
        if (hannWindowCache.size >= MAX_HANN_CACHE_SIZE) {
            const oldest = hannWindowLRU.shift();
            if (oldest !== undefined) {
                hannWindowCache.delete(oldest);
            }
        }

        hannWindowCache.set(size, window);
        hannWindowLRU.push(size);
    } else {
        // Move to end of LRU list (most recently used)
        const idx = hannWindowLRU.indexOf(size);
        if (idx !== -1) {
            hannWindowLRU.splice(idx, 1);
            hannWindowLRU.push(size);
        }
    }
    return window;
}

/**
 * Clear the Hann window cache (useful for memory management)
 */
export function clearHannWindowCache(): void {
    hannWindowCache.clear();
}

/**
 * Quadratic (parabolic) peak interpolation for sub-bin frequency resolution
 * Uses the standard formula: delta = 0.5 * (y1 - y3) / (y1 - 2*y2 + y3)
 * This is more accurate than barycentric for magnitude spectra
 * 
 * @param magnitudes Magnitude array
 * @param peakIndex Index of the peak bin
 * @returns Interpolated peak position
 */
export function quadraticPeakInterp(magnitudes: Float32Array, peakIndex: number): number {
    if (peakIndex <= 0 || peakIndex >= magnitudes.length - 1) {
        return peakIndex;
    }

    const y1 = magnitudes[peakIndex - 1];
    const y2 = magnitudes[peakIndex];
    const y3 = magnitudes[peakIndex + 1];

    // Standard quadratic interpolation formula
    const denom = y1 - 2 * y2 + y3;
    if (Math.abs(denom) < 1e-10) {
        return peakIndex;
    }

    const offset = 0.5 * (y1 - y3) / denom;
    // Clamp offset to [-0.5, 0.5] to stay within the bin
    const clampedOffset = Math.max(-0.5, Math.min(0.5, offset));
    return peakIndex + clampedOffset;
}

/**
 * Find peak frequency in audio data using FFT
 * 
 * Optimizations:
 * - Reuses preallocated buffers
 * - Caches Hann window by size
 * - Uses quadratic interpolation for accuracy
 */
export class FFTPeakFinder {
    private readonly fft: FFT;
    private readonly fftSize: number;
    private readonly fftInput: Float64Array;
    private readonly fftOutput: Float64Array;
    private readonly magnitudes: Float32Array;
    private readonly sampleRate: number;
    private readonly freqPerBin: number;

    // Cached window for the FFT size
    private readonly fullWindow: Float32Array;

    constructor(fftSize: number, sampleRate: number) {
        this.fftSize = fftSize;
        this.fft = new FFT(fftSize);
        this.fftInput = new Float64Array(fftSize);
        this.fftOutput = new Float64Array(fftSize * 2); // Complex output
        this.magnitudes = new Float32Array(fftSize / 2 + 1);
        this.sampleRate = sampleRate;
        this.freqPerBin = sampleRate / fftSize;
        this.fullWindow = hannWindow(fftSize);
    }

    /**
     * Find the dominant frequency in the given audio data
     * @param data Audio samples (can be smaller than FFT size)
     * @returns Peak frequency in Hz
     */
    findPeakFrequency(data: Float32Array): number {
        const len = data.length;

        // Clear input buffer
        this.fftInput.fill(0);

        // Apply window - use cached full window if size matches, otherwise get from cache
        if (len === this.fftSize) {
            for (let i = 0; i < len; i++) {
                this.fftInput[i] = data[i] * this.fullWindow[i];
            }
        } else {
            const window = hannWindow(len);
            for (let i = 0; i < len; i++) {
                this.fftInput[i] = data[i] * window[i];
            }
        }

        // Perform FFT
        this.fft.realTransform(this.fftOutput, this.fftInput);

        // Calculate magnitudes and find peak in a single pass
        let maxMag = -1;
        let peakBin = 0;
        const magLen = this.magnitudes.length;

        for (let i = 0; i < magLen; i++) {
            const real = this.fftOutput[2 * i];
            const imag = this.fftOutput[2 * i + 1];
            // Use squared magnitude to avoid sqrt (faster comparison)
            const magSq = real * real + imag * imag;
            this.magnitudes[i] = magSq;

            if (magSq > maxMag) {
                maxMag = magSq;
                peakBin = i;
            }
        }

        // Convert to linear magnitude only around the peak for interpolation
        if (peakBin > 0 && peakBin < magLen - 1) {
            this.magnitudes[peakBin - 1] = Math.sqrt(this.magnitudes[peakBin - 1]);
            this.magnitudes[peakBin] = Math.sqrt(this.magnitudes[peakBin]);
            this.magnitudes[peakBin + 1] = Math.sqrt(this.magnitudes[peakBin + 1]);
        }

        // Refine peak using quadratic interpolation
        const refinedBin = quadraticPeakInterp(this.magnitudes, peakBin);

        // Convert bin to frequency
        return refinedBin * this.freqPerBin;
    }

    /**
     * Get the frequency resolution of this FFT
     * @returns Hz per bin
     */
    getFrequencyResolution(): number {
        return this.freqPerBin;
    }

    /**
     * Convert frequency to pixel value (SSTV standard)
     * Black = 1500Hz (0), White = 2300Hz (255)
     * 
     * @param freq Frequency in Hz
     * @returns Pixel value 0-255
     */
    static frequencyToPixel(freq: number): number {
        // SSTV standard: 1500Hz = 0, 2300Hz = 255
        // Factor: 800 / 255 = 3.1372549
        const value = (freq - 1500) * 0.31875; // 255/800 = 0.31875
        return Math.max(0, Math.min(255, Math.round(value)));
    }
}
