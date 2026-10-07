// What grows where, now. A plant's fit at a point is its niche (src/terrain/niche.ts) over the island's lasting conditions
// there, in the light the crowns overhead leave it and on the soil as it has been fed or drawn down since. How fast
// anything grows is the air's warmth, the soil's water, the light and the soil's nourishment, as they stand now.
import { draw, envAt, fit } from "../terrain/niche";
import { SIZE, START } from "../terrain/flora";
import { airAt } from "./air";
import { warmRate } from "./cues";
import { growRate, skyShare } from "./light";
import { feedRate, fertilityAt, soilWaterAt } from "./soil";
import { TILE_M, groundOf, type World } from "./world";

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
// How fast what grows at a point grows now, 0 to about 1.25.
export const growth = (w: World, px: number, py: number) => growthOf(airAt(w, px, py).temp, soilWaterAt(w, px, py), growRate(w, px, py), feedRate(w, px, py));
// The same from the air's warmth, the soil's water, and the pace the light and the soil's nourishment allow (light.ts
// growRate, soil.ts feedRate).
export function growthOf(temp: number, water: number, light: number, feed: number) {
  const dry = Math.max(0, Math.min(1, (water - 0.05) / 0.3));
  return warmRate(temp) * dry * dry * (3 - 2 * dry) * light * feed;
}
