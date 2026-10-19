// The sky over the island: where the sun and the moon stand at an hour of a day of the year, and how much light they leave
// on bare ground. The numbers are the ones the renderer draws its sky with (demo/styles/isopixel/live.js: LAT, TILT, NOON,
// YEAR_DAYS, LUNAR, declination, bodyAt and moonAt), so the people live under the sky the screen shows. Change one place,
// change the other.
//
// Light is counted in lux, the way it is measured, because eyes meet it on a log scale: a day is a hundred thousand of them
// and a clear night under a full moon a quarter of one, and people work comfortably across almost all of that range.
import type { World } from "./world";
import { DAY, TICK_S, YEAR_DAYS } from "./ticks";

const DEG = Math.PI / 180;

// The island lies at 55.1 degrees north, as Bornholm does, whose climate it has (terrain/climate.ts); the sun crosses the
// south at 13:00. A year is YEAR_DAYS days, the first ten spring:
// the sun's path climbs and sinks over it by the earth's tilt, crossing the equator in the middle of spring and of autumn,
// highest in the middle of summer (58 degrees at noon, a 17.1 hour day) and lowest in the middle of winter (11.5 degrees,
// a 6.9 hour day). The moon crosses the same sky phase x 24 hours behind the sun as it waxes over LUNAR days, as far south of
// the equator when full as the sun is north, so a summer full moon rides low and a winter one high.
// The clock (ticks.ts), kept here too for the modules that have long read it off the sky: ticks a day, seconds a tick,
// days a year. Every speed, rate and duration in seconds becomes ticks through TICK_S alone.
export { DAY, TICK_S, YEAR_DAYS };
export const NOON = 13; // the sun crosses the south
// Where tick t falls between the middles of two seasons: the earlier's index and how far toward the next. A day's air is
// drawn straight between the seasons' means, as the island's fields are.
export function seasonAt(t: number) {
  const u = (((t / DAY) % YEAR_DAYS) - YEAR_DAYS / 8) / (YEAR_DAYS / 4), s = Math.floor(u);
  return { s: (s + 4) % 4, f: u - s };
}
// The island day (counted from 0) of a real date so many days after the spring equinox, 20 March, at the year's pace
// (365.25 / YEAR_DAYS real days to an island day), from the island's equinox in the middle of its spring.
export const onDay = (realDays: number) => (YEAR_DAYS / 8 + realDays / (365.25 / YEAR_DAYS)) % YEAR_DAYS;
const LAT = 55.1 * DEG, TILT = 23.44 * DEG, LUNAR = 29.53;
const hourAngle = (hour: number, transit: number) => ((hour - transit) * Math.PI) / 12;
// How far north of the equator the sun stands on day `day` of the world (counting from 1, as the clock does) at an hour.
export function declination(day: number, hour: number) {
  const d = (((day - 1 + hour / 24) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
  return TILT * Math.sin((2 * Math.PI * (d - YEAR_DAYS / 8)) / YEAR_DAYS);
}

// Hours between sunrise and sunset on day `day`, worked out once a day: the living things that go by the length of the
// day (cues.ts) ask it again and again, for every blade of grass a forager looks over.
const daylightOn = new Map<number, number>();
export function daylight(day: number) {
  let h = daylightOn.get(day);
  if (h === undefined) {
    const c = -Math.tan(LAT) * Math.tan(declination(day, NOON));
    daylightOn.set(day, (h = (Math.acos(Math.max(-1, Math.min(1, c))) * 24) / Math.PI));
  }
  return h;
}

// dir: toward it across the ground (x east, z south), el: its elevation in radians, tan: of the angle its beam makes
type Body = { dir: [number, number]; el: number; tan: number };
function bodyAt(H: number, dec: number, lat = LAT): Body {
  const e = -Math.cos(dec) * Math.sin(H), n = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(H);
  const u = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H), h = Math.hypot(e, n);
  return { dir: [e / h, -n / h], el: Math.asin(Math.max(-1, Math.min(1, u))), tan: u / h };
}
// day counts from 1, as the clock's does
export const sunAt = (day: number, hour: number): Body => bodyAt(hourAngle(hour, NOON), declination(day, hour));
export function moonAt(day: number, hour: number): Body & { phase: number; lit: number } {
  const phase = ((day - 1 + hour / 24) / LUNAR + 0.35) % 1, w = 2 * Math.PI * phase;
  return { ...bodyAt(hourAngle(hour, NOON + phase * 24), declination(day, hour) * Math.cos(w)), phase, lit: (1 - Math.cos(w)) / 2 };
}
// The same sky over a ground at another latitude (degrees, south negative): a window of the planet (gpu/globe/window.ts). The
// world's own sky above is the island's at 55.1 degrees north; the tilt, the year and the clock are the same [gap: Earth's tilt,
// 23.44 degrees, where the planet's is 23.4].
export type Sky = { latDeg: number; sunAt: typeof sunAt; moonAt: typeof moonAt; daylight: typeof daylight };
export function skyAt(latDeg: number): Sky {
  const lat = latDeg * DEG, memo = new Map<number, number>();
  return {
    latDeg,
    sunAt: (day, hour) => bodyAt(hourAngle(hour, NOON), declination(day, hour), lat),
    moonAt: (day, hour) => {
      const phase = ((day - 1 + hour / 24) / LUNAR + 0.35) % 1, w = 2 * Math.PI * phase;
      return { ...bodyAt(hourAngle(hour, NOON + phase * 24), declination(day, hour) * Math.cos(w), lat), phase, lit: (1 - Math.cos(w)) / 2 };
    },
    daylight: (day) => {
      let h = memo.get(day);
      if (h === undefined) memo.set(day, (h = (Math.acos(Math.max(-1, Math.min(1, -Math.tan(lat) * Math.tan(declination(day, NOON))))) * 24) / Math.PI));
      return h;
    },
  };
}

// The light a body leaves on bare ground under a clear sky at an elevation, as the US Naval Observatory reckons it (Circular
// 171, Janiczek and DeYoung 1987: its beam fitted to Jones and Condit, its sky's glow to Brown's charts; fire-constants
// sec. 33, R483): the elevation lifted by refraction above -5/6 of a degree, the path through the air at it, and from that
// the beam's share and the glow's, in lux for every 133,775 of the sun's at the top of the sky. A clear noon at 58
// degrees is some 100,000 lux, sunset 1,000, the end of civil twilight (6 below) 3, of nautical (12 below) a 230th.
function overhead(el: number) {
  let h = el / DEG;
  if (h >= -5 / 6) h += 1 / Math.tan((h + 8.59 / (h + 4.42)) * DEG) / 60;
  const u = Math.sin(h * DEG), X = 753.6616, s = Math.asin((X * Math.cos(h * DEG)) / (X + 1)), m = X * (Math.cos(s) - u) + Math.cos(s);
  return { beam: Math.max(0, Math.exp(-0.21 * m) * u), glow: 0.0289 * Math.exp(-0.042 * m) * (1 + ((h + 90) * u) / 57.29578) };
}
// The sun's lux on bare ground under a clear sky, and the share of it that comes as the beam.
export function sunLux(el: number) {
  const { beam, glow } = overhead(el);
  return { lux: 133775 * (beam + glow), beam: beam + glow > 0 ? beam / (beam + glow) : 0 };
}
// The moon's, the same way (Circular 171): a full moon at the top of the sky 0.4 lux, a half one a fifteenth of that, by
// how far it stands from the sun (its elongation, from how much of it is lit), a little more the higher it stands and so
// the nearer it is.
export function moonLux(m: { el: number; lit: number }) {
  const E = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * m.lit))), half = Math.tan(E / 2);
  const p = (half > 0 ? 0.892 * Math.exp(-3.343 / half ** 0.632) : 0) + 0.0344 * (Math.sin(E) - E * Math.cos(E));
  const { beam, glow } = overhead(m.el);
  return ((0.418 * p) / (1 - 0.005 * Math.cos(E) - 0.03 * Math.sin(Math.max(0, m.el)))) * (beam + glow);
}
// The night sky's own glow, the stars' and the air's, in Circular 171's sums: 0.0005 lux.
export const STAR_LUX = 0.0005;

// How much of the sky each sky's cloud covers, the share of the sun's beam it hides: Hammer Odde's mean total cloud in the
// hours of each (fire-constants sec. 33, R479) [derived].
export const CLOUD: Record<World["weather"]["sky"], number> = { clear: 0.053, cloudy: 0.814, rain: 0.899, storm: 0.868 };
// The share of a clear sky's daylight that reaches the ground under each sky: Kasten and Czeplak's 1 - 0.71 (N/8)^3.4 as
// fitted to London (CIBSE, R482) for the broken skies it holds for, and an overcast of nimbostratus's 0.16 for the
// raining ones (CIBSE Table 14) (sec. 33).
const kasten = (cover: number) => 1 - 0.71 * cover ** 3.4;
export const SKYLIGHT: Record<World["weather"]["sky"], number> = { clear: kasten(CLOUD.clear), cloudy: kasten(CLOUD.cloudy), rain: 0.16, storm: 0.16 };

// When the sun has gone this far below the horizon the sky is dark: the end of civil twilight.
export const NIGHT_EL = -6 * DEG;
