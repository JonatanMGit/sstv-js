/**
 * SSTV protocol constants based on the specification
 */

/** Sync pulse frequency (Hz) */
export const FREQ_SYNC = 1200;

/** Porch/gap frequency (Hz) */
export const FREQ_PORCH = 1500;

/** Video black (0%) frequency (Hz) */
export const FREQ_BLACK = 1500;

/** Video white (100%) frequency (Hz) */
export const FREQ_WHITE = 2300;

/** VIS digital "1" frequency (Hz) */
export const FREQ_VIS_BIT1 = 1100;

/** VIS digital "0" frequency (Hz) */
export const FREQ_VIS_BIT0 = 1300;

/** Leader tone frequency (Hz) */
export const FREQ_LEADER = 1900;

/** VIS start bit frequency (Hz) */
export const FREQ_VIS_START = 1200;

/** Porch frequency used in Robot modes */
export const FREQ_PORCH_ROBOT = 1500;

/** Separator frequency for even lines in Robot 36 */
export const FREQ_SEPARATOR_EVEN = 1500;

/** Separator frequency for odd lines in Robot 36 */
export const FREQ_SEPARATOR_ODD = 2300;

/** Separator frequency in Robot 72 */
export const FREQ_SEPARATOR_ROBOT72_1 = 1500;
export const FREQ_SEPARATOR_ROBOT72_2 = 2300;

/**
 * Calibration header timing (seconds)
 */
export const CALIB_LEADER_1 = 0.3;      // First leader tone
export const CALIB_BREAK = 0.01;         // Break
export const CALIB_LEADER_2 = 0.3;       // Second leader tone
export const CALIB_VIS_START = 0.03;     // VIS start bit

/** Total calibration header duration (before VIS data) */
export const CALIB_HEADER_DURATION = CALIB_LEADER_1 + CALIB_BREAK + CALIB_LEADER_2 + CALIB_VIS_START;

/**
 * VIS code timing
 */
export const VIS_BIT_DURATION = 0.03;    // 30ms per bit
export const VIS_DATA_BITS = 8;          // 8 data bits (7 data + 1 parity)
export const VIS_STOP_BIT_DURATION = 0.03;

/** Total VIS code duration */
export const VIS_CODE_DURATION = VIS_BIT_DURATION * (VIS_DATA_BITS + 1); // +1 for stop bit

/**
 * Pixel value to frequency conversion
 * F(Hz) = 1500 + (Value * 3.1372549)
 */
export const FREQ_RANGE = FREQ_WHITE - FREQ_BLACK;  // 800 Hz
export const PIXEL_TO_FREQ_FACTOR = FREQ_RANGE / 255;  // 3.1372549

/**
 * Convert pixel value (0-255) to frequency (Hz)
 */
export function pixelToFrequency(value: number): number {
    return FREQ_BLACK + (value * PIXEL_TO_FREQ_FACTOR);
}

/**
 * Convert frequency (Hz) to pixel value (0-255)
 */
export function frequencyToPixel(freq: number): number {
    const value = (freq - FREQ_BLACK) / PIXEL_TO_FREQ_FACTOR;
    return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Default FFT size for frequency analysis
 */
export const DEFAULT_FFT_SIZE = 4096;

/**
 * Default sample rate
 */
export const DEFAULT_SAMPLE_RATE = 48000;

/**
 * Frequency tolerance for sync detection (Hz)
 */
export const DEFAULT_SYNC_TOLERANCE = 50;

/**
 * Window size for header search (seconds)
 */
export const HEADER_SEARCH_WINDOW = 0.01;

/**
 * Jump interval when searching for header (seconds)
 */
export const HEADER_SEARCH_JUMP = 0.002;
