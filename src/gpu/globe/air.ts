// The `air` tile stage: the island's rain and the rest of its climate (src/gpu/terrain/{rain,climate}.ts) on a patch of the 75 m tier, fed by the planet's fields the way
// window.ts windowOf feeds a window, but each cell by its own place and the rain's totals by tier-0 block (a block is the 16 by 16 cells of one tier-0 cell). The planet's air
// (sea-level warmth by season, the sea's surface, the wind, the rain) is read by sampleCoarse; the tier's heights and its flooded surface say where open water lies.
//
// What a cell takes of its place (each a window's one value on the island and in window.ts):
//   sea-level air, the sea's surface and the air's water by season   the planet's, at the cell; the sea's surface from the sea cells of tier 0 alone (normalised sample)
//   wind direction                                                     the planet's year-mean wind at the cell (the rain's each season's) in the patch's axes; the roses keep their shapes
//   the sun's table                                                    the cell's band of latitude (0.1 degree), in the compass's axes, the cell's grid turned to them
//   the rain's background                                              the tier-0 cell's own rain (piecewise constant over a block), on which the orographic detail is added
//   the rain's cloud delays and its C_w                                the patch's centre's sea-level air by season (the one value the transfer takes: the measured step between two tiles' centres is in the notes)
//   Bornholm's, kept [gap]                                             cloud, beam and glow through the cloud, humidity at sea level against saturation, the wet hours' wind and humidity, fog,
//                                                                      the pool of cold air's cooling, the snow years' weather and spread, the sea wind's speed
//
// Rain (R1800 to R1829). The theory (Smith and Barstad, R487) is run on the detail relief: the tier's height less the planet's tier-0 surface sampled to the cell (window.ts
// rainZ), over the patch (rain.ts RainFormat {coarse 4, cells, wide}; M = 4 NC), with the cloud delays scaled by the planet's s (similarity.ts: Earth's times s, as the
// atmosphere scales them, so a drift of U tau is Earth's times s: 0.4 to 1 km, not 13 km). Its background is the tier-0 cell's own rain (so a block's cells add to the same
// number whatever their neighbours'); each cell's rain is the planet's (sampled) times the theory's field over its block's mean, then the block is scaled so its mean is the
// tier-0 cell's own: out(c) = shape(c) made(c) / mean_block(made), times P0 / mean_block(that). A block is whole in the patch because the halo is a whole number of blocks
// (16 cells) and a tile starts on one: the means are then those of whole blocks wherever the patch is cut.
//
// Halo (AIR_HALO = 128, a patch of 512 by 512, four times the tile's cells). Each kernel's reach in cells of 75 m: the blur three passes of 8 (24); the normal 1; the pool's around
// and slope (25); the horizons 95 (the table's 26 distances 1.2^n below 110), the longest and the only one that makes the halo's size (a multiple of 16 over it: 96); the snow
// years' group 2. Past any halo: the wind's wake (a break of height H shelters 30 H downwind: kilometres behind a range), the salt's far fall-off (31 km, 414 cells; the host seeds
// the edge with the planet's distance to the sea, a floor of how far the air has come) and the rain's lee waves (the theory's mountain waves of 17 km are damped by the cloud
// delays alone, which on this planet are s times Earth's, so they travel the patch). 128 keeps the wake's first 30 H of a 100 m ridge, the salt's near fall-off and the
// rain's first drift whole; what it cuts is measured in the notes (docs/research/globe/2026-10-21-planet-75m-air.md) and by air.test.ts.
import { SEASONS, SEASON_DAYS, H_W, LAPSE, ROSE, WET_ROSE, esat } from "../../terrain/climate";
import { eastNorth, haloSource, pointOf, tierGrid } from "./grid";
import { MOST_TOTAL_M, cloudDelays, rainHeights, rainParams, rainWords } from "../terrain/rain";
import { patchMeanWay, patchRose, runClimate, type PatchInput } from "../terrain/climate";
import { BAND_DEG } from "../wgsl/terrain-climate";
import type { RainFormat } from "../wgsl/terrain-rain";
import { readback } from "../kernel";
import type { Patch } from "./patch";
import type { Planet } from "./window";
import { sampleCoarse } from "./sample";
import { similarityOf } from "./similarity";
import type { Ctx, Field, TileStage } from "./stages";

const NS = SEASONS.length, DEG = Math.PI / 180;
export const AIR_HALO = 128;
// The orographic rain is reckoned on the detail relief over this: the transforms' words hold a coarse sum of 2e6 m of height, which 122 m of mean detail over a 512-cell patch
// passes [derived: rain.ts MOST_TOTAL_M], so the heights and the background are taken at a sixteenth and the theory (linear in both, R1708) is read back at sixteen times. The
// detail is under the planet's highest ground (6.5 km) in size, so its mean under 400 m at this scale: the check cannot fail.
export const RAIN_DOWN = 16;
// No cell's rain is more than this many times its block's mean [design: orographic rain over a face of a mountain is a few times the air's own rain around it: Bornholm's
// gauges rise 17% of the island's rain for each 100 m of height (R1327, r 0.82), 2.7 times over a kilometre, and the theory's gain over them is 3.5 (the rain note, finding 5);
// a cell of 75 m on the wettest face of a block of 1.2 km is given 4 against the block's mean] and, whatever the block's, no more than the words downstream hold of a season's
// rain: Q16 in an i32 is 32,767 mm [derived], held at 32,000.
export const RAIN_CAP = 4, WORD_MAX_MM = 32_000;
// Passes of the block-mean scale: each reads the scale between the blocks' centres and corrects the blocks' means by what is left [design: measured, the error after 8 is in the notes].
export const SCALE_PASSES = 8;
const BLOCK = 16;

// ---------- the patch's place on the sphere ----------
export interface Geometry {
  lat: Float64Array; // degrees
  psi: Float64Array; // radians, the grid's x axis counterclockwise from east, at each cell
  widthM: Float64Array; // the cell's width along x, m
  skewDeg: Float64Array; // how far the grid's y axis stands from a right angle to its x axis, degrees (zero where the grid is square)
}
export function geometryOf(patch: Patch, radius: number): Geometry {
  const g = tierGrid(patch.tier), S = patch.side, n = S * S, fn = g.fn, cells = fn * fn, pos = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const id = patch.ids[i], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn, p = pointOf(f, g.mid[X], g.mid[Y]);
    pos[3 * i] = p[0]; pos[3 * i + 1] = p[1]; pos[3 * i + 2] = p[2];
  }
  const lat = new Float64Array(n), psi = new Float64Array(n), widthM = new Float64Array(n), skewDeg = new Float64Array(n);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x, a = y * S + Math.max(0, x - 1), b = y * S + Math.min(S - 1, x + 1), c = Math.max(0, y - 1) * S + x, d = Math.min(S - 1, y + 1) * S + x;
      const p: [number, number, number] = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]], [e, nn] = eastNorth(p);
      const tx = [pos[3 * b] - pos[3 * a], pos[3 * b + 1] - pos[3 * a + 1], pos[3 * b + 2] - pos[3 * a + 2]], ty = [pos[3 * d] - pos[3 * c], pos[3 * d + 1] - pos[3 * c + 1], pos[3 * d + 2] - pos[3 * c + 2]];
      const dot = (u: number[], v: readonly number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2], lx = Math.hypot(tx[0], tx[1], tx[2]), ly = Math.hypot(ty[0], ty[1], ty[2]);
      lat[i] = Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG;
      psi[i] = lx > 0 ? Math.atan2(dot(tx, nn), dot(tx, e)) : 0;
      widthM[i] = (lx * radius) / (x === 0 || x === S - 1 ? 1 : 2);
      skewDeg[i] = lx > 0 && ly > 0 ? Math.acos(Math.max(-1, Math.min(1, dot(tx, ty) / (lx * ly)))) / DEG - 90 : 0;
    }
  return { lat, psi, widthM, skewDeg };
}

// ---------- the planet's fields at the patch ----------
// The distance over the land from each tier-0 cell to the nearest sea cell, m: Dijkstra over the cells' eight neighbours (across face edges) by the chord between their centres.
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
interface Planetary { fields: Float32Array[]; }
const planetary = new WeakMap<object, Planetary>();
// The planet's tier-0 fields the stage samples, in the order of `Sampled`: the surface, the sea-level air, the sea's surface (sea cells only, with the sea's share beside it), the rain, the wind.
function planetFields(ctx: Ctx): Planetary {
  let p = planetary.get(ctx.planet);
  if (!p) {
    const pl = ctx.planet, sea = Float32Array.from(pl.height, (h) => (h <= 0 ? 1 : 0));
    planetary.set(ctx.planet, (p = { fields: [pl.height, ...pl.seasons.map((s) => s.t), ...pl.seasons.map((s) => s.sst), sea, ...pl.seasons.map((s) => s.rain), ...pl.seasons.map((s) => s.windE), ...pl.seasons.map((s) => s.windN), seaDistance(pl)] }));
  }
  return p;
}
export interface Sampled { surface: Float32Array; t: Float32Array[]; sst: Float32Array[]; rain: Float32Array[]; windE: Float32Array[]; windN: Float32Array[]; seaM: Float32Array }
export function sampledOf(ctx: Ctx, patch: Patch): Sampled {
  const s = sampleCoarse(patch.tier, patch.ids, planetFields(ctx).fields), at = (k: number) => s.slice(k, k + NS);
  const sea = s[1 + 2 * NS], sst = at(1 + NS).map((v, k) => Float32Array.from(v, (x, i) => (sea[i] > 1e-3 ? x / sea[i] : s[1 + k][i])));
  return { surface: s[0], t: at(1), sst, rain: at(2 + 2 * NS), windE: at(2 + 3 * NS), windN: at(2 + 4 * NS), seaM: s[2 + 5 * NS] };
}

// How far, over the land, the air that enters the patch has come: the planet's distance to the nearest sea (tier 0's, by its neighbours' chords) is a floor of it along any
// bearing, and where the wavefront has no cell upwind (the patch's edge) the salt would start at the coast again [design; the true distance along the wind is longer, so the
// far salt is a little high near the edge where the wind comes off the land: gap]. Q12 m, as the kernel holds it, 0 over open water.
const STEP_Q16 = (k: number) => [Math.round(Math.cos((k / DIRS16) * Math.PI * 2) * 1.5 * 65536), Math.round(Math.sin((k / DIRS16) * Math.PI * 2) * 1.5 * 65536)];
function shoreSeed(S: number, open: Uint8Array, seaM: Float32Array): Int32Array {
  const shore = new Int32Array(DIRS16 * S * S), lim = (S - 1) * 65536;
  for (let k = 0; k < DIRS16; k++) {
    const [cs, sn] = STEP_Q16(k);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const ux = x * 65536 - cs, uy = y * 65536 - sn;
        if ((ux < 0 || uy < 0 || ux > lim || uy > lim) && !open[y * S + x]) shore[k * S * S + y * S + x] = Math.round(Math.min(3e5, seaM[y * S + x]) * 4096);
      }
  }
  return shore;
}

// The tier-0 cell (a block's) of a tier-4 cell id: face, row and column of the 16-cell blocks.
const parentOf = (id: number) => { const f = id >>> 24, r = id & 0xffffff; return f * 65536 + (r >> 16) * 256 + ((r & 4095) >> 4); };
// How far to turn the rose, in Q16 bearings (mod 16): the wind's direction in the patch's axes less the rose's own mean (climate.ts turned, in the patch's sense).
const TURN_MASK = 16 * 65536 - 1;
const turnWord = (e: number, n: number, psi: number) => Math.round(((Math.atan2(n, e) - psi - patchMeanWay(ROSE)) / (2 * Math.PI)) * DIRS16 * 65536) & TURN_MASK;
const DIRS16 = 16;

// ---------- the rain ----------
export interface RainTile { made: Float32Array[]; precip: Float32Array[]; delays: { tauC: number; tauF: number }[] }
// The rain of each season on the patch's cells, mm over the season.
export async function rainOf(ctx: Ctx, patch: Patch, height: Float32Array, geo: Geometry, planet: Sampled): Promise<RainTile> {
  const S = patch.side, n = S * S, fmt: RainFormat = { n: S, coarse: 4, cells: true, wide: true }, s = similarityOf(ctx.planet.radius).s, centre = ((S >> 1) * S) + (S >> 1);
  // the scale: RAIN_DOWN, or the next power of two that keeps the transforms' words (a patch of detail over 1.9 km a cell on the mean: none on this planet), so that no tile throws
  let detail = 0;
  for (let i = 0; i < n; i++) detail += Math.abs(Math.max(0, height[i]) - Math.max(0, planet.surface[i]));
  let down = RAIN_DOWN;
  while (detail / down / 16 > 0.9 * MOST_TOTAL_M) down *= 2;
  const z = Float32Array.from(height, (h, i) => (Math.max(0, h) - Math.max(0, planet.surface[i])) / down);
  const t0 = planet.t.map((v) => v[centre]), delays = t0.map((t) => cloudDelays(Math.exp(-Math.max(0, t) / LAPSE / H_W), s));
  // the moist layer's wind is the planet's surface wind at the patch's centre by season, never under the atmosphere's 2 m/s gust floor [design: the atmosphere's own rain
  // drifts by the planet's wind, so a delay of 31 to 83 s is 2 to 5 cells of 75 m at the land's median 4.7 m/s; Bornholm's 12 to 13.6 m/s at 850 hPa made it 5 to 14 cells a delay]
  const wind = planet.windE.map((e, k) => Math.max(2, Math.hypot(e[centre], planet.windN[k][centre])));
  const seasons = SEASONS.map((c, k) => ({ t: t0[k], mm: 0, rains: c.rains, rainWind: wind[k], rainHumid: c.rainHumid, rose: patchRose(WET_ROSE) }));
  const par = rainParams(patchRose(WET_ROSE), delays, seasons, fmt), cell = new Int32Array(2 * NS * n);
  const parent = Int32Array.from(patch.ids, parentOf);
  for (let k = 0; k < NS; k++) {
    const hours = SEASON_DAYS * 24 * SEASONS[k].rains;
    for (let i = 0; i < n; i++) {
      cell[k * n + i] = Math.round((Math.max(0, planet.rain[k][i]) / hours / down) * 2 ** 24);
      cell[(NS + k) * n + i] = turnWord(planet.windE[k][i], planet.windN[k][i], geo.psi[i]);
    }
  }
  const words = await rainWords(ctx.gpu, fmt, rainHeights(z, fmt), par, cell);
  // The rain of a cell is the planet's rain at it (smooth, between the four tier-0 centres) times the theory's enhancement there: made over the mean of made, the mean
  // being smooth too (the blocks' means read between their centres), the ratio held at RAIN_CAP. A block's mean is then brought to the tier-0 cell's own rain by a scale that
  // is itself read between the blocks' centres, a few passes of it, so that no step stands at a block's edge and the mean is the planet's to the passes' error [design].
  const B = S >> 4, tier0 = Float64Array.from({ length: B * B }, (_, b) => parent[((b / B | 0) * 16) * S + (b % B) * 16]);
  const made = [] as Float32Array[], precip = [] as Float32Array[];
  for (let k = 0; k < NS; k++) {
    const m = Float32Array.from({ length: n }, (_, i) => (words[k * n + i] * down) / 65536), bg = planet.rain[k], p0 = ctx.planet.seasons[k].rain;
    const target = Float64Array.from(tier0, (p) => p0[p]);
    for (const t of target) if (t > WORD_MAX_MM) throw new Error(`air: a tier-0 cell holds ${t.toFixed(0)} mm of rain in a season, past the ${WORD_MAX_MM} mm the downstream words hold`);
    const around = smoothBlocks(blockMeans(m, S), B, S), out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(0, bg[i]) * (around[i] > 0 ? Math.min(RAIN_CAP, m[i] / around[i]) : 1);
    const scale = new Float64Array(B * B), mean0 = blockMeans(out, S);
    for (let b = 0; b < B * B; b++) scale[b] = target[b] <= 0 ? 0 : mean0[b] > 0 ? target[b] / mean0[b] : 1;
    const fin = new Float32Array(n);
    for (let pass = 0; pass < SCALE_PASSES; pass++) {
      const c = smoothBlocks(scale, B, S), got = blockMeans(out.map((v, i) => Math.min(WORD_MAX_MM, v * c[i])), S);
      for (let b = 0; b < B * B; b++) if (target[b] > 0 && got[b] > 0) scale[b] *= target[b] / got[b];
    }
    const c = smoothBlocks(scale, B, S);
    for (let i = 0; i < n; i++) fin[i] = Math.min(WORD_MAX_MM, out[i] * c[i]);
    made.push(m); precip.push(fin);
  }
  return { made, precip, delays };
}

// The mean of each 16 by 16 block of a patch field (the patch starts on a block), blocks in rows.
export function blockMeans(f: ArrayLike<number>, S: number): Float64Array {
  const B = S >> 4, out = new Float64Array(B * B);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) out[(y >> 4) * B + (x >> 4)] += f[y * S + x];
  for (let b = 0; b < B * B; b++) out[b] /= 256;
  return out;
}
// A field of the blocks' values read between their centres, bilinear (held at the outermost centres beyond them): the blocks' mean-keeping scale without a step at an edge.
export function smoothBlocks(v: ArrayLike<number>, B: number, S: number): Float64Array {
  const out = new Float64Array(S * S), at = new Int32Array(S), w = new Float64Array(S);
  for (let x = 0; x < S; x++) {
    const u = Math.min(B - 1, Math.max(0, (x - 7.5) / 16)), i0 = Math.min(B - 2, Math.floor(u));
    at[x] = i0; w[x] = u - i0;
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const a = v[at[y] * B + at[x]], b = v[at[y] * B + at[x] + 1], c = v[(at[y] + 1) * B + at[x]], d = v[(at[y] + 1) * B + at[x] + 1];
      out[y * S + x] = (1 - w[y]) * ((1 - w[x]) * a + w[x] * b) + w[y] * ((1 - w[x]) * c + w[x] * d);
    }
  return out;
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
  if ((patch.x0 - patch.halo) % BLOCK || patch.halo % BLOCK || (patch.y0 - patch.halo) % BLOCK) throw new Error("air: a patch's edge must lie on a block of tier 0 (16 cells)");
  const geo = geoIn ?? geometryOf(patch, ctx.planet.radius), planet = sampledIn ?? sampledOf(ctx, patch);
  const height = Float32Array.from(heightWords, (h) => h / 256), open = Uint8Array.from(heightWords, (h, i) => (h <= 0 || floodedWords[i] - h >= 3 ? 1 : 0));
  const rain = await rainOf(ctx, patch, height, geo, planet);

  const q16 = (v: number) => Math.round(v * 65536);
  const tS = planet.t.map((v) => Int32Array.from(v, q16)), seaS = planet.sst.map((v) => Int32Array.from(v, q16));
  const e0S = planet.t.map((v, k) => Int32Array.from(v, (t) => q16(SEASONS[k].humid0 * esat(t))));
  const wturn = new Int32Array(n), band = new Int32Array(n), cps = new Int32Array(n), sps = new Int32Array(n), psi = new Int32Array(n);
  const bandAt = Int32Array.from(geo.lat, (l) => Math.round(l / BAND_DEG)), first = bandAt.reduce((a, b) => Math.min(a, b), 1e9), last = bandAt.reduce((a, b) => Math.max(a, b), -1e9);
  const limit = 89.95;
  const bandsDeg = Array.from({ length: last - first + 1 }, (_, k) => Math.max(-limit, Math.min(limit, (first + k) * BAND_DEG)));
  for (let i = 0; i < n; i++) {
    let e = 0, nn = 0;
    for (let k = 0; k < NS; k++) { e += planet.windE[k][i]; nn += planet.windN[k][i]; }
    wturn[i] = turnWord(e, nn, geo.psi[i]);
    band[i] = bandAt[i] - first;
    cps[i] = q16(Math.cos(geo.psi[i])); sps[i] = q16(Math.sin(geo.psi[i]));
    psi[i] = Math.round((geo.psi[i] / (2 * Math.PI)) * DIRS16 * 65536) & TURN_MASK;
  }
  // the snow years' groups: a game tile's four cells of the planet (the cells that share a tile of tier 3), whichever way the patch lays them
  const cells = 4096 * 4096, slot = new Map<number, number>(), groups: number[] = [];
  for (let i = 0; i < n; i++) {
    if (patch.missing[i]) continue;
    const id = patch.ids[i], f = Math.floor(id / cells), r = id - f * cells, key = (f * 2048 + (Math.floor(r / 4096) >> 1)) * 2048 + ((r & 4095) >> 1);
    let g = slot.get(key);
    if (g === undefined) { slot.set(key, (g = slot.size)); groups.push(-1, -1, -1, -1); }
    for (let c = 0; c < 4; c++) if (groups[4 * g + c] < 0) { groups[4 * g + c] = i; break; }
  }
  const grp = new Int32Array(4 * (S / 2 + 2) ** 2).fill(-1);
  grp.set(groups);
  const input: PatchInput = { tS, seaS, e0S, wturn, band, cps, sps, psi, bandsDeg, groups: grp, rose: patchRose(ROSE), shore: shoreSeed(S, open, planet.seaM) };
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
const seasonal = (stem: string, type: string) => Array.from({ length: NS }, (_, k) => `${stem}${k}.${type}`);
export const AIR_OUT = { pr: seasonal("t4-pr", "u16"), pe: seasonal("t4-pe", "u16"), sun: seasonal("t4-sun", "u16"), tmp: seasonal("t4-tmp", "i16"), hum: seasonal("t4-hum", "u8"), snow: "t4-snow.u8", wsh: "t4-wsh.u8", fog: "t4-fog.u8", snp: seasonal("t4-snp", "u16") };
export const AIR_OUTPUTS = [...AIR_OUT.pr, ...AIR_OUT.pe, ...AIR_OUT.sun, ...AIR_OUT.tmp, ...AIR_OUT.hum, AIR_OUT.snow, AIR_OUT.wsh, AIR_OUT.fog, ...AIR_OUT.snp];
// The units of the stored words.
// snp: the season's mean snowpack in 1/4 mm of water, held at 16 m (65,535) [design: the island's packs are metres at most]
export const AIR_UNIT = { pe: 10, sun: 1024, tmp: 256, hum: 255, snow: 255, wsh: 255, fog: 255, snp: 4 };

// The stored word of a season's rain: the square root of the mm times 360 (u16), so that 0.006 mm is held at a millimetre and 0.35 mm at the most a cell can hold
// (32,000 mm), a linear 0.1 mm word saturating at 6,553 where the planet's own tier-0 cells hold 23,000 [design].
export const PR_K = 360;
export const precipWord = (mm: number) => Math.round(Math.sqrt(Math.max(0, mm)) * PR_K);
export const precipOfWord = (v: number) => (v / PR_K) ** 2;

export function compact(a: AirTile): Record<string, Field> {
  const out: Record<string, Field> = {};
  let saturated = 0;
  const put = (name: string, src: Float32Array, word: (v: number) => number, lo: number, hi: number, K: new (n: number) => Field) => {
    const f = new K(src.length);
    for (let i = 0; i < src.length; i++) { const v = word(src[i]); if (v < lo || v > hi) saturated++; f[i] = Math.max(lo, Math.min(hi, v)); }
    out[name] = f;
  };
  const linear = (unit: number) => (v: number) => Math.round(v * unit);
  for (let k = 0; k < NS; k++) {
    put(AIR_OUT.pr[k], a.precip[k], precipWord, 0, 65535, Uint16Array); put(AIR_OUT.pe[k], a.pet[k], linear(AIR_UNIT.pe), 0, 65535, Uint16Array);
    put(AIR_OUT.sun[k], a.sun[k], linear(AIR_UNIT.sun), 0, 65535, Uint16Array); put(AIR_OUT.tmp[k], a.temp[k], linear(AIR_UNIT.tmp), -32768, 32767, Int16Array);
    put(AIR_OUT.hum[k], a.humid[k], linear(AIR_UNIT.hum), 0, 255, Uint8Array);
  }
  put(AIR_OUT.snow, a.snowCover, linear(AIR_UNIT.snow), 0, 255, Uint8Array);
  put(AIR_OUT.wsh, a.windShare, linear(AIR_UNIT.wsh), 0, 255, Uint8Array);
  put(AIR_OUT.fog, a.fog, linear(AIR_UNIT.fog), 0, 255, Uint8Array);
  for (let k = 0; k < NS; k++) put(AIR_OUT.snp[k], a.snowpack[k], linear(AIR_UNIT.snp), 0, 65535, Uint16Array);
  a.saturated = saturated;
  return out;
}

export const airStage: TileStage = {
  name: "air",
  halo: AIR_HALO,
  inputs: ["t4-height.i32", "t4-flooded.i32"],
  outputs: AIR_OUTPUTS,
  async run(ctx, patch, input) {
    return compact(await airOf(ctx, patch, input["t4-height.i32"] as Int32Array, input["t4-flooded.i32"] as Int32Array));
  },
};

