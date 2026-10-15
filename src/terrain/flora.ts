// The island at a finer grain than the generator's cells, and everything that grows or lies on it: trees, shrubs,
// rocks, stones, fallen wood, mushrooms, herbs, reeds, ferns and flowers. The game makes a thing of every object
// listed here and the renderer draws the same list, so both read this one function.
import { CELL, N, TILE_CELLS } from "./grid";
import type { Island } from "./island";
import { DRIFTS, ROCKS, type Drift, type Rock } from "./geology";
import { WOODED, bankDepth, bankWidth, widthOf } from "./water";
import { NICHE, SHRUBS, TREES, TREE_MAX, draw, envAt, fit, lightFit } from "./niche";
import { SLA, pOf, through, thrive, yearComp } from "./growth";
import { COVER, coverClass } from "./ground";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Gradient noise, roughly -1..1, and a few octaves of it. Gradients come from a table of 4096 bearings.
const GX = new Float64Array(4096), GY = new Float64Array(4096);
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

export function fineGround(isle: Island): Fine {
  const LEN = M * M, Hc = isle.height, wetC = Float32Array.from(isle.water, (w) => (w > 0 ? 1 : 0));
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

  // Streams in world meters, drawn into a mask for carving and shading at their bankfull width, the bed they keep cut:
  // wider where trees or shrubs hold 5% or more of the ground the banks stand on (R556). Round-capped strokes a pixel
  // wider than the stream (antialiasing [design]), coverage stacked the way a canvas stacks one stroke over another;
  // beside it the depth the bed is cut to (R557), in centimeters.
  const rivers = isle.rivers.map((line) => line.map(([x, y, q, b, qbf, s, under]): FineRiver => {
    const wooded = bilinear(isle.tree, x, y) + bilinear(isle.shrub, x, y) >= WOODED;
    return [START + x * CELL, START + y * CELL, q, b, qbf, s, under, bankWidth(qbf, wooded), qbf > 0 ? bankDepth(qbf, s) : 0];
  }));
  const px = (x: number) => ((x + SIZE / 2) / SIZE) * RM;
  const mask = new Uint8Array(RM * RM), cov = new Float32Array(RM * RM), cut = new Uint8Array(RM * RM);
  for (const line of rivers)
    for (let k = 1; k < line.length; k++) {
      const half = ((((line[k - 1][7] + line[k][7]) / 2) * RM) / SIZE + 1) / 2, deep = Math.min(255, Math.round(((line[k - 1][8] + line[k][8]) / 2) * 100));
      const ax = px(line[k - 1][0]), ay = px(line[k - 1][1]), bx = px(line[k][0]), by = px(line[k][1]);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)), i1 = Math.min(RM - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)), j1 = Math.min(RM - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cx = i + 0.5, cy = j + 0.5, t = clamp(((cx - ax) * dx + (cy - ay) * dy) / l2, 0, 1);
          const a = clamp(half + 0.5 - Math.hypot(cx - ax - t * dx, cy - ay - t * dy), 0, 1);
          if (a > 0) { cov[j * RM + i] += a * (1 - cov[j * RM + i]); cut[j * RM + i] = Math.max(cut[j * RM + i], deep); }
        }
    }
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(cov[i] * 255);
  const texel = (x: number, z: number) => clamp(Math.floor(px(z)), 0, RM - 1) * RM + clamp(Math.floor(px(x)), 0, RM - 1);
  const riverAt = (x: number, z: number) => mask[texel(x, z)] / 255;

  // Heights come from a smooth cubic through the generator's cells, plus a little ground swell the cells are too
  // coarse to hold [design]. Streams cut their beds a bankfull depth down. Covers wander at their edges instead of
  // following the cell grid.
  const h = new Float32Array(LEN), wet = new Float32Array(LEN), river = new Float32Array(LEN), moist = new Float32Array(LEN);
  const cover = Object.fromEntries(COVERS.map((k) => [k, new Float32Array(LEN)])) as Record<Cover, Float32Array>;
  const src = COVERS.map((k) => isle[k]), dst = COVERS.map((k) => cover[k]), share = new Float32Array(COVERS.length);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, cx = u / K, cy = v / K, x = START + u * STEP, z = START + v * STEP;
      const base = bicubic(Hc, cx, cy), wf = bilinear(wetC, cx, cy), rv = riverAt(x, z);
      const swell = 2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2);
      h[i] = base + smooth(-2, 6, base) * (1 - wf) * swell - (rv * cut[texel(x, z)]) / 100;
      wet[i] = wf;
      river[i] = rv;
      moist[i] = bilinear(isle.moist, cx, cy);
      let sum = 0;
      for (let n = 0; n < COVERS.length; n++) {
        share[n] = Math.max(0, bilinear(src[n], cx, cy) * (1 + 0.85 * fbm(x / 150, z / 150, 40 + n, 2)));
        sum += share[n];
      }
      for (let n = 0; n < COVERS.length; n++) dst[n][i] = sum > 0 ? share[n] / sum : share[n];
    }
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
  return { h, wet, river, moist, cover, rivers, mask, at, bilinear, bicubic, fine, heightAt, slopeAt, riverAt, riverWidth, dry };
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

const F = Object.fromEntries(FLORA.map((k, i) => [k, i])) as Record<Flora, number>;
const S = Object.fromEntries(SPECIES.map((k, i) => [k, i])) as Record<Species, number>;
// ---------- stems (docs/research/plant-constants.md sec. 11) ----------
// A stem's diameter at breast height by its height, cm, and its height by its diameter: the stand-grown allometry
// fuel.ts cuts its trunks by (fire-constants sec. 19: BAAD fits for pine, oak and aspen, R98; iLand's crowded bound for
// ash, R97).
const DBH: Record<string, [a: number, b: number]> = { pine: [1.721, 0.842], oak: [0.489, 1.334], aspen: [0.343, 1.371], ash: [(100 / 290) ** 1.938, 1.938] };
export const dbhOf = (sp: string, h: number) => DBH[sp][0] * h ** DBH[sp][1];
export const heightOfDbh = (sp: string, d: number) => (d / DBH[sp][0]) ** (1 / DBH[sp][1]);
// The most stems a closed stand of quadratic mean diameter D (cm) holds, by Reineke's rule N = SDImax (25 / D)^b: Scots
// pine SDImax 890 a ha, b 1.593; oak 733, b 1.424 (del Río et al., R650; Pretzsch and Biber, R651). A stem's crown
// then holds 10^4 / N m2 of a closed stand at its own diameter, and stems whose shares sum to the ground close it, so
// the stand's SDI by summation is its tree cover times SDImax [derived].
const REINEKE: Record<string, [max: number, b: number]> = { pine: [890, 1.593], oak: [733, 1.424] };
// Crown width by diameter, K = a + b d (m, d in m), for ash and aspen (poplar's, aspen's nearest in Hemery et al.'s
// Table 1, R652), whose maximum stand density is not known: crowns as wide as that pack a closed stand [derived].
const HEMERY: Record<string, [a: number, b: number]> = { ash: [0.758, 20.357], aspen: [0.801, 18.95] };
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
const STAND: Record<string, [lo: number, hi: number]> = {
  pine: [10.8, 31.2], oak: [9.1, 32.3],
  ash: [0.248 * TREE_MAX.ash, 0.796 * TREE_MAX.ash], aspen: [0.248 * TREE_MAX.aspen, 0.796 * TREE_MAX.aspen],
};
export const standHeight = (sp: string, f: number) => STAND[sp][0] + (STAND[sp][1] - STAND[sp][0]) * clamp(f, 0, 1);
// Stems in a stand spread as a two-parameter Weibull in diameter, shape c 2 to 3.6 in normal to dense stands
// (Siipilehto and Mehtätalo, R653): 3.6, every stand here standing at its maximum density [design], scaled so the
// stems' quadratic mean diameter is the stand's.
const SHAPE = 3.6;
export const lnGamma = (z: number): number => {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z - 1 + i);
  const t = z - 1 + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z - 0.5) * Math.log(t) - t + Math.log(x);
};
const QUAD = Math.exp(lnGamma(1 + 2 / SHAPE) / 2);
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
const SHRUB_MOST = 0.99;
// The widest boulder, m: the clasts' power law's upper cutoff [gap] (src/gpu/deadwood.ts CLASTS).
export const BOULDER = 5.5;
// the plants that compete for each place, by layer and kind (the trees and shrubs niche.ts's)
const FUNGI = ["bolete", "chanterelle", "puffball"] as const satisfies readonly Species[];
const HERBS = ["yarrow", "sorrel", "mint"] as const satisfies readonly Species[];
const FERNS = ["bracken", "lady_fern"] as const satisfies readonly Species[];
const FLOWERS = ["buttercup", "daisy", "clover", "harebell", "poppy"] as const satisfies readonly Species[];
// all of them, each layer's in a run, as the scatter's table of fits holds them
const PLANTS: readonly Species[] = [...TREES, ...SHRUBS, ...FUNGI, ...HERBS, ...FERNS, ...FLOWERS];

// Conifers take the poor, sour ground; oak and aspen the middling; ash the rich, base-rich ground; each where the water
// table lets it. Shrubs thicken at the woods' edge, heather on the sourest ground. Rocks and stones break out where the
// ground is bare or steep and lie in stream beds; fallen wood, ferns and mushrooms fill the shade; flowers and herbs the
// open grass; reeds and clay the wet margins. Each quad draws from its own stream, so a quad's objects depend only on the
// seed.
export function scatter(isle: Island, g: Fine, seed: number): Scatter {
  let cap = 1 << 19, n = 0;
  let kind = new Uint8Array(cap), species = new Uint8Array(cap), pxs = new Float32Array(cap), pys = new Float32Array(cap), size = new Float32Array(cap), seeds = new Uint32Array(cap);
  const grow = () => {
    cap *= 2;
    const more = <T extends Uint8Array | Float32Array | Uint32Array>(a: T) => { const b = new (a.constructor as new (n: number) => T)(cap); b.set(a); return b; };
    kind = more(kind); species = more(species); pxs = more(pxs); pys = more(pys); size = more(size); seeds = more(seeds);
  };
  let s = 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let q = Math.imul(s ^ (s >>> 15), 1 | s);
    q = (q + Math.imul(q ^ (q >>> 7), 61 | q)) ^ q;
    return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
  };
  // Nothing lies under standing water or in a stream bed, where no one could reach it and nothing would draw it. A thing
  // stands where the game puts it, to a ten-thousandth of a tile, and it is checked there too. A quad with no standing
  // water in any cell waterAt reads for its points and no stream in any texel riverSmooth reads for them (clearAt, a
  // metre past its edges) passes both checks at every point, so its things skip them.
  const tileAt = (m: number) => Math.fround(Math.round(((m + SIZE / 2) / TILE_M) * 1e4) / 1e4), back = (t: number) => t * TILE_M - SIZE / 2;
  const ore: Scatter["ore"] = [];
  const clearAt = (x0: number, z0: number) => {
    const ci = (v: number) => Math.round((v - START) / CELL), i0 = ci(x0 - 1) - 1, i1 = ci(x0 + STEP + 1) + 1, j0 = ci(z0 - 1) - 1, j1 = ci(z0 + STEP + 1) + 1;
    if (i0 < -1 || j0 < -1 || i1 > N || j1 > N || ci(x0 - 1) < 0 || ci(z0 - 1) < 0 || ci(x0 + STEP + 1) >= N || ci(z0 + STEP + 1) >= N) return false;
    for (let b = Math.max(0, j0); b <= Math.min(N - 1, j1); b++) for (let a = Math.max(0, i0); a <= Math.min(N - 1, i1); a++) if (isle.water[b * N + a] > 0) return false;
    const t = SIZE / RM, ti = (v: number) => clamp(Math.floor((v + SIZE / 2) / t - 0.5), 0, RM - 1);
    for (let b = ti(z0 - 1); b <= Math.min(RM - 1, ti(z0 + STEP + 1) + 1); b++) for (let a = ti(x0 - 1); a <= Math.min(RM - 1, ti(x0 + STEP + 1) + 1); a++) if (g.mask[b * RM + a]) return false;
    return true;
  };
  let clear = false;
  // k: an index into FLORA, or -1 for a loose stone of ore
  const put = (k: number, sp: number, x: number, z: number, sz: number) => {
    if (!clear && (waterAt(isle, g, x, z) > 0.5 || riverSmooth(g, x, z) > 0.5)) return;
    const px = tileAt(x), py = tileAt(z);
    if (!clear && (waterAt(isle, g, back(px), back(py)) > 0.5 || riverSmooth(g, back(px), back(py)) > 0.5)) return;
    if (k < 0) { ore.push({ px, py, size: sz, seed: (r() * 4294967296) >>> 0 }); return; }
    if (n === cap) grow();
    kind[n] = k; species[n] = sp; pxs[n] = px; pys[n] = py; size[n] = sz; seeds[n] = (r() * 4294967296) >>> 0;
    n++;
  };
  const { h, wet, moist, river, cover, fine, heightAt, bilinear } = g;
  // a clear quad (clearAt) is dry at every point: no stream in reach and no standing water to stand above
  const dry = (x: number, z: number) => clear || g.dry(x, z);
  const cellOf = (v: number) => (v - START) / CELL;
  // Every plant's fit at every cell but for the light it gets (niche.ts), and for a green plant the share of the open
  // sky's sun it needs there to make what it burns over the year (growth.ts yearComp): the cell's sun, warmth and soil
  // water through the seasons, as well as the ground suits it. Worked out once and read between cells.
  const NS = PLANTS.length, table = new Float32Array(N * N * NS), comps = new Float32Array(N * N * NS), fits = new Float32Array(NS), comp = new Float32Array(NS);
  const seasons = isle.seasons.length, sun = new Float32Array(seasons), temp = new Float32Array(seasons), water = new Float32Array(seasons);
  for (let i = 0; i < N * N; i++) {
    if (isle.height[i] < -2) continue;
    const e = envAt(isle, bilinear, START + (i % N) * CELL, START + Math.floor(i / N) * CELL, NaN, START);
    for (let s = 0; s < seasons; s++) { sun[s] = isle.seasons[s].sun[i]; temp[s] = isle.seasons[s].temp[i]; water[s] = isle.soilWater[s][i]; }
    for (let k = 0; k < NS; k++) {
      const f = (table[i * NS + k] = fit(PLANTS[k], e)), sla = SLA[PLANTS[k]];
      comps[i * NS + k] = sla ? Math.min(2, yearComp(sla, sun, temp, water, f, pOf(PLANTS[k]))) : 0;
    }
  }
  const fitsAt = (x: number, z: number) => {
    const cx = clamp(cellOf(x), 0, N - 1.001), cy = clamp(cellOf(z), 0, N - 1.001), x1 = cx | 0, y1 = cy | 0, tx = cx - x1, ty = cy - y1, i = (y1 * N + x1) * NS;
    const between = (f: Float32Array, k: number) => (f[i + k] * (1 - tx) + f[i + NS + k] * tx) * (1 - ty) + (f[i + N * NS + k] * (1 - tx) + f[i + N * NS + NS + k] * tx) * ty;
    for (let k = 0; k < NS; k++) { fits[k] = between(table, k); comp[k] = between(comps, k); }
  };
  // the fits of one layer's plants (PLANTS[at] onward) in the light they get: a green plant by how far that light clears
  // its compensation point (growth.ts thrive), a fungus by its niche's light
  const layer = (at: number, names: readonly Species[], light: number, out: Float32Array) => {
    for (let k = 0; k < names.length; k++) out[k] = fits[at + k] * (SLA[names[k]] ? thrive(light, comp[at + k]) : lightFit(names[k], light));
    return out;
  };
  const treeF = new Float32Array(TREES.length), shrubF = new Float32Array(SHRUBS.length), lowF = new Float32Array(8);
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u, x0 = START + u * STEP, z0 = START + v * STEP;
      s = (hash(u, v, seed) * 4294967296) >>> 0;
      clear = clearAt(x0, z0);
      const spot = (): [number, number] => [x0 + r() * STEP, z0 + r() * STEP];
      const m = moist[i], tree = cover.tree[i], shrub = cover.shrub[i], grass = cover.grass[i], marsh = cover.marsh[i], sand = cover.sand[i];
      // The wet margins first: reeds stand in the shallows and on marsh, clay lies in the silt beside still or running water.
      if (h[i] > -0.5 && wet[i] < 0.8) {
        const edge = wet[i] > 0.05 || river[i] > 0.2 ? 1 : 0;
        for (let c = Math.floor(marsh * 1.1 + edge * (0.5 - sand * 0.4) + r()); c > 0; c--) {
          const [x, z] = spot();
          if (fine(wet, x, z) < 0.6 && heightAt(x, z) > 0.2) put(F.reeds, 0, x, z, 1 + r() * 1.5);
        }
        // clay where the ground is clayey: river and lake silt, and the soil of mudstone and basalt
        const silt = bilinear(isle.silt, cellOf(x0), cellOf(z0)), clayey = bilinear(isle.clayey, cellOf(x0), cellOf(z0));
        for (let c = Math.floor(Math.max(silt, 1.5 * ramp01(clayey - 0.2)) * (0.08 + 0.5 * edge) + r()); c > 0; c--) {
          const [x, z] = spot();
          if (fine(wet, x, z) < 0.4 && heightAt(x, z) > 0.4) put(F.clay, 0, x, z, 0.6 + r() * 1.4);
        }
      }
      if (wet[i] > 0.3 || h[i] < 0.8) continue;
      // What the quad's ground offers each plant, in the light that reaches its layer: trees stand in the open sky; what
      // grows under them in the open share of the quad and, in the rest, what one crown lets through (growth.ts through),
      // as the game has it.
      fitsAt(x0 + STEP / 2, z0 + STEP / 2);
      layer(0, TREES, 1, treeF);
      const under = 1 - tree + tree * through(1);
      layer(TREES.length, SHRUBS, under, shrubF);
      // none of a layer where none of its plants can keep itself
      const any = (f: Float32Array, n: number) => { for (let k = 0; k < n; k++) if (f[k] > 0) return true; return false; };
      // Stems, as many as their crowns fill the share of the quad their form covers (ground.ts): each one's kind drawn by
      // its fit there, its height drawn, and the ground its crown holds (crownShare) added up until it reaches the
      // room, the last stem laid with the chance of the room it has left. Trees close their share of the quad as a stand
      // at its maximum density, and never more than the quad holds closed but for a lone tree, as the GPU's stems crowd
      // (src/gpu/wgsl/stems.ts); bushes stand as a Boolean cover of their crowns, whose covered share is 1 - e^(-the
      // crowns' area over the ground's), so their crowns fill -ln(1 - shrub) of it [derived]. A stem whose spot turns
      // out wet, or for a tree bare of soil to root in (ground.ts soil), stands nowhere.
      const lay = (kind: number, names: readonly Species[], f: Float32Array, room: number, most: number, height: (sp: Species, f: number, r: number) => number) => {
        if (!any(f, names.length)) return;
        for (let used = 0; ; ) {
          const sp = draw(names, f, r()), h = toMm(height(sp, f[names.indexOf(sp)], r())), a = crownShare(sp, h), last = used + a > room;
          if (last && (r() * a >= room - used || (used > 0 && used + a > most))) return;
          used += a;
          const [x, z] = spot();
          if (dry(x, z) && (kind !== F.tree || bilinear(isle.soil, cellOf(x), cellOf(z)) > 0)) put(kind, S[sp], x, z, h);
          if (last) return;
        }
      };
      lay(F.tree, TREES, treeF, tree * STEP * STEP, STEP * STEP, treeHeight);
      lay(F.bush, SHRUBS, shrubF, -Math.log(1 - Math.min(shrub, SHRUB_MOST)) * STEP * STEP, Infinity, bushHeight);
      const edge = tree * (1 - tree) * 4;
      // Small plants come in patches some tens of meters across rather than evenly: 0 in the gaps, up to about 1.7.
      const patch = clamp(0.35 + 1.3 * noise(x0 / 45, z0 / 45, 91), 0, 1.7);
      // Boulders, stones, pebbles, sticks and fallen logs are pieces on the GPU, not laid here (src/gpu/deadwood.ts;
      // the clasts' counts are clasts below).
      // The low plants: as many as the best fitted of their kind would hold, each of a kind drawn by its fit.
      const low = <T extends Species>(names: readonly T[], base: number, make: (sp: T, f: number, x: number, z: number) => void) => {
        const f = layer(PLANTS.indexOf(names[0]), names, under, lowF), best = Math.max(...f.subarray(0, names.length));
        for (let c = best > 0 ? Math.floor(base * (0.2 + best) + r()) : 0; c > 0; c--) {
          const [x, z] = spot();
          if (!dry(x, z)) continue;
          const sp = draw(names, f, r());
          make(sp, f[names.indexOf(sp)], x, z);
        }
      };
      low(FUNGI, tree * m * 0.25 + grass * 0.03, (sp, _f, x, z) => put(F.mushroom, S[sp], x, z, 0.05 + r() * 0.15));
      low(HERBS, (grass * m * 0.25 + shrub * 0.06) * 3.5 * patch, (sp, _f, x, z) => put(F.herb, S[sp], x, z, 0.15 + r() * 0.4));
      low(FERNS, (tree * 0.5 + shrub * 0.15 + edge * 0.3) * m * (0.5 + patch), (sp, f, x, z) => put(F.fern, S[sp], x, z, (0.4 + r() * 0.9) * clamp(0.5 + f, 0.5, 1.2)));
      low(FLOWERS, (grass * (0.3 + m * 0.2) * (1 - tree) + marsh * 0.15 + edge * 0.1) * 3.5 * patch, (sp, _f, x, z) => put(F.flowers, S[sp], x, z, 0.2 + r() * 0.6));
      // Tussocks of tall grass, sized by width, stand across open meadow and along the woods' edge, thick in some patches and thin in others.
      for (let c = Math.floor((grass * (1 - tree) * 20 + edge * 3.75) * patch + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.grass, 0, x, z, 0.8 + r() * 1.7);
      }
      // Bog iron forms in bogs and wet meadows from the iron the groundwater brings up out of the till, a spade's depth
      // down (R533); how much of it there is to find is a gap (the old 0.04 a cell stands in).
      for (let c = Math.floor(marsh * 0.04 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (fine(wet, x, z) < 0.3) put(-1, 0, x, z, 0.15 + r() * 0.2);
      }
    }
  // Tile by tile, each tile's things in the order they were laid down.
  const T = TILES * TILES, start = new Int32Array(T + 1), tileOf = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const t = Math.min(TILES - 1, Math.floor(pys[k])) * TILES + Math.min(TILES - 1, Math.floor(pxs[k]));
    tileOf[k] = t; start[t + 1]++;
  }
  for (let t = 0; t < T; t++) start[t + 1] += start[t];
  const out: Scatter = { n, start, kind: new Uint8Array(n), species: new Uint8Array(n), px: new Float32Array(n), py: new Float32Array(n), size: new Float32Array(n), seed: new Uint32Array(n), ore };
  const fill = start.slice(0, T);
  for (let k = 0; k < n; k++) {
    const j = fill[tileOf[k]]++;
    out.kind[j] = kind[k]; out.species[j] = species[k]; out.px[j] = pxs[k]; out.py[j] = pys[k]; out.size[j] = size[k]; out.seed[j] = seeds[k];
  }
  return out;
}

const ramp01 = (v: number) => clamp(v / 0.3, 0, 1);

// ---------- clasts ----------
// How many boulders (2 dm and up), stones (1 to 2 dm) and pebbles (2 cm to 1 dm) lie in each of the generator's cells,
// the GPU's clasts (src/gpu/deadwood.ts CLASTS): boulders at its drift's count a ha (BOULDERS_HA there), the smaller
// classes as many times that as till's N(> d) ~ d^-2.9 has them, on the cell's ground out of standing water, each count
// a Poisson draw of the cell's own stream. Nothing lies on the sea or a lake's bed.
export function clasts(isle: Island, seed: number, perHa: readonly number[], dim: number, bounds: readonly (readonly [number, number])[]): Uint32Array[] {
  const out = bounds.map(() => new Uint32Array(N * N)), ha = (CELL * CELL) / 1e4, lo = bounds[bounds.length - 1][0];
  let s = 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let q = Math.imul(s ^ (s >>> 15), 1 | s);
    q = (q + Math.imul(q ^ (q >>> 7), 61 | q)) ^ q;
    return ((q ^ (q >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < N * N; i++) {
    if (isle.water[i] > 0 || isle.height[i] < 0) continue;
    const boulders = perHa[isle.drift[i]] * ha;
    if (!boulders) continue;
    s = (hash(i % N, Math.floor(i / N), seed ^ 0xc1a5) * 4294967296) >>> 0;
    bounds.forEach(([a, b], c) => { out[c][i] = poisson(boulders * ((a / lo) ** -dim - (b / lo) ** -dim), r); });
  }
  return out;
}
// Poisson(lam): by counting uniforms' products under e^-lam below 30, from there by Hormann's transformed rejection
// (PTRS, "The transformed rejection method for generating Poisson random variables", 1993).
function poisson(lam: number, r: () => number): number {
  if (lam < 30) {
    const L = Math.exp(-lam);
    let k = 0, p = r();
    while (p > L) { k++; p *= r(); }
    return k;
  }
  const sl = Math.sqrt(lam), ll = Math.log(lam), b = 0.931 + 2.53 * sl, a = -0.059 + 0.02483 * b, ia = 1.1239 + 1.1328 / (b - 3.4), vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const U = r() - 0.5, V = r(), us = 0.5 - Math.abs(U), k = Math.floor(((2 * a) / us + b) * U + lam + 0.43);
    if (us >= 0.07 && V <= vr) return k;
    if (k < 0 || (us < 0.013 && V > us)) continue;
    if (Math.log(V) + Math.log(ia) - Math.log(a / (us * us) + b) <= -lam + k * ll - lnGamma(k + 1)) return k;
  }
}
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
