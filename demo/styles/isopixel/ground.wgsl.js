// The live ground on the GPU: main.js drawTerrainLive's colour for every ground pixel (groundAt, then paintWater or
// paintLand and everything they call) and the world fields it reads, written in WGSL, and the packing of those fields
// into textures and buffers. Every texel is read with textureLoad and blended here the way the JavaScript blends it,
// in the same order, so a pixel painted here is the bake's pixel wherever float32 allows.
//
// Noise is where float32 would part from the bake first: a world coordinate divided by a scale of a few decimetres is
// tens of thousands, with a thousandth of a cell lost to rounding at the island's edge. So every scale is taken as a
// ratio of whole numbers, x / S = x q / p, and the lattice cell and the place inside it are found with integer
// division, exact to about a millionth of a cell.
import { CELL, M, N, RM, SIZE, START, STEP, TILES, TILE_M } from "../island.js";
import { P, RGB } from "./pal.js";

const ORIGIN = -SIZE / 2, WS = 12.5, WN = Math.ceil(SIZE / WS) + 1, TN = Math.round(SIZE / 3);
// flora.ts streamAt's bins: 50 m across, holding every segment within REACH of them, cell -1 at index 0
const BIN = 50, REACH = 20, NB = Math.ceil(SIZE / BIN) + 3;
const COVER_LAYERS = ["tree", "shrub", "grass", "marsh", "bare", "sand"];
// The island fields the painter reads, one layer each of the isle texture, in this order.
const ISLE_LAYERS = ["height", "water", "exposure", "rock", "precip", "pet", "table", "peat", "soil", "silt", "fog", "snow0", "snow1", "snow2", "snow3"];
const IL = Object.fromEntries(ISLE_LAYERS.map((n, i) => [n, i]));

// ---------- packing ----------
// Everything the painter reads, as plain typed arrays for the renderer to upload: the fine ground (M x M, ten layers),
// the island's fields (N x N), the 12.5 m light grid (heights, occlusion, slope; layers 3 to 7 the renderer's own), the
// stream mask, main.js's table of ground colour pairs, the noise's gradients and the streams binned for streamAt.
// `consts` goes to groundWGSL as it is.
export function packGround(isle, g) {
  const MM = M * M, fine = new Float32Array(MM * 10);
  [g.h, g.wet, g.moist, g.river, ...COVER_LAYERS.map((k) => g.cover[k])].forEach((f, L) => fine.set(f, L * MM));
  const NN = N * N, S1 = isle.seasons[1], src = { height: isle.height, water: isle.water, exposure: isle.exposure, rock: isle.rock, precip: S1.precip, pet: S1.pet, table: isle.table, peat: isle.peat, soil: isle.soil, silt: isle.silt, fog: isle.fog };
  for (let s = 0; s < 4; s++) src[`snow${s}`] = isle.seasons[s].snowpack;
  const isl = new Float32Array(NN * ISLE_LAYERS.length);
  ISLE_LAYERS.forEach((n, L) => isl.set(src[n], L * NN));

  // main.js worldHeights and worldAO, and flora.ts worldSlope, worked out the way they work them out
  const W2 = WN * WN, grid = new Float32Array(W2 * 8), h = grid.subarray(0, W2), ao = grid.subarray(W2, 2 * W2), sl = grid.subarray(2 * W2, 3 * W2);
  for (let j = 0; j < WN; j++) for (let i = 0; i < WN; i++) h[j * WN + i] = Math.max(0, g.heightAt(ORIGIN + i * WS, ORIGIN + j * WS));
  const r = 16, tmp = new Float32Array(W2), m = new Float32Array(W2);
  for (let j = 0; j < WN; j++) { let a = 0, c = 0; for (let i = -r; i < WN + r; i++) { if (i + r < WN) { a += h[j * WN + i + r]; c++; } if (i - r - 1 >= 0) { a -= h[j * WN + i - r - 1]; c--; } if (i >= 0 && i < WN) tmp[j * WN + i] = a / c; } }
  for (let i = 0; i < WN; i++) { let a = 0, c = 0; for (let j = -r; j < WN + r; j++) { if (j + r < WN) { a += tmp[(j + r) * WN + i]; c++; } if (j - r - 1 >= 0) { a -= tmp[(j - r - 1) * WN + i]; c--; } if (j >= 0 && j < WN) m[j * WN + i] = a / c; } }
  for (let k = 0; k < W2; k++) ao[k] = Math.max(-1, Math.min(0.6, (h[k] - m[k]) / 45));
  const d = 18.75;
  for (let j = 0; j < WN; j++)
    for (let i = 0; i < WN; i++) {
      const X = -SIZE / 2 + i * WS, Z = -SIZE / 2 + j * WS;
      sl[j * WN + i] = Math.hypot(g.heightAt(X + d, Z) - g.heightAt(X - d, Z), g.heightAt(X, Z + d) - g.heightAt(X, Z - d)) / (2 * d);
    }

  // the noise's gradient table, as flora.ts makes it
  const grad = new Float32Array(8192);
  for (let k = 0; k < 4096; k++) { grad[k * 2] = Math.cos((k / 4096) * 6.2831853); grad[k * 2 + 1] = Math.sin((k / 4096) * 6.2831853); }

  // Streams: every vertex as x, z, mean flow, groundwater share, wettest flow; a bin's list holds the index of each
  // segment's second vertex, in flora.ts's order, so ties fall to the same segment. The bins' list starts come first,
  // as indices into the same array.
  const starts = [], verts = [];
  for (const line of g.rivers) { starts.push(verts.length / 5); for (const p of line) verts.push(p[0], p[1], p[2], p[3], p[4]); }
  const bins = Array.from({ length: NB * NB }, () => []), cell = (v) => Math.floor((v + SIZE / 2) / BIN);
  g.rivers.forEach((line, l) => {
    for (let k = 1; k < line.length; k++) {
      const [ax, az] = line[k - 1], [bx, bz] = line[k];
      for (let j = cell(Math.min(az, bz) - REACH); j <= cell(Math.max(az, bz) + REACH); j++)
        for (let i = cell(Math.min(ax, bx) - REACH); i <= cell(Math.max(ax, bx) + REACH); i++)
          if (i >= -1 && j >= -1 && i < NB - 1 && j < NB - 1) bins[(j + 1) * NB + i + 1].push(starts[l] + k);
    }
  });
  let total = 0;
  for (const b of bins) total += b.length;
  const streamBins = new Uint32Array(NB * NB + 1 + total);
  let at = NB * NB + 1;
  bins.forEach((b, k) => { streamBins[k] = at; streamBins.set(b, at); at += b.length; });
  streamBins[NB * NB] = at;

  return {
    fine: { size: M, layers: 10, data: fine },
    isle: { size: N, layers: ISLE_LAYERS.length, data: isl },
    grid: { size: WN, layers: 8, data: grid },
    river: g.mask,
    dq: dqBuild(),
    grad,
    streams: new Float32Array(verts.length ? verts : [0, 0, 0, 0, 0]),
    streamBins,
    consts: { quick: Array.from(isle.quick) },
  };
}

// main.js dqBuild: the nearest pair of natural ground colours for every RGB at 5 bits a channel, and how far along the
// pair the colour lies, packed as first | second << 8 | step << 16.
const DQ_NAMES = ["g0", "g1", "g2", "g3", "g4", "g5", "g6", "t1", "t2", "t3", "a0", "a1", "a2", "a3", "d0", "d1", "d2", "d3", "d4", "d5", "r0", "r1", "r2", "r3", "r4", "r5", "s0", "s1", "s2", "s3", "m0", "m1", "m2", "m3", "h0", "h1", "h2", "h3", "o0", "o1", "o2", "o3"];
function dqBuild() {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ids = DQ_NAMES.map((n) => P[n]), cols = ids.map((i) => RGB[i]), W8 = [3, 4, 2], d2 = (a, b) => W8[0] * (a[0] - b[0]) ** 2 + W8[1] * (a[1] - b[1]) ** 2 + W8[2] * (a[2] - b[2]) ** 2;
  const DQ = new Uint32Array(32768);
  for (let r = 0; r < 32; r++)
    for (let gg = 0; gg < 32; gg++)
      for (let b = 0; b < 32; b++) {
        const t0 = [r * 8 + 4, gg * 8 + 4, b * 8 + 4], near = cols.map((c, k) => [d2(c, t0), k]).sort((a, b) => a[0] - b[0]).slice(0, 6);
        let best = [near[0][0], near[0][1], near[0][1], 0];
        for (const [, i] of near)
          for (let j = 0; j < cols.length; j++) {
            if (j === i) continue;
            const A = cols[i], Bc = cols[j], e = [Bc[0] - A[0], Bc[1] - A[1], Bc[2] - A[2]];
            const t = clamp(((t0[0] - A[0]) * e[0] * W8[0] + (t0[1] - A[1]) * e[1] * W8[1] + (t0[2] - A[2]) * e[2] * W8[2]) / (W8[0] * e[0] ** 2 + W8[1] * e[1] ** 2 + W8[2] * e[2] ** 2 || 1), 0, 1);
            const q = d2([A[0] + e[0] * t, A[1] + e[1] * t, A[2] + e[2] * t], t0) + d2(A, Bc) * 0.2 * t * (1 - t);
            if (q < best[0]) best = [q, i, j, t];
          }
        DQ[(r << 10) | (gg << 5) | b] = ids[best[1]] | (ids[best[2]] << 8) | (Math.round(best[3] * 255) << 16);
      }
  return DQ;
}

// The bindings groundWGSL declares, in order, for the renderer's bind group layout.
export const GROUND_BINDINGS = [
  { name: "gFine", kind: "texture", sampleType: "unfilterable-float", dim: "2d-array" },
  { name: "gIsle", kind: "texture", sampleType: "unfilterable-float", dim: "2d-array" },
  { name: "gGrid", kind: "texture", sampleType: "unfilterable-float", dim: "2d-array" },
  { name: "gRiver", kind: "texture", sampleType: "uint", dim: "2d" },
  { name: "gTrail", kind: "texture", sampleType: "uint", dim: "2d" },
  { name: "gIce", kind: "texture", sampleType: "uint", dim: "2d" },
  { name: "gDQ", kind: "storage" },
  { name: "gGradT", kind: "storage" },
  { name: "gStreams", kind: "storage" },
  { name: "gStreamBins", kind: "storage" },
];

// ---------- WGSL ----------
// a number as a WGSL float literal holding its nearest float32
const lit = (v) => { const s = String(Math.fround(v)); return /[.e]/.test(s) ? s : `${s}.0`; };
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
// (x + c) / S times 2.03 to the octave, as (x q + o) / p in whole numbers, for g_dv
function ratio(S, oct = 0, c = 0) {
  const s = String(S), digits = s.includes(".") ? s.length - s.indexOf(".") - 1 : 0;
  let q = 10 ** digits * 203 ** oct, p = Math.round(S * 10 ** digits) * 100 ** oct;
  const k = gcd(q, p);
  q /= k; p /= k;
  for (let m = 2; !Number.isInteger(c * q) && m <= 64; m *= 2) { q *= 2; p *= 2; }
  const o = c * q;
  // a coordinate's whole meters (under 2^15) times q, plus o, must stay inside an i32
  if (!Number.isInteger(o) || q * 2 ** 15 + Math.abs(o) >= 2 ** 31) throw new Error(`ground.wgsl.js: (x + ${c}) / ${S} at octave ${oct} has no exact form`);
  return `${q}, ${o}, ${p}, ${lit(q / p)}`;
}
// noise(vx / Sx, vz / Sz, seed) at octave oct of an fbm
const NOISE = (Sx, Sz, seed, oct = 0, vx = "x", vz = "z") => `g_noiseP(g_dv(${vx}, ${ratio(Sx, oct)}), g_dv(${vz}, ${ratio(Sz, oct)}), ${seed + oct * 31})`;
// fbm(vx / Sx, vz / Sz, seed, 2)
const FBM = (Sx, Sz, seed, vx = "x", vz = "z") => `(${NOISE(Sx, Sz, seed, 0, vx, vz)} * 0.5 + ${NOISE(Sx, Sz, seed, 1, vx, vz)} * 0.25)`;
// main.js fade(S, mpp)
const FADE = (S) => `g_fade(${lit(S * 0.45)}, ${lit(S * 1.4)}, mpp)`;
// main.js clusters(x, z, S, seed, mpp, cut)
const CL = (S, seed, cut = "0.42") => `g_clusters(x, z, ${ratio(S, 0)}, ${lit(S * 0.45)}, ${lit(S * 1.4)}, ${seed}, mpp, ${cut})`;
// noise(x / Sx, z / Sz, seed) * fade(S, mpp), skipping the noise where the fade is nothing
const NF = (Sx, Sz, seed, S) => `g_nfade(x, z, ${ratio(Sx, 0)}, ${ratio(Sz, 0)}, ${seed}, ${lit(S * 0.45)}, ${lit(S * 1.4)}, mpp)`;
// h2(...) < t, decided exactly on the hash's 32 bits
const UT = (t) => `${Math.ceil(t * 2 ** 32)}u`;
const rgb = (c) => `vec3<f32>(${c.map(lit).join(", ")})`;
const arr = (type, vals) => `array<${type}, ${vals.length}>(${vals.join(", ")})`;
const u = (name) => `${P[name]}u`;
const ramp = (...names) => arr("u32", names.map(u));

// The ground's WGSL at bind group `group`: the bindings in GROUND_BINDINGS order and the functions the renderer calls.
// consts: packGround's `consts` (the island's runoff by season).
export function groundWGSL(group, consts) {
  if (!consts?.quick || consts.quick.length < 4) throw new Error("groundWGSL needs packGround's consts (quick by season)");
  const G = `@group(${group})`;
  const SEASON_QUICK = consts.quick.slice(0, 4).map((q) => lit(q * 1.2));
  return /* wgsl */ `
${G} @binding(0) var gFine: texture_2d_array<f32>;
${G} @binding(1) var gIsle: texture_2d_array<f32>;
${G} @binding(2) var gGrid: texture_2d_array<f32>;
${G} @binding(3) var gRiver: texture_2d<u32>;
${G} @binding(4) var gTrail: texture_2d<u32>;
${G} @binding(5) var gIce: texture_2d<u32>;
${G} @binding(6) var<storage, read> gDQ: array<u32>;
${G} @binding(7) var<storage, read> gGradT: array<vec2<f32>>;
${G} @binding(8) var<storage, read> gStreams: array<f32>;
${G} @binding(9) var<storage, read> gStreamBins: array<u32>;

// k: the level's art pixels per meter; frame 0..7 of the water's loop; season 0 spring .. 3 winter; flags bit 0: worn
// paths are drawn
struct PaintCtx { k: f32, frame: u32, season: u32, flags: u32 }

const g_N: i32 = ${N};
const g_M: i32 = ${M};
const g_RM: i32 = ${RM};
const g_WN: i32 = ${WN};
const g_TN: i32 = ${TN};
const g_TILES: i32 = ${TILES};
const g_NB: i32 = ${NB};
// the island's corner, -ORIGIN, in whole meters
const g_HALFI: i32 = ${SIZE / 2};
const g_ORIGIN: f32 = ${lit(ORIGIN)};
const g_QUICK = array<f32, 4>(${SEASON_QUICK.join(", ")});

const g_BAYER = ${arr("f32", [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => lit((v + 0.5) / 16)))};
const g_DI = ${ramp("d0", "d1", "d2", "d3", "d4", "d5")};
const g_SA = ${ramp("d3", "s0", "s1", "s2", "s3")};
const g_RK = ${ramp("r0", "r1", "r2", "r3", "r4", "r5")};
const g_MUD = ${ramp("d0", "m0", "m1", "m2")};
const g_WA = ${ramp("w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7")};
const g_ICE = ${ramp("w6", "haze", "snow")};
const g_HALF = array<f32, 5>(0.0, 0.45, 0.6, 0.78, 1.0);
// main.js's Math.floor(1.4 + 3.9 * 0 + R * 0.4 + C * 0.5) for R -2..2 and C -1..1, as float64 works it out
const g_OPEN = ${arr("i32", [-2, -1, 0, 1, 2].flatMap((R) => [-1, 0, 1].map((C) => Math.floor(1.4 + 3.9 * 0 + R * 0.4 + C * 0.5))))};

// ---------- px.js ----------
fn bayer(x: i32, y: i32) -> f32 { return g_BAYER[((y & 3) << 2u) | (x & 3)]; }
fn g_h2u(x: i32, y: i32, s: i32) -> u32 {
  var h = bitcast<u32>(x * 374761393 + y * 668265263 + s * 1442695041);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return h ^ (h >> 16u);
}
// the hash's top 24 bits, so it stays under 1 as px.js's does
fn g_hf(u: u32) -> f32 { return f32(u >> 8u) * (1.0 / 16777216.0); }
fn h2(x: i32, y: i32, s: i32) -> f32 { return g_hf(g_h2u(x, y, s)); }
// ((h2 * 97) | 0) & 1 from the hash's bits, exactly
fn g_odd97(u: u32) -> i32 { return i32((((u >> 16u) * 97u + (((u & 0xffffu) * 97u) >> 16u)) >> 16u) & 1u); }

// ---------- flora.ts noise ----------
fn g_smooth(a: f32, b: f32, v: f32) -> f32 { let t = clamp((v - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// JavaScript's Math.round
fn g_jround(v: f32) -> f32 { return floor(v + 0.5); }
fn g_fdiv(a: i32, p: i32) -> i32 { let d = a / p; return select(d, d - 1, d * p != a && a < 0); }
// (x q + o) / p as a whole part and a fraction in [0, 1); qp is q / p
fn g_dv(x: f32, q: i32, o: i32, p: i32, qp: f32) -> vec2<f32> {
  let xb = floor(x);
  let a = i32(xb) * q + o;
  let n = g_fdiv(a, p);
  let f = f32(a - n * p) / f32(p) + (x - xb) * qp;
  let k = floor(f);
  return vec2<f32>(f32(n) + k, f - k);
}
// a coordinate from g_dv held inside [0, hi], as main.js and flora.ts clamp theirs
fn g_clampC(c: vec2<f32>, hi: vec2<f32>) -> vec2<f32> {
  if (c.x < 0.0) { return vec2<f32>(0.0, 0.0); }
  if (c.x > hi.x || (c.x == hi.x && c.y > hi.y)) { return hi; }
  return c;
}
fn g_grad(x: i32, y: i32, s: i32) -> vec2<f32> {
  var h = bitcast<u32>(x * 374761393 + y * 668265263 + s * 982451653);
  h = (h ^ (h >> 13u)) * 1274126177u;
  return gGradT[(h ^ (h >> 16u)) >> 20u];
}
// gradient noise at a point given per axis as (lattice cell, place in it)
fn g_noiseP(px: vec2<f32>, pz: vec2<f32>, s: i32) -> f32 {
  let x0 = i32(px.x);
  let y0 = i32(pz.x);
  let fx = px.y;
  let fy = pz.y;
  let G0 = g_grad(x0, y0, s);
  let G1 = g_grad(x0 + 1, y0, s);
  let G2 = g_grad(x0, y0 + 1, s);
  let G3 = g_grad(x0 + 1, y0 + 1, s);
  let a = G0.x * fx + G0.y * fy;
  let b = G1.x * (fx - 1.0) + G1.y * fy;
  let c = G2.x * fx + G2.y * (fy - 1.0);
  let d = G3.x * (fx - 1.0) + G3.y * (fy - 1.0);
  let u = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
  let v = fy * fy * fy * (fy * (fy * 6.0 - 15.0) + 10.0);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.4;
}

// ---------- main.js fade, clusters, tone, dq ----------
fn g_fade(lo: f32, hi: f32, mpp: f32) -> f32 { return 1.0 - g_smooth(lo, hi, mpp); }
fn g_clusters(x: f32, z: f32, q: i32, o: i32, p: i32, qp: f32, lo: f32, hi: f32, seed: i32, mpp: f32, cut: f32) -> f32 {
  let a = g_fade(lo, hi, mpp);
  if (a <= 0.0) { return 0.0; }
  let n = g_noiseP(g_dv(x, q, o, p, qp), g_dv(z, q, o, p, qp), seed) * a;
  return select(select(0.0, -1.0, n < -cut), 1.0, n > cut);
}
fn g_nfade(x: f32, z: f32, qx: i32, ox: i32, px: i32, rx: f32, qz: i32, oz: i32, pz: i32, rz: f32, seed: i32, lo: f32, hi: f32, mpp: f32) -> f32 {
  let a = g_fade(lo, hi, mpp);
  if (a <= 0.0) { return 0.0; }
  return g_noiseP(g_dv(x, qx, ox, px, rx), g_dv(z, qz, oz, pz, rz), seed) * a;
}
fn g_toneIndex(v: f32, X: i32, Y: i32, n: i32) -> i32 { return clamp(i32(floor(v + 0.5 + (bayer(X, Y) - 0.5) * 0.55)), 0, n - 1); }
fn g_dithIndex(v: f32, X: i32, Y: i32, n: i32) -> i32 { return clamp(i32(floor(v + bayer(X, Y))), 0, n - 1); }
fn g_dq(c: vec3<f32>, X: i32, Y: i32) -> u32 {
  let r = clamp(i32(c.x) >> 3u, 0, 31);
  let g = clamp(i32(c.y) >> 3u, 0, 31);
  let b = clamp(i32(c.z) >> 3u, 0, 31);
  let e = gDQ[(r << 10u) | (g << 5u) | b];
  return select(e & 255u, (e >> 8u) & 255u, bayer(X, Y) * 255.0 < f32(e >> 16u));
}

// ---------- the world's fields ----------
// World meters as coordinates on the fine grid, the island's cells, the 12.5 m light grid, the stream mask's texel
// centres and the sim's tiles less half a tile: (whole part, fraction), each exact as the JavaScript's
fn g_fineC(x: f32) -> vec2<f32> { return g_dv(x, ${ratio(STEP, 0, -START)}); }
fn g_cellC(x: f32) -> vec2<f32> { return g_dv(x, ${ratio(CELL, 0, -START)}); }
fn g_gridC(x: f32) -> vec2<f32> { return g_dv(x, ${ratio(WS, 0, -ORIGIN)}); }
fn g_maskC(x: f32) -> vec2<f32> { return g_dv(x, ${ratio(SIZE / RM, 0, SIZE / 2 - SIZE / RM / 2)}); }
fn g_tileC(x: f32) -> vec2<f32> { return g_dv(x, ${ratio(TILE_M, 0, -ORIGIN - TILE_M / 2)}); }
// JavaScript's Math.round of a coordinate
fn g_roundC(c: vec2<f32>) -> i32 { return i32(c.x) + select(0, 1, c.y >= 0.5); }
// Fine.fine: a fine field read between its vertices, the coordinate held to [0, M - 1.001]
fn g_fineAt(L: i32, x: f32, z: f32) -> f32 {
  let hi = vec2<f32>(${M - 2}.0, ${lit(M - 1.001 - (M - 2))});
  let cu = g_clampC(g_fineC(x), hi);
  let cv = g_clampC(g_fineC(z), hi);
  let tu = cu.y;
  let tv = cv.y;
  let i = vec2<i32>(i32(cu.x), i32(cv.x));
  let a = textureLoad(gFine, i, L, 0).x;
  let b = textureLoad(gFine, i + vec2<i32>(1, 0), L, 0).x;
  let c = textureLoad(gFine, i + vec2<i32>(0, 1), L, 0).x;
  let d = textureLoad(gFine, i + vec2<i32>(1, 1), L, 0).x;
  return (a * (1.0 - tu) + b * tu) * (1.0 - tv) + (c * (1.0 - tu) + d * tu) * tv;
}
fn heightAt(x: f32, z: f32) -> f32 { return g_fineAt(0, x, z); }
fn g_isleAt(L: i32, i: i32, j: i32) -> f32 { return textureLoad(gIsle, vec2<i32>(clamp(i, 0, g_N - 1), clamp(j, 0, g_N - 1)), L, 0).x; }
// Fine.bilinear over an island field at cell coordinates from g_cellC
fn g_bil(L: i32, cx: vec2<f32>, cy: vec2<f32>) -> f32 {
  let tx = cx.y;
  let ty = cy.y;
  let x = i32(cx.x);
  let y = i32(cy.x);
  return (g_isleAt(L, x, y) * (1.0 - tx) + g_isleAt(L, x + 1, y) * tx) * (1.0 - ty) + (g_isleAt(L, x, y + 1) * (1.0 - tx) + g_isleAt(L, x + 1, y + 1) * tx) * ty;
}
// main.js wsample over a layer of the 12.5 m grid (flora.ts worldSlope reads its own the same way)
fn g_gridAt(L: i32, x: f32, z: f32) -> f32 {
  let hi = vec2<f32>(${WN - 2}.0, ${lit(WN - 1.001 - (WN - 2))});
  let cu = g_clampC(g_gridC(x), hi);
  let cv = g_clampC(g_gridC(z), hi);
  let a = cu.y;
  let c = cv.y;
  let i = vec2<i32>(i32(cu.x), i32(cv.x));
  return (textureLoad(gGrid, i, L, 0).x * (1.0 - a) + textureLoad(gGrid, i + vec2<i32>(1, 0), L, 0).x * a) * (1.0 - c) + (textureLoad(gGrid, i + vec2<i32>(0, 1), L, 0).x * (1.0 - a) + textureLoad(gGrid, i + vec2<i32>(1, 1), L, 0).x * a) * c;
}

// flora.ts waterAt: how much standing water covers a point, 0..1
fn waterAt(x: f32, z: f32) -> f32 {
  let cx = g_cellC(x);
  let cy = g_cellC(z);
  let i = g_roundC(cx);
  let j = g_roundC(cy);
  if (i < 0 || j < 0 || i >= g_N || j >= g_N) { return 1.0; }
  var lvl = 0.0;
  var any = false;
  for (var b = max(0, j - 1); b <= min(g_N - 1, j + 1); b++) {
    for (var a = max(0, i - 1); a <= min(g_N - 1, i + 1); a++) {
      let w = g_isleAt(${IL.water}, a, b);
      if (w > 0.0) {
        let l = g_isleAt(${IL.height}, a, b) + w;
        lvl = select(l, max(lvl, l), any);
        any = true;
      }
    }
  }
  if (!any) { return 0.0; }
  let x0 = clamp(cx.x, 0.0, f32(g_N - 2));
  let y0 = clamp(cy.x, 0.0, f32(g_N - 2));
  let tx = select(clamp(cx.x + cx.y - x0, 0.0, 1.0), cx.y, cx.x == x0);
  let ty = select(clamp(cy.x + cy.y - y0, 0.0, 1.0), cy.y, cy.x == y0);
  let i0 = i32(x0);
  let j0 = i32(y0);
  var wet = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var sea = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  for (var k = 0; k < 4; k++) {
    let a = i0 + (k & 1);
    let b = j0 + (k >> 1u);
    let w = g_isleAt(${IL.water}, a, b);
    wet[k] = select(0.0, 1.0, w > 0.0);
    sea[k] = select(0.0, 1.0, w > 0.0 && g_isleAt(${IL.height}, a, b) < 0.0);
  }
  let bw = (wet[0] * (1.0 - tx) + wet[1] * tx) * (1.0 - ty) + (wet[2] * (1.0 - tx) + wet[3] * tx) * ty;
  let bs = (sea[0] * (1.0 - tx) + sea[1] * tx) * (1.0 - ty) + (sea[2] * (1.0 - tx) + sea[3] * tx) * ty;
  let v = min(0.5 + (lvl - heightAt(x, z)) / 2.0, 0.5 + (bw - 0.2) * 2.0);
  return clamp(max(v, bs - 0.1), 0.0, 1.0);
}
// main.js buildMap's surfAt: the level of the nearest standing water within two cells, 0 if none
fn surfAt(x: f32, z: f32) -> f32 {
  let cx = g_roundC(g_cellC(x));
  let cy = g_roundC(g_cellC(z));
  var best = 0.0;
  var bd = 1000;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let X = cx + dx;
      let Y = cy + dy;
      if (X < 0 || Y < 0 || X >= g_N || Y >= g_N) { continue; }
      let w = textureLoad(gIsle, vec2<i32>(X, Y), ${IL.water}, 0).x;
      if (w <= 0.0) { continue; }
      if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = textureLoad(gIsle, vec2<i32>(X, Y), ${IL.height}, 0).x + w; }
    }
  }
  return best;
}
fn g_riverAt(i: i32, j: i32) -> f32 { return f32(textureLoad(gRiver, vec2<i32>(clamp(i, 0, g_RM - 1), clamp(j, 0, g_RM - 1)), 0).x) / 255.0; }
// flora.ts riverSmooth: the stream mask read between its texels
fn g_riverSmooth(x: f32, z: f32) -> f32 {
  let cu = g_maskC(x);
  let cv = g_maskC(z);
  let a = cu.y;
  let b = cv.y;
  let i = i32(cu.x);
  let j = i32(cv.x);
  return (g_riverAt(i, j) * (1.0 - a) + g_riverAt(i + 1, j) * a) * (1.0 - b) + (g_riverAt(i, j + 1) * (1.0 - a) + g_riverAt(i + 1, j + 1) * a) * b;
}
// flora.ts streamAt's bin of a coordinate, from its whole meters, which cannot cross a bin edge on their own
fn g_binOf(x: f32) -> i32 { return g_fdiv(i32(floor(x)) + g_HALFI, ${BIN}) + 1; }
// flora.ts streamAt: (distance off the nearest stream's middle, its mean flow, its groundwater share, 1) or all 0
fn g_streamAt(x: f32, z: f32) -> vec4<f32> {
  var best = vec4<f32>(0.0);
  let i = g_binOf(x);
  let j = g_binOf(z);
  if (i < 0 || j < 0 || i >= g_NB || j >= g_NB) { return best; }
  let bin = u32(j * g_NB + i);
  let end = gStreamBins[bin + 1u];
  for (var e = gStreamBins[bin]; e < end; e++) {
    let kb = gStreamBins[e] * 5u;
    let ka = kb - 5u;
    let ax = gStreams[ka];
    let az = gStreams[ka + 1u];
    let dx = gStreams[kb] - ax;
    let dz = gStreams[kb + 1u] - az;
    var l2 = dx * dx + dz * dz;
    if (l2 == 0.0) { l2 = 1e-9; }
    let t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0.0, 1.0);
    let d = length(vec2<f32>(x - ax - dx * t, z - az - dz * t));
    if (d <= ${REACH}.0 && (best.w == 0.0 || d < best.x)) {
      best = vec4<f32>(d, gStreams[ka + 2u] + (gStreams[kb + 2u] - gStreams[ka + 2u]) * t, gStreams[ka + 3u] + (gStreams[kb + 3u] - gStreams[ka + 3u]) * t, 1.0);
    }
  }
  return best;
}

// ---------- ice (the ice edge the CPU bake once drew, main.js iceTex) ----------
fn g_ice(i: i32, j: i32) -> f32 {
  if (i < 0 || j < 0 || i >= g_TILES || j >= g_TILES) { return 0.0; }
  return select(0.0, 1.0, textureLoad(gIce, vec2<i32>(i, j), 0).x == 1u);
}
// the sim freezes whole tiles; between a frozen tile and an open one the ice edge wanders
fn g_iceAt(x: f32, z: f32) -> bool {
  let cu = g_tileC(x);
  let cv = g_tileC(z);
  let a = cu.y;
  let b = cv.y;
  let i = i32(cu.x);
  let j = i32(cv.x);
  let v = (g_ice(i, j) * (1.0 - a) + g_ice(i + 1, j) * a) * (1.0 - b) + (g_ice(i, j + 1) * (1.0 - a) + g_ice(i + 1, j + 1) * a) * b;
  return v > 0.5 + ${NOISE(40, 40, 77)} * 0.3;
}
fn g_iceTex(X: i32, Y: i32, x: f32, z: f32) -> u32 {
  if (abs(${NOISE(9, 9, 131)}) < 0.025 || abs(${NOISE(23, 17, 132)}) < 0.015) { return ${u("w5")}; }
  let v = 1.4 + ${FBM(30, 30, 133)} * 1.2 + select(0.0, 1.0, g_h2u(X >> 1u, Y, 134) < ${UT(0.05)});
  return g_ICE[g_dithIndex(v, X, Y, 3)];
}

// ---------- water (main.js groundAt's shore and depth, then paintWater) ----------
// PH + (x + z) / 25, less whole turns: the meters' whole part is divided exactly and turned back by a two-part 2 pi
fn g_lapAngle(x: f32, z: f32, frame: u32) -> f32 {
  let xb = floor(x);
  let zb = floor(z);
  let A = i32(xb) + i32(zb);
  let n = g_fdiv(A, 25);
  let f = (f32(A - n * 25) + (x - xb) + (z - zb)) / 25.0;
  let m = floor(f32(n) / 6.2831855);
  let r = (f32(n) - m * 6.28125) - m * 0.0019353071795864769;
  return f32(frame) / 8.0 * 6.2831855 + r + f;
}
fn g_water(x: f32, z: f32, X: i32, Y: i32, ctx: PaintCtx, mpp: f32, kind: u32, wet: f32, river: f32) -> u32 {
  var gx: f32;
  var gz: f32;
  var v0: f32;
  var depth = 1.5;
  var bed = false;
  if (kind == 3u) {
    gx = (g_riverSmooth(x + 3.0, z) - g_riverSmooth(x - 3.0, z)) / 6.0;
    gz = (g_riverSmooth(x, z + 3.0) - g_riverSmooth(x, z - 3.0)) / 6.0;
    v0 = river;
    // the channel is cut to the wettest season's width; this season's water runs down the middle of it, or not at all
    let st = g_streamAt(x, z);
    var q = 0.0;
    if (st.w > 0.0) { q = st.y * (st.z + (1.0 - st.z) * g_QUICK[ctx.season & 3u]); }
    bed = st.w == 0.0 || q < 0.004 || st.x > clamp(2.5 + 2.8 * sqrt(q), 2.5, 16.0) / 2.0;
  } else {
    gx = (waterAt(x + 3.0, z) - waterAt(x - 3.0, z)) / 6.0;
    gz = (waterAt(x, z + 3.0) - waterAt(x, z - 3.0)) / 6.0;
    v0 = wet;
    if (kind == 1u) { depth = max(0.0, -heightAt(x, z)); } else { depth = g_bil(${IL.water}, g_cellC(x), g_cellC(z)); }
  }
  let gl = length(vec2<f32>(gx, gz));
  let shore = select(60.0, (v0 - 0.5) / gl, gl > 1e-4);

  // a stream's bed where no water runs this season: gravel and cobbles the floods left
  if (bed) {
    if (h2(X, Y, 44) < 0.08 * ${FADE(0.4)}) { return ${u("d5")}; }
    return g_DI[g_toneIndex(3.6 + ${CL(0.8, 45, "0.45")} * 0.8, X, Y, 6)];
  }
  if (kind != 1u && g_iceAt(x, z)) { return g_iceTex(X, Y, x, z); }
  let px = shore * ctx.k;
  let lap = 0.5 + 0.18 * sin(g_lapAngle(x, z, ctx.frame));
  if (px < 1.2 * lap + 0.3) { return ${u("w7")}; }
  if (px < 2.2 * lap + 0.3 && g_h2u(X, Y, 45) < ${UT(0.45)}) { return ${u("w6")}; }
  var v: f32;
  var vf: i32;
  if (kind == 3u) {
    v = 4.2 + ${CL(1.5, 46)} * 0.6 + select(0.0, 0.5, shore < 1.5);
    vf = i32(floor(v));
  } else {
    // a narrow band of shallows along the shore in meters, then open water by depth
    let shallow = max((1.0 - g_smooth(0.0, 2.5, depth)) * 0.8, 1.0 - g_smooth(0.0, 12.0, shore)) * (0.6 + 0.4 * (1.0 - g_smooth(0.0, 9.0, depth)));
    let R = g_jround(${FBM(90, 90, 41)} * 1.5);
    let C = ${CL(3, 42, "0.5")};
    v = 1.4 + 3.9 * shallow + R * 0.4 + C * 0.5;
    // open water's tone is a sum of decimals that float64 leaves a hair under a whole number (1.4 - 0.4 is
    // 0.9999999999999999), so its ripples take main.js's whole part from a table, by the broad swell and the clusters
    vf = i32(floor(v));
    if (shallow == 0.0 && abs(R) <= 2.0) { vf = g_OPEN[i32(R + 2.0) * 3 + i32(C + 1.0)]; }
  }
  // ripple dashes, 2 or 3 px on every other row, and sparkles, each shown in some frames only
  if ((Y & 1) == 0) {
    let sx = X + (Y >> 1u) * 3;
    let cell = g_fdiv(sx, 6);
    let ru = g_h2u(cell, Y, 47);
    let r = g_hf(ru);
    let nearS = 1.0 - g_smooth(0.0, 40.0, shore);
    let rate = 0.012 + 0.1 * nearS + 0.03;
    let life = ((ctx.frame + (g_h2u(cell, Y, 48) >> 29u)) & 7u) < 5u;
    if (r < rate && sx - cell * 6 < 2 + g_odd97(ru) && life) {
      if (r < rate * 0.3) { return ${u("w7")}; }
      return g_WA[clamp(vf + 2, 0, 6)];
    }
  }
  if (g_h2u(X, Y, 43) < ${UT(0.0006)} && ((ctx.frame + (g_h2u(X, Y, 49) >> 29u)) & 7u) != 0u) { return ${u("w7")}; }
  return g_WA[g_toneIndex(v, X, Y, 8)];
}

// ---------- land ----------
// what groundAt holds for land that the colour needs
struct g_Land { c: array<f32, 6>, cls: u32, snowNow: f32, ex: f32, cx: vec2<f32>, cy: vec2<f32>, season: u32 }
const g_BARE_ROCK = array<vec3<f32>, 5>(${[[118, 104, 92], [176, 140, 96], [204, 196, 176], [164, 144, 138], [92, 88, 84]].map(rgb).join(", ")});
fn g_mixc(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> { return a + (b - a) * clamp(t, 0.0, 1.0); }
// main.js groundRGB: each cover share's paint, the generator's climate and soil, light, mottle and texture
fn g_rgb(L: g_Land, s: f32, x: f32, z: f32, m60: f32, mpp: f32) -> vec3<f32> {
  let hill = L.cls == 6u;
  let tr = L.c[1];
  let sh = L.c[2];
  let ma = L.c[3];
  let sa = L.c[5];
  let gr = L.c[0] + select(0.0, L.c[4] * 0.8, hill);
  let ba = L.c[4] * select(1.0, 0.2, hill);
  var sum = gr + tr + sh + ma + ba;
  if (sum == 0.0) { sum = 1.0; }
  let pet = g_bil(${IL.pet}, L.cx, L.cy);
  let bal = (g_bil(${IL.precip}, L.cx, L.cy) - pet) / max(1.0, pet);
  let lush = max(g_smooth(-0.3, 0.3, bal), exp(-g_bil(${IL.table}, L.cx, L.cy) / 2.5));
  let peat = g_bil(${IL.peat}, L.cx, L.cy);
  let soil = g_bil(${IL.soil}, L.cx, L.cy);
  let silt = g_bil(${IL.silt}, L.cx, L.cy);
  let fog = g_bil(${IL.fog}, L.cx, L.cy);
  let rock = i32(textureLoad(gIsle, vec2<i32>(clamp(g_roundC(L.cx), 0, g_N - 1), clamp(g_roundC(L.cy), 0, g_N - 1)), ${IL.rock}, 0).x);
  var grass: vec3<f32>;
  if (lush > 0.5) { grass = g_mixc(${rgb([98, 126, 60])}, ${rgb([56, 96, 48])}, (lush - 0.5) * 2.0); } else { grass = g_mixc(${rgb([160, 150, 90])}, ${rgb([98, 126, 60])}, lush * 2.0); }
  let marsh = g_mixc(${rgb([74, 94, 56])}, ${rgb([48, 50, 38])}, peat);
  var rockC = ${rgb([146, 136, 116])};
  if (rock >= 0 && rock < 5) { rockC = g_BARE_ROCK[rock]; }
  let bare = g_mixc(g_mixc(g_mixc(${rgb([146, 136, 116])}, rockC, 0.45), ${rgb([126, 98, 70])}, g_smooth(0.3, 1.5, soil) * 0.6), ${rgb([186, 168, 128])}, silt * 8.0);
  var heath = ${rgb([112, 86, 96])};
  if (L.season == 2u) { grass = g_mixc(grass, ${rgb([178, 138, 64])}, 0.45); heath = g_mixc(heath, ${rgb([140, 76, 60])}, 0.35); }
  else if (L.season == 3u) { grass = g_mixc(grass, ${rgb([150, 150, 142])}, 0.4); heath = g_mixc(heath, ${rgb([150, 150, 142])}, 0.3); }
  var c = (tr * ${rgb([38, 68, 44])} + sh * heath + gr * grass + ma * marsh + ba * bare) / sum;
  c = g_mixc(c, ${rgb([220, 202, 150])}, sa * 1.4);
  // wind-scoured ground goes tawny, foggy hollows grey-green
  c = g_mixc(c, ${rgb([152, 128, 84])}, g_smooth(0.3, 0.42, L.ex) * 0.35);
  c = g_mixc(c, ${rgb([140, 162, 152])}, fog * 0.3);
  c = g_mixc(c, ${rgb([236, 240, 244])}, L.snowNow * 0.75);
  // pigment gathers where one cover gives way to another: the gap between the two largest shares
  var m1 = gr;
  var m2 = -1e30;
  let rest = array<f32, 4>(tr, sh, ma, ba);
  for (var q = 0; q < 4; q++) {
    let w = rest[q];
    if (w > m1) { m2 = m1; m1 = w; } else if (w > m2) { m2 = w; }
  }
  let pool = max(0.0, 1.0 - ((m1 - m2) / sum) * 3.0) * 0.07;
  let mot = m60 * 0.05 + ${CL(6, 12, "0.4")} * 0.05 + ${CL(1.8, 13)} * 0.08 + ${CL(0.5, 14, "0.5")} * 0.11;
  var L0 = c.x * 0.3 + c.y * 0.59 + c.z * 0.11;
  if (L0 == 0.0) { L0 = 1.0; }
  let band = 112.0 * (1.0 + (L0 / 112.0 - 1.0) * 0.18);
  let k = ((1.0 + mot - pool) * band * clamp(1.0 + s * 0.3, 0.42, 1.6)) / L0;
  return vec3<f32>(c.x * k, c.y * k, c.z * k);
}
// bare earth: soil tones with grit and the odd pale stone
fn g_soil(x: f32, z: f32, s: f32, X: i32, Y: i32, mpp: f32) -> u32 {
  if (${NF(0.3, 0.3, 91, 0.3)} > 0.62) { return ${u("d5")}; }
  return g_DI[g_toneIndex(3.1 + s + ${CL(1.4, 92)} * 0.8 + ${CL(0.4, 93, "0.5")} * 0.8, X, Y, 6)];
}
// rock: broad planes picked by facing, fissures, cracks and grain, and snow in solid shapes
fn g_rock(x: f32, z: f32, s: f32, snow: f32, X: i32, Y: i32, mpp: f32) -> u32 {
  let plane = g_jround(${FBM(30, 30, 27)} * 1.4) * 0.5;
  let face = s * 1.1 + plane + 0.9;
  var snowV = -1.0;
  if (snow > 0.03) { snowV = ${FBM(20, 40, 29)} + snow * 3.0 - 0.6 + ${CL(2, 30)} * 0.05; }
  let lit = select(${u("snow")}, ${u("haze")}, face < -0.2);
  if (snowV > 0.04) { return lit; }
  if (snowV > -0.02) { return select(select(${u("r4")}, ${u("r2")}, face < -0.2), lit, bayer(X, Y) < (snowV + 0.02) / 0.06); }
  if (${NOISE(45, 45, 214)} > 0.3) {
    let fis = abs(${NOISE(12, 26, 211)});
    if (fis < 0.035 * ${FADE(3)}) { return select(${u("r1")}, ${u("r0")}, fis < 0.015); }
  }
  if (${NOISE(9, 9, 215)} > 0.35) {
    let cf = 0.04 * ${FADE(0.9)};
    if (cf > 0.0 && abs(${NOISE(2.5, 5.5, 210)}) < cf) { return ${u("r1")}; }
  }
  return g_RK[g_toneIndex(2.6 + face * 1.3 + ${CL(2.2, 212)} * 0.7 + ${CL(0.5, 213, "0.5")} * 0.8, X, Y, 6)];
}

// ---------- worn paths (main.js trailNear, trailDist, onTrail) ----------
// a worn cell's step, 0 to 4, in the texel's low bits; bit 7 marks a cell with a worn one within three (webgpu.js)
fn g_worn(a: i32, b: i32) -> u32 { return textureLoad(gTrail, vec2<i32>(a, b), 0).x & 7u; }
fn g_has(a: i32, b: i32) -> i32 { return select(0, 1, g_worn(a, b) != 0u); }
// whether a worn cell lies within three 3 m cells of the point's
fn g_trailNear(x: f32, z: f32) -> bool {
  let i = g_fdiv(i32(floor(x)) + g_HALFI, 3);
  let j = g_fdiv(i32(floor(z)) + g_HALFI, 3);
  if (i < 0 || j < 0 || i >= g_TN || j >= g_TN) { return false; }
  return (textureLoad(gTrail, vec2<i32>(i, j), 0).x & 128u) != 0u;
}
// a worn cell's jittered centre, from its corner, in meters
fn g_off(i: i32, j: i32, s: i32) -> f32 { return (0.5 + (h2(i, j, s) - 0.5) * 0.7) * 3.0; }
// main.js trailDist at the point Px + ox, Pz + oz meters from the island's corner (whole meters and a small rest, so
// every distance is taken between nearby numbers)
fn g_trailDist(Px: i32, ox: f32, Pz: i32, oz: f32) -> f32 {
  let wi = floor(ox);
  let wk = floor(oz);
  let P = Px + i32(wi);
  let Q = Pz + i32(wk);
  let pf = ox - wi;
  let qf = oz - wk;
  let i = g_fdiv(P, 3);
  let j = g_fdiv(Q, 3);
  // where three or four of the cells round a point are worn it is trodden ground
  let ci = i - select(0, 1, f32(P - 3 * i) + pf < 1.5);
  let cj = j - select(0, 1, f32(Q - 3 * j) + qf < 1.5);
  if (ci >= 0 && cj >= 0 && ci < g_TN - 1 && cj < g_TN - 1) {
    if (g_has(ci, cj) + g_has(ci + 1, cj) + g_has(ci, cj + 1) + g_has(ci + 1, cj + 1) >= 3) { return -0.3; }
  }
  var best = 1e30;
  for (var b = j - 1; b <= j + 1; b++) {
    for (var a = i - 1; a <= i + 1; a++) {
      if (a < 1 || b < 1 || a >= g_TN - 1 || b >= g_TN - 1) { continue; }
      let q = min(g_worn(a, b), 4u);
      if (q == 0u) { continue; }
      let oa = g_off(a, b, 521);
      let ob = g_off(a, b, 522);
      let px = f32(P - 3 * a) + pf - oa;
      let pz = f32(Q - 3 * b) + qf - ob;
      let hq = g_HALF[q];
      best = min(best, length(vec2<f32>(px, pz)) - hq);
      for (var db = -1; db <= 1; db++) {
        for (var da = -1; da <= 1; da++) {
          if (da == 0 && db == 0) { continue; }
          let q2 = min(g_worn(a + da, b + db), 4u);
          if (q2 == 0u) { continue; }
          let dx = f32(3 * da) + g_off(a + da, b + db, 521) - oa;
          let dz = f32(3 * db) + g_off(a + da, b + db, 522) - ob;
          let t = clamp((px * dx + pz * dz) / (dx * dx + dz * dz), 0.0, 1.0);
          best = min(best, length(vec2<f32>(px - dx * t, pz - dz * t)) - (hq + (g_HALF[q2] - hq) * t));
        }
      }
    }
  }
  return best;
}
// on a path: a rough edge up close; far out a dither in proportion to the share of the pixel the path covers
fn g_onTrail(x: f32, z: f32, mpp: f32, X: i32, Y: i32) -> bool {
  let xb = floor(x);
  let zb = floor(z);
  let ox = (x - xb) + ${FBM(9, 9, 523)} * 0.8;
  let oz = (z - zb) + ${FBM(9, 9, 524)} * 0.8;
  let d = g_trailDist(i32(xb) + g_HALFI, ox, i32(zb) + g_HALFI, oz);
  if (mpp < 1.0) { return d + ${NOISE(0.45, 0.45, 525)} * 0.18 * ${FADE(0.45)} < 0.0; }
  let r = mpp * 0.5;
  return d < r && bayer(X, Y) < min(1.0, 1.6 / mpp) * (1.0 - max(0.0, d) / r) * 1.5;
}

// main.js paintLand, with groundAt's land half (flora.ts groundClass) worked out first
fn g_land(x: f32, z: f32, X: i32, Y: i32, ctx: PaintCtx, mpp: f32, wet: f32, river: f32) -> u32 {
  let slope = g_gridAt(2, x, z);
  let cx = g_cellC(x);
  let cy = g_cellC(z);
  let ex = g_bil(${IL.exposure}, cx, cy);
  // biome edges wander in world meters
  let wx = x + ${FBM(40, 40, 64)} * 14.0;
  let wz = z + ${FBM(40, 40, 66)} * 14.0;
  var L: g_Land;
  // grass, tree, shrub, marsh, bare, sand
  let layer = array<i32, 6>(6, 4, 5, 7, 8, 9);
  let weight = array<f32, 6>(1.0, 1.05, 1.2, 1.5, 1.3, 1.6);
  var best = 0u;
  var bs = -1.0;
  for (var q = 0u; q < 6u; q++) {
    let c = g_fineAt(layer[q], wx, wz);
    L.c[q] = c;
    if (c * weight[q] > bs) { bs = c * weight[q]; best = q; }
  }
  // thin bare ground is grass with outcrops; so is bare ground that is gentle and sheltered
  let base = select(best, 6u, best == 4u && L.c[4] < 0.6);
  let bare = select(base, 6u, base == 4u && slope < 0.32 && ex < 0.36);
  // a face past 35 degrees is bare whatever grows round it; past 27 degrees open ground breaks into outcrops
  var cls = bare;
  if (slope > 0.7 && bare != 5u) { cls = 4u; } else if (slope > 0.5 && (bare == 0u || bare == 2u)) { cls = 6u; }
  var rocky = cls == 4u;
  if (cls == 6u) { rocky = ${FBM(45, 45, 26)} + L.c[4] * 0.8 + (slope - 0.5) * 2.0 - 0.8 > 0.0; }
  if (rocky) { cls = 7u; }
  L.cls = cls;
  L.ex = ex;
  L.cx = cx;
  L.cy = cy;
  L.season = ctx.season;
  L.snowNow = g_smooth(3.0, 30.0, g_bil(${IL.snow0} + i32(ctx.season & 3u), cx, cy));
  // the light main.js terrainLight leaves to the bake when the GPU lights slopes and hollows: the ridges' share
  let s = max(0.0, g_gridAt(1, x, z)) * 0.4;

  if ((ctx.flags & 1u) != 0u && g_trailNear(x, z) && g_onTrail(x, z, mpp, X, Y)) { return g_soil(x, z, s + 0.4, X, Y, mpp); }
  let mot = ${FBM(60, 60, 11)};
  if (cls == 7u) { return g_rock(x, z, s, 0.6 * L.snowNow, X, Y, mpp); }
  switch cls {
    case 1u: {
      // leaf litter in small drifts, a few twigs of dark soil, lit patches where the canopy opens
      let lit = ${CL(4, 3, "0.5")};
      let litter = ${CL(0.7, 4, "0.5")};
      if (litter > 0.0 && ${NF(0.35, 0.35, 5, 0.35)} > 0.3) { return ${u("d2")}; }
      let c = g_rgb(L, s, x, z, mot, mpp);
      let k = 1.0 + lit * 0.06;
      return g_dq(vec3<f32>(c.x * k, c.y * k, c.z * k), X, Y);
    }
    case 2u: { return g_dq(g_rgb(L, s, x, z, mot, mpp), X, Y); }
    case 5u: {
      var v = 2.5 + s * 0.7 + g_jround(mot * 2.0) * 0.3 + ${CL(0.4, 8, "0.55")} * 0.8;
      // ripples 3 m apart, fading out once they are narrower than a pixel; (0.6 x + 0.8 z) / 3 is (3 x + 4 z) / 15,
      // its whole meters divided exactly
      let rf = ${FADE(1.2)};
      if (rf > 0.0) {
        let xb = floor(x);
        let zb = floor(z);
        let A = 3 * i32(xb) + 4 * i32(zb);
        let n = g_fdiv(A, 15);
        let r = (f32(A - n * 15) + 3.0 * (x - xb) + 4.0 * (z - zb)) / 15.0 + ${FBM(24, 24, 61)} * 2.0;
        let f = r - floor(r);
        if (f < 0.13 * rf) { v -= 1.0; } else if (f < 0.22 * rf) { v += 0.6; }
      }
      if (wet > 0.2 || river > 0.2) { v -= 0.8; }
      return g_SA[g_toneIndex(v, X, Y, 5)];
    }
    case 3u: {
      // wet hollows gather where a broad wetness field is high, so they come in clusters with firmer ground between
      let pn = ${NOISE(37, 37, 31)} + 0.3 * ${NOISE(15, 15, 32)} + ${NOISE(110, 110, 33)} * 0.5;
      if (pn > 0.42) {
        if (pn > 0.5 && ${NF(1.6, 1.6, 36, 1.6)} > 0.35) { return select(${u("w0")}, ${u("w1")}, bayer(X, Y) < 0.3); }
        return g_MUD[g_toneIndex(1.8 + s * 0.6 + ${CL(1.2, 9, "0.5")} * 0.8 + ${CL(0.4, 37, "0.5")} * 0.6 - min(1.0, (pn - 0.42) * 6.0) * 0.8, X, Y, 4)];
      }
      // reed rims round the pools: short upright strokes, a meter long
      if (pn > 0.35) {
        if (${NF(0.5, 2.2, 34, 0.5)} > 0.1) { return ${u("m3")}; }
        return select(${u("m1")}, ${u("a1")}, ${CL(1.5, 35)} > 0.0);
      }
      return g_dq(g_rgb(L, s, x, z, mot, mpp), X, Y);
    }
    default: {
      // meadow: bare patches only where the generator's soil is thin
      let bareN = ${FBM(14, 14, 55)};
      if (bareN > 0.3 + L.c[0] * 0.15 + g_smooth(0.3, 1.2, g_bil(${IL.soil}, cx, cy)) * 0.4) { return g_soil(x, z, s + (bareN - 0.5) * 1.5, X, Y, mpp); }
      // under the woods edge the grass is strewn with leaf litter
      if (L.c[1] > 0.2 && ${CL(0.6, 15, "0.55 - (L.c[1] - 0.2) * 0.4")} > 0.0) { return ${u("d2")}; }
      return g_dq(g_rgb(L, s, x, z, mot, mpp), X, Y);
    }
  }
}

// main.js drawTerrainLive's colour for a ground pixel at world meters x, z and global art pixel X, Y
fn paintGround(x: f32, z: f32, X: i32, Y: i32, ctx: PaintCtx) -> u32 {
  let mpp = 1.0 / ctx.k;
  let wet = waterAt(x, z);
  let river = g_riverSmooth(x, z);
  if (wet > 0.5) { return g_water(x, z, X, Y, ctx, mpp, select(2u, 1u, heightAt(x, z) < 0.5), wet, river); }
  if (river > 0.5) { return g_water(x, z, X, Y, ctx, mpp, 3u, wet, river); }
  return g_land(x, z, X, Y, ctx, mpp, wet, river);
}

// main.js texWall(V, DIRTW, face, X, Y, depth, hpx, lev, true, 0) with V.lp = lp: an earth bank under a grass lip
fn bankColour(face: u32, X: i32, Y: i32, depth: f32, hpx: f32, lev: f32, lp: f32) -> u32 {
  let f = face != 0u;
  if (depth < 1.0) { return select(${u("g3")}, ${u("g2")}, f); }
  if (depth < 2.0 && g_h2u(X, 0, 73) < ${UT(0.5)}) { return select(${u("g2")}, ${u("g1")}, f); }
  if (g_h2u(X, Y, 78) < ${UT(0.035)}) { return select(${u("r3")}, ${u("r2")}, f); }
  let band = i32(floor((lev * lp) / 3.0 + h2(X >> 2u, 0, 76) * 0.6));
  let v = select(2.9, 1.8, f) + select(-0.25, 0.35, (band & 1) != 0) + (h2(X, Y, 77) - 0.5) * 0.6 - select(0.0, 1.0, hpx - depth < 1.0);
  return g_DI[g_dithIndex(v, X, Y, 6)];
}
`;
}
