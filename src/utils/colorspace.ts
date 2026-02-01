/**
 * Color space conversion utilities
 */

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
 * Interpolate chroma values for 4:2:0 subsampling
 * Robot 36 standard: Even=V(red), Odd=U(blue)
 */
export function interpolateChroma(
    currentLine: number,
    height: number,
    chromaData: number[][][],
    width: number
): { u: number[], v: number[] } {
    const u = new Array(width);
    const v = new Array(width);

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
