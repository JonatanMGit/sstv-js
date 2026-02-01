/**
 * SSTV-JS - Modular SSTV Encoder/Decoder Library
 * 
 * A production-ready TypeScript library for encoding and decoding
 * Slow-Scan Television (SSTV) images with streaming support.
 * 
 * @example
 * ```typescript
 * import { SSTVDecoder, loadWavFile } from 'sstv-js';
 * 
 * // Load audio file
 * const audio = loadWavFile('sstv-signal.wav');
 * 
 * // Create decoder with streaming events
 * const decoder = new SSTVDecoder(audio.samples, {
 *   sampleRate: audio.sampleRate,
 *   enableSlantCorrection: true
 * });
 * 
 * // Listen for line-by-line updates
 * decoder.on('lineDecoded', (line, data, partialImage) => {
 *   console.log(`Decoded line ${line + 1}`);
 * });
 * 
 * decoder.on('modeDetected', (mode) => {
 *   console.log(`Mode: ${mode.name}`);
 * });
 * 
 * // Decode the image
 * const image = await decoder.decode();
 * if (image) {
 *   const rgb = imageDataToRGB(image);
 *   // Use RGB data...
 * }
 * ```
 */

// Core decoder and encoder
export { SSTVDecoder, imageDataToRGB } from './decoder';
export { SSTVEncoder } from './encoder';

// Streaming decoder for real-time SDR applications
export {
    StreamingDecoder,
    StreamingDecoderOptions,
    StreamingDecoderEvents,
    DecoderState,
    LineEvent,
    ImageCompleteEvent,
    ModeDetectedEvent
} from './streaming-decoder';

// Types and interfaces
export {
    SSTVMode,
    DecodedImage,
    ImageData,
    DecoderOptions,
    EncoderOptions,
    AudioBuffer,
    ColorFormat,
    ChromaSubsampling,
    SSTVDecoderEvents
} from './types';

// Constants
export {
    FREQ_SYNC,
    FREQ_PORCH,
    FREQ_BLACK,
    FREQ_WHITE,
    FREQ_VIS_BIT0,
    FREQ_VIS_BIT1,
    FREQ_LEADER,
    pixelToFrequency,
    frequencyToPixel
} from './constants';

// Audio utilities
export {
    loadWavFile,
    loadAudioFile,
    saveWavFile,
    resampleAudio
} from './utils/audio';

// Mode registry
export {
    getModeByVIS,
    getSupportedVISCodes,
    getSupportedModes,
    MartinM1,
    MartinM2,
    ScottieS1,
    ScottieS2,
    ScottieDX,
    Robot36,
    Robot72,
    Robot8BW,
    WraaseSC2180,
    PD50,
    PD90,
    PD120,
    PD160,
    PD180,
    PD240,
    PD290
} from './modes';

// Color space utilities
export {
    rgbToYCrCb,
    yCrCbToRgb,
    rgbToYUV,
    yuvToRgb
} from './utils/colorspace';

// Frequency analysis
export {
    FrequencyAnalyzer,
    zeroCrossingRate
} from './utils/fft';

// DSP utilities (new FM demodulation)
export {
    Demodulator,
    SyncPulseWidth
} from './utils/demodulator';

export {
    Complex,
    Phasor,
    FrequencyModulation,
    ComplexConvolution,
    SimpleMovingAverage,
    SchmittTrigger
} from './utils/dsp';
