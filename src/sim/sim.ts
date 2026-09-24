import {
  DAY, FOOD, H, W, addThing, clock, dist, isNight, level, log, nearWater, walkable, Tile,
  type Agent, type Item, type Thing, type ThingKind, type World,
} from "./world";
import { EDIBLE, GATHER_OP, SOCIAL, SOCIAL_ITEM_NEEDS, foodCount, plan, type PState } from "./plan";
import { HOMES, RECIPE, RECIPES, signature, type Recipe } from "./recipes";
import { chooseTinker, decide, fadeBonds, inventoryText, newRel, reflect, respond, sample } from "./brain";

const VISION = 8;
const TOOLS: Item[] = ["axe", "bow_drill", "fishing_line", "pot", "wedge", "sharp_stone"];

// Things touched this tick, so the server can send deltas instead of the whole map.
export const dirty = { things: new Set<string>(), removed: new Set<string>() };
const touch = (t: Thing) => dirty.things.add(t.id);
function removeThing(w: World, t: Thing) {
  w.things = w.things.filter((x) => x !== t);
  dirty.removed.add(t.id);
}
const spawn = (...args: Parameters<typeof addThing>) => {
  const t = addThing(...args);
  touch(t);
  return t;
};

export const GOALS: Record<string, string> = {
  forage: "Gather berries or mushrooms to eat later",
  eat: "Eat something now",
  rest: "Rest or sleep to recover energy",
  warm_up: "Get warm by a fire or at home",
  explore: "Wander off and explore new land",
  tinker: "Tinker: try combining things to see what can be made",
  collect_stones: "Collect stones",
  collect_sticks: "Collect sticks",
  collect_reeds: "Collect reeds for fiber",
  collect_clay: "Dig up clay",
  talk: "Walk over and chat with someone",
  give: "Give someone food or materials as a gift",
  trade: "Offer someone a trade",
  share_meal: "Share food and eat together with someone",
  share_fire: "Invite someone to sit by a fire together",
  help: "Help someone with what they are doing",
  gossip: "Tell someone what you think of a third person",
  teach: "Teach someone how to make something you know",
  insult: "Insult or mock someone",
  take: "Take something from someone openly",
  steal: "Secretly steal something from someone",
  avoid: "Keep away from someone",
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export const goalText = (type: string) =>
  type.startsWith("make:") ? cap(RECIPE[type.slice(5)].label) : GOALS[type] ?? cap(type.replaceAll("_", " "));
const HOSTILE = ["insult", "take", "steal", "avoid"];
const NEED_FIX: Record<string, (type: string) => boolean> = {
  food: (t) => ["eat", "forage", "share_meal", "make:roast", "make:roast_fish", "make:stew", "make:fish"].includes(t),
  energy: (t) => t === "rest",
  warmth: (t) => ["warm_up", "share_fire", "make:make_fire", "make:lean_to", "make:log_hut", "make:cabin", "make:hearth"].includes(t),
};

const agent = (w: World, id?: string) => w.agents.find((a) => a.id === id);
const nearestThing = (w: World, a: Agent, ok: (t: Thing) => boolean) => {
  let best: Thing | null = null, bd = Infinity;
  for (const t of w.things) if (ok(t) && dist(a, t) < bd) (best = t), (bd = dist(a, t));
  return best;
};
export function homeOf(w: World, a: Agent): Thing | null {
  let best: Thing | null = null;
  for (const t of w.things) if (t.owner === a.id && HOMES[t.kind] && (!best || HOMES[t.kind]!.tier > HOMES[best.kind]!.tier)) best = t;
  return best;
}
const isFire = (t: Thing) => t.kind === "fire" || t.kind === "hearth";
const THING_PLACES: Record<string, (t: Thing) => boolean> = {
  bush: (t) => t.kind === "bush" && (t.n ?? 0) > 0,
  mushroom: (t) => t.kind === "mushroom",
  stick: (t) => t.kind === "stick",
  stone: (t) => t.kind === "stone",
  reeds: (t) => t.kind === "reeds",
  clay: (t) => t.kind === "clay",
  tree: (t) => t.kind === "tree",
  fire: isFire,
};
// Shore tiles never change, so find them once per world.
const shores = new WeakMap<World, { x: number; y: number }[]>();
function shore(w: World) {
  let s = shores.get(w);
  if (!s) {
    s = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (walkable(w, x, y) && nearWater(w, x, y, 1)) s.push({ x, y });
    shores.set(w, s);
  }
  return s;
}
// Nearest spot of a place kind: a thing, a shore tile, your home, or another agent.
function place(w: World, a: Agent, kind: string): { x: number; y: number; thing?: Thing } | null {
  if (kind === "home") { const h = homeOf(w, a); return h && { x: h.x, y: h.y, thing: h }; }
  if (kind === "agent") return agent(w, a.goal?.target) ?? null;
  if (kind === "water") {
    let best = null, bd = Infinity;
    for (const p of shore(w)) if (dist(a, p) < bd) (best = p), (bd = dist(a, p));
    return best;
  }
  const t = nearestThing(w, a, THING_PLACES[kind]);
  return t && { x: t.x, y: t.y, thing: t };
}
const PLACE_KINDS = [...Object.keys(THING_PLACES), "water", "home"];
const within = (w: World, a: Agent, kind: string, r = 1) => { const p = place(w, a, kind); return p && dist(a, p) <= r ? p : null; };

function gain(w: World, a: Agent, skill: string, n: number) {
  const before = level(a.skills[skill] ?? 0);
  a.skills[skill] = (a.skills[skill] ?? 0) + n;
  if (level(a.skills[skill]) > before) log(w, "level", [a.id], a, `${a.name} got better at ${skill} (level ${level(a.skills[skill])}).`);
}
const speed = (a: Agent, skill?: string) => 1 + (skill ? level(a.skills[skill] ?? 0) : 0) * 0.15;
const take = (a: Agent, i: Item, n = 1) => (a.inv[i] = Math.max(0, (a.inv[i] ?? 0) - n));
const put = (a: Agent, i: Item, n = 1) => (a.inv[i] = (a.inv[i] ?? 0) + n);
const bestFood = (a: Agent): Item | null => EDIBLE.find((i) => (a.inv[i] ?? 0) > 0) ?? null;
const nice = (i: string) => i.replaceAll("_", " ");
const plural = (i: string) => (i === "berry" ? "berries" : i.endsWith("s") || i === "fiber" || i === "clay" ? nice(i) : `${nice(i)}s`);

// ponytail: plain BFS per move on a 64x64 grid; switch to cached A* if agent counts get into the hundreds.
function stepToward(w: World, a: Agent, tx: number, ty: number, reach = 1): "arrived" | "moved" | "stuck" {
  if (Math.max(Math.abs(a.x - tx), Math.abs(a.y - ty)) <= reach) return "arrived";
  const prev = new Int32Array(W * H).fill(-1);
  const start = a.y * W + a.x;
  prev[start] = start;
  const q = [start];
  let found = -1;
  for (let i = 0; i < q.length && found < 0; i++) {
    const c = q[i], cx = c % W, cy = (c / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = cx + dx, ny = cy + dy, ni = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev[ni] >= 0 || !walkable(w, nx, ny)) continue;
      prev[ni] = c;
      if (Math.max(Math.abs(nx - tx), Math.abs(ny - ty)) <= reach) { found = ni; break; }
      q.push(ni);
    }
  }
  if (found < 0) return "stuck";
  let c = found;
  while (prev[c] !== start) c = prev[c];
  a.x = c % W;
  a.y = (c / W) | 0;
  return "moved";
}

function pstate(w: World, a: Agent): PState {
  return { inv: { ...a.inv }, at: within(w, a, "fire", 2) ? "fire" : within(w, a, "home") ? "home" : null, flags: [] };
}
function planGoal(w: World, a: Agent, type: string, target?: string) {
  if (type === "explore") {
    for (let i = 0; i < 40; i++) {
      const x = Math.round(a.x + (Math.random() - 0.5) * 50), y = Math.round(a.y + (Math.random() - 0.5) * 50);
      if (walkable(w, x, y) && dist(a, { x, y }) > 12) return [{ op: "wander", arg: `${x},${y}` }];
    }
    return null;
  }
  if (type === "avoid") return [{ op: "avoid", arg: target }];
  if (type === "tinker") return [{ op: "tinker" }];
  const d: Record<string, number> = {};
  for (const k of PLACE_KINDS) { const p = place(w, a, k); if (p) d[k] = dist(a, p); }
  const t = agent(w, target);
  if (t) d.agent = dist(a, t);
  const home = homeOf(w, a);
  return plan(pstate(w, a), type, { dist: d, known: Object.keys(a.know), homeTier: home ? HOMES[home.kind]!.tier : 0 });
}

function setGoal(w: World, a: Agent, type: string, odds: Record<string, number>, target?: string) {
  const steps = planGoal(w, a, type, target);
  const who = target ? ` (${agent(w, target)?.name})` : "";
  if (!steps) {
    log(w, "stuck", [a.id], a, `${a.name} wanted to ${goalText(type).toLowerCase()}${who} but couldn't work out how.`);
    a.cooldowns[type] = w.t + 60;
    a.nextDecide = w.t + 2;
    return;
  }
  a.goal = { type, target, since: w.t, odds, fails: 0 };
  a.plan = steps.map((s) => ({ ...s, progress: 0 }));
  log(w, "goal", [a.id, ...(target ? [target] : [])], a,
    `${a.name} decided to ${goalText(type).toLowerCase()}${who}. (${Math.round((odds[type] ?? 0) * 100)}% likely)`);
}

function endGoal(w: World, a: Agent, ok: boolean, why?: string) {
  if (!ok && a.goal) {
    log(w, "fail", [a.id], a, `${a.name} gave up trying to ${goalText(a.goal.type).toLowerCase()}${why ? `: ${why}` : ""}.`);
    a.cooldowns[a.goal.type] = w.t + 30;
  }
  a.goal = null;
  a.plan = [];
  a.nextDecide = w.t + 1;
}

function feasible(w: World, a: Agent) {
  const opts: Record<string, string> = {};
  const fire = place(w, a, "fire");
  const people = w.agents.filter((b) => b !== a && b.down <= w.t && dist(a, b) <= 25 && (a.rel[b.id] || dist(a, b) <= VISION));
  const holding = Object.values(a.inv).some((n) => n);
  const ok: Record<string, boolean> = {
    forage: true,
    eat: foodCount(a.inv) > 0 || a.needs.food < 70,
    rest: a.needs.energy < 75,
    warm_up: a.needs.warmth < 75 && !!planGoal(w, a, "warm_up"),
    explore: true,
    tinker: holding,
    collect_stones: (a.inv.stone ?? 0) < 6,
    collect_sticks: (a.inv.stick ?? 0) < 6,
    collect_reeds: (a.inv.fiber ?? 0) < 6 && !!place(w, a, "reeds"),
    collect_clay: (a.inv.clay ?? 0) < 6 && !!place(w, a, "clay"),
  };
  for (const [k, v] of Object.entries(ok)) if (v && !(a.cooldowns[k] > w.t)) opts[k] = GOALS[k];
  for (const id of Object.keys(a.know)) {
    const type = `make:${id}`;
    if (a.cooldowns[type] > w.t) continue;
    if (id === "make_fire" && fire && dist(a, fire) <= 8) continue;
    const out = RECIPE[id].makes.item;
    if (out && (a.inv[out] ?? 0) >= (TOOLS.includes(out) ? 1 : 4)) continue; // enough of that already
    if (planGoal(w, a, type)) opts[type] = goalText(type);
  }
  const targets: Record<string, string[]> = {};
  for (const kind of [...SOCIAL, "avoid"]) {
    if (a.cooldowns[kind] > w.t) continue;
    const valid = people.filter((b) => {
      if (kind === "trade") return Object.values(b.inv).some((n) => n) && holding;
      if (kind === "give" || kind === "share_meal") return !!planGoal(w, a, kind, b.id);
      if (kind === "take" || kind === "steal") return Object.values(b.inv).some((n) => n);
      if (kind === "share_fire") return !!fire && dist(a, fire) <= 12;
      if (kind === "help") return !!b.goal && !SOCIAL.includes(b.goal.type) && !["explore", "help", "avoid"].includes(b.goal.type);
      if (kind === "gossip") return w.agents.some((c) => c !== a && c !== b && a.rel[c.id]);
      if (kind === "teach") return Object.keys(a.know).some((id) => !b.know[id]);
      return true;
    });
    if (!valid.length) continue;
    opts[kind] = GOALS[kind];
    targets[kind] = valid.map((b) => b.id);
  }
  return { opts, targets, people: people.map((b) => b.id) };
}

async function think(w: World, a: Agent) {
  a.thinking = true;
  a.status = "Thinking";
  try {
    const { opts, targets, people } = feasible(w, a);
    const res = await decide(w, a, opts, people, people);
    const type = sample(res.goal);
    let target: string | undefined;
    if (targets[type]) {
      const pool = (HOSTILE.includes(type) ? res.against : res.towards) ?? {};
      target = sample(Object.fromEntries(targets[type].map((id) => [id, pool[id] ?? 0.01])));
    }
    a.lastDecision = { t: w.t, goal: res.goal, who: target ? (HOSTILE.includes(type) ? res.against : res.towards) : undefined, chosen: type, target };
    a.thinking = false;
    if (a.down > w.t || a.engaged || a.goal) return;
    setGoal(w, a, type, res.goal, target);
  } catch (e) {
    console.error(`decide ${a.name}:`, e);
    a.thinking = false;
    a.status = "Lost in thought";
    a.nextDecide = w.t + 10;
  }
}

// ---------- knowledge ----------
function learn(w: World, a: Agent, r: Recipe, how: "discovered" | "watched" | "taught", from?: Agent) {
  if (a.know[r.id]) return;
  a.know[r.id] = { how, t: w.t, from: from?.id };
  delete a.clues[r.id];
  gain(w, a, r.craft, 3);
  if (how === "discovered") {
    if (!w.inventions[r.id]) {
      w.inventions[r.id] = { by: a.id, t: w.t };
      log(w, "invent", [a.id], a, `${a.name} invented a way to ${r.label}. No one had ever done it before.`);
    } else log(w, "discover", [a.id], a, `${a.name} worked out how to ${r.label} on their own.`);
  } else if (how === "watched" && from) {
    log(w, "learn", [a.id, from.id], a, `${a.name} learned how to ${r.label} by watching ${from.name}.`);
  }
}

// Someone doing a craft in plain sight teaches anyone watching, a little at a time.
function watch(w: World, doer: Agent, r: Recipe) {
  for (const b of w.agents) {
    if (b === doer || b.know[r.id] || b.down > w.t || dist(doer, b) > 6) continue;
    const k = 1 + (b.traits.observant ?? 0) + (b.traits.clever ?? 0) + (b.traits.curious ?? 0) * 0.5;
    b.clues[r.id] = (b.clues[r.id] ?? 0) + 0.08 * k;
    if (b.clues[r.id] >= 2) learn(w, b, r, "watched", doer);
  }
}

type Combo = { items: Item[]; place: string | null; key: string };
function tinkerOptions(w: World, a: Agent): Combo[] {
  const items = (Object.entries(a.inv) as [Item, number][]).filter(([i, n]) => n && i !== "meal" && i !== "stew").map(([i]) => i);
  const places = [null, ...["tree", "water", "fire", "home"].filter((k) => within(w, a, k, k === "fire" ? 2 : 1))];
  const subsets: Item[][] = [];
  for (let i = 0; i < items.length; i++) {
    subsets.push([items[i]]);
    for (let j = i + 1; j < items.length; j++) {
      subsets.push([items[i], items[j]]);
      for (let k = j + 1; k < items.length; k++) subsets.push([items[i], items[j], items[k]]);
    }
  }
  const combos: Combo[] = [];
  for (const s of subsets)
    for (const p of places) {
      const words = s.map((i) => (s.length === 1 && (a.inv[i] ?? 0) > 1 ? `two ${plural(i)} together` : nice(i)));
      const key = `${words.join(" + ")}${p ? `, at the ${p}` : ""}`;
      // Stop offering what already failed twice with no hint of anything.
      if ((a.tried[key] ?? 0) < 2) combos.push({ items: [...s].sort(), place: p, key });
    }
  // ponytail: random cap to stay under Jev's 255 options and keep the prompt small.
  return combos.sort(() => Math.random() - 0.5).slice(0, 120);
}
const trait = (a: Agent, t: string) => a.traits[t] ?? 0;
function attempt(w: World, a: Agent, c: Combo) {
  const sig = c.items.join("+"), tried = c.key;
  // A recipe tied to this exact place wins over one that works anywhere.
  const hit = RECIPES.filter((r) => signature(r) === sig && (!r.near || r.near === c.place)).sort((x, y) => +(y.near === c.place) - +(x.near === c.place))[0];
  if (hit) {
    const short = Object.entries(hit.inputs).find(([i, k]) => (a.inv[i as Item] ?? 0) < k!);
    if (short && !a.know[hit.id]) {
      a.clues[hit.id] = Math.min(3, (a.clues[hit.id] ?? 0) + 1);
      return log(w, "hint", [a.id], a, `${a.name} tried ${tried}. It felt close, but they needed more ${nice(short[0])}.`);
    }
    if (a.know[hit.id]) return perform(w, a, hit) === true ? undefined : log(w, "tinker", [a.id], a, `${a.name} tried ${tried} again, but it didn't come together.`);
    const p = Math.max(0.05, Math.min(0.9, 0.3 + (a.clues[hit.id] ?? 0) * 0.22 + trait(a, "clever") * 0.2 + trait(a, "curious") * 0.12
      + trait(a, "creative") * 0.1 + level(a.skills[hit.craft] ?? 0) * 0.04 - hit.difficulty * 0.25));
    if (Math.random() < p) {
      learn(w, a, hit, "discovered");
      perform(w, a, hit);
      return;
    }
    a.clues[hit.id] = Math.min(3, (a.clues[hit.id] ?? 0) + 1);
    return log(w, "tinker", [a.id], a, `${a.name} tried ${tried}. Nothing yet, but it seemed promising.`);
  }
  // Partly right: these items are part of something they haven't worked out.
  const partial = RECIPES.filter((r) => !a.know[r.id] && c.items.every((i) => signature(r).split("+").includes(i)) && (!r.near || !c.place || r.near === c.place)).slice(0, 3);
  for (const r of partial) a.clues[r.id] = Math.min(3, (a.clues[r.id] ?? 0) + 0.35);
  if (!partial.length) a.tried[c.key] = (a.tried[c.key] ?? 0) + 1;
  log(w, "tinker", [a.id], a, `${a.name} tried ${tried}. ${partial.length ? "Nothing came of it, but it gave them an idea." : "Nothing came of it."}`);
}

// Actually make a recipe's output. Returns true, or why it couldn't.
function perform(w: World, a: Agent, r: Recipe): true | string {
  for (const [i, k] of Object.entries(r.inputs)) if ((a.inv[i as Item] ?? 0) < k!) return `missing ${nice(i)}`;
  for (const t of r.tools ?? []) if (!a.inv[t]) return `no ${nice(t)}`;
  const at = r.near && within(w, a, r.near, r.near === "fire" ? 2 : 1);
  if (r.near && !at) return `not at the ${r.near}`;
  const home = r.makes.thing && HOMES[r.makes.thing];
  if (home) { const cur = homeOf(w, a); if (cur && HOMES[cur.kind]!.tier >= home.tier) return "already has a better home"; }
  for (const [i, k] of Object.entries(r.inputs)) take(a, i as Item, k!);
  gain(w, a, r.craft, 5);
  if (r.fells && at && "thing" in at && at.thing) {
    at.thing.kind = "stump";
    at.thing.until = w.t + DAY * 4;
    touch(at.thing);
  }
  if (r.makes.item) {
    const n = (r.makes.n ?? 1) + (r.makes.n && level(a.skills[r.craft] ?? 0) >= 4 ? 1 : 0);
    put(a, r.makes.item, n);
    log(w, "craft", [a.id], a, `${a.name} made ${n > 1 ? `${n} ${nice(r.makes.item)}s` : `a ${nice(r.makes.item)}`}.`);
  } else if (r.makes.thing) {
    const kind = r.makes.thing as ThingKind;
    if (kind === "fire") {
      spawn(w, "fire", a.x, a.y, { owner: a.id, until: w.t + Math.round(DAY * 0.5 * speed(a, "firemaking")) });
      log(w, "fire", [a.id], a, `${a.name} started a fire.`);
    } else {
      spawn(w, kind, a.x, a.y, { owner: a.id });
      if (home) a.home = { x: a.x, y: a.y };
      log(w, "build", [a.id], a, `${a.name} built ${r.label.replace(/^build /, "")}${home ? " and made it home" : ""}.`);
    }
  }
  return true;
}

// ---------- running plan steps ----------
const GATHER_STATUS: Record<string, string> = {
  pick_berries: "Picking berries", pick_mushroom: "Gathering a mushroom", pick_stick: "Picking up a stick",
  pick_stone: "Picking up a stone", pick_reeds: "Cutting reeds", dig_clay: "Digging clay",
};
const PLACE_NAME: Record<string, string> = {
  bush: "a berry bush", mushroom: "a mushroom", stick: "a stick", stone: "a stone", reeds: "the reeds", clay: "the clay bank",
  tree: "a tree", fire: "the fire", home: "home", water: "the water",
};
const tinkering = new Set<string>(); // agents waiting on Jev to pick what to try

function run(w: World, a: Agent): boolean | string {
  const s = a.plan[0];
  switch (s.op) {
    case "goto": {
      const p = place(w, a, s.arg!);
      if (!p) return `couldn't find ${PLACE_NAME[s.arg!] ?? s.arg}`;
      if (s.arg === "agent") {
        const b = p as Agent;
        if (b.down > w.t) return `${b.name} was unconscious`;
        if (dist(a, b) > 30) return `${b.name} was too far away`;
        a.status = `Walking over to ${b.name}`;
      } else a.status = `Walking to ${PLACE_NAME[s.arg!]}`;
      const r = stepToward(w, a, p.x, p.y, s.arg === "fire" ? 2 : 1);
      return r === "stuck" ? "no path" : r === "arrived";
    }
    case "wander": {
      const [x, y] = s.arg!.split(",").map(Number);
      a.status = "Exploring";
      const r = stepToward(w, a, x, y, 0);
      return r === "stuck" ? "no path" : r === "arrived";
    }
    case "avoid": {
      const b = agent(w, s.arg);
      if (!b || dist(a, b) >= 14 || s.progress++ > 40) return true;
      a.status = `Keeping away from ${b.name}`;
      stepToward(w, a, Math.max(0, Math.min(W - 1, a.x + Math.sign(a.x - b.x) * 3)), Math.max(0, Math.min(H - 1, a.y + Math.sign(a.y - b.y) * 3)), 0);
      return false;
    }
    case "rest": {
      const home = within(w, a, "home")?.thing;
      const kind = home ? nice(home.kind) : null;
      a.status = isNight(w.t) ? (kind ? `Sleeping in the ${kind}` : "Sleeping on the ground") : kind ? `Resting in the ${kind}` : "Resting";
      a.needs.energy = Math.min(100, a.needs.energy + 0.7 * (home ? 1 + HOMES[home.kind]!.rest : 1));
      return a.needs.energy >= (isNight(w.t) ? 98 : 85);
    }
    case "warm_up": {
      a.status = "Warming up";
      if (!within(w, a, "fire", 2) && !within(w, a, "home")) return "the warmth was gone";
      a.needs.warmth = Math.min(100, a.needs.warmth + 1.2);
      return a.needs.warmth >= 95;
    }
    case "eat": {
      const f = bestFood(a);
      if (!f) return "nothing to eat";
      take(a, f);
      a.needs.food = Math.min(100, a.needs.food + FOOD[f]!);
      log(w, "eat", [a.id], a, `${a.name} ate a ${nice(f)}.`);
      return true;
    }
    case "assist": {
      const b = agent(w, s.arg);
      if (!b || !b.goal || s.progress++ > 30) return true;
      a.status = `Helping ${b.name}`;
      const theirs = b.plan[0];
      if (stepToward(w, a, b.x, b.y) === "arrived" && theirs && (theirs.op === "craft" || GATHER_OP[theirs.op])) theirs.progress += 1;
      return false;
    }
    case "tinker": {
      if (s.arg) {
        a.status = `Trying ${s.arg.split("|")[0]}`;
        if ((s.progress += speed(a, "tinkering")) < 8) return false;
        const [key, items, where] = s.arg.split("|");
        attempt(w, a, { key, items: items.split("+") as Item[], place: where || null });
        gain(w, a, "tinkering", 2);
        return true;
      }
      if (tinkering.has(a.id)) return false;
      const options = tinkerOptions(w, a);
      if (!options.length) return "had nothing to tinker with";
      tinkering.add(a.id);
      a.status = "Turning things over in their hands";
      chooseTinker(w, a, options.map((o) => o.key))
        .then((key) => { const c = options.find((o) => o.key === key)!; s.arg = `${c.key}|${c.items.join("+")}|${c.place ?? ""}`; })
        .catch((e) => { console.error(`tinker ${a.name}:`, e); a.plan = []; })
        .finally(() => tinkering.delete(a.id));
      return false;
    }
    case "social": {
      const b = agent(w, a.goal?.target);
      if (!b) return "they weren't around";
      if (s.progress === 0) {
        if (b.engaged || b.down > w.t) return false; // wait for them to be free
        if (dist(a, b) > 1) { a.plan.unshift({ op: "goto", arg: "agent", progress: 0 }); return false; }
        s.progress = 1;
        a.engaged = b.id;
        b.engaged = a.id;
        a.status = `With ${b.name}`;
        b.status = `With ${a.name}`;
        interact(w, a, b, s.arg!).catch((e) => console.error(`interact ${a.name}->${b.name}:`, e))
          .finally(() => { a.engaged = null; b.engaged = null; s.progress = 2; });
        return false;
      }
      return s.progress === 2;
    }
    case "craft": {
      const r = RECIPE[s.arg!];
      a.status = `Working: ${r.label}`;
      watch(w, a, r);
      if ((s.progress += speed(a, r.craft)) < r.time) return false;
      return perform(w, a, r);
    }
  }
  const g = GATHER_OP[s.op];
  if (!g) return true;
  a.status = GATHER_STATUS[s.op];
  if ((s.progress += speed(a, "foraging")) < 2.5) return false;
  const t = within(w, a, g.place)?.thing;
  if (!t) return `${PLACE_NAME[g.place]} was gone`;
  let n = g.n;
  if (t.kind === "bush") {
    n = Math.min(t.n!, 2 + Math.floor(level(a.skills.foraging ?? 0) / 4));
    t.n! -= n;
    touch(t);
  } else removeThing(w, t);
  put(a, g.item, n);
  if (t.kind === "bush" || t.kind === "mushroom") gain(w, a, "foraging", 2);
  log(w, "gather", [a.id], a, `${a.name} gathered ${n > 1 ? `${n} ${plural(g.item)}` : g.item === "fiber" || g.item === "clay" ? `some ${g.item}` : `a ${nice(g.item)}`}.`);
  return true;
}

const pickGift = (a: Agent): Item | null =>
  bestFood(a) ?? (["stick", "stone", "fiber", "clay", "log", "cord", "plank"] as Item[]).find((i) => (a.inv[i] ?? 0) > 0) ?? null;
const most = (a: Agent, except?: Item): Item | null =>
  (Object.entries(a.inv) as [Item, number][]).filter(([i, n]) => n && i !== except && !TOOLS.includes(i)).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;

async function interact(w: World, a: Agent, b: Agent, kind: string) {
  const ra = (a.rel[b.id] ??= newRel(w.t));
  (b.rel[a.id] ??= newRel(w.t));
  const first = ra.history.length === 0 && b.rel[a.id].history.length === 0;
  let text = "";
  const witnesses = [a, b];
  const reply = (situation: string, opts: Record<string, string>) => respond(w, b, a, situation, opts);
  switch (kind) {
    case "talk": {
      const r = await reply(`${a.name} walks up to ${b.name} to talk.`, { welcome: "Chat warmly", brush_off: "Brush them off" });
      if (r === "welcome") {
        a.needs.social = Math.min(100, a.needs.social + 20);
        b.needs.social = Math.min(100, b.needs.social + 20);
        gain(w, a, "charm", 3);
        const story = a.memory.filter((m) => !m.includes(b.name)).at(-1 - Math.floor(Math.random() * 3));
        if (story) gain(w, a, "storytelling", 2);
        text = `${a.name} and ${b.name}${first ? " met for the first time and" : ""} talked for a while.${story ? ` ${a.name} told ${b.name} about this: "${story.replace(/^Day \d+, \w+: /, "")}"` : ""}`;
      } else text = `${a.name} tried to talk to ${b.name}, but ${b.name} brushed them off.`;
      break;
    }
    case "give": {
      const item = pickGift(a);
      if (!item) return;
      const n = Math.min(a.inv[item]!, item === "berry" ? 2 : 1);
      const r = await reply(`${a.name} offers ${b.name} ${n} ${nice(item)} as a gift.`, { accept: "Accept the gift", refuse: "Refuse it" });
      if (r === "accept") {
        take(a, item, n); put(b, item, n);
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} gave ${b.name} ${n} ${nice(item)}.${b.needs.food < 25 && FOOD[item] ? ` ${b.name} was starving.` : ""}`;
      } else text = `${b.name} refused ${a.name}'s gift of ${nice(item)}.`;
      break;
    }
    case "trade": {
      const give = most(a), want = most(b, give ?? undefined);
      if (!give || !want) return;
      gain(w, a, "bargaining", 2);
      const r = await reply(`${a.name} offers ${b.name} 1 ${nice(give)} in exchange for 1 ${nice(want)}.`, { accept: "Make the trade", refuse: "Turn it down" });
      if (r === "accept") {
        take(a, give); put(b, give); take(b, want); put(a, want);
        gain(w, a, "bargaining", 3);
        text = `${a.name} traded 1 ${nice(give)} to ${b.name} for 1 ${nice(want)}.`;
      } else text = `${b.name} turned down ${a.name}'s offer to trade ${nice(give)} for ${nice(want)}.`;
      break;
    }
    case "share_meal": {
      const f = bestFood(a);
      if (!f) return;
      const r = await reply(`${a.name} invites ${b.name} to share some food and eat together.`, { join: "Eat together", decline: "Decline" });
      if (r === "join") {
        take(a, f);
        b.needs.food = Math.min(100, b.needs.food + FOOD[f]!);
        const g = bestFood(a);
        if (g) { take(a, g); a.needs.food = Math.min(100, a.needs.food + FOOD[g]!); }
        a.needs.social = Math.min(100, a.needs.social + 25);
        b.needs.social = Math.min(100, b.needs.social + 25);
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} shared a ${nice(f)} with ${b.name} and they ate together.`;
      } else text = `${b.name} declined ${a.name}'s offer to eat together.`;
      break;
    }
    case "share_fire": {
      if (!place(w, a, "fire")) return;
      const r = await reply(`${a.name} invites ${b.name} to come sit by the fire together.`, { join: "Go sit by the fire", decline: "Decline" });
      if (r === "join") {
        for (const x of [a, b]) {
          x.goal = { type: "warm_up", since: w.t, odds: {}, fails: 0 };
          x.plan = [{ op: "goto", arg: "fire", progress: 0 }, { op: "warm_up", progress: 0 }];
          x.needs.social = Math.min(100, x.needs.social + 15);
        }
        text = `${a.name} and ${b.name} sat by the fire together.`;
      } else text = `${b.name} declined ${a.name}'s invitation to sit by the fire.`;
      break;
    }
    case "help": {
      const what = b.goal ? goalText(b.goal.type).toLowerCase() : "their work";
      const r = await reply(`${a.name} offers to help ${b.name} ${what}.`, { accept: "Accept the help", decline: "Say no thanks" });
      if (r === "accept") {
        a.goal = { type: "help", target: b.id, since: w.t, odds: a.goal?.odds ?? {}, fails: 0 };
        a.plan = [{ op: "assist", arg: b.id, progress: 0 }];
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} started helping ${b.name} ${what}.`;
      } else text = `${b.name} turned down ${a.name}'s offer to help.`;
      break;
    }
    case "teach": {
      const options = Object.keys(a.know).filter((id) => !b.know[id]);
      if (!options.length) return;
      const r = RECIPE[options[Math.floor(Math.random() * options.length)]];
      const ans = await reply(`${a.name} offers to show ${b.name} how to ${r.label}.`, { accept: "Learn from them", refuse: "Not interested" });
      if (ans === "accept") {
        b.know[r.id] = { how: "taught", t: w.t, from: a.id };
        delete b.clues[r.id];
        gain(w, b, r.craft, 3);
        gain(w, a, "teaching", 4);
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} taught ${b.name} how to ${r.label}.`;
      } else text = `${b.name} wasn't interested when ${a.name} offered to show them how to ${r.label}.`;
      break;
    }
    case "gossip": {
      const others = w.agents.filter((c) => c !== a && c !== b && a.rel[c.id]);
      const c = others.sort((x, y) => Math.abs(a.rel[y.id].affinity) - Math.abs(a.rel[x.id].affinity))[0];
      if (!c) return;
      const rc = a.rel[c.id];
      const said = Object.entries(rc.beliefs).filter(([, v]) => v! > 0.65 || v! < 0.35).map(([k, v]) => (v! > 0.65 ? k : `not ${k}`));
      const opinion = `${a.name} says they ${rc.affinity > 0.2 ? "like" : rc.affinity < -0.2 ? "dislike" : "don't know what to make of"} ${c.name}${said.length ? `, and that ${c.name} is ${said.join(", ")}` : ""}.`;
      const lie = a.traits.deceitful && rc.affinity < 0 && Math.random() < a.traits.deceitful;
      const told = lie ? `${a.name} says ${c.name} is dishonest and dangerous.` : opinion;
      if (lie) gain(w, a, "deception", 3);
      const r = await reply(`${a.name} tells ${b.name} about ${c.name}: "${told}"`, { believe: "Believe it", doubt: "Doubt it" });
      if (r === "believe") {
        const rb = (b.rel[c.id] ??= newRel(w.t));
        const weight = 0.5 * b.rel[a.id].trust;
        const src = lie ? { ...rc.beliefs, honest: 0.1, dangerous: 0.9 } : rc.beliefs;
        for (const [k, v] of Object.entries(src)) rb.beliefs[k as keyof typeof rb.beliefs] = (rb.beliefs[k as keyof typeof rb.beliefs] ?? 0.5) * (1 - weight) + v! * weight;
        rb.affinity += (lie ? -0.3 : rc.affinity) * weight * 0.5;
        rb.history = [...rb.history, `${clock(w.t)}: Heard from ${a.name}: ${told}`].slice(-10);
      }
      text = `${a.name} told ${b.name} what they think of ${c.name}: "${told}" ${b.name} ${r === "believe" ? "believed it" : "doubted it"}.`;
      if (lie) log(w, "lie", [a.id], a, `${a.name} lied to ${b.name} about ${c.name}.`);
      break;
    }
    case "insult": {
      const r = await reply(`${a.name} insults and mocks ${b.name}.`, { shrug: "Shrug it off", insult_back: "Insult them back", walk_away: "Walk away hurt" });
      b.needs.social = Math.max(0, b.needs.social - 10);
      text = `${a.name} insulted ${b.name}. ${b.name} ${r === "shrug" ? "shrugged it off" : r === "insult_back" ? "insulted them right back" : "walked away hurt"}.`;
      break;
    }
    case "take": case "steal": {
      const item = most(b) ?? (Object.entries(b.inv) as [Item, number][]).find(([, n]) => n)?.[0];
      if (!item) return;
      const hidden = kind === "steal";
      const noticed = !hidden || Math.random() < 0.35 + trait(b, "observant") * 0.4 + trait(b, "suspicious") * 0.2 - level(a.skills.pickpocketing ?? 0) * 0.05;
      take(b, item); put(a, item);
      if (hidden) gain(w, a, "pickpocketing", 4);
      if (!noticed) {
        log(w, "steal", [a.id], a, `${a.name} secretly stole a ${nice(item)} from ${b.name}. ${b.name} didn't notice.`);
        return;
      }
      const r = await reply(
        hidden ? `${b.name} catches ${a.name} stealing a ${nice(item)} from them.` : `${a.name} grabs a ${nice(item)} from ${b.name} and keeps it.`,
        { let_it_go: "Let it go", confront: "Confront them and demand it back" },
      );
      const back = r === "confront" && Math.random() < 0.6;
      if (back) { take(a, item); put(b, item); }
      text = `${a.name} ${hidden ? "was caught stealing" : "took"} a ${nice(item)} from ${b.name}. ${b.name} ${r === "let_it_go" ? "let it go" : back ? "confronted them and got it back" : "confronted them, but didn't get it back"}.`;
      break;
    }
    default:
      return;
  }
  log(w, kind, witnesses.map((x) => x.id), a, text);
  await Promise.all(witnesses.map((x) => {
    const other = x === a ? b : a;
    return reflect(w, x, other, text).then((r) => {
      if (r.bond !== "none") log(w, "bond", [x.id], x, `${x.name} will remember this about ${other.name}: ${r.bond.replaceAll("_", " ")}. They now see ${other.name} as ${/^[aeiou]/.test(x.rel[other.id].label) ? "an" : "a"} ${x.rel[other.id].label}.`);
    });
  }));
}

function regrow(w: World) {
  for (const t of [...w.things]) {
    if (t.kind === "fire" && t.until! <= w.t) { removeThing(w, t); log(w, "fire_out", [], t, "A campfire burned out."); }
    else if (t.kind === "stump" && t.until! <= w.t) { t.kind = "tree"; delete t.until; touch(t); }
    else if (t.kind === "bush" && (t.n ?? 0) < 4 && Math.random() < 1 / 80) { t.n = (t.n ?? 0) + 1; touch(t); }
  }
  if (Math.random() < 1 / 20) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H);
    if (!walkable(w, x, y) || w.things.some((t) => t.x === x && t.y === y)) return;
    const forest = w.tiles[y * W + x] === Tile.Forest, shoreSpot = nearWater(w, x, y, 1);
    const kind: ThingKind = shoreSpot ? (Math.random() < 0.7 ? "reeds" : "clay") : forest ? (Math.random() < 0.5 ? "mushroom" : "stick") : Math.random() < 0.5 ? "stick" : "stone";
    spawn(w, kind, x, y);
  }
}

export function tick(w: World) {
  w.t++;
  const night = isNight(w.t);
  regrow(w);
  if (w.t % DAY === 0) for (const a of w.agents) fadeBonds(a);

  for (const a of w.agents) {
    const n = a.needs;
    const home = homeOf(w, a);
    const atHome = home && dist(a, home) <= 1;
    const byFire = w.things.some((t) => isFire(t) && dist(a, t) <= 3);
    n.food = Math.max(0, n.food - 0.18);
    n.energy = Math.max(0, n.energy - (night ? 0.16 : 0.1));
    n.social = Math.max(0, n.social - 0.05);
    // Sun by day; at night only fire, a home, or huddling close to someone keeps the cold off.
    const huddle = night ? Math.min(2, w.agents.filter((b) => b !== a && dist(a, b) <= 1).length) * 0.3 : 0;
    const heat = (byFire ? 0.8 : 0) + (atHome ? 0.8 * HOMES[home.kind]!.warmth : 0) + huddle;
    n.warmth = Math.max(0, Math.min(100, n.warmth + (heat || (night ? -0.22 : 0.12))));
    if (n.food <= 0 || n.warmth <= 0) n.health -= 0.4;
    else if (n.food > 40 && n.warmth > 40) n.health = Math.min(100, n.health + 0.1);
    if (a.down > w.t) { a.status = "Unconscious"; continue; }
    if (n.health <= 0) {
      const cause = n.food <= 0 ? "hunger" : "cold";
      n.health = 25; n.food = Math.max(n.food, 15); n.warmth = Math.max(n.warmth, 20);
      a.down = w.t + 60;
      a.goal = null; a.plan = [];
      log(w, "collapse", [a.id], a, `${a.name} collapsed from ${cause}.`);
      continue;
    }

    for (const b of w.agents) {
      if (b === a || dist(a, b) > VISION) continue;
      if (!a.seen[b.id] || w.t - a.seen[b.id] > 150) {
        if (!a.rel[b.id]) log(w, "notice", [a.id], a, `${a.name} spotted a stranger: ${b.name}.`);
        a.nextDecide = Math.min(a.nextDecide, w.t);
        if (a.goal && w.t - a.goal.since > 5 && !a.engaged && !tinkering.has(a.id)) { a.goal = null; a.plan = []; }
      }
      a.seen[b.id] = w.t;
    }

    if (a.thinking || a.engaged) continue;
    const critical = (["food", "energy", "warmth"] as const).find((k) => n[k] < 20);
    if (a.goal && critical && !NEED_FIX[critical](a.goal.type) && !(a.cooldowns.interrupt > w.t)) {
      a.cooldowns.interrupt = w.t + 40;
      a.goal = null; a.plan = [];
    }
    if (a.goal && w.t - a.goal.since > (a.goal.type.startsWith("make:") ? DAY * 2 : DAY / 2)) endGoal(w, a, false, "took too long");
    if (!a.goal) {
      if (w.t >= a.nextDecide) void think(w, a);
      else a.status = "Idle";
      continue;
    }
    if (!a.plan.length) { endGoal(w, a, true); continue; }
    const step = a.plan[0];
    const r = run(w, a);
    if (r === true) {
      a.plan.shift();
      const made = step.op === "craft" && a.goal.type === `make:${step.arg}`;
      if (made) { endGoal(w, a, true); continue; }
      if (!a.plan.length) {
        // Big projects are planned one ingredient at a time; keep going until the thing is made.
        if (a.goal.type.startsWith("make:") && (a.goal.stages ?? 0) < 20) {
          const next = planGoal(w, a, a.goal.type, a.goal.target);
          if (next?.length) { a.plan = next.map((x) => ({ ...x, progress: 0 })); a.goal.stages = (a.goal.stages ?? 0) + 1; continue; }
        }
        endGoal(w, a, true);
      }
    } else if (typeof r === "string") {
      a.goal.fails++;
      if (a.goal.fails > 2) { endGoal(w, a, false, r); continue; }
      const steps = planGoal(w, a, a.goal.type, a.goal.target);
      if (!steps) endGoal(w, a, false, r);
      else a.plan = steps.map((x) => ({ ...x, progress: 0 }));
    }
  }
}

export { inventoryText };
