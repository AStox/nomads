// Deadwood and clasts in WGSL (src/gpu/deadwood.ts drives these and holds their TypeScript twins; the constants are
// docs/research/plant-constants.md sec. 12's). Every kernel is integer arithmetic and no step depends on the order in
// which invocations run, so every GPU gives the same words.
//
// The laws, as every kernel here and every twin reads them:
// - Rot. Each cell's hourly rot is ROT units under a closed canopy and more as it opens, ROT (1 + GAP_GAIN open) with
//   open the share of the cell no tree crown covers, recorded as the driver channel "rot" (tiers/drivers.ts). A piece's
//   decay is the rot over its cell since its birth, I (an exact integral of the channel), times its class's rate.
// - Survival. A piece of rate K (K40: per rot unit, times 2^40) has Lambda = I K40 / 2^40 (Q16.16) and lies on while
//   the top 16 bits of its own uniform word u stay below qexp(-Lambda): each piece lasts an exponential time of its
//   class's rate, the whole piece going at once, so a class's pool holds input / rate [derived].
// - A snag stands while the top 16 bits of its word uf stay below qexp(-age fr / 2^24), fr its fall rate per hour
//   (times 2^40), and is a log from then on; fr 0 is a piece lying from its birth.
// - A stick bin is one cell's litterfall of one birth hour: n sticks, member k drawn from the stream (seed, STICK,
//   cell + k 2^16, born): its place in the cell, then u.
// - A clast is member k of its cell's count (tiers/dormant.ts StaticDormant): the count split in half 8 times, along x
//   and then y, by exact Bin(n, 1/2) draws (rand.ts binhalf) on the stream (seed, stream + 1, cell, node), so member k
//   lies in one of 16 x 16 squares of the cell, the members of a square being a run of k; its place in the square and
//   its diameter, by the truncated power law N(> d) ~ d^-DIM between its class's bounds, from (seed, stream, k, cell).
import { N } from "../../terrain/grid";
import { CTL, type Layout, access } from "./alloc";
import { type DriverLayout, drvAccess } from "./drivers";
import { CELLS, CELL_MM } from "./index";
import { FIXED } from "./fixed";
import { RAND } from "./rand";
import { DIED, TEXELS, TEXELS_SIDE, TEXEL_MM } from "./stems";
import { CROWN_WORDS } from "./crowns";

// What the WGSL is given of the constants (src/gpu/deadwood.ts sets them): the seed and streams, the rot's scale and
// gain, every class's K40 and the snags' fall, by SPECIES index.
export type DeadLaw = {
  seed: number; rot: number; gain: number; stick: number; logK: readonly number[]; fallK: readonly number[];
  snagQ: number; litter: number; pool: number; rows: readonly number[];
};
export const STICK_STREAM = 0x5761, LOG_STREAM = 0x106, POOL_STREAM = 0x9001, LITTER_STREAM = 0x117;

const FLAT = /* wgsl */ `fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }`;

// The shared fixed-point law (needs FIXED ahead of it): Lambda in Q16.16 from an integral and a K40, saturating;
// survival of a word under it; a snag's standing; the constants. A log's birth takes it as its helpers.
export function common(L: DeadLaw) {
  return /* wgsl */ `
const SEED = ${L.seed >>> 0}u;
const ROT = ${L.rot}u;
const KSTICK = ${L.stick}u;
const KLOG = array<u32, 32>(${pad(L.logK)});
const KFALL = array<u32, 32>(${pad(L.fallK)});
const TREE_ROW = array<u32, 32>(${Array.from({ length: 32 }, (_, i) => `${L.rows[i] ?? 4}u`).join(", ")});
fn lam(i: u32, k: u32) -> i32 {
  let p = mul64(i, k);
  if (p.y >= 0x800000u) { return 0x7fffffffi; }
  return bitcast<i32>((p.x >> 24u) | (p.y << 8u));
}
fn lasts(u: u32, l: i32) -> bool { return (u >> 16u) < bitcast<u32>(qexp(-l)); }
fn standing(uf: u32, fr: u32, age: u32) -> bool { return fr != 0u && lasts(uf, lam(age, fr)); }`;
}
const pad = (a: readonly number[]) => Array.from({ length: 32 }, (_, i) => `${(a[i] ?? 0) >>> 0}u`).join(", ");

// A log's state at an hour: 0 gone, 1 a snag, 2 a log. The twin is src/gpu/deadwood.ts logState.
export const LOG_STATE = /* wgsl */ `
fn log_state(what: u32, born: u32, i: u32, u: u32, uf: u32, fr: u32, hour: u32) -> u32 {
  if (!lasts(u, lam(i, KLOG[min(what, 31u)]))) { return 0u; }
  if (standing(uf, fr, hour - born)) { return 1u; }
  return 2u;
}`;

// The cell cover and its rot, once a day from the stems' crown raster (wgsl/stems.ts: each texel's tree crowns summed
// as the raster was filed, the pines' and the other trees'): each of the cell's 16 texels covered no more than whole,
// and the cell's cover the mean of its texels'. With acc set the cover is added to acc, the litterfall's running sum of
// cover-days. Bindings: crowns (the raster's sums), cover, rot, acc, P (acc).
export function deadCover(L: DeadLaw) {
  return /* wgsl */ `
${FIXED}
${common(L)}
struct Params { acc: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> crowns: array<u32>;
@group(0) @binding(1) var<storage, read_write> cover: array<u32>;
@group(0) @binding(2) var<storage, read_write> rot: array<u32>;
@group(0) @binding(3) var<storage, read_write> acc: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let c = flat(g, n);
  if (c >= ${CELLS}u) { return; }
  let cx = c % ${N}u; let cy = c / ${N}u;
  var sum = 0u;
  for (var j = 0u; j < 4u; j++) {
    for (var i = 0u; i < 4u; i++) {
      let t = (cy * 4u + j) * ${TEXELS_SIDE}u + cx * 4u + i;
      sum += min(crowns[${CROWN_WORDS}u * t] + crowns[${CROWN_WORDS}u * t + 1u], 65536u);
    }
  }
  let cov = sum / 16u;
  cover[c] = cov;
  let p = mul64(65536u - cov, ${L.gain}u);
  rot[c] = ROT + p.y + select(0u, 1u, p.x >= 0x80000000u);
  if (P.acc == 1u) { acc[c] += cov; }
}`;
}

// The hour's rot recorded for every cell (a tiers/drivers.ts writer body; in0 is the rot by cell).
export const ROT_WRITE = "set_rot(cell, bitcast<i32>(in0[cell]));";

// The trees the stems' law starved or crowded out today: 1 each in counts, the mark of every dead stem consumed (a
// bush's leaves no piece [gap]). Bindings: the plant body, counts, P (cap, the crop and what fields' word offsets).
export function deadStems(L: DeadLaw) {
  return /* wgsl */ `
${FIXED}
${common(L)}
struct Params { cap: u32, fc: u32, fw: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read_write> cnt: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  var c = 0u;
  if ((b[i] & 1u) == 0u && b[P.fc + i] == ${DIED}u) {
    b[P.fc + i] = 0u;
    if (TREE_ROW[min(b[P.fw + i] >> 8u, 31u)] < 4u) { c = 1u; }
  }
  cnt[i] = c;
}`;
}

// The logs and snags the island holds when the world begins: every tree in the raster lays Poisson(m) of them, m its
// crown's share of its texel times the table's logs a whole texel of its kind at its height (src/gpu/deadwood.ts
// poolTable: the reserves' volume over the volume of a log of that height), each a tree of its own kind and height
// that died before. Bindings: starts, list, table (rows of HT entries), counts (cleared), P (TEXELS).
export const HT = 512, HSTEP = 128;
export function initialLogs(L: DeadLaw) {
  return /* wgsl */ `
${FIXED}
${RAND}
${common(L)}
@group(0) @binding(0) var<storage, read> start: array<u32>;
@group(0) @binding(1) var<storage, read> list: array<u32>;
@group(0) @binding(2) var<storage, read> table: array<u32>;
@group(0) @binding(3) var<storage, read> pb: array<u32>;
@group(0) @binding(4) var<storage, read_write> cnt: array<u32>;
@group(0) @binding(5) var<uniform> P: vec4u;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let p = flat(g, n);
  if (p >= start[${TEXELS}u]) { return; }
  let key = list[3u * p + 1u];
  if ((key & 1u) == 0u) { return; }
  let slot = list[3u * p];
  let row = TREE_ROW[min(pb[P.y + slot] >> 8u, 31u)];
  if (row >= 4u) { return; }
  let h = min((key >> 1u) / ${HSTEP}u, ${HT - 1}u);
  let m = mul64(table[row * ${HT}u + h], list[3u * p + 2u]);
  rinit(SEED, ${POOL_STREAM}u, slot, 0u);
  cnt[slot] = min(qpoisson(bitcast<i32>((m.x >> 16u) | (m.y << 16u))), 255u);
}`;
}

// A log's birth (store.ts bear, one row a plant slot; dormantAnchors sets born and arot after it). The plant body is
// bound as pl, the diameter table (mm by height, HT entries a tree row) as dbh. A dead stem's log lies where it stood;
// one of the pool at the world's start lies somewhere in its texel, a snag with the chance SNAG_Q in Q16, else down.
export type PlantAt = { cap: number; x: number; y: number; what: number; size: number };
export function logBirth(L: DeadLaw, p: PlantAt, initial: boolean) {
  return /* wgsl */ `
  let ps = parent;
  rinit(SEED, ${LOG_STREAM}u, ps + (k << 24u), drv_hour());
  var x = pl[${p.x}u + ps];
  var y = pl[${p.y}u + ps];
  ${initial ? `
  x = min(max(x + unif(${TEXEL_MM}u), ${TEXEL_MM / 2}u) - ${TEXEL_MM / 2}u, ${N * CELL_MM - 1}u);
  y = min(max(y + unif(${TEXEL_MM}u), ${TEXEL_MM / 2}u) - ${TEXEL_MM / 2}u, ${N * CELL_MM - 1}u);` : ""}
  let what = pl[${p.what}u + ps] >> 8u;
  let len = pl[${p.size}u + ps];
  let row = TREE_ROW[min(what, 31u)];
  let h = min(len / ${HSTEP}u, ${HT - 2}u);
  let lo = dbh[row * ${HT}u + h];
  let hi = dbh[row * ${HT}u + h + 1u];
  let dia = lo + ((hi - lo) * (len - h * ${HSTEP}u)) / ${HSTEP}u;
  child_set_x(slot, x);
  child_set_y(slot, y);
  child_set_what(slot, what);
  child_set_len(slot, len);
  child_set_dia(slot, dia);
  child_set_u(slot, next32());
  child_set_uf(slot, next32());
  // the fall rate: the kind's at 40 cm, times (400 mm / dia)^0.6 (Q16.16 by qpow)
  let ratio = qdiv(400i << 16u, bitcast<i32>(max(dia, 1u) << 16u));
  let f = mul64(KFALL[min(what, 31u)], bitcast<u32>(qpow(ratio, ${Math.round(0.6 * 65536)}i)));
  var fr = max((f.x >> 16u) | (f.y << 16u), 1u);
  ${initial ? `if ((next32() >> 16u) >= ${L.snagQ}u) { fr = 0u; }` : ""}
  child_set_fr(slot, fr);`;
}


// The stick bins born at a litterfall, one a cell with any: n = Poisson(litter cover-days), the cover-days then
// cleared; with pool set instead the cell's standing pool at the world's start, Poisson(pool cover / rot). Counts
// get 1 for a cell with sticks, n its count. Bindings: acc, cover, rot, n, counts, P (pool, born).
export function litter(L: DeadLaw) {
  return /* wgsl */ `
${FIXED}
${RAND}
${common(L)}
struct Params { pool: u32, born: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> acc: array<u32>;
@group(0) @binding(1) var<storage, read> cover: array<u32>;
@group(0) @binding(2) var<storage, read> rot: array<u32>;
@group(0) @binding(3) var<storage, read_write> nn: array<u32>;
@group(0) @binding(4) var<storage, read_write> cnt: array<u32>;
@group(0) @binding(5) var<uniform> P: Params;
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let c = flat(g, n);
  if (c >= ${CELLS}u) { return; }
  var lamq = 0u;
  if (P.pool == 1u) {
    // ${L.pool} sticks a whole cell under a closed canopy (Q16.16 times the rot of a closed hour)
    let p = mul64(cover[c], ${L.pool}u);
    lamq = divw(p.y, p.x, rot[c]).x;
  } else {
    let p = mul64(acc[c], ${L.litter}u);
    lamq = (p.x >> 16u) | (p.y << 16u);
    acc[c] = 0u;
  }
  rinit(SEED, ${LITTER_STREAM}u, c, P.born);
  let k = min(qpoisson(bitcast<i32>(min(lamq, 0x7fffffffu))), 65535u);
  nn[c] = k;
  cnt[c] = select(0u, 1u, k > 0u);
}`;
}
// A bin's birth at its cell's middle (bear rows are cells; nn bound as extra).
export const BIN_BIRTH = /* wgsl */ `
  child_set_x(slot, (parent % ${N}u) * ${CELL_MM}u + ${CELL_MM / 2}u);
  child_set_y(slot, (parent / ${N}u) * ${CELL_MM}u + ${CELL_MM / 2}u);
  child_set_n(slot, nn[parent]);`;

// Member k of a bin: its place, then its word.
export const STICK_MEMBER = /* wgsl */ `
struct Stick { x: u32, y: u32, u: u32 }
fn stick(cell: u32, born: u32, k: u32) -> Stick {
  rinit(SEED, ${STICK_STREAM}u, cell + (k << 16u), born);
  let x = (cell % ${N}u) * ${CELL_MM}u + unif(${CELL_MM}u);
  let y = (cell / ${N}u) * ${CELL_MM}u + unif(${CELL_MM}u);
  return Stick(x, y, next32());
}
fn taken(cell: u32, born: u32, k: u32) -> bool {
  let w = (cell << 16u) | k;
  var lo = 0u; var hi = gone[0];
  loop {
    if (lo >= hi) { return false; }
    let m = (lo + hi) / 2u; let a = gone[1u + 2u * m]; let b2 = gone[2u + 2u * m];
    if (a == w && b2 == born) { return true; }
    if (a < w || (a == w && b2 < born)) { lo = m + 1u; } else { hi = m; }
  }
}`;

// Every bin's sticks still lying at the newest committed hour counted into tot[0] and each live bin's count into
// each[slot]. With P.kill 1 instead only the bins of slots P.part modulo P.parts, one invocation each (a day's share,
// so no day pays for all), and each of them with none left let go: a bin's sticks are read only until one is found
// still lying, and tot and each are left as they were. Bindings: bins body, alloc, ring, gone, tot, each, P (cap, kill,
// part, parts).
export function binSweep(L: DeadLaw, bins: Layout, drv: DriverLayout) {
  return /* wgsl */ `
${FIXED}
${RAND}
struct Params { cap: u32, kill: u32, part: u32, parts: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> drv: array<u32>;
@group(0) @binding(3) var<storage, read> gone: array<u32>;
@group(0) @binding(4) var<storage, read_write> tot: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> each: array<u32>;
@group(0) @binding(6) var<uniform> P: Params;
${common(L)}
${access("s", "b", "P.cap", bins, true)}
${drvAccess(drv)}
${STICK_MEMBER}
${FLAT}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let j = g.x + g.y * n.x * 64u;
  let kill = P.kill == 1u;
  let i = select(j, j * P.parts + P.part, kill);
  if (i >= P.cap) { return; }
  if (!kill) { each[i] = 0u; }
  if (i >= a[${CTL.tail}u] || !s_alive(i)) { return; }
  let cell = cell_of(s_x(i), s_y(i));
  let born = s_born(i);
  let l = lam(drv_sum(CH_ROT, cell, drv_hour()) - s_arot(i), KSTICK);
  let e = bitcast<u32>(qexp(-l));
  var left = 0u;
  for (var k = 0u; k < s_n(i); k++) {
    let m = stick(cell, born, k);
    if ((m.u >> 16u) < e && !taken(cell, born, k)) { left++; if (kill) { break; } }
  }
  if (kill) { if (left == 0u) { s_kill(i); } return; }
  each[i] = left;
  atomicAdd(&tot[0], left);
}`;
}

// Every log's state at the newest committed hour into st (0 gone, 1 snag, 2 log; 3 for a free slot), the gone killed
// when P.kill is 1. Bindings: logs body, alloc, ring, st, P (cap, kill).
export function logSweep(L: DeadLaw, logs: Layout, drv: DriverLayout) {
  return /* wgsl */ `
${FIXED}
struct Params { cap: u32, kill: u32, a: u32, b: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> drv: array<u32>;
@group(0) @binding(3) var<storage, read_write> st: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;
${common(L)}
${LOG_STATE}
${access("o", "b", "P.cap", logs, true)}
${drvAccess(drv)}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= P.cap) { return; }
  if (i >= a[${CTL.tail}u] || !o_alive(i)) { st[i] = 3u; return; }
  let cell = cell_of(o_x(i), o_y(i));
  let h = drv_hour();
  let s = log_state(o_what(i), o_born(i), drv_sum(CH_ROT, cell, h) - o_arot(i), o_u(i), o_uf(i), o_fr(i), h);
  st[i] = s;
  if (s == 0u && P.kill == 1u) { o_kill(i); }
}`;
}

// The landing's copy of what the CPU needs to know every piece's state between days: every cell's rot running sum at
// the newest committed hour, then the rot each hour adds from here. Bindings: ring, rot, out, P (at).
export function rotGather(drv: DriverLayout) {
  return /* wgsl */ `
struct Params { at: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read> drv: array<u32>;
@group(0) @binding(1) var<storage, read> rot: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;
${drvAccess(drv)}
${FLAT}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let c = flat(g, n);
  if (c >= ${CELLS}u) { return; }
  out[P.at + c] = drv_sum(CH_ROT, c, drv_hour());
  out[P.at + ${CELLS}u + c] = rot[c];
}`;
}

// A clast class's member body for tiers/dormant.ts staticMembers: the square of member k by the halvings, then its
// place in the square and its diameter (mm) and a word of variation (seed). r1q is (1 - (lo / hi)^DIM) 2^32, dimq
// 1 / DIM in Q16.16.
export const LEVELS = 8, SQUARES = 1 << (LEVELS / 2);
export type ClastLaw = { seed: number; stream: number; lo: number; hi: number; r1q: number; dimq: number };
export function clastBody(c: ClastLaw) {
  return /* wgsl */ `
  var nn = counts[cell];
  var lo = 0u;
  var node = 1u;
  var ix = 0u;
  var iy = 0u;
  for (var l = 0u; l < ${LEVELS}u; l++) {
    rinit(${c.seed >>> 0}u, ${(c.stream + 1) >>> 0}u, cell, node);
    let left = binhalf(nn);
    let right = k - lo >= left;
    if (right) { lo += left; nn -= left; } else { nn = left; }
    node = node * 2u + select(0u, 1u, right);
    if ((l & 1u) == 0u) { ix = ix * 2u + select(0u, 1u, right); } else { iy = iy * 2u + select(0u, 1u, right); }
  }
  rinit(${c.seed >>> 0}u, ${c.stream >>> 0}u, k, cell);
  let sx0 = (ix * ${CELL_MM}u) / ${SQUARES}u; let sx1 = ((ix + 1u) * ${CELL_MM}u) / ${SQUARES}u;
  let sy0 = (iy * ${CELL_MM}u) / ${SQUARES}u; let sy1 = ((iy + 1u) * ${CELL_MM}u) / ${SQUARES}u;
  out_x = x0 + sx0 + unif(sx1 - sx0);
  out_y = y0 + sy0 + unif(sy1 - sy0);
  let v = 0xffffffffu - mulhi(next32(), ${c.r1q >>> 0}u);
  let e = qmul(round16(nlnu(v)), ${c.dimq}i);
  out_dia = min((${c.lo}u * bitcast<u32>(qexp(e))) >> 16u, ${c.hi - 1}u);
  out_seed = next32();`;
}
