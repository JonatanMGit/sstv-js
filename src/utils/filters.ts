/**
 * Additional DSP filters and utilities
 * 
 * This module contains additional signal processing utilities
 * that complement the core DSP module.
 */

/**
 * Exponential Moving Average filter
 * 
 * Smoother than simple moving average with less memory and O(1) per sample.
 * Common in audio processing for level tracking.
 * 
 * @example
 * ```typescript
 * // Create EMA with 0.1 alpha (slower response) or 0.9 (faster response)
 * const ema = new ExponentialMovingAverage(0.1);
 * 
 * for (const sample of samples) {
 *   const smoothed = ema.update(sample);
 * }
 * ```
 */
export class ExponentialMovingAverage {
    private readonly alpha: number;
    private value: number = 0;
    private initialized: boolean = false;

    /**
     * Create an EMA filter
     * @param alpha Smoothing factor (0-1). Higher = less smoothing, faster response.
     */
    constructor(alpha: number) {
        if (alpha <= 0 || alpha > 1) {
            throw new Error('Alpha must be in range (0, 1]');
        }
        this.alpha = alpha;
    }

    /**
     * Create EMA from time constant in samples
     * @param samples Number of samples for ~63% response (time constant)
     */
    static fromTimeConstant(samples: number): ExponentialMovingAverage {
        const alpha = 1 - Math.exp(-1 / samples);
        return new ExponentialMovingAverage(alpha);
    }

    /**
     * Create EMA from cutoff frequency
     * @param cutoffHz Cutoff frequency in Hz
     * @param sampleRate Sample rate in Hz
     */
    static fromCutoff(cutoffHz: number, sampleRate: number): ExponentialMovingAverage {
        const tau = 1 / (2 * Math.PI * cutoffHz);
        const alpha = 1 / (tau * sampleRate + 1);
        return new ExponentialMovingAverage(alpha);
    }

    /**
     * Update filter with new sample and return filtered value
     */
    update(sample: number): number {
        if (!this.initialized) {
            this.value = sample;
            this.initialized = true;
        } else {
            this.value = this.alpha * sample + (1 - this.alpha) * this.value;
        }
        return this.value;
    }

    /**
     * Get current filtered value
     */
    getValue(): number {
        return this.value;
    }

    /**
     * Reset filter state
     */
    reset(): void {
        this.value = 0;
        this.initialized = false;
    }

    /**
     * Set initial value (useful for continuing from known state)
     */
    setValue(value: number): void {
        this.value = value;
        this.initialized = true;
    }
}

/**
 * Dual-rate exponential filter with separate attack and decay
 * 
 * Uses different time constants for rising vs falling signals.
 * Common for audio envelope followers and level meters.
 */
export class AttackDecayFilter {
    private readonly attackAlpha: number;
    private readonly decayAlpha: number;
    private value: number = 0;

    constructor(attackSamples: number, decaySamples: number) {
        this.attackAlpha = 1 - Math.exp(-1 / attackSamples);
        this.decayAlpha = 1 - Math.exp(-1 / decaySamples);
    }

    /**
     * Update filter with new sample
     */
    update(sample: number): number {
        const alpha = sample > this.value ? this.attackAlpha : this.decayAlpha;
        this.value = alpha * sample + (1 - alpha) * this.value;
        return this.value;
    }

    getValue(): number {
        return this.value;
    }

    reset(): void {
        this.value = 0;
    }
}

/**
 * First-order IIR low-pass filter (RC filter)
 * 
 * Simple but effective low-pass filter with single-pole response.
 */
export class FirstOrderLowPass {
    private readonly b0: number;
    private readonly a1: number;
    private y1: number = 0;

    /**
     * Create filter from cutoff frequency
     * @param cutoffHz Cutoff frequency in Hz
     * @param sampleRate Sample rate in Hz
     */
    constructor(cutoffHz: number, sampleRate: number) {
        const rc = 1 / (2 * Math.PI * cutoffHz);
        const dt = 1 / sampleRate;
        const alpha = dt / (rc + dt);
        this.b0 = alpha;
        this.a1 = 1 - alpha;
    }

    /**
     * Process a sample
     */
    process(sample: number): number {
        this.y1 = this.b0 * sample + this.a1 * this.y1;
        return this.y1;
    }

    /**
     * Process an array in-place
     */
    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    reset(): void {
        this.y1 = 0;
    }
}

/**
 * First-order IIR high-pass filter
 */
export class FirstOrderHighPass {
    private readonly alpha: number;
    private x1: number = 0;
    private y1: number = 0;

    constructor(cutoffHz: number, sampleRate: number) {
        const rc = 1 / (2 * Math.PI * cutoffHz);
        const dt = 1 / sampleRate;
        this.alpha = rc / (rc + dt);
    }

    process(sample: number): number {
        this.y1 = this.alpha * (this.y1 + sample - this.x1);
        this.x1 = sample;
        return this.y1;
    }

    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    reset(): void {
        this.x1 = 0;
        this.y1 = 0;
    }
}

/**
 * DC Blocker (single-pole high-pass at very low frequency)
 * 
 * Removes DC offset from audio signals.
 */
export class DCBlocker {
    private readonly alpha: number;
    private x1: number = 0;
    private y1: number = 0;

    /**
     * Create DC blocker
     * @param alpha Pole position (0.99-0.9999, higher = lower cutoff)
     */
    constructor(alpha: number = 0.995) {
        this.alpha = alpha;
    }

    process(sample: number): number {
        this.y1 = sample - this.x1 + this.alpha * this.y1;
        this.x1 = sample;
        return this.y1;
    }

    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    reset(): void {
        this.x1 = 0;
        this.y1 = 0;
    }
}

/**
 * Pre-emphasis filter for RF transmission
 * 
 * Boosts high frequencies to compensate for de-emphasis in receivers.
 * Standard 50μs or 75μs time constants.
 */
export class PreEmphasis {
    private readonly alpha: number;
    private x1: number = 0;

    /**
     * Create pre-emphasis filter
     * @param tauMicroseconds Time constant in microseconds (50 or 75 typical)
     * @param sampleRate Sample rate in Hz
     */
    constructor(tauMicroseconds: number, sampleRate: number) {
        const tau = tauMicroseconds * 1e-6;
        this.alpha = 1 / (1 + 2 * Math.PI * tau * sampleRate);
    }

    /**
     * Create standard 50μs pre-emphasis
     */
    static standard50us(sampleRate: number): PreEmphasis {
        return new PreEmphasis(50, sampleRate);
    }

    /**
     * Create standard 75μs pre-emphasis
     */
    static standard75us(sampleRate: number): PreEmphasis {
        return new PreEmphasis(75, sampleRate);
    }

    process(sample: number): number {
        const output = sample - this.alpha * this.x1;
        this.x1 = sample;
        return output;
    }

    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    reset(): void {
        this.x1 = 0;
    }
}

/**
 * De-emphasis filter (inverse of pre-emphasis)
 */
export class DeEmphasis {
    private readonly beta: number;
    private y1: number = 0;

    constructor(tauMicroseconds: number, sampleRate: number) {
        const tau = tauMicroseconds * 1e-6;
        this.beta = 1 / (1 + 1 / (2 * Math.PI * tau * sampleRate));
    }

    static standard50us(sampleRate: number): DeEmphasis {
        return new DeEmphasis(50, sampleRate);
    }

    static standard75us(sampleRate: number): DeEmphasis {
        return new DeEmphasis(75, sampleRate);
    }

    process(sample: number): number {
        this.y1 = sample + this.beta * this.y1;
        return this.y1;
    }

    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    reset(): void {
        this.y1 = 0;
    }
}

/**
 * Median filter for impulse noise removal
 * 
 * Effective against clicks and pops while preserving edges.
 */
export class MedianFilter {
    private readonly windowSize: number;
    private readonly buffer: Float32Array;
    private readonly sorted: Float32Array;
    private writePos: number = 0;
    private filled: number = 0;

    constructor(windowSize: number) {
        if (windowSize % 2 === 0) {
            throw new Error('Window size must be odd');
        }
        this.windowSize = windowSize;
        this.buffer = new Float32Array(windowSize);
        this.sorted = new Float32Array(windowSize);
    }

    process(sample: number): number {
        this.buffer[this.writePos] = sample;
        this.writePos = (this.writePos + 1) % this.windowSize;
        if (this.filled < this.windowSize) {
            this.filled++;
        }

        // Copy and sort
        for (let i = 0; i < this.filled; i++) {
            this.sorted[i] = this.buffer[i];
        }
        this.sorted.subarray(0, this.filled).sort();

        // Return median
        return this.sorted[Math.floor(this.filled / 2)];
    }

    reset(): void {
        this.buffer.fill(0);
        this.writePos = 0;
        this.filled = 0;
    }
}

/**
 * Simple numeric statistics accumulator
 */
export class Statistics {
    private n: number = 0;
    private sum: number = 0;
    private sumSq: number = 0;
    private min: number = Infinity;
    private max: number = -Infinity;

    /**
     * Add a value to the statistics
     */
    add(value: number): void {
        this.n++;
        this.sum += value;
        this.sumSq += value * value;
        if (value < this.min) this.min = value;
        if (value > this.max) this.max = value;
    }

    /**
     * Get count of values
     */
    count(): number {
        return this.n;
    }

    /**
     * Get mean (average)
     */
    mean(): number {
        return this.n > 0 ? this.sum / this.n : 0;
    }

    /**
     * Get variance
     */
    variance(): number {
        if (this.n < 2) return 0;
        const mean = this.mean();
        return (this.sumSq / this.n) - (mean * mean);
    }

    /**
     * Get standard deviation
     */
    stdDev(): number {
        return Math.sqrt(this.variance());
    }

    /**
     * Get minimum value
     */
    getMin(): number {
        return this.min;
    }

    /**
     * Get maximum value
     */
    getMax(): number {
        return this.max;
    }

    /**
     * Reset statistics
     */
    reset(): void {
        this.n = 0;
        this.sum = 0;
        this.sumSq = 0;
        this.min = Infinity;
        this.max = -Infinity;
    }
}
