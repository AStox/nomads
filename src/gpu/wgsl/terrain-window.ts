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

// A window moved by (dx, dy) cells of the face: the lattice's field (the stream mask's plane and the beds' plane, 16 texels a cell, then the fine planes, 4 vertices a cell) copied from
// the field the window had, each word from where the move puts it; a word whose source is outside is left 0, for the rectangles of the fine and raster kernels to make. SH: dx, dy.
// The threads fill a 4,096 groups wide sheet, so the 18 million words of a field fit the dispatch limits.
export const fieldShiftKernel = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> OLD: array<u32>;
@group(0) @binding(1) var<storage, read_write> NEW: array<u32>;
@group(0) @binding(2) var<storage, read> SH: array<i32>;
const RMW = ${L.RMW}u;
const RMR = ${RM / 4}u;
const MW = ${L.m}u;
const MV = ${L.MV}u;
const FINE_AT = ${L.FINE_AT}u;
const WORDS = ${L.FINE_WORDS}u;
@compute @workgroup_size(256)
fn shift(@builtin(global_invocation_id) gid: vec3u) {
  let w = gid.y * 1048576u + gid.x;
  if (w >= WORDS) { return; }
  let dx = SH[0]; let dy = SH[1];
  if (w < FINE_AT) {
    let p = w / RMW; let i = w % RMW;
    let c = i32(i % RMR) + 4i * dx; let r = i32(i / RMR) + ${RM / 256}i * dy;
    if (c < 0i || c >= i32(RMR) || r < 0i || r >= ${RM}i) { return; }
    NEW[w] = OLD[p * RMW + u32(r) * RMR + u32(c)];
    return;
  }
  let j = w - FINE_AT;
  let q = j / MV; let n = j % MV;
  let u = i32(n % MW) + 4i * dx; let v = i32(n / MW) + 4i * dy;
  if (u < 0i || u >= i32(MW) || v < 0i || v >= i32(MW)) { return; }
  NEW[w] = OLD[FINE_AT + q * MV + u32(v) * MW + u32(u)];
}
`;

// ---------- the ground as pages ----------
// A page is 64 by 64 cells of a face, made from the lattice a window's fine kernel leaves: its fine layers at 257 vertices a side (the edge shared with the next page, so a read
// of i and i + 1 stays inside one page), its light grid at 385 nodes a side (12.5 m, edge shared), its stream mask at 1,024 texels a side. Rows are turned as the window's are
// (row 0 is the lattice's last row of the page). A page's rows sit at 256 byte pitches so a page copies into a texture. The pages of a call share one window's field, whose cells
// are the page's cells and the halo the light grid's blur reads (16 nodes) and the lattice cubic (2 cells).
export const PAGE_CELLS = 64;
export const PAGE_NV = PAGE_CELLS * 4 + 1;
export const PAGE_NG = PAGE_CELLS * 6 + 1;
export const PAGE_MASK = PAGE_CELLS * 16;
export const PAGE_FINE_PITCH = Math.ceil((PAGE_NV * 4) / 256) * 64;
export const PAGE_FINE_LAYER_WORDS = PAGE_NV * PAGE_FINE_PITCH;
export const PAGE_FINE_WORDS = FINE_OUT_LAYERS * PAGE_FINE_LAYER_WORDS;
export const PAGE_GRID_PITCH = Math.ceil((PAGE_NG * 4) / 256) * 64;
export const PAGE_GRID_LAYER_WORDS = PAGE_NG * PAGE_GRID_PITCH;
export const PAGE_GRID_WORDS = GRID_LAYERS * PAGE_GRID_LAYER_WORDS;
export const PAGE_MASK_WORDS = (PAGE_MASK * PAGE_MASK) / 4;
// the nodes a page's blur reads beyond its edge, and the lattice vertices round the page its heights need (16 nodes of 12.5 m is 10.7 vertices of 18.75 m, a bilinear read and the
// slope's step a vertex more each)
export const PAGE_HALO_NODES = R;
export const PAGE_HALO_VERTS = 12;
// a page's scratch: the heights over the page and the halo, then the blur's first pass over the same rows
export const PAGE_HN = PAGE_NG + 2 * R;
export const PAGE_SCRATCH_LAYER_WORDS = PAGE_HN * PAGE_GRID_PITCH;
export const PAGE_PARAMS = 4;

// PG: per page its slot, its lattice corner (u, v) in the window's lattice, its place in this call. The window's cells of the page are at (u / 4, v / 4).
const pageCommon = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINE: array<i32>;
const MW = ${L.m}u;
const RM = ${RM}u;
const PGW = ${PAGE_PARAMS}u;
`;

// FINE: the field; OUT: the pages' fine layers, FINE_OUT_LAYERS of PAGE_NV rows at PAGE_FINE_PITCH words, a page after a page. As fineOut's, vertex by vertex: the page's vertex (c, r)
// is the lattice's (u + c, v + 256 - r). The vertices outside the window's crop (two before it and three after) are the lattice's own; the mask layer holds the mask texel above
// the vertex (fineOut reads the row before the vertex's), kept inside the plane.
export const pageFineKernel = (L: SceneryLayout) => /* wgsl */ `
${pageCommon(L)}
@group(0) @binding(1) var<storage, read_write> OUT: array<f32>;
@group(0) @binding(2) var<storage, read> PG: array<u32>;
const NV = ${PAGE_NV}u;
const PITCH = ${PAGE_FINE_PITCH}u;
const LAYER = ${PAGE_FINE_LAYER_WORDS}u;
const PAGEW = ${PAGE_FINE_WORDS}u;
fn maskAt(x: u32, y: u32) -> u32 {
  let t = y * RM + x;
  return (bitcast<u32>(FINE[t >> 2u]) >> ((t & 3u) * 8u)) & 255u;
}
@compute @workgroup_size(256)
fn pageFine(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= NV * NV) { return; }
  let p = gid.y * PGW;
  let c = n % NV; let r = n / NV;
  let u = PG[p + 1u] + c; let v = PG[p + 2u] + NV - 1u - r;
  let at = v * MW + u;
  let o = PG[p] * PAGEW + r * PITCH + c;
  OUT[o] = f32(FINE[${L.FF.h}u + at]) / 65536.0;
  OUT[LAYER + o] = f32(FINE[${L.FF.wet}u + at]) / 16777216.0;
  OUT[2u * LAYER + o] = f32(FINE[${L.FF.moist}u + at]) / 16777216.0;
  OUT[3u * LAYER + o] = f32(maskAt(min(4u * u, RM - 1u), max(4u * v, 1u) - 1u)) / 255.0;
  OUT[4u * LAYER + o] = f32(FINE[${L.FF.tree}u + at]) / 16777216.0;
  OUT[5u * LAYER + o] = f32(FINE[${L.FF.shrub}u + at]) / 16777216.0;
  OUT[6u * LAYER + o] = f32(FINE[${L.FF.grass}u + at]) / 16777216.0;
  OUT[7u * LAYER + o] = f32(FINE[${L.FF.marsh}u + at]) / 16777216.0;
  OUT[8u * LAYER + o] = f32(FINE[${L.FF.bare}u + at]) / 16777216.0;
  OUT[9u * LAYER + o] = f32(FINE[${L.FF.sand}u + at]) / 16777216.0;
}
`;

// The pages' stream masks as words of four texels, 256 a row of a page, rows turned: the page's row r is the plane's row 16 (cells down from the page's first) + 1,023 - r.
export const pageMaskKernel = (L: SceneryLayout) => /* wgsl */ `
${pageCommon(L)}
@group(0) @binding(1) var<storage, read_write> MASK: array<u32>;
@group(0) @binding(2) var<storage, read> PG: array<u32>;
const ROWW = ${RM / 4}u;
const PW = ${PAGE_MASK / 4}u;
const PAGEW = ${PAGE_MASK_WORDS}u;
@compute @workgroup_size(256)
fn pageMask(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= PAGEW) { return; }
  let p = gid.y * PGW;
  let r = n / PW; let c = n % PW;
  MASK[PG[p] * PAGEW + n] = bitcast<u32>(FINE[(4u * PG[p + 2u] + ${PAGE_MASK - 1}u - r) * ROWW + PG[p + 1u] + c]);
}
`;

// The pages' light grids. A page's node (a, b) is the window's node (6 cells' worth from the page's corner): i = 6 u / 4 + a across, j = 6 (256 - v / 4) - 6 * 64 + b down (the
// window's rows are turned). The heights are the window's (gridHeight's heightAt over the fine layer's heights, the coordinate held to the window's crop), kept for the page
// and 16 nodes round it in the scratch; the blur's two passes and the gradient read the scratch and stop at the window's own edge nodes (0 and GN - 1), as the window's do, so
// a page equals the rectangle of a window it lies in. A page less than 16 nodes (and the crop's 3) from the window's edge holds the window's edge there, not the planet's.
const pageGridCommon = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINEF: array<f32>;
@group(0) @binding(1) var<storage, read_write> GRID: array<f32>;
@group(0) @binding(2) var<storage, read_write> SCR: array<f32>;
@group(0) @binding(3) var<storage, read> PG: array<u32>;
const MW = ${L.m}u;
const PGW = ${PAGE_PARAMS}u;
const NG = ${PAGE_NG}u;
const HN = ${PAGE_HN}u;
const HALO = ${R}i;
const GPITCH = ${PAGE_GRID_PITCH}u;
const GLAYER = ${PAGE_GRID_LAYER_WORDS}u;
const GPAGE = ${PAGE_GRID_WORDS}u;
const SLAYER = ${PAGE_SCRATCH_LAYER_WORDS}u;
const WGN = ${GN}i;
// the page's node corner in the window's nodes, and the window's edge nodes in the page's
struct Pg { slot: u32, i0: i32, j0: i32, lx: i32, hx: i32, ly: i32, hy: i32, at: u32 }
fn pg(p: u32) -> Pg {
  let i0 = i32(PG[p + 1u]) * 3 / 2;
  let j0 = ${6 * 192}i - i32(PG[p + 2u]) * 3 / 2;
  return Pg(PG[p], i0, j0, -i0, WGN - 1i - i0, -j0, WGN - 1i - j0, PG[p + 3u]);
}
fn sat(q: Pg, l: u32, a: i32, b: i32) -> u32 { return q.at * 2u * SLAYER + l * SLAYER + u32(b + HALO) * GPITCH + u32(a + HALO); }
fn gat(q: Pg, l: u32, a: u32, b: u32) -> u32 { return q.slot * GPAGE + l * GLAYER + b * GPITCH + a; }
`;

// The window's heights as floats, fineOut's layer 0 alone (M rows at FINE_PITCH words), which the grid's heights read exactly as the window's grid reads its own.
export const pageHeightPlaneKernel = (L: SceneryLayout) => /* wgsl */ `
@group(0) @binding(0) var<storage, read> FINE: array<i32>;
@group(0) @binding(1) var<storage, read_write> OUT: array<f32>;
const MW = ${L.m}u;
const M = ${M}u;
@compute @workgroup_size(256)
fn pageHeights(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= M * M) { return; }
  let x = n % M; let y = n / M;
  OUT[y * ${FINE_PITCH}u + x] = f32(FINE[${L.FF.h}u + (MW - 3u - y) * MW + 2u + x]) / 65536.0;
}
`;
const pageHeightKernel = (L: SceneryLayout) => /* wgsl */ `
${pageGridCommon(L)}
const FPITCH = ${FINE_PITCH}u;
const HI = ${lit(M - 1.001)};
// A coordinate in thirds of a vertex (a node is 2 thirds of a vertex from the one before it): the vertex before it and the weight of the next, held to the crop as the window's heightAt
// holds it. A third is exact where the window's own division by 18.75 rounds in its own frame, so a node reads the same whichever window holds it.
struct Cd { u: u32, w: f32 }
fn cd(t: i32) -> Cd {
  if (t <= 0i) { return Cd(0u, 0.0); }
  if (t >= ${3 * (M - 1) }i) { return Cd(${M - 2}u, HI - ${lit(M - 2)}); }
  let u = t / 3i; let r = t - u * 3i;
  return Cd(u32(u), select(select(0.0, ${lit(Math.fround(1 / 3))}, r == 1i), ${lit(Math.fround(2 / 3))}, r == 2i));
}
fn ha(tx: i32, tz: i32) -> f32 {
  let p = cd(tx); let q = cd(tz);
  let i = q.u * FPITCH + p.u;
  return (FINEF[i] * (1.0 - p.w) + FINEF[i + 1u] * p.w) * (1.0 - q.w) + (FINEF[i + FPITCH] * (1.0 - p.w) + FINEF[i + FPITCH + 1u] * p.w) * q.w;
}
@compute @workgroup_size(256)
fn pageHeight(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= HN * HN) { return; }
  let q = pg(gid.y * PGW);
  let a = i32(n % HN) - HALO; let b = i32(n / HN) - HALO;
  let tx = 2i * (q.i0 + a - 3i); let tz = 2i * (q.j0 + b - 3i);
  let h = max(0.0, ha(tx, tz));
  SCR[sat(q, 0u, a, b)] = h;
  if (a < 0i || b < 0i || a >= i32(NG) || b >= i32(NG)) { return; }
  GRID[gat(q, 0u, u32(a), u32(b))] = h;
  GRID[gat(q, 2u, u32(a), u32(b))] = length(vec2<f32>(ha(tx + 3i, tz) - ha(tx - 3i, tz), ha(tx, tz + 3i) - ha(tx, tz - 3i))) / ${lit(2 * D)};
}
`;
// The entry points touch only some of the four buffers and dispatch binds them in order from 0, so each names them all (an auto layout keeps only the bindings an entry reads).
const pageBound = "_ = FINEF[0u]; _ = GRID[0u]; _ = SCR[0u]; _ = PG[0u];";
const pageFoldKernels = (L: SceneryLayout) => /* wgsl */ `
${pageGridCommon(L)}
// the heights' mean along a row over the 33 nodes round each, the page's columns of the scratch's rows
@compute @workgroup_size(256)
fn pageBlurX(@builtin(global_invocation_id) gid: vec3u) {
  ${pageBound}
  let n = gid.x;
  if (n >= NG * HN) { return; }
  let q = pg(gid.y * PGW);
  let a = i32(n % NG); let b = i32(n / NG) - HALO;
  let lo = max(q.lx, a - HALO); let hi = min(q.hx, a + HALO);
  var s = 0.0;
  for (var i = lo; i <= hi; i++) { s += SCR[sat(q, 0u, i, b)]; }
  SCR[sat(q, 1u, a, b)] = s / f32(hi - lo + 1i);
}
@compute @workgroup_size(256)
fn pageBlurY(@builtin(global_invocation_id) gid: vec3u) {
  ${pageBound}
  let n = gid.x;
  if (n >= NG * NG) { return; }
  let q = pg(gid.y * PGW);
  let a = i32(n % NG); let b = i32(n / NG);
  let lo = max(q.ly, b - HALO); let hi = min(q.hy, b + HALO);
  var s = 0.0;
  for (var j = lo; j <= hi; j++) { s += SCR[sat(q, 1u, a, j)]; }
  let mean = s / f32(hi - lo + 1i);
  GRID[gat(q, 1u, u32(a), u32(b))] = clamp((SCR[sat(q, 0u, a, b)] - mean) / 45.0, -1.0, 0.6);
}
@compute @workgroup_size(256)
fn pageGradient(@builtin(global_invocation_id) gid: vec3u) {
  ${pageBound}
  let n = gid.x;
  if (n >= NG * NG) { return; }
  let q = pg(gid.y * PGW);
  let i = i32(n % NG); let j = i32(n / NG);
  let hx = array<f32, 4>(SCR[sat(q, 0u, min(q.hx, i + 2i), j)], SCR[sat(q, 0u, min(q.hx, i + 1i), j)], SCR[sat(q, 0u, max(q.lx, i - 1i), j)], SCR[sat(q, 0u, max(q.lx, i - 2i), j)]);
  let hz = array<f32, 4>(SCR[sat(q, 0u, i, min(q.hy, j + 2i))], SCR[sat(q, 0u, i, min(q.hy, j + 1i))], SCR[sat(q, 0u, i, max(q.ly, j - 1i))], SCR[sat(q, 0u, i, max(q.ly, j - 2i))]);
  GRID[gat(q, 3u, u32(i), u32(j))] = (hx[0] + hx[1] - hx[2] - hx[3]) / ${lit(6 * GRID_STEP)};
  GRID[gat(q, 4u, u32(i), u32(j))] = (hz[0] + hz[1] - hz[2] - hz[3]) / ${lit(6 * GRID_STEP)};
}
`;
export const pageGridKernels = { height: pageHeightKernel, folds: pageFoldKernels };
