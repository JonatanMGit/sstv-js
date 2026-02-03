/**
 * Goertzel Algorithm for Efficient Single-Frequency Detection
 * 
 * The Goertzel algorithm is more efficient than FFT when you only need
 * to detect one or a few specific frequencies. It's O(N) vs O(N log N)
 * for the specific case of single-frequency magnitude calculation.
 * 
 * Commonly used for DTMF detection and sync pulse frequency verification.
 */

/**
 * Goertzel filter for single-frequency detection
 * 
 * @example
 * ```typescript
 * // Detect 1200 Hz sync pulse at 48000 sample rate
 * const goertzel = new Goertzel(1200, 48000);
 * 
 * // Process samples
 * for (const sample of samples) {
 *   goertzel.process(sample);
 * }
 * 
 * // Get magnitude
 * const magnitude = goertzel.getMagnitude();
 * goertzel.reset();
 * ```
 */
export class Goertzel {
    private readonly coeff: number;
    private readonly targetFreq: number;
    private readonly sampleRate: number;

    private s0: number = 0;
    private s1: number = 0;
    private s2: number = 0;
    private sampleCount: number = 0;

    /**
     * Create a Goertzel filter for a specific frequency
     * @param targetFreq Target frequency in Hz
     * @param sampleRate Sample rate in Hz
     */
    constructor(targetFreq: number, sampleRate: number) {
        this.targetFreq = targetFreq;
        this.sampleRate = sampleRate;

        // Pre-calculate coefficient
        const normalizedFreq = targetFreq / sampleRate;
        this.coeff = 2 * Math.cos(2 * Math.PI * normalizedFreq);
    }

    /**
     * Process a single sample
     * @param sample Input sample
     */
    process(sample: number): void {
        this.s0 = sample + this.coeff * this.s1 - this.s2;
        this.s2 = this.s1;
        this.s1 = this.s0;
        this.sampleCount++;
    }

    /**
     * Process an array of samples
     * @param samples Input samples
     */
    processBuffer(samples: Float32Array): void {
        for (let i = 0; i < samples.length; i++) {
            this.s0 = samples[i] + this.coeff * this.s1 - this.s2;
            this.s2 = this.s1;
            this.s1 = this.s0;
        }
        this.sampleCount += samples.length;
    }

    /**
     * Get the squared magnitude (power) at the target frequency
     * Avoids the sqrt for efficiency when comparing magnitudes
     */
    getMagnitudeSquared(): number {
        return this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2;
    }

    /**
     * Get the magnitude at the target frequency
     */
    getMagnitude(): number {
        return Math.sqrt(this.getMagnitudeSquared());
    }

    /**
     * Get normalized magnitude (divided by sample count for consistent comparison)
     */
    getNormalizedMagnitude(): number {
        if (this.sampleCount === 0) return 0;
        return this.getMagnitude() / this.sampleCount;
    }

    /**
     * Get number of samples processed since last reset
     */
    getSampleCount(): number {
        return this.sampleCount;
    }

    /**
     * Reset the filter state
     */
    reset(): void {
        this.s0 = 0;
        this.s1 = 0;
        this.s2 = 0;
        this.sampleCount = 0;
    }
}

/**
 * Multi-frequency Goertzel bank
 * 
 * Efficiently detect multiple frequencies in parallel.
 * 
 * @example
 * ```typescript
 * // SSTV sync and tone detection
 * const bank = new GoertzelBank([1100, 1200, 1300, 1500, 1900, 2300], 48000);
 * bank.processBuffer(samples);
 * 
 * const magnitudes = bank.getMagnitudes();
 * console.log('1200 Hz magnitude:', magnitudes[1]); // Index 1 = 1200 Hz
 * bank.reset();
 * ```
 */
export class GoertzelBank {
    private readonly filters: Goertzel[];
    private readonly frequencies: readonly number[];

    constructor(frequencies: number[], sampleRate: number) {
        this.frequencies = frequencies;
        this.filters = frequencies.map(freq => new Goertzel(freq, sampleRate));
    }

    /**
     * Process a single sample through all filters
     */
    process(sample: number): void {
        for (const filter of this.filters) {
            filter.process(sample);
        }
    }

    /**
     * Process an array of samples through all filters
     */
    processBuffer(samples: Float32Array): void {
        for (const filter of this.filters) {
            filter.processBuffer(samples);
        }
    }

    /**
     * Get magnitudes for all frequencies
     */
    getMagnitudes(): number[] {
        return this.filters.map(f => f.getMagnitude());
    }

    /**
     * Get squared magnitudes for all frequencies (faster for comparison)
     */
    getMagnitudesSquared(): number[] {
        return this.filters.map(f => f.getMagnitudeSquared());
    }

    /**
     * Get the index of the frequency with highest magnitude
     */
    getPeakIndex(): number {
        let maxMag = -1;
        let maxIndex = 0;
        for (let i = 0; i < this.filters.length; i++) {
            const mag = this.filters[i].getMagnitudeSquared();
            if (mag > maxMag) {
                maxMag = mag;
                maxIndex = i;
            }
        }
        return maxIndex;
    }

    /**
     * Get the frequency with highest magnitude
     */
    getPeakFrequency(): number {
        return this.frequencies[this.getPeakIndex()];
    }

    /**
     * Get a specific filter
     */
    getFilter(index: number): Goertzel {
        return this.filters[index];
    }

    /**
     * Get frequencies
     */
    getFrequencies(): readonly number[] {
        return this.frequencies;
    }

    /**
     * Reset all filters
     */
    reset(): void {
        for (const filter of this.filters) {
            filter.reset();
        }
    }
}

/**
 * Sliding Goertzel filter for continuous frequency detection
 * 
 * Uses a sliding window approach for real-time frequency tracking.
 */
export class SlidingGoertzel {
    private readonly targetFreq: number;
    private readonly sampleRate: number;
    private readonly windowSize: number;
    private readonly coeff: number;
    private readonly sinCoeff: number;
    private readonly cosCoeff: number;

    private readonly buffer: Float32Array;
    private writePos: number = 0;
    private s1: number = 0;
    private s2: number = 0;

    constructor(targetFreq: number, sampleRate: number, windowSize: number) {
        this.targetFreq = targetFreq;
        this.sampleRate = sampleRate;
        this.windowSize = windowSize;
        this.buffer = new Float32Array(windowSize);

        const normalizedFreq = targetFreq / sampleRate;
        const omega = 2 * Math.PI * normalizedFreq;
        this.coeff = 2 * Math.cos(omega);
        this.sinCoeff = Math.sin(omega);
        this.cosCoeff = Math.cos(omega);
    }

    /**
     * Process a sample and return current magnitude
     */
    process(sample: number): number {
        // Remove oldest sample contribution
        const oldestSample = this.buffer[this.writePos];

        // Add new sample
        this.buffer[this.writePos] = sample;
        this.writePos = (this.writePos + 1) % this.windowSize;

        // Update filter state (approximation for sliding window)
        const s0 = (sample - oldestSample) + this.coeff * this.s1 - this.s2;
        this.s2 = this.s1;
        this.s1 = s0;

        // Calculate magnitude
        return Math.sqrt(this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2);
    }

    /**
     * Reset filter state
     */
    reset(): void {
        this.buffer.fill(0);
        this.writePos = 0;
        this.s1 = 0;
        this.s2 = 0;
    }
}
