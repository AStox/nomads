import type { Inv, Item } from "./world";
import { HOMES, RECIPE, type Recipe } from "./recipes";

// Abstract planning state: what I carry, what kind of place I'm standing at, what I've done.
export type PState = { inv: Inv; at: string | null; flags: string[] };
// dist: current distance to the nearest place of each kind. known: recipe ids this agent knows.
export type Ctx = { dist: Record<string, number>; known: string[]; homeTier: number };
export type PlanStep = { op: string; arg?: string };
type Op = PlanStep & { cost: number; pre: (s: PState) => boolean; eff: (s: PState) => PState; makes: string[]; place?: string };

const n = (s: PState, i: Item) => s.inv[i] ?? 0;
const add = (s: PState, i: Item, k: number): PState => ({ ...s, inv: { ...s.inv, [i]: Math.min(20, n(s, i) + k) } });
const flag = (s: PState, f: string): PState => ({ ...s, flags: [...s.flags, f].sort() });
const at = (s: PState, place: string | null): PState => ({ ...s, at: place });
export const RAW_FOOD: Item[] = ["berry", "mushroom", "fish"];
export const EDIBLE: Item[] = ["stew", "meal", "berry", "mushroom", "fish"];
export const foodCount = (inv: Inv) => EDIBLE.reduce((t, i) => t + (inv[i] ?? 0), 0);

export const SOCIAL = ["talk", "give", "trade", "share_meal", "share_fire", "help", "gossip", "teach", "insult", "take", "steal"];
export const SOCIAL_ITEM_NEEDS: Record<string, (s: PState) => boolean> = {
  give: (s) => Object.entries(s.inv).some(([i, v]) => v && !["axe", "bow_drill", "fishing_line", "pot", "wedge"].includes(i)),
  share_meal: (s) => foodCount(s.inv) > 0,
  trade: (s) => Object.values(s.inv).some((v) => (v ?? 0) > 0),
};

// Things anyone can do from the start.
const GATHER: [string, string, Item, number][] = [
  ["pick_berries", "bush", "berry", 2],
  ["pick_mushroom", "mushroom", "mushroom", 1],
  ["pick_stick", "stick", "stick", 1],
  ["pick_stone", "stone", "stone", 1],
  ["pick_reeds", "reeds", "fiber", 2],
  ["dig_clay", "clay", "clay", 2],
];
export const GATHER_OP: Record<string, { place: string; item: Item; n: number }> = Object.fromEntries(
  GATHER.map(([op, place, item, k]) => [op, { place, item, n: k }]),
);

const hasAll = (s: PState, r: Recipe) =>
  Object.entries(r.inputs).every(([i, k]) => n(s, i as Item) >= k!) && (r.tools ?? []).every((t) => n(s, t) > 0);
function recipeOp(r: Recipe, ctx: Ctx): Op {
  const home = r.makes.thing && HOMES[r.makes.thing];
  return {
    op: "craft",
    arg: r.id,
    cost: 1 + r.time / 8,
    makes: [r.makes.item ?? `place:${home ? "home" : r.makes.thing === "hearth" ? "fire" : r.makes.thing}`],
    place: r.near,
    pre: (s) => hasAll(s, r) && (!r.near || s.at === r.near) && (!home || home.tier > ctx.homeTier) && (r.id !== "make_fire" || s.at !== "fire"),
    eff: (s) => {
      let out = s;
      for (const [i, k] of Object.entries(r.inputs)) out = add(out, i as Item, -k!);
      if (r.makes.item) out = add(out, r.makes.item, r.makes.n ?? 1);
      if (r.makes.thing) out = at(out, home ? "home" : r.makes.thing === "hearth" ? "fire" : r.makes.thing);
      if (r.fells) out = at(out, null);
      return flag(out, `made:${r.id}`);
    },
  };
}

function ops(ctx: Ctx): Op[] {
  const list: Op[] = Object.entries(ctx.dist).map(([kind, d]) => ({
    op: "goto", arg: kind, cost: 1 + d / 4, makes: [`place:${kind}`], pre: (s) => s.at !== kind, eff: (s) => at(s, kind),
  }));
  for (const [op, place, item, k] of GATHER)
    list.push({ op, cost: 1.5, makes: [item], place, pre: (s) => s.at === place, eff: (s) => at(add(s, item, k), place === "bush" ? place : null) });
  for (const id of ctx.known) list.push(recipeOp(RECIPE[id], ctx));
  list.push(
    {
      op: "eat", cost: 1, makes: ["ate"], pre: (s) => foodCount(s.inv) > 0,
      eff: (s) => flag(add(s, EDIBLE.find((i) => n(s, i) > 0)!, -1), "ate"),
    },
    { op: "rest", cost: 4, makes: ["rested"], pre: (s) => s.at !== "home", eff: (s) => flag(s, "rested") },
    { op: "rest", cost: 1, makes: ["rested"], place: "home", pre: (s) => s.at === "home", eff: (s) => flag(s, "rested") },
    { op: "warm_up", cost: 1, makes: ["warm"], place: "fire", pre: (s) => s.at === "fire" || s.at === "home", eff: (s) => flag(s, "warm") },
  );
  for (const kind of SOCIAL)
    list.push({
      op: "social", arg: kind, cost: 1, makes: [`did_${kind}`], place: "agent",
      pre: (s) => s.at === "agent" && (SOCIAL_ITEM_NEEDS[kind]?.(s) ?? true), eff: (s) => flag(s, `did_${kind}`),
    });
  return list;
}

const COLLECT: Record<string, Item> = { collect_stones: "stone", collect_sticks: "stick", collect_reeds: "fiber", collect_clay: "clay" };
export const COLLECT_GOALS = COLLECT;

// Goal predicate plus what it needs, so the search only considers ops that can matter.
function goal(type: string, start: PState): { done: (s: PState) => boolean; needs: string[] } | null {
  if (type === "forage") return { done: (s) => foodCount(s.inv) >= Math.max(3, foodCount(start.inv) + 2), needs: RAW_FOOD };
  if (type === "eat") return { done: (s) => s.flags.includes("ate"), needs: ["ate"] };
  if (type === "rest") return { done: (s) => s.flags.includes("rested"), needs: ["rested"] };
  if (type === "warm_up") return { done: (s) => s.flags.includes("warm"), needs: ["warm"] };
  if (COLLECT[type]) { const i = COLLECT[type]; return { done: (s) => n(s, i) >= n(start, i) + 3, needs: [i] }; }
  if (type.startsWith("make:")) { const id = type.slice(5); return { done: (s) => s.flags.includes(`made:${id}`), needs: [`craft:${id}`] }; }
  if (type.startsWith("have:")) { const [, i, k] = type.split(":"); return { done: (s) => n(s, i as Item) >= +k, needs: [i] }; }
  if (SOCIAL.includes(type)) return { done: (s) => s.flags.includes(`did_${type}`), needs: [`did_${type}`] };
  return null;
}

// Walk backwards from what the goal needs to every op that could help, including the places they need.
function relevant(all: Op[], needs: string[], ctx: Ctx): Op[] {
  const want = new Set(needs), keep = new Set<Op>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of all) {
      if (keep.has(o)) continue;
      const hit = o.makes.some((m) => want.has(m)) || (o.op === "craft" && want.has(`craft:${o.arg}`));
      if (!hit) continue;
      keep.add(o);
      grew = true;
      // Only chase places that exist, except fire, which you can make.
      for (const p of o.op === "warm_up" ? ["fire", "home"] : o.place ? [o.place] : [])
        if (p in ctx.dist || p === "fire") want.add(`place:${p}`);
      if (o.op === "craft") {
        const r = RECIPE[o.arg!];
        for (const i of [...Object.keys(r.inputs), ...(r.tools ?? [])]) want.add(i);
      }
      if (o.op === "eat") for (const i of EDIBLE) want.add(i);
    }
  }
  return all.filter((o) => keep.has(o));
}

// Big projects (a cabin from nothing) are too deep to search in one go, so plan toward
// the first missing ingredient instead. The agent keeps the goal and replans when that runs out.
export function plan(start: PState, type: string, ctx: Ctx): PlanStep[] | null {
  const full = search(start, type, ctx);
  if (full || !type.startsWith("make:")) return full;
  return stepping(start, RECIPE[type.slice(5)], ctx, 3);
}
function stepping(start: PState, r: Recipe, ctx: Ctx, depth: number): PlanStep[] | null {
  if (!r || !ctx.known.includes(r.id) || depth === 0) return null;
  const needs: [Item, number][] = [...Object.entries(r.inputs), ...(r.tools ?? []).map((t) => [t, 1])] as [Item, number][];
  for (const [i, k] of needs) {
    if (n(start, i) >= k) continue;
    const direct = search(start, `have:${i}:${n(start, i) + 1}`, ctx);
    if (direct) return direct;
    const maker = ctx.known.map((id) => RECIPE[id]).find((x) => x.makes.item === i);
    const deeper = maker && stepping(start, maker, ctx, depth - 1);
    if (deeper) return deeper;
  }
  return null;
}

// ponytail: uniform-cost search over a small abstract state, pruned per goal; stepping() covers what's too deep for it.
function search(start: PState, type: string, ctx: Ctx): PlanStep[] | null {
  const g = goal(type, start);
  if (!g) return null;
  if (g.done(start)) return [];
  const all = relevant(ops(ctx), g.needs, ctx);
  const key = (s: PState) => `${s.at}|${s.flags.join(",")}|${Object.entries(s.inv).filter(([, v]) => v).sort().join(",")}`;
  const open = [{ s: start, cost: 0, steps: [] as PlanStep[] }];
  const seen = new Set<string>([key(start)]);
  while (open.length && seen.size < 20000) {
    const cur = open.shift()!;
    if (cur.steps.length >= 18) continue;
    for (const o of all) {
      if (!o.pre(cur.s)) continue;
      const s = o.eff(cur.s);
      const steps = [...cur.steps, { op: o.op, arg: o.arg }];
      if (g.done(s)) return steps;
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
