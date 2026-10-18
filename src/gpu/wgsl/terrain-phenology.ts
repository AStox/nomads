// How much of the sun a deciduous plant's leaves take in over each of the game's seasons: the growing season index of
// Jolly, Nemani and Running (R1280) read as the share of its full leaf display, the product of three ramps on each day,
// the day's coldest air, the day's driest air and the day's length, with the limits the NFDRS's 2024 version keeps
// (R72, read in fire-constants sec. 12 and used by sim/wetness.ts for the island's grass and broadleaves):
// - the coldest air of the day, from -2 C (nothing) to 5 C (all of it);
// - the day's largest vapour pressure deficit, from 4100 Pa (nothing) down to 900 Pa (all of it);
// - the daylight, from 10 h (nothing) to 11 h (all of it), here the game's own sky at 55.1 N (sim/sky.ts daylight).
// The terrain generator holds each season's mean air, humidity and sun, so a day is built from them the way the sim draws
// its days: straight between the middles of two seasons (sim/sky.ts seasonAt), the day's range by season from Rønne's
// swings (below), and the vapour pressure as the mean air's (relative humidity times saturation, climate.ts), which the
// day's highest air holds at its lowest humidity. A season's factor is the mean over its days of the day's index, each day
// weighted by its share of the season's clear-sky light (climate.ts sunlight's clear sky), so that the sun that comes with
// the long days of late spring counts as it comes; the weights sum to one in a season, so the season's own sun, as the
// generator found it, stays what it was and the factor is only how much of it the leaves are out for.
// The tables are built here on the host, at 91 steps to each season of SEASON_DAYS real days (a step of 1.003 days);
// the kernel (terrain-ground.ts) holds them as integers, and `leafFactors` is the same law in floats for the test.
import { SEASONS, SEASON_DAYS, esat } from "../../terrain/climate";
import { NOON, YEAR_DAYS, daylight, sunAt } from "../../sim/sky";

// The index's limits (R72 and R1280): minimum air C, vapour pressure deficit Pa, daylight h.
export const TMIN_LO = -2, TMIN_HI = 5, VPD_LO = 900, VPD_HI = 4100, PHOTO_LO = 10, PHOTO_HI = 11;
export const STEPS = 91; // days of each season's table: 91.3125 real days each, so a step is 1.0034 days
const YEAR = 365.25;

// How far the day's air swings either side of its mean at Rønne by season, C: half the day's range on clear days (a mean
// cloud of 1 okta or less, no rain), overcast dry days (6 oktas or more) and days with two hours of rain or more, NOAA ISD
// 2015 to 2024 (sim/air.ts RANGE, fire-constants sec. 33, R479) [derived], twice the swing being the range. A season's
// is the mean of the three by their share of hours: rain's is the season's share of hours with rain or snow at Hammer
// Odde (climate.ts SEASONS rains), the dry rest split clear to overcast as that station's hours are, 32 to 55 (fire-constants
// sec. 33) [derived; the days' own shares at Rønne were not tabulated, gap]. The generator's terrain, sea and cold pools
// leave the range as the station's everywhere [gap].
const RANGE = { clear: [7.49, 8.72, 7.48, 4.29], cloudy: [3.21, 3.44, 3.36, 2.41], rain: [3.44, 4.94, 3.99, 2.92] };
const CLEAR_SHARE = 0.32 / (0.32 + 0.55);
export const HALF_RANGE = SEASONS.map((s, k) => {
  const dry = 1 - s.rains;
  return 0.5 * (s.rains * RANGE.rain[k] + dry * (CLEAR_SHARE * RANGE.clear[k] + (1 - CLEAR_SHARE) * RANGE.cloudy[k]));
});

const ramp = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

// The clear sky's light on level ground over a game day (climate.ts sunlight's `level`: the beam through Kasten and
// Young's air mass with a transmittance of 0.7 to the 0.678 power of it, and the sky's glow), in W/m2 summed on 15 minutes.
function clearDay(day: number) {
  const S0 = 1361;
  let sum = 0;
  for (let hour = 0; hour < 24; hour += 0.25) {
    const b = sunAt(day, hour), sinEl = Math.sin(b.el);
    if (sinEl <= 0.005) continue;
    const am = 1 / (sinEl + 0.50572 * (b.el / (Math.PI / 180) + 6.07995) ** -1.6364), bn = S0 * 0.7 ** (am ** 0.678);
    sum += bn * sinEl + S0 * sinEl * Math.max(0, 0.271 - (0.294 * bn) / S0);
  }
  return sum;
}

// One entry for each of the year's 4 x STEPS days, in order from the start of spring (4 February).
export type Day = {
  season: number; // the season whose window the day falls in
  from: number; // the season whose middle the day lies after, and the next one whose middle it lies before is (from + 1) % 4
  toward: number; // how far it has gone from the one middle to the next, 0 to 1
  photo: number; // the daylight ramp, 0 to 1
  weight: number; // the day's share of the season's clear-sky light, the season's days summing to one
};
export const DAYS_OF_YEAR: Day[] = [];
for (let k = 0; k < 4; k++) {
  const light = Array.from({ length: STEPS }, (_, j) => clearDay(1 + (((k * SEASON_DAYS + ((j + 0.5) * SEASON_DAYS) / STEPS) / YEAR) * YEAR_DAYS) - 0.5));
  const total = light.reduce((a, b) => a + b, 0);
  for (let j = 0; j < STEPS; j++) {
    const x = k * SEASON_DAYS + ((j + 0.5) * SEASON_DAYS) / STEPS; // real days since 4 February
    const u = (x - SEASON_DAYS / 2) / SEASON_DAYS, fl = Math.floor(u);
    const phase = (x / YEAR) * YEAR_DAYS; // game days
    // daylight(day) reads the sun at noon on the game day `day`, so the day whose noon is at this phase starts NOON / 24 before
    const hours = daylight(1 + phase - NOON / 24);
    DAYS_OF_YEAR.push({ season: k, from: ((fl % 4) + 4) % 4, toward: u - fl, photo: ramp(hours, PHOTO_LO, PHOTO_HI), weight: light[j] / total });
  }
}

// Each season's factor from the seasons' mean air (C) and relative humidity (0 to 1) at a place, in floats: the mean over
// the season's days of the index.
export function leafFactors(temp: ArrayLike<number>, humid: ArrayLike<number>): number[] {
  const vapour = [0, 1, 2, 3].map((k) => Math.min(1, humid[k]) * esat(temp[k]));
  const out = [0, 0, 0, 0];
  for (const d of DAYS_OF_YEAR) {
    const a = d.from, b = (a + 1) % 4, f = d.toward;
    const T = temp[a] + (temp[b] - temp[a]) * f, half = HALF_RANGE[a] + (HALF_RANGE[b] - HALF_RANGE[a]) * f, e = vapour[a] + (vapour[b] - vapour[a]) * f;
    const cold = ramp(T - half, TMIN_LO, TMIN_HI);
    const dry = 1 - ramp(Math.max(0, esat(T + half) - e) * 1000, VPD_LO, VPD_HI);
    out[d.season] += d.weight * cold * d.photo * dry;
  }
  return out;
}

// The plants that keep their leaves through the winter, which this index does not govern: Scots pine and heather
// (evergreen) keep growth.ts's warmth ramp [design; their own winter photosynthesis is a gap].
export const EVERGREEN = ["pine", "heather"];
