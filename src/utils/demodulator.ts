/**
 * SSTV Demodulator using FM demodulation and complex baseband processing
 */

import {
    Complex,
    Phasor,
    FrequencyModulation,
    ComplexConvolution,
    SimpleMovingAverage,
    Delay,
    SchmittTrigger,
    Kaiser,
    Filter
} from './dsp';

export enum SyncPulseWidth {
    FiveMilliSeconds,
    NineMilliSeconds,
    TwentyMilliSeconds
}

export interface DemodulatorResult {
    syncPulseDetected: boolean;
    syncPulseWidth?: SyncPulseWidth;
    syncPulseOffset?: number;
    frequencyOffset?: number;
}

/**
 * SSTV Demodulator
 * 
 * This demodulator uses:
 * 1. Complex baseband conversion (oscillator at center frequency)
 * 2. Low-pass filtering with Kaiser window
 * 3. FM demodulation (phase difference method)
 * 4. Moving average filter for smoothing
 * 5. Schmitt trigger for robust sync detection
 * 6. Pulse width measurement (5ms, 9ms, 20ms)
 */
export class Demodulator {
    // Signal processing components
    private readonly syncPulseFilter: SimpleMovingAverage;
    private readonly baseBandLowPass: ComplexConvolution;
    private readonly frequencyModulation: FrequencyModulation;
    private readonly syncPulseTrigger: SchmittTrigger;
    private readonly baseBandOscillator: Phasor;
    private readonly syncPulseValueDelay: Delay;

    // Constants
    private readonly scanLineBandwidth: number;
    private readonly centerFrequency: number;
    private readonly syncPulseFrequencyValue: number;
    private readonly syncPulseFrequencyTolerance: number;
    private readonly syncPulseFilterDelay: number;

    // Pulse width thresholds (in samples)
    private readonly syncPulse5msMinSamples: number;
    private readonly syncPulse5msMaxSamples: number;
    private readonly syncPulse9msMaxSamples: number;
    private readonly syncPulse20msMaxSamples: number;

    // State
    private syncPulseCounter: number = 0;
    private baseBand: Complex = new Complex();

    // Public state
    public frequencyOffset: number = 0;

    // SSTV frequency constants
    public static readonly SYNC_PULSE_FREQUENCY = 1200;
    public static readonly BLACK_FREQUENCY = 1500;
    public static readonly WHITE_FREQUENCY = 2300;

    constructor(sampleRate: number) {
        this.scanLineBandwidth = Demodulator.WHITE_FREQUENCY - Demodulator.BLACK_FREQUENCY;
        this.frequencyModulation = new FrequencyModulation(this.scanLineBandwidth, sampleRate);

        // Sync pulse timing (5ms, 9ms, 20ms)
        const syncPulse5msSeconds = 0.005;
        const syncPulse9msSeconds = 0.009;
        const syncPulse20msSeconds = 0.020;
        const syncPulse5msMinSeconds = syncPulse5msSeconds / 2;
        const syncPulse5msMaxSeconds = (syncPulse5msSeconds + syncPulse9msSeconds) / 2;
        const syncPulse9msMaxSeconds = (syncPulse9msSeconds + syncPulse20msSeconds) / 2;
        const syncPulse20msMaxSeconds = syncPulse20msSeconds + syncPulse5msSeconds;

        this.syncPulse5msMinSamples = Math.round(syncPulse5msMinSeconds * sampleRate);
        this.syncPulse5msMaxSamples = Math.round(syncPulse5msMaxSeconds * sampleRate);
        this.syncPulse9msMaxSamples = Math.round(syncPulse9msMaxSeconds * sampleRate);
        this.syncPulse20msMaxSamples = Math.round(syncPulse20msMaxSeconds * sampleRate);

        // Moving average filter for sync pulse detection
        const syncPulseFilterSeconds = syncPulse5msSeconds / 2;
        const syncPulseFilterSamples = Math.round(syncPulseFilterSeconds * sampleRate) | 1;
        this.syncPulseFilterDelay = (syncPulseFilterSamples - 1) / 2;
        this.syncPulseFilter = new SimpleMovingAverage(syncPulseFilterSamples);
        this.syncPulseValueDelay = new Delay(syncPulseFilterSamples);

        // Baseband low-pass filter design
        const lowestFrequency = 1000;
        const highestFrequency = 2800;
        const cutoffFrequency = (highestFrequency - lowestFrequency) / 2;
        const baseBandLowPassSeconds = 0.002;
        const baseBandLowPassSamples = Math.round(baseBandLowPassSeconds * sampleRate) | 1;
        this.baseBandLowPass = new ComplexConvolution(baseBandLowPassSamples);

        // Design Kaiser-windowed low-pass filter
        const kaiser = new Kaiser();
        for (let i = 0; i < this.baseBandLowPass.length; i++) {
            this.baseBandLowPass.taps[i] =
                kaiser.window(2.0, i, this.baseBandLowPass.length) *
                Filter.lowPass(cutoffFrequency, sampleRate, i, this.baseBandLowPass.length);
        }

        // Center frequency and oscillator
        this.centerFrequency = (lowestFrequency + highestFrequency) / 2;
        this.baseBandOscillator = new Phasor(-this.centerFrequency, sampleRate);

        // Sync detection parameters
        this.syncPulseFrequencyValue = this.normalizeFrequency(Demodulator.SYNC_PULSE_FREQUENCY);
        this.syncPulseFrequencyTolerance = 50 * 2 / this.scanLineBandwidth;

        // Schmitt trigger hysteresis levels
        const syncPorchFrequency = 1500;
        const syncHighFrequency = (Demodulator.SYNC_PULSE_FREQUENCY + syncPorchFrequency) / 2;
        const syncLowFrequency = (Demodulator.SYNC_PULSE_FREQUENCY + syncHighFrequency) / 2;
        const syncLowValue = this.normalizeFrequency(syncLowFrequency);
        const syncHighValue = this.normalizeFrequency(syncHighFrequency);
        this.syncPulseTrigger = new SchmittTrigger(syncLowValue, syncHighValue);
    }

    /**
     * Normalize frequency to [-1, 1] range
     */
    private normalizeFrequency(frequency: number): number {
        return (frequency - this.centerFrequency) * 2 / this.scanLineBandwidth;
    }

    /**
     * Process audio buffer and detect sync pulses
     * @param buffer Input samples (mono)
     * @param output Output frequency values (normalized -1 to 1)
     * @returns Demodulation result with sync pulse information
     */
    public process(buffer: Float32Array, output: Float32Array): DemodulatorResult {
        let syncPulseDetected = false;
        let syncPulseWidth: SyncPulseWidth | undefined;
        let syncPulseOffset: number | undefined;

        for (let i = 0; i < buffer.length; i++) {
            // Step 1: Convert to complex baseband (shift to center frequency)
            this.baseBand.set(buffer[i]);
            this.baseBand.mul(this.baseBandOscillator.rotate());

            // Step 2: Low-pass filter
            this.baseBand = this.baseBandLowPass.push(this.baseBand);

            // Step 3: FM demodulation (extract frequency from phase)
            const frequencyValue = this.frequencyModulation.demod(this.baseBand);

            // Step 4: Smooth with moving average
            const syncPulseValue = this.syncPulseFilter.avg(frequencyValue);
            const syncPulseDelayedValue = this.syncPulseValueDelay.push(syncPulseValue);

            // Store frequency value for decoding
            output[i] = frequencyValue;

            // Step 5: Sync pulse detection with Schmitt trigger
            if (!this.syncPulseTrigger.latch(syncPulseValue)) {
                // Still in sync pulse
                this.syncPulseCounter++;
            } else if (
                this.syncPulseCounter < this.syncPulse5msMinSamples ||
                this.syncPulseCounter > this.syncPulse20msMaxSamples ||
                Math.abs(syncPulseDelayedValue - this.syncPulseFrequencyValue) > this.syncPulseFrequencyTolerance
            ) {
                // Invalid pulse - reset
                this.syncPulseCounter = 0;
            } else {
                // Valid sync pulse detected! Determine width
                if (this.syncPulseCounter < this.syncPulse5msMaxSamples) {
                    syncPulseWidth = SyncPulseWidth.FiveMilliSeconds;
                } else if (this.syncPulseCounter < this.syncPulse9msMaxSamples) {
                    syncPulseWidth = SyncPulseWidth.NineMilliSeconds;
                } else {
                    syncPulseWidth = SyncPulseWidth.TwentyMilliSeconds;
                }

                // syncPulseOffset should point to the START of the sync pulse
                // i is the index where the pulse ENDED (trigger unlatched)
                // syncPulseCounter is the duration
                syncPulseOffset = i - this.syncPulseFilterDelay - this.syncPulseCounter;
                this.frequencyOffset = syncPulseDelayedValue - this.syncPulseFrequencyValue;
                syncPulseDetected = true;
                this.syncPulseCounter = 0;
            }
        }

        return {
            syncPulseDetected,
            syncPulseWidth,
            syncPulseOffset,
            frequencyOffset: this.frequencyOffset
        };
    }

    /**
     * Reset demodulator state
     */
    public reset(): void {
        this.syncPulseCounter = 0;
        this.frequencyOffset = 0;
        this.syncPulseTrigger.reset();
    }
}
