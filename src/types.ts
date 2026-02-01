/**
 * Core TypeScript types and interfaces for the SSTV library
 */

/**
 * Color format enumeration
 */
export enum ColorFormat {
    RGB = 'RGB',
    GBR = 'GBR',  // Green-Blue-Red (Martin, Scottie)
    YCrCb = 'YCrCb', // YUV color space (Robot, PD)
    Grayscale = 'Grayscale'
}

/**
 * Chroma subsampling types
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
 */
export interface SSTVMode {
    /** Mode ID (VIS code) */
    id: number;
    /** Mode name (e.g., "Martin M1") */
    name: string;
    /** Color format */
    colorFormat: ColorFormat;
    /** Chroma subsampling */
    chromaSubsampling: ChromaSubsampling;
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;

    /** Sync pulse duration in seconds */
    syncPulse: number;
    /** Sync porch duration in seconds */
    syncPorch: number;

    /** Number of color channels/components */
    channelCount: number;
    /** Channel order (e.g., [0, 1, 2] for RGB or [1, 2, 0] for GBR) */
    channelOrder: number[];
    /** Scan time per channel in seconds */
    scanTimes: number[];
    /** Separator pulse durations in seconds */
    separatorPulses: number[];

    /** Total line time in seconds */
    lineTime: number;
    /** Whether the first line has a special start sync */
    hasStartSync: boolean;
    /** Channel index that contains sync (for Scottie modes) */
    syncChannel?: number;
    /** Window factor for pixel sampling (window size = pixelTime * windowFactor) */
    windowFactor: number;

    /**
     * Calculate the timing offset for a specific component
     * @param line Line number (0-indexed)
     * @param channel Channel index
     * @returns Offset in seconds from line start
     */
    getChannelOffset(line: number, channel: number): number;

    /**
     * Get the scan time for a specific channel and line
     * @param line Line number (0-indexed)
     * @param channel Channel index
     * @returns Scan duration in seconds
     */
    getScanTime(line: number, channel: number): number;
}

/**
 * Image data structure - 3D array [line][channel][pixel]
 */
export type ImageData = number[][][];

/**
 * Decoded SSTV image
 */
export interface DecodedImage {
    /** Mode used for decoding */
    mode: SSTVMode;
    /** Image data as 3D array [line][channel][pixel] */
    data: ImageData;
    /** Image width */
    width: number;
    /** Image height */
    height: number;
    /** Lines successfully decoded */
    linesDecoded: number;
    /** Slant correction factor applied (1.0 = no correction) */
    slantCorrection: number;
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
    /** Audio samples */
    samples: Float32Array;
    /** Sample rate */
    sampleRate: number;
    /** Number of channels (mono = 1, stereo = 2) */
    channels: number;
}
