// Climate from weather and the sun, the island standing for a Baltic one with Bornholm's climate (55.1 degrees north;
// docs/research/fire-constants.md sec. 34). Air comes in off the sea from every direction, as often as Hammer Odde's wind
// rose says, in every season; the rain its fronts bring falls more on the hills' windward side and less in their lee, by
// Smith and Barstad's linear theory of orographic rain. The sun crosses the sky of each season as src/sim/sky.ts has it,
// through the season's measured cloud, and the hills shade one another from it. Summing all of that gives rain, snow,
// sunlight, warmth, wind, damp air and evaporation without drawing a single zone by hand.
import { clamp } from "math";
import { YEAR_DAYS, sunAt } from "../sim/sky";
import { CELL, LEN, N, blur, ramp, sample } from "./grid";

// °C lost per meter climbed: the standard atmosphere's lapse rate (sec. 34, R494).
const LAPSE = 0.0065;
// The game's own seasons, each a quarter of a year of weather centred on an equinox or a solstice (spring from 4 February
// to 5 May, and so on), from DMI's and NOAA's records of Bornholm summed on those windows by docs/research/isd/bornholm.py
// (sec. 34) [derived]:
// - t, the mean air at sea level: Rønne's (DMI 06190) 1991 to 2020, brought down from its 16 m by the lapse rate;
// - sea, the sea's own warmth: Tejn harbour's water, DMI 2005 to 2024;
// - wet, the season's share of the year's precipitation: Bornholm's (DMI municipality 0400) 1991 to 2020;
// - cloud, the mean share of the sky covered by day at Hammer Odde (NOAA ISD 2015 to 2024), read by probes;
// - beam and glow, the sun's beam and the sky's glow through that cloud against a clear sky's: Kasten and Czeplak's
//   global 1 - 0.71 (N/8)^3.4 and diffuse share 0.3 + 0.7 (N/8)^2 averaged over Hammer Odde's daylight hours (R482);
// - humid0, the mean air's water against what air of its warmth holds, at Rønne (ISD);
// - rains, the share of hours with rain or snow falling at Hammer Odde (ISD);
// - rainWind and rainHumid, the wind and the relative humidity of the moist layer at 850 hPa when Hammer Odde reports rain
//   or snow falling: the mean of Greifswald's and Łeba's radiosondes at 00 and 12 UTC (NOAA IGRA2 2015 to 2024, R495),
//   the two soundings 150 km southwest and 170 km east of Bornholm.
export const SEASONS = [
  { t: 4.2, sea: 4.23, wet: 0.173, cloud: 0.55, beam: 0.496, glow: 1.252, humid0: 0.824, rains: 0.127, rainWind: 13.63, rainHumid: 0.853 },
  { t: 14.78, sea: 14.54, wet: 0.232, cloud: 0.395, beam: 0.665, glow: 1.23, humid0: 0.78, rains: 0.075, rainWind: 11.91, rainHumid: 0.857 },
  { t: 13.81, sea: 15.61, wet: 0.312, cloud: 0.462, beam: 0.604, glow: 1.267, humid0: 0.814, rains: 0.107, rainWind: 12.05, rainHumid: 0.861 },
  { t: 3.81, sea: 6.23, wet: 0.284, cloud: 0.755, beam: 0.276, glow: 1.308, humid0: 0.887, rains: 0.178, rainWind: 12.75, rainHumid: 0.847 },
];
export const SEASON_DAYS = 365.25 / 4; // real days of weather in each
// the game day in the middle of season s, the clock counting days from 1
export const midSeason = (s: number) => 1 + (YEAR_DAYS * (2 * s + 1)) / 8;
// How much colder, on a season's mean, the cold pooling on still, clear nights leaves the hollows where it lies deepest:
// src/sim/air.ts pooled() averaged over every hour of the island's own weather, Hammer Odde's sky and wind with Rønne's
// air water, 2015 to 2024 (bornholm.py pool; sec. 34) [derived]. Recompute it whenever pooled() or the weather changes.
export const POOL_C = [0.287, 0.29, 0.286, 0.158];
export const DIRS = 16; // wind directions and horizon bearings: k points the way (cos, sin) of 2πk/DIRS, x east, y south
const STEP = 1.5; // how far upwind each cell looks, in cells

// Water vapor's pressure in air saturated at a temperature, kPa (Tetens, FAO-56 eq. 11, R221).
export const esat = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
// The air's pressure at a height against sea level's (FAO-56 eq. 7, R221).
const pressure = (z: number) => ((293 - LAPSE * z) / 293) ** 5.26;

// Hammer Odde's wind rose, NOAA ISD 2015 to 2024: the share of hours the wind comes from each of 16 sectors, from north
// clockwise (sec. 34) [derived]. Bornholm's has two lobes, west-southwest and east. The moist layer's in the wet hours,
// at 850 hPa over Greifswald and Łeba (R495) [derived], is southwest to northwest, with little of the east's.
const ROSE = [0.025, 0.019, 0.029, 0.052, 0.118, 0.056, 0.03, 0.018, 0.053, 0.066, 0.132, 0.18, 0.148, 0.037, 0.018, 0.02];
const WET_ROSE = [0.0173, 0.0122, 0.0238, 0.0318, 0.0489, 0.0224, 0.0224, 0.0276, 0.0422, 0.0616, 0.1506, 0.1882, 0.2086, 0.0811, 0.0424, 0.0186];
// The wind at head height over open ground at an exposed coast, m/s, as an average over the year's weather: Hammer Odde's
// 6.26 m/s at 10 m brought down by the log profile over open ground (z0 0.03 m, sec. 14a) [derived].
const SEA_WIND = (6.26 * Math.log(2 / 0.03)) / Math.log(10 / 0.03);

// h: ground in meters. open: 1 over the sea and lakes.
export function climate(h: Float32Array, open: Uint8Array, rand: () => number): Climate {
  // The way the wind prevails is the island's own draw [design]; the roses are Hammer Odde's and the moist layer's, turned
  // together so the surface rose's mean way points that way.
  const prevailing = rand() * Math.PI * 2, shift = prevailing - meanWay(ROSE);
  const rose = turned(ROSE, shift), wetRose = turned(WET_ROSE, shift);
  const z = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) z[i] = Math.max(0, h[i]);
  // How far a place stands above or below the ground around it, some 600 m out [design]: knolls and ridges catch the
  // wind, and hollows and valley floors gather the cold air that slides off the slopes on still nights.
  const around = blur(z, 8);
  const a = airflow(z, open, around, rose);
  const precipBy = orographic(z, wetRose);
  const precip = new Float32Array(LEN);
  for (const r of precipBy) for (let i = 0; i < LEN; i++) precip[i] += r[i];
  const lit = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) lit[i] = h[i] > -2 ? 1 : 0;
  const shape = horizons(z, lit);
  // How often each place stands inside the cloud, by season: the chance the cloud's base is at or below it.
  const fogBy = SEASONS.map((_, si) => Float32Array.from(z, (zi) => inCloud(si, zi)));
  const fog = new Float32Array(LEN);
  for (const f of fogBy) for (let i = 0; i < LEN; i++) fog[i] += f[i] / SEASONS.length;
  const seasons: Season[] = SEASONS.map((_, si) => ({ precip: precipBy[si], pet: new Float32Array(LEN), sun: new Float32Array(LEN), temp: new Float32Array(LEN), humid: new Float32Array(LEN), snowpack: new Float32Array(LEN) }));
  const clearBy = SEASONS.map(() => new Float32Array(LEN)), flat = SEASONS.map((_, si) => sunlight(si, shape, lit, fogBy[si], seasons[si].sun, clearBy[si]));

  // ---------- warmth ----------
  // Cold air drains off the slopes on still, clear nights and lies in the hollows and on the valley floors. How deep a
  // hollow, how gentle and how sheltered it must be are hand-set [gap: no measured law found].
  const pool = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) continue;
    const slope = Math.hypot(shape.nx[i], shape.ny[i]) / shape.nz[i];
    pool[i] = ramp(around[i] - z[i], 3, 40) * (1 - ramp(slope, 0.06, 0.25)) * (1 - 0.7 * a.windShare[i]);
  }
  // A season's mean air: the air at sea level, which is a coastal station's and so already the sea's doing (an island
  // this small stays marine across), cooled with height, warmed on slopes that get more sun than open level ground by
  // Byram and Jemison's balance for a sunlit surface, ΔT = ΔI / (32.7 + 42.2 U) with ΔI in W/m² (11.574 for each MJ/m² a
  // day) and U the wind (sec. 11, R70; an upper bound for the air at head height), and chilled where the night's cold
  // pools. The air's water is the season's at sea level, thinning with the air's pressure as it climbs.
  const temp = new Float32Array(LEN);
  for (let si = 0; si < SEASONS.length; si++) {
    const { t, sea, humid0 } = SEASONS[si], T = seasons[si].temp, sun = seasons[si].sun, H = seasons[si].humid, e0 = humid0 * esat(t);
    for (let i = 0; i < LEN; i++) {
      T[i] = h[i] < 0 && open[i] ? sea : t - LAPSE * z[i] + (11.574 * (sun[i] - flat[si])) / (32.7 + 42.2 * a.breeze[i]) - POOL_C[si] * pool[i];
      H[i] = Math.min(1, (e0 * pressure(z[i])) / esat(T[i]));
      temp[i] += T[i] / SEASONS.length;
    }
  }
  const { snow, snowCover, cover, albedo } = snowYear(open, seasons, clearBy, z, a.breeze);
  const pet = new Float32Array(LEN);
  for (let si = 0; si < SEASONS.length; si++) penman(seasons[si], clearBy[si], z, a.breeze, cover[si], albedo[si], pet);
  const sun = new Float32Array(LEN), flatYear = flat.reduce((x, y) => x + y, 0);
  for (let i = 0; i < LEN; i++) { for (const s of seasons) sun[i] += s.sun[i]; sun[i] /= flatYear; }
  const { windShare, salt, breeze, lee } = a;
  return { wind: [Math.cos(prevailing), Math.sin(prevailing)], precip, seasons, snow, snowCover, fog, temp, pet, sun, sky: shape.sky, pool, breeze, lee, windShare, salt };
}

export type Season = {
  precip: Float32Array; // mm over the season
  pet: Float32Array; // evaporative demand, mm over the season (FAO-56 reference evapotranspiration, over snow where it lies)
  sun: Float32Array; // sunlight reaching the ground, MJ/m² a day: on its own slope, in its hills' shadows, through cloud
  temp: Float32Array; // mean air, °C
  humid: Float32Array; // mean relative humidity, 0..1
  snowpack: Float32Array; // water lying as snow, mm, the season's mean
};
export type Climate = {
  wind: [number, number]; // the way the prevailing wind blows
  precip: Float32Array; // mm a year
  seasons: Season[]; // the same and more for each of the game's seasons
  snow: Float32Array; // share of the year's precipitation that falls as snow
  snowCover: Float32Array; // share of the ground snow covers, over the year (Roesch's fraction of its snowpack each day)
  fog: Float32Array; // share of the year's hours spent inside cloud
  temp: Float32Array; // annual mean, °C
  pet: Float32Array; // evaporative demand, mm a year
  sun: Float32Array; // the year's sunlight on the ground against open level ground's
  sky: Float32Array; // share of the sky's dome open overhead, 0..1
  pool: Float32Array; // 0..1 how much cold air settles there on still, clear nights
  breeze: Float32Array; // mean wind at head height, m/s
  lee: Uint8Array; // DIRS per cell: the wind there, blowing toward bearing k, as hundredths of the wind over open ground at the coast
  windShare: Float32Array; // 0 sheltered .. 1 open: the year's mean of the wind there against the coast's, at most 1
  salt: Float32Array; // 0 .. 1 sea salt off windward shores, 1 at the waterline
};

// A measured rose (shares from north clockwise) as the code's bearings (k toward (cos, sin) of 2πk/DIRS, x east, y south).
const codeRose = (fromNorth: number[]) => Array.from({ length: DIRS }, (_, k) => fromNorth[(k + 12) % DIRS]);
// The way a measured rose's mean points, as an angle of the code's bearings.
function meanWay(fromNorth: number[]) {
  const code = codeRose(fromNorth);
  let cx = 0, cy = 0;
  for (let k = 0; k < DIRS; k++) { cx += code[k] * Math.cos((2 * Math.PI * k) / DIRS); cy += code[k] * Math.sin((2 * Math.PI * k) / DIRS); }
  return Math.atan2(cy, cx);
}
// A measured rose in the code's bearings turned by an angle, read between the sectors it falls between [design].
function turned(fromNorth: number[], angle: number) {
  const code = codeRose(fromNorth), shift = (angle / (2 * Math.PI)) * DIRS;
  const out = Array.from({ length: DIRS }, (_, k) => {
    const u = (((k - shift) % DIRS) + DIRS) % DIRS, k0 = Math.floor(u), f = u - k0;
    return code[k0] * (1 - f) + code[(k0 + 1) % DIRS] * f;
  });
  const sum = out.reduce((s, v) => s + v, 0);
  return out.map((v) => v / sum);
}

// ---------- rain ----------
// A season's precipitation: the fronts' own, Bornholm's yearly 634 mm on its coast (the mean of DMI's coastal 10 km cells,
// 1991 to 2020) shared out by season (sec. 34) [derived], falling in the season's wet hours; on it, where the ground lifts
// the moist air, Smith and Barstad's linear orographic rain (R487) [cited]:
//   P^(k, l) = C_w i σ h^(k, l) / ((1 - i m H_w)(1 + i σ τ_c)(1 + i σ τ_f)), σ = U k + V l,
//   m² = (N_m² - σ²) / σ² (k² + l²), m taking σ's sign where real and positive imaginary where not,
//   C_w = ρ_s Γ_m / γ, ρ_s the vapour density of saturated air at the season's warmth,
// with N_m 0.005 1/s, H_w 2500 m, τ_c = τ_f = 1000 s, γ -5.8 and Γ_m -6.5 °C/km (R487), the rate never below none. The
// wind is the moist layer's, at 850 hPa in the wet hours (SEASONS rainWind), blowing as often from each way as its wet
// rose has it; the theory takes that layer saturated, and its measured humidity there (rainHumid) scales ρ_s [design].
const P_BG = 634, N_M = 0.005, H_W = 2500, TAU_C = 1000, TAU_F = 1000, GAMMA_RATIO = 6.5 / 5.8, R_V = 461.5;
// The theory filters out every scale much under U τ (some 13 km), so it runs on cells four times as wide, on a grid four
// times as wide as the island so that rain carried downwind does not come round again [design].
const COARSE = 4, NC = N / COARSE, M = 4 * NC;

function orographic(z: Float32Array, wetRose: number[]) {
  const re = new Float64Array(M * M), im = new Float64Array(M * M);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) re[((y / COARSE) | 0) * M + ((x / COARSE) | 0)] += z[y * N + x] / (COARSE * COARSE);
  fft2(re, im, false);
  const dk = (2 * Math.PI) / (M * COARSE * CELL), wave = (i: number) => (i < M / 2 ? i : i - M) * dk;
  const pre = new Float64Array(M * M), pim = new Float64Array(M * M), coarse = new Float64Array(NC * NC);
  return SEASONS.map(({ t, wet, rains, rainWind, rainHumid }) => {
    const out = new Float32Array(LEN), hours = SEASON_DAYS * 24 * rains, bg = (P_BG * wet) / hours;
    const Cw = ((rainHumid * esat(t) * 1000) / (R_V * (t + 273.15))) * GAMMA_RATIO;
    for (let d = 0; d < DIRS; d++) {
      if (wetRose[d] <= 0) continue;
      const U = rainWind * Math.cos((2 * Math.PI * d) / DIRS), V = rainWind * Math.sin((2 * Math.PI * d) / DIRS);
      for (let j = 0; j < M; j++)
        for (let i = 0; i < M; i++) {
          const n = j * M + i, k = wave(i), l = wave(j), sg = U * k + V * l;
          if (sg === 0) { pre[n] = 0; pim[n] = 0; continue; }
          const m2 = ((N_M * N_M - sg * sg) / (sg * sg)) * (k * k + l * l);
          // 1 - i m H_w: m real (waves carry the lift up), or m = i μ (the lift dies away with height)
          let dr = 1, di = 0;
          if (m2 >= 0) di = -Math.sign(sg) * Math.sqrt(m2) * H_W; else dr = 1 + Math.sqrt(-m2) * H_W;
          // times (1 + i σ τ_c)(1 + i σ τ_f)
          const ar = 1 - sg * sg * TAU_C * TAU_F, ai = sg * (TAU_C + TAU_F), br = dr * ar - di * ai, bi = dr * ai + di * ar;
          // C_w i σ h over that
          const nr = -Cw * sg * im[n], ni = Cw * sg * re[n], den = br * br + bi * bi;
          pre[n] = (nr * br + ni * bi) / den; pim[n] = (ni * br - nr * bi) / den;
        }
      fft2(pre, pim, true);
      for (let y = 0; y < NC; y++) for (let x = 0; x < NC; x++) coarse[y * NC + x] = pre[y * M + x] * 3600; // mm an hour
      const share = wetRose[d] * hours;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const cx = clamp((x + 0.5) / COARSE - 0.5, 0, NC - 1.001), cy = clamp((y + 0.5) / COARSE - 0.5, 0, NC - 1.001);
          const x0 = cx | 0, y0 = cy | 0, fx = cx - x0, fy = cy - y0, c = y0 * NC + x0;
          const p = (coarse[c] * (1 - fx) + coarse[c + 1] * fx) * (1 - fy) + (coarse[c + NC] * (1 - fx) + coarse[c + NC + 1] * fx) * fy;
          out[y * N + x] += share * Math.max(0, bg + p);
        }
    }
    return out;
  });
}

// The complex Fourier transform of an M × M grid in place (radix 2), rows then columns; the inverse scaled by 1 / M².
function fft2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const r = new Float64Array(M), q = new Float64Array(M);
  for (let pass = 0; pass < 2; pass++)
    for (let a = 0; a < M; a++) {
      const at = (b: number) => (pass ? b * M + a : a * M + b);
      for (let b = 0; b < M; b++) { r[b] = re[at(b)]; q[b] = im[at(b)]; }
      fft(r, q, inverse);
      for (let b = 0; b < M; b++) { re[at(b)] = r[b]; im[at(b)] = q[b]; }
    }
  if (inverse) for (let n = 0; n < M * M; n++) { re[n] /= M * M; im[n] /= M * M; }
}
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ---------- cloud on the hills ----------
// The chance a place this high above the sea stands inside the cloud in season si: at Hammer Odde (9 m up), the share
// of hours with fog (under 1 km of sight) or a ceiling (5 oktas or more) based at or below the height, NOAA ISD 2015 to
// 2024 (sec. 34) [derived]; read straight between the heights, the highest held above them.
const FOG_Z = [0, 25, 50, 100, 150, 200, 300, 500];
const FOG = [
  [0.0213, 0.0214, 0.0342, 0.0661, 0.0796, 0.11, 0.1526, 0.2375],
  [0.0121, 0.0122, 0.0192, 0.0318, 0.0374, 0.0473, 0.0614, 0.0901],
  [0.0131, 0.0131, 0.0177, 0.0314, 0.0393, 0.0599, 0.094, 0.1624],
  [0.0071, 0.0071, 0.0137, 0.0541, 0.0799, 0.1374, 0.2225, 0.3981],
];
function inCloud(si: number, z: number) {
  const row = FOG[si];
  for (let n = 1; n < FOG_Z.length; n++) if (z <= FOG_Z[n]) return row[n - 1] + ((row[n] - row[n - 1]) * (z - FOG_Z[n - 1])) / (FOG_Z[n] - FOG_Z[n - 1]);
  return row[row.length - 1];
}

// ---------- wind and salt ----------
// Behind a break the wind comes back by how many of the break's heights downwind a place stands: half the open wind at 5,
// 0.65 at 10, 0.8 at 15, 0.85 at 20 and all of it by 30, as behind a dense windbreak (R489) [cited; ground that falls
// away is a solid break, not a porous one: gap]. The ground upwind breaks the wind where it falls away steeper than 0.3,
// past which Taylor and Lee's attached flow over a slope no longer holds (R488); gentler ground the wind follows.
const WAKE_X = [5, 10, 15, 20, 30], WAKE = [0.5, 0.65, 0.8, 0.85, 1], PARTS = 0.3;
function wake(xh: number) {
  if (xh <= WAKE_X[0]) return WAKE[0];
  for (let n = 1; n < WAKE_X.length; n++) if (xh <= WAKE_X[n]) return WAKE[n - 1] + ((WAKE[n] - WAKE[n - 1]) * (xh - WAKE_X[n - 1])) / (WAKE_X[n] - WAKE_X[n - 1]);
  return 1;
}
// Over a knoll or ridge the wind quickens by Taylor and Lee's B h / L1 at the top, h its height above the ground around
// and L1 its half-length, B 1.6 for a three-dimensional hill (R488) [cited], L1 the 600 m "around" stands for [design].
const TAYLOR_LEE = 1.6, HALF_LENGTH = 600;
// Sea salt falls off exponentially with the distance the air has come over land (R490), as two exponentials: the spray
// of the breaking waves within some 250 m [gap: a research note's 140 to 400 m, unverified], and the finer salt the air
// carries far inland, down to a fifth of the coast's 50 km in (R491), so an e-fold of 50 / ln 5 km; the far salt's share
// at the waterline is a tenth [gap: not measured here].
const SPRAY_M = 250, FAR_M = 50000 / Math.log(5), FAR = 0.1;

// The air blowing across the island from each direction in turn, weighted by the wind rose (share): how hard it blows at
// head height, how much of it a place sees, and how much salt it brings.
function airflow(z: Float32Array, open: Uint8Array, around: Float32Array, share: number[]) {
  const windShare = new Float32Array(LEN), salt = new Float32Array(LEN), breeze = new Float32Array(LEN), lee = new Uint8Array(LEN * DIRS);
  // the air arriving at each cell: the top of the break it last passed (none: -Infinity) and how far back, and how far it
  // has come over land
  const top = new Float32Array(LEN), since = new Float32Array(LEN), shore = new Float32Array(LEN);
  const order = new Int32Array(LEN), stepM = STEP * CELL;
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), f = share[k];
    downwind(order, c, s);
    for (let n = 0; n < LEN; n++) {
      const i = order[n], x = i % N, y = (i - x) / N, ux = x - c * STEP, uy = y - s * STEP;
      const off = ux < 0 || uy < 0 || ux > N - 1 || uy > N - 1;
      let j = 0, fx = 0, fy = 0;
      if (!off) { const x0 = Math.min(N - 2, ux | 0), y0 = Math.min(N - 2, uy | 0); fx = ux - x0; fy = uy - y0; j = y0 * N + x0; }
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const up = off ? 0 : z[j] * w00 + z[j + 1] * w10 + z[j + N] * w01 + z[j + N + 1] * w11;
      shore[i] = open[i] || off ? 0 : shore[j] * w00 + shore[j + 1] * w10 + shore[j + N] * w01 + shore[j + N + 1] * w11 + stepM;
      // The break: the one the nearest upwind cell carries [design], or the ground just upwind if it falls away steeply
      // enough to part the flow, whichever leaves less of the wind.
      const near = off ? -1 : j + (fx >= 0.5 ? 1 : 0) + (fy >= 0.5 ? N : 0);
      let T = near < 0 ? -Infinity : top[near], X = near < 0 ? 0 : since[near] + stepM, v = T > z[i] ? wake(X / (T - z[i])) : 1;
      if (!off && (up - z[i]) / stepM > PARTS) {
        const w = wake(stepM / (up - z[i]));
        if (w <= v) { T = up; X = stepM; v = w; }
      }
      if (!(T > z[i])) T = -Infinity;
      top[i] = T; since[i] = X;
      if (open[i]) v = 1;
      else v *= 1 + (TAYLOR_LEE * Math.max(0, z[i] - around[i])) / HALF_LENGTH;
      lee[i * DIRS + k] = Math.min(255, Math.round(v * 100));
      breeze[i] += f * SEA_WIND * v;
      windShare[i] += f * v;
      salt[i] += f * ((1 - FAR) * Math.exp(-shore[i] / SPRAY_M) + FAR * Math.exp(-shore[i] / FAR_M));
    }
  }
  for (let i = 0; i < LEN; i++) windShare[i] = Math.min(1, windShare[i]);
  return { windShare, salt, breeze, lee };
}

// Cells in downwind order, by counting sort on their position along the wind. The slices are thinner than the gap
// between a cell and the upwind corners it reads (at least 1.5 - √2 cells), so every read is already settled.
function downwind(order: Int32Array, c: number, s: number) {
  const SLICE = 0.05, lo = Math.min(0, (N - 1) * c) + Math.min(0, (N - 1) * s);
  const key = new Int32Array(LEN), count = new Int32Array(Math.ceil((N * 2) / SLICE) + 2);
  for (let i = 0; i < LEN; i++) {
    key[i] = Math.floor(((i % N) * c + Math.floor(i / N) * s - lo) / SLICE);
    count[key[i] + 1]++;
  }
  for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
  for (let i = 0; i < LEN; i++) order[count[key[i]]++] = i;
}

type Shape = { nx: Float32Array; ny: Float32Array; nz: Float32Array; hz: Float32Array; sky: Float32Array };
// Which way each cell faces (its unit normal: x east, y south, z up), and its horizon along each bearing, out to 8 km, as
// the tangent of the angle it stands at; sky, the share of the dome it leaves open.
function horizons(z: Float32Array, lit: Uint8Array): Shape {
  const at = (x: number, y: number) => z[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)];
  const nx = new Float32Array(LEN), ny = new Float32Array(LEN), nz = new Float32Array(LEN), sky = new Float32Array(LEN).fill(1);
  const hz = new Float32Array(LEN * DIRS), reach: number[] = [];
  for (let d = 1; d < 110; d *= 1.2) reach.push(d);
  const cs = Array.from({ length: DIRS }, (_, k) => Math.cos((k / DIRS) * Math.PI * 2)), sn = Array.from({ length: DIRS }, (_, k) => Math.sin((k / DIRS) * Math.PI * 2));
  let peak = 0;
  for (let i = 0; i < LEN; i++) peak = Math.max(peak, z[i]);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * CELL), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * CELL), g = Math.hypot(gx, gy, 1);
    nx[i] = -gx / g; ny[i] = -gy / g; nz[i] = 1 / g;
    if (!lit[i]) continue;
    let open2 = 0;
    for (let k = 0; k < DIRS; k++) {
      const c = cs[k], s = sn[k];
      let top = 0;
      for (let r = 0; r < reach.length; r++) {
        const d = reach[r], px = x + c * d, py = y + s * d;
        // nothing further out could stand higher in the sky than what already does
        if (px < 0 || py < 0 || px > N - 1 || py > N - 1 || peak - z[i] <= top * d * CELL) break;
        top = Math.max(top, (sample(z, px, py) - z[i]) / (d * CELL));
      }
      hz[i * DIRS + k] = top;
      open2 += 1 / (1 + top * top); // cos² of the horizon's angle
    }
    sky[i] = open2 / DIRS;
  }
  return { nx, ny, nz, hz, sky };
}

// Season si's middle day through the hours a quarter at a time: the sun's beam at normal incidence and the clear sky's glow
// on level ground, W/m², by the air mass the light crosses (Kasten and Young; Meinel's beam; Liu and Jordan's diffuse
// share). On each cell: the beam where the hills leave the sun in sight, by how squarely the slope faces it, and the glow
// of the share of sky it sees, each through the season's cloud (SEASONS beam and glow); inside the cloud (fog, the share
// of the season it stands in cloud) a nimbostratus overcast's 0.16 of a clear day's light on level ground, all of it glow
// (R482). Fills out (MJ/m² a day through the season's cloud) and clear (the same under a clear sky); returns the same for
// open level ground at the sea.
const IN_CLOUD = 0.16;
function sunlight(si: number, shape: Shape, lit: Uint8Array, fog: Float32Array, out: Float32Array, clear: Float32Array) {
  const S0 = 1361, DT = 900, { beam: tb, glow: tg } = SEASONS[si], { nx, ny, nz, hz, sky } = shape;
  const sx: number[] = [], sy: number[] = [], sz: number[] = [], kf: number[] = [], tan: number[] = [], beam: number[] = [];
  let glow = 0, levelBeam = 0;
  for (let hour = 0; hour < 24; hour += DT / 3600) {
    const b = sunAt(midSeason(si), hour), sinEl = Math.sin(b.el);
    if (sinEl <= 0.005) continue;
    const am = 1 / (sinEl + 0.50572 * (b.el / (Math.PI / 180) + 6.07995) ** -1.6364), bn = S0 * 0.7 ** (am ** 0.678), cosEl = Math.cos(b.el);
    sx.push(cosEl * b.dir[0]); sy.push(cosEl * b.dir[1]); sz.push(sinEl); tan.push(b.tan); beam.push(bn);
    kf.push((((Math.atan2(b.dir[1], b.dir[0]) / (Math.PI * 2)) * DIRS) % DIRS + DIRS) % DIRS);
    glow += S0 * sinEl * Math.max(0, 0.271 - (0.294 * bn) / S0);
    levelBeam += bn * sinEl;
  }
  const MJ = DT / 1e6, n = sz.length, level = levelBeam + glow, cloudy = tb * levelBeam + tg * glow;
  for (let i = 0; i < LEN; i++) {
    const p = fog[i];
    if (!lit[i]) { out[i] = ((1 - p) * cloudy + p * IN_CLOUD * level) * MJ; clear[i] = level * MJ; continue; }
    let b = 0;
    for (let q = 0; q < n; q++) {
      const k0 = Math.floor(kf[q]), k1 = (k0 + 1) % DIRS, t = kf[q] - k0;
      const face = nx[i] * sx[q] + ny[i] * sy[q] + nz[i] * sz[q];
      if (face > 0 && tan[q] > hz[i * DIRS + k0] * (1 - t) + hz[i * DIRS + k1] * t) b += beam[q] * face;
    }
    out[i] = ((1 - p) * (tb * b + tg * glow * sky[i]) + p * IN_CLOUD * level * sky[i]) * MJ;
    clear[i] = (b + glow * sky[i]) * MJ;
  }
  return cloudy * MJ;
}

// ---------- snow ----------
// Precipitation falls as snow by Dai's land fit, half of it at 1.3 °C with a logistic spread of 0.67 °C (R492), for a
// day's mean air widened by the swing of a wet day's air through it, a cosine of half Rønne's wet-day range (air.ts RANGE
// rain: 3.44, 4.94, 3.99 and 2.92 °C by season; sec. 33) [derived]: s = sqrt(0.67² + 3 σ² / π²), σ = range / (2 √2).
const SNOW_HALF = 1.3, SNOW_SPREAD = [3.44, 4.94, 3.99, 2.92].map((r) => Math.sqrt(0.67 ** 2 + (3 * (r / (2 * Math.SQRT2)) ** 2) / Math.PI ** 2));
// The day's mean air stands from its time of year's by a spread of 2.28, 2.51, 2.16 and 2.57 °C by season, and keeps
// 0.779 of its standing from one day to the next: Rønne's days, 2015 to 2024 (bornholm.py ronne; sec. 34) [derived].
// The snow year runs that weather as one long draw of its own [design: the same for every island, so the climate
// doesn't hang on one island's luck], ten years of it after one to settle, as many winters as DMI's snow record holds.
const DAY_SPREAD = [2.28, 2.51, 2.16, 2.57], DAY_KEEPS = 0.779, YEARS = 10;
// Lying snow melts by its energy balance (Ismail et al., R493): Q = (1 - α) S + L_net + ρ c_p C_H u T + ρ λ C_H u (q -
// q_s(0)) with the surface at 0 °C; every 0.334 MJ/m² of Q melts a millimetre of water (the latent heat of fusion).
// α 0.9 for new snow and 0.45 for old (R493) [cited; how fast one turns into the other: gap], new on a day most of whose
// precipitation fell as snow; C_H 0.0024 at 2 m (R493); L_net the sky's longwave as FAO-56 eq. 39 has it (R221) less a
// surface at 0 °C's own; c_p dry air's 1005 J/kg K and λ water's latent heat at 0 °C, 2.501 MJ/kg.
const FRESH = 0.9, OLD = 0.45, C_H = 0.0024, FUSION = 0.334, CP = 1005, VAPORIZE = 2.501e6, SIGMA = 4.903e-9, K0 = 273.16, K04 = K0 ** 4;

function snowYear(open: Uint8Array, seasons: Season[], clearBy: Float32Array[], z: Float32Array, breeze: Float32Array) {
  const snow = new Float32Array(LEN), snowCover = new Float32Array(LEN);
  const cover = SEASONS.map(() => new Float32Array(LEN)), albedo = SEASONS.map(() => new Float32Array(LEN).fill(OLD));
  const DAYS = 365 * (YEARS + 1);
  const C1 = new Float32Array(365), S1 = new Float32Array(365), C2 = new Float32Array(365), SI = new Uint8Array(365);
  for (let d = 0; d < 365; d++) {
    const th = 2 * Math.PI * (d / 365 - 1 / 8);
    C1[d] = Math.cos(th); S1[d] = Math.sin(th); C2[d] = Math.cos(2 * th); SI[d] = Math.min(3, Math.floor(d / SEASON_DAYS));
  }
  // the weather: each day's standing from its time of year, in °C
  const anomaly = new Float32Array(DAYS), draw = mulberry(0x5eed);
  let zd = 0, coldest = 0;
  for (let d = 0; d < DAYS; d++) {
    const n = Math.sqrt(-2 * Math.log(1 - draw())) * Math.cos(2 * Math.PI * draw());
    zd = DAY_KEEPS * zd + Math.sqrt(1 - DAY_KEEPS * DAY_KEEPS) * n;
    anomaly[d] = DAY_SPREAD[SI[d % 365]] * zd;
    coldest = Math.min(coldest, anomaly[d]);
  }
  // a day warmer than this in season s lets no more than a flake in two thousand fall as snow
  const warm = Float64Array.from(SNOW_SPREAD, (s) => SNOW_HALF + 7.6 * s), warmest = Math.max(...warm), days = [0, 0, 0, 0], inv = Float64Array.from(SNOW_SPREAD, (s) => 1 / s);
  for (let d = 0; d < 365; d++) days[SI[d]]++;
  // each season's water in the air (kPa), the dew point it condenses at, and what the sky sends back at it
  const P = new Float64Array(4), R = new Float64Array(4), F = new Float64Array(4), E = new Float64Array(4), dew = new Float64Array(4), back = new Float64Array(4);
  const lying = new Float64Array(4), whiteness = new Float64Array(4), packs = new Float64Array(4);
  const base = new Float64Array(365);
  // The share falling as snow by the logistic's argument, esat by the air's warmth and the ground snow covers by its
  // water, read between values a hundredth apart [design: the snow year asks for each hundreds of millions of times].
  const LO = -40, HI = 30, STEPS = (HI - LO) * 100, logit = new Float64Array(STEPS + 2), sat = new Float64Array(STEPS + 2), covers = new Float64Array(6002);
  for (let n = 0; n <= STEPS + 1; n++) { const x = LO + n / 100; logit[n] = 1 / (1 + Math.exp(x)); sat[n] = esat(x); }
  for (let n = 0; n < covers.length; n++) covers[n] = 0.95 * Math.tanh(n / 1000);
  // Each game tile (two cells a side) runs one snow year on its land cells' means [design: four times fewer runs].
  const T4 = new Float64Array(4), cells = new Int32Array(4);
  for (let i = 0; i < LEN; i++) {
    const tx = i % N, ty = (i - tx) / N;
    if (tx % 2 || ty % 2) continue;
    let n = 0;
    for (const j of [i, i + 1, i + N, i + N + 1]) if (!open[j]) cells[n++] = j;
    if (!n) continue;
    const mean4 = (f: Float32Array) => { let sum = 0; for (let c = 0; c < n; c++) sum += f[cells[c]]; return sum / n; };
    for (let s = 0; s < 4; s++) T4[s] = mean4(seasons[s].temp);
    const mean = (T4[0] + T4[1] + T4[2] + T4[3]) / 4, a1 = (T4[0] - T4[2]) / 2, b1 = (T4[1] - T4[3]) / 2, a2 = (T4[0] - T4[1] + T4[2] - T4[3]) / 4;
    if (mean - Math.hypot(a1, b1) - Math.abs(a2) + coldest > warmest) continue;
    for (let d = 0; d < 365; d++) base[d] = mean + a1 * C1[d] + b1 * S1[d] + a2 * C2[d];
    let wet = 0;
    for (let s = 0; s < 4; s++) {
      P[s] = mean4(seasons[s].precip) / SEASON_DAYS; R[s] = mean4(seasons[s].sun);
      F[s] = Math.min(1, R[s] / Math.max(0.1, mean4(clearBy[s])));
      E[s] = mean4(seasons[s].humid) * esat(T4[s]);
      const g = Math.log(E[s] / 0.6108);
      dew[s] = (237.3 * g) / (17.27 - g);
      back[s] = 1 - (0.34 - 0.14 * Math.sqrt(E[s])) * (1.35 * F[s] - 0.35);
      lying[s] = 0; whiteness[s] = 0; packs[s] = 0;
      wet += P[s] * days[s] * YEARS;
    }
    const u = Math.max(0.5, mean4(breeze)), p = 101.3 * pressure(mean4(z)), qs0 = (0.622 * esat(0)) / p;
    const turb = (((p * 1000) / 287.05) * C_H * u * 86400) / 1e6; // MJ/m² a day for each J/kg of difference, over the air's kelvins
    let pack = 0, fell = 0;
    for (let y = 0, d = 0; y <= YEARS; y++)
      for (let day = 0; day < 365; day++, d++) {
        const si = SI[day], T = base[day] + anomaly[d];
        if (pack === 0 && T > warm[si]) continue;
        const rain = P[si], v = (Math.min(HI, Math.max(LO, (T - SNOW_HALF) * inv[si])) - LO) * 100, k = v | 0, flakes = rain * (logit[k] + (logit[k + 1] - logit[k]) * (v - k));
        pack += flakes;
        // air colder than its season's dew point holds only what it can
        let ea = E[si], sky = back[si];
        if (T < dew[si]) {
          const w = (Math.max(LO, T) - LO) * 100, j = w | 0;
          ea = sat[j] + (sat[j + 1] - sat[j]) * (w - j);
          sky = 1 - (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * F[si] - 0.35);
        }
        const alpha = flakes > rain / 2 ? FRESH : OLD, K = T + K0, K2 = K * K;
        const Q = (1 - alpha) * R[si] + SIGMA * (sky * K2 * K2 - K04) + (turb / K) * (CP * T + VAPORIZE * ((0.622 * ea) / p - qs0));
        pack = Math.max(0, pack - Math.max(0, Q) / FUSION);
        if (y === 0) continue;
        fell += flakes;
        if (pack === 0) continue;
        const q = Math.min(6000, pack * 100), m = q | 0, c = covers[m] + (covers[m + 1] - covers[m]) * (q - m);
        packs[si] += pack; lying[si] += c; whiteness[si] += c * alpha;
      }
    for (let c = 0; c < n; c++) {
      const j = cells[c];
      snow[j] = wet > 0 ? fell / wet : 0;
      for (let s = 0; s < 4; s++) {
        seasons[s].snowpack[j] = packs[s] / (SEASON_DAYS * YEARS);
        cover[s][j] = lying[s] / (SEASON_DAYS * YEARS);
        snowCover[j] += lying[s] / (365 * YEARS);
        if (lying[s] > 0) albedo[s][j] = whiteness[s] / lying[s];
      }
    }
  }
  return { snow, snowCover, cover, albedo };
}

// A small seeded generator of uniform draws in [0, 1) (mulberry32).
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FAO-56's reference evapotranspiration (Penman-Monteith over short grass, R221) for a season, into its pet and added to
// the year's: the sun's net warmth less the ground's own glow to the sky, and the wind carrying off damp air for dry.
// Where snow lies (cover, its share of the ground) the same over snow: the snow's own albedo for grass's 0.23, its
// surface held at 0 °C, and ice's latent heat of sublimation, 2.834 MJ/kg, for water's (sec. 34) [derived].
function penman(s: Season, clear: Float32Array, z: Float32Array, breeze: Float32Array, cover: Float32Array, albedo: Float32Array, year: Float32Array) {
  const { temp: T, humid, sun, pet: E } = s, es0 = esat(0);
  for (let i = 0; i < LEN; i++) {
    const t = T[i], es = esat(t), ea = es * humid[i], d = (4098 * es) / (t + 237.3) ** 2, u = Math.max(0.5, breeze[i]);
    const gamma = 0.000665 * 101.3 * pressure(z[i]);
    const rnl = 4.903e-9 * (t + 273.16) ** 4 * (0.34 - 0.14 * Math.sqrt(ea)) * (1.35 * Math.min(1, sun[i] / Math.max(0.1, clear[i])) - 0.35);
    const aero = ((gamma * 900) / (t + 273)) * u, den = d + gamma * (1 + 0.34 * u);
    const grass = Math.max(0, (0.408 * d * (0.77 * sun[i] - rnl) + aero * (es - ea)) / den);
    const c = cover[i], onSnow = c > 0 ? Math.max(0, (0.353 * d * ((1 - albedo[i]) * sun[i] - rnl) + aero * (es0 - ea)) / den) : 0;
    E[i] = ((1 - c) * grass + c * onSnow) * SEASON_DAYS;
    year[i] += E[i];
  }
}
