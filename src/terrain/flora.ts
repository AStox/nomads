// The island at a finer grain than the generator's cells, and everything that grows or lies on it: trees, shrubs,
// rocks, stones, fallen wood, mushrooms, herbs, reeds, ferns and flowers. The game makes a thing of every object
// listed here and the renderer draws the same list, so both read this one function.
import { CELL, N, TILE_CELLS } from "./grid";
import type { Island } from "./island";

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

export type Fine = {
  h: Float32Array; wet: Float32Array; river: Float32Array; moist: Float32Array; cover: Record<Cover, Float32Array>;
  rivers: [number, number, number][][]; // streams in world meters, smoothed, each point carrying its discharge
  mask: Uint8Array; // RM x RM, 255 where a stream runs
  at: (f: Float32Array, i: number, j: number) => number;
  bilinear: (f: Float32Array, cx: number, cy: number) => number;
  bicubic: (f: Float32Array, cx: number, cy: number) => number;
  fine: (f: Float32Array, x: number, z: number) => number;
  heightAt: (x: number, z: number) => number;
  slopeAt: (x: number, z: number) => number;
  riverAt: (x: number, z: number) => number;
  riverWidth: (q: number) => number;
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

  // Streams, smoothed, in world meters, drawn into a mask for carving and shading. Round-capped strokes a pixel wider
  // than the stream, coverage antialiased and stacked the way a canvas stacks one stroke over another.
  type P = [number, number, number];
  const chaikin = (p: P[]): P[] => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25) as P, a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75) as P]), p.at(-1)!];
  const rivers = isle.rivers.map((line) => chaikin(chaikin(chaikin(line.map(([x, y, q]): P => [START + x * CELL, START + y * CELL, q])))));
  const riverWidth = (q: number) => clamp(2.5 + 2.8 * Math.sqrt(q), 2.5, 16);
  const px = (x: number) => ((x + SIZE / 2) / SIZE) * RM;
  const mask = new Uint8Array(RM * RM), cov = new Float32Array(RM * RM);
  for (const line of rivers)
    for (let k = 1; k < line.length; k++) {
      const half = ((riverWidth((line[k - 1][2] + line[k][2]) / 2) * RM) / SIZE + 1) / 2;
      const ax = px(line[k - 1][0]), ay = px(line[k - 1][1]), bx = px(line[k][0]), by = px(line[k][1]);
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - half - 1)), i1 = Math.min(RM - 1, Math.ceil(Math.max(ax, bx) + half + 1));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - half - 1)), j1 = Math.min(RM - 1, Math.ceil(Math.max(ay, by) + half + 1));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const cx = i + 0.5, cy = j + 0.5, t = clamp(((cx - ax) * dx + (cy - ay) * dy) / l2, 0, 1);
          const a = clamp(half + 0.5 - Math.hypot(cx - ax - t * dx, cy - ay - t * dy), 0, 1);
          if (a > 0) cov[j * RM + i] += a * (1 - cov[j * RM + i]);
        }
    }
  for (let i = 0; i < mask.length; i++) mask[i] = Math.round(cov[i] * 255);
  const riverAt = (x: number, z: number) => mask[clamp(Math.floor(px(z)), 0, RM - 1) * RM + clamp(Math.floor(px(x)), 0, RM - 1)] / 255;

  // Heights come from a smooth cubic through the generator's cells, plus a little ground swell the cells are too
  // coarse to hold. Streams cut their beds. Covers wander at their edges instead of following the cell grid.
  const h = new Float32Array(LEN), wet = new Float32Array(LEN), river = new Float32Array(LEN), moist = new Float32Array(LEN);
  const cover = Object.fromEntries(COVERS.map((k) => [k, new Float32Array(LEN)])) as Record<Cover, Float32Array>;
  const src = COVERS.map((k) => isle[k]), dst = COVERS.map((k) => cover[k]), share = new Float32Array(COVERS.length);
  for (let v = 0; v < M; v++)
    for (let u = 0; u < M; u++) {
      const i = v * M + u, cx = u / K, cy = v / K, x = START + u * STEP, z = START + v * STEP;
      const base = bicubic(Hc, cx, cy), wf = bilinear(wetC, cx, cy), rv = riverAt(x, z);
      const swell = 2.6 * fbm(x / 240, z / 240, 7, 3) + 0.8 * fbm(x / 60, z / 60, 8, 2);
      h[i] = base + smooth(-2, 6, base) * (1 - wf) * swell - rv * 1.8;
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
  const dry = (x: number, z: number) => fine(wet, x, z) < 0.15 && riverAt(x, z) < 0.25 && heightAt(x, z) > 0.8;
  return { h, wet, river, moist, cover, rivers, mask, at, bilinear, bicubic, fine, heightAt, slopeAt, riverAt, riverWidth, dry };
}

// Every object the ground holds. Kinds and species are indices into the tables below; 0 in SPECIES means none.
export const FLORA = ["tree", "bush", "boulder", "stone", "pebble", "stick", "fallen_log", "mushroom", "herb", "reeds", "fern", "flowers", "clay", "grass"] as const;
export type Flora = (typeof FLORA)[number];
export const SPECIES = [
  "", "pine", "oak", "ash", "aspen", "berry", "hazel", "heather", "gorse", "bolete", "chanterelle", "puffball",
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
const TALL = { pine: 17, oak: 15, ash: 16, aspen: 13 } as const;

// Conifers take cold, thin, windswept ground; oak the deep soils; ash the moist ones; aspen the wet edges. Shrubs
// thicken at the woods' edge, heather and gorse on exposed ground. Rocks and stones break out where the ground is bare
// or steep and lie in stream beds; fallen wood, ferns and mushrooms fill the shade; flowers and herbs the open grass;
// reeds and clay the wet margins. Each quad draws from its own stream, so a quad's objects depend only on the seed.
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
  // stands where the game puts it, to a ten-thousandth of a tile, and it is checked there too.
  const tileAt = (m: number) => Math.fround(Math.round(((m + SIZE / 2) / TILE_M) * 1e4) / 1e4), back = (t: number) => t * TILE_M - SIZE / 2;
  const ore: Scatter["ore"] = [];
  // k: an index into FLORA, or -1 for a loose stone of ore
  const put = (k: number, sp: number, x: number, z: number, sz: number) => {
    if (waterAt(isle, g, x, z) > 0.5 || riverSmooth(g, x, z) > 0.5) return;
    const px = tileAt(x), py = tileAt(z);
    if (waterAt(isle, g, back(px), back(py)) > 0.5 || riverSmooth(g, back(px), back(py)) > 0.5) return;
    if (k < 0) { ore.push({ px, py, size: sz, seed: (r() * 4294967296) >>> 0 }); return; }
    if (n === cap) grow();
    kind[n] = k; species[n] = sp; pxs[n] = px; pys[n] = py; size[n] = sz; seeds[n] = (r() * 4294967296) >>> 0;
    n++;
  };
  const { h, wet, moist, river, cover, fine, heightAt, slopeAt, dry, bilinear } = g;
  const cellOf = (v: number) => (v - START) / CELL;
  for (let v = 0; v < M - 1; v++)
    for (let u = 0; u < M - 1; u++) {
      const i = v * M + u, x0 = START + u * STEP, z0 = START + v * STEP;
      s = (hash(u, v, seed) * 4294967296) >>> 0;
      const spot = (): [number, number] => [x0 + r() * STEP, z0 + r() * STEP];
      const m = moist[i], tree = cover.tree[i], shrub = cover.shrub[i], grass = cover.grass[i], marsh = cover.marsh[i], bare = cover.bare[i], sand = cover.sand[i];
      // The wet margins first: reeds stand in the shallows and on marsh, clay lies in the silt beside still or running water.
      if (h[i] > -0.5 && wet[i] < 0.8) {
        const edge = wet[i] > 0.05 || river[i] > 0.2 ? 1 : 0;
        for (let c = Math.floor(marsh * 1.1 + edge * (0.5 - sand * 0.4) + r()); c > 0; c--) {
          const [x, z] = spot();
          if (fine(wet, x, z) < 0.6 && heightAt(x, z) > 0.2) put(F.reeds, 0, x, z, 1 + r() * 1.5);
        }
        const silt = bilinear(isle.silt, cellOf(x0), cellOf(z0));
        for (let c = Math.floor(silt * (0.08 + 0.5 * edge) + r()); c > 0; c--) {
          const [x, z] = spot();
          if (fine(wet, x, z) < 0.4 && heightAt(x, z) > 0.4) put(F.clay, 0, x, z, 0.6 + r() * 1.4);
        }
      }
      if (wet[i] > 0.3 || h[i] < 0.8) continue;
      const cx = cellOf(x0), cy = cellOf(z0), exposure = bilinear(isle.exposure, cx, cy), soil = Math.min(1.5, bilinear(isle.soil, cx, cy));
      const vigor = clamp(0.6 + m * 0.35 + soil * 0.2 - exposure * 0.4, 0.4, 1.2), slope = slopeAt(x0, z0);
      const pineAt = (x: number, z: number) => clamp(0.08 + (heightAt(x, z) - 80) / 320 + exposure * 0.8 - soil * 0.3 + (1 - m) * 0.3, 0.03, 0.97);
      for (let c = Math.floor(tree * 3.6 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (!dry(x, z) || slopeAt(x, z) > 0.7) continue;
        const pine = pineAt(x, z);
        const sp = r() < pine ? "pine" : m > 0.9 && r() < 0.45 ? "aspen" : soil > 0.9 && r() < 0.6 ? "oak" : "ash";
        put(F.tree, S[sp], x, z, TALL[sp] * vigor * (0.7 + r() * 0.55));
      }
      const edge = tree * (1 - tree) * 4;
      const heath = clamp(exposure * 1.4 + shrub - m * 0.3, 0, 1);
      for (let c = Math.floor((shrub * 5 + edge * 1.2) * 0.6 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (!dry(x, z)) continue;
        const tall = 0.8 + r() * 1.8, q = r();
        if (heath > 0.55) put(F.bush, q < 0.6 ? S.heather : S.gorse, x, z, q < 0.6 ? tall * 0.35 : tall * 0.8);
        else if (m > 0.35 && q < 0.55) put(F.bush, S.berry, x, z, tall * 0.75);
        else put(F.bush, S.hazel, x, z, tall * 1.5);
      }
      for (let c = Math.floor(bare * 1.6 + slope * 1.5 + r() * 0.8); c > 0; c--) {
        const [x, z] = spot();
        if (fine(wet, x, z) < 0.3) put(F.boulder, 0, x, z, 0.5 + r() ** 3 * 5);
      }
      // The small stuff, each where the ground would hold it.
      const rv = river[i];
      // Small plants come in patches some tens of meters across rather than evenly: 0 in the gaps, up to about 1.7.
      const patch = clamp(0.35 + 1.3 * noise(x0 / 45, z0 / 45, 91), 0, 1.7);
      for (let c = Math.floor(bare * 1.2 + sand * 0.3 + rv * 1.5 + slope * 0.6 + 0.1 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (fine(wet, x, z) < 0.3) put(F.stone, 0, x, z, 0.1 + r() ** 2 * 0.3);
      }
      for (let c = Math.floor(bare * 1.2 + sand * 1.0 + rv * 2 + 0.08 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (fine(wet, x, z) < 0.3) put(F.pebble, 0, x, z, 0.02 + r() * 0.06);
      }
      for (let c = Math.floor(tree * 0.7 + edge * 0.15 + 0.01 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.stick, 0, x, z, 0.4 + r() * 1.2);
      }
      for (let c = Math.floor(tree * 0.12 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z) && slopeAt(x, z) < 0.6) put(F.fallen_log, r() < pineAt(x, z) ? S.pine : r() < 0.5 ? S.oak : S.ash, x, z, 2 + r() * 7);
      }
      for (let c = Math.floor(tree * m * 0.25 + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.mushroom, m > 0.7 ? (r() < 0.5 ? S.chanterelle : S.bolete) : r() < 0.3 ? S.puffball : S.bolete, x, z, 0.05 + r() * 0.15);
      }
      for (let c = Math.floor((grass * m * 0.25 + shrub * 0.06) * 3.5 * patch + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.herb, m > 0.92 && r() < 0.5 ? S.mint : r() < 0.5 ? S.yarrow : S.sorrel, x, z, 0.15 + r() * 0.4);
      }
      for (let c = Math.floor((tree * 0.5 + shrub * 0.15 + edge * 0.3) * m * vigor * (0.5 + patch) + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.fern, m > 0.9 && r() < 0.6 ? S.lady_fern : S.bracken, x, z, (0.4 + r() * 0.9) * vigor);
      }
      for (let c = Math.floor((grass * (0.3 + m * 0.2) * (1 - tree) + marsh * 0.15 + edge * 0.1) * 3.5 * patch + r()); c > 0; c--) {
        const [x, z] = spot();
        if (!dry(x, z)) continue;
        const q = r();
        put(F.flowers, marsh > 0.3 && q < 0.4 ? S.buttercup : q < 0.3 ? S.daisy : q < 0.5 ? S.clover : q < 0.7 ? S.buttercup : q < 0.88 ? S.harebell : S.poppy, x, z, 0.2 + r() * 0.6);
      }
      // Tussocks of tall grass, sized by width, stand across open meadow and along the woods' edge, thick in some patches and thin in others.
      for (let c = Math.floor((grass * (1 - tree) * 20 + edge * 3.75) * patch + r()); c > 0; c--) {
        const [x, z] = spot();
        if (dry(x, z)) put(F.grass, 0, x, z, 0.8 + r() * 1.7);
      }
      // Weather wears reddish stones out of the bare rock.
      for (let c = Math.floor(bare * 0.012 + r()); c > 0; c--) {
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

// ---------- what a ground point is ----------
// One rule for the map and the inspector alike, from world data in meters only, so it is the same at every zoom.
// Water is the generator's standing water, with the lake's level reaching up the fine ground, and streams wider than the
// map's river mask shows them; land is the cover that wins, weighted, at a point whose edge wanders a little, with steep
// or exposed bare ground as rock.
export const GROUND = ["grassland", "forest floor", "scrub", "marsh", "bare ground", "sand", "grass with outcrops", "bare rock", "", "", "sea", "lake", "stream"] as const;
export const SEA = 10, LAKE = 11, RIVER = 12, ROCKY = 7, MEADOW = 0, SCRUB = 2, ROCK = 4, SAND = 5, HILL = 6;
const COV = ["grass", "tree", "shrub", "marsh", "bare", "sand"] as const, WEIGHT = [1.0, 1.05, 1.2, 1.5, 1.3, 1.6];
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
export type GroundPoint = { cls: number; water: number; wet: number; river: number; slope: number; cover: number[]; exposure: number };
// The class of the ground at world meters x, z: an index into GROUND. Water classes are SEA, LAKE and RIVER.
export function groundClass(isle: Island, g: Fine, x: number, z: number): GroundPoint {
  const wet = waterAt(isle, g, x, z), river = riverSmooth(g, x, z), slope = worldSlope(g, x, z);
  const exposure = g.bilinear(isle.exposure, (x - START) / CELL, (z - START) / CELL);
  const water = wet > 0.5 ? (g.heightAt(x, z) < 0.5 ? SEA : LAKE) : river > 0.5 ? RIVER : 0;
  // biome edges wander in world meters
  const wx = x + fbm(x / 40, z / 40, 64, 2) * 14, wz = z + fbm(x / 40, z / 40, 66, 2) * 14;
  const cover: number[] = [];
  let best = 0, bs = -1;
  for (let q = 0; q < 6; q++) { const c = g.fine(g.cover[COV[q]], wx, wz); cover.push(c); if (c * WEIGHT[q] > bs) { bs = c * WEIGHT[q]; best = q; } }
  if (water) return { cls: water, water, wet, river, slope, cover, exposure };
  // thin bare ground is grass with outcrops; so is bare ground that is gentle and sheltered
  const base = best === ROCK && cover[4] < 0.6 ? HILL : best;
  const bare = base === ROCK && slope < 0.32 && exposure < 0.36 ? HILL : base;
  // a face past 35 degrees is bare whatever grows round it; past 27 degrees open ground breaks into outcrops
  const cls = slope > 0.7 && bare !== SAND ? ROCK : slope > 0.5 && (bare === MEADOW || bare === SCRUB) ? HILL : bare;
  const rocky = cls === ROCK || (cls === HILL && fbm(x / 45, z / 45, 26, 2) + cover[4] * 0.8 + (slope - 0.5) * 2 - 0.8 > 0);
  return { cls: rocky ? ROCKY : cls, water, wet, river, slope, cover, exposure };
}
