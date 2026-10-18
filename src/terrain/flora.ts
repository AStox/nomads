// The island at a finer grain than the generator's cells, and everything that grows or lies on it: trees, shrubs,
// rocks, stones, fallen wood, mushrooms, herbs, reeds, ferns and flowers. The 3 m ground and every object on it are made
// by the GPU (src/gpu/terrain/scenery.ts, laws in src/gpu/wgsl/terrain-scenery.ts); this file holds what they are made
// of and what reads them: the Fine and Scatter types, the samplers over a Fine, the growth laws of a stem (size, crown,
// stand height), and the one rule for what a ground point is.
import { CELL, N, TILE_CELLS } from "./grid";
import type { Island } from "./island";
import { DRIFTS, ROCKS, type Drift, type Rock } from "./geology";
import { WOODED, bankDepth, bankWidth, widthOf } from "./water";
import { NICHE, SHRUBS, TREES, TREE_MAX } from "./niche";
import { COVER, coverClass } from "./ground";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Gradient noise, roughly -1..1, and a few octaves of it. Gradients come from a table of 4096 bearings.
export const GX = new Float64Array(4096), GY = new Float64Array(4096);
for (let k = 0; k < 4096; k++) { GX[k] = Math.cos((k / 4096) * 6.2831853); GY[k] = Math.sin((k / 4096) * 6.2831853); }
export function noise(x: number, y: number, s: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g0 = (hash(x0, y0, s) * 4096) | 0, g1 = (hash(x0 + 1, y0, s) * 4096) | 0, g2 = (hash(x0, y0 + 1, s) * 4096) | 0, g3 = (hash(x0 + 1, y0 + 1, s) * 4096) | 0;
  const a = GX[g0] * fx + GY[g0] * fy, b = GX[g1] * (fx - 1) + GY[g1] * fy, c = GX[g2] * fx + GY[g2] * (fy - 1), d = GX[g3] * (fx - 1) + GY[g3] * (fy - 1);
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.4;
}
export function fbm(x: number, y: number, s: number, octaves = 3) {
  let total = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) { total += noise(x * f, y * f, s + o * 31) * amp; f *= 2.03; amp *= 0.5; }
  return total;
}

export const COVERS = ["tree", "shrub", "grass", "marsh", "bare", "sand"] as const;
export type Cover = (typeof COVERS)[number];
// The fine grid puts four quads across every 75 m cell, with a vertex on every cell center.
export const K = 4, M = (N - 1) * K + 1, STEP = CELL / K, SIZE = N * CELL, START = CELL / 2 - SIZE / 2;
// The stream mask: a texel every 4.6875 m across the island.
export const RM = N * 16;
// Game tiles: their side in meters, and how many cross the island.
export const TILE_M = CELL * TILE_CELLS, TILES = N / TILE_CELLS;

// A point on a stream in world meters: x, z, mean discharge m³/s, the share of it from groundwater, bankfull discharge
// m³/s, slope m/m, the flow under its bed m³/s (water.ts River), and its bankfull width and depth, m.
export type FineRiver = [number, number, number, number, number, number, number, number, number];
export type Fine = {
  h: Float32Array; wet: Float32Array; river: Float32Array; moist: Float32Array; cover: Record<Cover, Float32Array>;
  rivers: FineRiver[][]; // streams in world meters as water.ts shapes them
  mask: Uint8Array; // RM x RM, 255 where a stream runs
  at: (f: Float32Array, i: number, j: number) => number;
  bilinear: (f: Float32Array, cx: number, cy: number) => number;
  bicubic: (f: Float32Array, cx: number, cy: number) => number;
  fine: (f: Float32Array, x: number, z: number) => number;
  heightAt: (x: number, z: number) => number;
  slopeAt: (x: number, z: number) => number;
  riverAt: (x: number, z: number) => number;
  riverWidth: (p: FineRiver) => number; // the width of a stream's mean flow at a point of its line, m
  dry: (x: number, z: number) => boolean;
};

// Streams in world meters: each line's points with the bankfull width and depth its flow cuts (water.ts bankWidth, wider
// where trees or shrubs hold 5% or more of the ground the banks stand on, R556; bankDepth, R557). The lines are list work
// placed against the lines before them (water.ts), so they stay here; the mask and the beds they cut are the GPU's.
export function fineRivers(isle: Pick<Island, "rivers" | "tree" | "shrub">): FineRiver[][] {
  const at = (f: Float32Array, i: number, j: number) => f[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  const bilinear = (f: Float32Array, cx: number, cy: number) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    return (at(f, x, y) * (1 - tx) + at(f, x + 1, y) * tx) * (1 - ty) + (at(f, x, y + 1) * (1 - tx) + at(f, x + 1, y + 1) * tx) * ty;
  };
  return isle.rivers.map((line) => line.map(([x, y, q, b, qbf, s, under]): FineRiver => {
    const wooded = bilinear(isle.tree, x, y) + bilinear(isle.shrub, x, y) >= WOODED;
    return [START + x * CELL, START + y * CELL, q, b, qbf, s, under, bankWidth(qbf, wooded), qbf > 0 ? bankDepth(qbf, s) : 0];
  }));
}

// What a Fine is made of: the 3 m field's own arrays, the generator's lines and the stream mask (scenery.ts makes them on
// the GPU).
export type FineParts = Pick<Fine, "h" | "wet" | "river" | "moist" | "cover" | "rivers" | "mask">;
// The samplers over those arrays: the generator's cells read between their centers, the fine grid read between its
// vertices, and what the sim and the page ask of a point (its height and slope, whether a stream runs there, whether it is
// dry).
export function fineView(isle: Pick<Island, "height" | "water">, parts: FineParts): Fine {
  const { h, rivers, mask } = parts;
  const at = (f: Float32Array, i: number, j: number) => f[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
  const bilinear = (f: Float32Array, cx: number, cy: number) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    return (at(f, x, y) * (1 - tx) + at(f, x + 1, y) * tx) * (1 - ty) + (at(f, x, y + 1) * (1 - tx) + at(f, x + 1, y + 1) * tx) * ty;
  };
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const bicubic = (f: Float32Array, cx: number, cy: number) => {
    const x = Math.floor(cx), y = Math.floor(cy), tx = cx - x, ty = cy - y;
    const row = (j: number) => cr(at(f, x - 1, j), at(f, x, j), at(f, x + 1, j), at(f, x + 2, j), tx);
    return cr(row(y - 1), row(y), row(y + 1), row(y + 2), ty);
  };
  const px = (x: number) => ((x + SIZE / 2) / SIZE) * RM;
  const texel = (x: number, z: number) => clamp(Math.floor(px(z)), 0, RM - 1) * RM + clamp(Math.floor(px(x)), 0, RM - 1);
  const riverAt = (x: number, z: number) => mask[texel(x, z)] / 255;
  const fine = (f: Float32Array, x: number, z: number) => {
    const fu = clamp((x - START) / STEP, 0, M - 1.001), fv = clamp((z - START) / STEP, 0, M - 1.001);
    const u = Math.floor(fu), v = Math.floor(fv), tu = fu - u, tv = fv - v, i = v * M + u;
    return (f[i] * (1 - tu) + f[i + 1] * tu) * (1 - tv) + (f[i + M] * (1 - tu) + f[i + M + 1] * tu) * tv;
  };
  const heightAt = (x: number, z: number) => fine(h, x, z);
  const slopeAt = (x: number, z: number) => Math.hypot(heightAt(x + 4, z) - heightAt(x - 4, z), heightAt(x, z + 4) - heightAt(x, z - 4)) / 8;
  // Dry ground: outside the stream's bank line (half the mask's coverage [design]) and above the year's high water on
  // the nearest lake or the sea, which stands 0.8 m over its level [gap]: the Baltic's yearly high at Rønne was not
  // read, and the old cut stands in.
  const dry = (x: number, z: number) => {
    if (riverAt(x, z) >= 0.5) return false;
    const i = Math.round((x - START) / CELL), j = Math.round((z - START) / CELL);
    let level = i < 0 || j < 0 || i >= N || j >= N ? 0 : -Infinity;
    for (let b = Math.max(0, j - 1); b <= Math.min(N - 1, j + 1); b++)
      for (let a = Math.max(0, i - 1); a <= Math.min(N - 1, i + 1); a++) { const k = b * N + a; if (isle.water[k] > 0) level = Math.max(level, isle.height[k] + isle.water[k]); }
    return heightAt(x, z) > level + 0.8;
  };
  const riverWidth = (p: FineRiver) => widthOf(p[2], p[4], p[7]);
  return { ...parts, at, bilinear, bicubic, fine, heightAt, slopeAt, riverAt, riverWidth, dry };
}

// Every object the ground holds. Kinds and species are indices into the tables below; 0 in SPECIES means none.
export const FLORA = ["tree", "bush", "boulder", "stone", "pebble", "stick", "fallen_log", "mushroom", "herb", "reeds", "fern", "flowers", "clay", "grass"] as const;
export type Flora = (typeof FLORA)[number];
export const SPECIES = [
  "", "pine", "oak", "ash", "aspen", "berry", "hazel", "heather", "bolete", "chanterelle", "puffball",
  "yarrow", "sorrel", "mint", "bracken", "lady_fern", "buttercup", "daisy", "clover", "harebell", "poppy",
] as const;
export type Species = (typeof SPECIES)[number];
// Everything that grows or lies on the ground, as the game takes it over: thing t{k + 1} is entry k. Entries run tile
// by tile, so start[t] .. start[t + 1] are the entries standing on tile t (row-major, TILES across). Loose stones of ore
// are listed apart: the game holds them as items from the start, the way it holds anything that can be picked up.
export type Scatter = {
  n: number;
  start: Int32Array; // TILES * TILES + 1
  kind: Uint8Array; species: Uint8Array;
  px: Float32Array; py: Float32Array; // where it stands, in game tiles from the island's north-west corner
  size: Float32Array; // meters: a tree's or shrub's height, a rock's width, a stick's or log's length, a patch's width
  seed: Uint32Array; // per-object variation, stable for the seed
  ore: { px: number; py: number; size: number; seed: number }[];
};

// ---------- stems (docs/research/plant-constants.md sec. 11) ----------
// A stem's diameter at breast height by its height, cm, and its height by its diameter: the stand-grown allometry
// fuel.ts cuts its trunks by (fire-constants sec. 19: BAAD fits for pine, oak and aspen, R98; iLand's crowded bound for
// ash, R97).
export const DBH: Record<string, [a: number, b: number]> = { pine: [1.721, 0.842], oak: [0.489, 1.334], aspen: [0.343, 1.371], ash: [(100 / 290) ** 1.938, 1.938] };
export const dbhOf = (sp: string, h: number) => DBH[sp][0] * h ** DBH[sp][1];
export const heightOfDbh = (sp: string, d: number) => (d / DBH[sp][0]) ** (1 / DBH[sp][1]);
// The most stems a closed stand of quadratic mean diameter D (cm) holds, by Reineke's rule N = SDImax (25 / D)^b: Scots
// pine SDImax 890 a ha, b 1.593; oak 733, b 1.424 (del Río et al., R650; Pretzsch and Biber, R651). A stem's crown
// then holds 10^4 / N m2 of a closed stand at its own diameter, and stems whose shares sum to the ground close it, so
// the stand's SDI by summation is its tree cover times SDImax [derived].
export const REINEKE: Record<string, [max: number, b: number]> = { pine: [890, 1.593], oak: [733, 1.424] };
// Crown width by diameter, K = a + b d (m, d in m), for ash and aspen (poplar's, aspen's nearest in Hemery et al.'s
// Table 1, R652), whose maximum stand density is not known: crowns as wide as that pack a closed stand [derived].
export const HEMERY: Record<string, [a: number, b: number]> = { ash: [0.758, 20.357], aspen: [0.801, 18.95] };
// The ground a stem's crown holds in a closed stand, m2, by its height: a tree's by its kind's maximum density or its
// crown width; a bush's crown a ball as wide as it is tall (fire-constants sec. 30) [derived].
export function crownShare(sp: string, h: number): number {
  const R = REINEKE[sp], K = HEMERY[sp];
  if (R) return (1e4 * (dbhOf(sp, h) / 25) ** R[1]) / R[0];
  if (K) { const k = K[0] + (K[1] * dbhOf(sp, h)) / 100; return (Math.PI * k * k) / 4; }
  return Math.PI * (h / 2) ** 2;
}
// A stand's quadratic mean height at a site, m. The generator lays old-growth stands with no age of their own, at the
// mean heights del Río et al. measured in stands about 72 years old across Europe (R650): Scots pine 10.8 to 31.2 m,
// oak 9.1 to 32.3, the niche's fit standing in for the site index across that span [design]. Ash and aspen take the
// same span as shares of their maximum heights, the mean of pine's and oak's (0.25 to 0.80) [gap: no stand heights read].
export const STAND: Record<string, [lo: number, hi: number]> = {
  pine: [10.8, 31.2], oak: [9.1, 32.3],
  ash: [0.248 * TREE_MAX.ash, 0.796 * TREE_MAX.ash], aspen: [0.248 * TREE_MAX.aspen, 0.796 * TREE_MAX.aspen],
};
export const standHeight = (sp: string, f: number) => STAND[sp][0] + (STAND[sp][1] - STAND[sp][0]) * clamp(f, 0, 1);
// Stems in a stand spread as a two-parameter Weibull in diameter, shape c 2 to 3.6 in normal to dense stands
// (Siipilehto and Mehtätalo, R653): 3.6, every stand here standing at its maximum density [design], scaled so the
// stems' quadratic mean diameter is the stand's.
export const SHAPE = 3.6;
export const lnGamma = (z: number): number => {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z - 1 + i);
  const t = z - 1 + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z - 0.5) * Math.log(t) - t + Math.log(x);
};
export const QUAD = Math.exp(lnGamma(1 + 2 / SHAPE) / 2);
// A tree's height, m: the stand's at the site (fit), the stem's diameter the Weibull's quantile r (0..1) of the
// stand's spread, and its height that diameter's, no taller than its kind grows.
export const treeHeight = (sp: string, f: number, r: number) =>
  Math.min(TREE_MAX[sp], heightOfDbh(sp, (dbhOf(sp, standHeight(sp, f)) / QUAD) * (-Math.log(1 - Math.min(r, 1 - 1e-12))) ** (1 / SHAPE)));
// A bush's height, m: its kind's (niche.ts tall) spread by how well it fits there and a draw [design: the old spread; a
// log-normal about tall is the replacement the generator notes name, its spread a gap].
export const bushHeight = (sp: string, f: number, r: number) => ((NICHE[sp].tall ?? 1) * clamp(0.4 + 0.8 * f, 0.4, 1.2) * (0.6 + r * 0.8)) / (1.2 * 1.4);
// Stems' sizes go down to the millimetre, as the GPU holds them (src/gpu/flora.ts).
export const toMm = (m: number) => Math.max(1, Math.round(m * 1000)) / 1000;
// The shrub share past which its crowns' Boolean cover can't be told from full, so no more are laid [design].
export const SHRUB_MOST = 0.99;
// The widest boulder, m: the clasts' power law's upper cutoff [gap] (src/gpu/deadwood.ts CLASTS).
export const BOULDER = 5.5;
// the plants that compete for each place, by layer and kind (the trees and shrubs niche.ts's)
export const FUNGI = ["bolete", "chanterelle", "puffball"] as const satisfies readonly Species[];
export const HERBS = ["yarrow", "sorrel", "mint"] as const satisfies readonly Species[];
export const FERNS = ["bracken", "lady_fern"] as const satisfies readonly Species[];
export const FLOWERS = ["buttercup", "daisy", "clover", "harebell", "poppy"] as const satisfies readonly Species[];
// all of them, each layer's in a run, as the scatter's table of fits holds them
export const PLANTS: readonly Species[] = [...TREES, ...SHRUBS, ...FUNGI, ...HERBS, ...FERNS, ...FLOWERS];

// The stream nearest world meters x, z within REACH meters (more than any bankfull half-width here), read off its line:
// how far off its middle the point lies and what flows there (mean m³/s, the share from groundwater, bankfull m³/s, the
// flow under its bed m³/s, and its bankfull width and depth, m), or null. Lines are binned once per island.
export type StreamPoint = { d: number; q: number; base: number; qbf: number; under: number; wbf: number; dbf: number };
const BIN = 50, REACH = 20, streamBins = new WeakMap<Fine, Map<number, [number, number][]>>();
export function streamAt(g: Fine, x: number, z: number): StreamPoint | null {
  let bins = streamBins.get(g);
  const key = (i: number, j: number) => j * 4096 + i, cell = (v: number) => Math.floor((v + SIZE / 2) / BIN);
  if (!bins) {
    bins = new Map();
    for (const [l, line] of g.rivers.entries())
      for (let k = 1; k < line.length; k++) {
        const [ax, az] = line[k - 1], [bx, bz] = line[k];
        for (let j = cell(Math.min(az, bz) - REACH); j <= cell(Math.max(az, bz) + REACH); j++)
          for (let i = cell(Math.min(ax, bx) - REACH); i <= cell(Math.max(ax, bx) + REACH); i++) {
            const list = bins.get(key(i, j));
            if (list) list.push([l, k]); else bins.set(key(i, j), [[l, k]]);
          }
      }
    streamBins.set(g, bins);
  }
  let best: StreamPoint | null = null;
  for (const [l, k] of bins.get(key(cell(x), cell(z))) ?? []) {
    const a = g.rivers[l][k - 1], b = g.rivers[l][k], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1e-9), 0, 1), d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
    const mix = (c: number) => a[c] + (b[c] - a[c]) * t;
    if (d <= REACH && (!best || d < best.d)) best = { d, q: mix(2), base: mix(3), qbf: mix(4), under: mix(6), wbf: mix(7), dbf: mix(8) };
  }
  return best;
}
// The bedrock under world meters x, z.
export const rockAt = (isle: Island, x: number, z: number): Rock => ROCKS[isle.rock[clamp(Math.round((z - START) / CELL), 0, N - 1) * N + clamp(Math.round((x - START) / CELL), 0, N - 1)]];
// What lies on the bedrock under world meters x, z.
export const driftAt = (isle: Island, x: number, z: number): Drift => DRIFTS[isle.drift[clamp(Math.round((z - START) / CELL), 0, N - 1) * N + clamp(Math.round((x - START) / CELL), 0, N - 1)]];

// ---------- what a ground point is ----------
// One rule for the map and the inspector alike, from world data in meters only, so it is the same at every zoom.
// Water is the generator's standing water, with the lake's level reaching up the fine ground, and streams wider than the
// map's river mask shows them; land is ground.ts coverClass of the covers at a point whose edge wanders a little.
export const GROUND = ["grassland", "forest floor", "scrub", "marsh", "bare ground", "sand", "grass with outcrops", "bare rock", "", "", "sea", "lake", "stream"] as const;
export const SEA = 10, LAKE = 11, RIVER = 12, ROCKY = 7;
// How much standing water covers a point, 0..1; over 0.5 is water.
export function waterAt(isle: Island, g: Fine, x: number, z: number) {
  const cx = (x - START) / CELL, cy = (z - START) / CELL, i = Math.round(cx), j = Math.round(cy);
  if (i < 0 || j < 0 || i >= N || j >= N) return 1;
  let lvl = -Infinity;
  for (let b = Math.max(0, j - 1); b <= Math.min(N - 1, j + 1); b++)
    for (let a = Math.max(0, i - 1); a <= Math.min(N - 1, i + 1); a++) { const k = b * N + a; if (isle.water[k] > 0) lvl = Math.max(lvl, isle.height[k] + isle.water[k]); }
  if (lvl === -Infinity) return 0;
  const x0 = clamp(Math.floor(cx), 0, N - 2), y0 = clamp(Math.floor(cy), 0, N - 2), tx = clamp(cx - x0, 0, 1), ty = clamp(cy - y0, 0, 1), k = y0 * N + x0;
  const bl = (f: (q: number) => number) => (f(k) * (1 - tx) + f(k + 1) * tx) * (1 - ty) + (f(k + N) * (1 - tx) + f(k + N + 1) * tx) * ty;
  const v = Math.min(0.5 + (lvl - g.heightAt(x, z)) / 2, 0.5 + (bl((q) => (isle.water[q] > 0 ? 1 : 0)) - 0.2) * 2);
  // the cubic through the cells rises above sea level here and there offshore; the sea cells keep that underwater
  return clamp(Math.max(v, bl((q) => (isle.water[q] > 0 && isle.height[q] < 0 ? 1 : 0)) - 0.1), 0, 1);
}
// The stream mask read between its texels, so a bank is a line rather than a staircase.
export function riverSmooth(g: Fine, x: number, z: number) {
  const t = SIZE / RM, fx = (x + SIZE / 2) / t - 0.5, fz = (z + SIZE / 2) / t - 0.5, i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j;
  const at = (ii: number, jj: number) => g.riverAt(-SIZE / 2 + (ii + 0.5) * t, -SIZE / 2 + (jj + 0.5) * t);
  return (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
}
// Ground slope, rise over run, on a fixed 12.5 m grid built once per island.
const slopeGrids = new WeakMap<Fine, Float32Array>();
export function worldSlope(g: Fine, x: number, z: number) {
  const S = 12.5, n = Math.ceil(SIZE / S) + 1;
  let s = slopeGrids.get(g);
  if (!s) {
    s = new Float32Array(n * n);
    const d = 18.75;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const X = -SIZE / 2 + i * S, Z = -SIZE / 2 + j * S;
        s[j * n + i] = Math.hypot(g.heightAt(X + d, Z) - g.heightAt(X - d, Z), g.heightAt(X, Z + d) - g.heightAt(X, Z - d)) / (2 * d);
      }
    slopeGrids.set(g, s);
  }
  const fx = clamp((x + SIZE / 2) / S, 0, n - 1.001), fz = clamp((z + SIZE / 2) / S, 0, n - 1.001), i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, k = j * n + i;
  return (s[k] * (1 - a) + s[k + 1] * a) * (1 - b) + (s[k + n] * (1 - a) + s[k + n + 1] * a) * b;
}
export type GroundPoint = { cls: number; water: number; wet: number; river: number; slope: number; cover: number[]; windShare: number };
// The class of the ground at world meters x, z: an index into GROUND. Water classes are SEA, LAKE and RIVER.
export function groundClass(isle: Island, g: Fine, x: number, z: number): GroundPoint {
  const wet = waterAt(isle, g, x, z), river = riverSmooth(g, x, z), slope = worldSlope(g, x, z);
  const cx = (x - START) / CELL, cy = (z - START) / CELL, windShare = g.bilinear(isle.windShare, cx, cy);
  const water = wet > 0.5 ? (g.heightAt(x, z) < 0.5 ? SEA : LAKE) : river > 0.5 ? RIVER : 0;
  // edges wander in world meters [design]
  const wx = x + fbm(x / 40, z / 40, 64, 2) * 14, wz = z + fbm(x / 40, z / 40, 66, 2) * 14;
  const cover = COVER.map((k) => g.fine(g.cover[k], wx, wz));
  if (water) return { cls: water, water, wet, river, slope, cover, windShare };
  return { cls: coverClass(cover, g.bilinear(isle.soil, cx, cy), slope), water, wet, river, slope, cover, windShare };
}
