// The island's crust, its erosion, the ice's scour and till and the hollows (src/terrain/island.ts holds the constants, each
// cited there) in WGSL, integer throughout; src/gpu/terrain/upstream.ts drives it. Every field is one i32 word a cell in one
// storage buffer F, in FIELDS order, each with its unit where it is listed; the atomic words (AT) hold what threads write at
// once (the flooded surface, labels, the scour, flags). The kernels are per-cell passes, or one workgroup of 256 that loops
// with barriers where the work is a graph walk or a sweep:
// - the crust: simplex noise (math/noise's simplex2d, its permutation tables made on the host by the package itself and
//   its arithmetic redone in Q24 coordinates and Q30 terms), the faults, the hinge (the k-th smallest depth over the land
//   by bisection on the integer), the rock classes and uplift, the dykes and the sea floor by a two-pass chamfer run along
//   the wavefront x + 2y, which visits every cell after the four it reads, as the row-by-row pass does;
// - the priority flood: the flooded surface is the one fixed point of f = max(h, least neighbour f + eps) with the map's
//   edge held at its height (eps above nothing makes it unique: a chain of supports cannot loop), so it is found by relaxing
//   downward from the edge, a round a dispatch with atomicMin, until a whole round changes nothing, and it comes out the
//   same whatever order threads run in;
// - the tree: pointer jumping over `to` gives each cell's depth, a counting sort files the cells by depth, and every
//   gather (the drainage area, the response time) and the implicit erosion walk the depths one workgroup of cells at a time,
//   each cell reading only its receiver or the neighbours that drain into it, so every sum is exact and the order of a
//   level's cells never matters;
// - the ice: one thread a valley, each walking its cells in order with private arrays, the scour a maximum over valleys;
// - the hollows: components of the cells the flood raised by more than a centimetre, labelled by their least cell as in the
//   hydrology (water.ts), but with the four neighbours the generator has always used here.
// The randomness is counter-based: the draws of the CPU's order (the dykes first, then each joint line's valleys) are words
// n of one Philox4x32-10 stream keyed by the island's key, and the layout kernel reads them in that order, so which valley
// a draw belongs to is fixed by its place in the order and by nothing the threads do.
import { CELL, LEN, N } from "../../terrain/grid";
import { BARE, DOLERITE, GRANITE, MELTWATER, ROCKS, SANDSTONE, TILL_CLAY, TILL_MAX, TILL_SAND } from "../../terrain/geology";
import {
  DEG, DIP, DYKE_LEN, ERODE, FLOOD_EPS, JOINT_GAP, JOINT_REACH, JOINTS, OFF_GRANITE, OFF_SEDIMENT, SCOUR, SHORE, SILL, STACK, STACK_TOP, VALLEY_GAP, VALLEY_LEN, WATER_TABLE,
} from "../../terrain/island";
import { FIXED } from "./fixed";

// ---------- units ----------
// Z:   Q12.20 metres, i32 (heights, depths, scour, the till; the host checks that no height reaches 340 m, the blur adds
//      128 m to each and sums nine in a u32);
// M15: Q17.15 metres, i32 (positions of dykes and valleys along the map, lengths along a valley);
// C16: Q16 cells, u32 (the chamfer's distances: 65,536 is one cell, 92,682 a diagonal);
// Q24: Q8.24 (the noise's coordinates, lift and fractions); Q30: Q2.30 (the noise inside, trigonometry, scales);
// area: whole cells; t: years in Q6 (1/64 yr), u64 in two words.
export const ZS = 2 ** 20;
export const MAXD = 8190; // the deepest flow path the counting sort holds, cells
export const DRN = 8192; // the draw words one island may use
export const VMAX = 1024; // valleys
export const DMAX = 1024; // dykes
const MAXC = 140; // cells a valley holds: 5 km at a sample every half cell is 134
const STRIDE = 8; // words of one valley's entry
export const VT = 64; // where the valley table begins in the misc words

// Everything the host reads back in one block, last in FIELDS: land, rock (class), h (the height the ice leaves), drift
// (class), dd (the till's depth, Z), fl (the flooded surface, Z), lvl (cells by depth along the receivers, then by index),
// to, basin, hol (the hollow's label, or -1), open.
export const OUTPUTS = ["land", "rock", "h", "drift", "dd", "fl", "lvl", "to", "basin", "hol", "open"] as const;
const INTERNAL = [
  "dr", "misc", "dep", "lift", "sea", "sh", "sh2", "far", "area", "dpth", "ua", "ub", "da", "db", "lvs", "zc", "zw", "tml", "tmh", "t1", "t2", "ar", "key",
];
export const FIELDS: readonly string[] = [...INTERNAL, ...OUTPUTS];
export const FIELD = Object.fromEntries(FIELDS.map((n, k) => [n, k])) as Record<string, number>;
// The atomic regions, LEN words each: fl the flooded surface (Z), lab hollow labels, dp the deepest of each hollow (Z), hist
// and cur the depth sort's counts and cursors, sc the scour (Z), dyke a flag a cell, cnt counters.
export const AT_REGIONS = ["fl", "lab", "dp", "hist", "cur", "sc", "dyke", "cnt"];
export const AT_OF = Object.fromEntries(AT_REGIONS.map((n, k) => [n, k])) as Record<string, number>;
// The counters: the basement's cells, the flags below, and the deepest depth a sort found.
export const CNT = { basement: 0, flags: 1, top: 2 };
// Flags a run can raise (the flags counter), which the host turns into errors or a rerun with more rounds.
export const FLAG = { chain: 1, depth: 2, floodErode: 4, floodFinal: 8, valleys: 16, draws: 32, dykes: 64, hollow: 128, tall: 256 };
// misc words
export const MISC = { nland: 0, hinge: 1, nvalley: 2, ndyke: 3, maxd: 4, tauLo: 5, tauHi: 6, eps: 7 };

// The parameters the host writes (words of P).
export const PAR = {
  perm: 0, // three permutation tables of 512 words
  tilt: 1536, stretch: 1537, invStretch: 1538, // tilt as a fraction of pi in Q32; the oval's stretch and 1 over it, Q30
  fault: 1540, // three of 8 words: x, y (M15), throw (Z), side (+1 or -1), azimuth as a fraction of pi in Q32
  key0: 1564, key1: 1565,
  udt: 1566, // the uplift of the horst a step, Z
  creep: 1567, // the creep's share a substep, Q32
  ka: 1568, // five rocks' K dt, Q16
  adverse: 1573, // the slope the ice could scour up toward a valley's end, Q30
  size: 1600,
};

const q = (x: number, bits: number) => Math.round(x * 2 ** bits);
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
// GRAD3's x and y for the twelve values a permutation entry reduces to (math/noise permutation.js)
const GRAD_X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0], GRAD_Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const cum = STACK.reduce<number[]>((a, [, m]) => [...a, (a[a.length - 1] ?? 0) + m], []);
const m15 = (m: number) => Math.round(m * 2 ** 15);
const z = (m: number) => Math.round(m * ZS);
const profile = (p: number[]) => p.map((v) => `${z(v)}i`).join(", ");
// 1 / K per rock, years, Q6: the response time's sum is of far / (K sqrt(area)); K as the CPU holds it, a float32
const invK = ROCKS.map((r) => Math.round(64 / Math.fround(r.erode)));
// the flood's step above a neighbour, Z: the erosion's, then the island's
export const EPS_ERODE = Math.max(1, z(FLOOD_EPS.erode)), EPS_ISLAND = Math.max(1, z(FLOOD_EPS.island));

const consts = /* wgsl */ `
const N = ${N}u;
const LEN = ${LEN}u;
${FIELDS.map((n, k) => `const f_${n}: u32 = ${k * LEN}u;`).join("\n")}
${AT_REGIONS.map((n, k) => `const a_${n}: u32 = ${k * LEN}u;`).join("\n")}
const MAXD = ${MAXD}u;
const DRN = ${DRN}u;
const VMAX = ${VMAX}u;
const DMAX = ${DMAX}u;
const VT = ${VT}u;
const STRIDE = ${STRIDE}u;
const MAXC = ${MAXC}u;
const ONE30 = ${2 ** 30}i;
const HALF30 = ${2 ** 29}i;
const F2_32 = ${q(F2, 32)}u;
const G2_32 = ${q(G2, 32)}u;
const G2_30 = ${q(G2, 30)}i;
const GX = array<i32, 12>(${GRAD_X.join(", ")});
const GY = array<i32, 12>(${GRAD_Y.join(", ")});
const C13 = ${q(1.3, 30)}i;
const INV13 = ${q(1 / 1.3, 30)}i;
const C022 = ${q(0.22, 32)}i;
const C012 = ${q(0.12, 32)}i;
const INV1875 = ${q(1 / 1.875, 30)}i;
const K52 = ${q(5.2, 24)}i;
const K13 = ${q(1.3, 24)}i;
const THR98 = ${q(0.98, 24)}i;
const THR30 = ${q(0.3, 24)}i;
const DIPY = ${z(DIP * CELL)}i;
const DIP0 = ${z((DIP * CELL) / 2)}i;
const PI4_32 = ${q(Math.PI / 4, 32)}u;
const STACK_TOPS = array<i32, ${STACK.length}>(${cum.map((c) => `${z(c)}i`).join(", ")});
const STACK_ROCK = array<i32, ${STACK.length}>(${STACK.map(([r]) => `${r}i`).join(", ")});
const TOP_Z = ${z(STACK_TOP)}i;
const SANDSTONE = ${SANDSTONE}i;
const SHORE_M = array<u32, ${SHORE.length}>(${SHORE.map((s) => `${s * 65536}u`).join(", ")});
const OFF_GR = array<i32, ${SHORE.length}>(${profile(OFF_GRANITE)});
const OFF_SD = array<i32, ${SHORE.length}>(${profile(OFF_SEDIMENT)});
const CELL_M = ${CELL}u;
const CELLM15 = ${m15(CELL)}i;
const HALFM15 = ${m15(CELL / 2)}i;
const DYKE_SAMPLES = ${Math.floor(DYKE_LEN / (CELL / 2)) + 1}u;
const MAPM15 = ${m15(N * CELL)}u;
const DYKE_A0 = ${q(1 / 18, 32)}u;
const DYKE_AS = ${q(1 / 9, 32)}u;
const JOINT_A0 = ${q(JOINTS[0] / DEG / 180, 32)}u;
const JOINT_A1 = ${q(JOINTS[1] / DEG / 180, 32)}u;
const REACH = ${m15(N * CELL * JOINT_REACH)}i;
const MID = ${m15((N * CELL) / 2)}i;
const LEN_MIN = ${m15(VALLEY_LEN[0])}i;
const LEN_SPAN = ${m15(VALLEY_LEN[1])}u;
const GAP_MIN = ${m15(VALLEY_GAP[0])}i;
const GAP_SPAN = ${m15(VALLEY_GAP[1])}u;
const LINE_MIN = ${m15(JOINT_GAP * 0.5)}i;
const LINE_SPAN = ${m15(JOINT_GAP)}u;
const SILL2 = ${q(2 * SILL, 32)}u;
const SCOUR_Z = ${z(SCOUR)}u;
const TILL_Z = ${z(TILL_MAX)}u;
const BOFF = ${z(128)}i;
const TALL = ${z(340)}i;
const WT_Z = ${z(WATER_TABLE)}i;
const HOLLOW_MIN = ${Math.ceil(0.01 * ZS)}i;
const RISE_Q16 = ${Math.round(ERODE.rise * CELL * 16 * 65536)}u;
const EPS_ERODE = ${EPS_ERODE}i;
const EPS_ISLAND = ${EPS_ISLAND}i;
const INFZ = 0x7fffffffi;
const CHAM_INF = 0x3fffffffu;
const ORTH = 65536u;
const DIAG = ${Math.round(Math.SQRT2 * 65536)}u;
const SLOPE_ORTH = ${2 ** 31}u;
const SLOPE_DIAG = ${Math.round(2 ** 31 / Math.SQRT2)}u;
const INV_SQRT2_32 = ${q(1 / Math.SQRT2, 32)}u;
const INV_K = array<u32, ${ROCKS.length}>(${invK.map((v) => `${v}u`).join(", ")});
const DX = array<i32, 8>(1, 1, 0, -1, -1, -1, 0, 1);
const DY = array<i32, 8>(0, 1, 1, 1, 0, -1, -1, -1);
const PERM_WARP = ${PAR.perm}u;
const PERM_COAST = ${PAR.perm + 512}u;
const PERM_BEND = ${PAR.perm + 1024}u;
const GRANITE = ${GRANITE}i;
const DOLERITE = ${DOLERITE}i;
const BARE = ${BARE}i;
const TILL_CLAY = ${TILL_CLAY}i;
const TILL_SAND = ${TILL_SAND}i;
const MELTWATER = ${MELTWATER}i;
const MISC_NLAND = ${MISC.nland}u;
const MISC_HINGE = ${MISC.hinge}u;
const MISC_NV = ${MISC.nvalley}u;
const MISC_ND = ${MISC.ndyke}u;
const MISC_MAXD = ${MISC.maxd}u;
const MISC_TAU_LO = ${MISC.tauLo}u;
const MISC_TAU_HI = ${MISC.tauHi}u;
const MISC_EPS = ${MISC.eps}u;
const CNT_BASEMENT = ${CNT.basement}u;
const CNT_FLAGS = ${CNT.flags}u;
const CNT_TOP = ${CNT.top}u;
const FLAG_CHAIN = ${FLAG.chain}i;
const FLAG_DEPTH = ${FLAG.depth}i;
const FLAG_FLOOD_E = ${FLAG.floodErode}i;
const FLAG_FLOOD_F = ${FLAG.floodFinal}i;
const FLAG_VALLEYS = ${FLAG.valleys}i;
const FLAG_DRAWS = ${FLAG.draws}i;
const FLAG_DYKES = ${FLAG.dykes}i;
const FLAG_HOLLOW = ${FLAG.hollow}i;
const FLAG_TALL = ${FLAG.tall}i;
const P_TILT = ${PAR.tilt}u;
const P_STRETCH = ${PAR.stretch}u;
const P_INVSTR = ${PAR.invStretch}u;
const P_FAULT = ${PAR.fault}u;
const P_KEY0 = ${PAR.key0}u;
const P_KEY1 = ${PAR.key1}u;
const P_UDT = ${PAR.udt}u;
const P_CREEP = ${PAR.creep}u;
const P_KA = ${PAR.ka}u;
const P_ADV = ${PAR.adverse}u;
`;

// The blur's six passes, three of box means of nine cells along x then y with the edge repeated: (sum + 4) / 9 of the
// heights offset by 128 m so the nine sum in a u32.
const blurPass = (name: string, src: string, dst: string, across: boolean) => /* wgsl */ `
@compute @workgroup_size(256)
fn ${name}(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; let x = i32(i & 255u); let y = i32(i >> 8u);
  var s = 0u;
  for (var k = -4i; k <= 4i; k++) {
    let xx = ${across ? "clamp(x + k, 0i, 255i)" : "x"}; let yy = ${across ? "y" : "clamp(y + k, 0i, 255i)"};
    s += u32(gi(${src}, u32(yy) * 256u + u32(xx)) + BOFF);
  }
  wi(${dst}, i, i32((s + 4u) / 9u) - BOFF);
}`;

const wgsl = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> F: array<i32>;
@group(0) @binding(1) var<storage, read_write> AT: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read> P: array<u32>;

fn gi(f: u32, i: u32) -> i32 { return F[f + i]; }
fn gu(f: u32, i: u32) -> u32 { return bitcast<u32>(F[f + i]); }
fn wi(f: u32, i: u32, v: i32) { F[f + i] = v; }
fn wu(f: u32, i: u32, v: u32) { F[f + i] = bitcast<i32>(v); }
fn pi_(i: u32) -> i32 { return bitcast<i32>(P[i]); }
fn al(r: u32, i: u32) -> i32 { return atomicLoad(&AT[r + i]); }
fn flag(f: i32) { atomicOr(&AT[a_cnt + CNT_FLAGS], f); }
fn ld(f: u32, i: u32) -> vec2u { return vec2u(gu(f, i), gu(f + LEN, i)); }
fn crystalline(r: i32) -> bool { return r == GRANITE || r == DOLERITE; }
fn cuttable(i: u32) -> bool { return gi(f_land, i) != 0i && crystalline(gi(f_rock, i)); }

// ---------- 64-bit and rounded products ----------
fn shr64(v: vec2u, s: u32) -> vec2u {
  if (s < 32u) { return vec2u((v.x >> s) | (v.y << (32u - s)), v.y >> s); }
  return vec2u(v.y >> (s - 32u), 0u);
}
// 2^(s - 1) as a 64-bit word, s in 1 to 63
fn rnd64(s: u32) -> vec2u {
  let k = s - 1u;
  return select(vec2u(0u, 1u << (k - 32u)), vec2u(1u << k, 0u), k < 32u);
}
// a * b / 2^s rounded half away from zero; the result must fit an i32
fn smulsh(a: i32, b: i32, s: u32) -> i32 {
  let p = shr64(add64(mul64(mag(a), mag(b)), rnd64(s)), s);
  let r = bitcast<i32>(p.x);
  return select(r, -r, (a < 0i) != (b < 0i));
}
fn umulsh(a: u32, b: u32, s: u32) -> u32 { return shr64(add64(mul64(a, b), rnd64(s)), s).x; }
// a * c / 2^32 rounded, c a Q32 constant
fn mulq32(a: i32, c: u32) -> i32 {
  let p = add64(mul64(mag(a), c), vec2u(0x80000000u, 0u));
  return select(bitcast<i32>(p.y), -bitcast<i32>(p.y), a < 0i);
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
fn fdiv(a: i32, d: i32) -> i32 { let q = a / d; return select(q, q - 1i, (a % d) < 0i); }

// ---------- philox, the island's stream ----------
fn philox(c0: vec4u, k0: vec2u) -> vec4u {
  var c = c0; var k = k0;
  for (var r = 0u; r < 10u; r++) {
    let x = mul64(0xD2511F53u, c.x); let y = mul64(0xCD9E8D57u, c.z);
    c = vec4u(y.y ^ c.y ^ k.x, y.x, x.y ^ c.w ^ k.y, x.x);
    k = k + vec2u(0x9E3779B9u, 0xBB67AE85u);
  }
  return c;
}
@compute @workgroup_size(256)
fn draws(@builtin(global_invocation_id) g: vec3u) {
  let n = g.x;
  if (n >= DRN) { return; }
  wu(f_dr, n, philox(vec4u(n, 0x55505354u, 0u, 0u), vec2u(P[P_KEY0], P[P_KEY1])).x);
}

// ---------- sine and cosine of pi times a Q32 fraction in [0, 1), Q30 ----------
fn sincos(a0: u32) -> vec2i {
  var a = a0; var negc = false; var swap = false;
  if (a > 0x80000000u) { a = 0u - a; negc = true; }
  if (a > 0x40000000u) { a = 0x80000000u - a; swap = true; }
  let x = i32(mulhi(a, PI4_32));
  let x2 = smulsh(x, x, 30u);
  var s = ONE30 - x2 / 110i;
  s = ONE30 - smulsh(x2 / 72i, s, 30u);
  s = ONE30 - smulsh(x2 / 42i, s, 30u);
  s = ONE30 - smulsh(x2 / 20i, s, 30u);
  s = ONE30 - smulsh(x2 / 6i, s, 30u);
  var c = ONE30 - x2 / 90i;
  c = ONE30 - smulsh(x2 / 56i, c, 30u);
  c = ONE30 - smulsh(x2 / 30i, c, 30u);
  c = ONE30 - smulsh(x2 / 12i, c, 30u);
  c = ONE30 - smulsh(x2 / 2i, c, 30u);
  let sn = smulsh(x, s, 30u);
  let sin_ = select(sn, c, swap); let cos_ = select(c, sn, swap);
  return vec2i(sin_, select(cos_, -cos_, negc));
}

// ---------- simplex noise (math/noise simplex2d), coordinates Q24, the result Q30 in [-1, 1] ----------
fn corner(X: i32, Y: i32, m: u32, base: u32) -> i32 {
  var t = HALF30 - smulsh(X, X, 30u) - smulsh(Y, Y, 30u);
  if (t < 0i) { return 0i; }
  let v = P[base + m] % 12u;
  t = smulsh(t, t, 30u);
  t = smulsh(t, t, 30u);
  return smulsh(t, GX[v] * X + GY[v] * Y, 30u);
}
fn simplex(base: u32, x: i32, y: i32) -> i32 {
  let s = mulq32(x + y, F2_32);
  let fi = (x + s) >> 24u; let fj = (y + s) >> 24u;
  let t = mulq32((fi + fj) << 24u, G2_32);
  let x0 = (x - (fi << 24u) + t) << 6u; let y0 = (y - (fj << 24u) + t) << 6u;
  var i1 = 0i; var j1 = 0i;
  if (x0 > y0) { i1 = 1i; } else { j1 = 1i; }
  let x1 = x0 - (i1 << 30u) + G2_30; let y1 = y0 - (j1 << 30u) + G2_30;
  let x2 = x0 - ONE30 + 2i * G2_30; let y2 = y0 - ONE30 + 2i * G2_30;
  let ii = u32(fi & 255i); let jj = u32(fj & 255i);
  let g0 = ii + P[base + jj];
  let g1 = ii + u32(i1) + P[base + jj + u32(j1)];
  let g2 = ii + 1u + P[base + jj + 1u];
  return 70i * (corner(x0, y0, g0, base) + corner(x1, y1, g1, base) + corner(x2, y2, g2, base));
}

// ---------- the crust: the oval, the coast and the basement's depth ----------
// Where the island stands, and its structure: a warped oval [design] on a tilted horst, the basement high in the
// north and the middle and dipping south under the sediments, broken by faults into blocks dropped by 50 to 250 m
// [design] along the Sorgenfrei-Tornquist trend (NW) and north to south (R529). The rock at the surface is the layer of
// the sediments the basement's depth there reaches into; the horst rises at U0 and the blocks less the deeper they lie
// [design]. Offshore, the sea floor falls away as Bornholm's does off the same rock. The oval's numbers (the noise's
// warp of 1.3 and 0.22, the coast's four octaves at 3 times the frequency and 0.12 of the radius, the seven cells off
// the map's edge, the bend of 20 m) were literals in the CPU's function and are the same here [design].
@compute @workgroup_size(256)
fn shape(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; let ix = i32(i & 255u); let iy = i32(i >> 8u);
  // u, v in -1 to 1: (x + 0.5) / N * 2 - 1
  let u0 = (2i * ix - 255i) << 16u; let v0 = (2i * iy - 255i) << 16u;
  let a = smulsh(u0, C13, 30u); let b = smulsh(v0, C13, 30u);
  let w1 = simplex(PERM_WARP, a, b); let w2 = simplex(PERM_WARP, a + K52, b + K13);
  let u = smulsh(a + smulsh(w1, C022, 38u), INV13, 30u);
  let v = smulsh(b + smulsh(w2, C022, 38u), INV13, 30u);
  let sc = sincos(P[P_TILT]);
  let ru = smulsh(u, sc.y, 30u) + smulsh(v, sc.x, 30u);
  let rv = smulsh(v, sc.y, 30u) - smulsh(u, sc.x, 30u);
  let ra = smulsh(ru, pi_(P_STRETCH), 30u); let rb = smulsh(rv, pi_(P_INVSTR), 30u);
  let hyp = i32(sqrt64(add64(mul64(mag(ra), mag(ra)), mul64(mag(rb), mag(rb)))));
  let u3 = u * 3i; let v3 = v * 3i;
  let fb = simplex(PERM_COAST, u3, v3) + (simplex(PERM_COAST, u3 * 2i, v3 * 2i) >> 1u) + (simplex(PERM_COAST, u3 * 4i, v3 * 4i) >> 2u) + (simplex(PERM_COAST, u3 * 8i, v3 * 8i) >> 3u);
  let d = hyp + smulsh(smulsh(fb, INV1875, 30u), C012, 38u);
  // seven cells keep the island off the map's edge
  let rim = u32(min(min(ix, iy), min(255i - ix, 255i - iy)));
  let edge = i32((min(rim, 7u) << 24u) / 7u);
  let thr = THR98 - smulsh(THR30, (1i << 24u) - edge, 24u);
  wi(f_land, i, select(0i, 1i, d < thr));
  // the basement's depth below the ground: the dip, a bend and the faults
  var dep = DIPY * iy + DIP0 + smulsh(simplex(PERM_BEND, u * 2i, v * 2i), 20i, 10u);
  let mx = ix * CELLM15 + HALFM15; let my = iy * CELLM15 + HALFM15;
  for (var k = 0u; k < 3u; k++) {
    let o = P_FAULT + 8u * k;
    let nsc = sincos(P[o + 4u]);
    let dist = smulsh(mx - pi_(o), nsc.y, 30u) + smulsh(my - pi_(o + 1u), nsc.x, 30u);
    if (pi_(o + 3u) * dist > 0i) { dep += pi_(o + 2u); }
  }
  wi(f_dep, i, dep);
}

// ---------- the hinge, where the basement goes under: the depth the horst's share of the land is not deeper than ----------
var<workgroup> wcnt: atomic<u32>;
var<workgroup> wval: u32;
@compute @workgroup_size(256)
fn hinge(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { atomicStore(&wcnt, 0u); }
  workgroupBarrier();
  var c = 0u;
  for (var i = t; i < LEN; i += 256u) { c += select(0u, 1u, gi(f_land, i) != 0i); }
  atomicAdd(&wcnt, c);
  workgroupBarrier();
  if (t == 0u) { wval = atomicLoad(&wcnt); }
  workgroupBarrier();
  let nland = workgroupUniformLoad(&wval);
  // the CPU's index floor(400 / 588 * (n - 1)), of the land's cells sorted by depth
  let k = select(0u, (100u * (nland - 1u)) / 147u, nland > 0u);
  var lo = 0u; var hi = 0xffffffffu;
  for (var r = 0u; r < 32u; r++) {
    let mid = lo + ((hi - lo) >> 1u);
    workgroupBarrier();
    if (t == 0u) { atomicStore(&wcnt, 0u); }
    workgroupBarrier();
    var n = 0u;
    for (var i = t; i < LEN; i += 256u) {
      if (gi(f_land, i) != 0i && bitcast<u32>(gi(f_dep, i)) + 0x40000000u <= mid) { n++; }
    }
    atomicAdd(&wcnt, n);
    workgroupBarrier();
    if (t == 0u) { wval = atomicLoad(&wcnt); }
    workgroupBarrier();
    let enough = workgroupUniformLoad(&wval) >= k + 1u;
    lo = select(mid + 1u, lo, enough);
    hi = select(hi, mid, enough);
  }
  if (t == 0u) {
    wi(f_misc, MISC_NLAND, i32(nland));
    wi(f_misc, MISC_HINGE, bitcast<i32>(lo - 0x40000000u));
  }
}

// ---------- the rock classes, the uplift's share, and the basement's count ----------
@compute @workgroup_size(256)
fn rocks(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let d = gi(f_dep, i) - bitcast<i32>(gu(f_misc, MISC_HINGE));
  wi(f_dep, i, d);
  var r = GRANITE;
  if (d > 0i) {
    r = SANDSTONE;
    for (var k = 0u; k < ${STACK.length}u; k++) { if (d <= STACK_TOPS[k]) { r = STACK_ROCK[k]; break; } }
  }
  wi(f_rock, i, r);
  let land = gi(f_land, i) != 0i;
  if (land && r == GRANITE) { atomicAdd(&AT[a_cnt + CNT_BASEMENT], 1i); }
  // U / U0 = 1 - 0.5 clamp(depth / the stack's top); a depth in Z over the stack's top, in Q24, is a 25th of it
  let share = (u32(clamp(d, 0i, TOP_Z)) + 12u) / 25u;
  wi(f_lift, i, select(0i, (1i << 24u) - i32(share >> 1u), land));
}

// ---------- the dolerite dykes: lines of cells one cell wide, a line a thread ----------
// the cell of the point s m along a line from (x0, y0) in direction (dx, dy), or -1 off the map
fn cell_at(x0: i32, y0: i32, dx: i32, dy: i32, s: i32) -> i32 {
  let cx = fdiv(x0 + smulsh(dx, s, 30u), CELLM15); let cy = fdiv(y0 + smulsh(dy, s, 30u), CELLM15);
  if (cx < 0i || cy < 0i || cx > 255i || cy > 255i) { return -1i; }
  return cy * 256i + cx;
}
@compute @workgroup_size(256)
fn dykes(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x;
  // the CPU's Math.round(DYKES * basement * CELL * CELL), which is 9 / 2560 of the basement's cells
  let nd = (9u * u32(al(a_cnt, CNT_BASEMENT)) + 1280u) / 2560u;
  if (k == 0u) { wi(f_misc, MISC_ND, i32(nd)); if (nd > DMAX) { flag(FLAG_DYKES); } }
  if (k >= nd || k >= DMAX) { return; }
  let w0 = gu(f_dr, 3u * k); let w1 = gu(f_dr, 3u * k + 1u); let w2 = gu(f_dr, 3u * k + 2u);
  let x0 = i32(mulhi(w0, MAPM15)); let y0 = i32(mulhi(w1, MAPM15));
  let sc = sincos(DYKE_A0 + mulhi(w2, DYKE_AS));
  let dx = sc.x; let dy = -sc.y;
  for (var j = 0u; j < DYKE_SAMPLES; j++) {
    let c = cell_at(x0, y0, dx, dy, i32(j) * HALFM15);
    if (c >= 0i) { atomicStore(&AT[a_dyke + u32(c)], 1i); }
  }
}
@compute @workgroup_size(256)
fn rockfin(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (al(a_dyke, i) != 0i && gi(f_rock, i) == GRANITE) { wi(f_rock, i, DOLERITE); }
}

// ---------- two-pass chamfer distances (grid.ts distance), C16, along the wavefront x + 2y ----------
fn chamfer(markLand: bool, outf: u32, t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    let m = (gi(f_land, i) != 0i) == markLand;
    wu(outf, i, select(CHAM_INF, 0u, m));
  }
  storageBarrier(); workgroupBarrier();
  // forward: west, north west, north, north east, each cell after the four
  for (var w = 0u; w < 766u; w++) {
    let y = (w - t) >> 1u;
    if (w >= t && ((w - t) & 1u) == 0u && y < 256u) {
      let i = y * 256u + t;
      var d = gu(outf, i);
      if (t > 0u) { d = min(d, gu(outf, i - 1u) + ORTH); }
      if (t > 0u && y > 0u) { d = min(d, gu(outf, i - 257u) + DIAG); }
      if (y > 0u) { d = min(d, gu(outf, i - 256u) + ORTH); }
      if (t < 255u && y > 0u) { d = min(d, gu(outf, i - 255u) + DIAG); }
      wu(outf, i, d);
    }
    storageBarrier(); workgroupBarrier();
  }
  // backward: east, south east, south, south west, from the last cell
  for (var w = 0u; w < 766u; w++) {
    let yb = (w - t) >> 1u;
    if (w >= t && ((w - t) & 1u) == 0u && yb < 256u) {
      let x = 255u - t; let y = 255u - yb;
      let i = y * 256u + x;
      var d = gu(outf, i);
      if (x < 255u) { d = min(d, gu(outf, i + 1u) + ORTH); }
      if (x < 255u && y < 255u) { d = min(d, gu(outf, i + 257u) + DIAG); }
      if (y < 255u) { d = min(d, gu(outf, i + 256u) + ORTH); }
      if (x > 0u && y < 255u) { d = min(d, gu(outf, i + 255u) + DIAG); }
      wu(outf, i, d);
    }
    storageBarrier(); workgroupBarrier();
  }
}
@compute @workgroup_size(256)
fn shore1(@builtin(local_invocation_index) t: u32) { chamfer(true, f_sh, t); }
@compute @workgroup_size(256)
fn shore2(@builtin(local_invocation_index) t: u32) { chamfer(false, f_sh2, t); }

// ---------- the sea floor off each coast (R520) ----------
@compute @workgroup_size(256)
fn seafl(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (gi(f_land, i) != 0i) { wi(f_sea, i, 0i); return; }
  let sh = gu(f_sh, i) * CELL_M; // Q16 metres
  let gr = crystalline(gi(f_rock, i));
  var k = 1u;
  for (; k < ${SHORE.length - 1}u; k++) { if (SHORE_M[k] >= sh) { break; } }
  let num = sh - SHORE_M[k - 1u]; let den = SHORE_M[k] - SHORE_M[k - 1u];
  var frac = 1u << 24u;
  if (num < den) { frac = divw(num >> 8u, num << 24u, den).x; }
  let p0 = select(OFF_SD[k - 1u], OFF_GR[k - 1u], gr); let p1 = select(OFF_SD[k], OFF_GR[k], gr);
  wi(f_sea, i, -(p0 + smulsh(p1 - p0, i32(frac), 24u)));
}

// ---------- the start of the erosion: a metre a kilometre inland, the sea floor elsewhere ----------
@compute @workgroup_size(256)
fn hinit(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  // C16 cells of CELL m each at a metre a kilometre, in Z
  let dither = i32(philox(vec4u(i, 0x44495448u, 0u, 0u), vec2u(P[P_KEY0], P[P_KEY1])).x % 3u) - 1i;
  wi(f_h, i, select(gi(f_sea, i), i32(umulsh(gu(f_sh2, i), RISE_Q16, 16u)) + dither, gi(f_land, i) != 0i));
}

// ---------- the priority flood: relax down from the map's edge until a round changes nothing ----------
@compute @workgroup_size(1)
fn epse() { wi(f_misc, MISC_EPS, EPS_ERODE); }
@compute @workgroup_size(1)
fn epsf() { wi(f_misc, MISC_EPS, EPS_ISLAND); }
@compute @workgroup_size(256)
fn flinit(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; let x = i & 255u; let y = i >> 8u;
  let edge = x == 0u || y == 0u || x == 255u || y == 255u;
  atomicStore(&AT[a_fl + i], select(INFZ, gi(f_h, i), edge));
}
fn flround(i: u32) -> bool {
  let x = i32(i & 255u); let y = i32(i >> 8u);
  if (x == 0i || y == 0i || x == 255i || y == 255i) { return false; }
  var m = INFZ;
  for (var d = 0u; d < 8u; d++) { m = min(m, al(a_fl, u32((y + DY[d]) * 256i + x + DX[d]))); }
  if (m == INFZ) { return false; }
  let cand = max(gi(f_h, i), m + gi(f_misc, MISC_EPS));
  if (cand >= al(a_fl, i)) { return false; }
  atomicMin(&AT[a_fl + i], cand);
  return true;
}
@compute @workgroup_size(256)
fn flood(@builtin(global_invocation_id) g: vec3u) { _ = flround(g.x); }
@compute @workgroup_size(256)
fn floodlast(@builtin(global_invocation_id) g: vec3u) {
  if (flround(g.x)) { flag(select(FLAG_FLOOD_F, FLAG_FLOOD_E, gi(f_misc, MISC_EPS) == EPS_ERODE)); }
}
// ---------- receivers: steepest descent on the flooded surface, the sea (flooded below zero) ending every river ----------
@compute @workgroup_size(256)
fn recv(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; let x = i32(i & 255u); let y = i32(i >> 8u);
  let f = al(a_fl, i);
  wi(f_fl, i, f);
  var to = i; var diag = 0i; var best = vec2u(0u, 0u);
  if (f >= 0i) {
    for (var d = 0u; d < 8u; d++) {
      let nx = x + DX[d]; let ny = y + DY[d];
      if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
      let j = u32(ny * 256i + nx);
      let dz = f - al(a_fl, j);
      if (dz <= 0i) { continue; }
      let odd = (d & 1u) == 1u;
      let key = mul64(u32(dz), select(SLOPE_ORTH, SLOPE_DIAG, odd));
      if (lt64(best, key)) { best = key; to = j; diag = select(0i, 1i, odd); }
    }
  }
  wu(f_to, i, to);
  wi(f_far, i, diag);
}

// ---------- the tree: depth by pointer jumping, then the cells filed by depth into ub ----------
// Each round every cell takes its pointer's pointer and adds that cell's depth to its own, so 14 rounds of doubling reach
// any path of 16,384 cells; the result is in ua and da (an even number of rounds), and ub is free to hold the filing.
@compute @workgroup_size(256)
fn lvinit(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x; let j = gu(f_to, i);
  wu(f_ua, i, j);
  wi(f_da, i, select(1i, 0i, j == i));
  if (i <= MAXD + 1u) { atomicStore(&AT[a_hist + i], 0i); }
  if (i == 0u) { atomicStore(&AT[a_cnt + CNT_TOP], 0i); }
}
fn jump(src: u32, srcd: u32, into: u32, intod: u32, i: u32) {
  let j = gu(src, i);
  wu(into, i, gu(src, j));
  wi(intod, i, gi(srcd, i) + gi(srcd, j));
}
@compute @workgroup_size(256)
fn jumpa(@builtin(global_invocation_id) g: vec3u) { jump(f_ua, f_da, f_ub, f_db, g.x); }
@compute @workgroup_size(256)
fn jumpb(@builtin(global_invocation_id) g: vec3u) { jump(f_ub, f_db, f_ua, f_da, g.x); }
// the depths counted, and a chain that does not end at a root flagged
@compute @workgroup_size(256)
fn lvhist(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let u = gu(f_ua, i);
  if (gu(f_to, u) != u) { flag(FLAG_CHAIN); }
  let d = gi(f_da, i);
  wi(f_dpth, i, d);
  if (u32(d) > MAXD) { flag(FLAG_DEPTH); } else { atomicAdd(&AT[a_hist + u32(d)], 1i); }
}
// where each depth's cells begin: the counts summed over 8192 bins, 32 a thread, then across the threads
var<workgroup> wsum: array<i32, 256>;
@compute @workgroup_size(256)
fn lvscan(@builtin(local_invocation_index) t: u32) {
  var local = 0i; var top = 0i;
  for (var k = 0u; k < 32u; k++) {
    let c = al(a_hist, t * 32u + k);
    local += c;
    if (c > 0i) { top = i32(t * 32u + k); }
  }
  wsum[t] = local;
  workgroupBarrier();
  var before = 0i;
  for (var u = 0u; u < t; u++) { before += wsum[u]; }
  var run = before;
  for (var k = 0u; k < 32u; k++) {
    let d = t * 32u + k;
    wi(f_lvs, d, run);
    atomicStore(&AT[a_cur + d], run);
    run += al(a_hist, d);
  }
  atomicMax(&AT[a_cnt + CNT_TOP], top);
  storageBarrier(); workgroupBarrier();
  if (t == 0u) { wi(f_misc, MISC_MAXD, al(a_cnt, CNT_TOP)); }
}
@compute @workgroup_size(256)
fn lvscatter(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let d = gu(f_dpth, i);
  if (d <= MAXD) { let p = atomicAdd(&AT[a_cur + d], 1i); wi(f_ub, u32(p), i32(i)); }
}

// ---------- the drainage area: a cell and all that drains into it, deepest first (grid.ts accumulate) ----------
var<workgroup> wtop: u32;
@compute @workgroup_size(256)
fn area(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wtop = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wtop);
  for (var k = 0u; k <= top; k++) {
    let d = top - k;
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) {
      let i = gu(f_ub, p);
      let x = i32(i & 255u); let y = i32(i >> 8u);
      var a = 1i;
      for (var e = 0u; e < 8u; e++) {
        let nx = x + DX[e]; let ny = y + DY[e];
        if (nx < 0i || ny < 0i || nx > 255i || ny > 255i) { continue; }
        let j = u32(ny * 256i + nx);
        if (gu(f_to, j) == i) { a += gi(f_area, j); }
      }
      wi(f_area, i, a);
    }
    storageBarrier(); workgroupBarrier();
  }
}

// the area's square root in Q16 cells, over the receiver's distance: a cell's K dt sqrt(A) / far
fn reach_q16(i: u32) -> u32 {
  let s = sqrt64(vec2u(0u, u32(gi(f_area, i))));
  return select(s, umulsh(s, INV_SQRT2_32, 32u), gi(f_far, i) != 0i);
}

// ---------- the response time: the sum of far / (K sqrt(A)) up each path (Q6 years, two words), then its greatest ----------
var<workgroup> wbest: array<vec2u, 256>;
@compute @workgroup_size(256)
fn clock(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wtop = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wtop);
  for (var d = 0u; d <= top; d++) {
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) {
      let i = gu(f_ub, p); let j = gu(f_to, i);
      var tm = vec2u(0u, 0u);
      if (gi(f_land, i) != 0i && j != i) {
        // far / (K sqrt(A)) with far in Q16 and sqrt(A) in Q16 cells: 1 / K in Q6 years times far over sqrt(A)
        let s = sqrt64(vec2u(0u, u32(gi(f_area, i))));
        let far = select(ORTH, DIAG, gi(f_far, i) != 0i);
        let n = mul64(INV_K[u32(gi(f_rock, i))], far);
        tm = add64(ld(f_tml, j), vec2u(divw(n.y, n.x, s).x, 0u));
      }
      wu(f_tml, i, tm.x); wu(f_tmh, i, tm.y);
    }
    storageBarrier(); workgroupBarrier();
  }
  var best = vec2u(0u, 0u);
  for (var i = t; i < LEN; i += 256u) { if (gi(f_land, i) != 0i) { let v = ld(f_tml, i); if (lt64(best, v)) { best = v; } } }
  wbest[t] = best;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (t < s && lt64(wbest[t], wbest[t + s])) { wbest[t] = wbest[t + s]; }
    workgroupBarrier();
  }
  if (t == 0u) { wu(f_misc, MISC_TAU_LO, wbest[0].x); wu(f_misc, MISC_TAU_HI, wbest[0].y); }
}

// ---------- uplift, then each cell eased toward its receiver (the implicit stream power step) ----------
// Uplift against the stream power law (Braun and Willett 2013, implicit, n = 1, m = 0.5): rivers cut down at each
// rock's erodibility times the square root of the area they drain, in m2, times their slope, and slopes creep at one
// diffusivity everywhere (geology.ts CREEP), with the sea level holding every stream's mouth. One rain falls over the
// whole island, so every cell sheds the same runoff and discharge goes with drainage area, as the erodibilities were
// fitted; that the heights wring more rain from the air than the coast gets is a [gap] here, as the climate comes after
// the landform. It runs for three times the slowest knickpoint's time to cross the island (the response time, the sum
// of dx / (K A^0.5) up its longest path), long enough for the land to settle where uplift and erosion balance, so the
// heights are what the rock and its uplift make them. Depressions keep their floors, so the landscape can hold lakes.
@compute @workgroup_size(256)
fn uplift(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  wi(f_h, i, gi(f_h, i) + i32(umulsh(u32(gi(f_lift, i)), P[P_UDT], 24u)));
}
// h' = (h + f h_r) / (1 + f) = h_r + (h - h_r) / (1 + f), f = K dt sqrt(A) / far, where that is lower than h; the receiver
// is already at its own new height (shallowest depth first) and the sea stands at zero
@compute @workgroup_size(256)
fn implicit(@builtin(local_invocation_index) t: u32) {
  if (t == 0u) { wtop = u32(gi(f_misc, MISC_MAXD)); }
  workgroupBarrier();
  let top = workgroupUniformLoad(&wtop);
  for (var d = 1u; d <= top; d++) {
    let lo = gu(f_lvs, d); let hi = gu(f_lvs, d + 1u);
    for (var p = lo + t; p < hi; p += 256u) {
      let i = gu(f_ub, p);
      if (gi(f_land, i) == 0i) { continue; }
      let j = gu(f_to, i);
      let hj = select(0i, gi(f_h, j), gi(f_land, j) != 0i);
      let hi_ = gi(f_h, i);
      if (hj >= hi_) { continue; }
      // f in Q16 (the product of K dt in Q16 and sqrt(A) / far in Q16), then 1 / (1 + f) in Q32; a larger f in Q8
      let f = shr64(mul64(P[P_KA + u32(gi(f_rock, i))], reach_q16(i)), 16u);
      var u = 0u;
      if (f.y == 0u && f.x < 0xffff0000u) { u = divw(65536u, 0u, f.x + 65536u).x; }
      else { u = divw(256u, 0u, ((f.y << 24u) | (f.x >> 8u)) + 256u).x; }
      wi(f_h, i, hj + i32(umulsh(u32(hi_ - hj), u, 32u)));
    }
    storageBarrier(); workgroupBarrier();
  }
}

// ---------- hillslope creep over the land cells off the rim, the sea standing at zero beside them ----------
fn inland(i: u32) -> bool {
  let x = i & 255u; let y = i >> 8u;
  return gi(f_land, i) != 0i && x > 0u && x < 255u && y > 0u && y < 255u;
}
fn creep_step(src: u32, dst: u32, i: u32) {
  if (!inland(i)) { return; }
  let s = gi(src, i - 1u) + gi(src, i + 1u) + gi(src, i - 256u) + gi(src, i + 256u) - 4i * gi(src, i);
  wi(dst, i, gi(src, i) + mulq32(s, P[P_CREEP]));
}
@compute @workgroup_size(256)
fn crpin(@builtin(global_invocation_id) g: vec3u) { if (inland(g.x)) { wi(f_zc, g.x, gi(f_h, g.x)); } }
@compute @workgroup_size(256)
fn crpab(@builtin(global_invocation_id) g: vec3u) { creep_step(f_zc, f_zw, g.x); }
@compute @workgroup_size(256)
fn crpba(@builtin(global_invocation_id) g: vec3u) { creep_step(f_zw, f_zc, g.x); }
@compute @workgroup_size(256)
fn crpouta(@builtin(global_invocation_id) g: vec3u) { if (inland(g.x)) { wi(f_h, g.x, gi(f_zc, g.x)); } }
@compute @workgroup_size(256)
fn crpoutb(@builtin(global_invocation_id) g: vec3u) { if (inland(g.x)) { wi(f_h, g.x, gi(f_zw, g.x)); } }

// ---------- the joint valleys: the layout from the draws, then each valley's scour ----------
// The last ice sheet overrode the horst (R532). It cleared the crushed rock out of the basement's fracture zones into
// narrow joint valleys, and melting back it left its till: clayey over the soft sediments, a thin sandy skin over the
// basement that thins to nothing on the knolls it scraped bare, and thickest, with its meltwater's sand, in the joint
// valleys (R528, R529, R530). On the basement the till lies up to 6 m thick where the ground lies 5 m or more below
// the ground within 300 m of it, thinning to none, bare rock, 5 m above it [design].
fn dw(n: u32) -> u32 { return gu(f_dr, n); }
// the CPU's loops over the two joint sets, their lines and each line's valleys, reading its draws in its order
@compute @workgroup_size(1)
fn joints() {
  let nd = u32(gi(f_misc, MISC_ND));
  var n = 3u * nd; var nv = 0u;
  for (var jset = 0u; jset < 2u; jset++) {
    let sc = sincos(select(JOINT_A1, JOINT_A0, jset == 0u));
    let sn = sc.x; let cs = sc.y;
    var o = -REACH;
    for (; o < REACH; ) {
      if (n + 1u > DRN) { flag(FLAG_DRAWS); break; }
      let bx = MID + smulsh(o, cs, 30u); let by = MID + smulsh(o, sn, 30u);
      var s = -REACH;
      for (; s < REACH; ) {
        if (n + 3u > DRN) { flag(FLAG_DRAWS); break; }
        if (nv >= VMAX) { flag(FLAG_VALLEYS); break; }
        let len = LEN_MIN + i32(mulhi(dw(n), LEN_SPAN));
        let deep = i32(mulhi(dw(n + 1u), SCOUR_Z));
        let gap = GAP_MIN + i32(mulhi(dw(n + 2u), GAP_SPAN));
        n += 3u;
        let e = VT + STRIDE * nv;
        wi(f_misc, e, bx + smulsh(sn, s, 30u)); wi(f_misc, e + 1u, by + smulsh(-cs, s, 30u));
        wi(f_misc, e + 2u, len); wi(f_misc, e + 3u, deep); wi(f_misc, e + 4u, sn); wi(f_misc, e + 5u, -cs);
        nv++;
        s += len + gap;
      }
      o += LINE_MIN + i32(mulhi(dw(n), LINE_SPAN));
      n += 1u;
    }
  }
  wi(f_misc, MISC_NV, i32(nv));
}

// A joint valley's floor once it drains out of both ends: floor is the rock floor the ice cleared, ground the surface
// beside it, along the valley's cells; sill the cell at the watershed; the floor may rise toward an end by the adverse
// slope the ice could scour (Q30) over a gap in M15, in Z. The floor comes out at the ground at each end, and no cell lies
// lower than the floor beyond it toward an end less slope times the distance to it, so the valley holds no closed hollow
// deeper than the ice could make one. The floor is never below the one the ice cleared, so it is only ever raised, and
// the sill takes the higher of its two halves'. Each valley is walked by one thread over its cells in order, cuts only
// the cuttable cells (the basement), and the scour of a cell is the greatest of the valleys that cross it.
fn rise(gap: i32) -> i32 { return i32(umulsh(P[P_ADV], u32(gap), 25u)); }
@compute @workgroup_size(256)
fn valleys(@builtin(global_invocation_id) g: vec3u) {
  let e = g.x;
  if (e >= u32(gi(f_misc, MISC_NV))) { return; }
  let b = VT + STRIDE * e;
  let x0 = gi(f_misc, b); let y0 = gi(f_misc, b + 1u); let len = gi(f_misc, b + 2u); let deep = u32(gi(f_misc, b + 3u));
  let dx = gi(f_misc, b + 4u); let dy = gi(f_misc, b + 5u);
  var cells: array<u32, ${MAXC}>; var js: array<i32, ${MAXC}>; var flo: array<i32, ${MAXC}>; var gro: array<i32, ${MAXC}>; var dra: array<i32, ${MAXC}>;
  var n = 0u;
  for (var j = 0i; j < ${MAXC}i; j++) {
    let s = j * HALFM15;
    if (s > len) { break; }
    let c = cell_at(x0, y0, dx, dy, s);
    if (c < 0i) { continue; }
    if (n == 0u || cells[n - 1u] != u32(c)) { cells[n] = u32(c); js[n] = j; n++; }
  }
  if (n == 0u) { return; }
  // each cell's floor as the ice cleared it, deepest toward the ends, none at the sill in the middle (|at - 0.5| / 0.15)
  var sill = 0u; var nearest = 0x7fffffff;
  let den = i32(mulhi(u32(len), SILL2));
  for (var k = 0u; k < n; k++) {
    let i = cells[k];
    let num = abs(2i * js[k] * HALFM15 - len);
    gro[k] = gi(f_h, i);
    var cut = 0i;
    if (cuttable(i)) {
      var ratio = 1u << 24u;
      if (num < den) { ratio = divw(u32(num) >> 8u, u32(num) << 24u, u32(den)).x; }
      cut = i32(umulsh(deep, ratio, 24u));
    }
    flo[k] = gro[k] - cut;
    if (num < nearest) { nearest = num; sill = k; }
  }
  // out of each end, no lower than the floor beyond less the adverse slope over the distance to it
  var low = gro[0];
  for (var k = 0u; k <= sill; k++) {
    if (k > 0u) { low -= rise((js[k] - js[k - 1u]) * HALFM15); }
    low = max(flo[k], low);
    dra[k] = low;
  }
  low = gro[n - 1u];
  for (var k = n - 1u; k >= sill; k--) {
    if (k < n - 1u) { low -= rise((js[k + 1u] - js[k]) * HALFM15); }
    low = max(flo[k], low);
    dra[k] = select(low, max(dra[k], low), k == sill);
    if (k == 0u) { break; }
  }
  for (var k = 0u; k < n; k++) {
    let i = cells[k];
    let cut = gro[k] - dra[k];
    if (cuttable(i) && cut > 0i) { atomicMax(&AT[a_sc + i], cut); }
  }
}

${blurPass("blur0", "f_h", "f_t1", true)}
${blurPass("blur1", "f_t1", "f_t2", false)}
${blurPass("blur2", "f_t2", "f_t1", true)}
${blurPass("blur3", "f_t1", "f_t2", false)}
${blurPass("blur4", "f_t2", "f_t1", true)}
${blurPass("blur5", "f_t1", "f_ar", false)}

// ---------- the till and the height the ice leaves ----------
@compute @workgroup_size(256)
fn till(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  let bed = gi(f_h, i);
  if (bed > TALL) { flag(FLAG_TALL); }
  if (gi(f_land, i) == 0i) { wi(f_drift, i, 0i); wi(f_dd, i, 0i); return; }
  let scour = al(a_sc, i);
  var kind = TILL_CLAY; var thick = i32(TILL_Z);
  if (scour > 0i) { kind = MELTWATER; }
  else if (crystalline(gi(f_rock, i))) {
    // TILL_MAX clamp(0.5 - (bed - around) / 10, 0, 1): 5 m under the ground around gives all of it, 5 m over none
    let arg = clamp((1i << 23u) - ((bed - gi(f_ar, i)) * 8i) / 5i, 0i, 1i << 24u);
    thick = i32(umulsh(TILL_Z, u32(arg), 24u));
    kind = select(BARE, TILL_SAND, thick > 0i);
  }
  wi(f_drift, i, kind); wi(f_dd, i, thick);
  wi(f_h, i, bed - scour + thick);
}

// ---------- the hollows: the cells the flood raised by over a centimetre, in components of four neighbours ----------
// Lakes stand in the closed hollows whose floors lie below the water table at their rims; whether one fills is the
// water's balance (water.ts). The open water the climate draws its damp from is the sea and those hollows.
var<workgroup> wchg: atomic<u32>;
var<workgroup> wuni: u32;
fn hcond(i: u32) -> bool { let f = gi(f_fl, i); return f >= 0i && f - gi(f_h, i) >= HOLLOW_MIN; }
@compute @workgroup_size(256)
fn hollow(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) {
    atomicStore(&AT[a_lab + i], select(INFZ, i32(i), hcond(i)));
    atomicStore(&AT[a_dp + i], 0i);
  }
  storageBarrier(); workgroupBarrier();
  var more = 1u;
  for (var r = 0u; r < 4096u; r++) {
    if (t == 0u) { atomicStore(&wchg, 0u); }
    storageBarrier(); workgroupBarrier();
    for (var i = t; i < LEN; i += 256u) {
      let own = al(a_lab, i);
      if (own == INFZ) { continue; }
      var m = min(own, al(a_lab, u32(own)));
      let x = i & 255u; let y = i >> 8u;
      if (x > 0u) { m = min(m, al(a_lab, i - 1u)); }
      if (x < 255u) { m = min(m, al(a_lab, i + 1u)); }
      if (y > 0u) { m = min(m, al(a_lab, i - 256u)); }
      if (y < 255u) { m = min(m, al(a_lab, i + 256u)); }
      if (m < own) { atomicMin(&AT[a_lab + i], m); atomicOr(&wchg, 1u); }
    }
    storageBarrier(); workgroupBarrier();
    if (t == 0u) { wuni = atomicLoad(&wchg); }
    workgroupBarrier();
    more = workgroupUniformLoad(&wuni);
    if (more == 0u) { break; }
  }
  if (t == 0u && more != 0u) { flag(FLAG_HOLLOW); }
  for (var i = t; i < LEN; i += 256u) {
    let l = al(a_lab, i);
    if (l != INFZ) { atomicMax(&AT[a_dp + u32(l)], gi(f_fl, i) - gi(f_h, i)); }
  }
  storageBarrier(); workgroupBarrier();
  for (var i = t; i < LEN; i += 256u) {
    let l = al(a_lab, i);
    let basin = l != INFZ && al(a_dp, u32(l)) > WT_Z;
    wi(f_hol, i, select(l, -1i, l == INFZ));
    wi(f_basin, i, select(0i, 1i, basin));
    wi(f_open, i, select(0i, 1i, gi(f_fl, i) < 0i || basin));
  }
}

// ---------- what the tests ask of the arithmetic: the noise and the trigonometry at the points staged in ua and ub ----------
@compute @workgroup_size(256)
fn noise(@builtin(global_invocation_id) g: vec3u) { wi(f_da, g.x, simplex(PERM_WARP, gi(f_ua, g.x), gi(f_ub, g.x))); }
@compute @workgroup_size(256)
fn trig(@builtin(global_invocation_id) g: vec3u) {
  let sc = sincos(gu(f_ua, g.x));
  wi(f_da, g.x, sc.x); wi(f_db, g.x, sc.y);
}

// ---------- the cells by depth along the receivers, then by index: a bitonic sort of depth * 65536 + index ----------
@compute @workgroup_size(256)
fn sortorder(@builtin(local_invocation_index) t: u32) {
  for (var i = t; i < LEN; i += 256u) { wu(f_key, i, (gu(f_dpth, i) << 16u) | i); }
  storageBarrier(); workgroupBarrier();
  for (var k = 2u; k <= LEN; k = k << 1u) {
    for (var j = k >> 1u; j > 0u; j = j >> 1u) {
      for (var i = t; i < LEN; i += 256u) {
        let l = i ^ j;
        if (l > i) {
          let a = gu(f_key, i); let b = gu(f_key, l);
          if ((a > b) == ((i & k) == 0u)) { wu(f_key, i, b); wu(f_key, l, a); }
        }
      }
      storageBarrier(); workgroupBarrier();
    }
  }
  for (var i = t; i < LEN; i += 256u) { wi(f_lvl, i, i32(gu(f_key, i) & 0xffffu)); }
}
`;

export const UPSTREAM_WGSL = FIXED + consts + wgsl;
export const ENTRIES = [
  "draws", "shape", "hinge", "rocks", "dykes", "rockfin", "shore1", "shore2", "seafl", "hinit", "epse", "epsf", "flinit", "flood", "floodlast", "recv", "lvinit", "jumpa", "jumpb", "lvhist", "lvscan", "lvscatter", "area",
  "clock", "uplift", "implicit", "crpin", "crpab", "crpba", "crpouta", "crpoutb", "joints", "valleys", "blur0", "blur1", "blur2", "blur3", "blur4", "blur5", "till", "hollow", "sortorder", "noise", "trig",
] as const;
