// The stems' daily law in WGSL (src/gpu/flora.ts drives it; docs/research/plant-constants.md sec. 11). Every live
// stem of store kind "plant" (trees and bushes) is filed into the crown raster, then grows a day under its own light,
// is crowded out or starves, and carries its year's seed. All of it integer arithmetic, and no step depends on the
// order in which invocations run, so every GPU gives the same words.
//
// The crown raster: the island in texels of 18.75 m, four to a 75 m cell (the generator's quads, src/terrain/flora.ts),
// each texel's stems listed together in `list` from start[texel] to start[texel + 1], each entry three words: its slot,
// its height in mm times two plus 1 for a tree, and the ground its crown holds in a closed stand (flora.ts crownShare)
// as a Q16 share of the texel. Where in its texel's run a stem is filed depends on which invocation came first, so
// nothing reads that order: what is read of a texel is sums over all of it. Light at any height and the crown pass
// (wgsl/crowns.ts: the ground's light, interception and the renderer's canopy) read the same lists.
//
// A stem's light: the crowns of the stems taller than it in its texel, and half of those exactly as tall, taken as
// spread evenly over the texel, layer on layer, each layer letting UNDER_CROWN through (growth.ts), as deep as they lie
// (wgsl/crowns.ts layered): with c the cover above, n its whole layers and f the rest, (1 - f) T^n + f T^(n + 1).
//
// Crowding (trees only): the trees in a texel, the tallest first (ties by slot), each take their crown's share of a
// closed stand; a tree whose own share, with those of all taller, passes the texel is thinned out, the smallest first,
// as Reineke's maximum density and crown packing have it. A tree with none taller stands whatever its crown.
//
// Growth, from the day's coefficients for its cell and kind (alpha, beta; plants.ts stemDriver):
// - a tree's q = M^(1/4) (kg^(1/4) x 2^20) grows as dM/dt = c M^(3/4) times how its place does against the reference
//   open ground (plant-constants sec. 9), so q gains c/4 times that a day: alpha L - beta, L the light in Q16;
// - a bush's q is its mass against what it was laid at, ^(1/4) x 2^20 (2^20 as laid), changing by the plant rule's
//   relative rate, (alpha L - beta) in Q16 a day, a quarter of the mass's, and never past 2^20 [design: a grown shrub's
//   growth is a gap]; alpha and beta each under 2^16, so the product with q / 32 stays inside an i32.
// A stem whose mass falls to half the most it weighed (q under 2^(-1/4) of its peak: 55109 / 2^16) dies, as the
// seedlings' rule has it (wgsl/seedlings.ts). A tree's height follows its q through its kind's table; a bush keeps its size.
// A stem that dies keeps DIED in its crop word for the deadwood. Its year's seed (crop), in a good or mast year of its
// kind and none in the rest: its kind's crop a stem, plus its kind's crop a Q16 of texel times the share its crown holds.
import { CELL, N } from "../../terrain/grid";
import { CROWN_WORDS, LAYERED } from "./crowns";

// Texels across the island, their side in mm and their area in cm2 (the area only as a check of the Q16 shares).
export const TEXELS_SIDE = N * 4, TEXELS = TEXELS_SIDE * TEXELS_SIDE, TEXEL_MM = (CELL * 1000) / 4;
// Rows of the stems' tables: pine, oak, ash, aspen (trees), berry, hazel, heather (bushes), and a spare.
export const ROWS = 8, TREE_ROWS = 4;
// The height table: HQ entries a tree row, entry i the height in mm at q = i << QSTEP; the crown table: HC entries a
// row, entry i the crown's Q16 share of a texel at a height of i << SSTEP mm. Both read between entries.
export const HQ = 4096, QSTEP = 12, HC = 1024, SSTEP = 6;
// The rows buffer: the row of every SPECIES index (MAP words), then per row ROW_WORDS: tree (1 or 0), the most q its
// kind grows to, its crop a stem, its crop a Q16 of texel, and this year's mast (1 or 0).
export const MAP = 32, ROW_WORDS = 8, RW = { tree: 0, qmax: 1, each: 2, area: 3, mast: 4 } as const;
// The crop word a stem the law starves or crowds out is left with, so its death can be told from a felling: the
// deadwood's law (wgsl/deadwood.ts) bears its snag and consumes the mark.
export const DIED = 0xdead0001;
// A mass at half its peak: q at 2^(-1/4) of the peak's, in Q16 [derived].
export const HALF_Q = Math.round(2 ** -0.25 * 65536);
// A bush's q as laid, and what every q holds at most: 2^24 (a mass of 65,536 kg).
export const LAID = 1 << 20, QTOP = 1 << 24;

// The plant kind's layout as the kernels need it: its capacity and the word offset of each field's run.
export type StemLayout = { cap: number; x: number; y: number; what: number; size: number; q: number; peak: number; crop: number };

const FLAT = /* wgsl */ `fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

function common(k: StemLayout) {
  return /* wgsl */ `
const C = ${k.cap}u;
const FX = ${k.x}u; const FY = ${k.y}u; const FW = ${k.what}u; const FS = ${k.size}u; const FQ = ${k.q}u; const FP = ${k.peak}u; const FC = ${k.crop}u;
const SIDE = ${TEXELS_SIDE}u; const TMM = ${TEXEL_MM}u; const CMM = ${CELL * 1000}u; const NC = ${N}u;
const HQ = ${HQ}u; const QSTEP = ${QSTEP}u; const HC = ${HC}u; const SSTEP = ${SSTEP}u; const ROWS = ${ROWS}u;
const MAP = ${MAP}u; const RWS = ${ROW_WORDS}u;
${FLAT}
fn texel_of(i: u32) -> u32 { return min(b[FY + i] / TMM, SIDE - 1u) * SIDE + min(b[FX + i] / TMM, SIDE - 1u); }
fn row_of(i: u32) -> u32 { return rows[min(b[FW + i] >> 8u, MAP - 1u)]; }
fn rw(r: u32, w: u32) -> u32 { return rows[MAP + r * RWS + w]; }
// a tree's height in mm at q, read between the table's entries
fn height_at(r: u32, q: u32) -> u32 {
  let j = min(q >> QSTEP, HQ - 2u);
  let lo = tables[r * HQ + j];
  let hi = tables[r * HQ + j + 1u];
  let t = min(q - (j << QSTEP), 1u << QSTEP);
  return lo + (((hi - lo) * t) >> QSTEP);
}
// a crown's Q16 share of a texel at a height in mm, read between the table's entries
fn crown_at(r: u32, s: u32) -> u32 {
  let base = ${TREE_ROWS * HQ}u + r * HC;
  let j = min(s >> SSTEP, HC - 2u);
  let lo = tables[base + j];
  let hi = tables[base + j + 1u];
  let t = min(s - (j << SSTEP), 1u << SSTEP);
  return lo + (((hi - lo) * t) >> SSTEP);
}`;
}

// Once, when the generator's stems are written: a tree's q, the least whose height reaches the height it was laid at
// (so its height is exactly that), and its peak; a bush's both LAID. Bindings: body, tables, rows.
export function stemsInit(k: StemLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> tables: array<u32>;
@group(0) @binding(2) var<storage, read> rows: array<u32>;
${common(k)}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= C || (b[i] & 1u) == 0u) { return; }
  let r = row_of(i);
  var q = ${LAID}u;
  if (rw(r, ${RW.tree}u) == 1u) {
    let s = b[FS + i];
    var lo = 0u;
    var hi = rw(r, ${RW.qmax}u);
    while (lo < hi) {
      let mid = (lo + hi) >> 1u;
      if (height_at(r, mid) >= s) { hi = mid; } else { lo = mid + 1u; }
    }
    q = lo;
  }
  b[FQ + i] = q;
  b[FP + i] = q;
}`;
}

// The live stems of a workgroup's 256 slots that stand in one texel one after another in slot order (the generator lays
// a texel's stems together) form a run, counted and filed with one or two atomics rather than one a stem. Each lane
// puts its slot's texel in tex (NONE for a dead or missing slot); a run's first lane is its head, its last its end.
const RUNS = /* wgsl */ `
const NONE = 0xffffffffu;
var<workgroup> tex: array<u32, 256>;
fn mine(i: u32) -> u32 { if (i >= C || (b[i] & 1u) == 0u) { return NONE; } return texel_of(i); }
fn is_head(l: u32, t: u32) -> bool { return t != NONE && (l == 0u || tex[l - 1u] != t); }
fn is_end(l: u32, t: u32) -> bool { return t != NONE && (l == 255u || tex[l + 1u] != t); }`;

// The raster, step one: every live stem counted into its texel, each run adding its end's lane plus one and taking
// away its head's (so its length, the u32 sums wrapping back). Bindings: body, counts (TEXELS + 1, cleared), rows.
export function stemsCount(k: StemLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read_write> count: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> rows: array<u32>;
@group(0) @binding(3) var<storage, read> tables: array<u32>;
${common(k)}
${RUNS}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) l: u32) {
  let t = mine(flat(g, n));
  tex[l] = t;
  workgroupBarrier();
  var d = 0u;
  if (is_end(l, t)) { d = l + 1u; }
  if (is_head(l, t)) { d -= l; }
  if (d != 0u) { atomicAdd(&count[t], d); }
}`;
}

// The raster, step two: every live stem filed in its texel's run (the counts scanned into starts). Each lane finds its
// run's head by a running maximum of the heads' lanes (hd), and each run's end takes the run's places in one atomic.
// The same pass sums each texel's trees (every stem with the tree bit) into crowns, as wgsl/crowns.ts reads them
// (CROWN_WORDS a texel): the pines' and the other trees' crown shares (list word 2), the trees' weights and their
// weighted heights. Each run's four sums are added in workgroup memory and then to its texel's by the run's end, so a
// texel's trees are read without walking its list (u32 sums, the same in any order). Bindings: body, starts, cursors
// (TEXELS, cleared), list, tables, rows, crowns (CROWN_WORDS TEXELS, cleared).
export function stemsFile(k: StemLayout) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> start: array<u32>;
@group(0) @binding(2) var<storage, read_write> cursor: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> list: array<u32>;
@group(0) @binding(4) var<storage, read> tables: array<u32>;
@group(0) @binding(5) var<storage, read> rows: array<u32>;
@group(0) @binding(6) var<storage, read_write> crowns: array<atomic<u32>>;
${common(k)}
${RUNS}
var<workgroup> hd: array<u32, 256>;
var<workgroup> base: array<u32, 256>;
var<workgroup> sums: array<atomic<u32>, 1024>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u, @builtin(local_invocation_index) l: u32) {
  let i = flat(g, n);
  let t = mine(i);
  tex[l] = t;
  for (var w = 0u; w < 4u; w++) { atomicStore(&sums[4u * l + w], 0u); }
  workgroupBarrier();
  hd[l] = select(0u, l, is_head(l, t));
  for (var o = 1u; o < 256u; o <<= 1u) {
    workgroupBarrier();
    var v = hd[l];
    if (l >= o) { v = max(v, hd[l - o]); }
    workgroupBarrier();
    hd[l] = v;
  }
  workgroupBarrier();
  let h = hd[l];
  var r = 0u;
  var s = 0u;
  var a = 0u;
  var tree = 0u;
  if (t != NONE) {
    r = row_of(i);
    s = b[FS + i];
    a = crown_at(r, s);
    tree = rw(r, ${RW.tree}u);
    if (tree == 1u) {
      let k = (a >> 8u) + 1u;
      atomicAdd(&sums[4u * h + select(1u, 0u, r == 0u)], a);
      atomicAdd(&sums[4u * h + 2u], k);
      atomicAdd(&sums[4u * h + 3u], k * (((s << 1u) >> 1u) / 100u));
    }
  }
  workgroupBarrier();
  if (is_end(l, t)) {
    base[h] = start[t] + atomicAdd(&cursor[t], l + 1u - h);
    for (var w = 0u; w < 4u; w++) {
      let v = atomicLoad(&sums[4u * h + w]);
      if (v != 0u) { atomicAdd(&crowns[${CROWN_WORDS}u * t + w], v); }
    }
  }
  workgroupBarrier();
  if (t == NONE) { return; }
  let p = base[h] + (l - h);
  list[3u * p] = i;
  list[3u * p + 1u] = (s << 1u) | tree;
  list[3u * p + 2u] = a;
}`;
}

// The busy texels, step one: a 1 for every texel holding a stem, into flags (to be scanned). Bindings: starts, flags.
export const STEMS_BUSY = /* wgsl */ `
@group(0) @binding(0) var<storage, read> start: array<u32>;
@group(0) @binding(1) var<storage, read_write> flags: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t > ${TEXELS}u) { return; }
  var f = 0u;
  if (t < ${TEXELS}u && start[t + 1u] > start[t]) { f = 1u; }
  flags[t] = f;
}`;
// The busy texels, step two: each one's number at its place in the scanned flags (flags[TEXELS] their count).
// Bindings: starts, flags, busy.
export const STEMS_BUSY_LIST = /* wgsl */ `
@group(0) @binding(0) var<storage, read> start: array<u32>;
@group(0) @binding(1) var<storage, read> flags: array<u32>;
@group(0) @binding(2) var<storage, read_write> busy: array<u32>;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let t = flat(g, n);
  if (t >= ${TEXELS}u || start[t + 1u] == start[t]) { return; }
  busy[flags[t]] = t;
}`;

// A day of every live stem, a workgroup to a busy texel: its texel's run read through workgroup memory a tile at a
// time for light and crowding, growth from its cell's coefficients, death by starvation or crowding, height and crop.
// Bindings: body, starts, list, tables, rows, coefficients (i32 pairs by cell and row), flags (the busy count at
// TEXELS), busy.
// The tile and workgroup: small, so many texels' workgroups fit a compute unit's memory at once (measured on seed 1's
// stems, 23 a busy texel on average and 142 at most: 10 ms against 39 ms with tiles of 1,024).
export const GROW_TILE = 64, GROW_SIZE = 32;
export function stemsGrow(k: StemLayout, tile = GROW_TILE, size = GROW_SIZE) {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> start: array<u32>;
@group(0) @binding(2) var<storage, read> list: array<u32>;
@group(0) @binding(3) var<storage, read> tables: array<u32>;
@group(0) @binding(4) var<storage, read> rows: array<u32>;
@group(0) @binding(5) var<storage, read> coef: array<i32>;
@group(0) @binding(6) var<storage, read> flags: array<u32>;
@group(0) @binding(7) var<storage, read> busy: array<u32>;
${common(k)}
const TILE = ${tile}u; const WG = ${size}u;
var<workgroup> ts: array<u32, ${tile}>;
var<workgroup> tk: array<u32, ${tile}>;
var<workgroup> ta: array<u32, ${tile}>;
var<workgroup> wlo: u32;
var<workgroup> wn: u32;
@compute @workgroup_size(${size}) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let w = wid.x + wid.y * nwg.x;
  if (l == 0u) {
    wn = 0u;
    if (w < flags[${TEXELS}u]) { let t = busy[w]; wlo = start[t]; wn = start[t + 1u] - start[t]; }
  }
  let n = workgroupUniformLoad(&wn);
  let lo = workgroupUniformLoad(&wlo);
  for (var batch = 0u; batch < n; batch += WG) {
    let mine = batch + l;
    let have = mine < n;
    var i = 0u;
    var key = 0u;
    if (have) { i = list[3u * (lo + mine)]; key = list[3u * (lo + mine) + 1u]; }
    let s = key >> 1u;
    let tree = (key & 1u) == 1u;
    var above = 0u;
    var crowd = 0u;
    var taller = 0u;
    for (var c = 0u; c < n; c += TILE) {
      let m = min(TILE, n - c);
      for (var j = l; j < m; j += WG) { ts[j] = list[3u * (lo + c + j)]; tk[j] = list[3u * (lo + c + j) + 1u]; ta[j] = list[3u * (lo + c + j) + 2u]; }
      workgroupBarrier();
      if (have) {
        for (var j = 0u; j < m; j++) {
          let sj = ts[j];
          if (sj == i) { continue; }
          let hj = tk[j] >> 1u;
          let aj = ta[j];
          if (hj > s) { above += aj; } else if (hj == s) { above += aj >> 1u; }
          if (tree && (tk[j] & 1u) == 1u && (hj > s || (hj == s && sj < i))) { crowd += aj; taller += 1u; }
        }
      }
      workgroupBarrier();
    }
    if (have) { grow(i, s, tree, above, crowd, taller); }
  }
}
${LAYERED}
fn grow(i: u32, s: u32, tree: bool, above: u32, crowd: u32, taller: u32) {
  let r = row_of(i);
  let a = crown_at(r, s);
  let light = layered(above);
  let cell = min(b[FY + i] / CMM, NC - 1u) * NC + min(b[FX + i] / CMM, NC - 1u);
  let alpha = coef[(cell * ROWS + r) * 2u];
  let beta = coef[(cell * ROWS + r) * 2u + 1u];
  let gain = i32((u32(alpha) * light) >> 16u) - beta;
  let q = i32(b[FQ + i]);
  let qmax = i32(rw(r, ${RW.qmax}u));
  var nq = q + gain;
  if (!tree) { nq = q + ((i32(u32(q) >> 5u) * gain) >> 11u); }
  nq = clamp(nq, 0, qmax);
  let peak = max(b[FP + i], u32(nq));
  let starved = u32(nq) == 0u || u32(nq) < (((peak >> 8u) * ${HALF_Q}u) >> 8u);
  let crowded = tree && taller > 0u && crowd + a > 65536u;
  if (starved || crowded) { b[i] = b[i] & ~1u; b[FC + i] = ${DIED}u; return; }
  b[FQ + i] = u32(nq);
  b[FP + i] = peak;
  if (tree) { b[FS + i] = height_at(r, u32(nq)); }
  b[FC + i] = rw(r, ${RW.mast}u) * (rw(r, ${RW.each}u) + ((rw(r, ${RW.area}u) * a) >> 16u));
}`;
}

// What the CPU keeps of every stem after a day, as small as it can be: a stem's height in mm (no more than 0xffff)
// while it lives, 0 once dead. A slot of the generator's stems (below laid) holds its stem only at generation 1: one
// born in the slot later is another stem, so the generator's stays gone. Of the generator's stems, a bush keeps the
// height it was laid at (the law grows trees' heights only, and flora.ts lets no stem change its species), so of every
// generator's stem only whether it stands (a height not 0) comes back, a bit each in the first part; a tree's height
// comes back too, two to a word in the second part, in the order of the trees' slots (bound as trees); and every slot
// beyond the generator's, two to a word in the third part. The first part's workgroups take a slot a lane, 256 slots
// (eight words) each, so neighbouring lanes read neighbouring slots; the rest a word a lane. Bindings: body, trees
// (their slots), out (landWords; dispatched over its threads).
export function landWords(cap: number, laid: number, trees: number) {
  const bits = Math.ceil(laid / 32), tw = Math.ceil(trees / 2), sw = Math.ceil((cap - laid) / 2);
  return { bits, trees: tw, spare: sw, total: bits + tw + sw, threads: Math.ceil(bits / 8) * 256 + tw + sw };
}
export function stemsLand(k: StemLayout, laid: number, trees: number) {
  const L = landWords(k.cap, laid, trees);
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> b: array<u32>;
@group(0) @binding(1) var<storage, read> tree: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
const C = ${k.cap}u; const FS = ${k.size}u; const LAID = ${laid}u; const NT = ${trees}u;
const BITS = ${L.bits}u; const TW = ${L.trees}u; const SW = ${L.spare}u; const BG = ${Math.ceil(L.bits / 8)}u;
var<workgroup> bits: array<atomic<u32>, 8>;
fn kept(i: u32) -> u32 {
  if (i >= C) { return 0u; }
  if (select((b[i] & 1u) == 1u, b[i] == 3u, i < LAID)) { return min(b[FS + i], 0xffffu); }
  return 0u;
}
fn tree_kept(k: u32) -> u32 { if (k >= NT) { return 0u; } return kept(tree[k]); }
@compute @workgroup_size(256) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) l: u32) {
  let wg = wid.x + wid.y * nwg.x;
  if (wg < BG) {
    if (l < 8u) { atomicStore(&bits[l], 0u); }
    workgroupBarrier();
    let i = wg * 256u + l;
    if (i < LAID && kept(i) != 0u) { atomicOr(&bits[l / 32u], 1u << (l % 32u)); }
    workgroupBarrier();
    if (l < 8u && wg * 8u + l < BITS) { out[wg * 8u + l] = atomicLoad(&bits[l]); }
    return;
  }
  let w = BITS + (wg - BG) * 256u + l;
  if (w < BITS + TW) {
    let k = 2u * (w - BITS);
    out[w] = tree_kept(k) | (tree_kept(k + 1u) << 16u);
  } else if (w < BITS + TW + SW) {
    let i = LAID + 2u * (w - BITS - TW);
    out[w] = kept(i) | (kept(i + 1u) << 16u);
  }
}`;
}
