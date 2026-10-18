// The island's hydrology (src/terrain/water.ts hydrology and aquifer) in WGSL, integer throughout; src/gpu/terrain/water.ts
// drives it. Every field is one i32 word a cell in one storage buffer F, in FIELDS order; each has its unit where it is
// listed. The kernels are per-cell passes, or one workgroup of 256 that loops with barriers where the work is a graph
// walk or a relaxation:
// - the tree: pointer jumping over `to` gives each cell's depth, a counting sort files the cells by depth, and every
//   gather (flow accumulation) and channel pass then walks the depths deepest first, each cell pulling from the
//   neighbours that drain into it, so no atomics touch a sum and every sum is exact;
// - the aquifer: the CPU's over-relaxation at 1.6 with its row-by-row sweep, run along the anti-diagonals, which moves
//   every cell after the same neighbours as the row sweep does, so it takes the same number of sweeps and stops at the
//   same 2 mm change; the 256 columns are the 256 threads of one workgroup;
// - the lakes: components of the hollows by minimum-label propagation, then each basin cell as a candidate level
//   against every cell of its hollow.
import { CELL, LEN, N } from "../../terrain/grid";
import { BARE, DRIFTS, ROCKS } from "../../terrain/geology";
import { ROOTS } from "../../terrain/growth";
import { AT_D, BANKFULL, BUCKET, CONFINED, FALL, FLOOD, HEAD_C, KC_DEEP, KC_SHALLOW, RHO, G, SEASON_S, SHIELDS, SUBMERGED, SY_DRIFT, SY_ROCK, T_FILL, WIDE_WOOD, YEAR_S } from "../../terrain/water";
import { FIXED } from "./fixed";

// ---------- units ----------
// Z:   Q12.20 metres (heights, depths, heads; the host checks that none reaches 1024 m, a sweep adds 2^30 to a head).
// MM:  Q16.16 millimetres.
// V:   Q25.6 cubic metres (a cell's volume in a season or a year), summed in 64 bits wherever cells are added.
// FQ:  Q6.26 cubic metres a second (flows; the island's biggest is about 1 and bankfull is 15 times that, under 64).
// S30: Q2.30 slopes (and slope35, the same in units of 2^-35, where the stage of a channel needs a flat's tiny fall).
// T13: Q19.13 transmissivity, m2 a year (the biggest cell holds under 82,000, a cell's four faces then sum under 2^32).
// W31: Q1.31 weights.
// A height is also held in a second word (hlo, flo) of what lies below its Z word, in units of 2^-31 of Z's last place.
export const ZS = 2 ** 20;
export const MAXD = 8190; // the deepest flow path the counting sort holds, cells
export const SWEEP_TOLERANCE_Z = 2097; // the CPU's 0.002 m, in Z, a sweep may still change by and stop

// The fields, in order. The outputs the host reads back are the last block, contiguous.
const INPUTS = ["sea", "h", "hlo", "filled", "flo", "to", "basin", "rock", "drift", "dd", "pr0", "pr1", "pr2", "pr3", "pe0", "pe1", "pe2", "pe3"];
const INTERNAL = [
  "fall", "su0", "su1", "su2", "su3", "sh0", "sh1", "sh2", "sh3", "wet", "rr", "bedT", "drK", "tt", "head", "depth", "hol", "spl", "isf", "fxv",
  "dep", "lvl", "lvs", "blist", "ua", "ub", "da", "db",
  "ce", "cs", "ww", "we", "wn", "ws", "sso", "out",
  "gw", "bk", "ln", "qk0", "qk1", "qk2", "qk3", "wt0", "wt1", "wt2", "wt3", "wt4",
  "ga0l", "ga0h", "ga1l", "ga1h", "ga2l", "ga2h", "ga3l", "ga3h", "ga4l", "ga4h",
  "inl", "inh", "rk", "lv", "tgt", "dbf", "misc",
];
// water: Z standing water; flow, sf0..3, spring: FQ; tab, stb0..3, dry: Z; base: Q16 share; valley, spf: 0 or 1;
// chn: channel 0 or 1; open: 0 or 1; qbf: FQ; slope: S30; pwr: Q16 W/m2; rtl, rth: the stream's flow under its bed, Q40 m3/s
// in two words.
export const OUTPUTS = ["water", "flow", "sf0", "sf1", "sf2", "sf3", "tab", "stb0", "stb1", "stb2", "stb3", "dry", "spring", "base", "valley", "chn", "open", "qbf", "slope", "pwr", "rtl", "rth", "spf"];
export const FIELDS: readonly string[] = [...INPUTS, ...INTERNAL, ...OUTPUTS];
export const FIELD = Object.fromEntries(FIELDS.map((n, k) => [n, k])) as Record<string, number>;
// Atomic words (AT): each region is LEN words.
export const AT_REGIONS = ["lab", "hist", "cur", "lbest", "lsp", "plc", "cnt"];
export const AT_OF = Object.fromEntries(AT_REGIONS.map((n, k) => [n, k])) as Record<string, number>;
// misc words
export const MISC = { maxd: 0, sweeps1: 2, sweeps2: 3, rounds: 4, quick: 16 };

const q16 = (x: number) => Math.round(x * 65536);
// transmissivity's scale: the sum of a cell's four faces, 4 x 82,000 m2 a year at most, then holds in a u32
export const TS = 2 ** 13;
const two = (v: bigint) => { const u = BigInt.asUintN(64, v); return [Number(u & 0xffffffffn), Number(u >> 32n)] as const; };

// bankDepth = 2^((log2 0.201 + 0.336 log2 Q - 0.085 log2 S + 0.025 log2(1.65 tau*)) / 1.025) (water.ts 66)
const BD0 = (Math.log2(0.201) + 0.025 * Math.log2(SUBMERGED * SHIELDS)) / 1.025, BD1 = 0.336 / 1.025, BD2 = 0.085 / 1.025;
const BD0W = two(BigInt(Math.round(BD0 * 2 ** 32)));
const D04 = BANKFULL ** -AT_D; // depthOf at the mean flow against the bankfull one
const SPRING_K = (CELL * CELL / 1000) * 2 ** 26 / YEAR_S / 65536; // MM in, FQ out: a spring's flow that evaporates (mm over a year)
const SECONDS_UP_MM = (SEASON_S / (CELL * CELL)) * 1000 * 2 ** 16 / 2 ** 26; // FQ to the metres a season of it rises over a cell, as MM per FQ unit

const rockTab = ROCKS.map((r) => `${Math.round(r.ksat * r.thick * YEAR_S * TS)}u`).join(", ");
const rockCap = ROCKS.map((r) => (Number.isFinite(r.cap) ? `${Math.round(r.cap * 65536)}i` : "2147483647i")).join(", ");
const rockSy = ROCKS.map((_, k) => `${q16(SY_ROCK[k] ?? 0)}i`).join(", ");
const driftK = DRIFTS.map((d) => `${Math.round(d.ksat * YEAR_S * TS)}u`).join(", ");
const driftShare = DRIFTS.flatMap((d) => d.recharge.map((r) => `${q16(r)}i`)).join(", ");
const driftSy = DRIFTS.map((_, k) => `${q16(SY_DRIFT[k] ?? 0)}i`).join(", ");

const consts = /* wgsl */ `
const N = ${N}u;
const LEN = ${LEN}u;
${FIELDS.map((n, k) => `const f_${n}: u32 = ${k * LEN}u;`).join("\n")}
${AT_REGIONS.map((n, k) => `const a_${n}: u32 = ${k * LEN}u;`).join("\n")}
const MAXD = ${MAXD}u;
const NR = ${ROCKS.length}u;
const ROCK_T = array<u32, ${ROCKS.length}>(${rockTab});
const ROCK_CAP = array<i32, ${ROCKS.length}>(${rockCap});
const ROCK_SY = array<i32, ${ROCKS.length}>(${rockSy});
const DRIFT_K = array<u32, ${DRIFTS.length}>(${driftK});
const DRIFT_SHARE = array<i32, ${DRIFTS.length * 3}>(${driftShare});
const DRIFT_SY = array<i32, ${DRIFTS.length}>(${driftSy});
const KC_DEEP = array<i32, 4>(${KC_DEEP.map(q16).join(", ")});
const DX = array<i32, 8>(1, 1, 0, -1, -1, -1, 0, 1);
const DY = array<i32, 8>(0, 1, 1, 1, 0, -1, -1, -1);
const BUCKET_Q16 = ${q16(BUCKET)}i;
const FALL_F = vec2u(${two(BigInt(Math.round(FALL * 2 ** 51))).join("u, ")}u);
const REACH_ORTH = ${q16(CELL)}u;
const REACH_DIAG = ${q16(Math.hypot(1, 1) * CELL)}u;
const ONE_Z = ${ZS}i;
const ROOTS_Z = ${Math.round(ROOTS * ZS)}i;
const KCS = ${q16(KC_SHALLOW)}i;
const RA_K = ${Math.round((CELL * CELL * 2 ** 33) / 65536 / 1000)}u;
const MMV = ${(CELL * CELL) / 1000 * 64}u;
const C_YEAR = ${Math.round(2 ** 32 * ZS / YEAR_S)}u;
const C_SEASON = ${Math.round(2 ** 32 * ZS / SEASON_S)}u;
const K_YEAR = ${Math.round((YEAR_S / ZS) * 65536)}u;
const BANKFULL_Q16 = ${q16(BANKFULL)}u;
const ONE_MINUS_D04 = ${q16(1 - D04)}i;
const RISE_Q16 = ${q16(FLOOD ** AT_D - 1)}i;
const BD0V = vec2u(${BD0W[0]}u, ${BD0W[1]}u);
const BD1U = ${Math.round(BD1 * 2 ** 32)}u;
const BD2U = ${Math.round(BD2 * 2 ** 32)}u;
const POWER_K = ${q16((RHO * G) / WIDE_WOOD)}i;
const WOOD_W = ${q16(WIDE_WOOD)}i;
const CONFINED_Q16 = ${q16(CONFINED)}i;
const TFILL = ${Math.round(T_FILL * 2 ** 32)}u;
const SPRING_K = ${Math.round(SPRING_K * 2 ** 32)}u;
const UP_K = ${Math.round(SECONDS_UP_MM * 65536)}u;
const RISE_Z = ${Math.round(0.016 * 2 ** 32)}u;
const SWEEP_TOL = ${SWEEP_TOLERANCE_Z + 1}u;
const HEAD_NUM = ${Math.round(CELL / HEAD_C)}u;
const OFF = 1073741824i;
`;

const wgsl = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> F: array<i32>;
@group(0) @binding(1) var<storage, read_write> AT: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> P: array<u32>;
// every entry point touches all three bindings, so that one bind group fits each of the auto layouts
fn touch() { _ = arrayLength(&F); _ = arrayLength(&AT); _ = arrayLength(&P); }

fn gi(f: u32, i: u32) -> i32 { return F[f + i]; }
fn gu(f: u32, i: u32) -> u32 { return bitcast<u32>(F[f + i]); }
fn wi(f: u32, i: u32, v: i32) { F[f + i] = v; }
fn wu(f: u32, i: u32, v: u32) { F[f + i] = bitcast<i32>(v); }
fn gs(f: u32, s: u32, i: u32) -> i32 { return F[f + s * LEN + i]; }

// ---------- 64-bit helpers on top of fixed.ts ----------
fn s64(v: i32) -> vec2u { return vec2u(bitcast<u32>(v), select(0u, 0xffffffffu, v < 0i)); }
fn smul64(a: i32, b: u32) -> vec2u { let p = mul64(mag(a), b); return select(p, neg64(p), a < 0i); }
fn sar64(v: vec2u, s: u32) -> vec2u { return vec2u((v.x >> s) | (v.y << (32u - s)), bitcast<u32>(bitcast<i32>(v.y) >> s)); }
fn rsar64(v: vec2u, s: u32) -> vec2u { return sar64(add64(v, vec2u(1u << (s - 1u), 0u)), s); }
fn sat32(v: vec2u) -> i32 {
  if (v.y == 0u && v.x < 0x80000000u) { return bitcast<i32>(v.x); }
  if (v.y == 0xffffffffu && v.x >= 0x80000000u) { return bitcast<i32>(v.x); }
  return select(FX_MAX, -FX_MAX, isneg64(v));
}
fn usat32(v: vec2u) -> u32 { return select(v.x, 0xffffffffu, v.y != 0u); }
// (a * b) >> s for the low word, s in 1..31
fn mulshr(a: u32, b: u32, s: u32) -> u32 { let p = mul64(a, b); return (p.x >> s) | (p.y << (32u - s)); }
// x * c / 2^32 for a signed x, truncated
fn sscale(x: i32, c: u32) -> i32 { let r = bitcast<i32>(mul64(mag(x), c).y); return select(r, -r, x < 0i); }
// millimetres Q16 to cubic metres a cell Q6
fn mm_v(mm: i32) -> i32 { return sat32(rsar64(smul64(mm, MMV), 16u)); }
fn ld64(f: u32, i: u32) -> vec2u { return vec2u(gu(f, i), gu(f + LEN, i)); }

// ---------- the ground's fall, the bucket, the rain's share, the first transmissivity ----------
// A height is held twice: the Q12.20 word, and the rest of it below the word's last place in a second, as units of
// 2^-31 of that place, so a fall of 1e-4 m between two cells of a flat (the priority flood's step) keeps its size.
fn fine(hi: i32, lo: i32) -> vec2u {
  let a = s64(hi);
  return add64(vec2u(a.x << 31u, (a.y << 31u) | (a.x >> 1u)), s64(lo));
}
// the fall from cell i to the sea's level or the ground of its receiver, units of 2^-51 m, at least the floor
fn fall_fine(hi_f: u32, lo_f: u32, i: u32, j: u32, floor: vec2u) -> vec2u {
  let a = fine(gi(hi_f, i), gi(lo_f, i));
  let b = fine(gi(hi_f, j), gi(lo_f, j));
  let dz = sub64(a, select(b, vec2u(0u), isneg64(b)));
  return select(dz, floor, isneg64(dz) || lt64(dz, floor));
}
// floor(n / d) for a 64-bit n
fn div64(n: vec2u, d: u32) -> vec2u {
  let qh = n.y / d;
  return vec2u(divw(n.y - qh * d, n.x, d).x, qh);
}
fn reach_of(i: u32) -> u32 {
  let j = gu(f_to, i);
  return select(REACH_ORTH, REACH_DIAG, ((j & 255u) != (i & 255u)) && ((j >> 8u) != (i >> 8u)));
}
// a cell's slope to the sea's level or the ground of its receiver, in units of 2^-35: the fall in 2^-51 m over the reach in
// 2^-16 m (a flat's 1e-4 m step over 75 m is 1.3e-6, which a Q30 slope holds to 7e-4 and this to 2e-5)
fn slope35(i: u32) -> vec2u {
  return div64(fall_fine(f_filled, f_flo, i, gu(f_to, i), FALL_F), reach_of(i));
}
// units of 2^-35 to Q30, rounded, saturating
fn s30_of(v: vec2u) -> u32 {
  let r = add64(v, vec2u(16u, 0u));
  return select((r.x >> 5u) | (r.y << 27u), 0xffffffffu, (r.y >> 5u) != 0u);
}
@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let hq = gi(f_h, i); let fq = gi(f_filled, i);
  let sea = gi(f_sea, i) != 0i;
  var sl = 0u; var fl = 0u;
  let j = gu(f_to, i);
  if (!sea && j != i) {
    sl = s30_of(slope35(i));
    fl = s30_of(div64(fall_fine(f_h, f_hlo, i, j, vec2u(0u)), reach_of(i)));
  }
  wu(f_slope, i, sl); wu(f_fall, i, fl);
  var wet = 0i; var rr = 0i;
  let rock = gu(f_rock, i); let drift = gu(f_drift, i); let dd = gi(f_dd, i);
  if (!sea) {
    var store = BUCKET_Q16;
    for (var year = 0u; year < 2u; year++) {
      for (var s = 0u; s < 4u; s++) {
        let pe = gs(f_pe0, s, i);
        let have = store + gs(f_pr0, s, i);
        let used = min(pe, have);
        let left = have - used;
        let over = max(0i, left - BUCKET_Q16);
        store = left - over;
        if (year == 1u) {
          F[f_su0 + s * LEN + i] = over;
          F[f_sh0 + s * LEN + i] = pe - used;
          wet += over;
        }
      }
    }
    let band = select(select(2u, 1u, dd <= 5i * ONE_Z), 0u, dd <= 3i * ONE_Z);
    rr = min(qmul(DRIFT_SHARE[drift * 3u + band], wet), ROCK_CAP[rock]);
  }
  wi(f_wet, i, wet); wi(f_rr, i, rr);
  let bed = ROCK_T[rock]; let dk = DRIFT_K[drift];
  wu(f_bedT, i, bed); wu(f_drK, i, dk);
  let p = add64(mul64(dk, u32(dd)), vec2u(1u << 19u, 0u));
  wu(f_tt, i, bed + ((p.x >> 20u) | (p.y << 12u)));
  wi(f_head, i, hq - 3i * ONE_Z);
  let basin = gi(f_basin, i) != 0i;
  wi(f_open, i, select(0i, 1i, sea || basin));
  wi(f_depth, i, select(0i, fq - hq, basin));
}

// ---------- the hollows: components of basin cells, labelled by their least cell ----------
var<workgroup> wflag: atomic<u32>;
var<workgroup> wuni: u32;
fn lab(i: u32) -> u32 { return atomicLoad(&AT[a_lab + i]); }
@compute @workgroup_size(256)
fn hollows(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    let inb = gi(f_basin, i) != 0i && gi(f_sea, i) == 0i;
    atomicStore(&AT[a_lab + i], select(0xffffffffu, i, inb));
  }
  storageBarrier(); workgroupBarrier();
  var rounds = 0u;
  for (var r = 0u; r < 4096u; r++) {
    if (t == 0u) { atomicStore(&wflag, 0u); }
    storageBarrier(); workgroupBarrier();
    for (var i = t; i < LEN; i += 256u) {
      let own = lab(i);
      if (own == 0xffffffffu) { continue; }
      var m = min(own, lab(own));
      let x = i32(i & 255u); let y = i32(i >> 8u);
      for (var d = 0u; d < 8u; d++) {
        let nx = x + DX[d]; let ny = y + DY[d];
        if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
        m = min(m, lab(u32(ny) * 256u + u32(nx)));
      }
      if (m < own) { atomicMin(&AT[a_lab + i], m); atomicOr(&wflag, 1u); }
    }
    storageBarrier(); workgroupBarrier();
    if (t == 0u) { wuni = atomicLoad(&wflag); }
    workgroupBarrier();
    rounds = r + 1u;
    if (workgroupUniformLoad(&wuni) == 0u) { break; }
  }
  if (t == 0u) { wi(f_misc, MISC_ROUNDS, i32(rounds)); }
  for (var i = t; i < LEN; i += 256u) {
    let l = lab(i);
    if (l == 0xffffffffu) { wi(f_hol, i, -1i); continue; }
    wi(f_hol, i, i32(l));
    wi(f_spl, i, 1i);
    let n = atomicAdd(&AT[a_cnt], 1u);
    wu(f_blist, n, i);
  }
}

// ---------- the tree: depth by pointer jumping, then the cells filed by depth ----------
@compute @workgroup_size(256)
fn levels(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    let j = gu(f_to, i);
    wu(f_ua, i, j);
    wi(f_da, i, select(1i, 0i, j == i));
  }
  storageBarrier(); workgroupBarrier();
  for (var r = 0u; r < 14u; r++) {
    let src = select(f_ua, f_ub, (r & 1u) == 1u);
    let srcd = select(f_da, f_db, (r & 1u) == 1u);
    let into = select(f_ub, f_ua, (r & 1u) == 1u);
    let intod = select(f_db, f_da, (r & 1u) == 1u);
    for (var i = t; i < LEN; i += 256u) {
      let j = gu(src, i);
      wu(into, i, gu(src, j));
      wi(intod, i, gi(srcd, i) + gi(srcd, j));
    }
    storageBarrier(); workgroupBarrier();
  }
  // after an even number of rounds the result is in ua, da
  for (var i = t; i < LEN; i += 256u) {
    let u = gu(f_ua, i);
    if (gu(f_to, u) != u) { atomicOr(&AT[a_cnt + 1u], 1u); }
    let d = gi(f_da, i);
    wi(f_dep, i, d);
    if (u32(d) > MAXD) { atomicOr(&AT[a_cnt + 1u], 2u); } else { atomicAdd(&AT[a_hist + u32(d)], 1u); }
  }
  storageBarrier(); workgroupBarrier();
  if (t == 0u) {
    var run = 0u; var top = 0u;
    for (var d = 0u; d <= MAXD + 1u; d++) {
      wu(f_lvs, d, run);
      atomicStore(&AT[a_cur + d], run);
      let c = atomicLoad(&AT[a_hist + d]);
      if (c > 0u) { top = d; }
      run += c;
    }
    wi(f_misc, MISC_MAXD, i32(top));
  }
  storageBarrier(); workgroupBarrier();
  for (var i = t; i < LEN; i += 256u) {
    let d = gu(f_dep, i);
    if (d <= MAXD) { let p = atomicAdd(&AT[a_cur + d], 1u); wu(f_lvl, p, i); }
  }
}

// ---------- weights for the gathers that are not the route's ----------
@compute @workgroup_size(256)
fn weights(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  // variant 0: one a cell (the drainage area in cells); 1: the year's surplus over each cell, m3 a year
  wi(f_wt0, i, select(mm_v(gi(f_wet, i)), 1i, P[0] == 0u));
}

// ---------- gathers: each cell's weight and all that drains into it, deepest first ----------
// water.ts gather: a cell's total goes to the cell it drains to; out of a hollow whose lake does not spill nothing
// goes, out of one that spills never less than nothing.
var<workgroup> wmax: u32;
fn gather_cell(i: u32, nc: u32, wbase: u32, obase: u32) {
  let x = i32(i & 255u); let y = i32(i >> 8u);
  let hi = gi(f_hol, i);
  for (var c = 0u; c < nc; c++) {
    var acc = s64(F[wbase + c * LEN + i]);
    for (var d = 0u; d < 8u; d++) {
      let nx = x + DX[d]; let ny = y + DY[d];
      if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
      let k = u32(ny) * 256u + u32(nx);
      if (gu(f_to, k) != i) { continue; }
      let a = ld64(obase + 2u * c * LEN, k);
      let hk = gi(f_hol, k);
      if (hk < 0i || hk == hi) { acc = add64(acc, a); }
      else if (gi(f_spl, u32(hk)) != 0i && !isneg64(a)) { acc = add64(acc, a); }
    }
    wu(obase + 2u * c * LEN, i, acc.x);
    wu(obase + (2u * c + 1u) * LEN, i, acc.y);
  }
}
@compute @workgroup_size(256)
fn gather(@builtin(local_invocation_index) t: u32) {
  let nc = P[0]; let wbase = P[1]; let obase = P[2];
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var k = 0u; k <= top; k++) {
    let d = top - k;
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) { gather_cell(gu(f_lvl, p), nc, wbase, obase); }
    storageBarrier(); workgroupBarrier();
  }
}

// the year's flow before any groundwater: the surplus gathered, m3 a second
@compute @workgroup_size(256)
fn flow0(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let f = ld64(f_ga0l, i);
  let pos = select(f, vec2u(0u), isneg64(f));
  wu(f_flow, i, usat32(mulhi64(pos, C_YEAR)));
}

// ---------- where a channel begins and every cell below one (water.ts channelOf) ----------
fn nonspill(i: u32) -> bool { let h = gi(f_hol, i); return h >= 0i && gi(f_spl, u32(h)) == 0i; }
// 3 * cells * fall^2 >= 2^60, which is (area / CELL) fall^2 >= HEAD_C with the area gathered as cells
fn begins(cells: u32, fall: u32) -> bool {
  let f2 = mul64(fall, fall); let m = HEAD_NUM * cells;
  let p0 = mul64(f2.x, m); let p1 = mul64(f2.y, m);
  let w1 = p0.y + p1.x; let w2 = p1.y + select(0u, 1u, w1 < p0.y);
  return w2 != 0u || w1 >= (1u << 28u);
}
fn channel_cell(i: u32) {
  let valid = gi(f_sea, i) == 0i && !nonspill(i);
  var c = 0i;
  if (valid) {
    if (begins(gu(f_ga0l, i), gu(f_fall, i))) { c = 1i; }
    let x = i32(i & 255u); let y = i32(i >> 8u);
    for (var d = 0u; d < 8u; d++) {
      let nx = x + DX[d]; let ny = y + DY[d];
      if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
      let k = u32(ny) * 256u + u32(nx);
      if (gu(f_to, k) == i && gi(f_chn, k) != 0i) { c = 1i; }
    }
  }
  wi(f_chn, i, c);
}
@compute @workgroup_size(256)
fn channels(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var k = 0u; k <= top; k++) {
    let d = top - k;
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) { channel_cell(gu(f_lvl, p)); }
    storageBarrier(); workgroupBarrier();
  }
}

// ---------- a channel's stage: its bed a bankfull depth down and its mean flow's depth over that ----------
// log2 of a 64-bit integer above zero, Q32.32
fn lg64(v: vec2u) -> vec2u {
  if (v.y != 0u) {
    let c = countLeadingZeros(v.y);
    return vec2u(lg2m(select((v.y << c) | (v.x >> (32u - c)), v.y, c == 0u)), 63u - c);
  }
  let c = countLeadingZeros(v.x);
  return vec2u(lg2m(v.x << c), 31u - c);
}
// the bankfull depth in Q12.20 m, from the bankfull flow (Q26 m3 a second) and the slope (units of 2^-35)
fn bank_depth_z(qq26: u32, s35: vec2u) -> i32 {
  let l2q = sub64(lg32(qq26), vec2u(0u, 10u));
  let l2s = sub64(lg64(s35), vec2u(0u, 35u));
  return exp2q(add64(add64(BD0V, vec2u(0u, 4u)), sub64(smulhi64(l2q, BD1U), smulhi64(l2s, BD2U))));
}
// floor(sqrt(n)) of a 64-bit n
fn sqrt64(n: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 0x80000000u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}
// the square root of a flow in Q26, as Q28
fn sqrt_q28(q: u32) -> u32 { return sqrt64(vec2u(q << 30u, q >> 2u)); }
fn bank_flow(i: u32) -> u32 { return mulshr(gu(f_flow, i), BANKFULL_Q16, 16u); }
struct Stage { ok: bool, z: i32 }
fn stage_of(i: u32) -> Stage {
  let zh = gi(f_h, i);
  let q = bank_flow(i);
  if (q == 0u) { return Stage(true, zh); }
  if (gu(f_to, i) == i) { return Stage(false, 0i); }
  let d = bank_depth_z(q, slope35(i));
  return Stage(true, zh - sat32(rsar64(smul64(d, u32(ONE_MINUS_D04)), 16u)));
}

// the fixed heads (the sea, lakes, channels), and for the second solve the transmissivity from the first one's head
@compute @workgroup_size(256)
fn fixedset(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  var isf = 0i; var fxv = 0i;
  let sea = gi(f_sea, i) != 0i;
  if (P[0] == 0u) {
    if (sea) { isf = 1i; fxv = 0i; }
    else if (gi(f_basin, i) != 0i) { isf = 1i; fxv = gi(f_filled, i); }
    else if (gi(f_chn, i) != 0i) { let s = stage_of(i); if (s.ok) { isf = 1i; fxv = s.z; } }
  } else {
    let dd = gi(f_dd, i);
    let sat = clamp(gi(f_head, i) - (gi(f_h, i) - dd), 0i, dd);
    let p = add64(mul64(gu(f_drK, i), u32(sat)), vec2u(1u << 19u, 0u));
    wu(f_tt, i, gu(f_bedT, i) + ((p.x >> 20u) | (p.y << 12u)));
    if (gi(f_open, i) != 0i) { isf = 1i; fxv = select(gi(f_h, i) + gi(f_water, i), 0i, sea); }
    else if (gi(f_chn, i) != 0i) { let s = stage_of(i); if (s.ok) { isf = 1i; fxv = s.z; } }
  }
  wi(f_isf, i, isf); wi(f_fxv, i, fxv);
}

// ---------- the aquifer ----------
// harmonic mean 2 a b / (a + b), rounded
fn harm(a: u32, b: u32) -> u32 {
  let s = a + b;
  if (s == 0u) { return 0u; }
  let p = mul64(a, b);
  let p2 = add64(vec2u(p.x << 1u, (p.y << 1u) | (p.x >> 31u)), vec2u(s >> 1u, 0u));
  return divw(p2.y, p2.x, s).x;
}
@compute @workgroup_size(256)
fn aqprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_isf, i) != 0i) { wi(f_head, i, gi(f_fxv, i)); }
  let x = i & 255u;
  let tt = gu(f_tt, i);
  wu(f_ce, i, select(0u, harm(tt, gu(f_tt, min(i + 1u, LEN - 1u))), x < 255u));
  wu(f_cs, i, select(0u, harm(tt, gu(f_tt, min(i + 256u, LEN - 1u))), i + 256u < LEN));
}
fn weight_of(c: u32, sum: u32) -> u32 { return divw(c >> 1u, c << 31u, sum).x; }
@compute @workgroup_size(256)
fn aqw(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let x = i & 255u; let y = i >> 8u;
  if (x < 1u || x > 254u || y < 1u || y > 254u) { return; }
  let cw = gu(f_ce, i - 1u); let ce = gu(f_ce, i); let cn = gu(f_cs, i - 256u); let cs = gu(f_cs, i);
  let sum = cw + ce + cn + cs;
  if (sum == 0u) { return; }
  var w = vec4u(weight_of(cw, sum), weight_of(ce, sum), weight_of(cn, sum), weight_of(cs, sum));
  // the rounding left over goes to the heaviest face, so the weights sum to one exactly
  let rem = 0x80000000u - (w.x + w.y + w.z + w.w);
  if (cw >= ce && cw >= cn && cw >= cs) { w.x += rem; }
  else if (ce >= cn && ce >= cs) { w.y += rem; }
  else if (cn >= cs) { w.z += rem; }
  else { w.w += rem; }
  wu(f_ww, i, w.x); wu(f_we, i, w.y); wu(f_wn, i, w.z); wu(f_ws, i, w.w);
  let ra = add64(mul64(u32(select(gi(f_rr, i), 0i, gi(f_open, i) != 0i)), RA_K), vec2u(sum >> 1u, 0u)); // R A in Q33 m3 a year, to round
  wi(f_sso, i, i32(divw(ra.y, ra.x, sum).x));
}
var<workgroup> wch: atomic<u32>;
// The CPU sweeps the cells in row order, each seeing its west and north neighbours already moved. A sweep along the
// anti-diagonals x + y = const moves every cell after the same neighbours and before the same ones, so it gives the
// same heads as the row sweep (the cells of one diagonal do not touch each other); thread t is the column x = t.
@compute @workgroup_size(256)
fn aquifer(@builtin(local_invocation_index) t: u32) {
  let most = P[0];
  var sweeps = 0u;
  for (var it = 0u; it < most; it++) {
    if (t == 0u) { atomicStore(&wch, 0u); }
    storageBarrier(); workgroupBarrier();
    var mine = 0u;
    for (var dg = 2u; dg <= 508u; dg++) {
      let y = dg - t;
      if (t >= 1u && t <= 254u && dg > t && y <= 254u) {
        let i = y * 256u + t;
        if (F[f_isf + i] == 0i) {
          var acc = mul64(bitcast<u32>(F[f_head + i - 1u] + OFF), gu(f_ww, i));
          acc = add64(acc, mul64(bitcast<u32>(F[f_head + i + 1u] + OFF), gu(f_we, i)));
          acc = add64(acc, mul64(bitcast<u32>(F[f_head + i - 256u] + OFF), gu(f_wn, i)));
          acc = add64(acc, mul64(bitcast<u32>(F[f_head + i + 256u] + OFF), gu(f_ws, i)));
          acc = add64(acc, vec2u(0x40000000u, 0u));
          let want = bitcast<i32>((acc.x >> 31u) | (acc.y << 1u)) - OFF + gi(f_sso, i);
          let hc = F[f_head + i];
          let d = want - hc;
          let v = min(gi(f_h, i), hc + d + (3i * d + select(-2i, 2i, d >= 0i)) / 5i);
          mine = max(mine, u32(abs(v - hc)));
          F[f_head + i] = v;
        }
      }
      storageBarrier(); workgroupBarrier();
    }
    atomicMax(&wch, mine);
    storageBarrier(); workgroupBarrier();
    sweeps = it + 1u;
    if (t == 0u) { wuni = select(0u, 1u, atomicLoad(&wch) < SWEEP_TOL); }
    workgroupBarrier();
    if (workgroupUniformLoad(&wuni) == 1u) { break; }
  }
  if (t == 0u) { wi(f_misc, P[1], i32(sweeps)); }
}
// what comes out of the ground in each cell, m3 a year Q6
@compute @workgroup_size(256)
fn outflux(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let x = i & 255u; let y = i >> 8u;
  if (x < 1u || x > 254u || y < 1u || y > 254u) { return; }
  let hc = gi(f_head, i);
  var s = mul64(u32(select(gi(f_rr, i), 0i, gi(f_open, i) != 0i)), RA_K);
  s = add64(s, smul64(gi(f_head, i - 1u) - hc, gu(f_ce, i - 1u)));
  s = add64(s, smul64(gi(f_head, i + 1u) - hc, gu(f_ce, i)));
  s = add64(s, smul64(gi(f_head, i - 256u) - hc, gu(f_cs, i - 256u)));
  s = add64(s, smul64(gi(f_head, i + 256u) - hc, gu(f_cs, i)));
  wi(f_out, i, sat32(rsar64(s, 27u)));
}

// ---------- the open water's evaporation over a year, mm Q16 summed over the seasons, at a depth (water.ts openKc) ----------
fn lake_mm(depth: i32, i: u32) -> i32 {
  let t = clamp(((depth - 2i * ONE_Z) / 3i) >> 4u, 0i, 65536i);
  var sum = 0i;
  for (var s = 0u; s < 4u; s++) {
    let kc = KCS + qmul(KC_DEEP[s] - KCS, t);
    sum += gs(f_pr0, s, i) - qmul(kc, gs(f_pe0, s, i));
  }
  return sum;
}

// ---------- gw, back, the lakes' net, and the season weights (water.ts route) ----------
@compute @workgroup_size(256)
fn routeprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let sea = gi(f_sea, i) != 0i;
  let open = gi(f_open, i) != 0i;
  let rr = gi(f_rr, i);
  let rs = select(rr, 0i, open);
  var gw = 0i; var bk = 0i; var ln = 0i;
  if (!sea) {
    if (open) { ln = mm_v(lake_mm(gi(f_depth, i), i)); }
    let o = gi(f_out, i);
    if (gi(f_isf, i) != 0i) { gw = o; }
    else if (!(gi(f_head, i) < gi(f_h, i)) && o > 0i) { bk = min(mm_v(rs), o); gw = o - bk; }
  }
  wi(f_gw, i, gw); wi(f_bk, i, bk); wi(f_ln, i, ln);
  let wet = gi(f_wet, i);
  for (var s = 0u; s < 4u; s++) {
    let su = gs(f_su0, s, i);
    let share = select(0i, qdiv(su, wet), wet > 0i);
    let run = select(mm_v(su - qmul(share, rr)), 0i, open);
    let q = sat32(rsar64(smul64(bk, u32(share)), 16u)) + run;
    F[f_qk0 + s * LEN + i] = q;
    F[f_wt0 + s * LEN + i] = q + ((gw + ln + 2i) >> 2u);
  }
  wi(f_wt4, i, gw);
}
@compute @workgroup_size(256)
fn routefin(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  var sum = 0u;
  for (var s = 0u; s < 4u; s++) {
    let f = ld64(f_ga0l + 2u * s * LEN, i);
    let pos = select(f, vec2u(0u), isneg64(f));
    let sf = min(usat32(mulhi64(pos, C_SEASON)), 0x1fffffffu);
    F[f_sf0 + s * LEN + i] = bitcast<i32>(sf);
    sum += sf;
  }
  let flow = (sum + 2u) >> 2u;
  wu(f_flow, i, flow);
  let fg = ld64(f_ga4l, i);
  var base = 0i;
  if (flow > 0u && !isneg64(fg)) {
    let q = usat32(mulhi64(fg, C_YEAR));
    if (q >= flow) { base = 65536i; } else if (q > 0u) { base = i32(divw(q >> 16u, q << 16u, flow).x); }
  }
  wi(f_base, i, base);
}
// the quick runoff each season, summed over every cell, 64 bits
var<workgroup> wql: array<vec2u, 256>;
@compute @workgroup_size(256)
fn quicksum(@builtin(local_invocation_index) t: u32) {
  for (var s = 0u; s < 4u; s++) {
    var acc = vec2u(0u);
    for (var i = t; i < LEN; i += 256u) { acc = add64(acc, s64(gs(f_qk0, s, i))); }
    wql[t] = acc;
    workgroupBarrier();
    for (var h = 128u; h > 0u; h = h >> 1u) {
      if (t < h) { wql[t] = add64(wql[t], wql[t + h]); }
      workgroupBarrier();
    }
    if (t == 0u) { wu(f_misc, MISC_QUICK + 2u * s, wql[0].x); wu(f_misc, MISC_QUICK + 2u * s + 1u, wql[0].y); }
    workgroupBarrier();
  }
}

// ---------- the lakes ----------
// the inflow into each hollow cell from outside its hollow, m3 a year Q6, 64 bits
@compute @workgroup_size(256)
fn lakeprep(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let hi = gi(f_hol, i);
  if (hi < 0i) { return; }
  let x = i32(i & 255u); let y = i32(i >> 8u);
  var acc = vec2u(0u);
  for (var d = 0u; d < 8u; d++) {
    let nx = x + DX[d]; let ny = y + DY[d];
    if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
    let k = u32(ny) * 256u + u32(nx);
    if (gu(f_to, k) != i || gi(f_hol, k) == hi) { continue; }
    acc = add64(acc, sar64(mul64(gu(f_flow, k), K_YEAR), 16u));
  }
  wu(f_inl, i, acc.x); wu(f_inh, i, acc.y);
}

// Each basin cell is a candidate lake level against every cell of its hollow (water.ts lakes): the hollow's cells by
// height, ties by index; a candidate of rank n counts its n lower cells as lake at its own height and the rest as dry
// ground. The highest candidate (rank 1 or more) whose balance is not negative is the level; the whole hollow full to
// its spill height is tried first, by the hollow's least cell.
@compute @workgroup_size(256)
fn lakecand(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let ci = gu(f_blist, g.x);
  let L = gi(f_hol, ci);
  let hc = gi(f_h, ci);
  var base = vec2u(0u);
  var terms = vec2u(0u);
  var spill = -FX_MAX;
  var rank = 0u;
  for (var k = 0u; k < B; k++) {
    let j = gu(f_blist, k);
    if (gi(f_hol, j) != L) { continue; }
    let hj = gi(f_h, j);
    base = add64(base, add64(ld64(f_inl, j), s64(gi(f_gw, j))));
    spill = max(spill, gi(f_filled, j));
    if (hj < hc || (hj == hc && j < ci)) { rank++; terms = add64(terms, s64(mm_v(lake_mm(hc - hj, j)))); }
    else { terms = add64(terms, s64(mm_v(gi(f_wet, j)))); }
  }
  wu(f_rk, ci, rank);
  if (rank >= 1u && !isneg64(add64(base, terms))) { atomicMax(&AT[a_lbest + u32(L)], rank + 1u); }
  if (u32(L) == ci) {
    var tot = base;
    for (var k = 0u; k < B; k++) {
      let j = gu(f_blist, k);
      if (gi(f_hol, j) != L) { continue; }
      tot = add64(tot, s64(mm_v(lake_mm(spill - gi(f_h, j), j))));
    }
    atomicStore(&AT[a_lsp + ci], select(0u, 1u, !isneg64(tot)));
    wi(f_lv, ci, spill);
  }
}
@compute @workgroup_size(256)
fn lakelevel(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let c = gu(f_blist, g.x);
  let L = u32(gi(f_hol, c));
  let best = atomicLoad(&AT[a_lbest + L]);
  if (atomicLoad(&AT[a_lsp + L]) == 0u && best > 0u && gu(f_rk, c) == best - 1u) { wi(f_lv, L, gi(f_h, c)); }
}
@compute @workgroup_size(256)
fn lakewater(@builtin(global_invocation_id) g: vec3u) {
  let B = atomicLoad(&AT[a_cnt]);
  if (g.x >= B) { return; }
  let c = gu(f_blist, g.x);
  let L = u32(gi(f_hol, c));
  let sp = atomicLoad(&AT[a_lsp + L]);
  let has = sp == 1u || atomicLoad(&AT[a_lbest + L]) > 0u;
  wi(f_water, c, select(0i, max(0i, gi(f_lv, L) - gi(f_h, c)), has));
  if (L == c) {
    wi(f_spl, L, i32(sp));
    if (has) { atomicAdd(&AT[a_cnt + 2u], 1u); }
  }
}
@compute @workgroup_size(256)
fn afterlake(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_sea, i) != 0i) { wi(f_water, i, -gi(f_h, i)); }
  let w = gi(f_water, i);
  wi(f_open, i, select(0i, 1i, w > 0i));
  wi(f_depth, i, w);
}

// ---------- the table, the springs and the seasons ----------
@compute @workgroup_size(256)
fn tables(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_open, i) != 0i) { wi(f_chn, i, 0i); return; }
  wi(f_tab, i, max(0i, gi(f_h, i) - gi(f_head, i)));
  let gw = gi(f_gw, i);
  wu(f_spring, i, select(0u, usat32(mulhi64(s64(gw), C_YEAR)), gw > 0i));
}
// The table in the middle of each season and the deepest it falls (water.ts 349 to 366): each season's net water the
// ground holds over the year's mean, over its specific yield. mm Q16 throughout until the rise, which is Z.
@compute @workgroup_size(256)
fn seasons(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_open, i) != 0i) { return; }
  let drift = gu(f_drift, i);
  let sy = select(DRIFT_SY[drift], ROCK_SY[gu(f_rock, i)], drift == ${BARE}u);
  let tab = gi(f_tab, i);
  let floor = max(tab, ROOTS_Z);
  let up = i32(min(mulshr(gu(f_spring, i), UP_K, 16u), 0x7fffffffu));
  let wet = gi(f_wet, i); let rr = gi(f_rr, i);
  var net = array<i32, 4>(0i, 0i, 0i, 0i);
  var mean = 0i;
  for (var s = 0u; s < 4u; s++) {
    // rr x surplus / wet in 64 bits: their product in mm2 passes what a Q16 word holds
    let p = add64(mul64(u32(rr), u32(gs(f_su0, s, i))), vec2u(u32(wet) >> 1u, 0u));
    let into = select(rr / 4i, i32(divw(p.y, p.x, max(u32(wet), 1u)).x), wet > 0i);
    let drawn = select(0i, max(0i, gs(f_sh0, s, i) - up), tab <= ROOTS_Z);
    net[s] = into - drawn;
    mean += net[s];
  }
  mean = (mean + 2i) >> 2u;
  var held = array<i32, 4>(0i, 0i, 0i, 0i);
  var sum = 0i; var heldMean = 0i;
  for (var s = 0u; s < 4u; s++) {
    let d = net[s] - mean;
    held[s] = sum + (d >> 1u);
    sum += d;
    heldMean += held[s];
  }
  heldMean = (heldMean + 2i) >> 2u;
  var dry = 0i;
  for (var s = 0u; s < 4u; s++) {
    let x = held[s] - heldMean;
    var st = tab;
    if (sy > 0i) { st = clamp(tab - sscale(qdiv(x, sy), RISE_Z), 0i, floor); }
    else if (x > 0i) { st = 0i; }
    else if (x < 0i) { st = floor; }
    F[f_stb0 + s * LEN + i] = st;
    dry = max(dry, st);
  }
  wi(f_dry, i, dry);
}

// ---------- the channels' bankfull flood and its power, the floodplains ----------
@compute @workgroup_size(256)
fn banks(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_sea, i) != 0i) { return; }
  let q = bank_flow(i);
  wu(f_qbf, i, q);
  let s = gu(f_slope, i);
  if (gi(f_chn, i) != 0i && q > 0u) {
    let p = mul64(sqrt_q28(q), s);
    let w = add64(mul64((p.x >> 30u) | (p.y << 2u), u32(POWER_K)), vec2u(1u << 27u, 0u));
    wi(f_pwr, i, bitcast<i32>((w.x >> 28u) | (w.y << 4u)));
    if (gu(f_to, i) != i) { wi(f_dbf, i, bank_depth_z(q, slope35(i))); }
  }
}
// the cell each cell drains to that is a channel or open water, walking up from the sea
@compute @workgroup_size(256)
fn reach(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wmax = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wmax);
  for (var d = 0u; d <= top; d++) {
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) {
      let i = gu(f_lvl, p);
      let j = gu(f_to, i);
      var tg = -1i;
      if (gi(f_chn, i) != 0i || gi(f_open, i) != 0i) { tg = i32(i); }
      else if (j != i) { tg = gi(f_tgt, j); }
      wi(f_tgt, i, tg);
    }
    storageBarrier(); workgroupBarrier();
  }
}
@compute @workgroup_size(256)
fn valley(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let tg = gi(f_tgt, i);
  if (tg < 0i) { return; }
  let t = u32(tg);
  if (gi(f_chn, t) == 0i || gi(f_open, i) != 0i || gi(f_pwr, t) > CONFINED_Q16) { return; }
  let rise = sat32(rsar64(smul64(gi(f_dbf, t), u32(RISE_Q16)), 16u));
  if (gi(f_h, i) - gi(f_h, t) > rise) { return; }
  wi(f_valley, i, 1i);
  atomicAdd(&AT[a_plc + t], 1u);
}
// what a stream's valley fill carries under its bed: T_FILL S W, W the wider of the channel and its floodplain over the reach
@compute @workgroup_size(256)
fn under(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_chn, i) == 0i || gi(f_sea, i) != 0i) { return; }
  let q = gu(f_qbf, i);
  let bw = add64(mul64(sqrt_q28(q), u32(WOOD_W)), vec2u(0u, 2u)).y >> 2u;
  let j = gu(f_to, i);
  let diag = ((j & 255u) != (i & 255u)) && ((j >> 8u) != (i >> 8u));
  let plain = atomicLoad(&AT[a_plc + i]) * select(${CELL * 1024}u, ${Math.round((CELL / Math.SQRT2) * 1024)}u, diag);
  let w = max(bw, plain);
  let r = mulhi64(mul64(gu(f_slope, i), w), TFILL);
  wu(f_rtl, i, r.x); wu(f_rth, i, r.y);
}
// a spring: groundwater out of the ground at more than a pool of it would evaporate, the most of its neighbours
@compute @workgroup_size(256)
fn springs(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let sp = gu(f_spring, i);
  if (sp == 0u || gi(f_open, i) != 0i) { return; }
  var short = 0i;
  for (var s = 0u; s < 4u; s++) { short += max(0i, qmul(KCS, gs(f_pe0, s, i)) - gs(f_pr0, s, i)); }
  if (sp < mul64(u32(short), SPRING_K).y) { return; }
  let x = i32(i & 255u); let y = i32(i >> 8u);
  for (var d = 0u; d < 8u; d++) {
    let nx = x + DX[d]; let ny = y + DY[d];
    if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
    if (gu(f_spring, u32(ny) * 256u + u32(nx)) > sp) { return; }
  }
  wi(f_spf, i, 1i);
}
`;

export const WATER_WGSL = (FIXED + consts + `
const MISC_MAXD = ${MISC.maxd}u;
const MISC_ROUNDS = ${MISC.rounds}u;
const MISC_QUICK = ${MISC.quick}u;
` + wgsl).replace(/(@compute @workgroup_size\(256\)\nfn \w+\(.*\) \{)/g, "$1\n  touch();");
export const ENTRIES = ["prep", "hollows", "levels", "weights", "gather", "flow0", "channels", "fixedset", "aqprep", "aqw", "aquifer", "outflux", "routeprep", "routefin", "quicksum", "lakeprep", "lakecand", "lakelevel", "lakewater", "afterlake", "tables", "seasons", "banks", "reach", "valley", "under", "springs"] as const;
