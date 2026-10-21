// The rest of the island's climate in WGSL (src/gpu/terrain/climate.ts drives it; the comments on the constants in
// src/terrain/climate.ts give the physics): the heights blurred to the ground "around", the wind and salt each of 16
// directions bring (a wavefront over the cells), the horizons and normals, the sun through the season's cloud, warmth and
// damp air, the snow years (one thread a game tile, a sequential daily loop over eleven years) and Penman's evaporation.
// All of it integer, and each invocation writes only its own words, so every GPU gives the same words.
//
// One arena holds every field, in sections of one word a cell (N x N) in the order of SECTIONS below; a section named
// `lee` takes four words a cell (16 bytes, one a bearing), `vk` sixteen, and so on. Each field's unit and scale is
// written beside it there. The constants and tables the kernels read sit in one table buffer (TABS).
//
// Scales used throughout: Qn is a number x held as round(x * 2^n) in an i32. Q16 for most fields (m, degrees C, kPa, mm,
// shares); Q24 for sums of light (MJ/m2 a day: a clear summer day is 25, so an i32 holds up to 127) and for quantities that
// are small and need many digits (the tangent of a horizon, a cloud's share, Penman's slope of the saturation curve).
import { CELL, LEN, N } from "../../terrain/grid";
import {
  DIRS, FAR, FAR_M, FOG_Z, HALF_LENGTH, LAPSE, PARTS, SEA_WIND, SEASON_DAYS, SPRAY_M, STEP, TAYLOR_LEE,
  WAKE, WAKE_X, FRESH, OLD, C_H, FUSION, CP, VAPORIZE, SIGMA, K0, YEARS,
} from "../../terrain/climate";
import { FIXED } from "./fixed";

export const Q = (x: number) => Math.round(x * 65536);
export const Q24 = (x: number) => Math.round(x * 2 ** 24);
export const Q32 = (x: number) => Math.round(x * 2 ** 32);

// ---------- the format and the arena ----------
// What the kernels are made for: the grid's side `n` (cells) and, with `patch`, a patch of the planet (src/gpu/globe/air.ts)
// where the island's one-place constants are the cell's own: each cell's sea-level air, the sea's warmth and the air's water by
// season, its wind's turn, its band of latitude (the sun's table for the band, in the compass's axes), and the turn of the grid's
// axes against east and north; the snow years run over groups of four cells made by the host and the wind's wavefront schedule
// is kept whole. The island's format makes the text the island's stage has always had.
export interface ClimateFormat { n: number; patch?: boolean }
export const ISLAND_CLIMATE: ClimateFormat = { n: N };
// The width of a band of latitude a patch's sun table is made for, degrees [design: 0.1 degree is 0.12% of the day's length at
// 60 degrees and 195.6 km of radius, so the step between two bands of the table is under the stage's own roundings].
export const BAND_DEG = 0.1, BANDS_MAX = 200;

// One arena holds every field, in sections of one word a cell (N x N) in the order below; a section named `lee` takes four
// words a cell (16 bytes, one a bearing), `vk` sixteen, and so on. Each field's unit and scale is written beside it.
// Inputs first (written by the host), then the fields the host reads back, then the rest.
const sectionsOf = (patch: boolean): [string, number][] => [
  ["hq", 1], // Q16 m: the ground as the island's height field has it (the sea's depth negative)
  ["open", 1], // 1 over the sea and lakes
  ["precip", 4], // Q16 mm a season
  ...(patch ? ([
    ["tS", 4], // Q16 C: the air's sea-level warmth, by season
    ["seaS", 4], // Q16 C: the sea's surface
    ["e0S", 4], // Q16 kPa: the air's water at sea level
    ["wturn", 1], // Q16 bearings (mod 16): the cell's wind direction less the rose's own mean
    ["band", 1], // the cell's band of latitude in the sun table, counted from the patch's first
    ["cps", 1], ["sps", 1], // Q16: cosine and sine of the grid's x axis against east, toward north
    ["psi", 1], // Q16 bearings (mod 16): the same angle
  ] as [string, number][]) : []),
  ["windShare", 1], // Q16
  ["breeze", 1], // Q16 m/s
  ["salt", 1], // Q16
  ["lee", 4], // bytes: hundredths of the coast's wind, 16 a cell, bearing k in byte k
  ["sky", 1], // Q16
  ["pool", 1], // Q16
  ["snow", 1], // Q16
  ["snowCover", 1], // Q16
  ["fog", 1], // Q24
  ["temp", 1], // Q16 C
  ["pet", 1], // Q16 mm a year
  ["sun", 1], // Q16 (the year's sunlight against open level ground's)
  ["petS", 4], // Q16 mm a season
  ["sunS", 4], // Q24 MJ/m2 a day
  ["tempS", 4], // Q16 C
  ["humidS", 4], // Q16
  ["snowpack", 4], // Q16 mm
  ["z", 1], // Q16 m: the ground, never under the sea's level
  ["around", 1], // Q16 m: z blurred over some 600 m
  ["tmp", 1],
  ["vk", 16], // Q16: the wind there from each bearing against the coast's
  ["sk", 16], // Q16: the salt that bearing brings
  ["top", 16], // Q16 m: the top of the break the air last passed from that bearing, -0x7fffffff for none
  ["since", 16], // Q16 m: how far back it was
  ["shore", 16], // Q16 m: how far the air has come over land from that bearing
  ["nx", 1], ["ny", 1], ["nz", 1], // Q16: the unit normal
  ["slope", 1], // Q16: the ground's rise over run
  ["hz", 16], // Q24: the tangent of the horizon along each bearing
  ["fogS", 4], // Q24: the share of the season a cell stands in cloud
  ["clearS", 4], // Q24 MJ/m2 a day under a clear sky
  ["cover", 4], // Q16: the share of the ground snow covers, by season
  ["albedo", 4], // Q16
];

export const REACH_N = 26; // the horizon's sample distances 1.2^n below 110 cells
export const LOGIT_N = 7002, SAT_N = 7002, COVERS_N = 6002;
export const DAYS = 365 * (YEARS + 1);

export interface Layout {
  f: ClimateFormat; n: number; len: number;
  SECTIONS: [string, number][]; SEC: Record<string, number>; ARENA_WORDS: number; INPUT_WORDS: number; // the words the host writes
  SUN_MAX: number; SUN_STRIDE: number; MAX_LEVELS: number; GROUPS: number;
  TABO: Record<string, number>; TAB_WORDS: number;
}
const layouts = new Map<string, Layout>();
export function layoutOf(f: ClimateFormat = ISLAND_CLIMATE): Layout {
  const key = `${f.n}:${f.patch ? 1 : 0}`;
  let l = layouts.get(key);
  if (l) return l;
  const patch = !!f.patch, len = f.n * f.n;
  const SUN_MAX = patch ? 96 : 80, SUN_STRIDE = 8 + SUN_MAX * 8, MAX_LEVELS = patch ? 4096 : 1024, GROUPS = (f.n / 2 + 2) ** 2;
  // the table buffer
  const TABS: [string, number][] = [
    ["dirs", 64], // per bearing: round(1.5 cos) Q16, round(1.5 sin) Q16, the wind rose's share Q32, 0
    ["cs16", 32], // per bearing: cos, sin Q16
    ["reach", REACH_N * 2], // per distance: d cells Q16, 256 / (d * CELL) Q28
    ["seas", 4 * 16], // per season: t, sea, e0 Q16; pool's cooling Q24; flat sun Q24; warm Q16; 1 / spread Q24; days; light's cloud shares Q16
    ...(patch ? ([["sunb", BANDS_MAX * 4 * SUN_STRIDE]] as [string, number][]) : ([["sun", 4 * SUN_STRIDE]] as [string, number][])), // a band's four seasons: the sun's header and rows (a patch's rows in the compass's axes)
    ["logit", LOGIT_N],
    ["sat", SAT_N],
    ["covers", COVERS_N],
    ["anom", DAYS],
    ["cal", 365 * 4], // per day: cos, sin, cos 2x of the year's angle Q24 and the day's season
    ["fogz", FOG_Z.length], // the heights the cloud's chance is given at, Q16 m
    ["fogrows", 4 * FOG_Z.length], // a season's chance at each of them, Q24
    ["sched", 2 * MAX_LEVELS],
    ["lst", DIRS * len],
    ...(patch ? ([["rosec", DIRS], ["grp", 4 * GROUPS]] as [string, number][]) : []), // the wind rose as measured, Q32; each group's four cells (-1 for none)
  ];
  const SECTIONS = sectionsOf(patch), SEC: Record<string, number> = {}, TABO: Record<string, number> = {};
  let ARENA_WORDS = 0, TAB_WORDS = 0;
  for (const [name, w] of SECTIONS) { SEC[name] = ARENA_WORDS; ARENA_WORDS += w * len; }
  for (const [name, w] of TABS) { TABO[name] = TAB_WORDS; TAB_WORDS += w; }
  l = { f, n: f.n, len, SECTIONS, SEC, ARENA_WORDS, INPUT_WORDS: SEC.windShare, SUN_MAX, SUN_STRIDE, MAX_LEVELS, GROUPS, TABO, TAB_WORDS };
  layouts.set(key, l);
  return l;
}
// The island's, as the module has always exported them.
const ISLE = layoutOf();
export const { SECTIONS, SEC, ARENA_WORDS, INPUT_WORDS, SUN_MAX, SUN_STRIDE, MAX_LEVELS, TABO, TAB_WORDS } = ISLE;

// Words of a season's row in the `seas` table.
export const SEAS = { t: 0, sea: 1, e0: 2, poolc: 3, flat: 4, warm: 5, inv: 6, days: 7, tb: 8, tg: 9 };

const offsets = (l: Layout) => [
  ...Object.entries(l.SEC).map(([k, v]) => `const O_${k} = ${v}u;`),
  ...Object.entries(l.TABO).map(([k, v]) => `const T_${k} = ${v}u;`),
].join("\n");

const q = (x: number) => `${Q(x)}i`;
const q24 = (x: number) => `${Q24(x)}i`;

// the wind's wake curve (climate.ts wake), piecewise linear through the knots
function wakeFn() {
  const xs = WAKE_X.map(Q), ws = WAKE.map(Q);
  let s = `fn wake_q(xh: i32) -> i32 {\n  if (xh <= ${xs[0]}i) { return ${ws[0]}i; }\n`;
  for (let n = 1; n < xs.length; n++) s += `  if (xh <= ${xs[n]}i) { return ${ws[n - 1]}i + seg(u32(xh - ${xs[n - 1]}i), ${ws[n] - ws[n - 1]}u, ${xs[n] - xs[n - 1]}u); }\n`;
  return s + `  return ${ws[xs.length - 1]}i;\n}`;
}

const common = (l: Layout) => {
  const n = l.n;
  return /* wgsl */ `
${FIXED}
@group(0) @binding(0) var<storage, read_write> W: array<i32>;
@group(0) @binding(1) var<storage, read> TAB: array<i32>;
@group(0) @binding(2) var<storage, read_write> CUR: array<u32>;
const LEN = ${l.len}u;
const ONE = 65536i;
const ONE24 = 16777216i;
const NEG = -0x7fffffffi;
const LIM = ${(n - 1) * 65536}i; // (N - 1) in Q16
${offsets(l)}

// a * b / 2^sh to nearest, ties away from zero, saturating (1 <= sh <= 48)
fn mulr(a: i32, b: i32, sh: u32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  var half = vec2u(0u, 0u);
  if (sh <= 32u) { half.x = 1u << (sh - 1u); } else { half.y = 1u << (sh - 33u); }
  let p = add64(mul64(mag(a), mag(b)), half);
  var r = 0u; var hi = 0u;
  if (sh < 32u) { r = (p.x >> sh) | (p.y << (32u - sh)); hi = p.y >> sh; }
  else if (sh == 32u) { r = p.y; }
  else { r = p.y >> (sh - 32u); }
  if (hi != 0u || r > 0x7fffffffu) { return select(FX_MAX, -FX_MAX, neg); }
  let v = bitcast<i32>(r);
  return select(v, -v, neg);
}
// a / b * 2^sh to nearest, for a and b held at one scale (0 <= sh <= 31), saturating
fn divsh(a: i32, b: i32, sh: u32) -> i32 {
  let neg = (a < 0i) != (b < 0i);
  if (b == 0i) { return select(select(0i, -FX_MAX, a < 0i), FX_MAX, a > 0i); }
  let A = mag(a); let B = mag(b);
  var num = vec2u(A << sh, 0u);
  if (sh > 0u) { num.y = A >> (32u - sh); }
  num = add64(num, vec2u(B >> 1u, 0u));
  if (num.y >= B) { return select(FX_MAX, -FX_MAX, neg); }
  let r = divw(num.y, num.x, B).x;
  if (r > 0x7fffffffu) { return select(FX_MAX, -FX_MAX, neg); }
  let v = bitcast<i32>(r);
  return select(v, -v, neg);
}
// the unsigned a * dw / dx, to nearest
fn seg(a: u32, dw: u32, dx: u32) -> i32 {
  let p = add64(mul64(a, dw), vec2u(dx >> 1u, 0u));
  return bitcast<i32>(divw(p.y, p.x, dx).x);
}
// a + (b - a) t for t in Q16
fn lerpq(a: i32, b: i32, t: i32) -> i32 { return a + qmul(b - a, t); }
// the bilinear read of a section at a cell and a fraction (both Q16) of the way to its +x and +y neighbours
fn bil(base: u32, j: u32, fx: i32, fy: i32) -> i32 {
  let a = W[base + j]; let b = W[base + j + 1u]; let c = W[base + j + ${n}u]; let d = W[base + j + ${n + 1}u];
  let r0 = lerpq(a, b, fx); let r1 = lerpq(c, d, fx);
  return lerpq(r0, r1, fy);
}
fn esat_q(t: i32) -> i32 { return qmul(${q(0.6108)}, qexp(qdiv(qmul(${q(17.27)}, t), t + ${q(237.3)}))); }
// the air's pressure at a height against sea level's (climate.ts pressure)
fn pressure_q(z: i32) -> i32 { return qpow(qdiv(${q(293)} - mulr(z, ${Q32(LAPSE)}i, 32u), ${q(293)}), ${q(5.26)}); }
fn ramp_q(v: i32, lo: i32, hi: i32) -> i32 {
  let t = clamp(qdiv(v - lo, hi - lo), 0i, ONE);
  return qmul(qmul(t, t), 3i * ONE - 2i * t);
}
// Every entry point binds all three buffers (the pipelines' automatic layouts keep only those a kernel uses, and the host
// binds them alike), so each reads one word of each here.
fn touch() { _ = W[0]; _ = TAB[0]; _ = CUR[0]; }
fn flat(g: vec3u, n: vec3u) -> u32 { touch(); return g.x + g.y * n.x * 64u; }
`;
};

// ---------- the heights blurred to the ground around ----------
// The cell's column and row from its index: masks and shifts where the side is a power of two (the island's 256).
const colOf = (n: number, i: string) => (Number.isInteger(Math.log2(n)) ? `i32(${i} & ${n - 1}u)` : `i32(${i} % ${n}u)`);
const rowOf = (n: number, i: string) => (Number.isInteger(Math.log2(n)) ? `i32(${i} >> ${Math.log2(n)}u)` : `i32(${i} / ${n}u)`);
export const prepWgsl = (f: ClimateFormat = ISLAND_CLIMATE) => /* wgsl */ `
${common(layoutOf(f))}
@compute @workgroup_size(64) fn zinit(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  let z = max(0i, W[O_hq + i]);
  W[O_z + i] = z; W[O_around + i] = z;
}
// 17 cells across, edges repeating: three passes each way make a cheap Gaussian (grid.ts blur, radius 8)
fn blur_at(src: u32, dst: u32, i: u32, across: bool) {
  let x = ${colOf(f.n, "i")}; let y = ${rowOf(f.n, "i")};
${f.patch ? `  // the sum of 17 heights of 6.4 km passes a word: the sixteenths and the rest summed apart, divided exactly
  var hi = 0i; var lo = 0i;
  for (var k = -8i; k <= 8i; k++) {
    let v = select(W[src + u32(clamp(y + k, 0i, ${f.n - 1}i) * ${f.n}i + x)], W[src + u32(y * ${f.n}i + clamp(x + k, 0i, ${f.n - 1}i))], across);
    hi += v >> 4u; lo += v & 15i;
  }
  let q17 = hi / 17i;
  W[dst + i] = 16i * q17 + (16i * (hi - q17 * 17i) + lo + 8i) / 17i;` : `  var s = 0i;
  for (var k = -8i; k <= 8i; k++) {
    if (across) { s += W[src + u32(y * ${f.n}i + clamp(x + k, 0i, ${f.n - 1}i))]; }
    else { s += W[src + u32(clamp(y + k, 0i, ${f.n - 1}i) * ${f.n}i + x)]; }
  }
  W[dst + i] = (s + 8i) / 17i;`}
}
@compute @workgroup_size(64) fn blur_x(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  blur_at(O_around, O_tmp, i, true);
}
@compute @workgroup_size(64) fn blur_y(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  blur_at(O_tmp, O_around, i, false);
}`;

// ---------- the wind and the salt ----------
// Each bearing's air crosses the island cell by cell in order of how far downwind a cell is: a cell reads the four cells
// round the place 1.5 cells upwind of it. The host groups the (bearing, cell) pairs into levels, a cell one level after the
// last cell it reads, and the kernel runs a level at a time (air_step, then air_advance to count the level).
const STEPM = Math.round(STEP * CELL * 65536);
export const airWgsl = (f: ClimateFormat = ISLAND_CLIMATE) => {
  const n = f.n, SHS = f.patch ? 4096 : 65536;
  return /* wgsl */ `
${common(layoutOf(f))}
${wakeFn()}
const STEPM = ${STEPM}i;${f.patch ? `
// a patch's air has come over land for tens of kilometres: the shore's distance is held in Q12 m (to 524 km), and how far behind a break a cell stands saturates
const STEPS = ${STEPM >> 4}i;
fn sadd(a: i32, b: i32) -> i32 { return select(a + b, 0x7fffffffi, a > 0x7fffffffi - b); }` : ""}
const PARTS_Q = ${Math.round(PARTS * STEP * CELL * 65536)}i;
@compute @workgroup_size(64) fn air_step(@builtin(global_invocation_id) g: vec3u) {
  let d = CUR[0];
  let start = u32(TAB[T_sched + 2u * d]); let count = u32(TAB[T_sched + 2u * d + 1u]);
  if (g.x >= count) { return; }
  let e = u32(TAB[T_lst + start + g.x]);
  ${f.patch ? "let k = e / LEN; let i = e % LEN;" : "let k = e >> 16u; let i = e & 0xffffu;"}
  let cs = TAB[T_dirs + 4u * k]; let sn = TAB[T_dirs + 4u * k + 1u];
  let x = ${colOf(n, "i")}; let y = ${rowOf(n, "i")};
  let ux = (x << 16u) - cs; let uy = (y << 16u) - sn;
  let off = ux < 0i || uy < 0i || ux > LIM || uy > LIM;
  let zi = W[O_z + i];
  let b = k * LEN;
  let isopen = W[O_open + i] != 0i;
  var T = NEG; var X = 0i; var v = ONE; var sh = 0i;
${f.patch ? "  // upwind of the patch's edge the air has come over land for as far as the host seeded it (the cell's word in `shore`, 0 where it did not)\n  if (off) { sh = W[O_shore + b + i]; }\n" : ""}  if (!off) {
    let x0 = min(${n - 2}i, ux >> 16u); let y0 = min(${n - 2}i, uy >> 16u);
    let fx = ux - (x0 << 16u); let fy = uy - (y0 << 16u);
    let j = u32(y0 * ${n}i + x0);
    let up = bil(O_z, j, fx, fy);
    if (!isopen) { sh = ${f.patch ? "sadd(bil(O_shore + b, j, fx, fy), STEPS)" : "bil(O_shore + b, j, fx, fy) + STEPM"}; }
    // the break the nearest upwind cell carries, or the ground just upwind if it falls away steeply enough to part the flow
    let nj = j + select(0u, 1u, fx >= 32768i) + select(0u, ${n}u, fy >= 32768i);
    T = W[O_top + b + nj]; X = ${f.patch ? "sadd(W[O_since + b + nj], STEPM)" : "W[O_since + b + nj] + STEPM"};
    if (T > zi) { v = wake_q(qdiv(X, T - zi)); }
    if (up - zi > PARTS_Q) {
      let w = wake_q(qdiv(STEPM, up - zi));
      if (w <= v) { T = up; X = STEPM; v = w; }
    }
  }
  if (!(T > zi)) { T = NEG; X = 0i; }
  W[O_top + b + i] = T; W[O_since + b + i] = X; W[O_shore + b + i] = sh;
  if (isopen) { v = ONE; }
  else { v = qmul(v, ONE + mulr(max(0i, zi - W[O_around + i]), ${Q32(TAYLOR_LEE / HALF_LENGTH)}i, 32u)); }
  W[O_vk + b + i] = v;
  let e1 = qexp(-qdiv(sh, ${Math.round(SPRAY_M * SHS)}i));
  let e2 = qexp(-qdiv(sh, ${Math.round(FAR_M * SHS)}i));
  W[O_sk + b + i] = qmul(${q(1 - FAR)}, e1) + qmul(${q(FAR)}, e2);
}
@compute @workgroup_size(1) fn air_advance() { touch(); CUR[0] = CUR[0] + 1u; }

// f (Q32) times v (Q16), to Q24
fn fq24(f: u32, v: u32) -> u32 { let p = add64(mul64(f, v), vec2u(0x800000u, 0u)); return (p.x >> 24u) | (p.y << 8u); }
@compute @workgroup_size(64) fn air_reduce(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  var ws = 0u; var sa = 0u;
  var words = array<u32, 4>(0u, 0u, 0u, 0u);
${f.patch ? "  let turn = W[O_wturn + i];\n" : ""}  for (var k = 0u; k < ${DIRS}u; k++) {
${f.patch ? `    // the rose as measured, turned to the cell's wind and read between two of its sectors (climate.ts turned)
    let u = u32((i32(k << 16u) - turn) & 0xfffff); let k0 = u >> 16u; let fr = u & 65535u;
    let rp = add64(add64(mul64(u32(TAB[T_rosec + k0]), 65536u - fr), mul64(u32(TAB[T_rosec + ((k0 + 1u) & 15u)]), fr)), vec2u(32768u, 0u));
    let f = (rp.x >> 16u) | (rp.y << 16u);` : "    let f = u32(TAB[T_dirs + 4u * k + 2u]);"}
    let v = u32(W[O_vk + k * LEN + i]);
    ws += fq24(f, v);
    sa += fq24(f, u32(W[O_sk + k * LEN + i]));
    let byte = min(255u, (v * 100u + 32768u) >> 16u);
    words[k >> 2u] = words[k >> 2u] | (byte << ((k & 3u) * 8u));
  }
  for (var w = 0u; w < 4u; w++) { W[O_lee + i * 4u + w] = bitcast<i32>(words[w]); }
  W[O_windShare + i] = min(ONE, i32((ws + 128u) >> 8u));
  W[O_breeze + i] = mulr(i32(ws), ${Q(SEA_WIND)}i, 24u);
  W[O_salt + i] = i32((sa + 128u) >> 8u);
}`;
};

// ---------- the ground's normal, its horizons and the share of sky it leaves open ----------
export const shapeWgsl = (f: ClimateFormat = ISLAND_CLIMATE) => {
  const n = f.n;
  return /* wgsl */ `
${common(layoutOf(f))}
fn zat(x: i32, y: i32) -> i32 { return W[O_z + u32(clamp(y, 0i, ${n - 1}i) * ${n}i + clamp(x, 0i, ${n - 1}i))]; }
// grid.ts sample: the bilinear read at (px, py) in Q16 cells, held inside the grid by a thousandth of a cell
fn zsample(px: i32, py: i32) -> i32 {
  let cx = min(px, ${Math.round((n - 1.001) * 65536)}i); let cy = min(py, ${Math.round((n - 1.001) * 65536)}i);
  let x0 = cx >> 16u; let y0 = cy >> 16u;
  return bil(O_z, u32(y0 * ${n}i + x0), cx & 65535i, cy & 65535i);
}
@compute @workgroup_size(64) fn shape_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  let x = ${colOf(n, "i")}; let y = ${rowOf(n, "i")};
  let gx = qdiv(zat(x + 1i, y) - zat(x - 1i, y), ${q(2 * CELL)});
  let gy = qdiv(zat(x, y + 1i) - zat(x, y - 1i), ${q(2 * CELL)});
  let g2 = qmul(gx, gx) + qmul(gy, gy);
  let gg = qsqrt(g2 + ONE);
  W[O_nx + i] = qdiv(-gx, gg); W[O_ny + i] = qdiv(-gy, gg); W[O_nz + i] = qdiv(ONE, gg);
  W[O_slope + i] = qsqrt(g2);
  var sky = ONE;
  if (W[O_hq + i] > ${q(-2)}) {
    let zi = W[O_z + i];
    var open2 = 0i;
    for (var k = 0u; k < ${DIRS}u; k++) {
      let c = TAB[T_cs16 + 2u * k]; let s = TAB[T_cs16 + 2u * k + 1u];
      var top = 0i;
      for (var r = 0u; r < ${REACH_N}u; r++) {
        let d = TAB[T_reach + 2u * r];
        let px = (x << 16u) + qmul(c, d); let py = (y << 16u) + qmul(s, d);
        if (px < 0i || py < 0i || px > LIM || py > LIM) { break; }
        let diff = zsample(px, py) - zi;
        if (diff > 0i) { top = max(top, mulr(diff, TAB[T_reach + 2u * r + 1u], 28u)); }
      }
      W[O_hz + i * ${DIRS}u + k] = top;
      open2 += divsh(ONE24, ONE24 + mulr(top, top, 24u), 24u);
    }
    sky = (open2 + 2048i) >> 12u;
  }
  W[O_sky + i] = sky;
}`;
};

// ---------- sunlight through the season's cloud ----------
export const sunWgsl = (f: ClimateFormat = ISLAND_CLIMATE) => {
  const l = layoutOf(f);
  return /* wgsl */ `
${common(l)}
fn fog_q24(s: u32, z: i32) -> i32 {
  for (var n = 1u; n < ${FOG_Z.length}u; n++) {
    let zn = TAB[T_fogz + n];
    if (z <= zn) {
      let a = TAB[T_fogrows + s * 8u + n - 1u]; let b = TAB[T_fogrows + s * 8u + n];
      let z0 = TAB[T_fogz + n - 1u];
      let t = (z - z0) / ((zn - z0) >> 16u);
      return a + mulr(b - a, t, 16u);
    }
  }
  return TAB[T_fogrows + s * 8u + 7u];
}
@compute @workgroup_size(64) fn sun_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  let lit = W[O_hq + i] > ${q(-2)};
  let z = W[O_z + i]; let sky = W[O_sky + i];
  let nx = W[O_nx + i]; let ny = W[O_ny + i]; let nz = W[O_nz + i];
${f.patch ? `  // the table's rows are in the compass's axes (east, north): the normal turned to them, and the horizon's bearing in the grid's axes
  let ce = qmul(nx, W[O_cps + i]) - qmul(ny, W[O_sps + i]); let cn = qmul(nx, W[O_sps + i]) + qmul(ny, W[O_cps + i]);
  let band = u32(W[O_band + i]); let psi = W[O_psi + i];
` : ""}  for (var s = 0u; s < 4u; s++) {
    let sb = ${f.patch ? `T_sunb + (band * 4u + s) * ${l.SUN_STRIDE}u` : `T_sun + s * ${l.SUN_STRIDE}u`};
    let cnt = u32(TAB[sb]); let tb = TAB[sb + 1u]; let gl = TAB[sb + 2u]; let lv = TAB[sb + 3u]; let cl = TAB[sb + 4u]; let icl = TAB[sb + 5u]; let tgl = TAB[sb + 6u];
    let p = fog_q24(s, z);
    let np = ONE24 - p;
    var out = 0i; var clear = 0i;
    if (!lit) {
      out = mulr(np, cl, 24u) + mulr(p, icl, 24u);
      clear = lv;
    } else {
      var b = 0i;
      for (var q = 0u; q < cnt; q++) {
        let o = sb + 8u + q * 8u;
        ${f.patch ? "let face = qmul(ce, TAB[o]) + qmul(cn, TAB[o + 1u]) + qmul(nz, TAB[o + 2u]);" : "let face = qmul(nx, TAB[o]) + qmul(ny, TAB[o + 1u]) + qmul(nz, TAB[o + 2u]);"}
        if (face > 0i) {
${f.patch ? `          let kq = ((TAB[o + 5u] << 16u) + TAB[o + 6u] - psi) & 0xfffff;
          let k0 = u32(kq) >> 16u; let k1 = (k0 + 1u) & 15u; let fr = kq & 65535i;
          let h0 = W[O_hz + i * ${DIRS}u + k0]; let h1 = W[O_hz + i * ${DIRS}u + k1];
          if (TAB[o + 3u] > h0 + mulr(h1 - h0, fr, 16u)) { b += mulr(face, TAB[o + 4u], 16u); }` : `          let k0 = u32(TAB[o + 5u]); let k1 = (k0 + 1u) & 15u;
          let h0 = W[O_hz + i * ${DIRS}u + k0]; let h1 = W[O_hz + i * ${DIRS}u + k1];
          if (TAB[o + 3u] > h0 + mulr(h1 - h0, TAB[o + 6u], 16u)) { b += mulr(face, TAB[o + 4u], 16u); }`}
        }
      }
      out = mulr(np, mulr(tb, b, 16u) + mulr(tgl, sky, 16u), 24u) + mulr(p, mulr(icl, sky, 16u), 24u);
      clear = b + mulr(gl, sky, 16u);
    }
    W[O_fogS + s * LEN + i] = p; W[O_sunS + s * LEN + i] = out; W[O_clearS + s * LEN + i] = clear;
  }
}`;
};

// ---------- warmth and damp air ----------
export const warmWgsl = (f: ClimateFormat = ISLAND_CLIMATE) => {
  const l = layoutOf(f);
  return /* wgsl */ `
${common(l)}
@compute @workgroup_size(64) fn pool_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  var pool = 0i;
  if (W[O_open + i] == 0i) {
    let hollow = ramp_q(W[O_around + i] - W[O_z + i], ${q(3)}, ${q(40)});
    let gentle = ONE - ramp_q(W[O_slope + i], ${q(0.06)}, ${q(0.25)});
    pool = qmul(qmul(hollow, gentle), ONE - qmul(${q(0.7)}, W[O_windShare + i]));
  }
  W[O_pool + i] = pool;
}
@compute @workgroup_size(64) fn temp_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  let z = W[O_z + i]; let pool = W[O_pool + i]; let u = W[O_breeze + i];
  let sea = W[O_hq + i] < 0i && W[O_open + i] != 0i;
  let pr = pressure_q(z);
  let cool = mulr(z, ${Q32(LAPSE)}i, 32u);${f.patch ? "\n  let band = u32(W[O_band + i]);" : ""}
  var sum = 0i;
  for (var s = 0u; s < 4u; s++) {
    let r = T_seas + s * 16u;
    var T = ${f.patch ? "W[O_seaS + s * LEN + i]" : `TAB[r + ${SEAS.sea}u]`};
    if (!sea) {
      let dI = mulr(W[O_sunS + s * LEN + i] - ${f.patch ? `TAB[T_sunb + (band * 4u + s) * ${l.SUN_STRIDE}u + 4u]` : `TAB[r + ${SEAS.flat}u]`}, ${q(11.574)}, 24u);
      T = ${f.patch ? "W[O_tS + s * LEN + i]" : `TAB[r + ${SEAS.t}u]`} - cool + qdiv(dI, ${q(32.7)} + qmul(${q(42.2)}, u)) - mulr(pool, TAB[r + ${SEAS.poolc}u], 24u);
    }
    W[O_tempS + s * LEN + i] = T;
    W[O_humidS + s * LEN + i] = min(ONE, qdiv(qmul(${f.patch ? "W[O_e0S + s * LEN + i]" : `TAB[r + ${SEAS.e0}u]`}, pr), esat_q(T)));
    sum += T;
  }
  W[O_temp + i] = (sum + 2i) >> 2u;
}`;
};

// ---------- snow ----------
// Each game tile (two cells a side) runs the snow years on its land cells' means.
const NEG_LIMIT = -40 * 65536, POS_LIMIT = 30 * 65536;
// The index of a game tile's first cell from the tile's own (the tiles are two cells a side, row after row).
const tileOrigin = (n: number) => {
  const half = n / 2;
  return Number.isInteger(Math.log2(half)) ? `(tile >> ${Math.log2(half)}u) * ${2 * n}u + (tile & ${half - 1}u) * 2u` : `(tile / ${half}u) * ${2 * n}u + (tile % ${half}u) * 2u`;
};
// shift: bits the sums of a day's rain and snow over the years are shifted down by (their ratio is the snow's share), for a place
// whose year of rain passes what the words hold unshifted (3,000 mm)
export const snowWgsl = (ranges: { coldest: number; warmest: number }, shift = 0, f: ClimateFormat = ISLAND_CLIMATE) => {
  const l = layoutOf(f);
  return /* wgsl */ `
${common(l)}
const DAYS_ALL = ${DAYS}u;
fn tile_mean(base: u32, cells: array<u32, 4>, n: u32, sh: u32) -> i32 {
  var s = 0i;
  for (var c = 0u; c < n; c++) { s += (W[base + cells[c]] + select(0i, (1i << sh) >> 1u, sh > 0u)) >> sh; }
  return (2i * s + select(i32(n), -i32(n), s < 0i)) / (2i * i32(n));
}
@compute @workgroup_size(64) fn snow_init(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  W[O_snow + i] = 0i; W[O_snowCover + i] = 0i;
  for (var s = 0u; s < 4u; s++) { W[O_cover + s * LEN + i] = 0i; W[O_albedo + s * LEN + i] = ${q(OLD)}; W[O_snowpack + s * LEN + i] = 0i; }
}
@compute @workgroup_size(64) fn snow_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let tile = flat(g, nw);
${f.patch ? `  if (tile >= ${l.GROUPS}u) { return; }
  // the group's cells are the host's: a game tile's four cells of the planet, whichever way the patch lays them (-1 where the patch holds none)
  var cells = array<u32, 4>(0u, 0u, 0u, 0u);
  var n = 0u;
  for (var c = 0u; c < 4u; c++) {
    let j = TAB[T_grp + tile * 4u + c];
    if (j >= 0i && W[O_open + u32(j)] == 0i) { cells[n] = u32(j); n++; }
  }` : `  if (tile >= ${(f.n / 2) * (f.n / 2)}u) { return; }
  let i0 = ${tileOrigin(f.n)};
  var cells = array<u32, 4>(0u, 0u, 0u, 0u);
  var n = 0u;
  for (var c = 0u; c < 4u; c++) {
    let j = i0 + (c & 1u) + (c >> 1u) * ${f.n}u;
    if (W[O_open + j] == 0i) { cells[n] = j; n++; }
  }`}
  if (n == 0u) { return; }
  var T4 = array<i32, 4>(0i, 0i, 0i, 0i);
  for (var s = 0u; s < 4u; s++) { T4[s] = tile_mean(O_tempS + s * LEN, cells, n, 0u); }
  let mean = (T4[0] + T4[1] + T4[2] + T4[3] + 2i) >> 2u;
  let a1 = (T4[0] - T4[2] + 1i) >> 1u; let b1 = (T4[1] - T4[3] + 1i) >> 1u;
  let a2 = (T4[0] - T4[1] + T4[2] - T4[3] + 2i) >> 2u;
  let amp = qsqrt(qmul(a1, a1) + qmul(b1, b1));
  if (mean - amp - abs(a2) + ${ranges.coldest}i > ${ranges.warmest}i) { return; }
  // each season's rain a day, sun, share of a clear day's sun, the water in the air, the dew point and what the sky sends back
  var P = array<i32, 4>(0i, 0i, 0i, 0i); var R = array<i32, 4>(0i, 0i, 0i, 0i); var F = array<i32, 4>(0i, 0i, 0i, 0i);
  var E = array<i32, 4>(0i, 0i, 0i, 0i); var dew = array<i32, 4>(0i, 0i, 0i, 0i); var back = array<i32, 4>(0i, 0i, 0i, 0i);
  var warm = array<i32, 4>(0i, 0i, 0i, 0i); var inv = array<i32, 4>(0i, 0i, 0i, 0i);
  var wet = 0u;
  for (var s = 0u; s < 4u; s++) {
    let r = T_seas + s * 16u;
    P[s] = mulr(tile_mean(O_precip + s * LEN, cells, n, 0u), ${Q32(1 / SEASON_DAYS)}i, 32u);
    R[s] = tile_mean(O_sunS + s * LEN, cells, n, 8u);
    F[s] = min(ONE, qdiv(R[s], max(${q(0.1)}, tile_mean(O_clearS + s * LEN, cells, n, 8u))));
    E[s] = qmul(tile_mean(O_humidS + s * LEN, cells, n, 0u), esat_q(T4[s]));
    let gg = qln(qdiv(E[s], ${q(0.6108)}));
    dew[s] = qdiv(qmul(${q(237.3)}, gg), ${q(17.27)} - gg);
    back[s] = ONE - qmul(${q(0.34)} - qmul(${q(0.14)}, qsqrt(E[s])), qmul(${q(1.35)}, F[s]) - ${q(0.35)});
    warm[s] = TAB[r + ${SEAS.warm}u]; inv[s] = TAB[r + ${SEAS.inv}u];
    wet += u32(${shift ? `P[s] >> ${shift}u` : "P[s]"}) * u32(TAB[r + ${SEAS.days}u]) * ${YEARS}u;
  }
  let u = max(${q(0.5)}, tile_mean(O_breeze, cells, n, 0u));
  let pk = qmul(${q(101.3)}, pressure_q(tile_mean(O_z, cells, n, 0u)));
  let Wc = mulr(mulr(u, pk, 16u), ${q24((1000 / 287.05) * C_H * 86400 / 1e6 * 1000)}, 24u);
  let cE = qdiv(${q((VAPORIZE / 1000) * 0.622)}, pk);
  var pack = 0i; var fell = 0u;
  var lying = array<u32, 4>(0u, 0u, 0u, 0u); var white = array<u32, 4>(0u, 0u, 0u, 0u);
  var packs = array<vec2u, 4>(vec2u(0u), vec2u(0u), vec2u(0u), vec2u(0u));
  for (var y = 0u; y <= ${YEARS}u; y++) {
    for (var day = 0u; day < 365u; day++) {
      let si = u32(TAB[T_cal + day * 4u + 3u]);
      let T = mean + mulr(a1, TAB[T_cal + day * 4u], 24u) + mulr(b1, TAB[T_cal + day * 4u + 1u], 24u) + mulr(a2, TAB[T_cal + day * 4u + 2u], 24u) + TAB[T_anom + y * 365u + day];
      if (pack == 0i && T > warm[si]) { continue; }
      let rain = P[si];
      let xc = clamp(mulr(T - ${q(1.3)}, inv[si], 24u), ${NEG_LIMIT}i, ${POS_LIMIT}i);
      let v = (xc + ${-NEG_LIMIT}i) * 100i;
      let k = u32(v >> 16u);
      let l0 = TAB[T_logit + k];
      let flakes = qmul(rain, l0 + qmul(TAB[T_logit + k + 1u] - l0, v & 65535i));
      pack += flakes;
      var ea = E[si]; var sky = back[si];
      if (T < dew[si]) {
        let w = (max(${NEG_LIMIT}i, T) + ${-NEG_LIMIT}i) * 100i;
        let j = u32(w >> 16u);
        let s0 = TAB[T_sat + j];
        ea = s0 + qmul(TAB[T_sat + j + 1u] - s0, w & 65535i);
        sky = ONE - qmul(${q(0.34)} - qmul(${q(0.14)}, qsqrt(ea)), qmul(${q(1.35)}, F[si]) - ${q(0.35)});
      }
      var alpha = ${q(OLD)};
      if (flakes * 2i > rain) { alpha = ${q(FRESH)}; }
      let K = T + ${q(K0)};
      let Kh = i32((u32(K) * 64u) / 25u);
      let Kh2 = mulr(Kh, Kh, 24u);
      let Kh4 = mulr(Kh2, Kh2, 24u);
      let lw = (mulr(mulr(sky, Kh4, 16u) - ${Math.round(((K0 / 100) ** 4) * 2 ** 24)}i, ${q24(SIGMA * 1e8)}, 24u) + 128i) >> 8u;
      let kj = mulr(T, ${q24(CP / 1000)}, 24u) + qmul(cE, ea - ${q(0.6108)});
      let turb = mulr(kj, divsh(Wc, K, 24u), 24u);
      let Q = qmul(ONE - alpha, R[si]) + lw + turb;
      pack = max(0i, pack - qdiv(max(0i, Q), ${q(FUSION)}));
      if (y == 0u) { continue; }
      fell += u32(${shift ? `flakes >> ${shift}u` : "flakes"});
      if (pack == 0i) { continue; }
      var q100 = 6000i * ONE;
      if (pack < 60i * ONE) { q100 = pack * 100i; }
      let m = u32(q100 >> 16u);
      let c0 = TAB[T_covers + m];
      let c = c0 + qmul(TAB[T_covers + m + 1u] - c0, q100 & 65535i);
      packs[si] = add64(packs[si], vec2u(u32(pack), 0u));
      lying[si] += u32(c);
      white[si] += u32(qmul(c, alpha));
    }
  }
  var snow = 0i;
  if (wet > 0u) { snow = qdiv(i32(fell), i32(wet)); }
  let den = ${Math.round(SEASON_DAYS * YEARS * 1000)}u; // SEASON_DAYS * YEARS * 1000
  var every = 0u;
  for (var s = 0u; s < 4u; s++) { every += lying[s]; }
  let cov = (every + 1825u) / ${365 * YEARS}u;
  for (var c = 0u; c < n; c++) {
    let j = cells[c];
    W[O_snow + j] = snow;
    W[O_snowCover + j] = i32(cov);
    for (var s = 0u; s < 4u; s++) {
      let pa = packs[s];
      let p0 = mul64(pa.x, 1000u); let p1 = mul64(pa.y, 1000u);
      let pm = vec2u(p0.x, p0.y + p1.x);
      W[O_snowpack + s * LEN + j] = bitcast<i32>(divw(pm.y, pm.x, den).x);
      let lm = mul64(lying[s], 1000u);
      W[O_cover + s * LEN + j] = bitcast<i32>(divw(lm.y, lm.x, den).x);
      if (lying[s] > 0u) { W[O_albedo + s * LEN + j] = qdiv(i32(white[s]), i32(lying[s])); }
    }
  }
}`;
};

// ---------- evaporation ----------
export const petWgsl = (flatYear: number, f: ClimateFormat = ISLAND_CLIMATE) => {
  const l = layoutOf(f);
  return /* wgsl */ `
${common(l)}
@compute @workgroup_size(64) fn pet_main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = flat(g, n);
  if (i >= LEN) { return; }
  let z = W[O_z + i]; let u = max(${q(0.5)}, W[O_breeze + i]);
  let gamma = mulr(pressure_q(z), ${q24(0.000665 * 101.3)}, 16u);
  var year = 0i; var sunSum = 0i; var fogSum = 0i;
  for (var s = 0u; s < 4u; s++) {
    let t = W[O_tempS + s * LEN + i];
    let es = esat_q(t); let ea = qmul(es, W[O_humidS + s * LEN + i]);
    let sun = W[O_sunS + s * LEN + i]; let clear = W[O_clearS + s * LEN + i];
    let om = (t + ${q(237.3)}) >> 8u;
    let d24 = mulr(qdiv(qdiv(es, om), om), ${q24(4098 / 65536)}, 16u);
    let Kh = i32((u32(t + ${q(K0)}) * 64u) / 25u);
    let Kh4 = mulr(mulr(Kh, Kh, 24u), mulr(Kh, Kh, 24u), 24u);
    let cloud = qdiv(sun, max(${q24(0.1)}, clear));
    let rnl = mulr(mulr(mulr(Kh4, ${q24(SIGMA * 1e8)}, 24u), ${q(0.34)} - qmul(${q(0.14)}, qsqrt(ea)), 16u), qmul(${q(1.35)}, min(ONE, cloud)) - ${q(0.35)}, 16u);
    let aero = mulr(mulr(gamma, qdiv(${q(900)}, t + ${q(273)}), 16u), u, 16u);
    let den = d24 + mulr(gamma, ONE + qmul(${q(0.34)}, u), 16u);
    let grass = max(0i, divsh(mulr(mulr(d24, mulr(${q(0.77)}, sun, 16u) - rnl, 24u), ${q(0.408)}, 16u) + mulr(aero, es - ea, 16u), den, 24u));
    let c = W[O_cover + s * LEN + i];
    var onSnow = 0i;
    if (c > 0i) {
      let net = mulr(ONE - W[O_albedo + s * LEN + i], sun, 16u) - rnl;
      onSnow = max(0i, divsh(mulr(mulr(d24, net, 24u), ${q(0.353)}, 16u) + mulr(aero, ${q(0.6108)} - ea, 16u), den, 24u));
    }
    let day24 = mulr(ONE - c, grass, 16u) + mulr(c, onSnow, 16u);
    let e = mulr(day24, ${q(SEASON_DAYS)}, 24u);
    W[O_petS + s * LEN + i] = e;
    year += e; sunSum += (sun + 128i) >> 8u; fogSum += W[O_fogS + s * LEN + i];
  }
  W[O_pet + i] = year;
  ${f.patch ? "W[O_sun + i] = qdiv(sunSum, TAB[T_sunb + u32(W[O_band + i]) * 4u * " + l.SUN_STRIDE + "u + 7u]);" : `W[O_sun + i] = qdiv(sunSum, ${flatYear}i);`}
  W[O_fog + i] = (fogSum + 2i) >> 2u;
}`;
};
