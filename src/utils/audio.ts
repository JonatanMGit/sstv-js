/**
 * Audio file loading utilities
 * Supports WAV, MP3, OGG, and other formats via file conversion
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { AudioBuffer } from '../types';

/**
 * Read WAV file header
 */
function parseWavHeader(buffer: Buffer): {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    dataOffset: number;
    dataSize: number;
} | null {
    // Check RIFF header
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') {
        return null;
    }

    // Check WAVE format
    if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
        return null;
    }

    // Find fmt chunk
    let offset = 12;
    while (offset < buffer.length - 8) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);

        if (chunkId === 'fmt ') {
            const audioFormat = buffer.readUInt16LE(offset + 8);
            if (audioFormat !== 1 && audioFormat !== 3) { // PCM or IEEE float
                return null; // Unsupported format
            }

            const channels = buffer.readUInt16LE(offset + 10);
            const sampleRate = buffer.readUInt32LE(offset + 12);
            const bitsPerSample = buffer.readUInt16LE(offset + 22);

            // Find data chunk
            let dataOffset = offset + 8 + chunkSize;
            while (dataOffset < buffer.length - 8) {
                const dataChunkId = buffer.toString('ascii', dataOffset, dataOffset + 4);
                const dataChunkSize = buffer.readUInt32LE(dataOffset + 4);

                if (dataChunkId === 'data') {
                    return {
                        sampleRate,
                        channels,
                        bitsPerSample,
                        dataOffset: dataOffset + 8,
                        dataSize: dataChunkSize
                    };
                }

                dataOffset += 8 + dataChunkSize;
            }
        }

        offset += 8 + chunkSize;
    }

    return null;
}

/**
 * Convert PCM data to Float32Array
 */
function pcmToFloat32(
    buffer: Buffer,
    offset: number,
    length: number,
    bitsPerSample: number,
    channels: number,
    targetChannel: number = 0
): Float32Array {
    const bytesPerSample = bitsPerSample / 8;
    const samplesPerChannel = Math.floor(length / bytesPerSample / channels);
    const result = new Float32Array(samplesPerChannel);

    for (let i = 0; i < samplesPerChannel; i++) {
        const sampleOffset = offset + (i * channels + targetChannel) * bytesPerSample;

        let value: number;
        if (bitsPerSample === 8) {
            // 8-bit is unsigned
            value = (buffer.readUInt8(sampleOffset) - 128) / 128;
        } else if (bitsPerSample === 16) {
            value = buffer.readInt16LE(sampleOffset) / 32768;
        } else if (bitsPerSample === 24) {
            const byte1 = buffer.readUInt8(sampleOffset);
            const byte2 = buffer.readUInt8(sampleOffset + 1);
            const byte3 = buffer.readUInt8(sampleOffset + 2);
            const int24 = (byte3 << 16) | (byte2 << 8) | byte1;
            value = (int24 & 0x800000 ? int24 - 0x1000000 : int24) / 8388608;
        } else if (bitsPerSample === 32) {
            value = buffer.readInt32LE(sampleOffset) / 2147483648;
        } else {
            value = 0;
        }

        result[i] = value;
    }

    return result;
}

/**
 * Decode WAV buffer to AudioBuffer
 */
function decodeWav(buffer: Buffer): AudioBuffer {
    const header = parseWavHeader(buffer);

    if (!header) {
        throw new Error('Invalid or unsupported WAV file format');
    }

    // Fix for streamed WAV from ffmpeg: 
    // The data chunk size might be set to 0xFFFFFFFF or other placeholders because length wasn't known.
    // We strictly limit reading to the available buffer size.
    const maxDataSize = buffer.length - header.dataOffset;

    // If declared size is suspiciously large or larger than buffer, clamp it
    let safeDataSize = header.dataSize;
    if (safeDataSize > maxDataSize || safeDataSize === 0) {
        safeDataSize = maxDataSize;
    }

    // Convert to mono Float32Array (use left channel if stereo)
    const samples = pcmToFloat32(
        buffer,
        header.dataOffset,
        safeDataSize,
        header.bitsPerSample,
        header.channels,
        0 // Use first channel
    );

    return {
        samples,
        sampleRate: header.sampleRate,
        channels: header.channels
    };
}

/**
 * Load audio from WAV file
 */
export function loadWavFile(filePath: string): AudioBuffer {
    const buffer = fs.readFileSync(filePath);
    return decodeWav(buffer);
}

/**
 * Detect audio file type from extension
 */
function getAudioType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.wav':
            return 'wav';
        case '.mp3':
            return 'mp3';
        case '.ogg':
        case '.oga':
            return 'ogg';
        case '.flac':
            return 'flac';
        case '.m4a':
        case '.mp4':
            return 'm4a';
        default:
            return 'unknown';
    }
}

/**
 * Load audio file (supports multiple formats)
 * For non-WAV files, uses ffmpeg to convert to WAV
 */
export async function loadAudioFile(filePath: string): Promise<AudioBuffer> {
    const fileType = getAudioType(filePath);

    if (fileType === 'wav') {
        return loadWavFile(filePath);
    }

    return new Promise((resolve, reject) => {
        // Use ffmpeg to convert to WAV (PCM 16-bit, mono, keep sample rate or use standard?)
        // We'll trust the source sample rate but force mono and s16le for easier parsing
        const ffmpeg = spawn('ffmpeg', [
            '-i', filePath,
            '-f', 'wav',
            '-acodec', 'pcm_s16le',
            '-ac', '1',     // Force mono
            '-'             // Output to stdout
        ]);

        const chunks: Buffer[] = [];

        ffmpeg.stdout.on('data', (chunk) => {
            chunks.push(chunk);
        });

        ffmpeg.stderr.on('data', () => {
            // Consume stderr to prevent buffer full issues
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                try {
                    const fullBuffer = Buffer.concat(chunks);
                    const audioBuffer = decodeWav(fullBuffer);
                    resolve(audioBuffer);
                } catch (e) {
                    reject(e);
                }
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (err) => {
            reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Make sure ffmpeg is installed.`));
        });
    });
}

/**
 * Save Float32Array audio to WAV file
 */
export function saveWavFile(
    filePath: string,
    samples: Float32Array,
    sampleRate: number,
    bitsPerSample: number = 16
): void {
    const numChannels = 1;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = samples.length * bytesPerSample;
    const fileSize = 44 + dataSize;

    const buffer = Buffer.alloc(fileSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(fileSize - 8, 4);
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28); // byte rate
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // block align
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Write samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));

        if (bitsPerSample === 16) {
            buffer.writeInt16LE(Math.round(value * 32767), offset);
            offset += 2;
        } else if (bitsPerSample === 8) {
            buffer.writeUInt8(Math.round((value + 1) * 127.5), offset);
            offset += 1;
        }
    }

    fs.writeFileSync(filePath, buffer);
}

/**
 * Resample audio to a different sample rate
 * 
 * Uses windowed sinc interpolation for high-quality resampling.
 * Falls back to linear interpolation for very small rate changes.
 * 
 * @param samples Input audio samples
 * @param fromRate Source sample rate
 * @param toRate Target sample rate
 * @returns Resampled audio samples
 */
export function resampleAudio(
    samples: Float32Array,
    fromRate: number,
    toRate: number
): Float32Array {
    if (fromRate === toRate) {
        return samples;
    }

    const ratio = fromRate / toRate;
    const newLength = Math.floor(samples.length / ratio);
    const resampled = new Float32Array(newLength);

    // For small rate changes (< 5%), use linear interpolation (faster)
    if (Math.abs(ratio - 1.0) < 0.05) {
        for (let i = 0; i < newLength; i++) {
            const srcPos = i * ratio;
            const srcIndex = Math.floor(srcPos);
            const frac = srcPos - srcIndex;

            if (srcIndex + 1 < samples.length) {
                resampled[i] = samples[srcIndex] * (1 - frac) + samples[srcIndex + 1] * frac;
            } else {
                resampled[i] = samples[srcIndex] ?? 0;
            }
        }
        return resampled;
    }

    // Use windowed sinc interpolation for larger rate changes
    // This provides better quality for upsampling/downsampling
    const windowSize = 16; // Half-window size (total window = 2 * windowSize + 1)

    // Precompute sinc window coefficients
    const sincTable = new Float32Array(windowSize * 2 + 1);
    for (let i = 0; i <= windowSize * 2; i++) {
        const x = i - windowSize;
        if (x === 0) {
            sincTable[i] = 1.0;
        } else {
            // Lanczos window (sinc * sinc)
            const piX = Math.PI * x;
            const piXa = piX / windowSize;
            sincTable[i] = (Math.sin(piX) / piX) * (Math.sin(piXa) / piXa);
        }
    }

    // Resample with windowed sinc interpolation
    for (let i = 0; i < newLength; i++) {
        const srcPos = i * ratio;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        let sum = 0;
        let weightSum = 0;

        for (let j = -windowSize; j <= windowSize; j++) {
            const idx = srcIndex + j;
            if (idx >= 0 && idx < samples.length) {
                const offset = j - frac;
                // Interpolate sinc value
                const sincIdx = (offset + windowSize);
                const sincIdxFloor = Math.floor(sincIdx);
                const sincFrac = sincIdx - sincIdxFloor;

                let weight: number;
                if (sincIdxFloor >= 0 && sincIdxFloor < sincTable.length - 1) {
                    weight = sincTable[sincIdxFloor] * (1 - sincFrac) +
                        sincTable[sincIdxFloor + 1] * sincFrac;
                } else if (sincIdxFloor >= 0 && sincIdxFloor < sincTable.length) {
                    weight = sincTable[sincIdxFloor];
                } else {
                    weight = 0;
                }

                sum += samples[idx] * weight;
                weightSum += weight;
            }
        }

        resampled[i] = weightSum > 0 ? sum / weightSum : 0;
    }

    return resampled;
}
