/**
 * Ring Buffer (Circular Buffer)
 * 
 * High-performance circular buffer for streaming audio processing.
 * Eliminates expensive array shifts by using wrap-around indices.
 * 
 * Used in streaming decoder to avoid `copyWithin` operations.
 */

/**
 * Generic ring buffer using Float32Array for audio samples.
 * 
 * @example
 * ```typescript
 * const buffer = new RingBuffer(48000); // 1 second at 48kHz
 * 
 * // Write samples
 * buffer.write(incomingSamples);
 * 
 * // Read samples at offset from read position
 * const value = buffer.read(100);
 * 
 * // Advance read position (consume samples)
 * buffer.advance(256);
 * ```
 */
export class RingBuffer {
    private readonly data: Float32Array;
    private readonly capacity: number;
    private readPos: number = 0;
    private writePos: number = 0;
    private count: number = 0;

    /**
     * Create a ring buffer with specified capacity
     * @param capacity Maximum number of samples to store
     */
    constructor(capacity: number) {
        this.capacity = capacity;
        this.data = new Float32Array(capacity);
    }

    /**
     * Write a single sample to the buffer
     * @param value Sample value
     * @returns true if written, false if buffer is full
     */
    writeSample(value: number): boolean {
        if (this.count >= this.capacity) {
            return false;
        }
        this.data[this.writePos] = value;
        this.writePos = (this.writePos + 1) % this.capacity;
        this.count++;
        return true;
    }

    /**
     * Write an array of samples to the buffer
     * @param samples Samples to write
     * @returns Number of samples actually written
     */
    write(samples: Float32Array): number {
        const toWrite = Math.min(samples.length, this.capacity - this.count);

        for (let i = 0; i < toWrite; i++) {
            this.data[this.writePos] = samples[i];
            this.writePos = (this.writePos + 1) % this.capacity;
        }
        this.count += toWrite;

        return toWrite;
    }

    /**
     * Write samples, overwriting oldest data if buffer is full
     * @param samples Samples to write
     */
    writeOverwrite(samples: Float32Array): void {
        for (let i = 0; i < samples.length; i++) {
            if (this.count >= this.capacity) {
                // Overwrite oldest: advance read position
                this.readPos = (this.readPos + 1) % this.capacity;
                this.count--;
            }
            this.data[this.writePos] = samples[i];
            this.writePos = (this.writePos + 1) % this.capacity;
            this.count++;
        }
    }

    /**
     * Read a sample at offset from read position (without consuming)
     * @param offset Offset from read position (0 = oldest available sample)
     * @returns Sample value, or 0 if offset is out of range
     */
    read(offset: number): number {
        if (offset < 0 || offset >= this.count) {
            return 0;
        }
        return this.data[(this.readPos + offset) % this.capacity];
    }

    /**
     * Read a range of samples into an output buffer
     * @param output Output buffer to fill
     * @param startOffset Start offset from read position
     * @returns Number of samples actually read
     */
    readRange(output: Float32Array, startOffset: number = 0): number {
        const toRead = Math.min(output.length, this.count - startOffset);
        if (toRead <= 0) return 0;

        for (let i = 0; i < toRead; i++) {
            output[i] = this.data[(this.readPos + startOffset + i) % this.capacity];
        }
        return toRead;
    }

    /**
     * Get a contiguous view of samples (may require copy if wrapped)
     * @param startOffset Start offset from read position
     * @param length Number of samples to get
     * @returns Float32Array view or copy
     */
    getView(startOffset: number, length: number): Float32Array {
        const availableLength = Math.min(length, this.count - startOffset);
        if (availableLength <= 0) {
            return new Float32Array(0);
        }

        const startIndex = (this.readPos + startOffset) % this.capacity;
        const endIndex = (startIndex + availableLength) % this.capacity;

        // Check if contiguous (no wrap-around)
        if (startIndex < endIndex || availableLength <= this.capacity - startIndex) {
            // Contiguous - return subarray view
            return this.data.subarray(startIndex, startIndex + Math.min(availableLength, this.capacity - startIndex));
        } else {
            // Wrapped - must copy
            const result = new Float32Array(availableLength);
            this.readRange(result, startOffset);
            return result;
        }
    }

    /**
     * Advance read position (consume samples)
     * @param count Number of samples to advance
     */
    advance(count: number): void {
        const toAdvance = Math.min(count, this.count);
        this.readPos = (this.readPos + toAdvance) % this.capacity;
        this.count -= toAdvance;
    }

    /**
     * Get number of samples available to read
     */
    available(): number {
        return this.count;
    }

    /**
     * Get number of samples that can be written
     */
    space(): number {
        return this.capacity - this.count;
    }

    /**
     * Get buffer capacity
     */
    getCapacity(): number {
        return this.capacity;
    }

    /**
     * Check if buffer is empty
     */
    isEmpty(): boolean {
        return this.count === 0;
    }

    /**
     * Check if buffer is full
     */
    isFull(): boolean {
        return this.count >= this.capacity;
    }

    /**
     * Clear all data
     */
    clear(): void {
        this.readPos = 0;
        this.writePos = 0;
        this.count = 0;
    }
}

/**
 * Multi-channel ring buffer for stereo or multi-channel audio
 */
export class MultiChannelRingBuffer {
    private readonly channels: RingBuffer[];
    private readonly channelCount: number;

    constructor(capacity: number, channelCount: number) {
        this.channelCount = channelCount;
        this.channels = [];
        for (let i = 0; i < channelCount; i++) {
            this.channels.push(new RingBuffer(capacity));
        }
    }

    /**
     * Write interleaved samples
     * @param samples Interleaved samples [ch0, ch1, ch0, ch1, ...]
     */
    writeInterleaved(samples: Float32Array): void {
        const frameCount = Math.floor(samples.length / this.channelCount);
        for (let frame = 0; frame < frameCount; frame++) {
            for (let ch = 0; ch < this.channelCount; ch++) {
                this.channels[ch].writeSample(samples[frame * this.channelCount + ch]);
            }
        }
    }

    /**
     * Get a specific channel's buffer
     */
    getChannel(index: number): RingBuffer {
        return this.channels[index];
    }

    /**
     * Get number of frames available (minimum across all channels)
     */
    available(): number {
        let min = Infinity;
        for (const ch of this.channels) {
            min = Math.min(min, ch.available());
        }
        return min;
    }

    /**
     * Advance all channels
     */
    advance(count: number): void {
        for (const ch of this.channels) {
            ch.advance(count);
        }
    }

    /**
     * Clear all channels
     */
    clear(): void {
        for (const ch of this.channels) {
            ch.clear();
        }
    }
}
