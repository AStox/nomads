// The globe's atmosphere on the GPU (host side, laws and constants: src/gpu/globe/atmosphere.ts; the research behind it:
// docs/research/globe/2026-10-19-atmosphere-impl.md). Four entry points, all integer, no float between a buffer read and a
// buffer write; each has a TypeScript twin in atmosphere.ts that the test compares with the kernel bit for bit.
//
// Cells. A cell is the sphere grid's (face, X, Y) at id = (face * fn + Y) * fn + X, one i32 word a field, field after field in
// the state buffer S (field f of cell id at f * N + id). The static geometry G holds, for each cell and each of its four
// neighbours (0 east, 1 north, 2 west, 3 south in the face's own axes): the neighbour's id, the link's length over the cell's
// area (Q28, 1 / m), and the unit normal of the shared edge (pointing to the neighbour) in the cell's own east and north and in
// the neighbour's (Q14), then each cell's latitude as an index into the 721 latitude nodes (0.25 degree) and its fraction (Q16).
// The tables T hold the saturation column at 1/16 K steps and the season's zonal tables on the 721 nodes.
//
// Fixed point (a value x is held as round(x * 2^n), Qn; the formats are [design] choices, sized by the ranges [derived]):
// - heights above the sea, ELEV: Q6 m (an i32 holds 33,000 km); slopes, SLX and SLY: Q16 m/m;
// - temperatures: Q16 degrees C (a range of 32,768 degrees);
// - winds U (east) and V (north), U0 and V0 and the zonal tables': Q16 m/s (an edge wind of the kernel's own resolution, 1.5e-5
//   m/s, so that the divergence of a smooth wind, 1e-6 /s over a 12 km cell, is not drowned: at Q10 the rounding was 6e-8 /s);
// - insolation INS: Q8 W/m2;
// - the water: vapour M, cloud water C and falling hydrometeors H, and the rain of a step, Q20 mm (an i32 holds 2,047 mm; the
//   column's saturation at 90 C is 1,044 mm, the host checks the accumulators);
// - rates: a link's rate (edge wind times length over the cell's area, 1/s), the evaporation, conversion and fall rates and the
//   air's adjustment to the ground below it: Q30 1/s; a rate times the step's seconds is the fraction a step moves, Q30 (the
//   host's step keeps the sum of a cell's four link fractions under 0.8, so no word passes 2^30);
// - the sea ice's thickness: Q16 m.
// A product of two words goes through a 64-bit intermediate (mulShr: a * b / 2^s rounded half away from zero) so no word holds
// less than it could.
import { FIXED } from "./fixed";

export const FIELD = {
  ELEV: 0, SLX: 1, SLY: 2, LAND: 3,
  U: 4, V: 5, TS: 6, SST: 7, INS: 8, LAP: 9, FE: 10, MSAT: 11, FC: 12, FF: 13, ICE: 14,
  R: 15, // four link rates, R .. R + 3
  ST: 19, // two sets of five state fields (TA, M, C, H, PP), ST .. ST + 4 and ST + 5 .. ST + 9
  PACC: 29, EACC: 30, RACC: 31, TN: 32, SNOW: 33,
  U0: 34, V0: 35, // the zonal table's wind at the cell, before the terrain's blocking
  COUNT: 36,
} as const;
export const STATE = { TA: 0, M: 1, C: 2, H: 3, PP: 4 } as const;

// The static geometry's layout, in units of N words: the four neighbours, the four links' length over area (Q28), the four links'
// normals (the cell's east and north, the neighbour's east and north: four words a link, Q14), the cell's latitude node and
// fraction, and for each link its midpoint's latitude node and fraction and the normal on the east and north of the midpoint
// (four words a link).
export const GEO = { NBR: 0, LC: 4, NRM: 8, LAT: 24, FRAC: 25, EDGE: 26, UNITS: 42 } as const;
// The tables: the saturation column (Q20 mm) at 1/16 K from CAP_FROM degrees; the season's zonal tables, node after node.
export const CAP_FROM = -120, CAP_TO = 90, CAP_PER_K = 16, NCAP = (CAP_TO - CAP_FROM) * CAP_PER_K + 1;
// The zonal tables' nodes are every 0.05 degrees (1.7 km, a seventh of a cell): between nodes the tables are read linearly, so the
// divergence of a smooth wind is off by (the wind's second derivative) x (half a node), 1e-8 /s against a 1e-6 signal.
export const NODE_DEG = 0.05, NODES = 3601;
export const TAB = { CAP: 0, LT: 3392, INS: 0, TL: 1, TW: 2, U: 3, V: 4, COLS: 5 } as const;
export const TABLE_WORDS = TAB.LT + TAB.COLS * NODES;
export const PARAM = { N: 0, DT: 1, ACC: 2, PAR: 3, BLOCK_L: 4, WORDS: 8 } as const;

// The constants the kernels use, each a Qn integer made by the host from its cited or tagged value.
export interface Kq {
  gammaQ22: number; // the lapse rate, K per m, Q22
  blockN: number; // N_m in m/s per km of rise, Q16
  gust: number; // the least wind the surface exchange sees, Q16 m/s
  ke: number; // C_E over H_w, 1/m, Q44
  ghw: number; // lapse rate times H_w, K, Q16
  tf: number; // the sea's freezing point, Q16 C
  kice: number; // Stefan's constant of a season: 2 k t / (rho L), m2 per K, Q16
  rh0: number; // the first guess of the column's share of saturation, Q16
  ft: number; // the air's adjustment rate to the ground, Q30 1/s
  snowHi: number; // the temperature above which all precipitation is rain, Q16 C
  snowInv: number; // 1 / (the width of the mixed range), Q16 per K
  tauCIce: number; tauCWarm: number; tauFRain: number; tauFSnow: number; // the rain stage's cloud delays, s
}

export function atmosphereWgsl(k: Kq): string {
  const capBase = -CAP_FROM * 65536, capMax = (NCAP - 1) * (65536 / CAP_PER_K) - 1;
  return /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read_write> S: array<i32>;
@group(0) @binding(1) var<storage, read> G: array<i32>;
@group(0) @binding(2) var<storage, read> T: array<i32>;
@group(0) @binding(3) var<storage, read> P: array<u32>;

const F_ELEV = ${FIELD.ELEV}u; const F_SLX = ${FIELD.SLX}u; const F_SLY = ${FIELD.SLY}u; const F_LAND = ${FIELD.LAND}u;
const F_U = ${FIELD.U}u; const F_V = ${FIELD.V}u; const F_TS = ${FIELD.TS}u; const F_SST = ${FIELD.SST}u; const F_INS = ${FIELD.INS}u;
const F_LAP = ${FIELD.LAP}u; const F_FE = ${FIELD.FE}u; const F_MSAT = ${FIELD.MSAT}u; const F_FC = ${FIELD.FC}u; const F_FF = ${FIELD.FF}u;
const F_ICE = ${FIELD.ICE}u; const F_R = ${FIELD.R}u; const F_ST = ${FIELD.ST}u;
const F_PACC = ${FIELD.PACC}u; const F_EACC = ${FIELD.EACC}u; const F_RACC = ${FIELD.RACC}u; const F_TN = ${FIELD.TN}u; const F_SNOW = ${FIELD.SNOW}u;
const F_U0 = ${FIELD.U0}u; const F_V0 = ${FIELD.V0}u;
const LT = ${TAB.LT}u;
const CAP_BASE = ${capBase}i; const CAP_MAXX = ${capMax}i;

fn touch() { _ = S[0]; _ = G[0]; _ = T[0]; _ = P[0]; }
fn flatIndex(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }

// a * b / 2^s rounded half away from zero, through 64 bits, s in 1 to 31, the result inside an i32.
fn mulShr(a: i32, b: i32, s: u32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  let r = add64(mul64(mag(a), mag(b)), vec2u(1u << (s - 1u), 0u));
  let q = bitcast<i32>((r.x >> s) | (r.y << (32u - s)));
  return select(q, -q, neg);
}

// A season table's column read between nodes: the node's word and the next one's, frac of the way (Q16).
fn interp(col: u32, i: u32, frac: i32) -> i32 {
  let a = T[LT + col * ${NODES}u + i]; let b = T[LT + col * ${NODES}u + i + 1u];
  return a + mulShr(b - a, frac, 16u);
}
// The column's saturation, mm (Q20), at a temperature (Q16 C): the host's table at 1/${CAP_PER_K} K read between its entries.
fn capAt(t: i32) -> i32 {
  let x = clamp(t + CAP_BASE, 0i, CAP_MAXX);
  let i = u32(x >> 12u); let f = x & 4095i;
  let a = T[i]; let b = T[i + 1u];
  return a + mulShr(b - a, f, 12u);
}

// One thread a cell: the season's surface. The prevailing wind from the zonal table, with the part of it that runs into a
// slope steep enough to block it taken out; the ground's sea-level temperature (the land's or the sea's column), the sea
// surface (not below freezing), the sea ice, the lapse term of the height, the rates of evaporation and of the cloud's
// two delays, and the first state of the run.
@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg); let n = P[0];
  if (idx >= n) { return; }
  let land = S[F_LAND * n + idx] != 0i;
  let li = u32(G[GEO_LAT * n + idx]); let lf = G[GEO_FRAC * n + idx];
  let ins = interp(${TAB.INS}u, li, lf);
  let tl = interp(${TAB.TL}u, li, lf); let tw = interp(${TAB.TW}u, li, lf);
  let u0 = interp(${TAB.U}u, li, lf); let v0 = interp(${TAB.V}u, li, lf);
  var u = u0; var v = v0;
  let gE = S[F_SLX * n + idx]; let gN = S[F_SLY * n + idx];
  let gm = qsqrt(qmul(gE, gE) + qmul(gN, gN));
  let sp = qsqrt(qmul(u, u) + qmul(v, v));
  if (gm > 0i && sp > 0i) {
    let zk = qmul(gm, bitcast<i32>(P[${PARAM.BLOCK_L}u]));
    let den = qmul(${k.blockN}i, zk);
    var b = 0i;
    if (den > 0i) { b = max(0i, 65536i - qdiv(sp, den)); }
    if (b > 0i) {
      let nE = qdiv(gE, gm); let nN = qdiv(gN, gm);
      let up = qmul(u, nE) + qmul(v, nN);
      if (up > 0i) { let w = qmul(b, up); u = u - qmul(w, nE); v = v - qmul(w, nN); }
    }
  }
  let sp2 = qsqrt(qmul(u, u) + qmul(v, v));
  let elev = S[F_ELEV * n + idx];
  let lap = mulShr(elev, ${k.gammaQ22}i, 12u);
  var ts = tw; if (land) { ts = tl; }
  let tsurf = ts - lap;
  var sst = 0i; var ice = 0i; var msat = 0i;
  if (!land) {
    sst = max(tw, ${k.tf}i);
    if (tw < ${k.tf}i) { ice = qsqrt(qmul(${k.tf}i - tw, ${k.kice}i)); }
    msat = capAt(sst);
  }
  var fe = mulShr(max(sp2, ${k.gust}i), ${k.ke}i, 30u);
  if (ice > 0i) { fe = 0i; }
  var f = 65536i;
  if (tsurf > 0i) { f = qexp(-qdiv(tsurf, ${k.ghw}i)); }
  let tauc = (f * ${k.tauCIce}i + (65536i - f) * ${k.tauCWarm}i + 32768i) >> 16u;
  let tauf = ((65536i - f) * ${k.tauFRain}i + f * ${k.tauFSnow}i + 32768i) >> 16u;
  S[F_U * n + idx] = u; S[F_V * n + idx] = v;
  S[F_U0 * n + idx] = u0; S[F_V0 * n + idx] = v0;
  S[F_TS * n + idx] = ts; S[F_SST * n + idx] = sst; S[F_INS * n + idx] = ins; S[F_LAP * n + idx] = lap;
  S[F_FE * n + idx] = fe; S[F_MSAT * n + idx] = msat; S[F_ICE * n + idx] = ice;
  S[F_FC * n + idx] = i32((1073741824u + u32(tauc) / 2u) / u32(tauc));
  S[F_FF * n + idx] = i32((1073741824u + u32(tauf) / 2u) / u32(tauf));
  S[F_ST * n + idx] = ts;
  S[(F_ST + 1u) * n + idx] = mulShr(capAt(tsurf), ${k.rh0}i, 16u);
  S[(F_ST + 2u) * n + idx] = 0i; S[(F_ST + 3u) * n + idx] = 0i; S[(F_ST + 4u) * n + idx] = 0i;
  S[F_PACC * n + idx] = 0i; S[F_EACC * n + idx] = 0i; S[F_RACC * n + idx] = 0i;
}

// One thread a cell: the four links' rates. The wind through the edge (positive out of the cell) is the zonal table's wind at the
// edge's own midpoint, along the edge's normal (east and north of the midpoint: exact where the wind is the table's, which a
// mean of the two cells' winds is not across the grid's kinked lines), plus the mean of the two cells' departures from the
// table (the terrain's blocking) along the normal in each cell's own east and north; times the edge's length over this cell's
// area it is the rate (1/s) at which this cell's air leaves (positive) or arrives (negative) through the link. The other cell
// of the link takes the same edge wind with the opposite sign, to the word.
@compute @workgroup_size(256)
fn edges(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg); let n = P[0];
  if (idx >= n) { return; }
  let di = vec2i(S[F_U * n + idx] - S[F_U0 * n + idx], S[F_V * n + idx] - S[F_V0 * n + idx]);
  for (var d = 0u; d < 4u; d++) {
    let j = u32(G[(GEO_NBR * n) + idx * 4u + d]);
    let b = GEO_NRM * n + (idx * 4u + d) * 4u;
    let e = GEO_EDGE * n + (idx * 4u + d) * 4u;
    let um = interp(${TAB.U}u, u32(G[e]), G[e + 1u]); let vm = interp(${TAB.V}u, u32(G[e]), G[e + 1u]);
    let dj = vec2i(S[F_U * n + j] - S[F_U0 * n + j], S[F_V * n + j] - S[F_V0 * n + j]);
    // Q14 normal times Q16 wind, to Q16: the zonal wind in full, half of each cell's departure from it
    let un = mulShr(G[e + 2u], um, 14u) + mulShr(G[e + 3u], vm, 14u) + mulShr(G[b], di.x, 15u) + mulShr(G[b + 1u], di.y, 15u) + mulShr(G[b + 2u], dj.x, 15u) + mulShr(G[b + 3u], dj.y, 15u);
    S[(F_R + d) * n + idx] = mulShr(un, G[GEO_LC * n + idx * 4u + d], 14u);
  }
}

// One time step of the moist air, one thread a cell, from the state set P[3] to the other. Upwind: a cell's vapour, cloud water
// and falling hydrometeors leave through the links whose rate is positive and arrive through the neighbours' whose rate is
// negative; the air's sea-level temperature moves the same way (the advective form: only what arrives, as a difference);
// the sea gives vapour at a bulk rate to its surface's saturation, the land at the same rate to what the rain it just had
// leaves it, none stored; what the column holds above its saturation (at the air's temperature less the height's lapse)
// becomes cloud water, which becomes hydrometeors and these fall, each at its own delay.
@compute @workgroup_size(256)
fn step(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg); let n = P[0];
  if (idx >= n) { return; }
  let dt = i32(P[${PARAM.DT}u]); let par = P[${PARAM.PAR}u];
  let fa = F_ST + 5u * par; let fb = F_ST + 5u * (1u - par);
  let ta = S[fa * n + idx]; let m = S[(fa + 1u) * n + idx]; let c = S[(fa + 2u) * n + idx]; let h = S[(fa + 3u) * n + idx]; let pp = S[(fa + 4u) * n + idx];
  var fo = 0i; var inM = 0i; var inC = 0i; var inH = 0i; var dT = 0i;
  for (var d = 0u; d < 4u; d++) {
    let r = S[(F_R + d) * n + idx];
    if (r > 0i) { fo += r * dt; }
    else if (r < 0i) {
      let w = -r * dt; let j = u32(G[GEO_NBR * n + idx * 4u + d]);
      inM += mulShr(S[(fa + 1u) * n + j], w, 30u);
      inC += mulShr(S[(fa + 2u) * n + j], w, 30u);
      inH += mulShr(S[(fa + 3u) * n + j], w, 30u);
      dT += mulShr(S[fa * n + j] - ta, w, 30u);
    }
  }
  var mn = m - mulShr(m, fo, 30u) + inM;
  var cn = c - mulShr(c, fo, 30u) + inC;
  var hn = h - mulShr(h, fo, 30u) + inH;
  let cap = capAt(ta - S[F_LAP * n + idx]);
  let fe = S[F_FE * n + idx] * dt;
  let land = S[F_LAND * n + idx] != 0i;
  var e = 0i;
  if (land) { e = min(mulShr(max(0i, cap - mn), fe, 30u), pp); }
  else { e = mulShr(max(0i, S[F_MSAT * n + idx] - mn), fe, 30u); }
  mn += e;
  if (mn > cap) { cn += mn - cap; mn = cap; }
  let q = mulShr(cn, S[F_FC * n + idx] * dt, 30u);
  cn -= q; hn += q;
  let p = mulShr(hn, S[F_FF * n + idx] * dt, 30u);
  hn -= p;
  let tn = ta + dT + mulShr(S[F_TS * n + idx] - ta, ${k.ft}i * dt, 30u);
  S[fb * n + idx] = tn; S[(fb + 1u) * n + idx] = mn; S[(fb + 2u) * n + idx] = cn; S[(fb + 3u) * n + idx] = hn; S[(fb + 4u) * n + idx] = p;
  if (P[${PARAM.ACC}u] != 0u) {
    S[F_PACC * n + idx] += p; S[F_EACC * n + idx] += e;
    if (land) { S[F_RACC * n + idx] += pp - e; }
  }
}

// One thread a cell: the near-surface temperature (the air's sea-level temperature less the height's lapse) and the share of
// the window's precipitation that fell as snow (all of it below the mixed range's lower end, none above its upper).
@compute @workgroup_size(256)
fn finish(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg); let n = P[0];
  if (idx >= n) { return; }
  let fa = F_ST + 5u * P[${PARAM.PAR}u];
  let tn = S[fa * n + idx] - S[F_LAP * n + idx];
  let sf = clamp(qmul(${k.snowHi}i - tn, ${k.snowInv}i), 0i, 65536i);
  S[F_TN * n + idx] = tn;
  S[F_SNOW * n + idx] = mulShr(S[F_PACC * n + idx], sf, 16u);
}
`.replace(/GEO_(NBR|LC|NRM|LAT|FRAC|EDGE)/g, (_, w: keyof typeof GEO) => `${GEO[w]}u`);
}
