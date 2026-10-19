// Ice on the globe's grid, on the GPU (host side, laws, constants and sources: src/gpu/globe/ice.ts and
// docs/research/globe/2026-10-19-ice-impl.md). The kernels are appended to the grid's own source (globe-grid.ts), so they share
// its bindings (S: every field in the padded tile layout, T: the tables, P: parameters) and its helpers (the halo exchange and
// the gradient, run through GlobeGpu; the flux step's corner and rounding helpers, called here), and add one: A, the atomic
// words (the largest diffusion number of a step, as a log). All integer: no float sits between a buffer read and a buffer write.
//
// One step of ice, in the order the host records it (dt is a Q8 number of years):
//   prep    the bed (initial bed less the rock the ice has cut plus the sediment laid, less the load's depression), the ice's
//           thickness from its volume, the surface s = bed + h, the mass balance at the surface (accumulation of solid
//           precipitation less the ablation the summer temperature gives) and whether the bed is at the melting point;
//   (halo of s, the grid's gradient of s)
//   coef    the diffusion number of each cell, D dt / (the mean cell's area) with D = (Gamma_A h + Gamma_s [temperate]) h^4 |grad s|^2,
//           capped at FO_CAP (the flux cap), and the erosion rate K_g u_s^l of the sliding speed u_s = K_s tau_b^3;
//   (halo of the diffusion number)
//   demand  the step's mass balance (ablation cannot take more than the stock; the debris of the ice that melts is laid down),
//           each of the four links' flux in volume units with the grid's conservative stencil (a link's diffusion number is
//           that of the cell the ice comes from), and the share of its stock each cell can give;
//   (halo of the share and of the debris concentration)
//   carry   the fluxes as moved (the giver's share of each; the debris goes with the ice at the giver's concentration),
//           the sliding's cut of the bed (a dissolved share and a sediment share that joins the debris), ice that is afloat
//           calves (its debris is laid on the sea floor), and the bed's depression relaxes toward the load.
// A cell's ice, debris, cut rock and laid sediment are volumes in the tectonics unit V = H a / 16 (H in m, a the area weight
// of the cell in 1/32,768 of the mean cell: 62,400 m3 on the mean cell, 0.49 mm of ice on it), so a link's flux is one integer
// that both cells of the link take with opposite signs, and the total changes only by the mass balance and the calving, which
// the cumulative fields AC, AB and CV carry.
import { TAB, globeWgsl } from "./globe-grid";

// Fields of S (one word a cell in the padded layout).
export const IF = {
  BED: 0, TS: 1, P: 5, SUM: 9, DT: 10, // inputs: the initial bed (Q6 m), the sea-level air temperature of four seasons (Q16 C), the four seasons' precipitation (Q16 mm), the summer season, the forcing's offset (Q16 K)
  ICE: 11, DEB: 12, RCK: 13, SED: 14, DEP: 15, // state: ice, debris in the ice, rock cut, sediment laid (volume units), the bed's depression (Q12 m: a step's relaxation of a metre is under a unit in Q6)
  AC: 16, AB: 17, CV: 18, DS: 19, // cumulative: accumulated, ablated, calved, dissolved (volume units)
  BEF: 20, HQ: 21, SRF: 22, GE: 23, GN: 24, BAL: 25, TMP: 26, FOC: 27, ERT: 28, VST: 29, DST: 30, OUT: 31, LAM: 32, CON: 33, FL: 34, // work (FL is four fields)
  ELA: 38, COUNT: 39,
} as const;

// Parameter words (P, u32): the grid's first 13 are its own (tiles, cells on a side, tiles in all, halo mode, fields).
export const IP = { sea6: 16, dtq: 17, logCd: 18, logCdCold: 19, logCs: 20, logCu: 21, logKe: 22, expL: 23, iso: 24, logUcap: 25, foCap: 26, diss16: 27, elaLo: 28, elaHi: 29 } as const;
// The atomic words: the largest log2 of a diffusion number (before the cap) in the step, offset by 2^30; the cells that held ice
// and the cells whose number the flux cap cut, summed over the steps of a batch.
export const AW = { maxLog: 0, cells: 1, capped: 2, COUNT: 4 } as const;
export const LOG_OFFSET = 2 ** 30;

// The law's constants as the kernels hold them (built by ice.ts kernelConstants).
export interface IceK {
  lapq: number; // the lapse rate: the air's temperature (Q16 K) falls by z6 * lapq / 2^10 for a height z6 (Q6 m)
  pexp: number; // the precipitation's fall with height: ln of its ratio is -dz6 * pexp / 2^14 in Q16 for a rise dz6 (Q6 m)
  slope24: number; // the gradient's words (Q6 of a Q6 height a cell's width) over (4,096 R Delta) to the slope, Q16: slope = g * slope24 / 2^24
  invRho24: number; // mm of water a year to m of ice a year, Q24 (1 / 910)
  tRoot: number; // the summer temperature (Q16 C) under which nothing melts: the root of the ablation quadratic
  c2: number; c1: number; c0: number; // ablation A(T) = c2 T^2 + c1 T + c0 (mm a year, Q16 coefficients)
  tTemp: number; // the mean annual air temperature (Q16 C) over which the bed is at the melting point
  rhoI: number; rhoW: number; // kg/m3
  isoQ16: number; // ice density over mantle density, Q16
}

export function iceWgsl(edges: readonly (readonly { face: number; side: number; flip: boolean }[])[], k: IceK): string {
  const fields = Object.entries(IF).filter(([n]) => n !== "COUNT").map(([n, v]) => `const F_${n}: u32 = ${v}u;`).join("\n");
  return /* wgsl */ `${globeWgsl(edges)}
@group(0) @binding(3) var<storage, read_write> A: array<atomic<u32>>;

${fields}
const LAPQ = ${k.lapq}i;
const PEXP = ${k.pexp}i;
const SLOPE24 = ${k.slope24}u;
const INV_RHO24 = ${k.invRho24}i;
const T_ROOT = ${k.tRoot}i;
const C2 = ${k.c2}i; const C1 = ${k.c1}i; const C0 = ${k.c0}i;
const T_TEMP = ${k.tTemp}i;
const RHO_I = ${k.rhoI}u; const RHO_W = ${k.rhoW}u;
const ISO16 = ${k.isoQ16}u;
const P_SEA = ${IP.sea6}u; const P_DTQ = ${IP.dtq}u; const P_LCD = ${IP.logCd}u; const P_LCDC = ${IP.logCdCold}u; const P_LCS = ${IP.logCs}u; const P_LCU = ${IP.logCu}u;
const P_LKE = ${IP.logKe}u; const P_EXPL = ${IP.expL}u; const P_ISO = ${IP.iso}u; const P_LUCAP = ${IP.logUcap}u; const P_FOCAP = ${IP.foCap}u; const P_DISS = ${IP.diss16}u;
const LOG_OFFSET = ${LOG_OFFSET}u;
const NONE_LOG = -2147483647i;

fn touch() { _ = S[0]; _ = T[0]; _ = P[0]; _ = atomicLoad(&A[0]); }
fn fwords() -> u32 { return P[2] * PAD2; }
fn cellAt(idx: u32) -> u32 {
  let slot = idx >> 16u; let c = idx & 65535u;
  return slot * PAD2 + ((c >> 8u) + 1u) * PAD + (c & 255u) + 1u;
}
fn gf(f: u32, at: u32) -> i32 { return S[f * fwords() + at]; }
fn sf(f: u32, at: u32, v: i32) { S[f * fwords() + at] = v; }

fn shr64(v: vec2u, s: u32) -> vec2u {
  if (s == 0u) { return v; }
  if (s >= 32u) { return vec2u(v.y >> (s - 32u), 0u); }
  return vec2u((v.x >> s) | (v.y << (32u - s)), v.y >> s);
}
fn sqrt64(n: vec2u) -> u32 {
  var r = 0u;
  for (var bit = 0x80000000u; bit != 0u; bit = bit >> 1u) {
    let c = r | bit;
    if (!lt64(n, mul64(c, c))) { r = c; }
  }
  return r;
}

// v / 2^10 / ... the thickness in Q6 m of a volume v on a cell of area weight a: v 16 / a m, times 64.
fn thick6(v: u32, a: u32) -> i32 { return i32((v / a) * 1024u + ((v % a) * 1024u) / a); }

// ---- mass balance (Q16 mm of water a year) at height z6 (Q6 m above the sea of the climate) ----
fn tair(at: u32, s: u32, z6: i32) -> i32 {
  let lap = bitcast<i32>(shrRound(smul(z6, LAPQ), 10u).x);
  return gf(F_TS + s, at) + gf(F_DT, at) - lap;
}
fn ablation(t: i32) -> i32 {
  if (t < T_ROOT) { return 0i; }
  let q = qadd(qadd(qmul(C2, qmul(t, t)), qmul(C1, t)), C0);
  return max(q, 0i);
}
fn bal_at(at: u32, z6: i32) -> i32 {
  var psolid = 0i; var tsum = 0i;
  let sidx = u32(gf(F_SUM, at));
  // the precipitation falls with the surface's height over the one the climate was made for (the bed, or the sea's surface where the bed is under it) as
  // the air's saturation falls with its temperature: exp(-gamma_P lapse dz)
  let dz = z6 - max(gf(F_BED, at), 0i);
  let ratio = qexp(-bitcast<i32>(shrRound(smul(dz, PEXP), 14u).x));
  for (var s = 0u; s < 4u; s++) {
    let t = tair(at, s, z6);
    let fs = clamp((65536i - t) >> 1u, 0i, 65536i);
    psolid = qadd(psolid, qmul(qmul(gf(F_P + s, at), ratio), fs));
    if (s == sidx) { tsum = t; }
  }
  return qadd(psolid, -ablation(tsum));
}

@compute @workgroup_size(256)
fn prep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let at = cellAt(idx);
  let a = u32(T[idx]);
  let bed = gf(F_BED, at) - thick6(u32(gf(F_RCK, at)), a) + thick6(u32(gf(F_SED, at)), a) - ((gf(F_DEP, at) + 32i) >> 6u);
  let ice = u32(gf(F_ICE, at));
  let h = thick6(ice, a);
  let srf = bed + h;
  sf(F_BEF, at, bed); sf(F_HQ, at, h); sf(F_SRF, at, srf);
  var b = shrRound(smul(bal_at(at, srf), INV_RHO24), 24u).x;
  // ice cannot grow from nothing on a floor under the sea (it would be afloat): only grounded ice has a balance there
  if (bed < bitcast<i32>(P[P_SEA]) && ice == 0u) { b = 0u; }
  sf(F_BAL, at, bitcast<i32>(b));
  var tm = 0i;
  for (var s = 0u; s < 4u; s++) { tm += tair(at, s, srf); }
  sf(F_TMP, at, select(0i, 1i, (tm >> 2u) > T_TEMP));
}


// ---- the diffusion number (the flux cap applied), the sliding's erosion rate, and the step's stiffest cell ----
var<workgroup> wmax: array<u32, 256>;
@compute @workgroup_size(256)
fn coef(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u, @builtin(local_invocation_index) lt: u32) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  var mine = 0u;
  if (idx < count) {
    let at = cellAt(idx);
    let h6 = gf(F_HQ, at);
    var foc = 0u; var ert = 0u;
    if (h6 > 0i) {
      let ge = gf(F_GE, at); let gn = gf(F_GN, at);
      let g6 = sqrt64(add64(mul64(mag(ge), mag(ge)), mul64(mag(gn), mag(gn))));
      let sl = i32(shr64(add64(mul64(g6, SLOPE24), vec2u(1u << 23u, 0u)), 24u).x);
      if (sl > 0i) {
        let temperate = gf(F_TMP, at) == 1i;
        let hk = i32((u32(h6) * 1024u) / 1000u);
        let lgh = qlog2(hk); let lgs = qlog2(sl);
        let lcd = bitcast<i32>(select(P[P_LCD], P[P_LCDC], !temperate));
        let ld = lcd + 5i * lgh + 2i * lgs;
        var fo = u32(exp2q(wide(ld + 524288i)));
        var worst = ld;
        if (temperate) {
          let ls = bitcast<i32>(P[P_LCS]) + 4i * lgh + 2i * lgs;
          fo = min(fo + u32(exp2q(wide(ls + 524288i))), 0x7fffffffu);
          worst = max(worst, ls);
          // the sliding speed, m a year, capped at the fastest measured glacier (the law's range), and the cut it gives
          let lu = min(bitcast<i32>(P[P_LCU]) + 3i * lgh + 3i * lgs, bitcast<i32>(P[P_LUCAP]));
          let le = bitcast<i32>(P[P_LKE]) + qmul(bitcast<i32>(P[P_EXPL]), lu) + 786432i;
          ert = u32(exp2q(wide(le)));
        }
        foc = min(fo, P[P_FOCAP]);
        mine = u32(worst + 1073741824i);
        atomicAdd(&A[${AW.cells}u], 1u);
        if (fo > P[P_FOCAP]) { atomicAdd(&A[${AW.capped}u], 1u); }
      }
    }
    sf(F_FOC, at, bitcast<i32>(foc)); sf(F_ERT, at, bitcast<i32>(ert));
  }
  // the largest log of the step's diffusion numbers: a workgroup's maximum, then one atomic
  wmax[lt] = mine;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (lt < s) { wmax[lt] = max(wmax[lt], wmax[lt + s]); }
    workgroupBarrier();
  }
  if (lt == 0u) { atomicMax(&A[0], wmax[0]); }
}

// ---- the step's mass balance, the links' fluxes and the share of its stock each cell can give ----
@compute @workgroup_size(256)
fn demand(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let at = cellAt(idx);
  let a = u32(T[idx]);
  let v0 = u32(gf(F_ICE, at)); let deb0 = u32(gf(F_DEB, at)); let bal = gf(F_BAL, at);
  // the balance over the step in volume units: bal (Q16 m a year) times dt (Q8 years) times the area weight over 2^28
  let dv = bitcast<i32>(shrRound(smul64u(smul(bal, i32(P[P_DTQ])), a), 28u).x);
  var acc = 0u; var want = 0u;
  if (dv > 0i) { acc = u32(dv); } else { want = u32(-dv); }
  let abl = min(want, v0);
  var rel = 0u;
  if (abl > 0u) {
    if (abl >= v0) { rel = deb0; } else { let p = mul64(deb0, abl); rel = divw(p.y, p.x, v0).x; }
  }
  let v1 = v0 + acc - abl; let deb1 = deb0 - rel;
  sf(F_SED, at, gf(F_SED, at) + i32(rel));
  sf(F_AC, at, gf(F_AC, at) + i32(acc)); sf(F_AB, at, gf(F_AB, at) + i32(abl));
  let qi = F_SRF * fwords(); let q0 = S[qi + at];
  let foi = u32(gf(F_FOC, at));
  var out = 0u;
  for (var d = 0u; d < 4u; d++) {
    let nb = u32(i32(at) + OFF[d]);
    let ends = shrRound(sub64(corner(at, qi, q0, d, idx, count), corner(at, qi, q0, (d + 3u) & 3u, idx, count)), 14u);
    let cr = shrRound(smul(T[(${TAB.C}u + d) * count + idx], bitcast<i32>(ends.x)), 6u);
    let s = add64(smul(T[(${TAB.K}u + d) * count + idx], S[qi + nb] - q0), cr);
    // the link's diffusion number is that of the cell the ice comes from (the higher surface; the larger on a tie, so both cells of a link agree): ice
    // leaves a thick cell into an empty one at the thick cell's rate and not at half of it
    let qn = S[qi + nb]; let fnb = u32(gf(F_FOC, nb));
    var fo = max(foi, fnb);
    if (qn > q0) { fo = fnb; } else if (qn < q0) { fo = foi; }
    let flux = shrRound(smul64u(shrRound(s, 8u), fo), 25u);
    let vin = bitcast<i32>(shrRound(flux, 10u).x);
    sf(F_FL + d, at, vin);
    if (vin < 0i) { out += u32(-vin); }
  }
  var lam = 65536u;
  if (out > v1) { let p = mul64(v1, 65536u); lam = divw(p.y, p.x, out).x; }
  var con = 0u;
  if (v1 > 0u && deb1 > 0u) {
    let p = mul64(deb1, 65536u);
    if (p.y >= v1) { con = 0x7fffffffu; } else { con = min(divw(p.y, p.x, v1).x, 0x7fffffffu); }
  }
  sf(F_VST, at, i32(v1)); sf(F_DST, at, i32(deb1)); sf(F_OUT, at, i32(out)); sf(F_LAM, at, i32(lam)); sf(F_CON, at, i32(con));
}

// ---- the fluxes moved, the bed cut, the ice afloat calved, the depression relaxed ----
@compute @workgroup_size(256)
fn carry(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let at = cellAt(idx);
  let a = u32(T[idx]);
  var v = u32(gf(F_VST, at)); var deb = u32(gf(F_DST, at));
  var sed = u32(gf(F_SED, at));
  for (var d = 0u; d < 4u; d++) {
    let vin = gf(F_FL + d, at);
    if (vin > 0i) {
      let nb = u32(i32(at) + OFF[d]);
      let mv = shr64(mul64(u32(vin), u32(gf(F_LAM, nb))), 16u).x;
      v += mv; deb += shr64(mul64(mv, u32(gf(F_CON, nb))), 16u).x;
    } else if (vin < 0i) {
      let mv = shr64(mul64(u32(-vin), u32(gf(F_LAM, at))), 16u).x;
      v -= mv; deb -= shr64(mul64(mv, u32(gf(F_CON, at))), 16u).x;
    }
  }
  // the sliding's cut under the ice that lay there at the start of the step: ert (Q28 m a year) times dt (Q8 years) times the area weight over 2^40
  let h0 = gf(F_HQ, at);
  let ert = u32(gf(F_ERT, at));
  var er = 0u; var ds = 0u;
  if (h0 > 0i && ert > 0u) {
    let pr = smul64u(mul64(ert, P[P_DTQ]), a);
    er = shr64(add64(pr, vec2u(0u, 128u)), 40u).x;
    ds = shr64(mul64(u32(gf(F_RCK, at)) + er, P[P_DISS]), 16u).x - u32(gf(F_DS, at));
    deb += er - ds;
  }
  // ice that is afloat calves: grounded where rho_i h >= rho_w (sea - bed)
  let bed = gf(F_BEF, at); let sea = bitcast<i32>(P[P_SEA]);
  var cal = 0u;
  if (v > 0u && bed < sea) {
    if (u32(thick6(v, a)) * RHO_I < u32(sea - bed) * RHO_W) { cal = v; sed += deb; v = 0u; deb = 0u; }
  }
  // the bed's depression relaxes toward the load of the ice at the start of the step
  let tgt = i32(shr64(mul64(u32(max(h0, 0i)), ISO16), 10u).x);
  let dep = gf(F_DEP, at);
  sf(F_DEP, at, dep + bitcast<i32>(shrRound(smul(tgt - dep, i32(P[P_ISO])), 16u).x));
  sf(F_ICE, at, i32(v)); sf(F_DEB, at, i32(deb)); sf(F_SED, at, i32(sed));
  sf(F_RCK, at, gf(F_RCK, at) + i32(er)); sf(F_DS, at, gf(F_DS, at) + i32(ds)); sf(F_CV, at, gf(F_CV, at) + i32(cal));
}

// ---- the equilibrium line: the lowest height (Q6 m) where the balance is not negative, found by bisection, from the climate and the offset alone ----
@compute @workgroup_size(256)
fn ela(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  let count = P[2] * 65536u;
  if (idx >= count) { return; }
  let at = cellAt(idx);
  let lo = bitcast<i32>(P[${IP.elaLo}u]); let hi = bitcast<i32>(P[${IP.elaHi}u]);
  var res = 2147483647i;
  if (bal_at(at, hi) >= 0i) {
    var l = lo; var h = hi;
    if (bal_at(at, lo) >= 0i) { h = lo; } else {
      for (var it = 0u; it < 24u; it++) {
        let m = l + ((h - l) >> 1u);
        if (bal_at(at, m) >= 0i) { h = m; } else { l = m; }
      }
    }
    res = h;
  }
  sf(F_ELA, at, res);
}
`;
}
