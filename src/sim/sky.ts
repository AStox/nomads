// The sky over the island: where the sun and the moon stand at an hour of a day of the year, and how much light they leave
// on bare ground. The numbers are the ones the renderer draws its sky with (demo/styles/isopixel/live.js: LAT, TILT, NOON,
// YEAR_DAYS, LUNAR, declination, bodyAt and moonAt), so the people live under the sky the screen shows. Change one place,
// change the other.
//
// Light is counted in lux, the way it is measured, because eyes meet it on a log scale: a day is a hundred thousand of them
// and a clear night under a full moon a quarter of one, and people work comfortably across almost all of that range.
const DEG = Math.PI / 180;

// The island lies at 52 degrees north; the sun crosses the south at 13:00. A year is YEAR_DAYS days, the first ten spring:
// the sun's path climbs and sinks over it by the earth's tilt, crossing the equator in the middle of spring and of autumn,
// highest in the middle of summer (61 degrees at noon, a 16.6 hour day) and lowest in the middle of winter (15 degrees, a
// 7.7 hour day). The moon crosses the same sky phase x 24 hours behind the sun as it waxes over LUNAR days, as far south of
// the equator when full as the sun is north, so a summer full moon rides low and a winter one high.
export const YEAR_DAYS = 40;
export const NOON = 13; // the sun crosses the south
const LAT = 52 * DEG, TILT = 23.44 * DEG, LUNAR = 29.53;
const hourAngle = (hour: number, transit: number) => ((hour - transit) * Math.PI) / 12;
// How far north of the equator the sun stands on day `day` of the world (counting from 1, as the clock does) at an hour.
export function declination(day: number, hour: number) {
  const d = (((day - 1 + hour / 24) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
  return TILT * Math.sin((2 * Math.PI * (d - YEAR_DAYS / 8)) / YEAR_DAYS);
}

// dir: toward it across the ground (x east, z south), el: its elevation in radians, tan: of the angle its beam makes
type Body = { dir: [number, number]; el: number; tan: number };
function bodyAt(H: number, dec: number): Body {
  const e = -Math.cos(dec) * Math.sin(H), n = Math.cos(LAT) * Math.sin(dec) - Math.sin(LAT) * Math.cos(dec) * Math.cos(H);
  const u = Math.sin(LAT) * Math.sin(dec) + Math.cos(LAT) * Math.cos(dec) * Math.cos(H), h = Math.hypot(e, n);
  return { dir: [e / h, -n / h], el: Math.asin(Math.max(-1, Math.min(1, u))), tan: u / h };
}
// day counts from 1, as the clock's does
export const sunAt = (day: number, hour: number): Body => bodyAt(hourAngle(hour, NOON), declination(day, hour));
export function moonAt(day: number, hour: number): Body & { phase: number; lit: number } {
  const phase = ((day - 1 + hour / 24) / LUNAR + 0.35) % 1, w = 2 * Math.PI * phase;
  return { ...bodyAt(hourAngle(hour, NOON + phase * 24), declination(day, hour) * Math.cos(w)), phase, lit: (1 - Math.cos(w)) / 2 };
}

// log10 of the lux on bare ground under a clear sky by the sun's height in degrees, its beam and the sky's glow together:
// sunrise is some 500 lux, the end of civil twilight (6 below) a few, the end of nautical twilight (12 below) a fiftieth.
const SUN: [number, number][] = [[-18, -3], [-12, -1.2], [-6, 0.6], [-3, 1.6], [0, 2.7], [3, 3.3], [10, 4.0], [20, 4.5], [40, 4.9], [90, 5.1]];
export function sunLux(el: number): number {
  const d = el / DEG;
  if (d <= SUN[0][0]) return 10 ** SUN[0][1];
  for (let i = 1; i < SUN.length; i++)
    if (d <= SUN[i][0]) { const [d0, l0] = SUN[i - 1], [d1, l1] = SUN[i]; return 10 ** (l0 + ((l1 - l0) * (d - d0)) / (d1 - d0)); }
  return 10 ** SUN[SUN.length - 1][1];
}
// A full moon overhead lights the ground with a quarter of a lux; the stars with a thousandth or two.
const MOON_LUX = 0.25;
export const STAR_LUX = 0.0015;
export const moonLux = (m: { el: number; lit: number }) => MOON_LUX * m.lit * Math.max(0, Math.sin(m.el)) ** 0.8;

// How hidden the sun is behind cloud, 0 to 1 (the renderer lights with the same), and the share of the sky's light that gets
// through it.
export const COVER = { clear: 0, cloudy: 0.7, rain: 0.88, storm: 0.95 } as const;
export const through = (cover: number) => 1 - 0.9 * cover;
// The share of a clear day's light that arrives as the sun's beam, which a hill or a tree can hide, the rest being the sky's
// glow from everywhere. The beam is nothing at night and thins to nothing behind cloud.
export const beam = (el: number, cover: number) => 0.8 * Math.sqrt(Math.max(0, Math.min(1, el / (20 * DEG)))) * (1 - cover);

// When the sun has gone this far below the horizon the sky is dark: the end of civil twilight.
export const NIGHT_EL = -6 * DEG;
