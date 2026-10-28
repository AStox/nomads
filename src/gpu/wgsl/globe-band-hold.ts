// The band-limited hold (the quadratic B-spline moment of the land's loss on the tier-0 lattice, or on every second tier-0 cell at span 2), ported from the band-limited hold note's kernels
// (docs/research/globe/2026-10-24-band-limited-hold.md) beside the box hold, which tiers that run without it keep: the same entry points under another name (b-prefixed), laid over the
// same AT words after the counters, a tier uses one or the other. The whole-tier, patch and streamed paths all have it.
export const BAND_PARENT_WORDS = 73;
export const BAND_CNT = { clamped: 4, dropped: 5 } as const;
export const BAND_FLAG_CARRY = 8;
export const bandHoldWgsl = (span: 1 | 2): string => /* wgsl */ `
const BUP = ${span}u; const BGN = ${256 / span}u; const BGNI = ${256 / span}i;
const CNT_CLAMPED = ${BAND_CNT.clamped}u; const CNT_DROPPED = ${BAND_CNT.dropped}u; const FLAG_CARRY = ${BAND_FLAG_CARRY}i;
const B_PS = A_CNT + 16u; const B_PC = B_PS + NP; const B_CARRY = B_PC + NP; const B_CARRYH = B_CARRY + NP; const B_PH = B_CARRYH + NP; const B_P3 = B_PH + NP; const B_PM = B_P3 + NP; const B_PL = B_PM + NP;
const B_RM = B_PL + NP; const B_RH = B_RM + NP; const B_R3 = B_RH + NP; const B_PM2 = B_R3 + NP; const B_ST = B_PM2 + NP; const B_NB = B_ST + 45u * NP; const B_IV = B_NB + 8u * NP;
// ---- the uplift: what the land lost comes back as the smooth field that leaves the planet's low-pass kept, not each tier-0 cell's box mean ----
// The rise of a land cell is R m, the quadratic B-spline interpolation of coefficients m on the tier-0 cells (the nine whose centres lie within one cell; the carry-down stencil's
// limit, so the reconstruction space V is the one the planet's tier-0 field is carried into). The conserved quantity is the analysis A = R^T, the B-spline-weighted moment of the land's
// height at every tier-0 centre (a cell's weights over the nine centres sum to one): A is the L2 projection onto V, so what a step takes off and does not put back lies in the
// orthogonal complement of V, and what V can represent (wavelengths over the tier-0 lattice's two cells) cannot drift. Each step solves the Gram system (R^T D R) m = R^T D loss + carry,
// D the land mask, for m: the best fit of the loss on the land by V, so the rise is the part of the loss the tier-0 lattice can carry, paid to the unit, and the rest stays lowered
// [design: the operator's band-limited hold]. A cell's weights are the products of the axes' B-spline weights in Q12 (the nine sum to 4096 exactly, a missing diagonal cell's weight
// to the cell's own slot); the same integers weigh the loss, the Gram matrix and the realized rises, so the moments plus the carry are kept exactly. Words per tier-0 cell: BL, BH the
// weighted loss (the loss in 6-bit digits and the rest, apart so that the sums stay in 32 bits at a span of two tier-0 cells over tier 5's 64 by 64 cells), the carry (64 bits), the coefficients and their second buffer, RL, RM, RH, R3 the weighted rises as BL, BM, BH, B3,
// the Gram matrix's 45 pair sums (Q16, the weights' products over 2^8, over the pairs of a cell's nine slots), and the eight neighbours' ids and the slot each has this cell in.
@compute @workgroup_size(256)
fn bpzero(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  atomicStore(&AT[B_PS + p], 0i);
  atomicStore(&AT[B_PC + p], 0i);
  atomicStore(&AT[B_PH + p], 0i);
  atomicStore(&AT[B_PL + p], 0i);
  atomicStore(&AT[B_RM + p], 0i);
  atomicStore(&AT[B_RH + p], 0i);
  atomicStore(&AT[B_P3 + p], 0i);
  atomicStore(&AT[B_R3 + p], 0i);
}
@compute @workgroup_size(256)
fn bpstzero(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  for (var s = 0u; s < 45u; s++) { atomicStore(&AT[B_ST + p * 45u + s], 0i); }
}
// the tier-0 cell next to p in direction d (0 east, 1 north, 2 west, 3 south, 4 NE, 5 NW, 6 SW, 7 SE), across a face's edge where it is one; NONE at a cube's corner's missing diagonal
fn bpnbr(p: u32, d: u32) -> u32 {
  let f = p / 65536u; let r = p - f * 65536u; let y = i32(r / 256u); let x = i32(r - u32(y) * 256u);
  let o = DXY[d]; let nx = x + o.x; let ny = y + o.y;
  let xo = nx < 0 || nx >= BGNI; let yo = ny < 0 || ny >= BGNI;
  if (!xo && !yo) { return u32(i32(p) + o.y * 256 + o.x); }
  if (xo && yo) { return NONE; }
  var s = 1u; var along = nx;
  if (xo) { s = select(0u, 2u, nx < 0); along = ny; } else { s = select(1u, 3u, ny < 0); }
  let e = f * 4u + s;
  let gs = EDGE_SIDE[e];
  let a = select(along, BGNI - 1 - along, EDGE_FLIP[e] == 1u);
  var gx = a; var gy = a;
  if (gs == 0u) { gx = BGNI - 1; } else if (gs == 1u) { gy = BGNI - 1; } else if (gs == 2u) { gx = 0; } else { gy = 0; }
  return EDGE_FACE[e] * 65536u + u32(gy) * 256u + u32(gx);
}
fn i64of(x: i32) -> vec2u { return vec2u(bitcast<u32>(x), select(0u, 0xffffffffu, x < 0i)); }
fn shl64(a: vec2u, s: u32) -> vec2u { return vec2u(a.x << s, (a.y << s) | (a.x >> (32u - s))); }
// the neighbours of every tier-0 cell once, and for each the slot this cell takes in that neighbour's own frame (a face's edge turns the frame)
fn bnb(p: u32, d: u32) -> u32 { return bitcast<u32>(fl(B_NB + p * 8u + d)); }
fn biv(p: u32, d: u32) -> u32 { return u32(fl(B_IV + p * 8u + d)); }
@compute @workgroup_size(256)
fn bgnbr(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  let px = (p % 65536u) % 256u; let py = (p % 65536u) / 256u;
  for (var d = 0u; d < 8u; d++) {
    var q = NONE;
    if (px < BGN && py < BGN) { q = bpnbr(p, d); }
    atomicStore(&AT[B_NB + p * 8u + d], bitcast<i32>(q));
    var back = 8u;
    if (q != NONE) { for (var s = 0u; s < 8u; s++) { if (back == 8u && bpnbr(q, s) == p) { back = s; } } }
    atomicStore(&AT[B_IV + p * 8u + d], i32(back));
  }
}
// the index of the pair (a, b), a <= b, of the nine slots (0 to 7 the neighbours, 8 the cell itself)
fn bpidx(a: u32, b: u32) -> u32 { return 8u * a - (a * (max(a, 1u) - 1u)) / 2u + b; }
// the cell's weights, Q12, on the nine tier-0 cells whose centres lie within one cell of it: the quadratic B-spline's along each axis for a cell at offset u from its tier-0 centre
// (|u| < 1/2: (1/2 - u)^2 / 2, 3/4 - u^2 and (1/2 + u)^2 / 2 for the neighbour on the low side, the cell and the one on the high side), exact over 8 B^2 per axis
struct BGw { q: array<u32, 9>, w: array<u32, 9> }
fn bgw(k: u32) -> BGw {
  let c = cid(k); let f = c / CELLS; let r = c - f * CELLS; let Y = r / FN; let X = r - Y * FN;
  let SP = FACT * BUP; let B = i32(SP); let ax = 2 * i32(X % SP) + 1 - B; let ay = 2 * i32(Y % SP) + 1 - B;
  let wx = array<u32, 3>(u32((B - ax) * (B - ax)), u32(2 * (3 * B * B - ax * ax)), u32((B + ax) * (B + ax)));
  let wy = array<u32, 3>(u32((B - ay) * (B - ay)), u32(2 * (3 * B * B - ay * ay)), u32((B + ay) * (B + ay)));
  let p = (f * 256u + Y / SP) * 256u + X / SP;
  let den = SP * SP * SP * SP;
  var o: BGw; var rest = 4096u;
  for (var s = 0u; s < 8u; s++) {
    let q = bnb(p, s);
    var w = 0u;
    if (q != NONE) { let v = wx[u32(DXY[s].x + 1)] * wy[u32(DXY[s].y + 1)]; w = select((v * 64u) / den, v / (den / 64u), den >= 64u); rest -= w; }
    o.q[s] = q; o.w[s] = w;
  }
  o.q[8] = p; o.w[8] = rest;
  return o;
}
// the loss's moments (a patch tallies the Gram matrix once and the loss after each stage's visit)
fn btally_count(k: u32) {
  if (!interior(k) || !is_land(k)) { return; }
  let g = bgw(k); let p = g.q[8];
  for (var a = 0u; a < 9u; a++) {
    if (g.w[a] == 0u) { continue; }
    for (var b = a; b < 9u; b++) {
      if (g.w[b] == 0u) { continue; }
      atomicAdd(&AT[B_ST + p * 45u + bpidx(a, b)], i32((g.w[a] * g.w[b]) >> 8u));
    }
  }
}
fn btally_loss(k: u32) {
  if (!interior(k) || !is_land(k)) { return; }
  let er = e_get(E_ER, k); let lo = er & 63i; let mid = (er >> 6u) & 63i; let hi = (er >> 12u) & 63i; let top = er >> 18u;
  let g = bgw(k);
  for (var s = 0u; s < 9u; s++) {
    let w = i32(g.w[s]);
    if (w == 0i) { continue; }
    atomicAdd(&AT[B_PS + g.q[s]], w * lo);
    atomicAdd(&AT[B_PC + g.q[s]], w * mid);
    atomicAdd(&AT[B_PH + g.q[s]], w * hi);
    let was = atomicAdd(&AT[B_P3 + g.q[s]], w * top);
    if (abs(was) > 0x20000000i) { flag(FLAG_CARRY); }
  }
}
// the streamed tier's two halves of btally: the Gram counts once, at the step's end, and the loss after each stage's visit (the box hold's tallyc and tallyl)
@compute @workgroup_size(256)
fn btallyc(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  btally_count(k);
}
@compute @workgroup_size(256)
fn btallyl(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  btally_loss(k);
}
@compute @workgroup_size(256)
fn btally(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  btally_count(k);
  btally_loss(k);
}
// the right side of the Gram system of a tier-0 cell, 64 bits: the weighted loss plus the carry, over 2^-12 (the weights' Q12): the system is in Q24
fn bmoments(l: u32, m: u32, h: u32, t: u32, p: u32) -> vec2u { return add64(add64(shl64(i64of(fl(t + p)), 18u), shl64(i64of(fl(h + p)), 12u)), add64(shl64(i64of(fl(m + p)), 6u), i64of(fl(l + p)))); }
fn bcarry_of(p: u32) -> vec2u { return vec2u(bitcast<u32>(fl(B_CARRY + p)), bitcast<u32>(fl(B_CARRYH + p))); }
fn baim_of(p: u32) -> vec2u { return shl64(add64(bmoments(B_PS, B_PC, B_PH, B_P3, p), bcarry_of(p)), 12u); }
@compute @workgroup_size(256)
fn bpmean(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  atomicStore(&AT[B_PM + p], 0i);
}
// One Jacobi sweep of the Gram system from the coefficients in one buffer to the other: the row of a tier-0 cell q is every pair of weights of the cells round it that meet on q
// (the Gram matrix, Q16, the coefficients Q8 of 1/256 m), and q moves by the row's miss over the row's sum. The matrix is non-negative and symmetric positive semi-definite, so the
// sweep's factor is 1 minus an eigenvalue of (row sum)^-1 M in (0, 1]: every mode converges without overshoot, the slowest (the checkerboard of both axes, 0.018 on a land that fills the
// lattice) leaves 0.982^128 = 0.1 of its error, the one-axis Nyquist 1e-8 [derived from the Gram of the quadratic B-spline's translates: 11/20, 13/60, 1/120]. The carry pays what is left.
fn bsolve_sweep(q: u32, src: u32, dst: u32) {
  var any = fl(B_ST + q * 45u + 44u) != 0i;
  for (var j = 0u; j < 8u && !any; j++) { let p = bnb(q, j); if (p != NONE && fl(B_ST + p * 45u + 44u) != 0i) { any = true; } }
  if (!any) { atomicStore(&AT[dst + q], 0i); return; }
  var pos = vec2u(0u, 0u); var neg = vec2u(0u, 0u); var rs = 0u;
  for (var j = 0u; j < 9u; j++) {
    var p = q; var sq = 8u;
    if (j < 8u) { p = bnb(q, j); if (p == NONE) { continue; } sq = biv(q, j); }
    for (var t = 0u; t < 9u; t++) {
      var c = p;
      if (t < 8u) { c = bnb(p, t); if (c == NONE) { continue; } }
      let w = u32(fl(B_ST + p * 45u + bpidx(min(sq, t), max(sq, t))));
      if (w == 0u) { continue; }
      rs += w;
      let m = fl(src + c);
      if (m >= 0i) { pos = add64(pos, mul64(w, u32(m))); } else { neg = add64(neg, mul64(w, u32(-m))); }
    }
  }
  if (rs == 0u) { atomicStore(&AT[dst + q], 0i); return; }
  let res = sub64(baim_of(q), sub64(pos, neg));
  let ng = isneg64(res);
  let mg = select(res, neg64(res), ng);
  var d = 0x3fffffffi;
  if (mg.y < (rs >> 1u)) { d = sdiv(false, mg, rs); }
  d = select(d, -d, ng);
  atomicStore(&AT[dst + q], clamp(fl(src + q) + d, -0x3fffffffi, 0x3fffffffi));
}
@compute @workgroup_size(256)
fn bpsolve(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  bsolve_sweep(p, B_PM, B_PM2);
}
@compute @workgroup_size(256)
fn bpsolve2(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  bsolve_sweep(p, B_PM2, B_PM);
}
// every land cell rises by R m, rounded to the unit, but is held at one unit where that would take it to the sea (the shortfall is counted: the carry owes it to the next steps' loss)
@compute @workgroup_size(256)
fn blift(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let k = gk(gid, nwg);
  if (k >= N) { return; }
  if (!interior(k) || !is_land(k)) { return; }
  let g = bgw(k);
  var pos = vec2u(0u, 0u); var neg = vec2u(0u, 0u);
  for (var s = 0u; s < 9u; s++) {
    if (g.w[s] == 0u) { continue; }
    let m = fl(B_PM + g.q[s]);
    if (m >= 0i) { pos = add64(pos, mul64(g.w[s], u32(m))); } else { neg = add64(neg, mul64(g.w[s], u32(-m))); }
  }
  let v = add64(sub64(pos, neg), vec2u(0x80000u, 0u));
  let rise = bitcast<i32>((v.x >> 20u) | (v.y << 12u));
  let h = e_get(E_H, k);
  let want = h + rise;
  let nh = max(1i, want);
  if (nh != want) { atomicAdd(&AT[A_CNT + CNT_CLAMPED], 1i); atomicAdd(&AT[A_CNT + CNT_DROPPED], nh - want); }
  e_set(E_H, k, nh);
  let d = nh - h; let lo = d & 63i; let mid = (d >> 6u) & 63i; let hi = (d >> 12u) & 63i; let top = d >> 18u;
  for (var s = 0u; s < 9u; s++) {
    let w = i32(g.w[s]);
    if (w == 0i) { continue; }
    atomicAdd(&AT[B_PL + g.q[s]], w * lo);
    atomicAdd(&AT[B_RM + g.q[s]], w * mid);
    atomicAdd(&AT[B_RH + g.q[s]], w * hi);
    atomicAdd(&AT[B_R3 + g.q[s]], w * top);
  }
}
// what the moments were short of: the weighted loss plus the old carry less the weighted rises
@compute @workgroup_size(256)
fn bpcarry(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let p = gk(gid, nwg);
  if (p >= NP) { return; }
  let nc = sub64(add64(bmoments(B_PS, B_PC, B_PH, B_P3, p), bcarry_of(p)), bmoments(B_PL, B_RM, B_RH, B_R3, p));
  atomicStore(&AT[B_CARRY + p], bitcast<i32>(nc.x));
  atomicStore(&AT[B_CARRYH + p], bitcast<i32>(nc.y));
}
`;
