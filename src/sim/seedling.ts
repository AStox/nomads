// A seedling's life, an hour at a time (docs/research/plant-constants.md sec. 4). It is so many grams of dry matter, from
// its seed's on: it gains what its leaves make of the sun reaching it while it's warm and watered enough, as well as its
// ground suits it (its niche: plants.ts fitHere), and loses what it burns to stay alive. It comes up once it weighs what
// a bush, a young tree or a tuft of grass does; it withers once it has burnt down to half the most it ever weighed.
// Grown plants close by take their share of the light and the water [gap: shareAt's reach and weights], and water
// poured round it soaks in [gap: a pour's own physics]. Ecology runs it on every seedling there is; seedlingFate runs
// it ahead on one not yet in the ground, over the weather the coming days might bring, for what the world's own formulas
// say comes of planting there (scripts/probes.ts, scripts/truth.ts).
import { type Thing, type World } from "./world";
import { TREES } from "../terrain/flora";
import { around } from "./space";
import { SEEDLINGS, fitHere, seedlingGain, type Seedling } from "./plants";
import { skyShare } from "./light";
import { soilWater } from "./soil";
import { islandTemp, placeTemp, sunOn } from "./air";

// The weather at a turn of the sky, an hour apart: the sky, the wind over the open sea, and the rain still running off
// the land (world.ts Weather).
export type Hour = { sky: World["weather"]["sky"]; speed: number; wet: number };

// A seedling that will grow into a tree: a tree's own seed, or a nut someone pushed into the ground.
export const treeOf = (t: { species?: string; item?: string }) => (TREES as readonly string[]).includes(t.species ?? "") || t.item === "nut";
// What a seedling will grow into, as the niches name it: a tree's seedling its own kind, a nut an oak, grain grass, any
// other seed a berry bush.
export const nicheOf = (t: { species?: string; item?: string }) => (treeOf(t) ? (t.species && t.species !== "berry" ? t.species : "oak") : t.item === "grain" ? "grass" : "berry");
// What a seedling of this niche is (plants.ts SEEDLINGS).
export const seedlingOf = (niche: string): Seedling => SEEDLINGS[niche] ?? SEEDLINGS.berry;
// The share of the light and water at a spot left to a seedling this far along (stage) by the grown plants close round
// it: all of it with none within two meters, half with a bush right beside it, less with more. Seedlings further along
// than it count a little; itself (self), not at all [gap].
export function shareAt(w: World, px: number, py: number, stage = 0, self?: Thing) {
  let take = 0;
  around(w, px, py, 2, ["tree", "bush", "dead_bush", "sapling"], (o, d) => { if (o !== self && (o.kind !== "sapling" || (o.stage ?? 0) > stage)) take += Math.max(0, 1 - d / 2) * (o.kind === "tree" ? 1.5 : o.kind === "sapling" ? 0.3 : 1); });
  return 1 / (1 + take);
}

// What a seedling carries: its dry mass and the most it has weighed, g; how far along it is, the log of its growth from
// seed toward coming up (stage), and how well it's doing (hp, 5 at its best down to 0 at half of it), both views of
// its mass; and water poured round it.
export type Sprout = { dry?: number; peak?: number; stage?: number; hp?: number; maxHp?: number; water?: number };
const view = (s: Sprout, k: Seedling) => {
  s.stage = Math.max(0, Math.log(s.dry! / k.seed) / Math.log(k.up / k.seed));
  s.hp = 5 * Math.max(0, Math.min(1, (s.dry! / s.peak! - 0.5) / 0.5));
  s.maxHp = 5;
};
// An hour of a seedling's life at a spot: the sun on the open ground there (W/m2) and the share of it the crowns let
// through (light), the air's warmth, the root zone's water (soil), how well the ground suits it (fit) and the share of
// light and water the plants round it leave it. Up, once grown; withered, once burnt down.
export function seedlingHour(s: Sprout, k: Seedling, fit: number, share: number, soil: number, temp: number, sun: number, light: number): "up" | "withered" | null {
  s.dry ??= k.seed * Math.exp((s.stage ?? 0) * Math.log(k.up / k.seed));
  s.peak = Math.max(s.peak ?? s.dry, s.dry);
  s.dry = Math.max(0, s.dry + seedlingGain(k, s.dry, sun, light * share, temp, (soil + (s.water ?? 0)) * share, fit));
  s.peak = Math.max(s.peak, s.dry);
  if (s.water && (s.water *= 0.97) < 0.02) delete s.water;
  view(s, k);
  return s.dry <= s.peak / 2 ? "withered" : s.dry >= k.up ? "up" : null;
}

// The weather's part in a seedling's hours ahead at a place: the soil's water, the air's warmth and the sun on the open
// ground at each turn of the sky after tick `at` (the first as ecology first tends what goes in at `at`), the same for
// every spot a few paces round it, which share the island's fields.
export type Ahead = { soil: number[]; temp: number[]; sun?: number[] };
export function ahead(w: World, px: number, py: number, at: number, hours: Hour[]): Ahead {
  const soil: number[] = [], temp: number[] = [], sun: number[] = [];
  let t = Math.ceil((at + 1) / 12) * 12;
  for (const h of hours) {
    soil.push(soilWater(w, px, py, t, h.wet));
    temp.push(islandTemp(t, h.sky) + placeTemp(w, px, py, t, h.sky, h.speed));
    sun.push(sunOn(t, h.sky));
    t += 12;
  }
  return { soil, temp, sun };
}
// What a spot gives a seedling of a niche: how well it fits it, the share of the light and water the plants round it
// leave it, and the share of the sky's sun the crowns let through.
export type Bed = { fit: number; share: number; light: number; niche: string };
export const bedAt = (w: World, px: number, py: number, niche: string): Bed => ({ fit: fitHere(w, niche, px, py), share: shareAt(w, px, py), light: skyShare(w, px, py), niche });
// What comes of seed pushed into the ground in a bed, the weather to come being what `ahead` makes of it: how many hours
// on it comes up, or null if it withers or is still a seedling when the hours run out. water: what's poured round it.
export function seedlingFate(bed: Bed, to: Ahead, water = 0): number | null {
  const k = seedlingOf(bed.niche), s: Sprout = { stage: 0, water };
  for (let i = 0; i < to.soil.length; i++) {
    const r = seedlingHour(s, k, bed.fit, bed.share, to.soil[i], to.temp[i], to.sun?.[i] ?? 0, bed.light);
    if (r) return r === "up" ? i : null;
  }
  return null;
}
