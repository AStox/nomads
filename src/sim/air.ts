// The air at any point of the island now, as light.ts has its light: how warm, how hard the wind blows, and how cold the
// two feel together. The weather (ecology.ts) is the island's own: the air at sea level away from the coast, and the wind
// over the open sea. A place takes them through what the generator found there (src/terrain/climate.ts): its height, the
// sea air tempering it, the sun its slopes get, the cold that pools in its hollows on still, clear nights, and how the
// ground upwind and the trees overhead break the wind. Nothing here is stored.
import { CELL } from "../terrain/grid";
import { DIRS, POOL_C, SEASONS, esat } from "../terrain/climate";
import { NOON, YEAR_DAYS, sunAt } from "./sky";
import { canopyAt } from "./light";
import { DAY, TILE_M, groundOf, hourOf, type World } from "./world";

// Where tick t falls between the middles of two seasons: the earlier's index and how far toward the next. A day's air is
// drawn straight between the seasons' means, as the island's fields are.
export function seasonAt(t: number) {
  const u = (((t / DAY) % YEAR_DAYS) - YEAR_DAYS / 8) / (YEAR_DAYS / 4), s = Math.floor(u);
  return { s: (s + 4) % 4, f: u - s };
}
const between = (t: number, of: (s: number) => number) => { const { s, f } = seasonAt(t); return of(s) * (1 - f) + of((s + 1) % 4) * f; };
// The day's mean air at sea level inland.
export const baseTemp = (t: number) => between(t, (s) => SEASONS[s].t);

// How far the day's warmth swings either side of its mean: widest under a clear sky and when the sun climbs high, the
// warmest of it two hours after the sun crosses the south and the coldest twelve hours later.
const SWING: Record<World["weather"]["sky"], number> = { clear: 6, cloudy: 3, rain: 2, storm: 2 };
const HIGH = Math.sin((38 + 23.44) * (Math.PI / 180)); // the sun at a midsummer noon
export function swing(t: number, sky: World["weather"]["sky"]) {
  const day = Math.floor(t / DAY) + 1, noon = Math.max(0, Math.sin(sunAt(day, NOON).el));
  return SWING[sky] * (0.4 + (0.6 * noon) / HIGH) * Math.cos((2 * Math.PI * (hourOf(t) - NOON - 2)) / 24);
}

// The day's air at sea level inland at tick t under a sky: its mean and swing, two degrees cooler in rain.
export const islandTemp = (t: number, sky: World["weather"]["sky"]) => baseTemp(t) + swing(t, sky) - (sky === "rain" || sky === "storm" ? 2 : 0);

// The wind over the open sea at head height, m/s, toward which it settles under each sky.
export const WIND: Record<World["weather"]["sky"], number> = { clear: 4, cloudy: 6, rain: 8, storm: 15 };

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
// The air at a point now. sheltered: out of the wind, inside walls.
export function airAt(w: World, px: number, py: number, sheltered = false): Air {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), wx = w.weather;
  // the wind at the place, for the way it blows now
  const a = Math.atan2(wx.wind.dy, wx.wind.dx), k = ((Math.round((a / (2 * Math.PI)) * DIRS) % DIRS) + DIRS) % DIRS;
  const x = Math.max(0, Math.min(n - 1.001, cellAt(px))), y = Math.max(0, Math.min(n - 1.001, cellAt(py))), x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const lee = (i: number) => isle.lee[i * DIRS + k] / 100, i = y0 * n + x0;
  const open = (lee(i) * (1 - fx) + lee(i + 1) * fx) * (1 - fy) + (lee(i + n) * (1 - fx) + lee(i + n + 1) * fx) * fy;
  const wind = sheltered ? 0 : wx.speed * open * (1 - 0.65 * Math.min(1, canopyAt(w, px, py)));
  const temp = wx.temp + placeTemp(w, px, py, w.t, wx.sky, wx.speed);
  return { temp, wind, feels: chill(temp, wind) };
}
// How much warmer or colder than the island's air a point is at tick t under a sky and a wind speed: the place's own
// season means against the island's, without the cold it pools, which comes with the night: on a still, clear night the
// cold slides off the slopes into the hollows, as much as five degrees more than the season's mean there, nothing in a
// wind or under cloud.
export function placeTemp(w: World, px: number, py: number, t: number, sky: World["weather"]["sky"], speed: number) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(t);
  const own = (k: number) => field(isle.seasons[k].temp, px, py, n) - SEASONS[k].t + POOL_C[k] * field(isle.pool, px, py, n);
  const pool = field(isle.pool, px, py, n), off = own(s) * (1 - f) + own((s + 1) % 4) * f;
  const night = Math.max(0, -Math.cos((2 * Math.PI * (hourOf(t) - NOON - 2)) / 24));
  const calm = Math.max(0, 1 - speed / 6), clear = sky === "clear" ? 1 : sky === "cloudy" ? 0.3 : 0;
  return off - pool * 5 * calm * clear * night;
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
// How much of the ground snow covers at a point now: the generator's snowpack for the time of year, drawn between the
// seasons' means, thin from a few millimetres of water and whole by thirty.
export function snowAt(w: World, px: number, py: number) {
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(w.t);
  const pack = field(isle.seasons[s].snowpack, px, py, n) * (1 - f) + field(isle.seasons[(s + 1) % 4].snowpack, px, py, n) * f, x = Math.max(0, Math.min(1, (pack - 3) / 27));
  return x * x * (3 - 2 * x);
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
// share that storm is the sky model's own (sec. 25), which this leaves as it was.
const LONDON = { mm: 618, wet: 1.6 / 24 }, IRELAND = { mm: 1205, wet: 0.2 };
const STORMY = [0.113, 0.242, 0.099, 0.024];
// The land's means, worked out once an island: each season's air water (kPa) and rain in a rain hour (mm), the share of
// the year's hours wet, and each season's shares of hours raining and storming.
type Means = { vapour: number[]; rain: number[]; wet: number; hours: [number, number][] };
const landMeans = new Map<number, Means>();
function meansOf(w: World): Means {
  const kept = landMeans.get(w.seed);
  if (kept) return kept;
  const { isle } = groundOf(w.seed), land = Array.from(isle.height.keys()).filter((i) => isle.height[i] > 0);
  const mean = (f: (i: number) => number) => land.reduce((t, i) => t + f(i), 0) / land.length;
  const precip = [0, 1, 2, 3].map((k) => mean((i) => isle.seasons[k].precip[i])), year = precip.reduce((t, x) => t + x, 0);
  const wet = LONDON.wet + ((year - LONDON.mm) * (IRELAND.wet - LONDON.wet)) / (IRELAND.mm - LONDON.mm);
  const hours = SEASONS.map((s, k): [number, number] => [4 * s.wet * wet * (1 - STORMY[k]), 4 * s.wet * wet * STORMY[k]]);
  const m: Means = {
    vapour: [0, 1, 2, 3].map((k) => mean((i) => isle.seasons[k].humid[i] * esat(isle.seasons[k].temp[i]))),
    rain: precip.map((p, k) => p / (10 * 24 * (hours[k][0] + 5 * hours[k][1]))), wet, hours,
  };
  landMeans.set(w.seed, m);
  return m;
}
// The share of the year's hours the island's sky rains or storms.
export const wetHours = (w: World) => meansOf(w).wet;
// The rain falling at a point now, mm an hour (sec. 13): the season's precipitation there spread over the hours a game
// season rains, a storm hour five times a rain hour.
export function rainAt(w: World, px: number, py: number) {
  const sky = w.weather.sky;
  if (sky !== "rain" && sky !== "storm") return 0;
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), { s, f } = seasonAt(w.t), { hours } = meansOf(w);
  const rate = (k: number) => field(isle.seasons[k].precip, px, py, n) / (10 * 24 * (hours[k][0] + 5 * hours[k][1]));
  return (rate(s) * (1 - f) + rate((s + 1) % 4) * f) * (sky === "storm" ? 5 : 1);
}
// The island's own air water (kPa) and rain (mm an hour) at tick t under a sky, drawn between the seasons as
// everywhere's are.
export function islandAir(w: World, t: number, sky: World["weather"]["sky"]) {
  const m = meansOf(w), { s, f } = seasonAt(t), now = (v: number[]) => v[s] * (1 - f) + v[(s + 1) % 4] * f;
  return { vapour: now(m.vapour), rain: sky === "rain" ? now(m.rain) : sky === "storm" ? 5 * now(m.rain) : 0 };
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
