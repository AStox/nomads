// A seedling's life, an hour at a time. It lives on what its spot gives it: the ground it stands in (its niche, light and
// soil, the same as decides where seed takes root: plants.ts fitHere), and water, its shallow roots wanting the soil
// moister than a grown plant does, with what's poured round it soaking in. Grown plants close by take their share of
// both, the closer and the bigger the more. It grows as the warmth, the water, the light and the soil's nourishment let
// it (plants.ts growthOf), a tree four times slower than a bush; short of what it needs it wilts, and wilted long enough
// it dies. Ecology runs it on every seedling there is; seedlingFate runs it ahead on one not yet in the ground, over the
// weather the coming days might bring, for what the world's own formulas say comes of planting there (scripts/probes.ts,
// scripts/truth.ts).
import { DAY, type Thing, type World } from "./world";
import { TREES, smooth } from "../terrain/flora";
import { around } from "./space";
import { fitHere, growthOf } from "./plants";
import { growRate } from "./light";
import { feedRate, soilWater } from "./soil";
import { islandTemp, placeTemp } from "./air";

// The weather at a turn of the sky, an hour apart: the sky, the wind over the open sea, and the rain still running off
// the land (world.ts Weather).
export type Hour = { sky: World["weather"]["sky"]; speed: number; wet: number };

// A seedling that will grow into a tree: a tree's own seed, or a nut someone pushed into the ground.
export const treeOf = (t: { species?: string; item?: string }) => (TREES as readonly string[]).includes(t.species ?? "") || t.item === "nut";
// What a seedling will grow into, as the niches name it: a tree's seedling its own kind, a nut an oak, grain grass, any
// other seed a berry bush.
export const nicheOf = (t: { species?: string; item?: string }) => (treeOf(t) ? (t.species && t.species !== "berry" ? t.species : "oak") : t.item === "grain" ? "grass" : "berry");
// The share of the light and water at a spot left to a seedling this far along (stage) by the grown plants close round
// it: all of it with none within two meters, half with a bush right beside it, less with more. Seedlings further along
// than it count a little; itself (self), not at all.
export function shareAt(w: World, px: number, py: number, stage = 0, self?: Thing) {
  let take = 0;
  around(w, px, py, 2, ["tree", "bush", "dead_bush", "sapling"], (o, d) => { if (o !== self && (o.kind !== "sapling" || (o.stage ?? 0) > stage)) take += Math.max(0, 1 - d / 2) * (o.kind === "tree" ? 1.5 : o.kind === "sapling" ? 0.3 : 1); });
  return 1 / (1 + take);
}

// An hour of a seedling's life: it grows by what it drinks and the pace the spot allows (grows: plants.ts growthOf), and
// wilts while what it gets of the light and water falls short. Up, once grown; withered, once wilted through.
export function seedlingHour(s: { stage?: number; hp?: number; maxHp?: number; water?: number }, fit: number, share: number, soil: number, grows: number, tree: boolean): "up" | "withered" | null {
  const drink = smooth(0.35, 0.75, (soil + (s.water ?? 0)) * share);
  s.stage = (s.stage ?? 0) + (12 / (3 * DAY)) * (tree ? 0.25 : 1) * grows * (0.4 + 0.6 * drink) * (0.5 + 0.5 * fit) * share;
  s.hp = Math.min(s.maxHp ?? 5, (s.hp ?? 5) + 0.25 * (fit * drink * share - 0.25));
  if (s.water && (s.water *= 0.97) < 0.02) delete s.water;
  return s.hp <= 0 ? "withered" : s.stage >= 1 ? "up" : null;
}

// The weather's part in a seedling's hours ahead at a place: the soil's water and the air's warmth at each turn of the
// sky after tick `at` (the first as ecology first tends what goes in at `at`), the same for every spot a few paces round
// it, which share the island's fields.
export type Ahead = { soil: number[]; temp: number[] };
export function ahead(w: World, px: number, py: number, at: number, hours: Hour[]): Ahead {
  const soil: number[] = [], temp: number[] = [];
  let t = Math.ceil((at + 1) / 12) * 12;
  for (const h of hours) {
    soil.push(soilWater(w, px, py, t, h.wet));
    temp.push(islandTemp(t, h.sky) + placeTemp(w, px, py, t, h.sky, h.speed));
    t += 12;
  }
  return { soil, temp };
}
// What a spot gives a seedling of a niche: how well it fits it, the share of the light and water the plants round it
// leave it, and the pace the light and the soil's nourishment allow its growing.
export type Bed = { fit: number; share: number; light: number; feed: number };
export const bedAt = (w: World, px: number, py: number, niche: string): Bed => ({ fit: fitHere(w, niche, px, py), share: shareAt(w, px, py), light: growRate(w, px, py), feed: feedRate(w, px, py) });
// What comes of seed pushed into the ground in a bed, the weather to come being what `ahead` makes of it: how many hours
// on it comes up, or null if it withers or is still a seedling when the hours run out. tree: a tree's seed, four times
// slower; water: what's poured round it.
export function seedlingFate(bed: Bed, tree: boolean, to: Ahead, water = 0): number | null {
  const s = { stage: 0, hp: 5, maxHp: 5, water };
  for (let i = 0; i < to.soil.length; i++) {
    const r = seedlingHour(s, bed.fit, bed.share, to.soil[i], growthOf(to.temp[i], to.soil[i], bed.light, bed.feed), tree);
    if (r) return r === "up" ? i : null;
  }
  return null;
}
