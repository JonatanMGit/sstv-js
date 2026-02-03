/**
 * Automatic Gain Control (AGC)
 * 
 * Port of MMSSTV's CLVL approach with peak tracking and adjustable attack/decay.
 * Normalizes input signals to a consistent level for more reliable decoding.
 */

/**
 * AGC configuration options
 */
export interface AGCOptions {
    /** Target output level (default: 1.0) */
    targetLevel?: number;
    /** Attack time constant in samples (faster = track peaks quickly) */
    attackSamples?: number;
    /** Decay time constant in samples (slower = hold gain longer) */
    decaySamples?: number;
    /** Minimum gain (prevents excessive amplification of noise) */
    minGain?: number;
    /** Maximum gain (prevents clipping on strong signals) */
    maxGain?: number;
    /** Initial gain (default: 1.0) */
    initialGain?: number;
}

/**
 * Automatic Gain Control using peak envelope tracking
 * 
 * This AGC uses separate attack and decay time constants for smooth
 * level control that quickly responds to signal increases but slowly
 * releases on signal decreases (typical for audio AGC).
 * 
 * @example
 * ```typescript
 * const agc = new AGC({ targetLevel: 1.0, attackSamples: 100, decaySamples: 1000 });
 * 
 * for (let i = 0; i < samples.length; i++) {
 *   samples[i] = agc.process(samples[i]);
 * }
 * ```
 */
export class AGC {
    private readonly targetLevel: number;
    private readonly attackCoeff: number;
    private readonly decayCoeff: number;
    private readonly minGain: number;
    private readonly maxGain: number;

    private envelope: number = 0;
    private gain: number;

    constructor(options: AGCOptions = {}) {
        this.targetLevel = options.targetLevel ?? 1.0;
        this.minGain = options.minGain ?? 0.1;
        this.maxGain = options.maxGain ?? 100;
        this.gain = options.initialGain ?? 1.0;

        // Convert time constants to exponential coefficients
        // coefficient = e^(-1/samples) ≈ 1 - 1/samples for large samples
        const attackSamples = options.attackSamples ?? 100;
        const decaySamples = options.decaySamples ?? 1000;

        this.attackCoeff = Math.exp(-1 / attackSamples);
        this.decayCoeff = Math.exp(-1 / decaySamples);
    }

    /**
     * Process a single sample through AGC
     * @param input Input sample
     * @returns Gain-adjusted output sample
     */
    process(input: number): number {
        const absInput = Math.abs(input);

        // Update envelope with attack/decay asymmetry
        if (absInput > this.envelope) {
            // Attack: fast response to increasing signal
            this.envelope = this.attackCoeff * this.envelope + (1 - this.attackCoeff) * absInput;
        } else {
            // Decay: slow release on decreasing signal
            this.envelope = this.decayCoeff * this.envelope + (1 - this.decayCoeff) * absInput;
        }

        // Calculate gain to reach target level
        if (this.envelope > 1e-10) {
            this.gain = this.targetLevel / this.envelope;
        }

        // Clamp gain to limits
        this.gain = Math.max(this.minGain, Math.min(this.maxGain, this.gain));

        return input * this.gain;
    }

    /**
     * Process an array of samples in-place
     * @param buffer Sample buffer to process
     */
    processBuffer(buffer: Float32Array): void {
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = this.process(buffer[i]);
        }
    }

    /**
     * Process an array of samples and return new buffer
     * @param input Input samples
     * @returns New buffer with gain-adjusted samples
     */
    processBufferCopy(input: Float32Array): Float32Array {
        const output = new Float32Array(input.length);
        for (let i = 0; i < input.length; i++) {
            output[i] = this.process(input[i]);
        }
        return output;
    }

    /**
     * Get current gain value
     */
    getGain(): number {
        return this.gain;
    }

    /**
     * Get current envelope value
     */
    getEnvelope(): number {
        return this.envelope;
    }

    /**
     * Reset AGC state
     */
    reset(): void {
        this.envelope = 0;
        this.gain = 1.0;
    }
}

/**
 * Peak-based level detector (simpler alternative to full AGC)
 * 
 * Tracks the peak level over a sliding window for normalization.
 * Useful when you want to normalize without the adaptive behavior of AGC.
 */
export class PeakLevelDetector {
    private readonly windowSize: number;
    private readonly samples: Float32Array;
    private writePos: number = 0;
    private peakValue: number = 0;
    private peakAge: number = 0;

    constructor(windowSamples: number) {
        this.windowSize = windowSamples;
        this.samples = new Float32Array(windowSamples);
    }

    /**
     * Add a sample and return the current peak level
     */
    update(sample: number): number {
        const absValue = Math.abs(sample);
        this.samples[this.writePos] = absValue;

        if (absValue >= this.peakValue) {
            this.peakValue = absValue;
            this.peakAge = 0;
        } else {
            this.peakAge++;
            if (this.peakAge >= this.windowSize) {
                // Peak aged out, find new peak
                this.peakValue = 0;
                for (let i = 0; i < this.windowSize; i++) {
                    if (this.samples[i] > this.peakValue) {
                        this.peakValue = this.samples[i];
                    }
                }
                this.peakAge = 0;
            }
        }

        this.writePos = (this.writePos + 1) % this.windowSize;
        return this.peakValue;
    }

    /**
     * Get current peak level
     */
    getPeak(): number {
        return this.peakValue;
    }

    /**
     * Reset detector state
     */
    reset(): void {
        this.samples.fill(0);
        this.writePos = 0;
        this.peakValue = 0;
        this.peakAge = 0;
    }
}
