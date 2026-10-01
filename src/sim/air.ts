// The air at any point of the island now, as light.ts has its light: how warm, how hard the wind blows, and how cold the
// two feel together. The weather (ecology.ts) is the island's own: the air at sea level away from the coast, and the wind
// over the open sea. A place takes them through what the generator found there (src/terrain/climate.ts): its height, the
// sea air tempering it, the sun its slopes get, the cold that pools in its hollows on still, clear nights, and how the
// ground upwind and the trees overhead break the wind. Nothing here is stored.
import { CELL } from "../terrain/grid";
import { DIRS, POOL_C, SEASONS } from "../terrain/climate";
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
  const { isle } = groundOf(w.seed), n = Math.round(Math.sqrt(isle.height.length)), wx = w.weather, { s, f } = seasonAt(w.t);
  // the place's own season means against the island's, without the cold it pools, which comes with the night below
  const own = (k: number) => field(isle.seasons[k].temp, px, py, n) - SEASONS[k].t + POOL_C[k] * field(isle.pool, px, py, n);
  const pool = field(isle.pool, px, py, n), off = own(s) * (1 - f) + own((s + 1) % 4) * f;
  // the wind at the place, for the way it blows now
  const a = Math.atan2(wx.wind.dy, wx.wind.dx), k = ((Math.round((a / (2 * Math.PI)) * DIRS) % DIRS) + DIRS) % DIRS;
  const x = Math.max(0, Math.min(n - 1.001, cellAt(px))), y = Math.max(0, Math.min(n - 1.001, cellAt(py))), x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const lee = (i: number) => isle.lee[i * DIRS + k] / 100, i = y0 * n + x0;
  const open = (lee(i) * (1 - fx) + lee(i + 1) * fx) * (1 - fy) + (lee(i + n) * (1 - fx) + lee(i + n + 1) * fx) * fy;
  const wind = sheltered ? 0 : wx.speed * open * (1 - 0.65 * Math.min(1, canopyAt(w, px, py)));
  // On a still, clear night the cold slides off the slopes into the hollows: as much as five degrees more than the
  // season's mean there, nothing in a wind or under cloud.
  const night = Math.max(0, -Math.cos((2 * Math.PI * (hourOf(w.t) - NOON - 2)) / 24));
  const calm = Math.max(0, 1 - wx.speed / 6), clear = wx.sky === "clear" ? 1 : wx.sky === "cloudy" ? 0.3 : 0;
  const temp = wx.temp + off - pool * 5 * calm * clear * night;
  return { temp, wind, feels: chill(temp, wind) };
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
