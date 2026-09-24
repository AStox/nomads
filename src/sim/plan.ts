import type { Inv, Item } from "./world";

// Abstract planning state: what I carry, what kind of place I'm standing at, what I've done.
export type PState = { inv: Inv; at: string | null; flags: string[] };
// dist: current distance to the nearest place of each kind ("bush", "tree", "fire", "home", "agent").
export type Ctx = { dist: Record<string, number>; hasHome: boolean };
type Op = { op: string; arg?: string; cost: number; pre: (s: PState) => boolean; eff: (s: PState) => PState };

const n = (s: PState, i: Item) => s.inv[i] ?? 0;
const add = (s: PState, i: Item, k: number): PState => ({ ...s, inv: { ...s.inv, [i]: Math.min(20, n(s, i) + k) } });
const flag = (s: PState, f: string): PState => ({ ...s, flags: [...s.flags, f].sort() });
const at = (s: PState, place: string | null): PState => ({ ...s, at: place });
export const foodCount = (inv: Inv) => (inv.berry ?? 0) + (inv.mushroom ?? 0) + (inv.meal ?? 0);

export const SOCIAL_ITEM_NEEDS: Record<string, (s: PState) => boolean> = {
  give: (s) => foodCount(s.inv) > 0 || n(s, "wood") > 0 || n(s, "stick") > 0 || n(s, "stone") > 0,
  share_meal: (s) => foodCount(s.inv) > 0,
  trade: (s) => Object.values(s.inv).some((v) => (v ?? 0) > 0),
};
export const SOCIAL = ["talk", "give", "trade", "share_meal", "share_fire", "help", "gossip", "insult", "take", "steal"];

function ops(ctx: Ctx): Op[] {
  const list: Op[] = Object.entries(ctx.dist).map(([kind, d]) => ({
    op: "goto",
    arg: kind,
    cost: 1 + d / 4,
    pre: (s) => s.at !== kind,
    eff: (s) => at(s, kind),
  }));
  list.push(
    { op: "pick_berries", cost: 3, pre: (s) => s.at === "bush", eff: (s) => add(s, "berry", 2) },
    { op: "pick_mushroom", cost: 2, pre: (s) => s.at === "mushroom", eff: (s) => at(add(s, "mushroom", 1), null) },
    { op: "pick_stick", cost: 1, pre: (s) => s.at === "stick", eff: (s) => at(add(s, "stick", 1), null) },
    { op: "pick_stone", cost: 1, pre: (s) => s.at === "stone", eff: (s) => at(add(s, "stone", 1), null) },
    {
      op: "craft_axe",
      cost: 3,
      pre: (s) => n(s, "stick") > 0 && n(s, "stone") > 0,
      eff: (s) => add(add(add(s, "stick", -1), "stone", -1), "axe", 1),
    },
    { op: "chop", cost: 3, pre: (s) => s.at === "tree" && n(s, "axe") > 0, eff: (s) => at(add(s, "wood", 2), null) },
    {
      op: "light_fire",
      cost: 2,
      pre: (s) => s.at !== "fire" && n(s, "wood") > 0 && n(s, "stick") > 0,
      eff: (s) => at(add(add(s, "wood", -1), "stick", -1), "fire"),
    },
    {
      op: "cook",
      cost: 2,
      pre: (s) => s.at === "fire" && (n(s, "mushroom") > 0 || n(s, "berry") > 1),
      eff: (s) => add(n(s, "mushroom") > 0 ? add(s, "mushroom", -1) : add(s, "berry", -2), "meal", 1),
    },
    {
      op: "build_shelter",
      cost: 5,
      pre: (s) => !ctx.hasHome && !s.flags.includes("built") && n(s, "wood") >= 4 && n(s, "stick") >= 2,
      eff: (s) => at(flag(add(add(s, "wood", -4), "stick", -2), "built"), "home"),
    },
    {
      op: "eat",
      cost: 1,
      pre: (s) => foodCount(s.inv) > 0,
      eff: (s) => flag(add(s, n(s, "meal") ? "meal" : n(s, "berry") ? "berry" : "mushroom", -1), "ate"),
    },
    { op: "rest", cost: 4, pre: (s) => s.at !== "home", eff: (s) => flag(s, "rested") },
    { op: "rest", cost: 1, pre: (s) => s.at === "home", eff: (s) => flag(s, "rested") },
    { op: "warm_up", cost: 1, pre: (s) => s.at === "fire" || s.at === "home", eff: (s) => flag(s, "warm") },
  );
  for (const kind of SOCIAL)
    list.push({
      op: "social",
      arg: kind,
      cost: 1,
      pre: (s) => s.at === "agent" && (SOCIAL_ITEM_NEEDS[kind]?.(s) ?? true),
      eff: (s) => flag(s, `did_${kind}`),
    });
  return list;
}

// Goal predicates, built from the starting state so "gather more" goals mean more than I have now.
export function goalTest(type: string, start: PState): ((s: PState) => boolean) | null {
  const food0 = foodCount(start.inv);
  switch (type) {
    case "forage": return (s) => foodCount(s.inv) >= Math.max(3, food0 + 2);
    case "eat": return (s) => s.flags.includes("ate");
    case "gather_wood": return (s) => n(s, "wood") >= n(start, "wood") + 3;
    case "craft_tool": return (s) => n(s, "axe") > 0;
    case "build_shelter": return (s) => s.flags.includes("built");
    case "start_fire": return (s) => s.at === "fire";
    case "cook_meal": return (s) => n(s, "meal") > n(start, "meal");
    case "rest": return (s) => s.flags.includes("rested");
    case "warm_up": return (s) => s.flags.includes("warm");
  }
  return SOCIAL.includes(type) ? (s) => s.flags.includes(`did_${type}`) : null;
}

// Which ops can matter for each goal. Pruning here is what keeps the search small.
const FOOD_OPS = ["pick_berries", "pick_mushroom"];
const WOOD_OPS = ["pick_stick", "pick_stone", "craft_axe", "chop"];
const FIRE_OPS = [...WOOD_OPS, "light_fire"];
const RELEVANT: Record<string, string[]> = {
  forage: FOOD_OPS,
  eat: [...FOOD_OPS, "eat"],
  gather_wood: WOOD_OPS,
  craft_tool: ["pick_stick", "pick_stone", "craft_axe"],
  build_shelter: [...WOOD_OPS, "build_shelter"],
  start_fire: FIRE_OPS,
  cook_meal: [...FOOD_OPS, ...FIRE_OPS, "cook"],
  rest: ["rest"],
  warm_up: [...FIRE_OPS, "warm_up"],
  give: [...FOOD_OPS, "pick_stick", "pick_stone", "social"],
  trade: [...FOOD_OPS, "pick_stick", "pick_stone", "social"],
  share_meal: [...FOOD_OPS, "social"],
};
const PLACE_FOR: Record<string, string[]> = {
  pick_berries: ["bush"], pick_mushroom: ["mushroom"], pick_stick: ["stick"], pick_stone: ["stone"],
  chop: ["tree"], cook: ["fire"], light_fire: ["fire"], warm_up: ["fire", "home"], rest: ["home"], social: ["agent"],
};

// ponytail: uniform-cost search over a tiny abstract state, pruned per goal; add a heuristic if plans get deeper than ~16 steps.
export function plan(start: PState, type: string, ctx: Ctx): { op: string; arg?: string }[] | null {
  const done = goalTest(type, start);
  if (!done) return null;
  if (done(start)) return [];
  const allowed = RELEVANT[type] ?? ["social"];
  const places = allowed.flatMap((o) => PLACE_FOR[o] ?? []);
  const all = ops(ctx).filter((o) =>
    o.op === "goto" ? places.includes(o.arg!) : allowed.includes(o.op) && (o.op !== "social" || o.arg === type),
  );
  const key = (s: PState) => `${s.at}|${s.flags.join(",")}|${Object.entries(s.inv).filter(([, v]) => v).sort().join(",")}`;
  const open = [{ s: start, cost: 0, steps: [] as { op: string; arg?: string }[] }];
  const seen = new Set<string>([key(start)]);
  while (open.length && seen.size < 20000) {
    const cur = open.shift()!;
    if (cur.steps.length >= 16) continue;
    for (const o of all) {
      if (!o.pre(cur.s)) continue;
      const s = o.eff(cur.s);
      const steps = [...cur.steps, { op: o.op, arg: o.arg }];
      if (done(s)) return steps;
      const k = key(s);
      if (seen.has(k)) continue;
      seen.add(k);
      const node = { s, cost: cur.cost + o.cost, steps };
      const i = open.findIndex((x) => x.cost > node.cost);
      open.splice(i < 0 ? open.length : i, 0, node);
    }
  }
  return null;
}
