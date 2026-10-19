// Plate tectonics on the globe's grid, on the GPU (host side, laws and constants: src/gpu/globe/tectonics.ts and
// docs/research/globe/2026-10-19-tectonics-impl.md). The kernels are appended to the grid's own source (globe-grid.ts), so
// they share its bindings (S the fields in the padded tile layout, T the tables, P the parameters), its `source` (the cell
// across a tile or face edge, with the quarter turns of the axes) and its integer helpers. Two bindings are new: A the
// atomic accumulators of the move (u32, the same layout as S) and Q the tables of this unit (plate rotations, the face's
// tangent nodes, the ocean's thermal buoyancy by age, the arcs' clock, the hot spots), and the cell centres are appended
// to T after the grid's own tables. All integer: no float sits between a buffer read and a buffer write.
//
// What a cell holds. Five volumes of rock (basalt, sediment, metasediment, granitoid, volcanic), each V = H a / 16 for a
// thickness H in m and the cell's area weight a (Q15 of the mean cell, T), so a volume is the conserved thing and the
// thickness is its quotient. Two sums that ride with the volumes: AGB, the basalt's age (the basalt volume over 1024 times
// its age in units of 0.5 My, summed) and ORG, the time since the column last grew by convergence, arc or hot spot (the
// whole volume over 1024 times the time, summed). PL is the plate (255 none).
//
// The move. Each cell is one parcel of its plate. It is carried by the plate's rotation for one step (a Q30 matrix),
// the point it lands on found by integer search of the face's tangent nodes, and its volumes are shared among the four
// cells nearest the point by bilinear (cloud in cell) weights that sum to exactly 2^16, each pool's rounding remainder
// going to the nearest cell, so every pool's total is conserved exactly and no cell is a hole. Where plates leave a gap
// the gap is new basalt; where they overlap the plate whose regional height (the plate's own columns averaged over a few cells) is
// lower has its basalt go under and its other rock scraped on. The crust an overlap stacks is spread over the plate as a wedge, thick crust
// then flows sideways by the load its region puts on the channel, and the root past the eclogite depth is cut.
//
// Parameters (P, u32): 0 to 15 are the grid's (0 tiles, 1 cells a side, 2 tiles in all); 16 and 17 a sweep's source and
// destination field bases; 18 the gap fill's sweep number; 22 the field that holds the regional height (claim);
// 19 the step in age units; 20 the pelagic sediment of a step in m; 21 the step's number; for the flow, 18 and 19 the
// source and destination of the regional volume (or of the stacked crust) and 20 the mode (0 the channel, 1 the wedge).
import { globeWgsl } from "./globe-grid";

// Fields of S, in the padded layout, one i32 a cell.
export const FLD = { VB: 0, VS: 1, VM: 2, VG: 3, VV: 4, AGB: 5, ORG: 6, PL: 7, Z: 8, SUB: 9, DIST: 10, DIST2: 11, PL2: 12, E2: 13, ZR: 20, ZR2: 21, VR: 22, VR2: 23, COUNT: 24 } as const;
// Fields of A (the atomic accumulators): coverage, the two rank keys, the winner plate's coverage, then the winner plate's and the other plates' seven
// extensive sums. The flux counters follow the fields (28 words: seven fluxes of four 8-bit limbs). STACK is no source or sink: the crust an
// overlap stacked on the winner's columns, which the wedge then spreads.
export const ACCF = { COV: 0, KR: 1, KC: 2, COVW: 3, W: 4, L: 11, COUNT: 18 } as const;
export const FLUX = { NEW: 0, SUB: 1, ARC: 2, HOT: 3, PEL: 4, TRIM: 5, STACK: 6, COUNT: 7 } as const;
export const NEXT = 7; // extensive fields: the five volumes, AGB, ORG

// ---- constants (each tagged: [cited R-number], [derived], [design], [gap], [UNVERIFIED], [analogue]) ----
export const PHYS = {
  // Densities, kg/m3 [cited R1411 sec. 2.2]: mantle 3300, water 1000, oceanic crust 2900, continental crust 2800, a mean of 2750 also used, sediment 2500.
  RHO_M: 3300, RHO_W: 1000,
  // Gravity, m/s2 [design: the operator's decision of 2026-10-19, as for the atmosphere]
  G: 9.81,
  // The five rocks' densities in the order basalt, sediment, metasediment, granitoid, volcanic. Basalt is the oceanic crust's 2900; sediment 2500 [cited R1411
  // eq. 2.10]; granitoid, metasediment and volcanic rock the continental crust's 2800 (the reference column's, so a granitoid column of 35 km stands at
  // z = 0; the mean of 2750 R1411 also uses would lift it 0.5 km) [analogue: no density read for the three].
  RHO: [2900, 2500, 2800, 2800, 2800],
  // The crust 35 km thick that stands at the reference level (z = 0): the continental crust's typical thickness [cited R1411 sec. 1.1].
  H0: 35_000,
  // Oceanic crust 6 km thick [cited R1411 sec. 1.1].
  H_OC: 6_000,
  // The depth the crust may not pass: below the isobar where lower crust turns to eclogite and founders into the mantle, 1.8 GPa [cited R1688: Chapman et al. 2017,
  // Cordillera Zealandia arc crust at least 65 km, 1.8 GPa]; over rho g = 2800 x 9.81 that is 65.5 km [derived], rounded to 65,500 m.
  H_MAX: 65_500,
  // The age unit, My [design: coarse steps are 2 My]; the ages' ceiling in units, 400 My [design: the oldest sea floor is some 200 My, R1411 sec. 1.1, twice that is a bound no cell reaches]; the divisor that
  // keeps the age sums in 32 bits [derived: a column of 70 km has V under 2^28, so V >> 10 is under 2^18 and times 800 under 2^28, and the sum of a few parcels' shares stays under 2^32].
  AGE_UNIT_MY: 0.5, AGE_MAX: 800, AGE_SHIFT: 10,
  // Overlap is a coverage over 17/16 and a gap one under 15/16 of the cell [design: the coverage of rigid motion is 1 to within the ripple measured in tectonics.test.ts].
  OVER_NUM: 17, GAP_NUM: 15,
  // The ownership smoothing: a cell with at most 2 of its 8 neighbours on its own plate, and at least 5 on one other, takes the other [design: a numerical regularisation of the plate map, the surface tension of its boundaries; the cloud in cell sharing decides ownership of a boundary cell from sub-cell sums, which jitter].
  SMOOTH_SAME: 2, SMOOTH_VOTES: 5,
  // A parcel claims a cell's plate by coverage only with at least 1/8 of the mean cell's area in it, and bids by rank in an overlap with at least 1/32 [design].
  CLAIM_MIN: 4096, RANK_MIN: 1024,
  // Arc to trench: the volcanic line lies 125 km over the slab [cited R1411 sec. 1.4], a slab dipping 40 degrees [design]: 149 km, 12 cells; the band 4 to 5 cells wide, a 50 km arc [cited R1415]. Distance in chamfer units of 5 a cell.
  ARC_LO: 50, ARC_HI: 70, CHAMFER_AXIS: 5, CHAMFER_DIAG: 7, DIST_INF: 2000,
  // The plutons outnumber the volcanics 30 to 1 in an arc [cited R1415].
  PLUTON_PER_VOLCANIC: 30,
  // Rank of a parcel: its elevation plus this, in m, clamped to 16 bits [design].
  RANK_BIAS: 8192,
  // The diffusion number of a sweep of the wedge's spreading, Q16: 0.2 [design: the explicit stencil's stable range, as FLOW.foMax]; the number of sweeps sets the
  // width the step's shortening is spread over (Setup.sweeps.wedge).
  WEDGE_FO: 13107,
} as const;

export interface TectonicsLayout {
  fn: number; // cells along a face's side
  plates: number;
  hotspots: number;
  steps: number; // arc table width: steps + 1
  rot: number; // offsets into Q
  node: number;
  phith: number;
  arc: number;
  hot: number;
  words: number;
  hmax: number; // the foundering depth, m
  hweak: number; // the thickness from which the lower crust flows, m
  foW: number; // the diffusion number of one flow sweep for a link of two weak columns, Q16
  foC: number; // and for a link to a cold column
}

export function tectonicsWgsl(edges: readonly (readonly { face: number; side: number; flip: boolean }[])[], L: TectonicsLayout, frames: readonly { n: readonly number[]; ex: readonly number[]; ey: readonly number[] }[]): string {
  const axis = (v: readonly number[]) => v.findIndex((x) => x !== 0);
  const sign = (v: readonly number[]) => v[axis(v)];
  const arr = (f: (fr: (typeof frames)[number]) => number) => frames.map(f).join(", ");
  const bits = Math.round(Math.log2(L.fn));
  const R = PHYS.RHO.map((r) => PHYS.RHO_M - r);
  const phi0 = PHYS.H0 * (PHYS.RHO_M - 2800);
  return /* wgsl */ `${globeWgsl(edges)}
@group(0) @binding(3) var<storage, read_write> A: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> Q: array<i32>;

const FN = ${L.fn}u;
const NP = ${L.plates}u;
const NH = ${L.hotspots}u;
const SW = ${L.steps + 1}u;
const Q_ROT = ${L.rot}u;
const Q_NODE = ${L.node}u;
const Q_PHITH = ${L.phith}u;
const Q_ARC = ${L.arc}u;
const Q_HOT = ${L.hot}u;
const TAB_COUNT = ${41}u;
const N_AX = array<u32, 6>(${arr((f) => axis(f.n))});
const EX_AX = array<u32, 6>(${arr((f) => axis(f.ex))});
const EY_AX = array<u32, 6>(${arr((f) => axis(f.ey))});
const N_SG = array<i32, 6>(${arr((f) => sign(f.n))});
const EX_SG = array<i32, 6>(${arr((f) => sign(f.ex))});
const EY_SG = array<i32, 6>(${arr((f) => sign(f.ey))});
const DR = array<i32, 5>(${R.join(", ")});
const PHI0 = ${phi0}i;
const HOC = ${PHYS.H_OC}u;
const HMAX = ${L.hmax}u;
const HWEAK = ${L.hweak}u;
const FO_W = ${L.foW}u;
const FO_C = ${L.foC}u;
const AGE_MAX = ${PHYS.AGE_MAX}u;
const ASHIFT = ${PHYS.AGE_SHIFT}u;
const CLAIM_MIN = ${PHYS.CLAIM_MIN}u;
const SMOOTH_SAME = ${PHYS.SMOOTH_SAME}u;
const SMOOTH_VOTES = ${PHYS.SMOOTH_VOTES}u;
const RANK_MIN = ${PHYS.RANK_MIN}u;
const RANK_BIAS = ${PHYS.RANK_BIAS}i;
const ARC_LO = ${PHYS.ARC_LO}u;
const ARC_HI = ${PHYS.ARC_HI}u;
const DIST_INF = ${PHYS.DIST_INF}u;
const CH_AX = ${PHYS.CHAMFER_AXIS}u;
const CH_DG = ${PHYS.CHAMFER_DIAG}u;
const PLUTONS = ${PHYS.PLUTON_PER_VOLCANIC + 1}u;
const NONE = 255u;

const F_VB = ${FLD.VB}u; const F_AGB = ${FLD.AGB}u; const F_ORG = ${FLD.ORG}u; const F_PL = ${FLD.PL}u; const F_Z = ${FLD.Z}u;
const F_ZR = ${FLD.ZR}u; const F_SUB = ${FLD.SUB}u; const F_DIST = ${FLD.DIST}u; const F_DIST2 = ${FLD.DIST2}u; const F_PL2 = ${FLD.PL2}u; const F_E2 = ${FLD.E2}u; const F_VR = ${FLD.VR}u;
const ACC_COVW = ${ACCF.COVW}u; const ACC_COV = ${ACCF.COV}u; const ACC_KR = ${ACCF.KR}u; const ACC_KC = ${ACCF.KC}u; const ACC_W = ${ACCF.W}u; const ACC_L = ${ACCF.L}u;
const ACC_COUNT = ${ACCF.COUNT}u;
const FLUX_TRIM = ${FLUX.TRIM}u; const FLUX_NEW = ${FLUX.NEW}u; const FLUX_SUB = ${FLUX.SUB}u; const FLUX_ARC = ${FLUX.ARC}u; const FLUX_HOT = ${FLUX.HOT}u; const FLUX_PEL = ${FLUX.PEL}u; const FLUX_STACK = ${FLUX.STACK}u;

fn touch() {
  _ = S[0]; _ = T[0]; _ = P[0]; _ = Q[0]; _ = atomicLoad(&A[0]);
}
fn cnt() -> u32 { return P[2] * 65536u; }
fn fwords() -> u32 { return P[2] * PAD2; }

// The cell a thread works on, in face coordinates.
fn srcOf(idx: u32) -> Src {
  let slot = idx >> 16u; let c = idx & 65535u;
  let tn = P[0]; let face = slot / (tn * tn); let rem = slot % (tn * tn);
  return Src(true, face, (rem % tn) * 256u + (c & 255u), (rem / tn) * 256u + (c >> 8u), 0u);
}
// The cell's index in the unpadded tables.
fn tIdxOf(c: Src) -> u32 {
  let t = P[0]; let slot = (c.face * t + (c.y >> 8u)) * t + (c.x >> 8u);
  return slot * 65536u + (c.y & 255u) * 256u + (c.x & 255u);
}
fn areaOf(c: Src) -> u32 { return u32(T[tIdxOf(c)]); }
// The neighbour in direction d (0 east, 1 north, 2 west, 3 south of the face's axes); rot is the turn of the axes there.
fn nbr(c: Src, d: u32) -> Src {
  var dx = 0; var dy = 0;
  if (d == 0u) { dx = 1; } else if (d == 1u) { dy = 1; } else if (d == 2u) { dx = -1; } else { dy = -1; }
  return source(c.face, i32(c.x) + dx, i32(c.y) + dy);
}
fn rs(f: u32, c: Src) -> u32 { return bitcast<u32>(S[wordOf(f, c)]); }
fn ws(f: u32, c: Src, v: u32) { S[wordOf(f, c)] = bitcast<i32>(v); }

fn thick(v: u32, a: u32) -> u32 { return (v / a) * 16u + ((v % a) * 16u) / a; }
// v * w / 2^16 for w up to 2^16.
fn part(v: u32, w: u32) -> u32 { let p = mul64(v, w); return (p.x >> 16u) | (p.y << 16u); }

// The surface height of a column above the reference level, m: the column's buoyancy against the mantle (the sum of
// thickness times the density deficit of each rock, plus the ocean lithosphere's thermal buoyancy for its age, in
// proportion to the basalt's share of an oceanic column), less the reference column's, over the mantle's density in air
// and over the mantle's less the water's under water.
fn elevOf(vb: u32, vs: u32, vm: u32, vg: u32, vv: u32, agb: u32, a: u32) -> i32 {
  let hb = thick(vb, a);
  var phi = i32(hb) * DR[0] + i32(thick(vs, a)) * DR[1] + i32(thick(vm, a)) * DR[2] + i32(thick(vg, a)) * DR[3] + i32(thick(vv, a)) * DR[4];
  let nb = vb >> ASHIFT;
  var age = 0u;
  if (nb > 0u) { age = min(agb / nb, AGE_MAX); }
  let pr = mul64(u32(Q[Q_PHITH + age]), min(hb, HOC));
  let th = divw(pr.y, pr.x, HOC).x;
  let d = phi + i32(th) - PHI0;
  var z = d / ${PHYS.RHO_M}i;
  if (d < 0) { z = d / ${PHYS.RHO_M - PHYS.RHO_W}i; }
  return z;
}

@compute @workgroup_size(256)
fn elev(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx); let a = areaOf(c);
  let z = elevOf(rs(F_VB, c), rs(F_VB + 1u, c), rs(F_VB + 2u, c), rs(F_VB + 3u, c), rs(F_VB + 4u, c), rs(F_AGB, c), a);
  S[wordOf(F_Z, c)] = z;
}

// The height that ranks a plate's columns in an overlap is the regional one: each column's height averaged over the same plate's
// cells in the 3 by 3 around it, sweep after sweep, so a few tens of km of the plate's own buoyancy stand in for the flexure of its
// lithosphere (the elastic plate carries a narrow load over its flexural scale). P16 and P17 are the source and destination fields.
@compute @workgroup_size(256)
fn regional(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let own = rs(F_PL, c);
  var sum = 0; var n = 0;
  for (var k = 0u; k < 9u; k++) {
    let nb = source(c.face, i32(c.x) + i32(k % 3u) - 1, i32(c.y) + i32(k / 3u) - 1);
    if (!nb.ok) { continue; }
    if (rs(F_PL, nb) != own) { continue; }
    sum = sum + S[wordOf(P[16], nb)];
    n = n + 1;
  }
  S[wordOf(P[17], c)] = sum / max(n, 1);
}

// ---- the move: where a parcel lands and how it is shared ----
var<private> hw: array<u32, 4>;
var<private> hc: array<Src, 4>;

fn rotc(p: u32, row: u32, v: vec3i) -> i32 {
  var s = vec2u(0u, 0u);
  s = add64(s, smul(Q[Q_ROT + p * 9u + row * 3u], v.x));
  s = add64(s, smul(Q[Q_ROT + p * 9u + row * 3u + 1u], v.y));
  s = add64(s, smul(Q[Q_ROT + p * 9u + row * 3u + 2u], v.z));
  return bitcast<i32>(shrRound(s, 30u).x);
}
// num / w in Q30 for w > 0, |num| at most about w, rounded toward zero and kept inside (-1, 1).
fn ratioQ30(num: i32, w: u32) -> i32 {
  let m = u32(abs(num));
  var q = divw(min(m >> 2u, w - 1u), m << 30u, w).x;
  q = min(q, 0x3fffffffu);
  return select(i32(q), -i32(q), num < 0);
}
fn findCell(rho: i32) -> u32 {
  var lo = 0u; var hi = FN;
  for (var i = 0u; i < ${bits}u; i++) {
    let mid = (lo + hi) >> 1u;
    if (Q[Q_NODE + mid] <= rho) { lo = mid; } else { hi = mid; }
  }
  return lo;
}
// The fraction of the way across cell k at ratio rho, Q16, linear in the tangent.
fn fracIn(k: u32, rho: i32) -> u32 {
  let diff = u32(rho - Q[Q_NODE + k]); let width = u32(Q[Q_NODE + k + 1u] - Q[Q_NODE + k]);
  return divw(min(diff >> 16u, width - 1u), diff << 16u, width).x;
}

// Where the parcel of cell c (plate p) lands after one step and the four weights: hw (Q16, summing to 2^16) and hc.
fn stencil(idx: u32, c: Src, p: u32) {
  let cn = cnt();
  let v = vec3i(T[(TAB_COUNT) * cn + idx], T[(TAB_COUNT + 1u) * cn + idx], T[(TAB_COUNT + 2u) * cn + idx]);
  let r = vec3i(rotc(p, 0u, v), rotc(p, 1u, v), rotc(p, 2u, v));
  var comp = array<i32, 3>(r.x, r.y, r.z);
  var dd = array<i32, 6>(r.x, r.y, -r.x, -r.y, r.z, -r.z);
  var face = 0u; var best = dd[0];
  for (var f = 1u; f < 6u; f++) { if (dd[f] > best) { best = dd[f]; face = f; } }
  let w = u32(max(best, 1));
  let ua = EX_SG[face] * comp[EX_AX[face]];
  let vb = EY_SG[face] * comp[EY_AX[face]];
  let rx = ratioQ30(ua, w); let ry = ratioQ30(vb, w);
  let X = findCell(rx); let Y = findCell(ry);
  let fx = fracIn(X, rx); let fy = fracIn(Y, ry);
  var nx = i32(X) + 1; var wxn = fx - 32768u; var wxo = 65536u - (fx - 32768u);
  if (fx < 32768u) { nx = i32(X) - 1; wxn = 32768u - fx; wxo = 32768u + fx; }
  var ny = i32(Y) + 1; var wyn = fy - 32768u; var wyo = 65536u - (fy - 32768u);
  if (fy < 32768u) { ny = i32(Y) - 1; wyn = 32768u - fy; wyo = 32768u + fy; }
  let own = Src(true, face, X, Y, 0u);
  var cx = source(face, nx, i32(Y));
  var cy = source(face, i32(X), ny);
  var cd = source(face, nx, ny);
  if (!cx.ok) { cx = own; }
  if (!cy.ok) { cy = own; }
  if (!cd.ok) { cd = own; }
  let w1 = (wxn * wyo) >> 16u; let w2 = (wxo * wyn) >> 16u; let w3 = (wxn * wyn) >> 16u;
  hw[0] = 65536u - w1 - w2 - w3; hw[1] = w1; hw[2] = w2; hw[3] = w3;
  hc[0] = own; hc[1] = cx; hc[2] = cy; hc[3] = cd;
}

fn vtotAt(f: u32, c: Src) -> u32 { return rs(f, c) + rs(f + 1u, c) + rs(f + 2u, c) + rs(f + 3u, c) + rs(f + 4u, c); }

// Pass one of the move: every parcel adds its coverage to the cells it lands in and, where it holds at least CLAIM_MIN of
// the cell (RANK_MIN for the first), bids for the cell's plate twice: by elevation (who rides over in an overlap) and by
// coverage (who owns a cell the plates share).
@compute @workgroup_size(256)
fn claim(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  if (vtotAt(F_VB, c) == 0u) { return; }
  let p = rs(F_PL, c);
  if (p >= NP) { return; }
  let a = areaOf(c);
  let rank = u32(clamp(S[wordOf(P[22], c)] + RANK_BIAS, 0, 65534)) + 1u;
  stencil(idx, c, p);
  for (var k = 0u; k < 4u; k++) {
    let w = hw[k];
    if (w == 0u) { continue; }
    let cv = (a * w + 32768u) >> 16u;
    let d = hc[k];
    atomicAdd(&A[wordOf(ACC_COV, d)], cv);
    if (cv >= RANK_MIN) { atomicMax(&A[wordOf(ACC_KR, d)], (rank << 8u) | p); }
    if (cv >= CLAIM_MIN) { atomicMax(&A[wordOf(ACC_KC, d)], (cv << 8u) | p); }
  }
}

// The plate that owns a landing cell: the highest-ranked bidder in an overlap, else the bidder with most coverage; NONE
// when nobody held enough of it.
fn winnerOf(d: Src, ad: u32, cov: u32) -> u32 {
  let over = cov * 16u > ad * ${PHYS.OVER_NUM}u;
  let key = select(atomicLoad(&A[wordOf(ACC_KC, d)]), atomicLoad(&A[wordOf(ACC_KR, d)]), over);
  return select(NONE, key & 255u, key != 0u);
}

// Pass two: every parcel shares each of its seven extensive fields among its four cells, into the winner plate's sums or
// the other plates', exactly: the three smaller shares floor, the nearest cell takes the rest.
@compute @workgroup_size(256)
fn deposit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  if (vtotAt(F_VB, c) == 0u) { return; }
  let p = rs(F_PL, c);
  if (p >= NP) { return; }
  var v = array<u32, 7>(rs(F_VB, c), rs(F_VB + 1u, c), rs(F_VB + 2u, c), rs(F_VB + 3u, c), rs(F_VB + 4u, c), rs(F_AGB, c), rs(F_ORG, c));
  let a = areaOf(c);
  stencil(idx, c, p);
  for (var k = 0u; k < 4u; k++) {
    if (hw[k] == 0u) { continue; }
    let d = hc[k];
    let wp = winnerOf(d, areaOf(d), atomicLoad(&A[wordOf(ACC_COV, d)]));
    if (wp == NONE || wp == p) { atomicAdd(&A[wordOf(ACC_COVW, d)], (a * hw[k] + 32768u) >> 16u); }
  }
  for (var j = 0u; j < 7u; j++) {
    let p1 = part(v[j], hw[1]); let p2 = part(v[j], hw[2]); let p3 = part(v[j], hw[3]);
    let share = array<u32, 4>(v[j] - p1 - p2 - p3, p1, p2, p3);
    for (var k = 0u; k < 4u; k++) {
      if (hw[k] == 0u) { continue; }
      let d = hc[k];
      let cov = atomicLoad(&A[wordOf(ACC_COV, d)]);
      let wp = winnerOf(d, areaOf(d), cov);
      let base = select(ACC_L, ACC_W, wp == NONE || wp == p);
      atomicAdd(&A[wordOf(base + j, d)], share[k]);
    }
  }
}

fn addFlux(kind: u32, v: u32) {
  if (v == 0u) { return; }
  let base = ACC_COUNT * fwords() + kind * 4u;
  for (var l = 0u; l < 4u; l++) { atomicAdd(&A[base + l], (v >> (8u * l)) & 255u); }
}

// Pass three: each cell turns its sums into its new column. An overlap (coverage over the bound): the winner's rock
// stays, the other plates' basalt goes under (the flux SUB) and their sediment and other rock are scraped on, sediment
// becoming metasediment; the cell's orogeny clock is reset. Otherwise everything merges. A gap (coverage under the
// bound) is filled with new basalt of age zero to the area that is bare.
@compute @workgroup_size(256)
fn resolve(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx); let a = areaOf(c);
  let cov = atomicLoad(&A[wordOf(ACC_COV, c)]);
  let over = cov * 16u > a * ${PHYS.OVER_NUM}u;
  let gap = cov * 16u < a * ${PHYS.GAP_NUM}u;
  let wp = winnerOf(c, a, cov);
  var nv = array<u32, 7>(0u, 0u, 0u, 0u, 0u, 0u, 0u);
  var lost = 0u; var stacked = 0u;
  for (var j = 0u; j < 7u; j++) {
    nv[j] = atomicLoad(&A[wordOf(ACC_W + j, c)]) + atomicLoad(&A[wordOf(ACC_L + j, c)]);
  }
  if (over) {
    // the lower plates' share that lies under the winner: the overlap (coverage less the cell) over their coverage
    let covL = cov - atomicLoad(&A[wordOf(ACC_COVW, c)]);
    var q = 0u;
    if (covL > 0u) { let x = min(cov - a, covL); q = divw(x >> 16u, x << 16u, covL).x; }
    var l = array<u32, 7>(0u, 0u, 0u, 0u, 0u, 0u, 0u);
    var u = array<u32, 7>(0u, 0u, 0u, 0u, 0u, 0u, 0u);
    for (var j = 0u; j < 7u; j++) {
      l[j] = atomicLoad(&A[wordOf(ACC_L + j, c)]);
      u[j] = part(l[j], q);
    }
    lost = u[0]; stacked = u[1] + u[2] + u[3] + u[4];
    // under the winner: basalt goes down, sediment and the other rock are scraped on (sediment becomes metasediment); the rest of them stays
    nv[0] = nv[0] - u[0];
    nv[1] = nv[1] - u[1];
    nv[2] = nv[2] + u[1];
    nv[5] = nv[5] - u[5];
    nv[6] = 0u;
  }
  var fresh = 0u;
  if (gap) {
    fresh = ((a - cov) * HOC) >> 4u;
    nv[0] = nv[0] + fresh;
  }
  for (var j = 0u; j < 7u; j++) { ws(F_VB + j, c, nv[j]); }
  var plate = wp;
  if (cov == 0u) { plate = NONE; }
  ws(F_PL, c, plate);
  ws(F_SUB, c, lost);
  ws(F_VR, c, stacked);
  addFlux(FLUX_NEW, fresh);
  addFlux(FLUX_SUB, lost);
  addFlux(FLUX_STACK, stacked);
}

// ---- plates for the cells no parcel owned ----
@compute @workgroup_size(256)
fn gapfill(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let own = rs(P[16], c);
  var out = own;
  if (own == NONE) {
    var cand = array<u32, 4>(NONE, NONE, NONE, NONE);
    var n = 0u;
    for (var d = 0u; d < 4u; d++) {
      let q = rs(P[16], nbr(c, d));
      if (q != NONE) { cand[n] = q; n = n + 1u; }
    }
    if (n > 0u) {
      var h = idx * 2654435761u + P[18] * 40503u;
      h = (h ^ (h >> 15u)) * 2246822519u;
      h = h ^ (h >> 13u);
      out = cand[h % n];
    }
  }
  ws(P[17], c, out);
}

// ---- plate ownership is smoothed: a cell that has almost none of its eight neighbours on its plate and five on one other takes that plate ----
@compute @workgroup_size(256)
fn plateSmooth(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let own = rs(P[16], c);
  var seen = array<u32, 8>(NONE, NONE, NONE, NONE, NONE, NONE, NONE, NONE);
  var same = 0u;
  for (var k = 0u; k < 8u; k++) {
    var dx = 0; var dy = 0;
    if (k == 0u) { dx = 1; } else if (k == 1u) { dy = 1; } else if (k == 2u) { dx = -1; } else if (k == 3u) { dy = -1; }
    else if (k == 4u) { dx = 1; dy = 1; } else if (k == 5u) { dx = -1; dy = 1; } else if (k == 6u) { dx = -1; dy = -1; } else { dx = 1; dy = -1; }
    let nb = source(c.face, i32(c.x) + dx, i32(c.y) + dy);
    if (nb.ok) { seen[k] = rs(P[16], nb); if (seen[k] == own) { same = same + 1u; } }
  }
  var out = own;
  if (same <= SMOOTH_SAME) {
    for (var k = 0u; k < 8u; k++) {
      let q = seen[k];
      if (q == own || q == NONE) { continue; }
      var votes = 0u;
      for (var m = 0u; m < 8u; m++) { if (seen[m] == q) { votes = votes + 1u; } }
      if (votes >= SMOOTH_VOTES) { out = q; break; }
    }
  }
  ws(P[17], c, out);
}

// ---- the distance to the trench, over the overriding plate ----
@compute @workgroup_size(256)
fn distInit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  ws(F_DIST, c, select(DIST_INF, 0u, rs(F_SUB, c) > 0u));
}
@compute @workgroup_size(256)
fn distSweep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let pl = rs(F_PL, c);
  var best = rs(P[16], c);
  if (rs(F_SUB, c) > 0u) { best = 0u; }
  for (var k = 0u; k < 8u; k++) {
    var dx = 0; var dy = 0; var cost = CH_AX;
    if (k == 0u) { dx = 1; } else if (k == 1u) { dy = 1; } else if (k == 2u) { dx = -1; } else if (k == 3u) { dy = -1; }
    else {
      cost = CH_DG;
      if (k == 4u) { dx = 1; dy = 1; } else if (k == 5u) { dx = -1; dy = 1; } else if (k == 6u) { dx = -1; dy = -1; } else { dx = 1; dy = -1; }
    }
    let nb = source(c.face, i32(c.x) + dx, i32(c.y) + dy);
    if (!nb.ok) { continue; }
    if (rs(F_PL, nb) != pl) { continue; }
    best = min(best, rs(P[16], nb) + cost);
  }
  ws(P[17], c, min(best, DIST_INF));
}

// ---- magma: arcs over the slab, hot spots, pelagic sediment, and the clocks ----
@compute @workgroup_size(256)
fn magma(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx); let a = areaOf(c);
  var vb = rs(F_VB, c); var vs = rs(F_VB + 1u, c); var vm = rs(F_VB + 2u, c); var vg = rs(F_VB + 3u, c); var vv = rs(F_VB + 4u, c);
  var agb = rs(F_AGB, c); var org = rs(F_ORG, c);
  let pl = rs(F_PL, c);
  var event = false;
  var arcAdd = 0u; var hotAdd = 0u; var pelAdd = 0u;
  let d = rs(F_DIST, c);
  if (d >= ARC_LO && d <= ARC_HI && pl < NP) {
    let dh = u32(max(Q[Q_ARC + pl * SW + P[21]], 0));
    arcAdd = (dh * a) >> 4u;
    let vol = arcAdd / PLUTONS;
    vv = vv + vol; vg = vg + (arcAdd - vol);
    if (arcAdd > 0u) { event = true; }
  }
  let cn = cnt();
  let cv = vec3i(T[(TAB_COUNT) * cn + idx], T[(TAB_COUNT + 1u) * cn + idx], T[(TAB_COUNT + 2u) * cn + idx]);
  for (var h = 0u; h < NH; h++) {
    let o = Q_HOT + h * 6u;
    var dot = vec2u(0u, 0u);
    dot = add64(dot, smul(Q[o], cv.x));
    dot = add64(dot, smul(Q[o + 1u], cv.y));
    dot = add64(dot, smul(Q[o + 2u], cv.z));
    let cosd = bitcast<i32>(shrRound(dot, 30u).x);
    let cosr = Q[o + 3u];
    if (cosd >= cosr) {
      let diff = u32(cosd - cosr); let span = u32(1073741824 - cosr);
      let q = divw(min(diff >> 16u, span - 1u), diff << 16u, span).x;
      let dh = (u32(Q[o + 4u]) * q) >> 16u;
      let vol = (dh * a) >> 4u;
      vv = vv + vol; hotAdd = hotAdd + vol;
      if (vol > 0u) { event = true; }
    }
  }
  if (vb > 0u && vb >= vm + vg + vv && !event) {
    pelAdd = (P[20] * a) >> 4u;
    vs = vs + pelAdd;
  }
  if (event) { org = 0u; }
  let vt = vb + vs + vm + vg + vv;
  agb = min(agb + (vb >> ASHIFT) * P[19], (vb >> ASHIFT) * AGE_MAX);
  org = min(org + (vt >> ASHIFT) * P[19], (vt >> ASHIFT) * AGE_MAX);
  ws(F_VB + 1u, c, vs); ws(F_VB + 3u, c, vg); ws(F_VB + 4u, c, vv);
  ws(F_AGB, c, agb); ws(F_ORG, c, org);
  addFlux(FLUX_ARC, arcAdd); addFlux(FLUX_HOT, hotAdd); addFlux(FLUX_PEL, pelAdd);
}

// ---- gravity-driven flow of thick crust ----
// Crust thick enough to be hot at its base (HWEAK) flows sideways in a weak lower-crustal channel (Poiseuille flow between
// stationary boundaries: the flux is H^3 rho g / (12 eta) times the gradient of the load on the channel [cited R1684]), into
// continental neighbours only. The load the channel feels is the column's weight as the strong upper crust over it passes it on: a
// load narrower than the plate's flexural scale (a valley, a pile at the front) is held by the plate's bending, so the pressure in the
// channel follows the regional thickness, the thickness averaged over the plate's continental cells (Sweeps.load) [INFERENCE R1695].
// In regional thickness the law is diffusion, d hr / d t = D (laplacian of hr), so one sweep sends
// Fo (hr - hr_n) of thickness from a column to a neighbour n of lower hr, Fo the diffusion number of the sweep (FO_W for a link
// of two weak columns, FO_C for a link to a cold one: the margin's viscosity decides the flux); the sender's composition goes
// with it, and the regional volume (VR) moves by the same amount, so a column's departure from its region (h - hr) is what the
// flow leaves alone.
fn thickAt(base: u32, c: Src) -> u32 { return thick(vtotAt(base, c), areaOf(c)); }
fn contAt(base: u32, c: Src) -> bool { return rs(base + 2u, c) + rs(base + 3u, c) + rs(base + 4u, c) > rs(base, c); }
// The regional thickness: a column's thickness (loadInit), averaged over the same plate's continental cells in the 3 by 3 around
// it sweep after sweep (loadSweep, P16 to P17; a cell of ocean floor keeps its own), then turned back into a volume on the
// column's area (loadVol, from P16 into VR).
@compute @workgroup_size(256)
fn loadInit(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  ws(F_ZR, c, thickAt(F_VB, c));
}
@compute @workgroup_size(256)
fn loadSweep(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  if (!contAt(F_VB, c)) { ws(P[17], c, rs(P[16], c)); return; }
  let own = rs(F_PL, c);
  var sum = 0u; var n = 0u;
  for (var k = 0u; k < 9u; k++) {
    let nb = source(c.face, i32(c.x) + i32(k % 3u) - 1, i32(c.y) + i32(k / 3u) - 1);
    if (!nb.ok) { continue; }
    if (rs(F_PL, nb) != own || !contAt(F_VB, nb)) { continue; }
    sum = sum + rs(P[16], nb);
    n = n + 1u;
  }
  ws(P[17], c, sum / n);
}
@compute @workgroup_size(256)
fn loadVol(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  var v = vtotAt(F_VB, c);
  if (contAt(F_VB, c)) { let p = mul64(rs(P[16], c), areaOf(c)); v = (p.x >> 4u) | (p.y << 28u); }
  ws(F_VR, c, v);
}
// The share (Q16) of the column's volume that leaves: the excess over the foundering depth. The column's own thickness sets the
// pressure at its base, as the heights' isostasy is local.
fn outFrac(base: u32, c: Src) -> u32 {
  let vt = vtotAt(base, c); let cp = (HMAX * areaOf(c)) >> 4u;
  if (vt <= cp) { return 0u; }
  let ex = vt - cp;
  return divw(ex >> 16u, ex << 16u, vt).x;
}
// The share (Q16) of cell j's column that goes to its neighbour in direction d, at most a quarter so that four links never take
// more than the column holds. The channel (P20 = 0): Fo (hr_j - hr_n) of thickness over the column's own thickness. The wedge
// (P20 = 1): the crust a step stacked in an overlap (r) spreads over the same plate's continental cells by a diffusion of
// number WEDGE_FO, Fo (r_j - r_n) of volume over the column's own: pure shear spreads a shortening over the orogen's width
// [cited R1413 through R1672; the width, Sweeps.wedge, R1696].
fn shareTo(base: u32, r: u32, j: Src, d: u32) -> u32 {
  if (!contAt(base, j)) { return 0u; }
  let n = nbr(j, d);
  if (!contAt(base, n)) { return 0u; }
  if (P[20] == 1u) {
    if (rs(F_PL, n) != rs(F_PL, j)) { return 0u; }
    let rj = rs(r, j); let rn = rs(r, n);
    if (rn >= rj) { return 0u; }
    let m = part(rj - rn, ${PHYS.WEDGE_FO}u);
    return min(divw(m >> 16u, m << 16u, max(vtotAt(base, j), 1u)).x, 16384u);
  }
  let hj = thick(rs(r, j), areaOf(j));
  if (hj < HWEAK) { return 0u; }
  let hn = thick(rs(r, n), areaOf(n));
  if (hn >= hj) { return 0u; }
  var fo = FO_C;
  if (hn >= HWEAK) { fo = FO_W; }
  let own = max(thickAt(base, j), 1u);
  return min((fo * (hj - hn)) / own, 16384u);
}
@compute @workgroup_size(256)
fn crustflow(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let fa = P[16]; let fb = P[17]; let ra = P[18]; let rb = P[19];
  var outS = array<u32, 4>(0u, 0u, 0u, 0u);
  var inS = array<u32, 4>(0u, 0u, 0u, 0u);
  var inN = array<Src, 4>(c, c, c, c);
  for (var d = 0u; d < 4u; d++) {
    outS[d] = shareTo(fa, ra, c, d);
    let nb = nbr(c, d);
    inN[d] = nb;
    inS[d] = shareTo(fa, ra, nb, (d + 2u + nb.rot) & 3u);
  }
  var vo = 0u; var vi = 0u;
  for (var j = 0u; j < 7u; j++) {
    let v = rs(fa + j, c);
    var o = 0u; var i = 0u;
    for (var d = 0u; d < 4u; d++) {
      o = o + part(v, outS[d]);
      i = i + part(rs(fa + j, inN[d]), inS[d]);
    }
    ws(fb + j, c, v - o + i);
    if (j < 5u) { vo = vo + o; vi = vi + i; }
  }
  ws(rb, c, rs(ra, c) - vo + vi);
}

// What is left past the foundering depth is cut: the column keeps its depth's volume, the rest is the flux TRIM (the eclogite root
// that sinks into the mantle).
@compute @workgroup_size(256)
fn trim(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  touch();
  let idx = flatIndex(gid, nwg);
  if (idx >= cnt()) { return; }
  let c = srcOf(idx);
  let f = outFrac(P[16], c);
  if (f == 0u) { return; }
  var cut = 0u;
  for (var j = 0u; j < 7u; j++) {
    let v = rs(P[16] + j, c);
    let o = part(v, f);
    if (j < 5u) { cut = cut + o; }
    ws(P[16] + j, c, v - o);
  }
  addFlux(FLUX_TRIM, cut);
}
`;
}
