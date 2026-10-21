// The island's orographic rain on the GPU (kernels: wgsl/terrain-rain.ts). The inputs are the heights in metres (N x N: the
// ground, never under the sea's level) and the wet rose (DIRS shares); the output is the rain each season brings, in mm
// over the season, N x N, the background rain included (the climate sums the seasons into precip). The cloud delays
// (tau_c, tau_f) are each season's own, from the phase of the water in the moist layer, where the paper takes 1000 s in
// every season (see below and docs/research/generator/2026-10-18-rain.md).
//
// Fixed point, field by field (a value x is held as the integer round(x * 2^n), Qn):
// - z, the heights: Q16 m (an i32 holds up to 32,767 m);
// - the 4 x 4 blocks' mean height (the coarse grid), the exact sum of 16 of them: Q20 m;
// - the transform along x of each coarse row: Q13 m; the height's spectrum on the 256 x 256 wave grid: Q10 m (both are
//   sums, not means, so they run up to the island's total height, held in an i32 up to 2e6 m of it, which the host checks);
// - sine and cosine of the transforms' angles: Q28; of the wind directions: Q22;
// - a wave's place along the wind, q = wave index along the wind's two axes, in grid units: Q22 (sigma = U k + V l is
//   the wind's speed times the grid's wave step dk times q);
// - the transfer's factors: Q30 (each is at most 1 in size); its constants: Q26;
// - the waves' spectrum of rain, times M x M: Q16 mm an hour; its inverse along y: Q8; the rain of a rain hour p the
//   waves add and the background rain: Q24 mm an hour;
// - the rain of a season: Q16 mm in the kernel, a float32 here.
// The choice of transform, and what each rounding costs: wgsl/terrain-rain.ts and rain.test.ts.
import { type Gpu } from "../device";
import { cover, dispatch, pipeline, readback, storage } from "../kernel";
import { e2f, tolog2 } from "../fixed";
import { N, CELL } from "../../terrain/grid";
import { DIRS, GAMMA_RATIO, H_W, M, N_M, P_BG, R_V, SEASONS, SEASON_DAYS } from "../../terrain/climate";
import { BATCH, ISLAND_RAIN, rainCoarse, rainConv, rainCols, rainDims, rainFine, rainInvA, rainInvB, rainRows, rainTransfer, type RainFormat } from "../wgsl/terrain-rain";

const NS = SEASONS.length;
// Words of the parameter buffer: a season's eight, a direction's two, the wet rose's share of each (season, direction).
export const SEASON_AT = 0, DIR_AT = NS * 8, SHARE_AT = DIR_AT + 2 * DIRS, PAR_WORDS = SHARE_AT + BATCH;
// Tallest total height the transforms' words hold: the coarse cells' sum of heights in m.
export const MOST_TOTAL_M = 2e6;

const Q = (x: number, n: number) => Math.round(x * 2 ** n);

// The cloud delays of Smith and Barstad's transfer (R1320): tau_c the time cloud water takes to become hydrometeors,
// tau_f the time they take to fall out. Their mountain example takes 1000 s for both and the theory cannot say more;
// the delays depend on the phase of the water (R1321 sec. 7: the cold case a longer drift of hydrometeors and a shorter
// conversion time, the warm case the opposite; R1322: growth by accretion, which snow and rain falling through the
// cloud do, is fast, and slow where the condensation is weak), so each season takes its own, by the share of its
// condensation that happens above the freezing level:
//   ice share f = e^(-z_f / H_w): the theory's own weight of condensation at a height (R1320 eq. 10, e^(-z / H_w)) from
//     the freezing level z_f up, the wet hours' mean of the soundings' (scripts/rain-freezing.ts, R495) [derived];
//   tau_c = f TAU_C_ICE + (1 - f) TAU_C_WARM;  tau_f = (1 - f) TAU_F_RAIN + f H_w / V_SNOW, the mean fall time of a
//     particle from a height with the condensation's weight, falling as rain below the freezing level and as snow above
//     it [design: a first-order mean of the delays, since the theory takes one tau for a season].
// Cold-cloud conversion 1000 s: R1321's fitted delays for the cold cases (IPEX 500 to 1000 s, MAP IOP8 1000 s) [cited].
export const TAU_C_ICE = 1000;
// Warm-cloud conversion 2700 s: growth by condensation and coalescence takes 30 to 60 min, R1323; the middle [cited].
export const TAU_C_WARM = 2700;
// Fall time as rain 1000 s: R1320's (2.5 km, the moist layer, at 2.5 m/s) [cited].
export const TAU_F_RAIN = 1000;
// Fall speed of snow, m/s: about 1, R1323 [cited]; the fall time as snow is H_w over it, 2500 s.
export const V_SNOW = 1;
// By game season (spring, summer, autumn, winter): the mean over Greifswald's and Leba's soundings in Hammer Odde's wet
// hours, 2015 to 2024 (707 and 685 of them) of e^(-z_f / H_w), H_w 2500 m, z_f the freezing level above the sea (nothing
// where the air at the ground is below freezing, so 1; none up the sounding, 0). Median freezing level 770, 2780, 2385
// and 741 m [derived, R495].
export const ICE_SHARE = [0.749, 0.357, 0.408, 0.739];
export interface Delays { tauC: number; tauF: number }
// On a similar planet (gpu/globe/similarity.ts) the delays are Earth's times s, rounded as the atmosphere rounds them (atmosphere.ts kernelConstants), so that a drift of U tau is Earth's times s.
export const cloudDelays = (ice: number, s = 1): Delays => (s === 1
  ? { tauC: ice * TAU_C_ICE + (1 - ice) * TAU_C_WARM, tauF: (1 - ice) * TAU_F_RAIN + (ice * H_W) / V_SNOW }
  : { tauC: ice * Math.round(TAU_C_ICE * s) + (1 - ice) * Math.round(TAU_C_WARM * s), tauF: (1 - ice) * Math.round(TAU_F_RAIN * s) + ice * Math.round((H_W / V_SNOW) * s) });
// tau_c / tau_f by season: 1427 / 2124, 2093 / 1536, 2006 / 1612, 1444 / 2109 s.
export const ISLAND_DELAYS: Delays[] = ICE_SHARE.map((ice) => cloudDelays(ice));

// FAO-56's saturation vapour pressure, kPa (climate.ts esat), with the exponential taken by the world's integer exp
// (fixed.ts: 2^f from a table and a series, good to 2^-30) so that no word here depends on the engine's Math.exp.
export function esat(t: number) {
  const x = Math.round(((17.27 * t) / (t + 237.3)) * 2 ** 32);
  const [lo, hi] = tolog2([x >>> 0, Math.floor(x / 2 ** 32)]);
  return 0.6108 * (e2f(lo) / 2 ** 31) * 2 ** (hi | 0);
}

export function twiddles(m = M): Int32Array {
  const t = new Int32Array(2 * m);
  for (let n = 0; n < m; n++) {
    t[n] = Q(Math.cos((2 * Math.PI * n) / m), 28);
    t[m + n] = Q(Math.sin((2 * Math.PI * n) / m), 28);
  }
  return t;
}
// The wind directions' cosine and sine, Q22, for each of DIRS.
export const windTable = () => Int32Array.from({ length: 2 * DIRS }, (_, n) => Q(n & 1 ? Math.sin((2 * Math.PI * (n >> 1)) / DIRS) : Math.cos((2 * Math.PI * (n >> 1)) / DIRS), 22));
// How far, in steps of the last place, the closest of the tables' exact values lies from a rounding tie: an engine whose
// Math.cos or Math.sin is off by a unit in the last place of a double rounds the same word while this is over 1e-6.
export function tableMargin(m = M): number {
  let least = 0.5;
  const check = (v: number, n: number) => { least = Math.min(least, Math.abs(Math.abs(v * 2 ** n - Math.floor(v * 2 ** n)) - 0.5)); };
  for (let n = 0; n < m; n++) { check(Math.cos((2 * Math.PI * n) / m), 28); check(Math.sin((2 * Math.PI * n) / m), 28); }
  for (let d = 0; d < DIRS; d++) { check(Math.cos((2 * Math.PI * d) / DIRS), 22); check(Math.sin((2 * Math.PI * d) / DIRS), 22); }
  return least;
}

// What the rain stage reads of each season: the air's sea-level warmth (C), the season's background rain (mm over it), the share
// of its hours that rain, the moist layer's wind and humidity in them, and the wet rose (DIRS shares). The island's are
// Bornholm's (SEASONS and P_BG) with one rose; a window's come from the planet (gpu/globe/window.ts).
export type RainSeason = { t: number; mm: number; rains: number; rainWind: number; rainHumid: number; rose: number[] };
export const islandRain = (wetRose: number[]): RainSeason[] => SEASONS.map(({ t, wet, rains, rainWind, rainHumid }) => ({ t, mm: P_BG * wet, rains, rainWind, rainHumid, rose: wetRose }));

// The parameter words (layout in wgsl/terrain-rain.ts rainTransfer): from each season's constants, the seasons' cloud
// delays and the wet roses.
export function rainParams(wetRose: number[], delays: Delays[] = ISLAND_DELAYS, seasons: RainSeason[] = islandRain(wetRose), fmt: RainFormat = ISLAND_RAIN): Int32Array {
  const par = new Int32Array(PAR_WORDS), dk = (2 * Math.PI) / (rainDims(fmt).m * fmt.coarse * CELL);
  seasons.forEach(({ t, mm, rains, rainWind, rainHumid, rose }, si) => {
    const hours = SEASON_DAYS * 24 * rains, bg = mm / hours;
    const Cw = ((rainHumid * esat(t) * 1000) / (R_V * (t + 273.15))) * GAMMA_RATIO;
    par.set([
      Q(Cw * 3600 * rainWind * dk * (256 / rainDims(fmt).m) ** 2, 26), // B: C_w in mm an hour for each m, times sigma / q, and the inverse's 1 / M^2 (the kernels' shifts hold it for M = 256: a wider grid's own is a factor of (256 / M)^2 more)
      Q((N_M * H_W) / rainWind, 26), // a
      Q((rainWind * dk) / N_M, 26), // c1: sigma / N_m for each unit of q
      Q(rainWind * dk * delays[si].tauC, 26), // sigma tau_c for each unit of q
      Q(rainWind * dk * delays[si].tauF, 26),
      Q(bg, 24),
    ], SEASON_AT + si * 8);
    for (let d = 0; d < DIRS; d++) par[SHARE_AT + si * DIRS + d] = rose[d] > 0 ? Q(rose[d] * hours, 20) : 0;
  });
  par.set(windTable(), DIR_AT);
  return par;
}

const kernelSets = new Map<string, Record<"coarse" | "rows" | "cols" | "transfer" | "invA" | "invB" | "fine", string>>();
const kernelsOf = (f: RainFormat) => {
  const key = `${f.n}:${f.coarse}:${f.cells ? 1 : 0}:${f.wide ? 1 : 0}`;
  let k = kernelSets.get(key);
  if (!k) kernelSets.set(key, (k = { coarse: rainCoarse(f), rows: rainRows(f), cols: rainCols(f), transfer: rainTransfer(f), invA: rainInvA(f), invB: rainInvB(f), fine: rainFine(f) }));
  return k;
};

// The heights' Q16 words, their total in coarse cells' sum of metres checked against the words (MOST_TOTAL_M).
export function rainHeights(z: Float32Array, fmt: RainFormat = ISLAND_RAIN): Int32Array {
  const zq = new Int32Array(z.length);
  let total = 0;
  for (let i = 0; i < z.length; i++) { zq[i] = Math.round(z[i] * 65536); total += Math.abs(zq[i]); }
  if (total / 65536 / (fmt.coarse * fmt.coarse) > MOST_TOTAL_M) throw new Error("rainGpu: the heights' total passes the transforms' range");
  return zq;
}

// The seven passes over the heights' words, the words of each season's rain by cell (Q16 mm) back. `cell` (a format with per-cell
// inputs) is the fine pass's cell words: each season's background rain (Q24 mm an hour) then each season's turn of the wet rose.
export async function rainWords(g: Gpu, fmt: RainFormat, zq: Int32Array, par: Int32Array, cell?: Int32Array): Promise<Int32Array> {
  const { nc, m } = rainDims(fmt), n = fmt.n, k = kernelsOf(fmt);
  if (zq.length !== n * n) throw new Error(`rainGpu: ${zq.length} heights, wanted ${n * n}`);
  if (!!cell !== !!fmt.cells) throw new Error("rainGpu: the per-cell words and the format's `cells` go together");
  const zB = storage(g, zq), twB = storage(g, twiddles(m)), parB = storage(g, par), cellB = cell ? storage(g, cell) : null;
  const hc = storage(g, nc * nc * 4), r = storage(g, nc * m * 8), hh = storage(g, m * m * 8);
  const s = storage(g, BATCH * m * m * 8), a = storage(g, BATCH * nc * m * 8), p = storage(g, BATCH * nc * nc * 4);
  const out = storage(g, NS * n * n * 4);
  const groups = (c: number): [number, number] => { const w = cover(g, c); if (w[1] !== 1 && !fmt.wide) throw new Error(`rainGpu: ${c} invocations need more than one row of workgroups`); return w; };
  dispatch(g, pipeline(g, k.coarse), [zB, hc], groups(nc * nc));
  dispatch(g, pipeline(g, k.rows), [hc, twB, r], groups(nc * m));
  dispatch(g, pipeline(g, k.cols), [r, twB, hh], groups(m * m));
  dispatch(g, pipeline(g, k.transfer), [hh, parB, s], groups(BATCH * m * m));
  dispatch(g, pipeline(g, k.invA), [s, twB, a], [BATCH * nc]);
  dispatch(g, pipeline(g, k.invB), [a, twB, p], groups(BATCH * nc * nc));
  dispatch(g, pipeline(g, k.fine), cellB ? [p, parB, cellB, out] : [p, parB, out], groups(NS * n * n));
  const words = new Int32Array(await readback(g, out));
  for (const b of [zB, twB, parB, hc, r, hh, s, a, p, out, ...(cellB ? [cellB] : [])]) b.destroy();
  return words;
}

// The waves alone: the rain of a rain hour that the transfer gives each (season, direction) of the batch (BATCH x nc x nc words, Q24 mm an hour), the passes up to the inverse transform.
export async function rainWaves(g: Gpu, fmt: RainFormat, zq: Int32Array, par: Int32Array): Promise<Int32Array> {
  const { nc, m } = rainDims(fmt), n = fmt.n, k = kernelsOf(fmt);
  if (zq.length !== n * n) throw new Error(`rainWaves: ${zq.length} heights, wanted ${n * n}`);
  const zB = storage(g, zq), twB = storage(g, twiddles(m)), parB = storage(g, par);
  const hc = storage(g, nc * nc * 4), r = storage(g, nc * m * 8), hh = storage(g, m * m * 8);
  const s = storage(g, BATCH * m * m * 8), a = storage(g, BATCH * nc * m * 8), p = storage(g, BATCH * nc * nc * 4);
  const groups = (c: number) => cover(g, c);
  dispatch(g, pipeline(g, k.coarse), [zB, hc], groups(nc * nc));
  dispatch(g, pipeline(g, k.rows), [hc, twB, r], groups(nc * m));
  dispatch(g, pipeline(g, k.cols), [r, twB, hh], groups(m * m));
  dispatch(g, pipeline(g, k.transfer), [hh, parB, s], groups(BATCH * m * m));
  dispatch(g, pipeline(g, k.invA), [s, twB, a], [BATCH * nc]);
  dispatch(g, pipeline(g, k.invB), [a, twB, p], groups(BATCH * nc * nc));
  const words = new Int32Array(await readback(g, p));
  for (const b of [zB, twB, parB, hc, r, hh, s, a, p]) b.destroy();
  return words;
}

const convSets = new Map<string, { coarse: string; conv: string; fine: string }>();
// The convolved rain: the coarse heights, the waves as a sum over the response `tab` (BATCH x (2 radius + 1)^2 words) of the coarse cells within `radius`, then the fine pass
// (cells format) to the orographic rain of each cell, Q16 mm over the season (rainFine's cell words in `cell`).
export async function rainConvolved(g: Gpu, fmt: RainFormat, radius: number, zq: Int32Array, par: Int32Array, tab: Int32Array, cell: Int32Array): Promise<Int32Array> {
  const { nc } = rainDims(fmt), n = fmt.n, key = `${fmt.n}:${fmt.coarse}:${radius}`;
  let k = convSets.get(key);
  if (!k) convSets.set(key, (k = { coarse: rainCoarse(fmt), conv: rainConv(fmt, radius), fine: rainFine(fmt) }));
  if (!fmt.cells || !fmt.wide) throw new Error("rainConvolved: a patch's format has per-cell words and wide dispatch");
  if (zq.length !== n * n) throw new Error(`rainConvolved: ${zq.length} heights, wanted ${n * n}`);
  const zB = storage(g, zq), parB = storage(g, par), tabB = storage(g, tab), cellB = storage(g, cell);
  const hc = storage(g, nc * nc * 4), p = storage(g, BATCH * nc * nc * 4), out = storage(g, NS * n * n * 4);
  const groups = (c: number, size = 256) => cover(g, c, size);
  dispatch(g, pipeline(g, k.coarse), [zB, hc], groups(nc * nc));
  dispatch(g, pipeline(g, k.conv), [hc, tabB, p], groups(BATCH * nc * nc, 64));
  dispatch(g, pipeline(g, k.fine), [p, parB, cellB, out], groups(NS * n * n));
  const words = new Int32Array(await readback(g, out));
  for (const b of [zB, parB, tabB, cellB, hc, p, out]) b.destroy();
  return words;
}

// The rain of each season, mm over the season, by cell, with the seasons' cloud delays (the paper's are 1000 s all year:
// pass those to compare). Throws where the heights' total passes
// what the transforms' words hold (2e6 m of coarse height, a mean of 490 m over the island).
export async function rainGpu(g: Gpu, z: Float32Array, wetRose: number[], delays: Delays[] = ISLAND_DELAYS, seasons?: RainSeason[]): Promise<Float32Array[]> {
  if (z.length !== N * N) throw new Error(`rainGpu: ${z.length} heights, wanted ${N * N}`);
  if (wetRose.length !== DIRS) throw new Error(`rainGpu: ${wetRose.length} directions in the wet rose, wanted ${DIRS}`);
  const words = await rainWords(g, ISLAND_RAIN, rainHeights(z), rainParams(wetRose, delays, seasons));
  return Array.from({ length: NS }, (_, si) => Float32Array.from(words.subarray(si * N * N, (si + 1) * N * N), (v) => v / 65536));
}
