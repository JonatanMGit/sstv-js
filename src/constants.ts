/**
 * SSTV protocol constants based on the specification
 * 
 * Reference: SSTV Handbook by Martin Bruchanov OK2MNM
 * 
 * All frequency values are in Hz, all timing values are in seconds
 * unless otherwise noted.
 */

// ============================================================================
// SSTV Frequency Constants (Hz)
// ============================================================================

/** Sync pulse frequency (Hz) - used for horizontal sync */
export const FREQ_SYNC = 1200 as const;

/** Porch/gap frequency (Hz) - black reference level */
export const FREQ_PORCH = 1500 as const;

/** Video black (0%) frequency (Hz) */
export const FREQ_BLACK = 1500 as const;

/** Video white (100%) frequency (Hz) */
export const FREQ_WHITE = 2300 as const;

/** VIS digital "1" frequency (Hz) */
export const FREQ_VIS_BIT1 = 1100 as const;

/** VIS digital "0" frequency (Hz) */
export const FREQ_VIS_BIT0 = 1300 as const;

/** Leader tone frequency (Hz) - calibration header */
export const FREQ_LEADER = 1900 as const;

/** VIS start bit frequency (Hz) - same as sync */
export const FREQ_VIS_START = 1200 as const;

/** Porch frequency used in Robot modes (Hz) */
export const FREQ_PORCH_ROBOT = 1500 as const;

/** Separator frequency for even lines in Robot 36 (Hz) */
export const FREQ_SEPARATOR_EVEN = 1500 as const;

/** Separator frequency for odd lines in Robot 36 (Hz) */
export const FREQ_SEPARATOR_ODD = 2300 as const;

/** Separator frequency in Robot 72 - before V channel (Hz) */
export const FREQ_SEPARATOR_ROBOT72_1 = 1500 as const;

/** Separator frequency in Robot 72 - before U channel (Hz) */
export const FREQ_SEPARATOR_ROBOT72_2 = 2300 as const;

// ============================================================================
// Calibration Header Timing (seconds)
// ============================================================================

/** First leader tone duration (seconds) */
export const CALIB_LEADER_1 = 0.3 as const;

/** Break duration between leader tones (seconds) */
export const CALIB_BREAK = 0.01 as const;

/** Second leader tone duration (seconds) */
export const CALIB_LEADER_2 = 0.3 as const;

/** VIS start bit duration (seconds) */
export const CALIB_VIS_START = 0.03 as const;

/** Total calibration header duration before VIS data (seconds) */
export const CALIB_HEADER_DURATION = CALIB_LEADER_1 + CALIB_BREAK + CALIB_LEADER_2 + CALIB_VIS_START;

// ============================================================================
// VIS Code Timing
// ============================================================================

/** Duration per VIS bit (seconds) - 30ms */
export const VIS_BIT_DURATION = 0.03 as const;

/** Number of VIS data bits (7 data + 1 parity) */
export const VIS_DATA_BITS = 8 as const;

/** VIS stop bit duration (seconds) */
export const VIS_STOP_BIT_DURATION = 0.03 as const;

/** Total VIS code duration including stop bit (seconds) */
export const VIS_CODE_DURATION = VIS_BIT_DURATION * (VIS_DATA_BITS + 1);

// ============================================================================
// Pixel-to-Frequency Conversion
// ============================================================================

/** Frequency range for video signal (Hz) - 800 Hz total */
export const FREQ_RANGE = FREQ_WHITE - FREQ_BLACK;

/** Factor to convert pixel value (0-255) to frequency offset */
export const PIXEL_TO_FREQ_FACTOR = FREQ_RANGE / 255;

/** Precomputed inverse factor for frequency to pixel conversion */
export const FREQ_TO_PIXEL_FACTOR = 255 / FREQ_RANGE;

/**
 * Convert pixel value (0-255) to frequency (Hz)
 * 
 * Formula: F(Hz) = 1500 + (Value * 800/255)
 * 
 * @param value Pixel brightness value (0-255, where 0=black, 255=white)
 * @returns Frequency in Hz (1500-2300)
 */
export function pixelToFrequency(value: number): number {
    return FREQ_BLACK + (value * PIXEL_TO_FREQ_FACTOR);
}

/**
 * Convert frequency (Hz) to pixel value (0-255)
 * 
 * Formula: Value = (F(Hz) - 1500) * 255/800
 * 
 * @param freq Frequency in Hz (1500-2300)
 * @returns Pixel brightness value (0-255)
 */
export function frequencyToPixel(freq: number): number {
    const value = (freq - FREQ_BLACK) * FREQ_TO_PIXEL_FACTOR;
    return Math.max(0, Math.min(255, Math.round(value)));
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Default FFT size for frequency analysis (power of 2) */
export const DEFAULT_FFT_SIZE = 4096 as const;

/** Default sample rate (Hz) - 48000 is recommended for better frequency resolution */
export const DEFAULT_SAMPLE_RATE = 48000 as const;

/** Frequency tolerance for sync detection (Hz) */
export const DEFAULT_SYNC_TOLERANCE = 50 as const;

/** Window size for header search (seconds) */
export const HEADER_SEARCH_WINDOW = 0.01 as const;

/** Jump interval when searching for header (seconds) */
export const HEADER_SEARCH_JUMP = 0.002 as const;

// ============================================================================
// Type Definitions for Strict Typing
// ============================================================================

/** Valid VIS code type */
export type VISCode = number;

/** Frequency in Hz */
export type FrequencyHz = number;

/** Duration in seconds */
export type DurationSeconds = number;
