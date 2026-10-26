// Erosion and deposition on the globe's grid, on the GPU (host side, laws, constants and sources: src/gpu/globe/erosion.ts and
// docs/research/globe/2026-10-19-erosion-impl.md). The kernels are appended to the grid's own source (globe-grid.ts), so they
// share its bindings (S the tectonics state in the padded tile layout, T the tables, P the parameters) and its helpers, and
// add four: E the erosion's own fields (one i32 word a cell, in the tables' cell order k = slot * 65536 + y * 256 + x, which
// at tier 0 is the cell number (face * 256 + y) * 256 + x), AT the atomic words (the flooded surface, the depth sort's counts,
// counters, the ledger), X the read-only tables (the eight neighbours of each cell, the inverse of their distances, the ocean
// floor's thermal buoyancy by age) and G a scratch state of the grid's own fields, which the creep's halo exchange fills.
// All integer: no float sits between a buffer read and a buffer write.
//
// One substep, in the order the host records it:
//   height   the isostatic height of every column from its five rock volumes, in 1/256 m above the sea (HQ);
//   weights  each land cell's share of the discharge: its area times its rain over the reference rain;
//   flood    the flooded surface f = max(h, least neighbour f + eps) from the ocean inwards (priority flood), one round a
//            dispatch, until a round changes nothing: the one fixed point, so the order of threads never matters;
//   recv     every land cell drains to its steepest neighbour on the flooded surface, so the receivers form a forest rooted
//            at ocean cells (a strictly lower f at every step, no cycle);
//   tree     depth by pointer jumping, the cells filed by depth (a counting sort), the discharge area gathered deepest first;
//   kappa    each land cell's erodibility from the rock in the top skin of its column;
//   relief   the thickness the landscape-scale law of local relief (Montgomery and Brandon 2002) takes from each cell, from the heights before incision;
//   incise   the implicit stream power step (Braun and Willett 2013) in order of depth, receivers first;
//   waste    what the relief law takes beyond the river's incision (the larger of the two lowers the cell);
//   removal  the volume the incision took from each column and the dissolved share of it;
//   route    the sediment carried down the tree, deposited in lakes and (by Davy and Lague's deposition term) along the way;
//   ring     what reaches the sea spreads outward from the coast by rings (cells of equal distance), filling a graded shelf;
//   apply    rock removed from the top of each stack down, sediment laid on top.
// Hillslope creep and the sea floor's diffusion are separate small steps (creepin, the grid's halo exchange, creepflux, apply).
//
// Units. Heights HQ are 1/256 m (i32); volumes are the tectonics unit V = H a / 16 (H in m, a the cell's area weight, Q15 of
// the mean cell), 62,400 m3 on the mean cell; the discharge area ACC is in 1/512 of a mean cell at the reference rain (u32);
// the inverse distance to a neighbour RD is Q28 of 1/m; sediment fluxes are two words (lo, hi) of volume units.
import { SHIFT, TAB, globeWgsl } from "./globe-grid";
import { PHILOX } from "./rand";
import { PHYS } from "./globe-tectonics";

// Fields of E (flat cells).
export const EF = {
  H: 0, RHO: 1, W: 2, TO: 3, RD: 4, UA: 5, UB: 6, DA: 7, DB: 8, DP: 9, LVS: 10, ORD: 11, ACC: 12, KC: 13, ER: 14, RV: 15, DS: 16, PS: 17, AD: 18, QL: 19, QH: 20,
  CD: 21, CD2: 22, DV: 23, CL: 24, CH: 25, XL: 26, XH: 27, WL: 28, COUNT: 29,
} as const;
// AT regions: three of the cell count's words (the flooded surface, the depth histogram, its cursors), then 16 counters and the ledger.
export const CNT = { flags: 0, top: 1, changed: 2, spare: 3, COUNT: 16 } as const;
export const LED = { removed: 0, deposited: 1, dissolved: 2, COUNT: 3 } as const; // each four limbs of 8 bits: see the ledger kernel
export const FLAG = { chain: 1, depth: 2, flood: 4, pileUp: 8, sediment: 16 } as const;
export const MAXD = 16382; // the deepest flow path the counting sort holds, in cells

// Parameter words (P, u32).
export const PR = {
  sea16: 16, eps: 17, ringMax: 18, ring: 19, diss16: 20, g8: 21, upl: 22, kconst: 23, shelf: 24, nExp: 25, foLand: 26, foSea: 27, skin: 28, kc: 30, rc: 36, kdt: 37, e0: 38, // kc: five words from kc; rc, kdt, e0: the relief law (see `relief`)
  draw: 40, drawKey: 41, drawSeed: 42, kvar: 43, rho8: 44, // draw: 0 steepest descent, 1 the receiver drawn among the lower neighbours (see `recv`); the substep's number and the planet's seed key the draw; rho8: 1 the receiver by Rho8's random diagonal lengths
} as const;

// A layer of sediment laid on the water-loaded crust raises the surface by (rho_m - rho_s) / (rho_m - rho_w) of its thickness, 800 / 2300 [derived,
// cited densities R1411 sec. 2.2], so filling a gap in the surface takes this many times its height of sediment: Q16.
export const CAP_FACTOR = (PHYS.RHO_M - PHYS.RHO_W) / (PHYS.RHO_M - PHYS.RHO[1]);
const CAP_FACTOR_Q16 = Math.round(CAP_FACTOR * 65536);

export function erosionWgsl(edges: readonly (readonly { face: number; side: number; flip: boolean }[])[]): string {
  const DR = PHYS.RHO.map((r) => PHYS.RHO_M - r);
  const phi0 = PHYS.H0 * (PHYS.RHO_M - 2800);
  const fields = Object.entries(EF).filter(([k]) => k !== "COUNT").map(([k, v]) => `const E_${k}: u32 = ${v}u;`).join("\n");
  return /* wgsl */ `${globeWgsl(edges)}
@group(0) @binding(3) var<storage, read_write> E: array<i32>;
@group(0) @binding(4) var<storage, read_write> AT: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read> X: array<u32>;
@group(0) @binding(6) var<storage, read_write> G: array<i32>;

${fields}
const MAXD = ${MAXD}u;
const INF = 0x7fffffffi;
const NONE = 0xffffffffu;
const A_FL = 0u;
const CNT_FLAGS = ${CNT.flags}u; const CNT_TOP = ${CNT.top}u; const CNT_CHANGED = ${CNT.changed}u;
const FLAG_CHAIN = ${FLAG.chain}i; const FLAG_DEPTH = ${FLAG.depth}i; const FLAG_FLOOD = ${FLAG.flood}i; const FLAG_PILE = ${FLAG.pileUp}i; const FLAG_SED = ${FLAG.sediment}i;
const ORDER = array<u32, 5>(1u, 4u, 2u, 3u, 0u);
const DR = array<i32, 5>(${DR.join(", ")});
const PHI0_16 = ${phi0 * 16}i;
const ASHIFT = ${PHYS.AGE_SHIFT}u;
const AGE_MAX = ${PHYS.AGE_MAX}u;
const VOL_MAX = ${2 ** 28}u;
const CAPF = ${CAP_FACTOR_Q16}u;
const P_SEA = ${PR.sea16}u; const P_EPS = ${PR.eps}u; const P_RINGMAX = ${PR.ringMax}u; const P_RING = ${PR.ring}u; const P_DISS = ${PR.diss16}u; const P_G = ${PR.g8}u;
const P_UPL = ${PR.upl}u; const P_KCONST = ${PR.kconst}u; const P_SHELF = ${PR.shelf}u; const P_NEXP = ${PR.nExp}u; const P_FOL = ${PR.foLand}u; const P_FOS = ${PR.foSea}u;
const P_KVAR = ${PR.kvar}u; const P_DRAW = ${PR.draw}u; const P_DRAWKEY = ${PR.drawKey}u; const P_DRAWSEED = ${PR.drawSeed}u; const P_RHO8 = ${PR.rho8}u;
const P_SKIN = ${PR.skin}u; const P_KC = ${PR.kc}u; const P_RC = ${PR.rc}u; const P_KDT = ${PR.kdt}u; const P_E0 = ${PR.e0}u;

fn touch() {
  _ = S[0]; _ = T[0]; _ = P[0]; _ = E[0]; _ = atomicLoad(&AT[0]); _ = X[0]; _ = G[0];
}
fn cnt() -> u32 { return P[2] * 65536u; }
fn fwords() -> u32 { return P[2] * PAD2; }
fn pw(k: u32) -> u32 {
  let c = k & 65535u;
  return (k >> 16u) * PAD2 + ((c >> 8u) + 1u) * PAD + (c & 255u) + 1u;
}
fn e_get(f: u32, k: u32) -> i32 { return E[f * cnt() + k]; }
fn e_set(f: u32, k: u32, v: i32) { E[f * cnt() + k] = v; }
fn e_getu(f: u32, k: u32) -> u32 { return bitcast<u32>(E[f * cnt() + k]); }
fn e_setu(f: u32, k: u32, v: u32) { E[f * cnt() + k] = bitcast<i32>(v); }
fn s_get(f: u32, k: u32) -> u32 { return bitcast<u32>(S[f * fwords() + pw(k)]); }
fn s_set(f: u32, k: u32, v: u32) { S[f * fwords() + pw(k)] = bitcast<i32>(v); }
fn area_of(k: u32) -> u32 { return u32(T[k]); }
fn at_load(r: u32, k: u32) -> i32 { return atomicLoad(&AT[r + k]); }
fn flag(f: i32) { atomicOr(&AT[3u * cnt() + CNT_FLAGS], f); }
fn nbr8(k: u32, d: u32) -> u32 { return X[k * 8u + d]; }
fn invd8(k: u32, d: u32) -> u32 { return X[8u * cnt() + k * 8u + d]; }
fn pool(f: u32, k: u32) -> u32 { return s_get(f, k); }
fn col_total(k: u32) -> u32 { return pool(0u, k) + pool(1u, k) + pool(2u, k) + pool(3u, k) + pool(4u, k); }
fn is_land(k: u32) -> bool { return e_get(E_H, k) > 0i; }

// 64-bit helpers (vec2u: lo, hi)
fn shr64(v: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return v; }
  if (s >= 32u) { return vec2u(v.y >> (s - 32u), 0u); }
  return vec2u((v.x >> s) | (v.y << (32u - s)), v.y >> s);
}
fn min64(a: vec2u, b: vec2u) -> vec2u { return select(b, a, lt64(a, b)); }
fn sqrt64(n: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 0x80000000u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}
fn umulsh(a: u32, b: u32, s: u32) -> u32 { return shr64(add64(mul64(a, b), vec2u(1u << (s - 1u), 0u)), s).x; }
// v / n for a small n: the quotient and the remainder
fn div64small(v: vec2u, n: u32) -> array<u32, 3> {
  let qh = v.y / n; let rh = v.y % n;
  let lo = divw(rh, v.x, n);
  return array<u32, 3>(lo.x, qh, lo.y);
}

// ---- height ----
fn thick16(v: u32, a: u32) -> i32 { return i32((v / a) * 256u + ((v % a) * 256u) / a); }
fn thick_m(v: u32, a: u32) -> u32 { return (v / a) * 16u + ((v % a) * 16u) / a; }
// The isostatic height of a column in 1/256 m above the sea: tectonics' elevOf at 1/16 m, then times 16.
fn height_of(k: u32) -> i32 {
  let a = area_of(k);
  let vb = pool(0u, k);
  let tb = thick16(vb, a);
  let phi = tb * DR[0] + thick16(pool(1u, k), a) * DR[1] + thick16(pool(2u, k), a) * DR[2] + thick16(pool(3u, k), a) * DR[3] + thick16(pool(4u, k), a) * DR[4];
  let nb = vb >> ASHIFT;
  var age = 0u;
  if (nb > 0u) { age = min(s_get(5u, k) / nb, AGE_MAX); }
  let q16 = bitcast<i32>(X[16u * cnt() + age]) * 16;
  let hb = u32(min(tb, 96000i));
  let rho15 = (hb * 32768u) / 96000u;
  let th16 = bitcast<i32>(shrRound(smul(q16, i32(rho15)), 15u).x);
  let d16 = phi + th16 - PHI0_16;
  var z16 = d16 / ${PHYS.RHO_M}i;
  if (d16 < 0i) { z16 = d16 / ${PHYS.RHO_M - PHYS.RHO_W}i; }
  return (z16 - bitcast<i32>(P[P_SEA])) * 16i;
}

@compute @workgroup_size(256)
fn height(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  e_set(E_H, k, height_of(k));
}

// each land cell's discharge weight: its area times the rain over the reference, in 1/512 mean cell (Q8 rain, Q15 area, shift 14)
@compute @workgroup_size(256)
fn weights(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  var w = 0u;
  if (is_land(k)) { w = (area_of(k) * e_getu(E_RHO, k) + 8192u) >> 14u; }
  e_setu(E_W, k, w);
  e_set(E_ER, k, 0i);
}

// solver only: uplift of the land
@compute @workgroup_size(256)
fn uplift(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  if (is_land(k)) { e_set(E_H, k, e_get(E_H, k) + bitcast<i32>(P[P_UPL])); }
}
@compute @workgroup_size(256)
fn kconst(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  e_setu(E_KC, k, select(0u, P[P_KCONST], is_land(k)));
}

// ---- the priority flood ----
@compute @workgroup_size(256)
fn flinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  atomicStore(&AT[A_FL + k], select(e_get(E_H, k), INF, is_land(k)));
}
fn flround(k: u32) -> bool {
  if (!is_land(k)) { return false; }
  var m = INF;
  for (var d = 0u; d < 8u; d++) {
    let j = nbr8(k, d);
    if (j != NONE) { m = min(m, at_load(A_FL, j)); }
  }
  if (m == INF) { return false; }
  let cand = max(e_get(E_H, k), m + bitcast<i32>(P[P_EPS]));
  if (cand >= at_load(A_FL, k)) { return false; }
  atomicMin(&AT[A_FL + k], cand);
  return true;
}
@compute @workgroup_size(256)
fn flood(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  if (flround(k)) { atomicAdd(&AT[3u * cnt() + CNT_CHANGED], 1i); }
}

// ---- receivers: steepest descent on the flooded surface, the ocean ending every river ----
// With P[P_DRAW] set the receiver is instead drawn among the lower neighbours with the probability proportional to the fall to each over its distance, anew each substep: steepest
// descent sends water down any slope within 22.5 degrees of a lattice direction along that direction (Fairfield and Leymarie 1991, Tarboton 1997), so on a planar ramp it carves
// straight valleys on the lattice. Every lower neighbour is a valid receiver, so the forest stays a forest; the draw is a Philox word of the cell's id, the substep and the seed.
// With P[P_RHO8] set (Rho8, Fairfield and Leymarie 1991 as WhiteboxTools rho8_pointer has it: the fall to a cardinal neighbour over 1, to a diagonal one over 2 - r, r uniform in [0, 1),
// a draw for each diagonal link and substep) the receiver is the steepest of those among the lower neighbours only, so every receiver is strictly lower on the flooded surface and no chain
// can loop. The sphere's diagonal link has its own length (the table's inverse length), so the draw scales that link by (2 - r) / sqrt 2, which is 2 - r on a square grid: the link's inverse
// length is multiplied by sqrt 2 x 2^16 / (2 - r) / 2^16 (sqrt 2 x 2^16 = 92682). The incision still reads the link's true length.
${PHILOX}
@compute @workgroup_size(256)
fn recv(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  var to = k; var rd = 0u; var best = vec2u(0u, 0u);
  var rw = vec4u(0u, 0u, 0u, 0u);
  if (P[P_RHO8] != 0u && is_land(k)) { rw = philox(vec4u(k, P[P_DRAWKEY], 0u, 0x52484f38u), vec2u(P[P_DRAWSEED], 0x524f5554u)); }
  if (is_land(k)) {
    let f = at_load(A_FL, k);
    var share = array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u); var total = 0u;
    for (var d = 0u; d < 8u; d++) {
      let j = nbr8(k, d);
      if (j == NONE) { continue; }
      let dz = f - at_load(A_FL, j);
      if (dz <= 0i) { continue; }
      let iv = invd8(k, d);
      var ev = iv;
      if (P[P_RHO8] != 0u && d >= 4u) { ev = shr64(mul64(iv, (92682u << 15u) / ((131072u - (rw[d - 4u] & 0xffffu)) >> 1u)), 16u).x; }
      let key = mul64(u32(dz), ev);
      if (lt64(best, key)) { best = key; to = j; rd = iv; }
      let skey = mul64(u32(dz), iv);
      share[d] = max(1u, min(shr64(skey, 16u).x, 0x0fffffffu)); total += share[d];
    }
    if (P[P_DRAW] != 0u && total > 0u) {
      let r = philox(vec4u(k, P[P_DRAWKEY], 0u, 0x54305256u), vec2u(P[P_DRAWSEED], 0x524f5554u)).x % total;
      var acc = 0u;
      for (var d = 0u; d < 8u; d++) {
        acc += share[d];
        if (share[d] != 0u && r < acc) { to = nbr8(k, d); rd = invd8(k, d); break; }
      }
    }
  }
  e_setu(E_TO, k, to);
  e_setu(E_RD, k, rd);
}

// ---- the tree: depth by pointer jumping, then the cells filed by depth ----
@compute @workgroup_size(256)
fn lvinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let j = e_getu(E_TO, k);
  e_setu(E_UA, k, j);
  e_set(E_DA, k, select(1i, 0i, j == k));
  if (k <= MAXD + 1u) { atomicStore(&AT[cnt() + k], 0i); }
  if (k == 0u) { atomicStore(&AT[3u * cnt() + CNT_TOP], 0i); }
}
fn jump(src: u32, srcd: u32, into: u32, intod: u32, k: u32) {
  let j = e_getu(src, k);
  e_setu(into, k, e_getu(src, j));
  e_set(intod, k, e_get(srcd, k) + e_get(srcd, j));
}
@compute @workgroup_size(256)
fn jumpa(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  jump(E_UA, E_DA, E_UB, E_DB, k);
}
@compute @workgroup_size(256)
fn jumpb(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  jump(E_UB, E_DB, E_UA, E_DA, k);
}
@compute @workgroup_size(256)
fn lvhist(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let u = e_getu(E_UA, k);
  if (e_getu(E_TO, u) != u) { flag(FLAG_CHAIN); }
  let d = e_get(E_DA, k);
  e_set(E_DP, k, d);
  if (u32(d) > MAXD) { flag(FLAG_DEPTH); } else { atomicAdd(&AT[cnt() + u32(d)], 1i); }
}
var<workgroup> wsum: array<i32, 256>;
@compute @workgroup_size(256)
fn lvscan(@builtin(local_invocation_index) t: u32) {
  touch();
  var local = 0i; var top = 0i;
  for (var j = 0u; j < 64u; j++) {
    let c = at_load(cnt(), t * 64u + j);
    local += c;
    if (c > 0i) { top = i32(t * 64u + j); }
  }
  wsum[t] = local;
  workgroupBarrier();
  var before = 0i;
  for (var u = 0u; u < t; u++) { before += wsum[u]; }
  var run = before;
  for (var j = 0u; j < 64u; j++) {
    let d = t * 64u + j;
    e_set(E_LVS, d, run);
    atomicStore(&AT[2u * cnt() + d], run);
    run += at_load(cnt(), d);
  }
  atomicMax(&AT[3u * cnt() + CNT_TOP], top);
}
@compute @workgroup_size(256)
fn lvscatter(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let d = u32(e_get(E_DP, k));
  if (d <= MAXD) { let p = atomicAdd(&AT[2u * cnt() + d], 1i); e_set(E_ORD, u32(p), i32(k)); }
}

// ---- walks over the depths, one workgroup: the deepest first or the shallowest first, each level a barrier apart ----
var<workgroup> wtop: u32;
fn top_depth(t: u32) -> u32 {
  if (t == 0u) { wtop = u32(at_load(3u * cnt(), CNT_TOP)); }
  workgroupBarrier();
  return workgroupUniformLoad(&wtop);
}
fn level_lo(d: u32) -> u32 { return u32(e_get(E_LVS, d)); }
// the end of level d: the next level's start, or the cell count for the last
fn level_hi(d: u32, top: u32) -> u32 { return select(u32(e_get(E_LVS, d + 1u)), cnt(), d >= top); }

// the discharge area: a cell's own weight and everything that drains into it
@compute @workgroup_size(256)
fn area(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  for (var s = 0u; s <= top; s++) {
    let d = top - s;
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      var a = e_getu(E_W, k);
      for (var e = 0u; e < 8u; e++) {
        let j = nbr8(k, e);
        if (j != NONE && j != k && e_getu(E_TO, j) == k) { a += e_getu(E_ACC, j); }
      }
      e_setu(E_ACC, k, a);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// ---- erodibility from the rock in the top skin of the column ----
@compute @workgroup_size(256)
fn kappa(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  var kc = 0u;
  if (is_land(k)) {
    let a = area_of(k);
    var rem = P[P_SKIN]; var acc = vec2u(0u, 0u); var wsum_ = 0u;
    for (var s = 0u; s < 5u; s++) {
      let pl = ORDER[s];
      let w = min(thick_m(pool(pl, k), a), rem);
      rem -= w; wsum_ += w;
      acc = add64(acc, mul64(w, P[P_KC + pl]));
    }
    if (wsum_ > 0u) { kc = divw(acc.y, acc.x, wsum_).x; }
    // with P[P_KVAR] set the class erodibility is scaled by the cell's factor of the spatial field (Q16, the table past the thermal buoyancy: kfield.ts)
    if (P[P_KVAR] != 0u) { kc = shr64(add64(mul64(kc, X[16u * cnt() + AGE_MAX + 1u + k]), vec2u(32768u, 0u)), 16u).x; }
  }
  e_setu(E_KC, k, kc);
}

// ---- the implicit stream power step, shallowest depth first ----
// n = 1 (m = 1/2): h' = h_r + (h - h_r) / (1 + f), f = K dt sqrt(A) / d, Braun and Willett 2013. n = 2 (m = 1): x + c x^2 = h - h_r with
// c = K dt A / d^2, solved by x = 2 (h - h_r) / (1 + sqrt(1 + 4 c (h - h_r))) (Hergarten 2002). A is the discharge area at the reference rain.
@compute @workgroup_size(256)
fn incise(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  let nexp = P[P_NEXP];
  for (var d = 1u; d <= top; d++) {
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      let j = e_getu(E_TO, k);
      let hk = e_get(E_H, k);
      if (hk <= 0i || j == k) { continue; }
      if (at_load(A_FL, k) > hk) { continue; }
      var hj = 0i;
      if (is_land(j)) { hj = e_get(E_H, j); }
      if (hj >= hk) { continue; }
      let kc = e_getu(E_KC, k);
      if (kc == 0u) { continue; }
      let acc = e_getu(E_ACC, k); let rd = e_getu(E_RD, k);
      let delta = u32(hk - hj);
      var x = delta;
      if (nexp == 1u) {
        let s8 = sqrt64(vec2u(acc << 16u, acc >> 16u));
        let p1 = mul64(kc, rd);
        let p1s = select((p1.x >> 16u) | (p1.y << 16u), 0xffffffffu, (p1.y >> 16u) != 0u);
        let f64_ = shr64(mul64(p1s, s8), 16u);
        let f16 = select(f64_.x, 0x7fffffffu, f64_.y != 0u || f64_.x > 0x7fffffffu);
        if (f16 > 0u) {
          let u = divw(65536u, 0u, f16 + 65536u).x;
          x = umulsh(delta, u, 32u);
        }
      } else {
        let t1 = mul64(acc, delta);
        let a = shr64(mul64(kc, rd * rd), 28u);
        let a32 = select(a.x, 0xffffffffu, a.y != 0u);
        var z16 = mulhi64(t1, a32);
        if (z16.y >= 0x8000u) { z16 = vec2u(0xffffffffu, 0x7fffu); }
        let w = add64(z16, vec2u(65536u, 0u));
        let sq = min(sqrt64(vec2u(w.x << 16u, (w.y << 16u) | (w.x >> 16u))), 0x7fffffffu);
        x = divw(delta >> 15u, delta << 17u, 65536u + sq).x;
      }
      let nh = max(hj + i32(x), 1i);
      if (nh < hk) { e_set(E_ER, k, hk - nh); e_set(E_H, k, nh); }
    }
    storageBarrier(); workgroupBarrier();
  }
}

// ---- landscape-scale denudation by relief (Montgomery and Brandon 2002) ----
// A 12 km cell cannot hold a valley, so the stream power law sees only the slope between cell means and misses the denudation of the relief inside
// the cell. Landscape-scale erosion rate follows local relief R as E = E0 + K R / (1 - (R / Rc)^2), with R measured here from a cell to its lowest axis
// neighbour (12 km, the width of a 10 km window) over the sea level at the least. R is integrated in eight sub-intervals so that a steep scarp loses
// height as its relief falls; the relief is held under 15/16 of Rc, where the law becomes singular. P_RC is Rc in 1/256 m, P_KDT is K dt / 8 in Q16
// and P_E0 is E0 dt / 8 in 1/256 m (all 0 when the law is off). WL holds the thickness the law takes from a cell in the substep, from the heights before incision.
@compute @workgroup_size(256)
fn relief(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  var tot = 0u;
  let hk = e_get(E_H, k);
  if (hk > 0i && P[P_RC] > 0u) {
    var low = hk;
    for (var d = 0u; d < 4u; d++) {
      let j = nbr8(k, d);
      if (j != NONE) { low = min(low, max(e_get(E_H, j), 0i)); }
    }
    var r = u32(hk - max(low, 0i));
    let rcap = (P[P_RC] * 15u) >> 4u;
    for (var s = 0u; s < 8u; s++) {
      let rr = min(r, rcap);
      let q = divw(rr >> 16u, rr << 16u, P[P_RC]).x;
      let den = 65536u - ((q * q) >> 16u);
      let t = mul64(rr, P[P_KDT]);
      let dh = min(divw(t.y, t.x, den).x + P[P_E0], r);
      r -= dh; tot += dh;
    }
  }
  e_set(E_WL, k, i32(tot));
}

// What the law takes beyond what the incision did: the larger of the two is the lowering of the cell, so the river's part is not counted twice.
@compute @workgroup_size(256)
fn waste(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let hk = e_get(E_H, k);
  if (hk <= 0i || at_load(A_FL, k) > hk + e_get(E_ER, k)) { return; }
  let extra = min(max(e_get(E_WL, k) - e_get(E_ER, k), 0i), hk - 1i);
  if (extra > 0i) { e_set(E_ER, k, e_get(E_ER, k) + extra); e_set(E_H, k, hk - extra); }
}

// ---- what the incision took from each column ----
@compute @workgroup_size(256)
fn removal(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  var r = 0u; var ds = 0u;
  let er = e_get(E_ER, k);
  if (er > 0i) {
    r = min(shr64(add64(mul64(u32(er), area_of(k)), vec2u(2048u, 0u)), 12u).x, col_total(k));
    ds = shr64(mul64(r, P[P_DISS]), 16u).x;
  }
  e_setu(E_RV, k, r); e_setu(E_DS, k, ds); e_setu(E_PS, k, r - ds); e_setu(E_AD, k, 0u); e_setu(E_QL, k, 0u); e_setu(E_QH, k, 0u); e_setu(E_XL, k, 0u); e_setu(E_XH, k, 0u);
}

// The sediment that fills a gap of g (1/256 m) in the surface of cell k, in volume units, with the isostatic subsidence the load makes.
fn fill_cap(g: u32, k: u32) -> vec2u {
  let v = shr64(add64(mul64(g, area_of(k)), vec2u(2048u, 0u)), 12u);
  return mulshr16(v, CAPF);
}

// ---- the sediment carried down the tree and deposited: lakes fill, and Davy and Lague's term takes a share along the way ----
@compute @workgroup_size(256)
fn route(@builtin(local_invocation_index) t: u32) {
  touch();
  let top = top_depth(t);
  let g8 = P[P_G];
  for (var s = 0u; s < top; s++) {
    let d = top - s;
    let lo = level_lo(d); let hi = level_hi(d, top);
    for (var p = lo + t; p < hi; p += 256u) {
      let k = u32(e_get(E_ORD, p));
      var avail = vec2u(e_getu(E_PS, k), 0u);
      // what a dead end of the sea carried over comes down the river beside the rest and takes nothing from it on the way (a lake aside)
      var xin = vec2u(e_getu(E_CL, k), e_getu(E_CH, k));
      e_setu(E_CL, k, 0u); e_setu(E_CH, k, 0u);
      for (var e = 0u; e < 8u; e++) {
        let j = nbr8(k, e);
        if (j != NONE && j != k && e_getu(E_TO, j) == k) {
          avail = add64(avail, vec2u(e_getu(E_QL, j), e_getu(E_QH, j)));
          xin = add64(xin, vec2u(e_getu(E_XL, j), e_getu(E_XH, j)));
        }
      }
      var dep = vec2u(0u, 0u);
      var xout = xin;
      // the floor before the incision: a cell is a lake where the flooded surface stands above it
      let hk = e_get(E_H, k) + e_get(E_ER, k); let fk = at_load(A_FL, k);
      if (fk > hk) {
        // a lake: it takes up to what fills it to the flooded surface, what arrives first and then what is carried
        let cap = fill_cap(u32(fk - hk), k);
        dep = min64(avail, cap);
        let more = min64(xin, sub64(cap, dep));
        dep = add64(dep, more); xout = sub64(xin, more);
      } else if (g8 > 0u) {
        // the deposited share g / (1 + g) of what arrives, g = G w / A: G w / (G w + A)
        let gw = g8 * e_getu(E_W, k);
        let den = add64(vec2u(gw, 0u), vec2u(e_getu(E_ACC, k) << 8u, e_getu(E_ACC, k) >> 24u));
        var sh = 0u;
        if (den.y != 0u) { sh = 33u - countLeadingZeros(den.y); }
        let dd = shr64(den, sh).x;
        let yy = gw >> sh;
        // a cell with no water (no rain, no discharge) has nothing to carry what the relief law takes from it: the debris stays where it fell
        var lam = 65536u;
        if (dd > 0u) { lam = divw(yy >> 16u, yy << 16u, dd).x; }
        dep = mulshr16(avail, lam);
      }
      // the regular flux goes on less what it deposited (a deposit beyond it came from the carried part)
      let rest = sub64(avail, min64(avail, dep));
      e_setu(E_QL, k, rest.x); e_setu(E_QH, k, rest.y);
      e_setu(E_XL, k, xout.x); e_setu(E_XH, k, xout.y);
      if (dep.y != 0u) { flag(FLAG_PILE); }
      e_setu(E_AD, k, dep.x);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// ---- the coast's rings: cells of the sea by distance from the land, in cells (eight neighbours) ----
@compute @workgroup_size(256)
fn cdinit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  e_set(E_CD, k, select(INF, 0i, is_land(k)));
}
fn cd_round(src: u32, dst: u32, k: u32) {
  var v = e_get(src, k);
  if (v == INF) {
    var m = INF;
    for (var d = 0u; d < 8u; d++) { let j = nbr8(k, d); if (j != NONE) { m = min(m, e_get(src, j)); } }
    if (m != INF) { v = m + 1i; }
  }
  e_set(dst, k, v);
}
@compute @workgroup_size(256)
fn cda(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  cd_round(E_CD, E_CD2, k);
}
@compute @workgroup_size(256)
fn cdb(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  cd_round(E_CD2, E_CD, k);
}
// the cells of ring c that p feeds: its neighbours of ring c + 1
fn children(p: u32, c: u32) -> u32 {
  var n = 0u;
  if (c >= P[P_RINGMAX]) { return 0u; }
  for (var d = 0u; d < 8u; d++) { let j = nbr8(p, d); if (j != NONE && e_get(E_CD, j) == i32(c + 1u)) { n += 1u; } }
  return n;
}
// One ring: the sediment arriving (from the rivers at ring 1, from the parents' shares at the rest) fills the cell up to a graded
// shelf, ring c deeper than the coast by c shelf steps, and the rest goes on to the cell's children in equal shares (the remainder
// to the first in direction order). A cell with no children (a dead end between two coasts, or the last ring) fills to the sea and carries
// what is left over to the next substep.
@compute @workgroup_size(256)
fn ring(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let c = P[P_RING];
  if (e_get(E_CD, k) != i32(c)) { return; }
  var avail = vec2u(0u, 0u);
  for (var e = 0u; e < 8u; e++) {
    let j = nbr8(k, e);
    if (j == NONE) { continue; }
    if (c == 1u) {
      if (is_land(j) && e_getu(E_TO, j) == k) { avail = add64(add64(avail, vec2u(e_getu(E_QL, j), e_getu(E_QH, j))), vec2u(e_getu(E_XL, j), e_getu(E_XH, j))); }
    } else if (e_get(E_CD, j) == i32(c - 1u)) {
      let n = children(j, c - 1u);
      let q = div64small(vec2u(e_getu(E_QL, j), e_getu(E_QH, j)), n);
      var rank = 0u;
      for (var f = 0u; f < 8u; f++) {
        let m = nbr8(j, f);
        if (m == k) { break; }
        if (m != NONE && e_get(E_CD, m) == i32(c)) { rank += 1u; }
      }
      avail = add64(avail, vec2u(q[0], q[1]));
      if (rank < q[2]) { avail = add64(avail, vec2u(1u, 0u)); }
    }
  }
  avail = add64(avail, vec2u(e_getu(E_CL, k), e_getu(E_CH, k)));
  // with children the cell fills to the graded shelf, ring c deeper than the coast by c shelf steps; a dead end of the rings fills to the sea
  let ramp = select(-i32(c * P[P_SHELF]), 0i, children(k, c) == 0u);
  var dep = min64(avail, fill_cap(u32(max(ramp - e_get(E_H, k), 0i)), k));
  var out = sub64(avail, dep);
  var carry = vec2u(0u, 0u);
  if (children(k, c) == 0u) { carry = out; out = vec2u(0u, 0u); }
  e_setu(E_CL, k, carry.x); e_setu(E_CH, k, carry.y);
  e_setu(E_QL, k, out.x); e_setu(E_QH, k, out.y);
  if (dep.y != 0u || dep.x >= VOL_MAX) { flag(FLAG_PILE); }
  e_setu(E_AD, k, dep.x);
}
// The open sea beyond the rings: what is carried there is laid down as far as the water is deep.
@compute @workgroup_size(256)
fn far(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  if (is_land(k) || e_get(E_CD, k) != INF) { return; }
  let avail = vec2u(e_getu(E_CL, k), e_getu(E_CH, k));
  let dep = min64(avail, fill_cap(u32(max(-e_get(E_H, k), 0i)), k));
  let carry = sub64(avail, dep);
  e_setu(E_CL, k, carry.x); e_setu(E_CH, k, carry.y);
  if (dep.y != 0u || dep.x >= VOL_MAX) { flag(FLAG_PILE); }
  e_setu(E_AD, k, dep.x);
}

// ---- rock removed from the top of the stack down, sediment laid on top ----
@compute @workgroup_size(256)
fn apply(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let r = e_getu(E_RV, k); let ad = e_getu(E_AD, k);
  if (r == 0u && ad == 0u) { return; }
  let vb = pool(0u, k); let vs = pool(1u, k); let vm = pool(2u, k); let vg = pool(3u, k); let vv = pool(4u, k);
  let agb = s_get(5u, k); let org = s_get(6u, k);
  let t0 = vb + vs + vm + vg + vv;
  var rem = r;
  var nvs = vs; var nvv = vv; var nvm = vm; var nvg = vg; var nvb = vb;
  var tk = min(rem, nvs); nvs -= tk; rem -= tk;
  tk = min(rem, nvv); nvv -= tk; rem -= tk;
  tk = min(rem, nvm); nvm -= tk; rem -= tk;
  tk = min(rem, nvg); nvg -= tk; rem -= tk;
  tk = min(rem, nvb); nvb -= tk; rem -= tk;
  if (rem != 0u) { flag(FLAG_SED); }
  // a column holds at most what its volumes' integers do: the sediment past that stays in transit
  let room = select(0u, VOL_MAX - 1u - nvs, nvs < VOL_MAX - 1u);
  let put = min(ad, room);
  if (put != ad) {
    let more = add64(vec2u(e_getu(E_CL, k), e_getu(E_CH, k)), vec2u(ad - put, 0u));
    e_setu(E_CL, k, more.x); e_setu(E_CH, k, more.y);
    e_setu(E_AD, k, put);
  }
  nvs += put;
  let t1 = nvb + nvs + nvm + nvg + nvv;
  s_set(0u, k, nvb); s_set(1u, k, nvs); s_set(2u, k, nvm); s_set(3u, k, nvg); s_set(4u, k, nvv);
  if (nvb != vb && (vb >> ASHIFT) > 0u) {
    let pr = mul64(agb, nvb >> ASHIFT);
    s_set(5u, k, divw(pr.y, pr.x, vb >> ASHIFT).x);
  }
  if (t1 != t0 && (t0 >> ASHIFT) > 0u) {
    let pr = mul64(org, t1 >> ASHIFT);
    s_set(6u, k, divw(pr.y, pr.x, t0 >> ASHIFT).x);
  }
}

// ---- the books: the volumes removed, deposited and dissolved over the planet, each in four limbs of 8 bits so that a cell's add cannot overflow ----
@compute @workgroup_size(256)
fn ledger(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let base = 3u * cnt() + ${CNT.COUNT}u;
  for (var q = 0u; q < 3u; q++) {
    let v = select(select(e_getu(E_DS, k), e_getu(E_AD, k), q == 1u), e_getu(E_RV, k), q == 0u);
    if (v == 0u) { continue; }
    for (var l = 0u; l < 4u; l++) { atomicAdd(&AT[base + q * 4u + l], i32((v >> (8u * l)) & 255u)); }
  }
}

// ---- creep and the sea floor's diffusion ----
// G fields: 0 the height in 1/64 m (q), 1 the land mask, 2 the most a cell may give a link (volume units).
@compute @workgroup_size(256)
fn creepin(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = flatIndex(gid, nwg);
  if (k >= cnt()) { return; }
  let h = e_get(E_H, k);
  let at = pw(k); let fw = fwords();
  G[at] = h / 4i;
  let land = h > 0i;
  G[fw + at] = select(0i, 1i, land);
  G[2u * fw + at] = i32(select(pool(1u, k), col_total(k), land) / 8u);
}
fn cornerG(at: u32, q0: i32, c: u32, idx: u32, count: u32) -> vec2u {
  var sum = vec2u(0u, 0u);
  for (var j = 0u; j < 4u; j++) {
    var off = 0;
    if (j == 1u) { off = OFF[c]; } else if (j == 2u) { off = OFF[(c + 1u) & 3u]; } else if (j == 3u) { off = OFF[4u + c]; }
    sum = add64(sum, smul(T[(${TAB.V}u + 4u * c + j) * count + idx], G[u32(i32(at) + off)] - q0));
  }
  return sum;
}
// One diffusion step as volumes: each link moves the grid's flux (a link's mass in q * a, here q in 1/64 m, so mass / 1024 is volume units),
// rounded to whole units by the one rule at both its cells, and limited by what the cell that gives can spare. Land links
// diffuse at the creep's rate, sea links at the sea floor's, a link between land and sea not at all.
@compute @workgroup_size(256)
fn creepflux(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = cnt();
  if (idx >= count) { return; }
  let at = pw(idx); let fw = fwords();
  let q0 = G[at]; let land0 = G[fw + at] == 1i;
  var dv = 0i;
  for (var d = 0u; d < 4u; d++) {
    let nb = u32(i32(at) + OFF[d]);
    let landn = G[fw + nb] == 1i;
    if (land0 != landn) { continue; }
    let fo = select(P[P_FOS], P[P_FOL], land0);
    if (fo == 0u) { continue; }
    let ends = shrRound(sub64(cornerG(at, q0, d, idx, count), cornerG(at, q0, (d + 3u) & 3u, idx, count)), ${SHIFT.vertex - SHIFT.ends}u);
    let cr = shrRound(smul(T[(${TAB.C}u + d) * count + idx], bitcast<i32>(ends.x)), ${SHIFT.ends}u);
    let s = add64(smul(T[(${TAB.K}u + d) * count + idx], G[nb] - q0), cr);
    let s1 = shrRound(s, ${SHIFT.kappa - 16}u);
    let flux = shrRound(smul64u(s1, fo), ${SHIFT.fo + 1}u);
    var v = bitcast<i32>(shrRound(flux, 10u).x);
    // the cell that gives: the neighbour if the link brings volume in, this cell if it sends it out
    let lim = select(G[2u * fw + at], G[2u * fw + nb], v > 0i);
    v = clamp(v, -lim, lim);
    dv += v;
  }
  e_setu(E_RV, idx, u32(max(-dv, 0i)));
  e_setu(E_AD, idx, u32(max(dv, 0i)));
  e_setu(E_DS, idx, 0u);
}
`;
}

