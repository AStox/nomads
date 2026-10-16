// The crowns over the island, one raster for every law and the renderer (src/gpu/crowns.ts drives it; Unit 12 of
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md). Each day the stems' law files every live stem in its
// 18.75 m texel (wgsl/stems.ts, the crown raster: slot, height and the ground its crown holds in a closed stand as a Q16
// share of the texel); the crown pass sums the trees' crowns of each texel into the words everything else reads:
// - a texel word: the pines' crowns over it in its low half and the broadleaves' (oak, ash, aspen) in its high half,
//   each in layers as Q4.12 (a whole texel's worth of crown is 4096), at most 0xffff, nearly 16 layers [design: under
//   16 layers the light is 0.02^16 of the sky's, nothing a Q16 law can tell from none];
// - a cell word (75 m, the 16 texels of a cell together): the height of the trees' crowns, in decimetres, each tree
//   weighted by the ground its crown holds.
// Bushes stand under the trees' crowns and are left out of it: the ground's light, rain and wind under the trees are
// the crowns over a standing person's head (light.ts, rain.ts, air.ts). Each bush and tree still takes its own light
// from every crown taller than it in the stems' law.
//
// Light through crowns: layer on layer, each letting UNDER_CROWN through (terrain/growth.ts). The crowns of a texel are
// taken as spread evenly over it, so with c the cover in layers, n its whole layers and f the rest, the ground under n
// layers takes T^n and the share f of it under one more T^(n + 1): (1 - f) T^n + f T^(n + 1), with no cap on n
// [derived: Beer-Lambert through whole crowns, the stems' law's rule since Unit 7, its two-layer cap removed].
// Integer throughout: no step depends on invocation order, so every GPU gives the same words.
import { CELL, N } from "../../terrain/grid";
import { UNDER_CROWN } from "../../terrain/growth";

// One layer of crowns lets this Q16 share of the light through.
export const T1 = Math.round(UNDER_CROWN * 65536);
// Texels across the island and in all (wgsl/stems.ts's raster), cells, and the cell words' place after the texels'.
export const SIDE = N * 4, TEXELS = SIDE * SIDE, CELLS = N * N, CELL_AT = TEXELS;
export const WORDS = TEXELS + CELLS;
// Q4.12 layers: the texel words' scale against the raster's Q16 shares.
export const QSHIFT = 4, QMAX = 0xffff;

// The share (Q16) of what falls on crowns c deep (Q16 layers) that gets through when a layer lets t through (Q16, under
// 65536): t^n by n roundings of a Q16 product, then the share under one more. layered is the light's, t = T1. Shared by
// the stems', the seedlings' and every Unit 12 law (light, and the rain through crowns in wgsl/moisture.ts).
export const LAYERED = /* wgsl */ `
fn layered_by(c: u32, t: u32) -> u32 {
  let n = c >> 16u;
  let f = c & 0xffffu;
  var p = 65536u;
  for (var k = 0u; k < n && p != 0u; k++) { p = (p * t + 32768u) >> 16u; }
  if (f == 0u) { return p; }
  return (((65536u - f) * p) >> 16u) + ((f * ((p * t + 32768u) >> 16u)) >> 16u);
}
fn layered(c: u32) -> u32 { return layered_by(c, ${T1}u); }`;
// Their twins.
export function layeredBy(c: number, t: number): number {
  const n = Math.floor(c / 65536), f = c % 65536;
  let p = 65536;
  for (let k = 0; k < n && p !== 0; k++) p = Math.floor((p * t + 32768) / 65536);
  if (f === 0) return p;
  return Math.floor(((65536 - f) * p) / 65536) + Math.floor((f * Math.floor((p * t + 32768) / 65536)) / 65536);
}
export const layered = (c: number) => layeredBy(c, T1);

// The texel sums the stems' raster is filed with (wgsl/stems.ts stemsFile), CROWN_WORDS a texel, over its trees: the
// crown shares (Q16 of the texel) of its pines (row 0 of the stems' rows, by species) and of its other trees, the
// trees' weights k (a crown's share in 256ths of the texel, plus one, so a cell of small crowns still has a height),
// and the sum of k times each tree's height in decimetres. u32 sums: they stay inside a u32 (at most 257 x 6,553 dm a
// tree, a few thousand trees a cell).
export const CROWN_WORDS = 4;
// The crown pass: a lane a texel, sixteen cells to a workgroup, each texel's word from its sums, then each cell's
// sixteen lanes' weights added in workgroup memory for its word. Bindings: the raster's texel sums, words (WORDS).
// Dispatched over CELLS / 16 workgroups.
export function crownPass() {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> sums: array<u32>;
@group(0) @binding(1) var<storage, read_write> words: array<u32>;
var<workgroup> swh: array<u32, 256>;
var<workgroup> shw: array<u32, 256>;
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let c = (wid.x + wid.y * nwg.x) * 16u + (l >> 4u);
  let have = c < ${CELLS}u;
  var wh = 0u;
  var hw = 0u;
  if (have) {
    let t = ((c / ${N}u) * 4u + ((l & 15u) >> 2u)) * ${SIDE}u + (c % ${N}u) * 4u + (l & 3u);
    let at = ${CROWN_WORDS}u * t;
    wh = sums[at + 2u];
    hw = sums[at + 3u];
    words[t] = min(sums[at] >> ${QSHIFT}u, ${QMAX}u) | (min(sums[at + 1u] >> ${QSHIFT}u, ${QMAX}u) << 16u);
  }
  swh[l] = wh;
  shw[l] = hw;
  workgroupBarrier();
  if (have && (l & 15u) == 0u) {
    var w = 0u;
    var h = 0u;
    for (var k = 0u; k < 16u; k++) { w += swh[l + k]; h += shw[l + k]; }
    var m = 0u;
    if (w > 0u) { m = h / w; }
    words[${CELL_AT}u + c] = min(m, 0xffffu);
  }
}`;
}

// The texel of a place in millimetres, and its cell.
export const TEXEL_MM = (CELL * 1000) / 4;
export const texelAt = (x: number, y: number) => Math.min(Math.floor(y / TEXEL_MM), SIDE - 1) * SIDE + Math.min(Math.floor(x / TEXEL_MM), SIDE - 1);
export const cellAt = (x: number, y: number) => Math.min(Math.floor(y / (CELL * 1000)), N - 1) * N + Math.min(Math.floor(x / (CELL * 1000)), N - 1);
// WGSL accessors for a law binding the crown words as \`crowns\`: a place's texel and its cover in Q16 layers, all of
// it, the pines' and the broadleaves'.
export const CROWN_ACCESS = /* wgsl */ `
fn texel_at(x: u32, y: u32) -> u32 { return min(y / ${TEXEL_MM}u, ${SIDE - 1}u) * ${SIDE}u + min(x / ${TEXEL_MM}u, ${SIDE - 1}u); }
fn pine_cover(t: u32) -> u32 { return (crowns[t] & 0xffffu) << ${QSHIFT}u; }
fn broad_cover(t: u32) -> u32 { return (crowns[t] >> 16u) << ${QSHIFT}u; }
fn crown_cover(t: u32) -> u32 { return pine_cover(t) + broad_cover(t); }
fn crown_height_dm(cell: u32) -> u32 { return crowns[${CELL_AT}u + cell]; }`;
