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
import { COARSE, DIRS, GAMMA_RATIO, H_W, M, NC, N_M, P_BG, R_V, SEASONS, SEASON_DAYS } from "../../terrain/climate";
import { BATCH, rainCoarse, rainCols, rainFine, rainInvA, rainInvB, rainRows, rainTransfer } from "../wgsl/terrain-rain";

const NS = SEASONS.length;
// Words of the parameter buffer: a season's eight, a direction's two, the wet rose's share of each (season, direction).
export const SEASON_AT = 0, DIR_AT = NS * 8, SHARE_AT = DIR_AT + 2 * DIRS, PAR_WORDS = SHARE_AT + BATCH;
// Tallest total height the transforms' words hold: the coarse cells' sum of heights in m.
const MOST_TOTAL_M = 2e6;

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
export const cloudDelays = (ice: number): Delays => ({ tauC: ice * TAU_C_ICE + (1 - ice) * TAU_C_WARM, tauF: (1 - ice) * TAU_F_RAIN + (ice * H_W) / V_SNOW });
// tau_c / tau_f by season: 1427 / 2124, 2093 / 1536, 2006 / 1612, 1444 / 2109 s.
export const ISLAND_DELAYS: Delays[] = ICE_SHARE.map(cloudDelays);

// FAO-56's saturation vapour pressure, kPa (climate.ts esat), with the exponential taken by the world's integer exp
// (fixed.ts: 2^f from a table and a series, good to 2^-30) so that no word here depends on the engine's Math.exp.
function esat(t: number) {
  const x = Math.round(((17.27 * t) / (t + 237.3)) * 2 ** 32);
  const [lo, hi] = tolog2([x >>> 0, Math.floor(x / 2 ** 32)]);
  return 0.6108 * (e2f(lo) / 2 ** 31) * 2 ** (hi | 0);
}

// The cosine and sine of 2 pi n / M for n < M, Q28: the first M words, then the last M.
export function twiddles(): Int32Array {
  const t = new Int32Array(2 * M);
  for (let n = 0; n < M; n++) {
    t[n] = Q(Math.cos((2 * Math.PI * n) / M), 28);
    t[M + n] = Q(Math.sin((2 * Math.PI * n) / M), 28);
  }
  return t;
}
// The wind directions' cosine and sine, Q22, for each of DIRS.
export const windTable = () => Int32Array.from({ length: 2 * DIRS }, (_, n) => Q(n & 1 ? Math.sin((2 * Math.PI * (n >> 1)) / DIRS) : Math.cos((2 * Math.PI * (n >> 1)) / DIRS), 22));
// How far, in steps of the last place, the closest of the tables' exact values lies from a rounding tie: an engine whose
// Math.cos or Math.sin is off by a unit in the last place of a double rounds the same word while this is over 1e-6.
export function tableMargin(): number {
  let least = 0.5;
  const check = (v: number, n: number) => { least = Math.min(least, Math.abs(Math.abs(v * 2 ** n - Math.floor(v * 2 ** n)) - 0.5)); };
  for (let n = 0; n < M; n++) { check(Math.cos((2 * Math.PI * n) / M), 28); check(Math.sin((2 * Math.PI * n) / M), 28); }
  for (let d = 0; d < DIRS; d++) { check(Math.cos((2 * Math.PI * d) / DIRS), 22); check(Math.sin((2 * Math.PI * d) / DIRS), 22); }
  return least;
}

// The parameter words (layout in wgsl/terrain-rain.ts rainTransfer): from each season's constants, the seasons' cloud
// delays and the wet rose.
export function rainParams(wetRose: number[], delays: Delays[] = ISLAND_DELAYS): Int32Array {
  const par = new Int32Array(PAR_WORDS), dk = (2 * Math.PI) / (M * COARSE * CELL);
  SEASONS.forEach(({ t, wet, rains, rainWind, rainHumid }, si) => {
    const hours = SEASON_DAYS * 24 * rains, bg = (P_BG * wet) / hours;
    const Cw = ((rainHumid * esat(t) * 1000) / (R_V * (t + 273.15))) * GAMMA_RATIO;
    par.set([
      Q(Cw * 3600 * rainWind * dk, 26), // B: C_w in mm an hour for each m, times sigma / q
      Q((N_M * H_W) / rainWind, 26), // a
      Q((rainWind * dk) / N_M, 26), // c1: sigma / N_m for each unit of q
      Q(rainWind * dk * delays[si].tauC, 26), // sigma tau_c for each unit of q
      Q(rainWind * dk * delays[si].tauF, 26),
      Q(bg, 24),
    ], SEASON_AT + si * 8);
    for (let d = 0; d < DIRS; d++) par[SHARE_AT + si * DIRS + d] = wetRose[d] > 0 ? Q(wetRose[d] * hours, 20) : 0;
  });
  par.set(windTable(), DIR_AT);
  return par;
}

const kernels = { coarse: rainCoarse(), rows: rainRows(), cols: rainCols(), transfer: rainTransfer(), invA: rainInvA(), invB: rainInvB(), fine: rainFine() };

// The rain of each season, mm over the season, by cell, with the seasons' cloud delays (the paper's are 1000 s all year:
// pass those to compare). Throws where the heights' total passes
// what the transforms' words hold (2e6 m of coarse height, a mean of 490 m over the island).
export async function rainGpu(g: Gpu, z: Float32Array, wetRose: number[], delays: Delays[] = ISLAND_DELAYS): Promise<Float32Array[]> {
  if (z.length !== N * N) throw new Error(`rainGpu: ${z.length} heights, wanted ${N * N}`);
  if (wetRose.length !== DIRS) throw new Error(`rainGpu: ${wetRose.length} directions in the wet rose, wanted ${DIRS}`);
  const zq = new Int32Array(z.length);
  let total = 0;
  for (let i = 0; i < z.length; i++) { zq[i] = Math.round(z[i] * 65536); total += Math.abs(zq[i]); }
  if (total / 65536 / (COARSE * COARSE) > MOST_TOTAL_M) throw new Error("rainGpu: the heights' total passes the transforms' range");

  const zB = storage(g, zq), twB = storage(g, twiddles()), parB = storage(g, rainParams(wetRose, delays));
  const hc = storage(g, NC * NC * 4), r = storage(g, NC * M * 8), hh = storage(g, M * M * 8);
  const s = storage(g, BATCH * M * M * 8), a = storage(g, BATCH * NC * M * 8), p = storage(g, BATCH * NC * NC * 4);
  const out = storage(g, NS * N * N * 4);
  const groups = (n: number) => cover(g, n)[0];
  dispatch(g, pipeline(g, kernels.coarse), [zB, hc], [groups(NC * NC)]);
  dispatch(g, pipeline(g, kernels.rows), [hc, twB, r], [groups(NC * M)]);
  dispatch(g, pipeline(g, kernels.cols), [r, twB, hh], [groups(M * M)]);
  dispatch(g, pipeline(g, kernels.transfer), [hh, parB, s], [groups(BATCH * M * M)]);
  dispatch(g, pipeline(g, kernels.invA), [s, twB, a], [BATCH * NC]);
  dispatch(g, pipeline(g, kernels.invB), [a, twB, p], [groups(BATCH * NC * NC)]);
  dispatch(g, pipeline(g, kernels.fine), [p, parB, out], [groups(NS * N * N)]);
  const words = new Int32Array(await readback(g, out));
  for (const b of [zB, twB, parB, hc, r, hh, s, a, p, out]) b.destroy();
  return Array.from({ length: NS }, (_, si) => Float32Array.from(words.subarray(si * N * N, (si + 1) * N * N), (v) => v / 65536));
}
