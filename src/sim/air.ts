// The air at any point of the island now, as light.ts has its light: how warm, how hard the wind blows, and how cold the
// two feel together. The weather (ecology.ts) is the island's own: the air at sea level away from the coast, and the wind
// over the open sea. A place takes them through what the generator found there (src/terrain/climate.ts): its height, the
// sea air tempering it, the sun its slopes get, the cold that pools in its hollows on still, clear nights, and how the
// ground upwind and the trees overhead break the wind. Nothing here is stored.
import { CELL } from "../terrain/grid";
import { DIRS, POOL_C, SEASONS, SEASON_DAYS, esat } from "../terrain/climate";
import { CLOUD, NOON, daylight, seasonAt, sunAt } from "./sky";
import { crownsAt } from "./light";
import { DAY, TILE_M, groundOf, hourOf, type World } from "./world";

const between = (t: number, of: (s: number) => number) => { const { s, f } = seasonAt(t); return of(s) * (1 - f) + of((s + 1) % 4) * f; };
// The day's mean air at sea level inland.
export const baseTemp = (t: number) => between(t, (s) => SEASONS[s].t);

type Sky = World["weather"]["sky"];
const wet = (sky: Sky) => sky === "rain" || sky === "storm";
// How far the day's warmth swings either side of its mean: half the day's range at De Kooy, on the Dutch coast, by season
// (spring, summer, autumn, winter) on clear days (a cloud amount of 1 okta or less), overcast dry ones (6 or more) and
// days with a millimetre of rain, KNMI 1991 to 2020 (fire-constants sec. 33, R478) [derived]; a storm's as rain's. The
// warmest of the day two hours after the sun crosses the south, the coldest twelve hours later.
const RANGE: Record<Sky, number[]> = { clear: [8.7, 8.9, 7.7, 5.5], cloudy: [5.7, 6.0, 4.9, 3.8], rain: [5.4, 5.8, 5.0, 4.4], storm: [5.4, 5.8, 5.0, 4.4] };
export const swing = (t: number, sky: Sky) => (between(t, (s) => RANGE[sky][s]) / 2) * Math.cos((2 * Math.PI * (hourOf(t) - NOON - 2)) / 24);
// How much warmer an hour of steady rain is than a dry one at the same place, month and hour, by season: De Kooy and De
// Bilt, KNMI hourly 2011 to 2020 (sec. 33, R478) [derived]: colder in summer, as the rain cools the air it falls through
// toward its wet bulb, warmer in winter, the rain coming with the mild Atlantic air.
const RAIN_OFF = [-0.75, -2.5, -0.15, 1.4];

// The day's air at sea level inland at tick t under a sky: its mean and swing, and rain's own warmth.
export const islandTemp = (t: number, sky: Sky) => baseTemp(t) + swing(t, sky) + (wet(sky) ? between(t, (s) => RAIN_OFF[s]) : 0);

// The wind over the open sea at head height under each sky, m/s, its mean and spread by season: Belmullet, on Ireland's
// exposed west coast, hourly 2015 to 2024 (NOAA ISD) sorted into the four skies (sec. 33, R479) [derived], its 10 m wind
// brought down to head height over open ground by the log profile (z0 0.03 m, sec. 14a).
const HEAD = Math.log(2 / 0.03) / Math.log(10 / 0.03);
const SPEED: Record<Sky, [number, number][]> = {
  clear: [[4.64, 2.57], [4.39, 2.39], [4.47, 2.63], [4.86, 3.08]],
  cloudy: [[5.97, 3.26], [5.51, 2.76], [5.92, 3.17], [7.08, 3.79]],
  rain: [[7.77, 3.53], [6.67, 3.17], [7.86, 3.63], [8.48, 3.8]],
  storm: [[19.0, 0.98], [19.0, 1.0], [19.16, 1.2], [19.33, 1.61]],
};
// The wind's anomaly, how many spreads it stands above or below its sky's mean, keeps 0.854 of itself from one hour to the
// next there (sec. 33) [derived].
const KEEPS = 0.854;
// The wind over the open sea at head height at tick t under a sky, for an anomaly z.
export const windOf = (t: number, sky: Sky, z: number) => Math.max(0, HEAD * between(t, (s) => SPEED[sky][s][0] + z * SPEED[sky][s][1]));
// The anomaly an hour on, from a normal draw n.
export const nextAnomaly = (z: number, n: number) => KEEPS * z + Math.sqrt(1 - KEEPS * KEEPS) * n;
// The way the wind blows an hour on, from normal draws nx and ny: its direction as a vector settling toward the way it
// prevails (unit) as much as the island's year has it, each part keeping 0.925 of its departure an hour with a spread of
// 0.68; at Belmullet the hours' mean direction is 0.12, 0.34, 0.26 and 0.39 of a steady wind by season (sec. 33) [derived].
const STEADY = [0.12, 0.339, 0.26, 0.391], TURNS = 0.925, VEERS = 0.68 * Math.sqrt(1 - TURNS * TURNS);
export function nextWay(t: number, way: { dx: number; dy: number }, prevails: [number, number], nx: number, ny: number) {
  const len = Math.hypot(prevails[0], prevails[1]) || 1, R = between(t, (s) => STEADY[s]), mx = (R * prevails[0]) / len, my = (R * prevails[1]) / len;
  return { dx: mx + TURNS * (way.dx - mx) + VEERS * nx, dy: my + TURNS * (way.dy - my) + VEERS * ny };
}

const cellAt = (p: number) => (p * TILE_M) / CELL - 0.5;
function field(f: Float32Array, px: number, py: number, n: number) {
  const x = Math.max(0, Math.min(n - 1.001, cellAt(px))), y = Math.max(0, Math.min(n - 1.001, cellAt(py)));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * n + x0;
  return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) + (f[i + n] * (1 - fx) + f[i + n + 1] * fx) * fy;
}

export type Air = {
  temp: number; // °C
  wind: number; // m/s at head height
  feels: number; // °C: the wind chill, the air as cold as bare skin finds it
};
// How much of the open sea's wind reaches head height at a point when it blows this way: what the generator found the
// ground upwind leaves of it there (climate.ts lee), before any trees.
export function leeAt(w: World, px: number, py: number, way: { dx: number; dy: number }) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length));
  const a = Math.atan2(way.dy, way.dx), k = ((Math.round((a / (2 * Math.PI)) * DIRS) % DIRS) + DIRS) % DIRS;
  const x = Math.max(0, Math.min(n - 1.001, cellAt(px))), y = Math.max(0, Math.min(n - 1.001, cellAt(py))), x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const lee = (i: number) => isle.lee[i * DIRS + k] / 100, i = y0 * n + x0;
  return (lee(i) * (1 - fx) + lee(i + 1) * fx) * (1 - fy) + (lee(i + n) * (1 - fx) + lee(i + n + 1) * fx) * fy;
}
// How steeply the ground rises at a point, meters for each meter east (x) and south (y), across a cell either way.
export function slopeAt(w: World, px: number, py: number): [number, number] {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), h = CELL / 2 / TILE_M;
  const at = (x: number, y: number) => field(isle.height, x, y, n);
  return [(at(px + h, py) - at(px - h, py)) / CELL, (at(px, py + h) - at(px, py - h)) / CELL];
}
// The head-height wind at a point, blowing this way at speed over the open sea: what the ground upwind leaves of it, and
// under trees Albini and Baughman's sheltered wind (fire-constants sec. 14a, R81): the wind 20 ft above open ground times
// 0.555 / (sqrt(f H) ln((20 + 0.36 H) / (0.13 H))), H the crowns' height in feet and f the share of the space under them
// their crowns fill, cover times crown ratio over 3, wherever that share passes 5%. The 20-ft wind is the head-height
// wind carried up the open class's log profile (z0 0.03 m, sec. 14a).
const FT = 0.3048, TWENTY = Math.log((20 * FT) / 0.03) / Math.log(2 / 0.03);
export function headWind(w: World, px: number, py: number, way: { dx: number; dy: number }, speed: number) {
  const open = speed * leeAt(w, px, py, way), c = crownsAt(w, px, py), f = (Math.min(1, c.cover) * c.ratio) / 3, H = c.height / FT;
  if (f <= 0.05 || H <= 0) return open;
  return Math.min(open, (open * TWENTY * 0.555) / (Math.sqrt(f * H) * Math.log((20 + 0.36 * H) / (0.13 * H))));
}
// The air at a point now. sheltered: out of the wind, inside walls.
export function airAt(w: World, px: number, py: number, sheltered = false): Air {
  const wx = w.weather;
  const wind = sheltered ? 0 : headWind(w, px, py, wx.wind, wx.speed);
  const temp = wx.temp + placeTemp(w, px, py, w.t, wx.sky, wx.speed);
  return { temp, wind, feels: chill(temp, wind) };
}
// How much warmer or colder than the island's air a point is at tick t under a sky and a wind speed: the place's own
// season means against the island's, without the cold it pools, which comes with the night (pooled).
export function placeTemp(w: World, px: number, py: number, t: number, sky: Sky, speed: number) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(t);
  const own = (k: number) => field(isle.seasons[k].temp, px, py, n) - SEASONS[k].t + POOL_C[k] * field(isle.pool, px, py, n);
  const pool = field(isle.pool, px, py, n), off = own(s) * (1 - f) + own((s + 1) % 4) * f;
  return pool > 0 ? off - pool * pooled(w, px, py, t, sky, speed) : off;
}
// The cold a hollow where it pools deepest holds below the slopes round it at tick t (sec. 33): from sunset, 1.9 degrees an
// hour on and 4.3 by midnight in Gustavsson et al.'s Swedish valley (R480), so 4.3 (1 - e^(-h / 1.72)) h hours after
// sunset, gone once the sun is up [derived]; in full where the wind is under 3 m/s and none above 6, the most it held on
// in a forest hollow, open hollows losing theirs sooner (R480, R481) [derived, straight between]; and in full under a
// sky that sends back under 80% of what the ground radiates, none past 93% (Jemmett-Smith et al.'s strong pools, R481),
// what comes back as FAO-56 has the net longwave (eq. 39, R221), the sun's share of the day's possible hours taken as the
// sky's clear share (eqs. 35 and 37).
const POOL_MAX = 4.3, POOL_H = -1 / Math.log(1 - 1.9 / 4.3);
function pooled(w: World, px: number, py: number, t: number, sky: Sky, speed: number) {
  const day = Math.floor(t / DAY) + 1, half = daylight(day) / 2, h = hourOf(t), set = NOON + half, rise = NOON - half;
  const after = h >= set ? h - set : h < rise ? h + 24 - set : -1, calm = Math.max(0, Math.min(1, (6 - speed) / 3));
  if (after < 0 || calm <= 0) return 0;
  const sunny = (0.25 + 0.5 * (1 - CLOUD[sky])) / 0.75, back = 1 - (0.34 - 0.14 * Math.sqrt(vapourAt(w, px, py, t))) * (1.35 * sunny - 0.35);
  const still = Math.max(0, Math.min(1, (0.93 - back) / (0.93 - 0.8)));
  return POOL_MAX * (1 - Math.exp(-after / POOL_H)) * calm * still;
}
// Where an entity stands, worked out once a tick however many questions ask.
const memo = new WeakMap<object, { t: number; px: number; py: number; sheltered: boolean; air: Air }>();
export function airOn(w: World, e: { px: number; py: number }, sheltered = false): Air {
  const m = memo.get(e);
  if (m && m.t === w.t && m.px === e.px && m.py === e.py && m.sheltered === sheltered) return m.air;
  const air = airAt(w, e.px, e.py, sheltered);
  memo.set(e, { t: w.t, px: e.px, py: e.py, sheltered, air });
  return air;
}
// How much of the ground snow covers at a point now: the generator's snowpack for the time of year (mm of water), drawn
// between the seasons' means, covering as Roesch et al.'s fraction has it on flat ground, 0.95 tanh(0.1 SWE) (fire-constants
// sec. 33, R476): half the ground under 6 mm, nine tenths under 30, never quite all of it.
export function snowAt(w: World, px: number, py: number) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(w.t);
  const pack = field(isle.seasons[s].snowpack, px, py, n) * (1 - f) + field(isle.seasons[(s + 1) % 4].snowpack, px, py, n) * f;
  return 0.95 * Math.tanh(0.1 * Math.max(0, pack));
}
// The water in the air at a point at tick t, kPa: the place's season humidity at its season's warmth (climate.ts fields),
// drawn between the seasons' middles as its warmth is, so air holding the same water is damper the colder it is.
export function vapourAt(w: World, px: number, py: number, t: number) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(t);
  const e = (k: number) => field(isle.seasons[k].humid, px, py, n) * esat(field(isle.seasons[k].temp, px, py, n));
  return e(s) * (1 - f) + e((s + 1) % 4) * f;
}
// How much of the water air this warm could hold it holds, 0 to 1.
export const humidity = (vapour: number, temp: number) => Math.min(1, vapour / esat(temp));
// How often the sky rains (docs/research/fire-constants.md sec. 25b): measurable rain falls in 1.6 hours a day at a London
// station taking 618 mm a year (R211), and in one hourly observation in five over Ireland's 1,205 mm (R212). An island's
// share of wet hours is read between the two by its land's own yearly precipitation, and each season takes its share of
// the year's wet hours as it takes its share of the year's rain (climate.ts SEASONS wet). Of a season's wet hours, the
// share that storm, and how the sky turns, are Belmullet's (CHAIN).
const LONDON = { mm: 618, wet: 1.6 / 24 }, IRELAND = { mm: 1205, wet: 0.2 };
// How the sky turns from one hour to the next at Belmullet, hourly 2015 to 2024 (NOAA ISD; sec. 33, R479) [derived]: by
// season, from clear, cloudy, rain and storm (rows) to each (columns). A clear hour is a dry one with 2 oktas of cloud or
// less, or none reported; a cloudy one any other dry hour; rain an hour of falling rain, drizzle or snow (present weather
// 40 to 89) in a wind under a gale's 17.2 m/s, a storm one at a gale or more. Storms are too few in any one season for
// their own row, so each season leaves a storm as the four seasons together do.
const STORM_ROW = [0.0038, 0.2256, 0.282, 0.4887];
const CHAIN: number[][][] = [
  [[0.733, 0.243, 0.024, 0], [0.1114, 0.781, 0.1069, 0.0007], [0.0381, 0.3979, 0.5605, 0.0036], STORM_ROW],
  [[0.6648, 0.319, 0.0162, 0], [0.0737, 0.8371, 0.089, 0.0001], [0.0187, 0.4224, 0.5586, 0.0003], STORM_ROW],
  [[0.6171, 0.3374, 0.0455, 0], [0.0924, 0.7734, 0.133, 0.0011], [0.037, 0.3993, 0.5602, 0.0034], STORM_ROW],
  [[0.5489, 0.3642, 0.0869, 0], [0.08, 0.7453, 0.1717, 0.0031], [0.0499, 0.4096, 0.5324, 0.0081], STORM_ROW],
];
const SKIES: Sky[] = ["clear", "cloudy", "rain", "storm"];
// The share of hours a chain spends in each sky in the long run.
function settled(P: number[][]) {
  let p = [0.25, 0.25, 0.25, 0.25];
  for (let n = 0; n < 400; n++) p = [0, 1, 2, 3].map((j) => p.reduce((t, x, i) => t + x * P[i][j], 0));
  return p;
}
// A season's chain held to the island's own share of wet hours: the chance of rain or storm coming on out of a dry sky
// scaled by one factor until the chain rains that share of its hours, the rest of a dry row keeping its own proportions
// [derived].
function heldTo(P: number[][], share: number) {
  const scaled = (k: number) => P.map((row, i) => {
    if (i >= 2) return row;
    const wet = (row[2] + row[3]) * k, keep = (1 - wet) / (row[0] + row[1]);
    return [row[0] * keep, row[1] * keep, row[2] * k, row[3] * k];
  });
  let lo = 0, hi = 1 / Math.max(P[0][2] + P[0][3], P[1][2] + P[1][3]);
  for (let n = 0; n < 50; n++) {
    const mid = (lo + hi) / 2, p = settled(scaled(mid));
    if (p[2] + p[3] < share) lo = mid; else hi = mid;
  }
  return scaled((lo + hi) / 2);
}
// The land's means, worked out once an island: each season's air water (kPa) and rain in a rain hour (mm), the share of
// the year's hours wet, each season's shares of hours raining and storming, and the chain its sky turns by. A wet hour
// rains as one of the real season's wet hours does: its precipitation spread over the hours of its real 91 days that
// rain, whatever share of them a game season's ten days stand for.
type Means = { vapour: number[]; rain: number[]; wet: number; hours: [number, number][]; chain: number[][][] };
const landMeans = new Map<number, Means>();
function meansOf(w: World): Means {
  const kept = landMeans.get(w.seed);
  if (kept) return kept;
  const { isle } = groundOf(w.seed), land = Array.from(isle.height.keys()).filter((i) => isle.height[i] > 0);
  const mean = (f: (i: number) => number) => land.reduce((t, i) => t + f(i), 0) / land.length;
  const precip = [0, 1, 2, 3].map((k) => mean((i) => isle.seasons[k].precip[i])), year = precip.reduce((t, x) => t + x, 0);
  const wet = LONDON.wet + ((year - LONDON.mm) * (IRELAND.wet - LONDON.wet)) / (IRELAND.mm - LONDON.mm);
  const chain = SEASONS.map((s, k) => heldTo(CHAIN[k], 4 * s.wet * wet));
  const hours = chain.map((P): [number, number] => { const p = settled(P); return [p[2], p[3]]; });
  const m: Means = {
    vapour: [0, 1, 2, 3].map((k) => mean((i) => isle.seasons[k].humid[i] * esat(isle.seasons[k].temp[i]))),
    rain: precip.map((p, k) => p / (SEASON_DAYS * 24 * (hours[k][0] + 5 * hours[k][1]))), wet, hours, chain,
  };
  landMeans.set(w.seed, m);
  return m;
}
// The sky an hour after one at tick t, for a draw r: the island's chain for the time of year, drawn between the seasons'.
export function nextSky(w: World, sky: Sky, r: number, t: number): Sky {
  const { chain } = meansOf(w), { s, f } = seasonAt(t), i = SKIES.indexOf(sky);
  let sum = 0;
  for (let j = 0; j < 4; j++) if (r < (sum += chain[s][i][j] * (1 - f) + chain[(s + 1) % 4][i][j] * f)) return SKIES[j];
  return sky;
}
// The rain falling on open level ground at a point at tick t under a sky, mm an hour (sec. 13, 25b): the season's
// precipitation there spread over the hours of its real days that rain, a storm hour five times a rain hour. What
// reaches the ground under trees, behind rocks or on a slope is rain.ts's.
export function rainWhen(w: World, px: number, py: number, t: number, sky: World["weather"]["sky"]) {
  if (sky !== "rain" && sky !== "storm") return 0;
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(t), { hours } = meansOf(w);
  const rate = (k: number) => field(isle.seasons[k].precip, px, py, n) / (SEASON_DAYS * 24 * (hours[k][0] + 5 * hours[k][1]));
  return (rate(s) * (1 - f) + rate((s + 1) % 4) * f) * (sky === "storm" ? 5 : 1);
}
// The same now.
export function rainAt(w: World, px: number, py: number) { return rainWhen(w, px, py, w.t, w.weather.sky); }
// The island's own air water (kPa) and rain (mm an hour) at tick t under a sky, drawn between the seasons as
// everywhere's are.
export function islandAir(w: World, t: number, sky: World["weather"]["sky"]) {
  const m = meansOf(w), { s, f } = seasonAt(t), now = (v: number[]) => v[s] * (1 - f) + v[(s + 1) % 4] * f;
  return { vapour: now(m.vapour), rain: sky === "rain" ? now(m.rain) : sky === "storm" ? 5 * now(m.rain) : 0 };
}
// The island's rain an hour at tick t, wet and dry hours together, mm: its season's precipitation over all its real hours.
export function meanRain(w: World, t: number) {
  const m = meansOf(w), { s, f } = seasonAt(t), of = (k: number) => m.rain[k] * (m.hours[k][0] + 5 * m.hours[k][1]);
  return of(s) * (1 - f) + of((s + 1) % 4) * f;
}
// The sun on something lying in the open at tick t under a sky, W/m2: the clear-sky beam at the sun's height (sec. 11).
export function sunOn(t: number, sky: World["weather"]["sky"]) {
  const el = sunAt(Math.floor(t / DAY) + 1, hourOf(t)).el;
  return el > 0 ? 1381.6 * 0.745 ** (1 / Math.sin(el)) * Math.sin(el) * (1 - CLOUD[sky]) : 0;
}
// Environment Canada's wind chill index, for air at or below 10 °C and a wind at head height (taken as three quarters of
// the 10 m wind the index is reckoned in).
export function chill(t: number, v: number) {
  const kmh = (v / 0.75) * 3.6;
  if (t > 10 || kmh < 4.8) return t;
  const p = kmh ** 0.16;
  return Math.min(t, 13.12 + 0.6215 * t - 11.37 * p + 0.3965 * t * p);
}
// What it is like, in a few words.
export function airWords(air: Air) {
  const t = Math.round(air.temp), wind = air.wind < 1.5 ? "still" : air.wind < 4 ? "a light breeze" : air.wind < 8 ? "a stiff wind" : air.wind < 13 ? "a strong wind" : "a gale";
  return `${t}C, ${wind}${air.feels < air.temp - 2 ? `, feels like ${Math.round(air.feels)}C` : ""}`;
}
