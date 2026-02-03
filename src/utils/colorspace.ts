/**
 * Color space conversion utilities
 * 
 * Provides both allocating and in-place conversion methods.
 * Use in-place methods in hot paths for better performance.
 */

// Pre-allocated result arrays for in-place conversion (thread-local style)
// These are reused to avoid allocation in tight loops
const _rgbResult = new Uint8Array(3);
const _yuvResult = new Uint8Array(3);

/**
 * Convert RGB to YCrCb (ITU-R BT.601)
 * Used for Robot and PD modes
 */
export function rgbToYCrCb(r: number, g: number, b: number): [number, number, number] {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cr = (r - y) * 0.713 + 128;  // V = R - Y
    const cb = (b - y) * 0.564 + 128;  // U = B - Y

    return [
        Math.max(0, Math.min(255, Math.round(y))),
        Math.max(0, Math.min(255, Math.round(cr))),
        Math.max(0, Math.min(255, Math.round(cb)))
    ];
}

/**
 * Convert YCrCb to RGB (ITU-R BT.601)
 * Used for decoding Robot and PD modes
 */
export function yCrCbToRgb(y: number, cr: number, cb: number): [number, number, number] {
    const v = cr - 128;
    const u = cb - 128;

    const r = y + 1.402 * v;
    const g = y - 0.344136 * u - 0.714136 * v;
    const b = y + 1.772 * u;

    return [
        Math.max(0, Math.min(255, Math.round(r))),
        Math.max(0, Math.min(255, Math.round(g))),
        Math.max(0, Math.min(255, Math.round(b)))
    ];
}

/**
 * Alternative YUV conversion (used by Robot modes)
 * V = R - Y, U = B - Y
 * Outputs FULL RANGE [0-255] for transmission
 * The decoder will handle limited range conversion internally
 */
export function rgbToYUV(r: number, g: number, b: number): [number, number, number] {
    // Use Rec. 601 coefficients but output FULL RANGE for SSTV transmission
    // The frequency mapping is 0=1500Hz, 255=2300Hz
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = 0.713 * (r - y) + 128;  // V = Cr = R-Y
    const u = 0.564 * (b - y) + 128;  // U = Cb = B-Y

    return [
        Math.max(0, Math.min(255, Math.round(y))),
        Math.max(0, Math.min(255, Math.round(v))),
        Math.max(0, Math.min(255, Math.round(u)))
    ];
}

/**
 * Convert YUV to RGB (Robot mode style)
 * Uses Rec. 601 coefficients with FULL RANGE Y [0-255]
 * This matches the encoder's rgbToYUV which outputs full range.
 * Parameter order: Y, U, V
 */
export function yuvToRgb(y: number, u: number, v: number): [number, number, number] {
    const uOffset = u - 128;
    const vOffset = v - 128;

    const r = y + 1.402 * vOffset;
    const g = y - 0.344136 * uOffset - 0.714136 * vOffset;
    const b = y + 1.772 * uOffset;

    return [
        Math.max(0, Math.min(255, Math.round(r))),
        Math.max(0, Math.min(255, Math.round(g))),
        Math.max(0, Math.min(255, Math.round(b)))
    ];
}

/**
 * In-place YUV to RGB conversion for hot paths
 * Avoids tuple allocation overhead
 * 
 * @param y Y component (0-255)
 * @param u U component (0-255)
 * @param v V component (0-255)
 * @param output Output buffer (at least 3 bytes)
 * @param offset Starting offset in output buffer
 */
export function yuvToRgbInPlace(
    y: number,
    u: number,
    v: number,
    output: Uint8Array,
    offset: number = 0
): void {
    const uOffset = u - 128;
    const vOffset = v - 128;

    const r = y + 1.402 * vOffset;
    const g = y - 0.344136 * uOffset - 0.714136 * vOffset;
    const b = y + 1.772 * uOffset;

    output[offset] = Math.max(0, Math.min(255, Math.round(r)));
    output[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
    output[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
}

/**
 * In-place RGB to YUV conversion for hot paths
 */
export function rgbToYUVInPlace(
    r: number,
    g: number,
    b: number,
    output: Uint8Array,
    offset: number = 0
): void {
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = 0.713 * (r - y) + 128;
    const u = 0.564 * (b - y) + 128;

    output[offset] = Math.max(0, Math.min(255, Math.round(y)));
    output[offset + 1] = Math.max(0, Math.min(255, Math.round(v)));
    output[offset + 2] = Math.max(0, Math.min(255, Math.round(u)));
}

/**
 * Clamp value to byte range (0-255)
 */
export function clampByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Interpolate chroma values for 4:2:0 subsampling
 * Robot 36 standard: Even=V(red), Odd=U(blue)
 * 
 * @param currentLine - Current line being processed
 * @param height - Total image height
 * @param chromaData - Image data array [line][channel][pixel]
 * @param width - Image width in pixels
 * @returns Interpolated U and V chroma arrays for the current line
 */
export function interpolateChroma(
    currentLine: number,
    height: number,
    chromaData: readonly (readonly (readonly number[])[])[] | number[][][],
    width: number
): { u: number[], v: number[] } {
    const u = new Array<number>(width);
    const v = new Array<number>(width);

    // Determine the even/odd line pair
    const pairStart = currentLine - (currentLine % 2); // Round down to even
    const evenLine = pairStart;
    const oddLine = pairStart + 1;

    for (let x = 0; x < width; x++) {
        // V from even line (1500Hz separator - red chroma)
        if (evenLine < height) {
            v[x] = chromaData[evenLine][1][x];
        } else {
            v[x] = 128;
        }

        // U from odd line (2300Hz separator - blue chroma)
        if (oddLine < height) {
            u[x] = chromaData[oddLine][1][x];
        } else {
            u[x] = 128;
        }
    }

    return { u, v };
}
