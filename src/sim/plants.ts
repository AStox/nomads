// What grows where, now, and how fast (docs/research/plant-constants.md). A plant's fit at a point is its niche
// (src/terrain/niche.ts) over the island's lasting conditions there, in the light the crowns overhead leave it and on the
// soil as it has been fed or drawn down since. It grows by the sun its leaves take in, made into dry matter at Monteith's
// efficiency while it is warm enough and the soil holds water enough (FAO-56's stress coefficient), less what it burns to
// keep alive (McCree): a seedling a gram at a time, a grown plant as the share of its best it grows at now.
import { draw, envAt, fit } from "../terrain/niche";
import { SIZE, START, clamp } from "../terrain/flora";
import { airAt, sunOn } from "./air";
import { skyShare } from "./light";
import { feedRate, fertilityAt, soilWaterAt } from "./soil";
import { DAY, TILE_M, YEAR_DAYS, groundOf, type World } from "./world";

export function fitHere(w: World, name: string, px: number, py: number) {
  return fit(name, { ...envHere(w, px, py), light: skyShare(w, px, py), fert: fertilityAt(w, px, py) });
}
// The island's lasting conditions at a point, as the niches read them (niche.ts Env): the light left out, and the soil's
// nourishment as the generator had it, both of which fitHere takes as they are now.
export function envHere(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed);
  return envAt(isle, fine.bilinear, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2, NaN, START);
}
// Of the names, the one that takes root at a point, drawn by fit and vigor as the ground's own were (r: 0..1).
export const pickHere = <T extends string>(w: World, names: readonly T[], px: number, py: number, r: number) => draw(names, names.map((n) => fitHere(w, n, px, py)), r);

// ---------- what limits growth (secs. 2 and 3) ----------
// Warm enough to grow: the NFDRS growing season index's minimum-temperature ramp, nothing at -2 C and all of it from 5 C
// (fire-constants R72), taken for the hour's air.
export const warmEnough = (temp: number) => clamp((temp + 2) / 7, 0, 1);
// Water enough: FAO-56's stress coefficient Ks (R221 eq. 84) for a root zone holding this share of what it can, with
// half of it taken before stress begins (p 0.5).
export const P_STRESS = 0.5;
export const watered = (share: number) => clamp(share / (1 - P_STRESS), 0, 1);
// How fast a grown plant at a point grows now, against its best: warm and watered enough, in the light the crowns leave
// it, on the soil's nourishment (soil.ts feedRate) [gap: fertility's own physics].
export const growth = (w: World, px: number, py: number) => growthOf(airAt(w, px, py).temp, soilWaterAt(w, px, py), skyShare(w, px, py), feedRate(w, px, py));
export function growthOf(temp: number, water: number, light: number, feed: number) {
  return warmEnough(temp) * watered(water) * light * feed;
}

// ---------- a seedling's carbon (sec. 4) ----------
// Monteith's 1.4 g of dry matter for each MJ of the sun's radiation leaves intercept (R335); half a young plant's mass in
// leaf (Poorter, R337); McCree's growth respiration, a quarter of what's made, and maintenance, 1.5% of the plant a day at
// 20 C, doubling with every 10 degrees (R336).
export const RUE = 1.4, LMF = 0.5, GROWTH_RESP = 0.25, MAINT = 0.015, Q10 = 2;
// The island's year is YEAR_DAYS days, and what plants do in a year they do in it (fire-constants sec. 12, body-constants
// sec. 10): a seedling's day is the year's 365.25 / YEAR_DAYS days of growing [design].
export const YEARS_PACE = 365.25 / YEAR_DAYS;
// What each kind of seedling is: its seed's mass, g (R338 to R342; grass [UNVERIFIED]), the leaf area each gram of its
// leaves spreads, m2 (oak R343; the rest [UNVERIFIED]), and the mass at which it stands as what the island calls a bush,
// a young tree or a tuft of grass, g [design].
export type Seedling = { seed: number; sla: number; up: number };
export const SEEDLINGS: Record<string, Seedling> = {
  berry: { seed: 0.0025, sla: 0.02, up: 5 },
  grass: { seed: 0.001, sla: 0.025, up: 0.5 },
  oak: { seed: 3.5, sla: 0.015, up: 10 },
  ash: { seed: 0.07, sla: 0.0253, up: 10 },
  pine: { seed: 0.006, sla: 0.0147, up: 10 },
  aspen: { seed: 0.0005, sla: 0.015, up: 10 },
};
// The dry matter a seedling of this kind and mass makes in an hour, g: what its leaves catch of the sun on the open
// ground (W/m2) in the share of it that reaches them, made at RUE while warm and watered enough and as the ground suits
// it (fit, the niche's), less growth respiration; less what it burns to stay alive at the air's warmth; at the year's
// pace.
export function seedlingGain(k: Seedling, mass: number, sun: number, light: number, temp: number, water: number, fit: number) {
  const leaf = k.sla * LMF * mass, made = RUE * ((sun * light * 3600) / 1e6) * leaf * warmEnough(temp) * watered(water) * fit;
  const kept = (MAINT / 24) * Q10 ** ((temp - 20) / 10) * mass;
  return ((1 - GROWTH_RESP) * made - kept) * YEARS_PACE;
}
// The share of the open sky's sun at which a seedling of a kind makes no more than it burns (its compensation point):
// on the island's midsummer day under a broken sky at 15 C, watered and on ground that suits it [design reference].
const compensations = new Map<Seedling, number>();
export function compensation(k: Seedling, day = 16) {
  const known = compensations.get(k);
  if (known !== undefined && day === 16) return known;
  let made = 0;
  for (let h = 0; h < 24; h++) made += (1 - GROWTH_RESP) * RUE * ((sunOn((day - 1) * DAY + h * 12, "cloudy") * 3600) / 1e6) * k.sla * LMF;
  const c = (MAINT * Q10 ** ((15 - 20) / 10)) / made;
  if (day === 16) compensations.set(k, c);
  return c;
}
