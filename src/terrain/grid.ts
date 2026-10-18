// The island's simulation grid. How water finds its way downhill across it (the priority flood, receivers and drainage
// area) is on the GPU: src/gpu/wgsl/terrain-upstream.ts.
import { clamp } from "math";

export const N = 256; // cells per side
export const CELL = 75; // meters per cell
export const TILE_CELLS = 2; // cells per side of a game tile
export const LEN = N * N;

// 0 below lo, 1 above hi, smooth between.
export const ramp = (v: number, lo: number, hi: number) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };
