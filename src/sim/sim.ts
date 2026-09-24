import {
  DAY, FOOD, H, W, addThing, clock, dist, isNight, level, log, walkable,
  type Agent, type Item, type Skill, type Thing, type World,
} from "./world";
import { SOCIAL, SOCIAL_ITEM_NEEDS, foodCount, plan, type PState } from "./plan";
import { decide, fadeBonds, inventoryText, newRel, reflect, respond, sample } from "./brain";

const VISION = 8;

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
  gather_wood: "Chop trees for wood",
  craft_tool: "Make a stone axe",
  build_shelter: "Build a shelter to call home",
  start_fire: "Light a campfire, or go sit at one",
  cook_meal: "Cook a hot meal at a fire",
  rest: "Rest or sleep to recover energy",
  warm_up: "Get warm by a fire or in a shelter",
  explore: "Wander off and explore new land",
  talk: "Walk over and chat with someone",
  give: "Give someone food or materials as a gift",
  trade: "Offer someone a trade",
  share_meal: "Share food and eat together with someone",
  share_fire: "Invite someone to sit by a fire together",
  help: "Help someone with what they are doing",
  gossip: "Tell someone what you think of a third person",
  insult: "Insult or mock someone",
  take: "Take something from someone openly",
  steal: "Secretly steal something from someone",
  avoid: "Keep away from someone",
};
const HOSTILE = ["insult", "take", "steal", "avoid"];
const NEEDS_GOAL: Record<string, string[]> = {
  food: ["eat", "forage", "cook_meal", "share_meal"],
  energy: ["rest"],
  warmth: ["warm_up", "start_fire", "share_fire", "build_shelter"],
};

const nearest = (w: World, a: Agent, ok: (t: Thing) => boolean) => {
  let best: Thing | null = null, bd = Infinity;
  for (const t of w.things) if (ok(t) && dist(a, t) < bd) (best = t), (bd = dist(a, t));
  return best;
};
const agent = (w: World, id?: string) => w.agents.find((a) => a.id === id);
const PLACES: Record<string, (t: Thing, a: Agent) => boolean> = {
  bush: (t) => t.kind === "bush" && (t.n ?? 0) > 0,
  mushroom: (t) => t.kind === "mushroom",
  stick: (t) => t.kind === "stick",
  stone: (t) => t.kind === "stone",
  tree: (t) => t.kind === "tree",
  fire: (t) => t.kind === "fire",
  home: (t, a) => t.kind === "shelter" && t.owner === a.id,
};

function xp(a: Agent, s: Skill, n: number) {
  const before = level(a.skills[s]);
  a.skills[s] += n;
  return level(a.skills[s]) > before;
}
function gain(w: World, a: Agent, s: Skill, n: number) {
  if (xp(a, s, n)) log(w, "level", [a.id], a, `${a.name} got better at ${s} (level ${level(a.skills[s])}).`);
}
const speed = (a: Agent, s: Skill) => 1 + level(a.skills[s]) * 0.15;
const take = (a: Agent, i: Item, n = 1) => (a.inv[i] = Math.max(0, (a.inv[i] ?? 0) - n));
const put = (a: Agent, i: Item, n = 1) => (a.inv[i] = (a.inv[i] ?? 0) + n);
const bestFood = (a: Agent): Item | null => (["meal", "berry", "mushroom"] as Item[]).find((i) => (a.inv[i] ?? 0) > 0) ?? null;

// ponytail: plain BFS per move on a 64x64 grid; switch to cached A* if agent counts get into the hundreds.
function stepToward(w: World, a: Agent, tx: number, ty: number, within = 1): "arrived" | "moved" | "stuck" {
  if (Math.max(Math.abs(a.x - tx), Math.abs(a.y - ty)) <= within) return "arrived";
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
      if (Math.max(Math.abs(nx - tx), Math.abs(ny - ty)) <= within) { found = ni; break; }
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
  const near = (k: string) => { const t = nearest(w, a, (t) => PLACES[k](t, a)); return t && dist(a, t) <= 1; };
  return { inv: { ...a.inv }, at: near("fire") ? "fire" : near("home") ? "home" : null, flags: [] };
}
function planFor(w: World, a: Agent) {
  const g = a.goal!;
  if (g.type === "explore") {
    for (let i = 0; i < 40; i++) {
      const x = Math.round(a.x + (Math.random() - 0.5) * 50), y = Math.round(a.y + (Math.random() - 0.5) * 50);
      if (walkable(w, x, y) && dist(a, { x, y }) > 12) return [{ op: "wander", arg: `${x},${y}` }];
    }
    return null;
  }
  if (g.type === "avoid") return [{ op: "avoid", arg: g.target }];
  const d: Record<string, number> = {};
  for (const k of Object.keys(PLACES)) {
    const t = nearest(w, a, (t) => PLACES[k](t, a));
    if (t) d[k] = dist(a, t);
  }
  const target = agent(w, g.target);
  if (target) d.agent = dist(a, target);
  return plan(pstate(w, a), g.type, { dist: d, hasHome: !!a.home });
}

function setGoal(w: World, a: Agent, type: string, odds: Record<string, number>, target?: string) {
  a.goal = { type, target, since: w.t, odds, fails: 0 };
  const steps = planFor(w, a);
  const who = target ? ` (${agent(w, target)?.name})` : "";
  if (!steps) {
    log(w, "stuck", [a.id], a, `${a.name} wanted to ${GOALS[type].toLowerCase()}${who} but couldn't work out how.`);
    a.cooldowns[type] = w.t + 60;
    a.goal = null;
    a.nextDecide = w.t + 2;
    return;
  }
  a.plan = steps.map((s) => ({ ...s, progress: 0 }));
  log(w, "goal", [a.id, ...(target ? [target] : [])], a,
    `${a.name} decided to ${GOALS[type].toLowerCase()}${who}. (${Math.round((odds[type] ?? 0) * 100)}% likely)`);
}

function endGoal(w: World, a: Agent, ok: boolean, why?: string) {
  if (!ok && a.goal) log(w, "fail", [a.id], a, `${a.name} gave up trying to ${GOALS[a.goal.type].toLowerCase()}${why ? `: ${why}` : ""}.`);
  if (!ok && a.goal) a.cooldowns[a.goal.type] = w.t + 30;
  a.goal = null;
  a.plan = [];
  a.nextDecide = w.t + 1;
}

function feasible(w: World, a: Agent) {
  const opts: Record<string, string> = {};
  const nearFire = nearest(w, a, (t) => t.kind === "fire");
  const people = w.agents.filter((b) => b !== a && b.down <= w.t && dist(a, b) <= 25 && (a.rel[b.id] || dist(a, b) <= VISION));
  const ok: Record<string, boolean> = {
    forage: true,
    eat: foodCount(a.inv) > 0 || a.needs.food < 70,
    gather_wood: true,
    craft_tool: !a.inv.axe,
    build_shelter: !a.home,
    start_fire: !nearFire || dist(a, nearFire) > 8,
    cook_meal: a.needs.food < 90,
    rest: a.needs.energy < 75,
    warm_up: a.needs.warmth < 75,
    explore: true,
  };
  for (const [k, v] of Object.entries(ok)) if (v && !(a.cooldowns[k] > w.t)) opts[k] = GOALS[k];
  const targets: Record<string, string[]> = {};
  for (const kind of [...SOCIAL, "avoid"]) {
    if (a.cooldowns[kind] > w.t) continue;
    const valid = people.filter((b) => {
      if (kind === "trade") return Object.values(b.inv).some((n) => n) && Object.values(a.inv).some((n) => n);
      if (kind === "take" || kind === "steal") return Object.values(b.inv).some((n) => n);
      if (kind === "share_fire") return !!nearFire && dist(a, nearFire) <= 12;
      if (kind === "help") return !!b.goal && !SOCIAL.includes(b.goal.type) && b.goal.type !== "explore";
      if (kind === "gossip") return w.agents.some((c) => c !== a && c !== b && a.rel[c.id]);
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
    let type = sample(res.goal);
    let target: string | undefined;
    if (targets[type]) {
      const pool = (HOSTILE.includes(type) ? res.against : res.towards) ?? {};
      const odds = Object.fromEntries(targets[type].map((id) => [id, pool[id] ?? 0.01]));
      target = sample(odds);
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

const DURATION: Record<string, [number, Skill | null]> = {
  pick_berries: [3, "foraging"], pick_mushroom: [2, "foraging"], pick_stick: [1, null], pick_stone: [1, null],
  craft_axe: [8, "crafting"], chop: [6, "woodcutting"], light_fire: [5, "firemaking"], cook: [6, "cooking"],
  build_shelter: [24, "building"], eat: [2, null],
};

const STATUS: Record<string, string> = {
  pick_berries: "Picking berries", pick_mushroom: "Gathering a mushroom", pick_stick: "Picking up a stick",
  pick_stone: "Picking up a stone", craft_axe: "Crafting a stone axe", chop: "Chopping a tree",
  light_fire: "Lighting a fire", cook: "Cooking", build_shelter: "Building a shelter", eat: "Eating",
};
const PLACE_NAME: Record<string, string> = {
  bush: "a berry bush", mushroom: "a mushroom", stick: "a stick", stone: "a stone", tree: "a tree", fire: "the fire", home: "home",
};

function adjacent(w: World, a: Agent, k: string) {
  const t = nearest(w, a, (t) => PLACES[k](t, a));
  return t && dist(a, t) <= 1 ? t : null;
}

// Runs the op. Returns true when finished, false while still working, or a string reason when it failed.
function run(w: World, a: Agent): boolean | string {
  const s = a.plan[0];
  switch (s.op) {
    case "goto": {
      if (s.arg === "agent") {
        const b = agent(w, a.goal?.target);
        if (!b || b.down > w.t) return "they weren't around";
        if (dist(a, b) > 30) return `${b.name} was too far away`;
        a.status = `Walking over to ${b.name}`;
        const r = stepToward(w, a, b.x, b.y);
        return r === "stuck" ? "no path" : r === "arrived";
      }
      const t = nearest(w, a, (t) => PLACES[s.arg!](t, a));
      if (!t) return `couldn't find ${PLACE_NAME[s.arg!]}`;
      a.status = `Walking to ${PLACE_NAME[s.arg!]}`;
      const r = stepToward(w, a, t.x, t.y);
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
      const tx = Math.max(0, Math.min(W - 1, a.x + Math.sign(a.x - b.x) * 3));
      const ty = Math.max(0, Math.min(H - 1, a.y + Math.sign(a.y - b.y) * 3));
      stepToward(w, a, tx, ty, 0);
      return false;
    }
    case "rest": {
      const home = a.home && dist(a, a.home) <= 1;
      a.status = isNight(w.t) ? (home ? "Sleeping in the shelter" : "Sleeping on the ground") : home ? "Resting in the shelter" : "Resting";
      a.needs.energy = Math.min(100, a.needs.energy + (home ? 1.4 : 0.7));
      return a.needs.energy >= (isNight(w.t) ? 98 : 85);
    }
    case "warm_up": {
      a.status = "Warming up";
      if (!adjacent(w, a, "fire") && !adjacent(w, a, "home")) return "the warmth was gone";
      a.needs.warmth = Math.min(100, a.needs.warmth + 1.2);
      return a.needs.warmth >= 95;
    }
    case "assist": {
      const b = agent(w, s.arg);
      if (!b || !b.goal || s.progress++ > 30) return true;
      a.status = `Helping ${b.name}`;
      if (stepToward(w, a, b.x, b.y) === "arrived" && b.plan[0] && DURATION[b.plan[0].op]) b.plan[0].progress += 1;
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
  }
  const [base, skill] = DURATION[s.op];
  a.status = STATUS[s.op];
  s.progress += skill ? speed(a, skill) : 1;
  if (s.progress < base) return false;
  return finish(w, a, s.op);
}

function finish(w: World, a: Agent, op: string): true | string {
  switch (op) {
    case "pick_berries": {
      const b = adjacent(w, a, "bush");
      if (!b) return "the bush was picked clean";
      const n = Math.min(b.n!, 2 + Math.floor(level(a.skills.foraging) / 4));
      b.n! -= n;
      touch(b);
      put(a, "berry", n);
      gain(w, a, "foraging", 3);
      log(w, "gather", [a.id], a, `${a.name} picked ${n} berries.`);
      return true;
    }
    case "pick_mushroom": case "pick_stick": case "pick_stone": {
      const k = op.slice(5);
      const t = adjacent(w, a, k);
      if (!t) return `the ${k} was gone`;
      removeThing(w, t);
      put(a, k as Item);
      if (k === "mushroom") gain(w, a, "foraging", 2);
      log(w, "gather", [a.id], a, `${a.name} picked up a ${k}.`);
      return true;
    }
    case "craft_axe":
      if (!a.inv.stick || !a.inv.stone) return "missing a stick or stone";
      take(a, "stick"); take(a, "stone"); put(a, "axe");
      gain(w, a, "crafting", 6);
      log(w, "craft", [a.id], a, `${a.name} crafted a stone axe.`);
      return true;
    case "chop": {
      const t = adjacent(w, a, "tree");
      if (!t) return "the tree was gone";
      if (!a.inv.axe) return "no axe";
      t.kind = "stump";
      t.until = w.t + DAY * 4;
      touch(t);
      const n = 2 + Math.floor(level(a.skills.woodcutting) / 3);
      put(a, "wood", n);
      gain(w, a, "woodcutting", 4);
      log(w, "gather", [a.id], a, `${a.name} chopped down a tree for ${n} wood.`);
      return true;
    }
    case "light_fire":
      if (!a.inv.wood || !a.inv.stick) return "missing wood or a stick";
      take(a, "wood"); take(a, "stick");
      spawn(w, "fire", a.x, a.y, { owner: a.id, until: w.t + Math.round(DAY * 0.5 * speed(a, "firemaking")) });
      gain(w, a, "firemaking", 4);
      log(w, "fire", [a.id], a, `${a.name} lit a campfire.`);
      return true;
    case "cook": {
      if (!adjacent(w, a, "fire")) return "the fire went out";
      if (a.inv.mushroom) take(a, "mushroom");
      else if ((a.inv.berry ?? 0) > 1) take(a, "berry", 2);
      else return "nothing to cook";
      put(a, "meal");
      gain(w, a, "cooking", 4);
      log(w, "cook", [a.id], a, `${a.name} cooked a hot meal.`);
      return true;
    }
    case "build_shelter":
      if (a.home) return "already has a home";
      if ((a.inv.wood ?? 0) < 4 || (a.inv.stick ?? 0) < 2) return "not enough wood and sticks";
      take(a, "wood", 4); take(a, "stick", 2);
      spawn(w, "shelter", a.x, a.y, { owner: a.id });
      a.home = { x: a.x, y: a.y };
      gain(w, a, "building", 10);
      log(w, "build", [a.id], a, `${a.name} built a shelter and now has a home.`);
      return true;
    case "eat": {
      const f = bestFood(a);
      if (!f) return "nothing to eat";
      take(a, f);
      a.needs.food = Math.min(100, a.needs.food + FOOD[f]);
      log(w, "eat", [a.id], a, `${a.name} ate a ${f}.`);
      return true;
    }
  }
  return true;
}

const pickGift = (a: Agent): Item | null =>
  bestFood(a) ?? (["wood", "stick", "stone"] as Item[]).find((i) => (a.inv[i] ?? 0) > 0) ?? null;
const most = (a: Agent, except?: Item): Item | null =>
  (Object.entries(a.inv) as [Item, number][]).filter(([i, n]) => n && i !== except && i !== "axe").sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;

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
      const r = await reply(`${a.name} offers ${b.name} ${n} ${item} as a gift.`, { accept: "Accept the gift", refuse: "Refuse it" });
      if (r === "accept") {
        take(a, item, n); put(b, item, n);
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} gave ${b.name} ${n} ${item}.${b.needs.food < 25 && FOOD[item] ? ` ${b.name} was starving.` : ""}`;
      } else text = `${b.name} refused ${a.name}'s gift of ${item}.`;
      break;
    }
    case "trade": {
      const give = most(a), want = most(b, give ?? undefined);
      if (!give || !want) return;
      gain(w, a, "bargaining", 2);
      const r = await reply(`${a.name} offers ${b.name} 1 ${give} in exchange for 1 ${want}.`, { accept: "Make the trade", refuse: "Turn it down" });
      if (r === "accept") {
        take(a, give); put(b, give); take(b, want); put(a, want);
        gain(w, a, "bargaining", 3);
        text = `${a.name} traded 1 ${give} to ${b.name} for 1 ${want}.`;
      } else text = `${b.name} turned down ${a.name}'s offer to trade ${give} for ${want}.`;
      break;
    }
    case "share_meal": {
      const f = bestFood(a);
      if (!f) return;
      const r = await reply(`${a.name} invites ${b.name} to share some food and eat together.`, { join: "Eat together", decline: "Decline" });
      if (r === "join") {
        take(a, f);
        b.needs.food = Math.min(100, b.needs.food + FOOD[f]);
        const g = bestFood(a);
        if (g) { take(a, g); a.needs.food = Math.min(100, a.needs.food + FOOD[g]); }
        a.needs.social = Math.min(100, a.needs.social + 25);
        b.needs.social = Math.min(100, b.needs.social + 25);
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} shared a ${f} with ${b.name} and they ate together.`;
      } else text = `${b.name} declined ${a.name}'s offer to eat together.`;
      break;
    }
    case "share_fire": {
      const fire = nearest(w, a, (t) => t.kind === "fire");
      if (!fire) return;
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
      const what = b.goal ? GOALS[b.goal.type].toLowerCase() : "their work";
      const r = await reply(`${a.name} offers to help ${b.name} ${what}.`, { accept: "Accept the help", decline: "Say no thanks" });
      if (r === "accept") {
        a.goal = { type: "help", target: b.id, since: w.t, odds: a.goal?.odds ?? {}, fails: 0 };
        a.plan = [{ op: "assist", arg: b.id, progress: 0 }];
        b.rel[a.id].ledger++; ra.ledger--;
        text = `${a.name} started helping ${b.name} ${what}.`;
      } else text = `${b.name} turned down ${a.name}'s offer to help.`;
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
      const item = most(b);
      if (!item) return;
      const hidden = kind === "steal";
      const noticed = !hidden || Math.random() < 0.35 + (b.traits.observant ?? 0) * 0.4 + (b.traits.suspicious ?? 0) * 0.2 - level(a.skills.pickpocketing) * 0.05;
      take(b, item); put(a, item);
      if (hidden) gain(w, a, "pickpocketing", 4);
      if (!noticed) {
        log(w, "steal", [a.id], a, `${a.name} secretly stole a ${item} from ${b.name}. ${b.name} didn't notice.`);
        return;
      }
      const r = await reply(
        hidden ? `${b.name} catches ${a.name} stealing a ${item} from them.` : `${a.name} grabs a ${item} from ${b.name} and keeps it.`,
        { let_it_go: "Let it go", confront: "Confront them and demand it back" },
      );
      const back = r === "confront" && Math.random() < 0.6;
      if (back) { take(a, item); put(b, item); }
      text = `${a.name} ${hidden ? "was caught stealing" : "took"} a ${item} from ${b.name}. ${b.name} ${r === "let_it_go" ? "let it go" : back ? "confronted them and got it back" : "confronted them, but didn't get it back"}.`;
      break;
    }
    default:
      return;
  }
  log(w, kind, witnesses.map((x) => x.id), a, text);
  await Promise.all(witnesses.flatMap((x) => {
    const other = x === a ? b : a;
    return [reflect(w, x, other, text).then((r) => {
      const rel = x.rel[other.id];
      if (r.bond !== "none") log(w, "bond", [x.id], x, `${x.name} will remember this about ${other.name}: ${r.bond.replaceAll("_", " ")}. They now see ${other.name} as a ${rel.label}.`);
    })];
  }));
}

export function tick(w: World) {
  w.t++;
  const night = isNight(w.t);
  for (const t of [...w.things]) {
    if (t.kind === "fire" && t.until! <= w.t) { removeThing(w, t); log(w, "fire_out", [], t, "A campfire burned out."); }
    else if (t.kind === "stump" && t.until! <= w.t) { t.kind = "tree"; delete t.until; touch(t); }
    else if (t.kind === "bush" && (t.n ?? 0) < 4 && Math.random() < 1 / 80) { t.n = (t.n ?? 0) + 1; touch(t); }
  }
  if (Math.random() < 1 / 30) {
    const x = Math.floor(Math.random() * W), y = Math.floor(Math.random() * H);
    if (walkable(w, x, y) && !w.things.some((t) => t.x === x && t.y === y)) {
      const forest = w.tiles[y * W + x] === 1;
      spawn(w, forest ? (Math.random() < 0.5 ? "mushroom" : "stick") : Math.random() < 0.5 ? "stick" : "stone", x, y);
    }
  }
  if (w.t % DAY === 0) for (const a of w.agents) fadeBonds(a);

  for (const a of w.agents) {
    const n = a.needs;
    const warmSpot = w.things.some((t) => (t.kind === "fire" && dist(a, t) <= 3) || (t.kind === "shelter" && t.owner === a.id && dist(a, t) <= 1));
    n.food = Math.max(0, n.food - 0.18);
    n.energy = Math.max(0, n.energy - (night ? 0.16 : 0.1));
    n.social = Math.max(0, n.social - 0.05);
    n.warmth = warmSpot ? Math.min(100, n.warmth + 0.8) : Math.max(0, n.warmth - (night ? 0.25 : 0.03));
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
        if (a.goal && w.t - a.goal.since > 5 && !a.engaged) { a.goal = null; a.plan = []; }
      }
      a.seen[b.id] = w.t;
    }

    if (a.thinking || a.engaged) continue;
    const critical = (["food", "energy", "warmth"] as const).find((k) => n[k] < 20);
    if (a.goal && critical && !NEEDS_GOAL[critical].includes(a.goal.type) && !(a.cooldowns.interrupt > w.t)) {
      a.cooldowns.interrupt = w.t + 40;
      a.goal = null; a.plan = [];
    }
    if (a.goal && w.t - a.goal.since > DAY / 2) endGoal(w, a, false, "took too long");
    if (!a.goal) {
      if (w.t >= a.nextDecide) void think(w, a);
      else a.status = "Idle";
      continue;
    }
    if (!a.plan.length) { endGoal(w, a, true); continue; }
    const r = run(w, a);
    if (r === true) {
      a.plan.shift();
      if (!a.plan.length) endGoal(w, a, true);
    } else if (typeof r === "string") {
      a.goal.fails++;
      if (a.goal.fails > 2) { endGoal(w, a, false, r); continue; }
      const steps = planFor(w, a);
      if (!steps) endGoal(w, a, false, r);
      else a.plan = steps.map((s) => ({ ...s, progress: 0 }));
    }
  }
}

export { inventoryText };
