// The climate's constants and types, the island standing for a Baltic one with Bornholm's climate (55.1 degrees north;
// docs/research/fire-constants.md sec. 34): the seasons' measured weather, the wind roses, the cloud, wake, salt and snow
// laws' parameters. The fields are made on the GPU (src/gpu/terrain/rain.ts and climate.ts); the sim and the kernels read
// the numbers from here.
import { YEAR_DAYS } from "../sim/sky";
import { N } from "./grid";

// °C lost per meter climbed: the standard atmosphere's lapse rate (sec. 34, R494).
export const LAPSE = 0.0065;
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
export const STEP = 1.5; // how far upwind each cell looks, in cells

// Water vapor's pressure in air saturated at a temperature, kPa (Tetens, FAO-56 eq. 11, R221).
export const esat = (t: number) => 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
// The air's pressure at a height against sea level's (FAO-56 eq. 7, R221).
export const pressure = (z: number) => ((293 - LAPSE * z) / 293) ** 5.26;

// Hammer Odde's wind rose, NOAA ISD 2015 to 2024: the share of hours the wind comes from each of 16 sectors, from north
// clockwise (sec. 34) [derived]. Bornholm's has two lobes, west-southwest and east. The moist layer's in the wet hours,
// at 850 hPa over Greifswald and Łeba (R495) [derived], is southwest to northwest, with little of the east's.
export const ROSE = [0.025, 0.019, 0.029, 0.052, 0.118, 0.056, 0.03, 0.018, 0.053, 0.066, 0.132, 0.18, 0.148, 0.037, 0.018, 0.02];
export const WET_ROSE = [0.0173, 0.0122, 0.0238, 0.0318, 0.0489, 0.0224, 0.0224, 0.0276, 0.0422, 0.0616, 0.1506, 0.1882, 0.2086, 0.0811, 0.0424, 0.0186];
// The wind at head height over open ground at an exposed coast, m/s, as an average over the year's weather: Hammer Odde's
// 6.26 m/s at 10 m brought down by the log profile over open ground (z0 0.03 m, sec. 14a) [derived].
export const SEA_WIND = (6.26 * Math.log(2 / 0.03)) / Math.log(10 / 0.03);

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
export function meanWay(fromNorth: number[]) {
  const code = codeRose(fromNorth);
  let cx = 0, cy = 0;
  for (let k = 0; k < DIRS; k++) { cx += code[k] * Math.cos((2 * Math.PI * k) / DIRS); cy += code[k] * Math.sin((2 * Math.PI * k) / DIRS); }
  return Math.atan2(cy, cx);
}
// A measured rose in the code's bearings turned by an angle, read between the sectors it falls between [design].
export function turned(fromNorth: number[], angle: number) {
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
// with N_m 0.005 1/s, H_w 2500 m, γ -5.8 and Γ_m -6.5 °C/km (R487; the paper's τ_c = τ_f = 1000 s, which the island's delays
// replace by the water's phase, src/gpu/terrain/rain.ts), the rate never below none. The
// wind is the moist layer's, at 850 hPa in the wet hours (SEASONS rainWind), blowing as often from each way as its wet
// rose has it; the theory takes that layer saturated, and its measured humidity there (rainHumid) scales ρ_s [design].
export const P_BG = 634, N_M = 0.005, H_W = 2500, GAMMA_RATIO = 6.5 / 5.8, R_V = 461.5;
// The theory filters out every scale much under U τ (some 13 km), so it runs on cells four times as wide, on a grid four
// times as wide as the island so that rain carried downwind does not come round again [design].
export const COARSE = 4, NC = N / COARSE, M = 4 * NC;

// ---------- cloud on the hills ----------
// The chance a place this high above the sea stands inside the cloud in season si: at Hammer Odde (9 m up), the share
// of hours with fog (under 1 km of sight) or a ceiling (5 oktas or more) based at or below the height, NOAA ISD 2015 to
// 2024 (sec. 34) [derived]; read straight between the heights, the highest held above them.
export const FOG_Z = [0, 25, 50, 100, 150, 200, 300, 500];
export const FOG = [
  [0.0213, 0.0214, 0.0342, 0.0661, 0.0796, 0.11, 0.1526, 0.2375],
  [0.0121, 0.0122, 0.0192, 0.0318, 0.0374, 0.0473, 0.0614, 0.0901],
  [0.0131, 0.0131, 0.0177, 0.0314, 0.0393, 0.0599, 0.094, 0.1624],
  [0.0071, 0.0071, 0.0137, 0.0541, 0.0799, 0.1374, 0.2225, 0.3981],
];

// ---------- wind and salt ----------
// Behind a break the wind comes back by how many of the break's heights downwind a place stands: half the open wind at 5,
// 0.65 at 10, 0.8 at 15, 0.85 at 20 and all of it by 30, as behind a dense windbreak (R489) [cited; ground that falls
// away is a solid break, not a porous one: gap]. The ground upwind breaks the wind where it falls away steeper than 0.3,
// past which Taylor and Lee's attached flow over a slope no longer holds (R488); gentler ground the wind follows.
export const WAKE_X = [5, 10, 15, 20, 30], WAKE = [0.5, 0.65, 0.8, 0.85, 1], PARTS = 0.3;

// Over a knoll or ridge the wind quickens by Taylor and Lee's B h / L1 at the top, h its height above the ground around
// and L1 its half-length, B 1.6 for a three-dimensional hill (R488) [cited], L1 the 600 m "around" stands for [design].
export const TAYLOR_LEE = 1.6, HALF_LENGTH = 600;
// Sea salt falls off exponentially with the distance the air has come over land (R490), as two exponentials: the spray
// of the breaking waves within some 250 m [gap: a research note's 140 to 400 m, unverified], and the finer salt the air
// carries far inland, down to a fifth of the coast's 50 km in (R491), so an e-fold of 50 / ln 5 km; the far salt's share
// at the waterline is a tenth [gap: not measured here].
export const SPRAY_M = 250, FAR_M = 50000 / Math.log(5), FAR = 0.1;

// Inside the cloud (the share of a season a place stands in it, FOG) a nimbostratus overcast's 0.16 of a clear day's light
// on level ground, all of it glow (R482).
export const IN_CLOUD = 0.16;

// ---------- snow ----------
// Precipitation falls as snow by Dai's land fit, half of it at 1.3 °C with a logistic spread of 0.67 °C (R492), for a
// day's mean air widened by the swing of a wet day's air through it, a cosine of half Rønne's wet-day range (air.ts RANGE
// rain: 3.44, 4.94, 3.99 and 2.92 °C by season; sec. 33) [derived]: s = sqrt(0.67² + 3 σ² / π²), σ = range / (2 √2).
export const SNOW_HALF = 1.3, SNOW_SPREAD = [3.44, 4.94, 3.99, 2.92].map((r) => Math.sqrt(0.67 ** 2 + (3 * (r / (2 * Math.SQRT2)) ** 2) / Math.PI ** 2));
// The day's mean air stands from its time of year's by a spread of 2.28, 2.51, 2.16 and 2.57 °C by season, and keeps
// 0.779 of its standing from one day to the next: Rønne's days, 2015 to 2024 (bornholm.py ronne; sec. 34) [derived].
// The snow year runs that weather as one long draw of its own [design: the same for every island, so the climate
// doesn't hang on one island's luck], ten years of it after one to settle, as many winters as DMI's snow record holds.
export const DAY_SPREAD = [2.28, 2.51, 2.16, 2.57], DAY_KEEPS = 0.779, YEARS = 10;
// Lying snow melts by its energy balance (Ismail et al., R493): Q = (1 - α) S + L_net + ρ c_p C_H u T + ρ λ C_H u (q -
// q_s(0)) with the surface at 0 °C; every 0.334 MJ/m² of Q melts a millimetre of water (the latent heat of fusion).
// α 0.9 for new snow and 0.45 for old (R493) [cited; how fast one turns into the other: gap], new on a day most of whose
// precipitation fell as snow; C_H 0.0024 at 2 m (R493); L_net the sky's longwave as FAO-56 eq. 39 has it (R221) less a
// surface at 0 °C's own; c_p dry air's 1005 J/kg K and λ water's latent heat at 0 °C, 2.501 MJ/kg.
export const FRESH = 0.9, OLD = 0.45, C_H = 0.0024, FUSION = 0.334, CP = 1005, VAPORIZE = 2.501e6, SIGMA = 4.903e-9, K0 = 273.16;

// A small seeded generator of uniform draws in [0, 1) (mulberry32).
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
