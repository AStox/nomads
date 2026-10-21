// The `air` tile stage: the island's rain and the rest of its climate (src/gpu/terrain/{rain,climate}.ts) on a patch of the 75 m tier, fed by the planet's fields the way
// window.ts windowOf feeds a window, but each cell by its own place. Unit 5b: every stored word of a cell is a pure function of the cells within a stated reach of it, so the
// same cell has the same bytes under any tiling (air.test.ts proves it by running patches that overlap at other offsets and other halos). A tiling starts on a multiple of 4
// cells (the rain's coarse cells); a tile does.
//
// What a cell takes of its place:
//   sea-level air, the sea's surface and the air's water by season   the planet's at the cell (sampleCoarse); the sea's surface from the sea cells of tier 0 alone
//   wind direction                                                     the planet's year-mean wind at the cell (the rain's each season's), the roses keeping their shapes
//   the sun                                                            the cell's band of latitude (0.1 degree) in the compass's bearings, the cell's normal and horizons by its lattice's own metric
//   the rain's background                                              the planet's rain made mean-keeping at tier 0 (bgField), read between tier-0 centres
//   the far salt                                                       the planet's distance over land to the sea (a global field, seaDistance)
//   Bornholm's, kept [gap]                                             cloud, beam and glow through the cloud, humidity at sea level against saturation, the wet hours' humidity and rains,
//                                                                      fog, the pool of cold air's cooling, the snow years' weather and spread, the sea wind's speed
//
// Rain (R1800 to R1829). Smith and Barstad's transfer (R487) is linear in the relief, so the orographic part of a season's rain of a wind direction is a convolution of the
// coarse relief (the detail: the tier's height less the planet's tier-0 surface at the cell, in 4 by 4 means of 300 m) with a response. The response is the transfer's own, got once
// by the integer transform kernels (rain.ts) from a 1,024 m impulse in a domain a hundred coarse cells wide, truncated at RAIN_R coarse cells and kept as integers (rainTable);
// the kernel sums it directly (terrain-rain.ts rainConv). It is the planet's: per season and direction at the planet's land-mean wind and sea-level air (the delays are the
// atmosphere's, similarity.ts), and the cell's own gain follows its wind and warmth (the transfer's amplitude is its humid air's vapour times the wind): gain = Cw(t) U / Cw(tRef) U_ref.
// The truncation is the model's [design]: the response's waves decay slowly (90% of its energy lies within 15 coarse cells, 99% within 55), so the truncated sum differs from the
// untruncated by 3 to 10% of the waves' rms at 56 and 18 to 25% at 24 (notes).
// The rain of a cell is its background plus its orographic part less the mean of that part, cut at none, where the mean is read between the centres of the tier-0 blocks (a block is
// the 2^tier by 2^tier cells of one tier-0 cell (16 by 16 at tier 4); a constant to each would step at every edge); the cut adds rain where the part is large against the background, so a block's mean is then
// brought back to its background's by a scale at most 1, read between the blocks' centres (a block with no background keeps none). No cell's share of its tier-0 cell's rain is capped.
// Reach of a cell's rain: rainReach (the waves, then the means, the passes that make them smooth, the scale).
//
// Reach of every other stored word, cells of the lattice (the halo is AIR_HALO): temperature, humidity, pet: their own sun, pool, breeze and the planet's air (local) ->
// the sun 123 (a horizon sample 94.4 cells of 75 m out, a lattice step to 1.16 per metre and 1.13 of a cell's width); pool: the blurred ground 24 and the wind; breeze and wind
// share: the wake of a break, followed WAKE_REACH = 240 cells then ended [design: the wake curve ends at 30 heights; a break taller than 600 m is followed only that far, and
// the wind there is the open's past it]; salt: the spray's distance over land 240 (it is gone at 3 km), the far salt the global distance to the sea; snow years, snowpack, fog,
// sky: local after the sun and rain. Tier-0 fields are read at the cell, the nearest four centres: local.
import { SEASONS, SEASON_DAYS, H_W, LAPSE, ROSE, WET_ROSE, esat } from "../../terrain/climate";
import { CELL } from "../../terrain/grid";
import { eastNorth, haloSource, pointOf, tierGrid } from "./grid";
import { tierFile } from "./bakedir";
import { cloudDelays, rainConvolved, rainParams, rainWaves } from "../terrain/rain";
import { patchMeanWay, patchRose, runClimate, type PatchInput } from "../terrain/climate";
import { BAND_DEG } from "../wgsl/terrain-climate";
import type { RainFormat } from "../wgsl/terrain-rain";
import { readback } from "../kernel";
import type { Patch } from "./patch";
import type { Planet } from "./window";
import { sampleCoarse } from "./sample";
import { similarityOf } from "./similarity";
import type { Ctx, Field, TileStage } from "./stages";

const NS = SEASONS.length;
// The rain's reach, cells, for blocks of `block` cells (a tier-0 cell's children, 2^tier): the waves (radius coarse cells of 4, the cell's own coarse cell and its bilinear read: 4 radius + 8), the
// block means a cell's smooth mean reads (the blocks either side of its own: 2 block - 1 cells), each Jacobi pass of the means (a block more) and the scale that keeps a block's mean (the blocks either side again).
export const rainReach = (radius: number, passes: number, block: number) => 4 * radius + 8 + (2 * block - 1) + block * passes + (2 * block - 1);
// Passes that bring the smooth mean's own block means to the orographic part's [design: set from the error left, measured in the notes].
export const MEAN_PASSES = 1;
// The detail relief is reckoned at a sixteenth (the words of the transforms hold a coarse height to 2,047 m) and the waves read back at sixteen times by the gain [derived].
export const RAIN_DOWN = 16;
// The response is kept to this many coarse cells (300 m) from the impulse [design: set from the response's decay and the error it leaves, measured in the notes].
export const RAIN_R = 56;
// The block of tier 0 is 2^tier cells (16 at the 195.6 km planet's tier 4, 32 at tier 5), so the halo is the reach rounded up to 16 cells of that tier's lattice.
export const airHalo = (tier: number) => 16 * Math.ceil(rainReach(RAIN_R, MEAN_PASSES, 2 ** tier) / 16);
// The most rain a stored word holds in a season, mm [derived: the words downstream, Q16 in an i32, hold 32,767 mm].
export const WORD_MAX_MM = 32_000;

// ---------- the patch's place on the sphere ----------
export interface Geometry {
  lat: Float64Array; // degrees
  psi: Float64Array; // radians, the lattice's x axis counterclockwise from east, at each cell
  gm: Int32Array; // 4 a cell, Q16: the lattice's differences to (east, north) gradients (climate.ts PatchInput)
  skewDeg: Float64Array; // how far the lattice's y axis stands from a right angle to its x axis, degrees
}
// Each cell's lattice by its neighbours' unit vectors (the steps to x +- 1 and y +- 1, at the patch's edge the one step): the steps in metres along east and north, J, and from it
// the gradient map (J^-T times CELL) and the lattice offset of a compass step (J^-1 times the step).
export function geometryOf(patch: Patch, radius: number): Geometry {
  const g = tierGrid(patch.tier), S = patch.side, n = S * S, fn = g.fn, cells = fn * fn, pos = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const id = patch.ids[i], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn, p = pointOf(f, g.mid[X], g.mid[Y]);
    pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2];
  }
  const lat = new Float64Array(n), psi = new Float64Array(n), skewDeg = new Float64Array(n), gm = new Int32Array(4 * n);
  const DEG = Math.PI / 180;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x, xa = Math.max(0, x - 1), xb = Math.min(S - 1, x + 1), ya = Math.max(0, y - 1), yb = Math.min(S - 1, y + 1);
      const a = y * S + xa, b = y * S + xb, c = ya * S + x, d = yb * S + x, stepX = xb - xa, stepY = yb - ya;
      const p: [number, number, number] = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], [e, nn] = eastNorth(p);
      const tx = [0, 1, 2].map((m) => (pos[3 * b + m] - pos[3 * a + m]) / stepX), ty = [0, 1, 2].map((m) => (pos[3 * d + m] - pos[3 * c + m]) / stepY);
      const dot = (u: number[], v: readonly number[]) => (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * radius;
      const txe = dot(tx, e), txn = dot(tx, nn), tye = dot(ty, e), tyn = dot(ty, nn), det = txe * tyn - tye * txn;
      lat[i] = Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG;
      psi[i] = Math.atan2(txn, txe);
      skewDeg[i] = Math.acos(Math.max(-1, Math.min(1, (txe * tye + txn * tyn) / (Math.hypot(txe, txn) * Math.hypot(tye, tyn))))) / DEG - 90;
      gm[4 * i] = Math.round((CELL * tyn * 65536) / det); gm[4 * i + 1] = Math.round((-CELL * txn * 65536) / det);
      gm[4 * i + 2] = Math.round((-CELL * tye * 65536) / det); gm[4 * i + 3] = Math.round((CELL * txe * 65536) / det);
    }
  return { lat, psi, gm, skewDeg };
}

// ---------- the planet's fields, made once for a planet ----------
// The distance over land from each tier-0 cell to the nearest sea cell, m: Dijkstra over the cells' eight neighbours (across face edges) by the chord between their centres.
export function seaDistance(pl: Planet): Float32Array {
  const g = tierGrid(0), fn = g.fn, cells = fn * fn, total = 6 * cells, pos = new Float64Array(3 * total), dist = new Float64Array(total).fill(Infinity);
  for (let id = 0; id < total; id++) { const f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), p = pointOf(f, g.mid[r - Y * fn], g.mid[Y]); pos.set(p, 3 * id); }
  const cap = 8 * total, key = new Float64Array(cap), at = new Int32Array(cap);
  let size = 0;
  const push = (d: number, id: number) => {
    let i = size++;
    while (i > 0) { const up = (i - 1) >> 1; if (key[up] <= d) break; key[i] = key[up]; at[i] = at[up]; i = up; }
    key[i] = d; at[i] = id;
  };
  for (let id = 0; id < total; id++) if (pl.height[id] <= 0) { dist[id] = 0; push(0, id); }
  while (size > 0) {
    const d = key[0], id = at[0], dl = key[--size], il = at[size];
    for (let i = 0; ; ) { let c = 2 * i + 1; if (c >= size) { key[i] = dl; at[i] = il; break; } if (c + 1 < size && key[c + 1] < key[c]) c++; if (key[c] >= dl) { key[i] = dl; at[i] = il; break; } key[i] = key[c]; at[i] = at[c]; i = c; }
    if (d > dist[id]) continue;
    const f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const s = haloSource(g, f, X + dx, Y + dy);
        if (!s) continue;
        const j = (s.face * fn + s.Y) * fn + s.X, dot = pos[3 * id] * pos[3 * j] + pos[3 * id + 1] * pos[3 * j + 1] + pos[3 * id + 2] * pos[3 * j + 2], nd = d + pl.radius * Math.acos(Math.min(1, dot));
        if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
      }
  }
  return Float32Array.from(dist, (v) => (Number.isFinite(v) ? v : 1e6));
}

// A tier-0 field, changed least so that the tier-0 cells' own values are the means of what sampleCoarse gives their children (the 16 by 16 cells): the children's mean of the
// bilinear read is 1/8, 3/4, 1/8 of a cell and its neighbours along each axis [derived], so Q solves S Q = P0 for that operator, by Jacobi passes (the operator's symbol is at
// least a quarter, so the error falls by 3/4 a pass) held at none. A pure function of the planet's tier-0 field: the one background every tiling shares.
export const BG_PASSES = 50;
export function bgField(p0: Float32Array, nb: Int32Array): Float32Array {
  const n = p0.length;
  let q = Float64Array.from(p0), next = new Float64Array(n);
  for (let pass = 0; pass < BG_PASSES; pass++) {
    for (let b = 0; b < n; b++) {
      const o = 9 * b, v1 = q[nb[o + 1]], v3 = q[nb[o + 3]], v5 = q[nb[o + 5]], v7 = q[nb[o + 7]];
      // a cube's corner has no cell on the diagonal: the mean of the two beside it, as sampleCoarse takes it
      const v0 = nb[o] >= 0 ? q[nb[o]] : (v1 + v3) / 2, v2 = nb[o + 2] >= 0 ? q[nb[o + 2]] : (v1 + v5) / 2;
      const v6 = nb[o + 6] >= 0 ? q[nb[o + 6]] : (v3 + v7) / 2, v8 = nb[o + 8] >= 0 ? q[nb[o + 8]] : (v5 + v7) / 2;
      const s = 0.015625 * (v0 + v2 + v6 + v8) + 0.09375 * (v1 + v3 + v5 + v7) + 0.5625 * q[b];
      next[b] = Math.max(0, q[b] + p0[b] - s);
    }
    [q, next] = [next, q];
  }
  return Float32Array.from(q);
}

interface Base { q: Float32Array[]; dsea: Float32Array; uRef: number[]; tRef: number[]; table?: Promise<Int32Array> }
const bases = new WeakMap<object, Base>();
// The tier-0 cells' 3 by 3 neighbours (-1 at a cube's corner), by the cells' ids.
export function neighbours0(): Int32Array {
  const g = tierGrid(0), fn = g.fn, cells = fn * fn, out = new Int32Array(9 * 6 * cells).fill(-1);
  for (let f = 0; f < 6; f++)
    for (let Y = 0; Y < fn; Y++)
      for (let X = 0; X < fn; X++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) { const s = haloSource(g, f, X + dx, Y + dy); if (s) out[9 * ((f * fn + Y) * fn + X) + (dy + 1) * 3 + dx + 1] = (s.face * fn + s.Y) * fn + s.X; }
  return out;
}
// What the stage reads of a planet as a whole: each season's mean-keeping rain, the distance to the sea, and the land's mean wind (at least the atmosphere's 2 m/s gust) and
// sea-level air by season, which the response is made at [design: one set for the planet, not for a patch].
export function baseOf(planet: Planet): Base {
  let b = bases.get(planet);
  if (!b) {
    const nb = neighbours0(), land: number[] = [];
    for (let i = 0; i < planet.n; i++) if (planet.height[i] > 0) land.push(i);
    const mean = (f: (i: number) => number) => land.reduce((s, i) => s + f(i), 0) / Math.max(1, land.length);
    b = {
      q: planet.seasons.map((s) => bgField(s.rain, nb)), dsea: seaDistance(planet),
      uRef: planet.seasons.map((s) => mean((i) => Math.max(2, Math.hypot(s.windE[i], s.windN[i])))), tRef: planet.seasons.map((s) => mean((i) => s.t[i])),
    };
    bases.set(planet, b);
  }
  return b;
}

// The response, made by the transform kernels once for a planet: a 1,024 m impulse of one coarse cell in the middle of a domain of 128 by 128 coarse cells (a transform of 512, so
// the wrap is 150 km away), each (season, direction) of the batch; the table is its words from -RAIN_R to RAIN_R along each axis (BATCH x (2 RAIN_R + 1)^2, Q24 mm an hour).
export const TABLE_FMT = { n: 512, coarse: 4, wide: true } as const;
export async function rainTable(ctx: Ctx, radius = RAIN_R): Promise<Int32Array> {
  const b = baseOf(ctx.planet);
  if (radius !== RAIN_R) return responseOf(ctx, b, radius);
  b.table ??= responseOf(ctx, b, RAIN_R);
  return b.table;
}
export async function responseOf(ctx: Ctx, b: Base, radius: number): Promise<Int32Array> {
  const nc = TABLE_FMT.n / TABLE_FMT.coarse, c0 = nc / 2, W = 2 * radius + 1, s = similarityOf(ctx.planet.radius).s;
  const delays = b.tRef.map((t) => cloudDelays(Math.exp(-Math.max(0, t) / LAPSE / H_W), s));
  const seasons = SEASONS.map((c, k) => ({ t: b.tRef[k], mm: 0, rains: c.rains, rainWind: b.uRef[k], rainHumid: c.rainHumid, rose: patchRose(WET_ROSE) }));
  const z = new Int32Array(TABLE_FMT.n * TABLE_FMT.n);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) z[(c0 * 4 + y) * TABLE_FMT.n + c0 * 4 + x] = 1024 * 65536;
  const p = await rainWaves(ctx.gpu, TABLE_FMT, z, rainParams(patchRose(WET_ROSE), delays, seasons, TABLE_FMT));
  const tab = new Int32Array(64 * W * W);
  for (let sd = 0; sd < 64; sd++)
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) tab[sd * W * W + (dy + radius) * W + dx + radius] = p[sd * nc * nc + (c0 + dy) * nc + c0 + dx];
  return tab;
}

// ---------- the planet's fields at the patch ----------
export interface Sampled { surface: Float32Array; t: Float32Array[]; sst: Float32Array[]; rain: Float32Array[]; windE: Float32Array[]; windN: Float32Array[]; dsea: Float32Array }
// sampleCoarse's bilinear read, the same floats, with the four centres a cell reads rather than nine (a cell at a cube's corner whose four include a missing one is read by
// sampleCoarse itself): the patch reads some thirty fields of 800,000 cells.
export function sampleFast(tier: number, ids: ArrayLike<number>, fields: ArrayLike<number>[]): Float32Array[] {
  const g0 = tierGrid(0), n0 = g0.fn, fn = tierGrid(tier).fn, cells = fn * fn, B = 2 ** tier;
  const out = fields.map(() => new Float32Array(ids.length)), cache = new Map<number, Int32Array>();
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn, px = X >> tier, py = Y >> tier, pid = (f * n0 + py) * n0 + px;
    let around = cache.get(pid);
    if (!around) {
      around = new Int32Array(9);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const s = haloSource(g0, f, px + dx, py + dy); around[(dy + 1) * 3 + dx + 1] = s ? (s.face * n0 + s.Y) * n0 + s.X : -1; }
      if (cache.size > 4096) cache.clear();
      cache.set(pid, around);
    }
    const u = ((X & (B - 1)) + 0.5) / B, v = ((Y & (B - 1)) + 0.5) / B, ux = u < 0.5, vy = v < 0.5;
    const cx = ux ? 0 : 1, cy = vy ? 0 : 1, whx = ux ? u + 0.5 : u - 0.5, why = vy ? v + 0.5 : v - 0.5, wlx = 1 - whx, wly = 1 - why, c0 = cy * 3 + cx;
    const a = around[c0], b = around[c0 + 1], c = around[c0 + 3], d = around[c0 + 4];
    if (a < 0 || b < 0 || c < 0 || d < 0) { const one = sampleCoarse(tier, [id], fields); for (let m = 0; m < fields.length; m++) out[m][k] = one[m][0]; continue; }
    for (let m = 0; m < fields.length; m++) { const fm = fields[m]; out[m][k] = wly * (wlx * fm[a] + whx * fm[b]) + why * (wlx * fm[c] + whx * fm[d]); }
  }
  return out;
}
export function sampledOf(ctx: Ctx, patch: Patch): Sampled {
  const pl = ctx.planet, b = baseOf(pl), sea = Float32Array.from(pl.height, (h) => (h <= 0 ? 1 : 0));
  const s = sampleFast(patch.tier, patch.ids, [pl.height, ...pl.seasons.map((x) => x.t), ...pl.seasons.map((x) => x.sst), sea, ...b.q, ...pl.seasons.map((x) => x.windE), ...pl.seasons.map((x) => x.windN), b.dsea]);
  const at = (k: number) => s.slice(k, k + NS), shore = s[1 + 2 * NS];
  const sst = at(1 + NS).map((v, k) => Float32Array.from(v, (x, i) => (shore[i] > 1e-3 ? x / shore[i] : s[1 + k][i])));
  return { surface: s[0], t: at(1), sst, rain: at(2 + 2 * NS), windE: at(2 + 3 * NS), windN: at(2 + 4 * NS), dsea: s[2 + 5 * NS] };
}


// How far to turn the rose, in Q16 bearings (mod 16): the wind's direction in the patch's axes less the rose's own mean (climate.ts turned, in the patch's sense).
const TURN_MASK = 16 * 65536 - 1;
const turnWord = (e: number, n: number, psi: number) => Math.round(((Math.atan2(n, e) - psi - patchMeanWay(ROSE)) / (2 * Math.PI)) * DIRS16 * 65536) & TURN_MASK;
const DIRS16 = 16;

// ---------- the rain ----------
export interface RainTile { oro: Float32Array[]; precip: Float32Array[] }
// The rain of each season on the patch's cells, mm over the season.
export async function rainOf(ctx: Ctx, patch: Patch, height: Float32Array, geo: Geometry, planet: Sampled, radius = RAIN_R, meanPasses = MEAN_PASSES): Promise<RainTile> {
  const S = patch.side, n = S * S, fmt: RainFormat = { n: S, coarse: 4, cells: true, wide: true }, b = baseOf(ctx.planet);
  if ((patch.x0 - patch.halo) & 3 || (patch.y0 - patch.halo) & 3) throw new Error("air: a patch's first cell must lie on a multiple of 4 (the rain's coarse cells)");
  if (rainReach(radius, meanPasses, 2 ** patch.tier) > patch.halo) throw new Error(`air: a halo of ${patch.halo} cells is under the rain's reach of ${rainReach(radius, meanPasses, 2 ** patch.tier)}`);
  const zq = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const z = (Math.max(0, height[i]) - Math.max(0, planet.surface[i])) / RAIN_DOWN;
    if (Math.abs(z) > 2000) throw new Error(`air: a detail relief of ${(z * RAIN_DOWN).toFixed(0)} m is past what the transforms' words hold`);
    zq[i] = Math.round(z * 65536);
  }
  const s = similarityOf(ctx.planet.radius).s, delays = b.tRef.map((t) => cloudDelays(Math.exp(-Math.max(0, t) / LAPSE / H_W), s));
  const seasons = SEASONS.map((c, k) => ({ t: b.tRef[k], mm: 0, rains: c.rains, rainWind: b.uRef[k], rainHumid: c.rainHumid, rose: patchRose(WET_ROSE) }));
  const par = rainParams(patchRose(WET_ROSE), delays, seasons, fmt), cell = new Int32Array(3 * NS * n);
  for (let k = 0; k < NS; k++) {
    const hours = SEASON_DAYS * 24 * SEASONS[k].rains, ref = esat(b.tRef[k]) / (b.tRef[k] + 273.15);
    for (let i = 0; i < n; i++) {
      const t = planet.t[k][i], u = Math.max(2, Math.hypot(planet.windE[k][i], planet.windN[k][i]));
      cell[k * n + i] = Math.round((Math.max(0, planet.rain[k][i]) / hours) * 2 ** 20);
      cell[(NS + k) * n + i] = turnWord(planet.windE[k][i], planet.windN[k][i], geo.psi[i]);
      cell[(2 * NS + k) * n + i] = Math.round(RAIN_DOWN * ((esat(t) / (t + 273.15)) / ref) * (u / b.uRef[k]) * 65536);
    }
  }
  const words = await rainConvolved(ctx.gpu, fmt, radius, zq, par, await rainTable(ctx, radius), cell);
  // The blocks of tier 0 are the lattice's own 2^tier by 2^tier cells (a tier-0 cell's children, whichever the tiling and across a face's edge, where the lattice continues): a cell's
  // block is floor of its face position over 2^tier. The mean of the orographic part is read between the blocks' centres (a constant to each block would step at every edge), the means
  // first brought to a smooth field whose own block means they are by MEAN_PASSES Jacobi passes of the 1/8, 3/4, 1/8 stencil [derived: the children's mean of a bilinear read].
  const B = 2 ** patch.tier, X0 = patch.x0 - patch.halo, Y0 = patch.y0 - patch.halo, BX0 = Math.floor(X0 / B), BY0 = Math.floor(Y0 / B), nbx = Math.floor((X0 + S - 1) / B) - BX0 + 1, nby = Math.floor((Y0 + S - 1) / B) - BY0 + 1;
  const bx = Int32Array.from({ length: S }, (_, x) => Math.floor((X0 + x) / B) - BX0), by = Int32Array.from({ length: S }, (_, y) => Math.floor((Y0 + y) / B) - BY0);
  // the bilinear read between centres: the cell's left block, and the share of the right one (held at the outermost centre beyond the patch's)
  const lerp = (X: number, B0: number, nb: number) => Array.from({ length: S }, (_, x) => { const u = (X + x - (B - 1) / 2) / B, bl = Math.floor(u); let i0 = bl - B0, t = u - bl; if (i0 < 0) { i0 = 0; t = 0; } if (i0 > nb - 2) { i0 = nb - 2; t = 1; } return [i0, t] as const; });
  const lx = lerp(X0, BX0, nbx), ly = lerp(Y0, BY0, nby);
  const count = new Float64Array(nbx * nby);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) count[by[y] * nbx + bx[x]]++;
  const oro = [] as Float32Array[], precip = [] as Float32Array[];
  for (let k = 0; k < NS; k++) {
    const sum = new Float64Array(nbx * nby), w = words.subarray(k * n, (k + 1) * n), fin = new Float32Array(n), o = new Float32Array(n);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) sum[by[y] * nbx + bx[x]] += w[y * S + x];
    const m = Float64Array.from(sum, (v, b) => v / count[b] / 65536);
    let mu = Float64Array.from(m), next = new Float64Array(m.length);
    const at = (a: Float64Array, ix: number, iy: number) => a[Math.min(nby - 1, Math.max(0, iy)) * nbx + Math.min(nbx - 1, Math.max(0, ix))];
    for (let pass = 0; pass < meanPasses; pass++) {
      for (let iy = 0; iy < nby; iy++)
        for (let ix = 0; ix < nbx; ix++) {
          const s = 0.015625 * (at(mu, ix - 1, iy - 1) + at(mu, ix + 1, iy - 1) + at(mu, ix - 1, iy + 1) + at(mu, ix + 1, iy + 1)) + 0.09375 * (at(mu, ix, iy - 1) + at(mu, ix - 1, iy) + at(mu, ix + 1, iy) + at(mu, ix, iy + 1)) + 0.5625 * mu[iy * nbx + ix];
          next[iy * nbx + ix] = mu[iy * nbx + ix] + m[iy * nbx + ix] - s;
        }
      [mu, next] = [next, mu];
    }
    // the rain with the smooth mean of the orographic part taken out and cut at none; the cut adds rain where the part is large against the background (and none is the planet's
    // where its background is none), so each block's mean is brought back to its background's by a scale at most 1 (the mean of the cut rain is at least the mean it was cut from),
    // read between the blocks' centres like the mean: no division by less than its numerator, and no step at a block's edge
    const pos = new Float64Array(n), cut = new Float64Array(nbx * nby), bgSum = new Float64Array(nbx * nby);
    for (let y = 0; y < S; y++) {
      const [j0, ty] = ly[y];
      for (let x = 0; x < S; x++) {
        const [i0, tx] = lx[x], a = mu[j0 * nbx + i0], b2 = mu[j0 * nbx + i0 + 1], c = mu[(j0 + 1) * nbx + i0], d = mu[(j0 + 1) * nbx + i0 + 1];
        const around = (1 - ty) * ((1 - tx) * a + tx * b2) + ty * ((1 - tx) * c + tx * d), i = y * S + x;
        o[i] = w[i] / 65536;
        pos[i] = Math.max(0, planet.rain[k][i] + (w[i] / 65536 - around));
        cut[by[y] * nbx + bx[x]] += pos[i]; bgSum[by[y] * nbx + bx[x]] += planet.rain[k][i];
      }
    }
    const lam = Float64Array.from(cut, (c, b) => (c > 0 ? bgSum[b] / c : 1));
    for (let y = 0; y < S; y++) {
      const [j0, ty] = ly[y];
      for (let x = 0; x < S; x++) {
        const [i0, tx] = lx[x], a = lam[j0 * nbx + i0], b2 = lam[j0 * nbx + i0 + 1], c = lam[(j0 + 1) * nbx + i0], d = lam[(j0 + 1) * nbx + i0 + 1];
        fin[y * S + x] = pos[y * S + x] * ((1 - ty) * ((1 - tx) * a + tx * b2) + ty * ((1 - tx) * c + tx * d));
      }
    }
    oro.push(o); precip.push(fin);
  }
  return { oro, precip };
}

// ---------- the climate ----------
export interface AirTile {
  precip: Float32Array[]; pet: Float32Array[]; sun: Float32Array[]; temp: Float32Array[]; humid: Float32Array[]; // by season, patch cell order
  snowCover: Float32Array; // the year's share of the ground under snow
  // not stored (the sim's own, made again for its play area)
  snow: Float32Array; snowpack: Float32Array[]; fog: Float32Array; sky: Float32Array; pool: Float32Array; breeze: Float32Array; windShare: Float32Array; salt: Float32Array; lee: Uint8Array;
  saturated: number; // words the stored units could not hold
}

// The patch's air from its heights (1/256 m) and flooded surface (1/256 m).
export async function airOf(ctx: Ctx, patch: Patch, heightWords: Int32Array, floodedWords: Int32Array, geoIn?: Geometry, sampledIn?: Sampled): Promise<AirTile> {
  const S = patch.side, n = S * S;
  if ((patch.x0 - patch.halo) & 3 || (patch.y0 - patch.halo) & 3) throw new Error("air: a patch's first cell must lie on a multiple of 4");
  const geo = geoIn ?? geometryOf(patch, ctx.planet.radius), planet = sampledIn ?? sampledOf(ctx, patch);
  const height = Float32Array.from(heightWords, (h) => h / 256), open = Uint8Array.from(heightWords, (h, i) => (h <= 0 || floodedWords[i] - h >= 3 ? 1 : 0));
  const rain = await rainOf(ctx, patch, height, geo, planet);

  const q16 = (v: number) => Math.round(v * 65536);
  const tS = planet.t.map((v) => Int32Array.from(v, q16)), seaS = planet.sst.map((v) => Int32Array.from(v, q16));
  const e0S = planet.t.map((v, k) => Int32Array.from(v, (t) => q16(SEASONS[k].humid0 * esat(t))));
  const wturn = new Int32Array(n), band = new Int32Array(n), dsea = new Int32Array(n);
  const bandAt = Int32Array.from(geo.lat, (l) => Math.round(l / BAND_DEG)), first = bandAt.reduce((a, b) => Math.min(a, b), 1e9), last = bandAt.reduce((a, b) => Math.max(a, b), -1e9);
  const limit = 89.95;
  const bandsDeg = Array.from({ length: last - first + 1 }, (_, k) => Math.max(-limit, Math.min(limit, (first + k) * BAND_DEG)));
  for (let i = 0; i < n; i++) {
    let e = 0, nn = 0;
    for (let k = 0; k < NS; k++) { e += planet.windE[k][i]; nn += planet.windN[k][i]; }
    wturn[i] = turnWord(e, nn, geo.psi[i]);
    band[i] = bandAt[i] - first;
    dsea[i] = open[i] ? 0 : Math.round(Math.min(5e5, planet.dsea[i]) * 4096);
  }
  // the snow years' groups: a game tile's four cells of the planet (the cells that share a tile of tier 3), whichever way the patch lays them
  const fn = tierGrid(patch.tier).fn, cells = fn * fn, half = fn / 2, slot = new Map<number, number>(), groups: number[] = [];
  for (let i = 0; i < n; i++) {
    if (patch.missing[i]) continue;
    const id = patch.ids[i], f = Math.floor(id / cells), r = id - f * cells, key = (f * half + (Math.floor(r / fn) >> 1)) * half + ((r & (fn - 1)) >> 1);
    let g = slot.get(key);
    if (g === undefined) { slot.set(key, (g = slot.size)); groups.push(-1, -1, -1, -1); }
    for (let c = 0; c < 4; c++) if (groups[4 * g + c] < 0) { groups[4 * g + c] = i; break; }
  }
  const grp = new Int32Array(4 * (S / 2 + 2) ** 2).fill(-1);
  grp.set(groups);
  const input: PatchInput = { tS, seaS, e0S, wturn, band, gm: geo.gm, dsea, bandsDeg, groups: grp, rose: patchRose(ROSE) };
  const arena = runClimate(ctx.gpu, { height, open, precip: rain.precip, angle: 0, patch: input }), { SEC } = arena.layout;
  const words = new Int32Array(await readback(ctx.gpu, arena.words, (SEC.z - SEC.windShare) * 4, SEC.windShare * 4));
  arena.destroy();
  const field = (name: string, scale: number, which = 0) => { const o = SEC[name] - SEC.windShare + which * n, f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = words[o + i] / scale; return f; };
  const four = (name: string, scale: number) => Array.from({ length: NS }, (_, k) => field(name, scale, k));
  return {
    precip: rain.precip, pet: four("petS", 65536), sun: four("sunS", 2 ** 24), temp: four("tempS", 65536), humid: four("humidS", 65536), snowCover: field("snowCover", 65536),
    snow: field("snow", 65536), snowpack: four("snowpack", 65536), fog: field("fog", 2 ** 24), sky: field("sky", 65536), pool: field("pool", 65536), breeze: field("breeze", 65536),
    windShare: field("windShare", 65536), salt: field("salt", 65536), lee: new Uint8Array(words.buffer, (SEC.lee - SEC.windShare) * 4, n * 16).slice(), saturated: 0,
  };
}

// ---------- the stage ----------
const seasonal = (tier: number, stem: string, type: string) => Array.from({ length: NS }, (_, k) => tierFile(tier, `${stem}${k}.${type}`));
export const airOut = (tier: number) => ({
  pr: seasonal(tier, "pr", "u16"), pe: seasonal(tier, "pe", "u16"), sun: seasonal(tier, "sun", "u16"), tmp: seasonal(tier, "tmp", "i16"), hum: seasonal(tier, "hum", "u8"),
  snow: tierFile(tier, "snow.u8"), wsh: tierFile(tier, "wsh.u8"), fog: tierFile(tier, "fog.u8"), snp: seasonal(tier, "snp", "u16"),
});
export const airOutputs = (tier: number) => { const o = airOut(tier); return [...o.pr, ...o.pe, ...o.sun, ...o.tmp, ...o.hum, o.snow, o.wsh, o.fog, ...o.snp]; };
// The units of the stored words.
// snp: the season's mean snowpack in 1/2 mm of water, held at 32.8 m (65,535): the kernel's pack is Q16 mm in a word, 32.8 m, and holds there (a cold range's packs reach 18 m as a season's mean over ten years)
export const AIR_UNIT = { pe: 10, sun: 1024, tmp: 256, hum: 255, snow: 255, wsh: 255, fog: 255, snp: 2 };

// The stored word of a season's rain: the square root of the mm times 360 (u16), so that 0.006 mm is held at a millimetre and 0.35 mm at the most a cell can hold
// (32,000 mm), a linear 0.1 mm word saturating at 6,553 where the planet's own tier-0 cells hold 23,000 [design].
export const PR_K = 360;
export const precipWord = (mm: number) => Math.round(Math.sqrt(Math.max(0, mm)) * PR_K);
export const precipOfWord = (v: number) => (v / PR_K) ** 2;

export function compact(a: AirTile, tier: number): Record<string, Field> {
  const out: Record<string, Field> = {}, names = airOut(tier);
  let saturated = 0;
  const put = (name: string, src: Float32Array, word: (v: number) => number, lo: number, hi: number, K: new (n: number) => Field) => {
    const f = new K(src.length);
    for (let i = 0; i < src.length; i++) { const v = word(src[i]); if (v < lo || v > hi) saturated++; f[i] = Math.max(lo, Math.min(hi, v)); }
    out[name] = f;
  };
  const linear = (unit: number) => (v: number) => Math.round(v * unit);
  for (let k = 0; k < NS; k++) {
    put(names.pr[k], a.precip[k], precipWord, 0, 65535, Uint16Array); put(names.pe[k], a.pet[k], linear(AIR_UNIT.pe), 0, 65535, Uint16Array);
    put(names.sun[k], a.sun[k], linear(AIR_UNIT.sun), 0, 65535, Uint16Array); put(names.tmp[k], a.temp[k], linear(AIR_UNIT.tmp), -32768, 32767, Int16Array);
    put(names.hum[k], a.humid[k], linear(AIR_UNIT.hum), 0, 255, Uint8Array);
  }
  put(names.snow, a.snowCover, linear(AIR_UNIT.snow), 0, 255, Uint8Array);
  put(names.wsh, a.windShare, linear(AIR_UNIT.wsh), 0, 255, Uint8Array);
  put(names.fog, a.fog, linear(AIR_UNIT.fog), 0, 255, Uint8Array);
  for (let k = 0; k < NS; k++) put(names.snp[k], a.snowpack[k], linear(AIR_UNIT.snp), 0, 65535, Uint16Array);
  a.saturated = saturated;
  return out;
}

// `block`: the side in tiles of the square one patch makes (stages.ts runTiles); the halo is shared by block * block tiles and no byte changes.
export const airStage = (tier: number, block = 1): TileStage => {
  const height = tierFile(tier, "height.i32"), flooded = tierFile(tier, "flooded.i32");
  return {
    name: "air",
    halo: airHalo(tier),
    block,
    inputs: [height, flooded],
    outputs: airOutputs(tier),
    async run(ctx, patch, input) {
      const tile = await airOf(ctx, patch, input[height] as Int32Array, input[flooded] as Int32Array), out = compact(tile, tier);
      // a word past its unit would be clamped and hide what passed it: say so rather than store it
      if (tile.saturated) throw new Error(`air: ${tile.saturated} words of tile (face ${patch.face}, ${patch.tx}, ${patch.ty}) pass what their stored units hold`);
      return out;
    },
  };
};
