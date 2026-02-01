/**
 * Core TypeScript types and interfaces for the SSTV library
 */

/**
 * Color format enumeration for SSTV modes
 */
export enum ColorFormat {
    /** Standard RGB color */
    RGB = 'RGB',
    /** Green-Blue-Red order (Martin, Scottie modes) */
    GBR = 'GBR',
    /** YUV color space (Robot, PD modes) */
    YCrCb = 'YCrCb',
    /** Single-channel grayscale (Robot 8BW) */
    Grayscale = 'Grayscale'
}

/**
 * Chroma subsampling types for YCrCb modes
 * @see https://en.wikipedia.org/wiki/Chroma_subsampling
 */
export enum ChromaSubsampling {
    /** Full chroma (4:4:4 equivalent for RGB modes) */
    Full = '4:4:4',
    /** Half horizontal chroma (4:2:2) - Robot 72, PD modes */
    HalfHorizontal = '4:2:2',
    /** Half horizontal and vertical (4:2:0) - Robot 36 */
    Quarter = '4:2:0'
}

/**
 * SSTV Mode definition interface
 * 
 * All timing values are in seconds unless otherwise noted.
 */
export interface SSTVMode {
    /** Mode ID (VIS code, 0-127) */
    readonly id: number;
    /** Mode name (e.g., "Martin M1") */
    readonly name: string;
    /** Color format */
    readonly colorFormat: ColorFormat;
    /** Chroma subsampling */
    readonly chromaSubsampling: ChromaSubsampling;
    /** Image width in pixels */
    readonly width: number;
    /** Image height in pixels */
    readonly height: number;

    /** Sync pulse duration in seconds */
    readonly syncPulse: number;
    /** Sync porch duration in seconds */
    readonly syncPorch: number;

    /** Number of color channels/components (1-4) */
    readonly channelCount: number;
    /** Channel order (e.g., [0, 1, 2] for RGB or [1, 2, 0] for GBR) */
    readonly channelOrder: readonly number[];
    /** Scan time per channel in seconds */
    readonly scanTimes: readonly number[];
    /** Separator pulse durations in seconds */
    readonly separatorPulses: readonly number[];

    /** Total line time in seconds */
    readonly lineTime: number;
    /** Whether the first line has a special start sync */
    readonly hasStartSync: boolean;
    /** Channel index that contains sync (for Scottie modes where sync is mid-line) */
    readonly syncChannel?: number;
    /** Window factor for pixel sampling (window size = pixelTime * windowFactor) */
    readonly windowFactor: number;

    /**
     * Calculate the timing offset for a specific component
     * @param line - Line number (0-indexed)
     * @param channel - Channel index
     * @returns Offset in seconds from line start (or sync pulse for mid-sync modes)
     */
    getChannelOffset(line: number, channel: number): number;

    /**
     * Get the scan time for a specific channel and line
     * @param line - Line number (0-indexed)
     * @param channel - Channel index
     * @returns Scan duration in seconds
     */
    getScanTime(line: number, channel: number): number;
}

/**
 * Image data structure - 3D array [line][channel][pixel]
 * Each pixel value is 0-255 representing brightness or color component
 */
export type ImageData = readonly (readonly (readonly number[])[])[];

/**
 * Decoded SSTV image result
 */
export interface DecodedImage {
    /** Mode used for decoding */
    readonly mode: SSTVMode;
    /** Image data as 3D array [line][channel][pixel], values 0-255 */
    readonly data: ImageData;
    /** Image width in pixels */
    readonly width: number;
    /** Image height in pixels */
    readonly height: number;
    /** Lines successfully decoded (may be less than height for incomplete signals) */
    readonly linesDecoded: number;
    /** Slant correction factor applied (1.0 = no correction) */
    readonly slantCorrection: number;
}

/**
 * Events emitted by the streaming decoder
 */
export interface SSTVDecoderEvents {
    /** Emitted when searching for calibration header */
    'searching': (position: number) => void;

    /** Emitted when calibration header is found */
    'headerFound': (position: number) => void;

    /** Emitted when VIS code is decoded */
    'modeDetected': (mode: SSTVMode, visCode: number) => void;

    /** Emitted when starting to decode image data */
    'decodingStarted': (mode: SSTVMode) => void;

    /** Emitted for each decoded line */
    'lineDecoded': (line: number, data: number[][], partialImage: DecodedImage) => void;

    /** Emitted when decoding is complete */
    'decodingComplete': (image: DecodedImage) => void;

    /** Emitted on errors (continues if possible) */
    'error': (error: Error, recoverable: boolean) => void;

    /** Emitted for warning messages */
    'warning': (message: string) => void;

    /** Emitted when sync pulse is found (for slant correction) */
    'syncFound': (line: number, expectedTime: number, actualTime: number) => void;
}

/**
 * Decoder options
 */
export interface DecoderOptions {
    /** Sample rate of input audio (Hz) */
    sampleRate: number;

    /** Enable slant correction */
    enableSlantCorrection?: boolean;

    /** FFT size for frequency analysis */
    fftSize?: number;

    /** Frequency tolerance for sync detection (Hz) */
    syncTolerance?: number;

    /** Skip this many seconds at the start of audio */
    skip?: number;

    /** Specific VIS code to decode (skip auto-detection) */
    forceMode?: number | undefined;

    /** Allow lenient header detection for noisy signals (default: true) */
    lenientHeaderDetection?: boolean;
}

/**
 * Encoder options
 */
export interface EncoderOptions {
    /** Output sample rate (Hz) */
    sampleRate?: number;

    /** Mode to encode (use mode.id) */
    mode: number | SSTVMode;

    /** Add calibration header */
    addCalibrationHeader?: boolean;

    /** VOX tones before transmission */
    addVoxTones?: boolean;
}

/**
 * Audio samples with metadata
 */
export interface AudioBuffer {
    /** Audio samples (mono, normalized to -1.0 to 1.0) */
    readonly samples: Float32Array;
    /** Sample rate in Hz */
    readonly sampleRate: number;
    /** Number of channels (mono = 1, stereo = 2) - samples array is always mono */
    readonly channels: number;
}
