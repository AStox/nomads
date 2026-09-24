// GOAP over what each agent believes. Agents can only plan with things they've seen work.
import type { Belief } from "./beliefs";
import { THING_MATERIAL, p, type Registry } from "./materials";

export type PState = { inv: Record<string, number>; at: string | null; flags: string[] };
export type Ctx = {
  dist: Record<string, number>; // nearest distance to each kind of place
  beliefs: Belief[];
  facts: Record<string, string>;
  kinds: Registry;
  toxic: string[]; // kinds they believe make you sick
  store?: Record<string, number>; // what's kept in their home
};
export type PlanStep = { op: string; arg?: string; key?: string };
type Op = PlanStep & { cost: number; needs: string[]; makes: string[]; pre: (s: PState) => boolean; eff: (s: PState) => PState };

const n = (s: PState, k: string) => s.inv[k] ?? 0;
const add = (s: PState, k: string, d: number): PState => ({ ...s, inv: { ...s.inv, [k]: Math.max(0, Math.min(24, n(s, k) + d)) } });
const flag = (s: PState, f: string): PState => (s.flags.includes(f) ? s : { ...s, flags: [...s.flags, f].sort() });
const at = (s: PState, place: string | null): PState => ({ ...s, at: place });

export const SOCIAL = ["talk", "give", "trade", "share_meal", "share_fire", "help", "gossip", "teach", "tend", "insult", "take", "steal", "attack"];
export const SOCIAL_ITEM_NEEDS: Record<string, (s: PState, kinds: Registry) => boolean> = {
  give: (s) => Object.values(s.inv).some((v) => v > 0),
  share_meal: (s, kinds) => Object.entries(s.inv).some(([k, v]) => v && p(kinds[k], "edible") > 0.1),
  trade: (s) => Object.values(s.inv).some((v) => v > 0),
};

// What anyone can do from birth.
export const GATHER: Record<string, { place: string; item: string; n: number; keep?: boolean }> = {
  pick_berries: { place: "bush", item: "berry", n: 2, keep: true },
  pick_mushroom: { place: "mushroom", item: "mushroom", n: 1 },
  pick_herb: { place: "herb", item: "herb", n: 1 },
  pick_stick: { place: "stick", item: "stick", n: 1 },
  pick_stone: { place: "stone", item: "stone", n: 1 },
  pull_reeds: { place: "reeds", item: "fiber", n: 2 },
  dig_clay: { place: "clay", item: "clay", n: 2, keep: true },
};

export const edibleKinds = (ctx: Ctx) => Object.keys(ctx.kinds).filter((k) => p(ctx.kinds[k], "edible") >= 0.1 && !ctx.toxic.includes(k));
export const foodIn = (inv: Record<string, number>, ctx: Ctx) => edibleKinds(ctx).reduce((t, k) => t + (inv[k] ?? 0), 0);

// What the belief needs in hand, not counting what the world provides.
function required(b: Belief): Record<string, number> {
  const req: Record<string, number> = {};
  for (const k of b.fields.inputs) req[k] = (req[k] ?? 0) + 1;
  for (const [k, v] of Object.entries(b.uses)) req[k] = Math.max(req[k] ?? 0, v);
  if (b.fields.tool) req[b.fields.tool] = (req[b.fields.tool] ?? 0) + 1; // held and swung, on top of what's worked
  if (b.spurious) req[b.spurious] = Math.max(req[b.spurious] ?? 0, 1);
  return req;
}
function outputs(b: Belief, ctx: Ctx): Record<string, number> {
  if (Object.keys(b.out).length) return b.out;
  const target = b.fields.target;
  if ((b.fields.verb === "strike" || b.fields.verb === "throw") && target && (b.rate ?? 0) > 0 && ctx.facts[`breaks:${target}`]) return THING_MATERIAL[target]?.breaks ?? {};
  return {};
}
const PLACE_OF: Record<string, string> = { fire: "fire", hearth: "fire", fed_fire: "fire", pit: "pit" };

function beliefOp(b: Belief, ctx: Ctx): Op | null {
  const req = required(b), out = outputs(b, ctx);
  const f = b.fields;
  const target = (f.verb === "strike" && f.target && !f.inputs.length) || f.verb === "throw" ? f.target ?? null : null;
  const place = target ?? f.at ?? (f.builds === "shelter" && "home" in ctx.dist ? "home" : null);
  const builds = f.builds ?? (f.effect === "cure" ? "cured" : null);
  if (!Object.keys(out).length && !builds) return null;
  if ((f.verb === "strike" || f.verb === "throw") && target && (b.rate ?? 0) <= 0 && b.wins === 0) return null;
  if (f.verb !== "strike" && f.verb !== "throw" && b.wins === 0) return null;
  if (f.verb === "eat") return null;
  const wr = Math.max(0.2, (b.wins + 1) / (b.tries + 2));
  const prey = target === "deer" || target === "wolf" ? `hunted:${target}` : null;
  const makes = [...Object.keys(out), ...(builds ? [builds] : []), ...(prey ? [prey] : []), ...(PLACE_OF[builds ?? ""] ? [`place:${PLACE_OF[builds!]}`] : [])];
  if (builds === "shelter") makes.push("place:home");
  return {
    op: "act", key: b.key, arg: b.key,
    cost: 1 + b.ticks / 8 / wr,
    needs: [...Object.keys(req), ...(place ? [`place:${place}`] : [])],
    makes,
    pre: (s) => Object.entries(req).every(([k, v]) => n(s, k) >= v) && (!place || s.at === place) && !(builds === "fire" && s.at === "fire"),
    eff: (s) => {
      let o = s;
      for (const [k, v] of Object.entries(b.uses)) o = add(o, k, -v);
      for (const [k, v] of Object.entries(out)) o = add(o, k, v);
      if (builds) o = flag(o, builds);
      if (prey) o = flag(o, prey);
      if (PLACE_OF[builds ?? ""]) o = at(o, PLACE_OF[builds!]);
      if (builds === "shelter") o = at(o, "home");
      if (target) o = at(o, null);
      return o;
    },
  };
}

function ops(ctx: Ctx): Op[] {
  const list: Op[] = Object.entries(ctx.dist).map(([place, d]) => ({
    op: "goto", arg: place, cost: 1 + d / 4, needs: [], makes: [`place:${place}`], pre: (s) => s.at !== place, eff: (s) => at(s, place),
  }));
  for (const [op, g] of Object.entries(GATHER))
    list.push({ op, cost: 1.5, needs: [`place:${g.place}`], makes: [g.item], pre: (s) => s.at === g.place, eff: (s) => at(add(s, g.item, g.n), g.keep ? g.place : null) });
  for (const place of Object.keys(ctx.dist).filter((x) => x.startsWith("item:"))) {
    const k = place.slice(5);
    list.push({ op: "pick_up", arg: k, cost: 1, needs: [`place:${place}`], makes: [k], pre: (s) => s.at === place, eff: (s) => at(add(s, k, 1), null) });
  }
  for (const b of ctx.beliefs) { const o = beliefOp(b, ctx); if (o) list.push(o); }
  // Anyone can put things away at home and take them back out.
  if ("home" in ctx.dist) {
    list.push({ op: "stash", cost: 1, needs: ["place:home"], makes: ["stashed"], pre: (s) => s.at === "home", eff: (s) => flag(s, "stashed") });
    for (const [k, v] of Object.entries(ctx.store ?? {}))
      if (v > 0) list.push({ op: "take_stored", arg: k, cost: 1, needs: ["place:home"], makes: [k], pre: (s) => s.at === "home", eff: (s) => add(s, k, Math.min(v, 3)) });
  }
  // Anyone who has seen what an animal is inside can try to kill one with whatever they hold.
  for (const sp of ["deer", "wolf"]) {
    if (!ctx.facts[`breaks:${sp}`] || !(sp in ctx.dist)) continue;
    const out = THING_MATERIAL[sp].breaks;
    list.push({
      op: "hunt", arg: sp, cost: 12, needs: [`place:${sp}`], makes: [`hunted:${sp}`, ...Object.keys(out)],
      pre: (s) => s.at === sp, eff: (s) => { let o = flag(at(s, null), `hunted:${sp}`); for (const [k, v] of Object.entries(out)) o = add(o, k, v); return o; },
    });
  }
  const edible = edibleKinds(ctx);
  list.push(
    { op: "eat", cost: 1, needs: edible, makes: ["ate"], pre: (s) => edible.some((k) => n(s, k) > 0), eff: (s) => flag(add(s, edible.find((k) => n(s, k) > 0)!, -1), "ate") },
    { op: "rest", cost: 4, needs: [], makes: ["rested"], pre: (s) => s.at !== "home", eff: (s) => flag(s, "rested") },
    { op: "rest", cost: 1, needs: ["place:home"], makes: ["rested"], pre: (s) => s.at === "home", eff: (s) => flag(s, "rested") },
    { op: "warm_up", cost: 1, needs: ["place:fire"], makes: ["warm"], pre: (s) => s.at === "fire" || s.at === "home", eff: (s) => flag(s, "warm") },
    { op: "warm_up", cost: 1, needs: ["place:home"], makes: ["warm"], pre: (s) => s.at === "home", eff: (s) => flag(s, "warm") },
  );
  for (const k of SOCIAL)
    list.push({
      op: "social", arg: k, cost: 1, needs: ["place:agent"], makes: [`did_${k}`],
      pre: (s) => s.at === "agent" && (SOCIAL_ITEM_NEEDS[k]?.(s, ctx.kinds) ?? true), eff: (s) => flag(s, `did_${k}`),
    });
  return list;
}

export const COLLECT: Record<string, string> = { collect_stones: "stone", collect_sticks: "stick", collect_reeds: "fiber", collect_clay: "clay" };

function goal(type: string, start: PState, ctx: Ctx): { done: (s: PState) => boolean; needs: string[] } | null {
  const has = (flagName: string) => (s: PState) => s.flags.includes(flagName);
  if (type === "forage") { const f0 = foodIn(start.inv, ctx); return { done: (s) => foodIn(s.inv, ctx) >= Math.max(3, f0 + 2), needs: edibleKinds(ctx) }; }
  if (type === "eat") return { done: has("ate"), needs: ["ate"] };
  if (type === "rest") return { done: has("rested"), needs: ["rested"] };
  if (type === "warm_up") return { done: has("warm"), needs: ["warm"] };
  if (COLLECT[type]) { const k = COLLECT[type]; return { done: (s) => n(s, k) >= n(start, k) + 3, needs: [k] }; }
  if (type.startsWith("make:")) { const k = type.slice(5); return { done: (s) => n(s, k) > n(start, k), needs: [k] }; }
  if (type.startsWith("have:")) { const [, k, c] = type.split(":"); return { done: (s) => n(s, k) >= +c, needs: [k] }; }
  if (type.startsWith("hunt:")) { const f = `hunted:${type.slice(5)}`; return { done: has(f), needs: [f] }; }
  if (type === "make_fire") return { done: has("fire"), needs: ["fire"] };
  if (type === "build_shelter") return { done: has("shelter"), needs: ["shelter"] };
  if (type === "contain_fire") return { done: has("hearth"), needs: ["hearth"] };
  if (type === "plant") return { done: has("bush"), needs: ["bush"] };
  if (type === "cure") return { done: has("cured"), needs: ["cured"] };
  if (type === "put_on") return { done: has("worn"), needs: ["worn"] };
  if (type === "dig_pit") return { done: has("pit"), needs: ["pit"] };
  if (type === "set_trap") return { done: has("trap"), needs: ["trap"] };
  if (type === "store_food") return { done: has("stashed"), needs: ["stashed"] };
  if (SOCIAL.includes(type)) return { done: has(`did_${type}`), needs: [`did_${type}`] };
  return null;
}

function relevant(all: Op[], needs: string[]): Op[] {
  const want = new Set(needs), keep = new Set<Op>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of all) {
      if (keep.has(o) || !o.makes.some((m) => want.has(m))) continue;
      keep.add(o);
      grew = true;
      for (const x of o.needs) want.add(x);
    }
  }
  return all.filter((o) => keep.has(o));
}

// Big projects are too deep to search in one go, so plan toward the first missing ingredient.
export function plan(start: PState, type: string, ctx: Ctx, depth = 2): PlanStep[] | null {
  const full = search(start, type, ctx);
  if (full || !type.startsWith("make:") || depth <= 0) return full;
  const k = type.slice(5);
  const maker = ctx.beliefs.find((b) => (b.out[k] ?? 0) > 0);
  if (!maker) return null;
  for (const [need, c] of Object.entries(required(maker))) {
    if (n(start, need) >= c) continue;
    const sub = search(start, `have:${need}:${n(start, need) + 1}`, ctx) ?? plan(start, `make:${need}`, ctx, depth - 1);
    if (sub) return sub;
  }
  return null;
}

// ponytail: uniform-cost search over a small abstract state, pruned per goal; plan() covers what's too deep.
function search(start: PState, type: string, ctx: Ctx): PlanStep[] | null {
  const g = goal(type, start, ctx);
  if (!g) return null;
  if (g.done(start)) return [];
  const all = relevant(ops(ctx), g.needs);
  const key = (s: PState) => `${s.at}|${s.flags.join(",")}|${Object.entries(s.inv).filter(([, v]) => v).sort().join(",")}`;
  const open = [{ s: start, cost: 0, steps: [] as PlanStep[] }];
  const seen = new Set<string>([key(start)]);
  // ponytail: node cap keeps a think under a few ms; raise it if plans start coming back null for reachable goals.
  while (open.length && seen.size < 3000) {
    const cur = open.shift()!;
    if (cur.steps.length >= 14) continue;
    for (const o of all) {
      if (!o.pre(cur.s)) continue;
      const s = o.eff(cur.s);
      const steps = [...cur.steps, { op: o.op, arg: o.arg, key: o.key }];
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
