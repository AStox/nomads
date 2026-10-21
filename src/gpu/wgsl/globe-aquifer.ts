// The water table's relaxation over the whole tier as one grid (Unit 5b): the island's own step (terrain-water.ts `aq_cell_n`, with the plants' draw `gw_et` and everything they call, taken
// from the island's kernel text by name, so there is one law) applied to every cell in the order of aquifer.ts's four colours, the neighbours of a cell found from its place across tile and
// face edges as globe-regional.ts finds them (its `nbr`, taken from that text). The answer of a sweep is the same for any tiling of the work and any order of the cells of one colour.
//
// The state is packed to 14 words a cell (5.6 GB at tier 4) and the island's code reads it as the island's fields (GFIELDS, one i32 each) through `ld`:
//   A (read and write; 6 planes of one word a cell): head, fxv (the cap of a channel's head), sso (the cell's source), eaf (the plants' sink, 0 where there is none), meta, height (1/256 m: the
//       ground is 512 times it in Z)
//   B (read; 8 planes): ww, we, wn, ws (the weights of the west, east, south (y - 1) and north (y + 1) neighbours, the rest of 2^31 the cell's own: `wd`), the potential evaporation of two seasons to
//       a word (two u16 of 0.1 mm) twice, and the demand the soil leaves unmet the same
//   meta: isf (0 free, 1 fixed, 2 capped at fxv) in bits 0 and 1, the rock in 2 to 4, the drift in 5 to 7, the colour in 8 and 9, the root metre's fill by drift (Q16, 0 to 65536) from bit 10
// What is derived: the draw's four constants from the rock, drift and fill (`gw_params`), the draw's flag (eaf not 0), the unmet demand's sum, the summer's wet-ground term and `wd`.
import { EDGES } from "../globe/grid";
import { FIXED } from "./fixed";
import { constsOf, kernelsOf, planetWater, type WaterFormat } from "./terrain-water";
import { regionalWgsl } from "./globe-regional";

// The logical fields the island's functions read (the colour is the one this module adds).
export const GFIELDS = ["head", "isf", "fxv", "h", "ww", "we", "wn", "ws", "wd", "evk", "sso", "eaf", "evd", "evb", "eve", "evs", "evw", "evu", "sh0", "sh1", "sh2", "sh3", "pe0", "pe1", "pe2", "pe3", "col"] as const;
export const A_PLANES = ["head", "fxv", "sso", "eaf", "meta", "ht", "res"] as const;
export const B_PLANES = ["ww", "we", "wn", "ws", "pe01", "pe23", "sh01", "sh23"] as const;

// The top-level function called `name` of a WGSL text, to its closing brace.
function fnOf(src: string, name: string): string {
  const at = src.indexOf(`fn ${name}(`);
  if (at < 0) throw new Error(`globe-aquifer: no function ${name} in the water kernels`);
  let depth = 0, seen = false;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; } else if (src[i] === "}" && --depth === 0 && seen) return src.slice(at, i + 1);
  }
  throw new Error(`globe-aquifer: ${name} does not close`);
}
const lineOf = (src: string, start: string) => {
  const at = src.indexOf(start);
  if (at < 0) throw new Error(`globe-aquifer: no ${start} in the regional kernels`);
  return src.slice(at, src.indexOf("\n", at));
};
// The island's reads of its one buffer, as reads of the packed state: the head is plane 0 of A, every other field goes through `ld`.
const packed = (src: string) => src
  .replace(/F\[f_head \+ ([^\]]+)\] = /g, "A[$1] = ")
  .replace(/F\[f_head \+ ([^\]]+)\]/g, "A[$1]")
  .replace(/F\[(f_\w+) \+ ([^\]]+)\]/g, "ld($1, $2)");

export const globalFormat = (cells: number, omega?: number): WaterFormat => ({ ...planetWater(256), len: cells, omega });
// The over-relaxation of the global solve: 1.99, near the optimum 2 / (1 + sin(pi / N)) of a grid 2,048 to 4,096 wide (1.9 leaves the slowest mode an e-fold in 20,000 sweeps, 1.99 in 8,000 on real tier 3)
export const OMEGA = 1.99;
export function aquiferWgsl(tier: number, omega = OMEGA): string {
  const fn = 256 * 2 ** tier, cells = 6 * fn * fn, kernels = kernelsOf(globalFormat(cells, omega)), regional = regionalWgsl(EDGES, fn);
  const water = ["s64", "smul64", "sat32", "mulshr", "tenth_q16", "gw_params", "exp2n", "gw_frac", "reed_fit", "wet_extra", "gw_et", "aq_want_n", "aq_cap", "aq_cell_n"].map((n) => packed(fnOf(kernels, n)));
  const idx = (n: (typeof GFIELDS)[number]) => GFIELDS.indexOf(n);
  return /* wgsl */ `${FIXED}
${constsOf(globalFormat(cells, omega), GFIELDS)}
const FN = ${fn}u; const FNI = ${fn}i; const CELLS = ${fn * fn}u;
${lineOf(regional, "const EDGE_FACE")}
${lineOf(regional, "const EDGE_SIDE")}
${lineOf(regional, "const EDGE_FLIP")}
${lineOf(regional, "const DXY")}
${lineOf(regional, "const NONE")}
@group(0) @binding(0) var<storage, read_write> A: array<i32>;
@group(0) @binding(1) var<storage, read> B: array<i32>;
@group(0) @binding(2) var<storage, read_write> C: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> P: array<u32>;
${fnOf(regional, "nbr")}
fn cellmeta(i: u32) -> u32 { return bitcast<u32>(A[${A_PLANES.indexOf("meta")}u * LEN + i]); }
fn two(p: u32, s: u32, i: u32) -> u32 { return (bitcast<u32>(B[p * LEN + i]) >> (16u * (s & 1u))) & 0xffffu; }
fn pe_s(s: u32, i: u32) -> i32 { return tenth_q16(two(${B_PLANES.indexOf("pe01")}u + s / 2u, s, i)); }
fn sh_s(s: u32, i: u32) -> i32 { return tenth_q16(two(${B_PLANES.indexOf("sh01")}u + s / 2u, s, i)); }
fn w4(p: u32, i: u32) -> i32 { return B[p * LEN + i]; }
// the island's field f (an offset of LEN words a field) of cell i
fn ld(f: u32, i: u32) -> i32 {
  let q = f / LEN;
  let m = cellmeta(i);
  switch (q) {
    case ${idx("head")}u: { return A[i]; }
    case ${idx("isf")}u: { return i32(m & 3u); }
    case ${idx("fxv")}u: { return A[${A_PLANES.indexOf("fxv")}u * LEN + i]; }
    case ${idx("h")}u: { return A[${A_PLANES.indexOf("ht")}u * LEN + i] * 512i; }
    case ${idx("ww")}u, ${idx("we")}u, ${idx("wn")}u, ${idx("ws")}u: { return w4(q - ${idx("ww")}u, i); }
    case ${idx("wd")}u: { return bitcast<i32>(0x80000000u - bitcast<u32>(w4(0u, i) + w4(1u, i) + w4(2u, i) + w4(3u, i))); }
    case ${idx("evk")}u: { return select(0i, 1i, A[${A_PLANES.indexOf("eaf")}u * LEN + i] != 0i); }
    case ${idx("sso")}u: { return A[${A_PLANES.indexOf("sso")}u * LEN + i]; }
    case ${idx("eaf")}u: { return A[${A_PLANES.indexOf("eaf")}u * LEN + i]; }
    case ${idx("evd")}u, ${idx("evb")}u, ${idx("eve")}u, ${idx("evs")}u: { return gw_params((m >> 2u) & 7u, (m >> 5u) & 7u, i32(m >> 10u), q - ${idx("evd")}u); }
    case ${idx("evw")}u: { return qmul(KC_X, pe_s(SUMMER, i)); }
    case ${idx("evu")}u: { return sh_s(0u, i) + sh_s(1u, i) + sh_s(2u, i) + sh_s(3u, i); }
    case ${idx("sh0")}u, ${idx("sh1")}u, ${idx("sh2")}u, ${idx("sh3")}u: { return sh_s(q - ${idx("sh0")}u, i); }
    case ${idx("pe0")}u, ${idx("pe1")}u, ${idx("pe2")}u, ${idx("pe3")}u: { return pe_s(q - ${idx("pe0")}u, i); }
    default: { return i32((m >> 8u) & 3u); }
  }
}
fn gi(f: u32, i: u32) -> i32 { return ld(f, i); }
fn gu(f: u32, i: u32) -> u32 { return bitcast<u32>(ld(f, i)); }
fn gs(f: u32, s: u32, i: u32) -> i32 { return ld(f + s * LEN, i); }
${water.join("\n")}
// P[0] the colour to move, P[1] the word of C to keep the largest change in, P[2] 1 to visit the cells from the last to the first (the answer is the same: a colour's cells do not read each other)
@compute @workgroup_size(256)
fn aqg(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  _ = arrayLength(&A); _ = arrayLength(&B); _ = arrayLength(&C); _ = arrayLength(&P);
  let k0 = gid.x + gid.y * nwg.x * 256u;
  if (k0 >= LEN) { return; }
  let k = select(k0, LEN - 1u - k0, P[2] == 1u);
  if (((cellmeta(k) >> 8u) & 3u) != P[0]) { return; }
  let d0 = gi(f_h, k) - A[k];
  let c = aq_cell_n(k, nbr(k, 2u), nbr(k, 0u), nbr(k, 3u), nbr(k, 1u));
  if (c != 0u) { atomicMax(&C[P[1]], c); if (d0 < ${8 * 2 ** 17}i) { atomicMax(&C[2u + P[1]], c); } }
}
// the residual of each cell, in the head's unit: how far a pure Gauss-Seidel step would move it (0 for a fixed cell), into the plane res; C[0] keeps the greatest residual of the cells within 8 m of
// the ground (C[1]: of all)
@compute @workgroup_size(256)
fn aqres(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  _ = arrayLength(&A); _ = arrayLength(&B); _ = arrayLength(&C); _ = arrayLength(&P);
  let k = gid.x + gid.y * nwg.x * 256u;
  if (k >= LEN) { return; }
  var d = 0i;
  if (ld(f_isf, k) != 1i) {
    let want = aq_want_n(k, nbr(k, 2u), nbr(k, 0u), nbr(k, 3u), nbr(k, 1u));
    d = min(want, aq_cap(k)) - A[k];
  }
  A[${A_PLANES.indexOf("res")}u * LEN + k] = d;
  if (d != 0i) { atomicMax(&C[1u], u32(abs(d))); if (gi(f_h, k) - A[k] < ${8 * 2 ** 17}i) { atomicMax(&C[0u], u32(abs(d))); } }
}
// a correction (the plane res) added to the heads, none above a cap and none to a fixed cell
@compute @workgroup_size(256)
fn aqcorr(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  _ = arrayLength(&A); _ = arrayLength(&B); _ = arrayLength(&C); _ = arrayLength(&P);
  let k = gid.x + gid.y * nwg.x * 256u;
  if (k >= LEN) { return; }
  if (ld(f_isf, k) == 1i) { return; }
  A[k] = min(aq_cap(k), A[k] + A[${A_PLANES.indexOf("res")}u * LEN + k]);
}
`;
}
