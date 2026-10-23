// What the page's painter reads of a window of the planet's ground, made on the GPU from the fine kernel's integer lattice and the stream mask, in the
// units and layout `packGround` (demo/styles/isopixel/ground.wgsl.js) and main.js give them, and never read back but for the heights: the ten fine layers
// as floats (the lattice cropped to the island's 1,021 by 1,021 and turned so z runs south), the stream mask with its rows turned, and the 12.5 m light grid
// (heights, the share of the sky the folds hide, slope, and the heights' gradient for the light). Rows are padded to 256 bytes so a buffer copies into a texture.
// Every kernel reads a rectangle's worth of one source (the fine kernel's buffer of a window's lattice), so a tile of the lattice is run by the same text.
import { M, RM, SIZE, START, STEP } from "../../terrain/flora";
import type { SceneryLayout } from "./terrain-scenery";

export const GRID_STEP = 12.5;
export const GN = Math.ceil(SIZE / GRID_STEP) + 1;
// words in a padded row of the fine layers and of the light grid's layers
export const FINE_PITCH = Math.ceil((M * 4) / 256) * 64;
export const GRID_PITCH = Math.ceil((GN * 4) / 256) * 64;
export const FINE_OUT_LAYERS = 10;
// h, folds, slope, gradient x, gradient z
export const GRID_LAYERS = 5;
export const FINE_LAYER_WORDS = M * FINE_PITCH, GRID_LAYER_WORDS = GN * GRID_PITCH;
const R = 16, D = 18.75;
const lit = (v: number) => { const s = String(Math.fround(v)); return /[.e]/.test(s) ? s : `${s}.0`; };

// FINE: the fine kernel's buffer; OUT: the layers as floats at FINE_PITCH words a row.
export const fineOutKernel = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINE: array<i32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<f32>;
const MW = ${L.m}u;
const MV = ${L.MV}u;
const M = ${M}u;
const RM = ${RM}u;
const PITCH = ${FINE_PITCH}u;
const LAYER = ${FINE_LAYER_WORDS}u;
fn maskAt(x: u32, y: u32) -> u32 {
  // the plane's rows are the lattice's, the window's are turned: row r of the window is row RM - 1 - r of the plane
  let t = (RM - 1u - y) * RM + x;
  return (bitcast<u32>(FINE[t >> 2u]) >> ((t & 3u) * 8u)) & 255u;
}
@compute @workgroup_size(256)
fn fineOut(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= M * M) { return; }
  let x = n % M; let y = n / M;
  // the window's vertex (x, y) is the lattice's (x + 2, MT - 3 - y), MT = ${L.m}
  let at = (MW - 3u - y) * MW + 2u + x;
  let o = y * PITCH + x;
  OUT[o] = f32(FINE[${L.FF.h}u + at]) / 65536.0;
  OUT[LAYER + o] = f32(FINE[${L.FF.wet}u + at]) / 16777216.0;
  OUT[2u * LAYER + o] = f32(FINE[${L.FF.moist}u + at]) / 16777216.0;
  OUT[3u * LAYER + o] = f32(maskAt(8u + 4u * x, 8u + 4u * y)) / 255.0;
  OUT[4u * LAYER + o] = f32(FINE[${L.FF.tree}u + at]) / 16777216.0;
  OUT[5u * LAYER + o] = f32(FINE[${L.FF.shrub}u + at]) / 16777216.0;
  OUT[6u * LAYER + o] = f32(FINE[${L.FF.grass}u + at]) / 16777216.0;
  OUT[7u * LAYER + o] = f32(FINE[${L.FF.marsh}u + at]) / 16777216.0;
  OUT[8u * LAYER + o] = f32(FINE[${L.FF.bare}u + at]) / 16777216.0;
  OUT[9u * LAYER + o] = f32(FINE[${L.FF.sand}u + at]) / 16777216.0;
}
`;

// The stream mask, its rows turned: MASK is words of four texels, RM / 4 a row.
export const maskOutKernel = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINE: array<i32>;
@group(0) @binding(1) var<storage, read_write> MASK: array<u32>;
const ROWW = ${RM / 4}u;
@compute @workgroup_size(256)
fn maskOut(@builtin(global_invocation_id) gid: vec3u) {
  let w = gid.x;
  if (w >= ${L.RMW}u) { return; }
  let r = w / ROWW; let c = w % ROWW;
  MASK[w] = bitcast<u32>(FINE[(${RM - 1}u - r) * ROWW + c]);
}
`;

// FINEF: the fine layers as floats (fineOut's). GRID: the light grid's layers at GRID_PITCH words a row; TOP: the highest height, as bits.
const gridSizes = /* wgsl */ `
const GN = ${GN}u;
const GPITCH = ${GRID_PITCH}u;
const GLAYER = ${GRID_LAYER_WORDS}u;
fn gat(L: u32, i: u32, j: u32) -> u32 { return L * GLAYER + j * GPITCH + i; }
`;
// heightAt of main.js and groundwin.js: the lattice read between its vertices, the coordinate held to [0, M - 1.001].
const gridHeightCommon = /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINEF: array<f32>;
@group(0) @binding(1) var<storage, read_write> GRID: array<f32>;
@group(0) @binding(2) var<storage, read_write> TOP: array<atomic<u32>>;
${gridSizes}
const M = ${M}u;
const FPITCH = ${FINE_PITCH}u;
fn ha(x: f32, z: f32) -> f32 {
  let hi = ${lit(M - 1.001)};
  let fu = min(hi, max(0.0, (x - (${lit(START)})) / ${lit(STEP)}));
  let fv = min(hi, max(0.0, (z - (${lit(START)})) / ${lit(STEP)}));
  let u = u32(floor(fu)); let v = u32(floor(fv));
  let a = fu - floor(fu); let b = fv - floor(fv);
  let i = v * FPITCH + u;
  return (FINEF[i] * (1.0 - a) + FINEF[i + 1u] * a) * (1.0 - b) + (FINEF[i + FPITCH] * (1.0 - a) + FINEF[i + FPITCH + 1u] * a) * b;
}
`;
const gridFoldCommon = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> GRID: array<f32>;
${gridSizes}
`;

// layer 0: the heights (never under 0), layer 2: the slope over 2 x 18.75 m.
export const gridHeightKernel = /* wgsl */ `
${gridHeightCommon}
@compute @workgroup_size(16, 16)
fn gridHeight(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GN || gid.y >= GN) { return; }
  let x = ${lit(-SIZE / 2)} + f32(gid.x) * ${lit(GRID_STEP)};
  let z = ${lit(-SIZE / 2)} + f32(gid.y) * ${lit(GRID_STEP)};
  let h = max(0.0, ha(x, z));
  GRID[gat(0u, gid.x, gid.y)] = h;
  GRID[gat(2u, gid.x, gid.y)] = length(vec2<f32>(ha(x + ${lit(D)}, z) - ha(x - ${lit(D)}, z), ha(x, z + ${lit(D)}) - ha(x, z - ${lit(D)}))) / ${lit(2 * D)};
  atomicMax(&TOP[0], bitcast<u32>(h));
}
`;

// The mean of the heights over the 33 by 33 cells round each (clipped at the edge), in two passes through layer 5 (the scratch, past the layers kept), then the
// share of the sky the folds hide: (height - mean) / 45 held to [-1, 0.6]. Layers 0 to 4 are kept; the scratch is layer 5.
export const gridFoldKernels = /* wgsl */ `
${gridFoldCommon}
@compute @workgroup_size(16, 16)
fn blurX(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GN || gid.y >= GN) { return; }
  let lo = max(0i, i32(gid.x) - ${R}i); let hi = min(i32(GN) - 1i, i32(gid.x) + ${R}i);
  var a = 0.0;
  for (var i = lo; i <= hi; i++) { a += GRID[gat(0u, u32(i), gid.y)]; }
  GRID[gat(5u, gid.x, gid.y)] = a / f32(hi - lo + 1i);
}
@compute @workgroup_size(16, 16)
fn blurY(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GN || gid.y >= GN) { return; }
  let lo = max(0i, i32(gid.y) - ${R}i); let hi = min(i32(GN) - 1i, i32(gid.y) + ${R}i);
  var a = 0.0;
  for (var j = lo; j <= hi; j++) { a += GRID[gat(5u, gid.x, u32(j))]; }
  let mean = a / f32(hi - lo + 1i);
  GRID[gat(1u, gid.x, gid.y)] = clamp((GRID[gat(0u, gid.x, gid.y)] - mean) / 45.0, -1.0, 0.6);
}
// the gradient of the heights for the light: over two steps each way, into layers 3 and 4
@compute @workgroup_size(16, 16)
fn gradient(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= GN || gid.y >= GN) { return; }
  let n = i32(GN) - 1i;
  let i = i32(gid.x); let j = i32(gid.y);
  let hx = array<f32, 4>(GRID[gat(0u, u32(min(n, i + 2i)), gid.y)], GRID[gat(0u, u32(min(n, i + 1i)), gid.y)], GRID[gat(0u, u32(max(0i, i - 1i)), gid.y)], GRID[gat(0u, u32(max(0i, i - 2i)), gid.y)]);
  let hz = array<f32, 4>(GRID[gat(0u, gid.x, u32(min(n, j + 2i)))], GRID[gat(0u, gid.x, u32(min(n, j + 1i)))], GRID[gat(0u, gid.x, u32(max(0i, j - 1i)))], GRID[gat(0u, gid.x, u32(max(0i, j - 2i)))]);
  GRID[gat(3u, gid.x, gid.y)] = (hx[0] + hx[1] - hx[2] - hx[3]) / ${lit(6 * GRID_STEP)};
  GRID[gat(4u, gid.x, gid.y)] = (hz[0] + hz[1] - hz[2] - hz[3]) / ${lit(6 * GRID_STEP)};
}
`;
export const GRID_SCRATCH_LAYERS = GRID_LAYERS + 1;
