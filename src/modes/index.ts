/**
 * Mode registry - maps VIS codes to mode implementations
 */

import { SSTVMode } from '../types';
import { MartinM1 } from './martin-m1';
import { MartinM2 } from './martin-m2';
import { ScottieS1 } from './scottie-s1';
import { ScottieS2 } from './scottie-s2';
import { ScottieDX } from './scottie-dx';
import { Robot36 } from './robot-36';
import { Robot72 } from './robot-72';
import { Robot8BW } from './robot-8bw';
import { WraaseSC2180 } from './wraase-sc2-180';
import { PD50, PD90, PD120, PD160, PD180, PD240, PD290 } from './pd-modes';

/**
 * Registry of all supported SSTV modes
 */
export const MODE_REGISTRY: Map<number, () => SSTVMode> = new Map([
    // Martin modes
    [44, () => new MartinM1()],
    [40, () => new MartinM2()],

    // Scottie modes
    [60, () => new ScottieS1()],
    [56, () => new ScottieS2()],
    [76, () => new ScottieDX()],

    // Robot modes
    [8, () => new Robot36()],
    [12, () => new Robot72()],
    [2, () => new Robot8BW()],

    // Wraase mode
    [55, () => new WraaseSC2180()],

    // PD modes
    [93, () => new PD50()],
    [99, () => new PD90()],
    [95, () => new PD120()],
    [98, () => new PD160()],
    [96, () => new PD180()],
    [97, () => new PD240()],
    [94, () => new PD290()]
]);

/**
 * Get mode by VIS code
 */
export function getModeByVIS(visCode: number): SSTVMode | null {
    const factory = MODE_REGISTRY.get(visCode);
    return factory ? factory() : null;
}

/**
 * Get all supported VIS codes
 */
export function getSupportedVISCodes(): number[] {
    return Array.from(MODE_REGISTRY.keys());
}

/**
 * Get all supported mode names
 */
export function getSupportedModes(): Array<{ id: number; name: string }> {
    return Array.from(MODE_REGISTRY.entries()).map(([id, factory]) => {
        const mode = factory();
        return { id, name: mode.name };
    });
}

/**
 * Get all mode instances
 */
export function getAllModes(): SSTVMode[] {
    return Array.from(MODE_REGISTRY.values()).map(factory => factory());
}

// Export all mode classes
export {
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
};
