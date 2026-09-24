import type { Inv, Item, ThingKind } from "./world";

// The hidden recipe book. Agents can't see it; they find entries by tinkering, watching, or being taught.
export type Recipe = {
  id: string;
  label: string; // "haft a stone axe", reads after "how to"
  craft: string;
  inputs: Inv; // used up
  tools?: Item[]; // needed, not used up
  near?: ThingKind | "water" | "home";
  makes: { item?: Item; n?: number; thing?: ThingKind };
  fells?: boolean; // turns the tree it's next to into a stump
  difficulty: number; // 0 easy to 1 hard, for a first try
  time: number; // ticks at level 0
};

export const RECIPES: Recipe[] = [
  { id: "knap", label: "knap a sharp stone", craft: "stonework", inputs: { stone: 2 }, makes: { item: "sharp_stone" }, difficulty: 0.3, time: 6 },
  { id: "twist_cord", label: "twist fiber into cord", craft: "fibercraft", inputs: { fiber: 2 }, makes: { item: "cord" }, difficulty: 0.3, time: 5 },
  { id: "stone_axe", label: "haft a stone axe", craft: "stonework", inputs: { sharp_stone: 1, stick: 1, cord: 1 }, makes: { item: "axe" }, difficulty: 0.5, time: 8 },
  { id: "fell_tree", label: "fell a tree for logs", craft: "woodworking", inputs: {}, tools: ["axe"], near: "tree", makes: { item: "log", n: 2 }, fells: true, difficulty: 0.25, time: 8 },
  { id: "lean_to", label: "build a lean-to", craft: "building", inputs: { stick: 4, fiber: 2 }, makes: { thing: "lean_to" }, difficulty: 0.35, time: 16 },
  { id: "log_hut", label: "build a log hut", craft: "building", inputs: { log: 4, cord: 2 }, makes: { thing: "log_hut" }, difficulty: 0.55, time: 26 },
  { id: "bow_drill", label: "make a bow drill", craft: "firemaking", inputs: { stick: 2, cord: 1 }, makes: { item: "bow_drill" }, difficulty: 0.55, time: 8 },
  { id: "make_fire", label: "start a fire with a bow drill", craft: "firemaking", inputs: { stick: 2, fiber: 1 }, tools: ["bow_drill"], makes: { thing: "fire" }, difficulty: 0.5, time: 8 },
  { id: "roast", label: "roast a mushroom over a fire", craft: "cooking", inputs: { mushroom: 1 }, near: "fire", makes: { item: "meal" }, difficulty: 0.2, time: 5 },
  { id: "fishing_line", label: "make a fishing line", craft: "fishing", inputs: { stick: 1, cord: 1 }, near: "water", makes: { item: "fishing_line" }, difficulty: 0.4, time: 6 },
  { id: "fish", label: "catch a fish", craft: "fishing", inputs: {}, tools: ["fishing_line"], near: "water", makes: { item: "fish" }, difficulty: 0.35, time: 10 },
  { id: "roast_fish", label: "cook a fish over a fire", craft: "cooking", inputs: { fish: 1 }, near: "fire", makes: { item: "meal" }, difficulty: 0.2, time: 5 },
  { id: "wedge", label: "carve a wooden wedge", craft: "woodworking", inputs: { log: 1 }, tools: ["sharp_stone"], makes: { item: "wedge" }, difficulty: 0.45, time: 8 },
  { id: "split_planks", label: "split logs into planks", craft: "woodworking", inputs: { log: 1 }, tools: ["axe", "wedge"], makes: { item: "plank", n: 2 }, difficulty: 0.6, time: 10 },
  { id: "cabin", label: "build a plank cabin", craft: "building", inputs: { plank: 6, log: 2, cord: 2 }, makes: { thing: "cabin" }, difficulty: 0.65, time: 40 },
  { id: "pot", label: "fire a clay pot", craft: "pottery", inputs: { clay: 2 }, near: "fire", makes: { item: "pot" }, difficulty: 0.5, time: 10 },
  { id: "stew", label: "cook a stew in a pot", craft: "cooking", inputs: { mushroom: 1, berry: 2 }, tools: ["pot"], near: "fire", makes: { item: "stew" }, difficulty: 0.4, time: 8 },
  { id: "brick", label: "fire clay into bricks", craft: "pottery", inputs: { clay: 2, fiber: 1 }, near: "fire", makes: { item: "brick", n: 2 }, difficulty: 0.55, time: 12 },
  { id: "hearth", label: "build a brick hearth at home", craft: "building", inputs: { brick: 6, stone: 2 }, near: "home", makes: { thing: "hearth" }, difficulty: 0.6, time: 20 },
];
export const RECIPE: Record<string, Recipe> = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

// Better homes rest and warm you faster; you only build one that beats what you have.
export const HOMES: Partial<Record<ThingKind, { tier: number; rest: number; warmth: number }>> = {
  lean_to: { tier: 1, rest: 1.0, warmth: 0.6 },
  log_hut: { tier: 2, rest: 1.3, warmth: 0.9 },
  cabin: { tier: 3, rest: 1.6, warmth: 1.2 },
};

// What a tinkering attempt has to look like to hit a recipe: these item types, maybe at this place.
export const signature = (r: Recipe) => [...Object.keys(r.inputs), ...(r.tools ?? [])].sort().join("+");
