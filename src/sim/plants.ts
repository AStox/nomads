// What grows where, now, and how fast (docs/research/plant-constants.md). A plant's fit at a point is its niche
// (src/terrain/niche.ts) over the island's lasting conditions there, in the light the crowns overhead leave it and on the
// soil as it has been fed or drawn down since. It grows by the sun its leaves take in, made into dry matter at Monteith's
// efficiency while it is warm enough and the soil holds water enough (FAO-56's stress coefficient), less what it burns to
// keep alive (McCree): a seedling a gram at a time, a grown plant as the share of its best it grows at now.
import { draw, envAt, fit } from "../terrain/niche";
import { SIZE, START } from "../terrain/flora";
import { SLA, keptOf, madeOf, warmEnough, watered } from "../terrain/growth";
import { CELL } from "../terrain/grid";
import { airAt } from "./air";
import { skyShare } from "./light";
import { feedRate, fertilityAt, soilWaterAt } from "./soil";
import { TILE_M, YEAR_DAYS, groundOf, type World } from "./world";

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

// ---------- what limits growth (secs. 2 and 3; terrain/growth.ts) ----------
// How fast a grown plant at a point grows now, against its best: warm and watered enough, in the light the crowns leave
// it, on the soil's nourishment (soil.ts feedRate) [gap: fertility's own physics].
export const growth = (w: World, px: number, py: number) => growthOf(airAt(w, px, py).temp, soilWaterAt(w, px, py), skyShare(w, px, py), feedRate(w, px, py));
export function growthOf(temp: number, water: number, light: number, feed: number) {
  return warmEnough(temp) * watered(water) * light * feed;
}

// ---------- a seedling's carbon (sec. 4; terrain/growth.ts) ----------
// The island's year is YEAR_DAYS days, and what plants do in a year they do in it (fire-constants sec. 12, body-constants
// sec. 10): a seedling's day is the year's 365.25 / YEAR_DAYS days of growing [design].
export const YEARS_PACE = 365.25 / YEAR_DAYS;
// What each kind of seedling is: its seed's mass, g (FloraVeg.EU, R344; the berry's R342, FloraVeg's Rubus seed being
// the whole fruitlet; grass the mean of the five grasses SLA takes), the leaf area each gram of its leaves spreads
// (growth.ts SLA), and the mass at which it stands as what the island calls a bush, a young tree or a tuft of grass, g
// [design].
export type Seedling = { seed: number; sla: number; up: number };
export const SEEDLINGS: Record<string, Seedling> = {
  berry: { seed: 0.0025, sla: SLA.berry, up: 5 },
  grass: { seed: 0.0006, sla: SLA.grass, up: 0.5 },
  oak: { seed: 3.12, sla: SLA.oak, up: 10 },
  ash: { seed: 0.0623, sla: SLA.ash, up: 10 },
  pine: { seed: 0.00658, sla: SLA.pine, up: 10 },
  aspen: { seed: 0.00011, sla: SLA.aspen, up: 10 },
};
// The dry matter a seedling of this kind and mass makes in an hour, g: what its leaves catch of the sun on the open
// ground (W/m2) in the share of it that reaches them, made while warm and watered enough and as the ground suits it
// (fit, the niche's), less what it burns to stay alive at the air's warmth; at the year's pace.
export function seedlingGain(k: Seedling, mass: number, sun: number, light: number, temp: number, water: number, fit: number) {
  return ((madeOf(k.sla, (sun * light * 3600) / 1e6, temp, water) * fit - keptOf(temp) / 24) * mass) * YEARS_PACE;
}
// The island's seasons at a point, as the generator laid its plants down by (growth.ts yearComp): each season's sun on
// the ground there (MJ/m2 a day), its mean warmth, and how full the soil's water stands.
export function seasonsHere(w: World, px: number, py: number) {
  const { isle, fine } = groundOf(w.seed), cx = (px * TILE_M - SIZE / 2 - START) / CELL, cy = (py * TILE_M - SIZE / 2 - START) / CELL;
  const at = (f: Float32Array) => fine.bilinear(f, cx, cy);
  return { sun: isle.seasons.map((s) => at(s.sun)), temp: isle.seasons.map((s) => at(s.temp)), water: isle.soilWater.map(at) };
}
