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
  const { isle, fine } = groundOf(w.seed), env = envAt(isle, fine.bilinear, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2, skyShare(w, px, py), START);
  env.fert = fertilityAt(w, px, py);
  return fit(name, env);
}
// Of the names, the one that takes root at a point, drawn by fit and vigor as the ground's own were (r: 0..1).
export const pickHere = <T extends string>(w: World, names: readonly T[], px: number, py: number, r: number) => draw(names, names.map((n) => fitHere(w, n, px, py)), r);
// How fast what grows at a point grows now, 0 to about 1.25.
export function growth(w: World, px: number, py: number) {
  const water = soilWaterAt(w, px, py), dry = Math.max(0, Math.min(1, (water - 0.05) / 0.3));
  return warmRate(airAt(w, px, py).temp) * dry * dry * (3 - 2 * dry) * growRate(w, px, py) * feedRate(w, px, py);
}
