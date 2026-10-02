import {
  DAY, H, REACH, TILE_M, W, clock, isNight, shoreOf, level, log, meters, reachOf, stageOf,
  type Act, type Agent, type Animal, type Step, type Thing, type World,
} from "./world";
import { THING_MATERIAL, depth, noun, p, plural, type Kind } from "./materials";
import {
  airy, applyRuling, beside, count, counts, digTick, diggable, eat, fireKind, force, giveItems, greasy, heat, homeOf, join, mark, nearFire, openWater, place as placeItems, plant,
  reaches, removeThing, rubTick, shape, stash, strikeDamage, strikeTick, takeItems, throwTick, unstash, wearIt, wet, type Outcome,
} from "./physics";
import { die, life, lifeSummary } from "./life";
import { beliefKey, beliefText, record, see, sentence, teach, watchers, type Belief } from "./beliefs";
import { COLLECT, GATHER, SOCIAL, SOCIAL_ITEM_NEEDS, edibleKinds, foodIn, plan, type Ctx, type PState } from "./plan";
import { burnedHomes, ecology, onGrew, trample, trapped, tread } from "./ecology";
import { FAUNA, HUNTED } from "./fauna";
import { attacked } from "./animals";
import { chooseTinker, decide, describeKind, fadeBonds, nameIt, newRel, reflect, respond, rule, sample } from "./brain";
import { clock as traceClock, count as bump, timed, trace } from "./trace";
import { campOf, friendly, groups, incident, knownCustoms, liveCamps, share, sharedStore, snubbed, spread, standing, takeShared } from "./groups";
import { anyAround, around, liveThings, nearestThing, shelve, thingById } from "./space";
import { landOf, walk } from "./walk";
import { DARK, canSee, lightOn, moveRate, restRate, workRate } from "./light";
import { airOn } from "./air";
import { enrich } from "./soil";
import { travel } from "./journeys";

const VISION = 300; // meters: how far off someone notices another person
const WALK = 2, RUN = 6; // meters a tick for an adult
const SEARCH = 800; // meters: the farthest anyone goes looking for something to gather or work
const nm = (w: World, k: string) => w.kinds[k]?.name ?? k.replaceAll("_", " ");
const an = (s: string) => (s.includes("'s ") ? s : /^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const agentById = (w: World, id?: string) => w.agents.find((a) => a.id === id);

export const GOALS: Record<string, string> = {
  forage: "Gather berries or mushrooms to eat later",
  eat: "Eat something now",
  rest: "Rest or sleep to recover energy",
  warm_up: "Get warm by a fire or at home",
  explore: "Wander off and explore new land",
  tinker: "Experiment: try things with what's at hand to see what happens",
  "experiment:shelter": "Try to put together some kind of shelter from what's at hand",
  "experiment:fire": "Try to find a way to make fire",
  "experiment:tool": "Try to make a better tool",
  "experiment:food": "Try new ways to get food",
  collect_stones: "Collect stones",
  collect_sticks: "Collect sticks",
  collect_reeds: "Pull up reeds for fiber",
  collect_clay: "Dig up clay",
  collect_resin: "Scrape beads of resin off wounded trees",
  collect_bark: "Gather strips of bark",
  collect_ore: "Pick up the reddish stones lying about",
  make_fire: "Start a fire",
  build_shelter: "Build or add to a shelter",
  move_home: "Leave their shelter and build a new one next to the home of someone they like",
  contain_fire: "Ring the fire with stones",
  plant: "Plant something to grow",
  cure: "Eat something that eases sickness",
  put_on: "Put on something warm",
  dig_pit: "Dig a pit",
  set_trap: "Hide a pit to trap animals",
  store_food: "Put food and goods away at home",
  share_store: "Set spare food and goods aside for the whole camp to share",
  raid: "Sneak into someone's home and take their stores",
  stay_close: "Stay close to family and watch what they do",
  talk: "Walk over and chat with someone",
  give: "Give someone food or materials as a gift",
  trade: "Offer someone a trade",
  share_meal: "Share food and eat together with someone",
  share_fire: "Invite someone to sit by a fire together",
  help: "Help someone with what they are doing",
  gossip: "Tell someone what you think of a third person",
  teach: "Show someone how to do something you know",
  tend: "Go look after someone who has collapsed",
  beg: "Ask someone for something to eat",
  insult: "Insult or mock someone",
  take: "Take something from someone openly",
  steal: "Secretly steal something from someone",
  attack: "Attack someone",
  avoid: "Keep away from someone",
  flee: "Run for safety",
};
const lower = (s: string) => s[0].toLowerCase() + s.slice(1);
export function goalText(w: World, type: string, target?: string) {
  if (type.startsWith("make:")) return `Make ${an(nm(w, type.slice(5)))}`;
  if (type.startsWith("hunt:")) return `Hunt ${an(type.slice(5))}`;
  if (type === "defend") return `Fight off the wolf attacking ${agentById(w, target)?.name ?? "someone"}`;
  if (type === "fight") return "Fight off a wolf";
  const name = agentById(w, target)?.name;
  const text = GOALS[type] ?? cap(type.replaceAll("_", " "));
  return name && text.includes("someone") ? text.replace("someone", name) : text;
}
const HOSTILE = ["insult", "take", "steal", "avoid", "attack", "raid"];
const NEED_FIX: Record<string, (type: string, w: World) => boolean> = {
  food: (t, w) => ["eat", "forage", "share_meal"].includes(t) || t.startsWith("hunt:") || (t.startsWith("make:") && p(w.kinds[t.slice(5)], "edible") > 0),
  energy: (t) => t === "rest",
  warmth: (t) => ["warm_up", "share_fire", "make_fire", "build_shelter", "move_home", "put_on", "contain_fire"].includes(t),
};
const isTool = (k?: Kind) => !!k && (k.verb === "join" || k.verb === "rub" || p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6);
// Roughly how much losing one of these costs someone: tools more than food, food more than raw stuff.
const valueOf = (w: World, k: string) => { const x = w.kinds[k]; return isTool(x) ? 0.45 : p(x, "edible") >= 0.1 ? 0.15 + p(x, "edible") * 0.5 : 0.1; };

// ---------- places ----------
type Place = { kinds: readonly string[]; ok?: (t: Thing) => boolean };
const THING_PLACES: Record<string, Place> = {
  bush: { kinds: ["bush"], ok: (t) => (t.n ?? 0) > 0 && !t.burning },
  mushroom: { kinds: ["mushroom"] }, herb: { kinds: ["herb"] }, stick: { kinds: ["stick"] }, stone: { kinds: ["stone"] },
  reeds: { kinds: ["reeds"], ok: (t) => !t.burning }, clay: { kinds: ["clay"] }, tree: { kinds: ["tree"], ok: (t) => !t.burning },
  boulder: { kinds: ["boulder"] }, stump: { kinds: ["stump"] }, dead_bush: { kinds: ["dead_bush"] }, fallen_log: { kinds: ["fallen_log"], ok: (t) => !t.burning },
  // Anything on fire is a fire you can take a flame from or warm up by.
  fire: { kinds: [] },
  pit: { kinds: ["pit"] },
  hearth: { kinds: ["fire"], ok: (t) => !!t.contained },
  kiln: { kinds: ["fire"], ok: (t) => !!t.contained && !!t.covered },
  forge: { kinds: ["fire"], ok: (t) => !!t.contained && (t.charcoal ?? 0) > 0 },
  resin: { kinds: ["tree", "stump"], ok: (t) => (t.resin ?? 0) > 0 },
};
// What everyone knows the whereabouts of in the dark. The rest they find by sight, so a plant, a stone or an animal beyond it
// is no place to go.
const KNOWN: Record<string, true> = { home: true, homesite: true, store: true, water: true, pit: true, agent: true };
const FIRES: Record<string, true> = { fire: true, hearth: true, kiln: true, forge: true };
// A step that takes someone out after what they would have to see: exploring, gathering, or walking to a plant, a stone, an
// animal or a thing lying about.
const foray = (s: Step) => s.op === "wander" || s.op in GATHER || (s.op === "goto" && !!s.arg && !KNOWN[s.arg] && !FIRES[s.arg]);
const STRIKEABLE = Object.keys(THING_MATERIAL).filter((k) => !(k in FAUNA));
// A place to go and how near to get: a thing, an animal, a person, or a point.
type Spot = { px: number; py: number; reach: number; thing?: Thing; animal?: Animal; agent?: Agent };
function nearest<T extends { px: number; py: number }>(a: { px: number; py: number }, list: Iterable<T>, ok: (t: T) => boolean = () => true): T | null {
  let best: T | null = null, bd = Infinity;
  for (const t of list) if (ok(t)) { const d = meters(a, t); if (d < bd) { bd = d; best = t; } }
  return best;
}
// On ground the agent could walk to from where they are.
const reachable = (w: World, a: Agent, x: number, y: number) => { const land = landOf(w); return land[y * W + x] > 0 && land[y * W + x] === land[a.y * W + a.x]; };
const thingSpot = (t: Thing | null): Spot | null => t && { px: t.px, py: t.py, reach: reachOf(t), thing: t };
// Someone without a home settles beside the home of whoever they like most, if anyone they like has one.
// A lean-to far from a close friend isn't worth staying in either.
function homesite(w: World, a: Agent): Spot | null {
  const mine = homeOf(w, a);
  if ((mine?.shelter?.tier ?? 0) >= 2) return null;
  const friend = w.agents
    .filter((b) => b !== a && (a.rel[b.id]?.affinity ?? 0) > (mine ? 0.4 : 0.15) && homeOf(w, b) && homeOf(w, b) !== mine && meters(a, homeOf(w, b)!) <= 600 && (!mine || meters(mine, homeOf(w, b)!) > 60))
    .sort((x, y) => a.rel[y.id].affinity - a.rel[x.id].affinity)[0];
  const h = friend && homeOf(w, friend);
  if (!h) return null;
  // A clear patch of ground a few paces from their door.
  for (const r of [6, 9, 12, 15])
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2 + h.seed, px = h.px + (Math.cos(ang) * r) / TILE_M, py = h.py + (Math.sin(ang) * r) / TILE_M;
      if (px >= 0 && py >= 0 && px < W && py < H && reachable(w, a, Math.floor(px), Math.floor(py)) && diggable(w, px, py) && !anyAround(w, px, py, 3, ["structure"])) return { px, py, reach: 1 };
    }
  return null;
}
function spot(w: World, a: Agent, kind: string): Spot | null {
  if (kind === "home") { const h = homeOf(w, a); return h && { px: h.px, py: h.py, reach: reachOf(h) + 0.5, thing: h }; }
  if (kind === "homesite") return homesite(w, a);
  if (kind === "store") return thingSpot(sharedStore(w, a));
  if (kind === "agent") { const b = agentById(w, a.goal?.target); return b ? { px: b.px, py: b.py, reach: 2, agent: b } : null; }
  if (kind === "water") {
    const s = nearest(a, shoreOf(w), (p) => reachable(w, a, Math.floor(p.px), Math.floor(p.py)));
    const well = nearestThing(w, a.px, a.py, ["well"], (t) => reachable(w, a, t.x, t.y), s ? meters(a, s) : SEARCH);
    return well ? thingSpot(well) : s && { ...s, reach: 1 };
  }
  if ((HUNTED as readonly string[]).includes(kind)) { const x = nearest(a, w.animals, (m) => m.species === kind); return x && { px: x.px, py: x.py, reach: REACH + 0.5, animal: x }; }
  const ok = (t: Thing) => reachable(w, a, t.x, t.y);
  if (kind.startsWith("item:")) { const k = kind.slice(5); return thingSpot(nearestThing(w, a.px, a.py, ["item"], (t) => t.item === k && ok(t), SEARCH)); }
  if (kind === "fire") return thingSpot(nearest(a, liveThings(w), (t) => (t.kind === "fire" || (t.burning ?? 0) > 0.3) && meters(a, t) <= SEARCH && ok(t)));
  const f = THING_PLACES[kind];
  return f ? thingSpot(nearestThing(w, a.px, a.py, f.kinds, (t) => (!f.ok || f.ok(t)) && ok(t), SEARCH)) : null;
}
// The place, if they're already close enough to it to work there (give or take `slack` meters).
const within = (w: World, a: Agent, kind: string, slack = 0) => { const s = spot(w, a, kind); return s && meters(a, s) <= s.reach + slack ? s : null; };

// ---------- movement ----------
const speedOf = (w: World, a: Agent, run: boolean) =>
  (run ? RUN : WALK) * (stageOf(w, a) === "child" ? 0.6 : 1) * (w.paths[a.y * W + a.x] >= 5 ? 1.4 : 1) * moveRate(lightOn(w, a).bright);
// Walk (or run) toward a point in tiles until within reach meters of it.
function stepToward(w: World, a: Agent, tx: number, ty: number, reach: number, run = false): "arrived" | "moved" | "stuck" {
  const x0 = a.px, y0 = a.py;
  const r = walk(w, a, tx, ty, speedOf(w, a, run), reach);
  const walked = Math.hypot(a.px - x0, a.py - y0) * TILE_M;
  if (!walked) return r;
  trample(w, a, walked);
  tread(w, x0, y0, a.px, a.py);
  const fell = trapped(w, a, x0, y0);
  if (fell && typeof fell === "object") {
    const text = `${a.name} fell into a pit ${fell.name} had hidden.`;
    incident(w, { act: "trapped", by: fell, against: a, at: a, text, value: 0.25, seenBy: [a, ...w.agents.filter((b) => b !== fell && canSee(w, b, a, 30))] });
    reflect(w, a, fell, text).then((r) => { if (r.bond !== "none") log(w, "bond", [a.id], a, `${a.name} will remember this about ${fell.name}: ${r.bond.replaceAll("_", " ")}.`); }).catch(() => {});
  }
  return fell ? "stuck" : r;
}
function stepAway(w: World, a: Agent, from: { px: number; py: number }, run = true) {
  const d = Math.hypot(a.px - from.px, a.py - from.py) || 1e-6, far = 30 / TILE_M;
  stepToward(w, a, Math.max(0, Math.min(W - 1e-3, a.px + ((a.px - from.px) / d) * far)), Math.max(0, Math.min(H - 1e-3, a.py + ((a.py - from.py) / d) * far)), 1, run);
}

// ---------- planning glue ----------
// The planner weighs trips in steps of fifteen meters, about what one step used to be worth.
const STEP_M = 15;
export function ctxFor(w: World, a: Agent): Ctx {
  const d: Record<string, number> = {};
  // In the dark, unless they are freezing or starving, they plan around what they can see: a bush 300 m off is not a place to go.
  const blind = lightOn(w, a).bright < DARK && a.needs.food >= 15 && a.needs.warmth >= 15;
  for (const k of [...Object.keys(THING_PLACES), "water", "home", "homesite", "store", ...HUNTED]) { const s = spot(w, a, k); if (s && (k !== "pit" || s.thing?.owner === a.id) && (!blind || KNOWN[k] || canSee(w, a, s, SEARCH))) d[k] = meters(a, s) / STEP_M; }
  around(w, a.px, a.py, 600, ["item"], (t, m) => { if (t.item && reachable(w, a, t.x, t.y) && (!blind || canSee(w, a, t, SEARCH))) d[`item:${t.item}`] = Math.min(d[`item:${t.item}`] ?? 99, m / STEP_M); });
  const target = agentById(w, a.goal?.target);
  if (target) d.agent = meters(a, target) / STEP_M;
  const toxic = Object.values(a.beliefs).filter((b) => b.fields.verb === "eat" && b.fields.effect === "sick").map((b) => b.fields.inputs[0]);
  const home = homeOf(w, a);
  const store: Record<string, number> = {};
  for (const s of home?.store ?? []) store[s.k] = (store[s.k] ?? 0) + 1;
  const shared: Record<string, number> = {};
  const camp = sharedStore(w, a);
  if (camp && camp !== home) for (const s of camp.store ?? []) shared[s.k] = (shared[s.k] ?? 0) + 1;
  return { dist: d, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic, store, shared };
}
function pstate(w: World, a: Agent): PState {
  const fire = nearFire(w, a);
  return { inv: counts(a), at: fire ? fireKind(fire) : within(w, a, "home") ? "home" : null, flags: [] };
}
function planGoal(w: World, a: Agent, type: string, target?: string, ctx = ctxFor(w, a)): Step[] | null {
  const mk = (op: string, arg?: string): Step[] => [{ op, arg, progress: 0 }];
  if (type === "explore") {
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * Math.PI * 2, m = 80 + Math.random() * 320, x = a.px + (Math.cos(ang) * m) / TILE_M, y = a.py + (Math.sin(ang) * m) / TILE_M;
      if (x >= 0 && y >= 0 && x < W && y < H && reachable(w, a, Math.floor(x), Math.floor(y))) return mk("wander", `${x.toFixed(4)},${y.toFixed(4)}`);
    }
    return null;
  }
  if (type === "avoid") return mk("avoid", target);
  if (type === "tinker") return mk("tinker");
  if (type.startsWith("experiment:")) return mk("tinker", type.slice(11));
  if (type === "raid") { const h = [...liveThings(w)].find((t) => t.kind === "structure" && t.owner === target && t.store?.length); return h ? [{ op: "raid", arg: h.id, progress: 0 }] : null; }
  if (type === "stay_close") return mk("follow", target);
  if (type === "tend") return [{ op: "goto", arg: "agent", progress: 0 }, { op: "tend", arg: target, progress: 0 }];
  if (type === "flee" || type === "fight" || type === "defend") return mk(type === "flee" ? "flee" : "fight", target);
  if (type === "store_food" && homeOf(w, a)) return [{ op: "goto", arg: "home", progress: 0 }, { op: "stash", progress: 0 }];
  if (type === "share_store") return sharedStore(w, a) || homeOf(w, a) ? [{ op: "goto", arg: sharedStore(w, a) ? "store" : "home", progress: 0 }, { op: "share", progress: 0 }] : null;
  const dists: Record<string, number> = { ...ctx.dist, ...(target && agentById(w, target) ? { agent: meters(a, agentById(w, target)!) / STEP_M } : {}) };
  if (type === "move_home") { if (!("homesite" in dists)) return null; delete dists.home; }
  const steps = plan(pstate(w, a), type === "move_home" ? "build_shelter" : type, { ...ctx, dist: dists });
  return steps?.map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 })) ?? null;
}
function stepLabel(w: World, a: Agent, s: Step): string {
  if (s.op === "goto" && s.arg === "homesite") return "Go to a spot beside the home of someone they like";
  if (s.op === "goto") return s.arg === "agent" ? `Go to ${agentById(w, a.goal?.target)?.name}` : `Go to ${s.arg!.startsWith("item:") ? `the ${nm(w, s.arg!.slice(5))}` : `the ${s.arg!.replaceAll("_", " ")}`}`;
  if (s.op === "act" && s.key && a.beliefs[s.key]) return actText(w, actFromBelief(a.beliefs[s.key]));
  if (s.op === "tinker") return s.act ? actText(w, s.act) : "Experiment";
  if (s.op === "social") return `${cap(s.arg!.replaceAll("_", " "))} with ${agentById(w, a.goal?.target)?.name}`;
  if (s.op === "pick_up") return `Pick up the ${nm(w, s.arg!)}`;
  if (s.op === "fight") return "Fight the wolf";
  if (s.op === "wander") return "Explore";
  return cap(s.op.replaceAll("_", " "));
}

function setGoal(w: World, a: Agent, type: string, odds: Record<string, number>, target?: string) {
  const steps = planGoal(w, a, type, target);
  const tn = agentById(w, target)?.name;
  const who = tn && type !== "defend" && !goalText(w, type, target).includes(tn) ? ` (${tn})` : "";
  if (!steps) {
    log(w, "stuck", [a.id], a, `${a.name} wanted to ${lower(goalText(w, type, target))}${who} but couldn't work out how.`);
    trace("plan", "no_plan", { type, target }, a.id);
    a.cooldowns[type] = w.t + 60;
    a.nextDecide = w.t + 2;
    return;
  }
  a.goal = { type, target, since: w.t, odds, fails: 0 };
  a.plan = steps;
  trace("plan", "plan", { type, target, steps: steps.map((s) => stepLabel(w, a, s)) }, a.id);
  if (odds[type] !== undefined)
    log(w, "goal", [a.id, ...(target ? [target] : [])], a, `${a.name} decided to ${lower(goalText(w, type, target))}${who}. (${Math.round((odds[type] ?? 0) * 100)}% likely)`);
}
function endGoal(w: World, a: Agent, ok: boolean, why?: string) {
  if (!ok && a.goal) {
    log(w, "fail", [a.id], a, `${a.name} gave up trying to ${lower(goalText(w, a.goal.type, a.goal.target))}${why ? `: ${why}` : ""}.`);
    a.cooldowns[a.goal.type] = w.t + 30;
  }
  trace("plan", "end", { type: a.goal?.type, ok, why }, a.id);
  a.goal = null;
  a.plan = [];
  a.nextDecide = w.t + 1;
}

// ---------- deciding ----------
const canCache = new Map<string, Record<string, { t: number; ok: boolean }>>();
function feasible(w: World, a: Agent) {
  const opts: Record<string, string> = {};
  const ctx = ctxFor(w, a);
  const fire = spot(w, a, "fire");
  // In the dark nobody sets out to forage, explore or hunt; they rest, mend the fire and keep to it.
  const dark = lightOn(w, a).bright < DARK;
  const people = w.agents.filter((b) => b !== a && b.down <= w.t && meters(a, b) <= 600 && (a.rel[b.id] || canSee(w, a, b, VISION)));
  const fallen = w.agents.filter((b) => b !== a && b.down > w.t && canSee(w, a, b, VISION));
  const holding = a.inv.length > 0;
  const home = homeOf(w, a);
  const can = (type: string) => {
    if (a.cooldowns[type] > w.t) return false;
    const hit = canCache.get(a.id)?.[type];
    if (hit && w.t - hit.t < 40) return hit.ok;
    const ok = !!planGoal(w, a, type, undefined, ctx);
    (canCache.get(a.id) ?? canCache.set(a.id, {}).get(a.id)!)[type] = { t: w.t, ok };
    return ok;
  };
  const add = (type: string, ok: boolean) => { if (ok && !(a.cooldowns[type] > w.t)) opts[type] = goalText(w, type); };
  add("forage", !dark);
  add("eat", foodIn(counts(a), ctx) > 0 || (a.needs.food < 70 && !dark));
  add("rest", a.needs.energy < 75 || (dark && a.needs.energy < 95));
  add("warm_up", (a.needs.warmth < 75 || (dark && !!fire && meters(a, fire) > 15)) && can("warm_up"));
  add("explore", !dark);
  add("tinker", holding || !!anyAround(w, a.px, a.py, 20, STRIKEABLE));
  // Aimed experiments: they don't know how, but they know what they're after.
  const knows = (b: string) => Object.values(a.beliefs).some((x) => x.fields.builds === b && x.wins > 0);
  if (holding) {
    add("experiment:shelter", !knows("shelter") && !home);
    add("experiment:fire", !knows("fire"));
    add("experiment:tool", true);
    add("experiment:food", a.needs.food < 70);
  }
  for (const [type, k] of Object.entries(COLLECT)) add(type, !dark && count(a, k) < 6 && (k === "stone" || k === "stick" || (ctx.dist[k === "fiber" ? "reeds" : k] ?? ctx.dist[`item:${k}`]) !== undefined));
  const believes = Object.values(a.beliefs);
  const builds = (b: string) => believes.some((x) => x.fields.builds === b && x.wins > 0);
  add("make_fire", builds("fire") && (!fire || meters(a, fire) > 60) && can("make_fire"));
  add("build_shelter", builds("shelter") && (home?.shelter?.tier ?? 0) < 3 && can("build_shelter"));
  const site = homesite(w, a);
  if (site && home) add("move_home", builds("shelter") && can("move_home"));
  else if (site && opts.build_shelter) opts.build_shelter = "Build a first shelter next to the home of someone they like";
  add("contain_fire", builds("hearth") && !!fire && !(fire.thing?.contained) && meters(a, fire) <= 100 && can("contain_fire"));
  add("plant", builds("bush") && can("plant"));
  add("cure", !!a.sickness && believes.some((b) => b.fields.effect === "cure") && can("cure"));
  add("put_on", !a.wearing && builds("worn") && can("put_on"));
  add("dig_pit", builds("pit") && !anyAround(w, a.px, a.py, SEARCH, ["pit"], (t) => t.owner === a.id) && can("dig_pit"));
  add("set_trap", builds("trap") && can("set_trap"));
  const foodHeld = a.inv.filter((s) => p(w.kinds[s.k], "edible") >= 0.1).length;
  add("store_food", !!home && (home.shelter?.tier ?? 0) >= 1 && meters(a, home) <= 300 && (foodHeld > 3 || a.inv.length > 12));
  const store = sharedStore(w, a);
  add("share_store", !!campOf(w, a.id) && (foodHeld > 3 || a.inv.length > 10) && ((!!store && meters(a, store) <= 400) || (!!home && meters(a, home) <= 300)));
  const products = new Set(believes.filter((b) => b.wins > 0 || (b.rate ?? 0) > 0).flatMap((b) => [...Object.keys(b.out), ...(b.fields.target && a.facts[`breaks:${b.fields.target}`] ? Object.keys(THING_MATERIAL[b.fields.target]?.breaks ?? {}) : [])]));
  for (const k of products) {
    if (Object.keys(FAUNA).some((s) => THING_MATERIAL[s]?.breaks[k])) continue;
    const kind = w.kinds[k];
    if (count(a, k) >= (isTool(kind) ? 1 : 4)) continue;
    // Nobody keeps making a thing they've never found a use for.
    if (kind?.made && p(kind, "edible") <= 0 && !kind.uses && !believes.some((b) => b.wins > 0 && (b.fields.tool === k || b.fields.inputs.includes(k)))) continue;
    add(`make:${k}`, can(`make:${k}`));
  }
  for (const species of HUNTED) {
    const hunter = believes.some((b) => b.fields.target === species && (b.rate ?? 0) > 0) || !!a.facts[`breaks:${species}`];
    const prey = nearest(a, w.animals, (m) => m.species === species);
    if (hunter && prey && !dark && meters(a, prey) <= 400) opts[`hunt:${species}`] = goalText(w, `hunt:${species}`);
  }
  const targets: Record<string, string[]> = {};
  const child = stageOf(w, a) === "child";
  for (const kind of [...SOCIAL, "avoid", "raid", "stay_close"]) {
    if (a.cooldowns[kind] > w.t) continue;
    if (kind === "tend") {
      if (fallen.length) { opts.tend = GOALS.tend; targets.tend = fallen.map((b) => b.id); }
      continue;
    }
    if (child && ["attack", "teach", "raid", "steal", "take"].includes(kind)) continue;
    const valid = people.filter((b) => {
      if (kind === "trade") return b.inv.length > 0 && holding;
      if (kind === "give" || kind === "share_meal") return !!SOCIAL_ITEM_NEEDS[kind]?.({ inv: counts(a), at: "agent", flags: [] }, w.kinds);
      if (["take", "steal", "insult", "attack"].includes(kind) && a.cooldowns[`hostile:${b.id}`] > w.t) return false;
      if (SOCIAL.includes(kind) && kind !== "tend" && a.cooldowns[`social:${b.id}`] > w.t) return false;
      if (kind === "take" || kind === "steal") return b.inv.some((s) => !a.inv.some((x) => x.k === s.k) && (p(w.kinds[s.k], "edible") < 0.1 || a.needs.food < 60));
      if (kind === "share_fire") return !!fire && meters(a, fire) <= 150;
      if (kind === "help") return !!b.goal && !SOCIAL.includes(b.goal.type) && !["explore", "help", "avoid", "flee"].includes(b.goal.type);
      if (kind === "gossip") return w.agents.some((c) => c !== a && c !== b && a.rel[c.id]);
      if (kind === "teach") return Object.keys(a.beliefs).some((k) => !b.beliefs[k] && a.beliefs[k].wins > 0);
      if (kind === "beg") return a.needs.food < 45 && b.inv.some((s) => p(w.kinds[s.k], "edible") >= 0.1);
      if (kind === "attack") return (a.rel[b.id]?.affinity ?? 0) < -0.3 && b.needs.health > 30;
      if (kind === "raid") return meters(a, b) > 150 && [...liveThings(w)].some((t) => t.kind === "structure" && t.owner === b.id && t.store?.length && meters(a, t) <= 500);
      if (kind === "stay_close") return b.rel[a.id]?.label === "kin" || a.rel[b.id]?.label === "kin";
      return true;
    });
    if (!valid.length) continue;
    opts[kind] = GOALS[kind];
    targets[kind] = valid.map((b) => b.id);
  }
  // Dark, tired of nothing, and nothing to mend: sitting it out is always there to choose.
  if (!Object.keys(opts).length) opts.rest = goalText(w, "rest");
  return { opts, targets, people: [...people, ...fallen].map((b) => b.id) };
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
    a.lastDecision = { t: w.t, goal: res.goal, labels: opts, who: target ? (HOSTILE.includes(type) ? res.against : res.towards) : undefined, chosen: type, target };
    trace("brain", "decided", { chosen: type, target, odds: res.goal }, a.id);
    a.thinking = false;
    if (a.down > w.t || a.engaged || a.goal) return;
    setGoal(w, a, type, res.goal, target);
  } catch (e) {
    console.error(`decide ${a.name}:`, e);
    trace("brain", "error", { error: String(e) }, a.id);
    a.thinking = false;
    a.status = "Lost in thought";
    a.nextDecide = w.t + 10;
  }
}

// ---------- acts ----------
export function actFromBelief(b: Belief): Act {
  const f = b.fields;
  if (f.verb === "strike") {
    if (!f.inputs.length) return { verb: "strike", items: [], tool: f.tool ?? null, target: { kind: f.target } };
    return { verb: "strike", items: [], tool: f.tool ?? null, target: { kind: f.target ?? f.inputs[0] } };
  }
  return { verb: f.verb as Act["verb"], items: f.verb === "rub" ? f.inputs.slice(0, 2) : [...f.inputs], tool: f.tool ?? null, shape: f.shape as Act["shape"], at: f.at ?? null };
}
export function actText(w: World, act: Act): string {
  const tool = act.tool ? `the ${nm(w, act.tool)}` : "bare hands";
  const items = act.items.map((k) => nm(w, k));
  const same = items.length === 2 && items[0] === items[1];
  switch (act.verb) {
    case "strike": return `Strike ${act.target?.thing || act.target?.animal || ["tree", "bush", "boulder", "reeds", "stump", "dead_bush", "deer", "wolf"].includes(act.target?.kind ?? "") ? "the" : "a"} ${nm(w, act.target?.kind ?? "")} with ${act.tool ? tool : "bare hands"}`;
    case "rub": return same ? `Rub two ${items[0]}s together` : `Rub the ${items[0]} against the ${items[1]}`;
    case "join": return same && items.length === 2 ? `Twist two ${items[0]}s together` : `Bind ${items.map((x) => `the ${x}`).join(", ")} together`;
    case "heat": return act.tool ? `Heat the ${items.join(" and ")} in the fire, blowing air at it with the ${nm(w, act.tool)}` : `Hold ${items.map((x) => `the ${x}`).join(" and ")} in the fire`;
    case "wet": return `Dip the ${items[0]} in the water`;
    case "shape": return `Press the ${items[0]} into a ${act.shape}`;
    case "place": {
      const c: Record<string, number> = {};
      for (const k of items) c[k] = (c[k] ?? 0) + 1;
      const what = Object.entries(c).map(([k, n]) => (n > 1 ? `${n} ${plural(k)}` : `the ${k}`)).join(" and ");
      return items.length >= 3 ? `Lean and stack ${what} against each other here` : `Set down ${what} here`;
    }
    case "plant": return `Push the ${items[0]} into the ground`;
    case "wear": return `Wrap the ${items[0]} around themselves`;
    case "eat": return `Eat the ${items[0]}`;
    case "throw": return `Throw the ${items[0]} at the ${act.target?.kind}`;
    case "dig": return `Dig here with ${act.tool ? tool : "bare hands"}`;
  }
}
const actSig = (act: Act) => [act.verb, [...act.items].sort().join("+"), act.tool ?? "-", act.target?.kind ?? "-", act.at ?? "-", act.shape ?? "-"].join("|");

const SKILL: Record<string, (act: Act, w: World) => string> = {
  strike: (act, w) => act.target?.kind?.startsWith("hot:") || p(w.kinds[act.target?.kind ?? ""], "metal") >= 0.8 ? "smithing"
    : act.target?.kind === "tree" || act.target?.kind === "stump" ? "woodcutting" : act.target?.kind === "deer" || act.target?.kind === "wolf" ? "hunting" : ["stone", "bone", "boulder", "flint"].includes(act.target?.kind ?? "") ? "stonework" : "toolwork",
  rub: (act, w) => (act.items.some((k) => greasy(w.kinds[k])) ? "leatherworking" : act.items.some((k) => p(w.kinds[k], "flammable") >= 0.5) ? "firemaking" : "toolwork"),
  join: () => "crafting",
  heat: (act, w) => {
    const ks = act.items.map((k) => w.kinds[k]);
    return ks.some((k) => p(k, "metal") >= 0.3) ? "smithing" : ks.some((k) => p(k, "plastic") > 0.5) ? "pottery" : ks.some((k) => p(k, "insulating") >= 0.5 && p(k, "flexible") >= 0.5) ? "leatherworking" : ks.some((k) => p(k, "edible") > 0) ? "cooking" : "charcoal burning";
  },
  wet: () => "fishing", shape: () => "pottery", place: () => "building", plant: () => "farming", wear: () => "crafting", eat: () => "foraging",
  throw: () => "throwing", dig: () => "digging",
};
function gain(w: World, a: Agent, skill: string, n: number) {
  const before = level(a.skills[skill] ?? 0);
  a.skills[skill] = (a.skills[skill] ?? 0) + n;
  if (level(a.skills[skill]) > before) log(w, "level", [a.id], a, `${a.name} got better at ${skill} (level ${level(a.skills[skill])}).`);
}

const DURATION: Record<string, number> = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, wear: 2 };
const pendingRulings = new Set<string>();
const namingNow = new Set<string>();
const rulingKey = (act: Act) => `rule|${actSig(act)}`;

// In poor light a tick's work is sometimes lost to groping about, though not in a fight, which is quick and close.
function fumbles(w: World, a: Agent) {
  if (a.goal?.type === "fight" || a.goal?.type === "defend") return false;
  const b = lightOn(w, a).bright;
  if (Math.random() < workRate(b)) return false;
  a.status = b < DARK ? "Fumbling in the dark" : "Working in poor light";
  return true;
}

// Run one tick of an act. Returns the outcome when it resolves, "wait" while working, or a reason string if it can't happen.
function doAct(w: World, a: Agent, s: Step): Outcome | "wait" | string {
  const act = s.act!;
  if (act.verb === "strike") {
    const long = p(w.kinds[act.tool ?? ""], "long") >= 0.6 ? 1 : 0;
    if (act.target && !act.target.thing && !act.target.animal && THING_MATERIAL[act.target.kind ?? ""]) {
      const kind = act.target.kind!;
      if (kind in FAUNA) {
        const prey = nearest(a, w.animals, (m) => m.species === kind && m.alt < 2);
        if (!prey || meters(a, prey) > 250) return `the ${kind} got away`;
        act.target.animal = prey.id;
      } else {
        const t = nearestThing(w, a.px, a.py, [kind], (x) => !x.burning && reachable(w, a, x.x, x.y), 25);
        if (!t) return `no ${kind} within reach`;
        act.target.thing = t.id;
      }
    }
    if (act.target?.thing) {
      const t = thingById(w, act.target.thing);
      if (t && meters(a, t) > reachOf(t) + long) {
        a.status = `Walking over to the ${nm(w, t.kind)}`;
        if ((s.tries = (s.tries ?? 0) + 1) > 40) return `couldn't get to the ${nm(w, t.kind)}`;
        return stepToward(w, a, t.px, t.py, reachOf(t)) === "stuck" ? `couldn't get to the ${nm(w, t.kind)}` : "wait";
      }
    }
    if (act.target?.animal) {
      const prey = w.animals.find((m) => m.id === act.target!.animal);
      if (!prey) return "the animal was gone";
      if (prey.alt > 2 || meters(a, prey) > REACH + 0.5 + long) {
        a.status = `Chasing the ${prey.species}`;
        if ((s.tries = (s.tries ?? 0) + 1) > 60 || prey.alt > 2) return `the ${prey.species} got away`;
        // Catching up and swinging happen in the same moment, or a fleeing animal is always a stride ahead.
        if (stepToward(w, a, prey.px, prey.py, REACH + long, true) !== "arrived") return "wait";
      }
      if (prey.species === "deer") prey.state = "flee";
      if (prey.species === "wolf") prey.target = a.id;
    }
    if (fumbles(w, a)) return "wait";
    a.status = actText(w, act);
    const r = strikeTick(w, a, act, s);
    if (r.broke) log(w, "break", [a.id], a, `${a.name}: ${r.broke}`);
    return r.done ? r.out! : "wait";
  }
  if (act.verb === "rub") {
    if (fumbles(w, a)) return "wait";
    a.status = actText(w, act);
    const r = rubTick(w, a, act, s);
    return r.done ? r.out! : "wait";
  }
  if (act.verb === "dig") {
    if (fumbles(w, a)) return "wait";
    a.status = actText(w, act);
    const r = digTick(w, a, act, s);
    return r.done ? r.out! : "wait";
  }
  if (act.verb === "throw") {
    const prey = w.animals.find((m) => m.id === act.target?.animal) ?? nearest(a, w.animals, (m) => m.species === act.target?.kind && m.alt < 2);
    if (!prey || meters(a, prey) > 250) return `the ${act.target?.kind} got away`;
    act.target = { ...act.target, animal: prey.id };
    if (meters(a, prey) > 20) {
      a.status = `Stalking the ${prey.species}`;
      if ((s.tries = (s.tries ?? 0) + 1) > 80) return `the ${prey.species} got away`;
      stepToward(w, a, prey.px, prey.py, 16);
      return "wait";
    }
    if (fumbles(w, a)) return "wait";
    a.status = actText(w, act);
    const r = throwTick(w, a, act, s);
    return r.done ? r.out! : "wait";
  }
  if (act.at && act.at !== "home" && !(act.at === "water" ? openWater(w, a) : within(w, a, act.at, 1))) return `not at the ${act.at}`;
  if (act.verb !== "eat" && fumbles(w, a)) return "wait";
  a.status = actText(w, act);
  if ((s.progress += 1 + level(a.skills[SKILL[act.verb](act, w)] ?? 0) * 0.1) < (DURATION[act.verb] ?? 4)) return "wait";
  switch (act.verb) {
    case "join": case "heat": {
      const res = act.verb === "join" ? join(w, a, act) : heat(w, a, act);
      if (res !== "ask") return res;
      if (act.items.some((k) => depth(w.kinds, w.kinds[k]) >= 2)) return applyRuling(w, a, act, rulingKey(act), { useful: false, name: "", props: {} });
      const key = rulingKey(act);
      const cached = w.rulings[key];
      if (cached) return applyRuling(w, a, act, key, cached);
      if (pendingRulings.has(key)) return "wait";
      const hourly = w.jev.rulings - (rulingsAt.get(Math.floor(w.t / 12)) ?? w.jev.rulings);
      if (!rulingsAt.has(Math.floor(w.t / 12))) rulingsAt.set(Math.floor(w.t / 12), w.jev.rulings);
      if (hourly >= 6) return applyRuling(w, a, act, key, { useful: false, name: "", props: {} });
      pendingRulings.add(key);
      const parts = act.items.map((k) => w.kinds[k]).filter(Boolean);
      const uniq = [...new Set(parts.map((k) => (k.parts ? noun(k) : k.name)))];
      const soft = parts.find((k) => p(k, "plastic") >= 0.5 || p(k, "fibrous") >= 0.6);
      const rest = [...new Set(parts.filter((k) => k !== soft).map((k) => (k.parts ? noun(k) : k.name)))];
      const template = act.verb === "join"
        ? soft && rest.length ? `${rest.join(" and ")} ${p(soft, "plastic") >= 0.5 ? "pressed into" : "wrapped in"} ${soft.parts ? noun(soft) : soft.name}` : uniq.length === 1 ? `bundle of ${plural(uniq[0])}` : `${uniq[0]} wedged into ${uniq.slice(1).join(" and ")}`
        : `fire-hardened ${uniq.join(" and ")}`;
      rule(w, a, actText(w, act), parts, template)
        .then((r) => { w.rulings[key] = r; trace("physics", "ruling", { key, ruling: r }, a.id); })
        .catch((e) => { trace("brain", "error", { error: String(e), key }, a.id); })
        .finally(() => pendingRulings.delete(key));
      a.status = "Puzzling over what happened";
      return "wait";
    }
    case "wet": return wet(w, a, act);
    case "shape": return shape(w, a, act);
    case "place": return placeItems(w, a, act);
    case "plant": return plant(w, a, act);
    case "wear": return wearIt(w, a, act);
    case "eat": return eat(w, a, act.items[0]);
  }
  return "nothing to do";
}
const rulingsAt = new Map<number, number>();

// Everything that follows from an act finishing: beliefs, watchers, the chronicle, skills, names.
function finishAct(w: World, a: Agent, s: Step, out: Outcome, tinkering: boolean) {
  const act = s.act!;
  const ticks = Math.max(1, w.t - (s.started ?? w.t));
  trace("physics", "outcome", { act: actSig(act), ok: out.ok, text: out.text, uses: out.uses, gives: out.gives, builds: out.builds, effect: out.effect, numbers: out.numbers, ticks }, a.id);
  const b = record(w, a, out, ticks);
  if (tinkering && !b) a.tried[actSig(act)] = (a.tried[actSig(act)] ?? 0) + 1;
  watchers(w, a, out, ticks);
  const kind = out.builds === "fire" ? "fire" : out.builds === "shelter" || out.builds === "hearth" ? "build" : act.target?.animal && out.ok ? "hunt" : out.ok ? "craft" : "tinker";
  log(w, kind, [a.id], a, `${a.name}: ${out.text}`);
  if (out.ok) gain(w, a, SKILL[act.verb](act, w), tinkering ? 3 : 5);
  if (act.verb === "strike") gain(w, a, "toolwork", 1);
  if (out.ok && act.verb === "strike" && act.target?.kind && THING_MATERIAL[act.target.kind]) {
    const breaks = THING_MATERIAL[act.target.kind].breaks;
    see(w, a, `breaks:${act.target.kind}`, `A ${act.target.kind} breaks down into ${Object.keys(breaks).map((k) => nm(w, k)).join(", ")}.`);
  }
  // Bringing down the last deer anywhere near is something the neighbors notice.
  if (out.ok && act.target?.kind === "deer" && !w.animals.some((m) => m.species === "deer" && meters(m, a) <= 500))
    incident(w, { act: "last_deer", by: a, at: a, text: `${a.name} killed the last deer anywhere near.`, value: 0.6, seenBy: w.agents.filter((b) => canSee(w, b, a, VISION)) });
  if (out.ok) for (const k of new Set([act.tool, ...act.items].filter(Boolean) as string[])) noteUse(w, k, act, out);
  for (const k of Object.keys(out.gives)) {
    const kind = w.kinds[k];
    if (!kind?.made) continue;
    kind.count = (kind.count ?? 0) + 1;
    if (kind.count >= 3 && !kind.named && !namingNow.has(k)) {
      namingNow.add(k);
      // What people actually do with it matters more to what they call it than what it's made of.
      const uses = [...new Set(w.agents.flatMap((x) => Object.values(x.beliefs))
        .filter((b) => b.fields.tool === k || b.fields.inputs.includes(k))
        .map((b) => sentence(w, b.fields, b.ticks)))].slice(0, 6);
      nameIt(w, a, kind, uses).then((word) => {
        kind.named = true;
        // Two different things can share a word; tell them apart by what they're made of.
        const taken = word && Object.values(w.kinds).some((x) => x.id !== k && x.name === word);
        const head = kind.parts?.map((id) => w.kinds[id]).find((x) => x && !x.parts)?.name.split(" ").at(-1);
        const name = taken && head ? `${head} ${word}` : word;
        if (name && name !== kind.name) {
          kind.plain = kind.name;
          log(w, "named", [a.id], a, `People have started calling the ${kind.name} ${an(name)}.`, name);
          kind.name = name;
          changedKinds.add(k);
        }
      }).catch(() => {}).finally(() => namingNow.delete(k));
    }
  }
}
export const changedKinds = new Set<string>();

// What a thing was just used for, in a few words.
function usePhrase(k: string, act: Act, out: Outcome): string | null {
  const t = act.target?.kind ?? "";
  if (act.verb === "strike" && act.tool === k) {
    if (out.builds === "fire") return "striking sparks";
    const world: Record<string, string> = { tree: "felling trees", stump: "clearing stumps", bush: "clearing brush", dead_bush: "clearing brush", boulder: "breaking rock", reeds: "cutting reeds", deer: "hunting deer", wolf: "fighting wolves" };
    if (world[t]) return world[t];
    if (t === "log") return "splitting logs";
    if (t === "stone" || t === "bone") return `chipping ${t}`;
    return null;
  }
  if (act.verb === "dig" && act.tool === k) return "digging";
  if (act.verb === "throw") return `throwing at ${t}`;
  if (act.verb === "strike" && act.tool === k && t.startsWith("hot:")) return "forging metal";
  if (act.verb === "heat" && act.tool === k) return "blowing air into fires";
  if (act.verb === "rub" && out.builds === "fire") return "making fire";
  if (act.verb === "rub" && Object.keys(out.gives).length) return "grinding points";
  if (act.verb === "wet" && out.gives.fish) return "fishing";
  if (act.verb === "heat" && Object.keys(out.gives).some((g) => g.startsWith("stew:"))) return "cooking stew";
  if (act.verb === "wear") return "keeping warm";
  if (act.verb === "place" && out.builds === "fire") return "starting fires";
  return null;
}
// Until people settle on a word, a made thing is called by what it is and what it's for.
function noteUse(w: World, k: string, act: Act, out: Outcome) {
  const kind = w.kinds[k];
  const phrase = kind?.made && !kind.named ? usePhrase(k, act, out) : null;
  if (!phrase) return;
  kind.uses ??= {};
  kind.uses[phrase] = (kind.uses[phrase] ?? 0) + 1;
  kind.desc ??= kind.name;
  const top = Object.entries(kind.uses).sort((x, y) => y[1] - x[1])[0][0];
  const name = `${kind.desc} for ${top}`;
  if (name !== kind.name) { kind.name = name; changedKinds.add(k); }
}

// ---------- tinkering ----------
type Option = { text: string; act: Act };
const AIM: Record<string, (act: Act) => boolean> = {
  shelter: (act) => act.verb === "place" || act.verb === "dig" || (act.verb === "join" && act.items.length >= 2),
  fire: (act) => act.verb === "rub" || act.verb === "heat" || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]) || act.verb === "place",
  tool: (act) => act.verb === "join" || act.verb === "rub" || act.verb === "shape" || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]),
  food: (act) => act.verb === "throw" || act.verb === "wet" || act.verb === "plant" || act.verb === "heat" || (act.verb === "strike" && ["deer", "wolf", "rabbit", "bush"].includes(act.target?.kind ?? "")),
};
function tinkerOptions(w: World, a: Agent, aim?: string): Option[] {
  const c = counts(a);
  const held = Object.keys(c).filter((k) => !k.startsWith("rotten:"));
  const opts: Option[] = [];
  const push = (act: Act) => { if ((a.tried[actSig(act)] ?? 0) < 2) opts.push({ text: actText(w, act), act }); };
  // Soft things like berries or fiber don't get swung, dug with, or ground against anything.
  const tools = [null, ...held.filter((k) => p(w.kinds[k], "hard") >= 0.2 || p(w.kinds[k], "heavy") >= 0.3)];
  // What's lying or growing within a stone's throw that they could walk over to and strike.
  const targets: string[] = [];
  around(w, a.px, a.py, 20, STRIKEABLE, (t) => { if (!t.burning) targets.push(t.kind); });
  const animalsNear = w.animals.filter((m) => meters(a, m) <= 60 && m.alt < 2 && THING_MATERIAL[m.species]).map((m) => m.species);
  for (const kind of new Set([...targets, ...animalsNear])) for (const tool of tools) push({ verb: "strike", items: [], tool, target: { kind } });
  for (const sp of new Set(w.animals.filter((m) => meters(a, m) <= 120 && m.alt < 2 && THING_MATERIAL[m.species]).map((m) => m.species)))
    for (const x of held) if (p(w.kinds[x], "heavy") >= 0.3 || p(w.kinds[x], "sharp") >= 0.4) push({ verb: "throw", items: [x], target: { kind: sp } });
  if (diggable(w, ...beside(w, a, 1)))
    for (const tool of tools) push({ verb: "dig", items: [], tool });
  for (const x of held) {
    const k = w.kinds[x];
    for (const tool of tools) if (tool !== x || c[x] >= 2) push({ verb: "strike", items: [], tool, target: { kind: x } });
    if (within(w, a, "fire", 1)) {
      push({ verb: "heat", items: [x], at: "fire" });
      // Something soft and hollow can be squeezed or flapped at the flames while something else heats.
      for (const f of held) if (f !== x && airy(w.kinds[f])) push({ verb: "heat", items: [x], tool: f, at: "fire" });
    }
    if (openWater(w, a)) push({ verb: "wet", items: [x], at: "water" });
    if (p(k, "plastic") >= 0.6) { push({ verb: "shape", items: [x], shape: "bowl" }); push({ verb: "shape", items: [x], shape: "block" }); }
    if (p(k, "seed") > 0 || p(k, "edible") > 0) push({ verb: "plant", items: [x] });
    if (p(k, "flexible") >= 0.4) push({ verb: "wear", items: [x] });
    push({ verb: "place", items: Array(Math.min(c[x], 6)).fill(x) });
  }
  for (let i = 0; i < held.length; i++)
    for (let j = i; j < held.length; j++) {
      const [x, y] = [held[i], held[j]];
      if (x === y && c[x] < 2) continue;
      if ([x, y].every((k) => p(w.kinds[k], "hard") >= 0.2 || p(w.kinds[k], "flammable") >= 0.5) || greasy(w.kinds[x]) || greasy(w.kinds[y])) push({ verb: "rub", items: [x, y] });
      push({ verb: "join", items: [x, y] });
      if (x !== y) push({ verb: "place", items: [...Array(Math.min(c[x], 5)).fill(x), ...Array(Math.min(c[y], 3)).fill(y)] });
      if (within(w, a, "fire", 1) && x !== y) push({ verb: "heat", items: [x, y], at: "fire" });
      for (let k = j; k < held.length; k++) {
        const z = held[k];
        const need = [x, y, z].reduce<Record<string, number>>((m, q) => ((m[q] = (m[q] ?? 0) + 1), m), {});
        if (Object.entries(need).some(([q, n]) => c[q] < n)) continue;
        push({ verb: "join", items: [x, y, z] });
      }
    }
  // ponytail: random cap to stay under Jev's 255 options and keep the prompt small.
  const aimed = aim && AIM[aim] ? opts.filter((o) => AIM[aim](o.act)) : opts;
  return (aimed.length ? aimed : opts).sort(() => Math.random() - 0.5).slice(0, 100);
}
const tinkerWait = new Set<string>();

// ---------- running plan steps ----------
const GATHER_STATUS: Record<string, string> = {
  pick_berries: "Picking berries", pick_mushroom: "Gathering a mushroom", pick_herb: "Picking herbs", pick_stick: "Picking up a stick",
  pick_stone: "Picking up a stone", pull_reeds: "Pulling up reeds", dig_clay: "Digging clay", scrape_resin: "Scraping resin off a tree",
};
function bestFood(w: World, a: Agent) {
  const ctx = { kinds: w.kinds, toxic: ctxFor(w, a).toxic } as Ctx;
  const ok = new Set(edibleKinds(ctx));
  return [...new Set(a.inv.map((s) => s.k))].filter((k) => ok.has(k)).sort((x, y) => p(w.kinds[y], "edible") - p(w.kinds[x], "edible"))[0] ?? null;
}
const bestWeapon = (w: World, a: Agent) =>
  [...new Set(a.inv.map((s) => s.k))].map((k) => w.kinds[k]).filter((k) => p(k, "edible") < 0.1 && (p(k, "sharp") > 0 || p(k, "heavy") > 0.4))
    .sort((x, y) => strikeDamage(y, 0.15) - strikeDamage(x, 0.15))[0] ?? null;

function run(w: World, a: Agent): boolean | string {
  const s = a.plan[0];
  s.started ??= w.t;
  switch (s.op) {
    case "goto": {
      const t = spot(w, a, s.arg!);
      if (!t) return `couldn't find ${s.arg}`;
      if (t.agent && t.agent.down > w.t) return `${t.agent.name} was unconscious`;
      a.status = stepLabel(w, a, s).replace(/^Go to/, "Walking to");
      const r = stepToward(w, a, t.px, t.py, t.reach);
      return r === "stuck" ? "no path" : r === "arrived";
    }
    case "wander": {
      const [x, y] = s.arg!.split(",").map(Number);
      a.status = "Exploring";
      const r = stepToward(w, a, x, y, 2);
      return r === "stuck" ? "no path" : r === "arrived";
    }
    case "avoid": {
      const b = agentById(w, s.arg);
      if (!b || meters(a, b) >= 100 || s.progress++ > 40) return true;
      a.status = `Keeping away from ${b.name}`;
      stepAway(w, a, b);
      return false;
    }
    case "flee": {
      const wolf = w.animals.find((m) => m.species === "wolf" && m.target === a.id) ?? nearest(a, w.animals, (m) => m.species === "wolf");
      const burning = nearest(a, liveThings(w), (t) => !!t.burning);
      const danger = wolf && meters(a, wolf) < 40 ? wolf : burning && meters(a, burning) < 10 ? burning : null;
      if (!danger || s.progress++ > 20) return true;
      a.status = wolf === danger ? "Running from a wolf" : "Running from the fire";
      const safe = nearest(a, w.agents, (b) => b !== a && b.down <= w.t) ?? nearest(a, liveThings(w), (t) => t.kind === "fire");
      if (wolf === danger && safe && meters(a, safe) < 100) stepToward(w, a, safe.px, safe.py, 2, true);
      else stepAway(w, a, danger);
      return false;
    }
    case "fight": {
      const wolf = w.animals.find((m) => m.species === "wolf" && (m.target === (s.arg ?? a.id) || meters(m, a) <= 20));
      if (!wolf || s.progress++ > 40 || a.needs.health < 20) {
        if (s.arg && s.arg !== a.id && !wolf) defended(w, a, s.arg);
        return true;
      }
      const weapon = bestWeapon(w, a);
      s.act ??= { verb: "strike", items: [], tool: weapon?.id ?? null, target: { kind: "wolf", animal: wolf.id } };
      s.act.target!.animal = wolf.id;
      const r = doAct(w, a, s);
      if (typeof r === "object") { finishAct(w, a, s, r, false); if (s.arg && s.arg !== a.id) defended(w, a, s.arg); return true; }
      a.status = "Fighting a wolf";
      return false;
    }
    case "stash": {
      const n = stash(w, a);
      if (n) log(w, "store", [a.id], a, `${a.name} put ${n} things away at home.`);
      return true;
    }
    case "take_stored": {
      const home = homeOf(w, a);
      if (!home || !reaches(a, home)) return "wasn't home";
      const n = unstash(w, a, home, s.arg!, 3);
      return n ? true : "it wasn't there anymore";
    }
    case "share": {
      const n = share(w, a);
      return n ? true : "had nothing spare to share";
    }
    case "take_shared": {
      const n = takeShared(w, a, s.arg!);
      return n ? true : "the store didn't have it anymore";
    }
    case "raid": {
      const home = thingById(w, s.arg);
      if (!home?.store?.length) return "there was nothing there";
      const owner = agentById(w, home.owner);
      if (!reaches(a, home)) { a.status = "Creeping toward someone's home"; return stepToward(w, a, home.px, home.py, reachOf(home)) === "stuck" ? "no path" : false; }
      const took: string[] = [];
      for (let i = 0; i < 3 && home.store.length && a.inv.length < 16; i++) { const st = home.store.pop()!; a.inv.push(st); took.push(st.k); }
      mark(w, home);
      const seen = w.agents.filter((b) => b !== a && canSee(w, b, a, 30));
      const text = `${a.name} took ${took.map((k) => nm(w, k)).join(", ")} from ${owner ? `${owner.name}'s` : "an empty"} home.`;
      if (!seen.length) { log(w, "steal", [a.id], a, `${text} No one saw.`); return true; }
      log(w, "steal", [a.id, ...seen.map((b) => b.id)], a, `${text} ${seen.map((b) => b.name).join(" and ")} saw it happen.`);
      for (const b of seen) reflect(w, b, a, `I saw ${text}`).catch(() => {});
      if (owner && !seen.includes(owner)) { owner.rel[a.id] ??= newRel(w.t); owner.rel[a.id].history.push(`${clock(w.t)}: Heard ${text}`); }
      incident(w, { act: "raid", by: a, against: owner, at: home, text, value: took.reduce((t, k) => t + valueOf(w, k), 0), seenBy: seen, items: took });
      return true;
    }
    case "tend": {
      const b = agentById(w, s.arg);
      if (!b) return "they were gone";
      if (b.down <= w.t || s.progress++ > 60) {
        if (s.progress > 5) {
          const text = `${a.name} stayed with ${b.name} while they lay collapsed, and kept them alive.`;
          log(w, "help", [a.id, b.id], a, text);
          incident(w, { act: "tend", by: a, against: b, at: b, text, value: 0.5, seenBy: [b, ...w.agents.filter((c) => c !== a && canSee(w, c, a, VISION))] });
          reflect(w, b, a, text).then((r) => { if (r.bond !== "none") log(w, "bond", [b.id], b, `${b.name} will remember this about ${a.name}: ${r.bond.replaceAll("_", " ")}.`); }).catch(() => {});
        }
        return true;
      }
      if (meters(a, b) > 2) { stepToward(w, a, b.px, b.py, 1.5); return false; }
      a.status = `Looking after ${b.name}`;
      // Warmth from a body beside them, and a little food pressed into their hands.
      b.needs.warmth = Math.min(100, b.needs.warmth + 0.6);
      b.needs.health = Math.min(100, b.needs.health + 0.3);
      const f = bestFood(w, a);
      if (f && b.needs.food < 40 && s.progress % 10 === 1) { takeItems(a, f); b.needs.food = Math.min(100, b.needs.food + p(w.kinds[f], "edible") * 100); }
      if (b.needs.health > 50 && b.needs.food > 25 && b.needs.warmth > 25) b.down = w.t;
      return false;
    }
    case "follow": {
      const b = agentById(w, s.arg);
      if (!b || s.progress++ > 40) return true;
      a.status = `Staying close to ${b.name}`;
      stepToward(w, a, b.px, b.py, 3);
      return false;
    }
    case "hunt": {
      const prey = nearest(a, w.animals, (m) => m.species === s.arg);
      if (!prey && !s.act) return `there were no ${s.arg} about`;
      const weapon = bestWeapon(w, a);
      s.act ??= { verb: "strike", items: [], tool: weapon?.id ?? null, target: { kind: s.arg } };
      const r = doAct(w, a, s);
      if (r === "wait") return false;
      if (typeof r === "string") return r;
      finishAct(w, a, s, r, false);
      return r.ok ? true : r.text;
    }
    case "rest": {
      const home = within(w, a, "home")?.thing;
      const kind = home ? ["pile", "lean-to", "hut", "cabin"][home.shelter?.tier ?? 0] : null;
      const here = lightOn(w, a).bright, target = isNight(w.t) ? 98 : 85;
      a.status = isNight(w.t) ? (kind ? `Sleeping in the ${kind}` : "Sleeping on the ground") : kind ? `Resting in the ${kind}` : "Resting";
      // Nothing left to sleep off: in the dark they sit it out, rather than start over every tick.
      if (a.needs.energy >= target) {
        if (here >= DARK) return true;
        a.status = nearFire(w, a, 12) ? "Sitting by the fire" : "Waiting out the dark";
        return s.progress++ >= 12;
      }
      a.needs.energy = Math.min(100, a.needs.energy + 0.7 * (1 + (home?.shelter?.tier ?? 0) * 0.35) * restRate(here));
      return a.needs.energy >= target;
    }
    case "warm_up": {
      a.status = "Warming up";
      if (!within(w, a, "fire", 1) && !within(w, a, "home")) return "the warmth was gone";
      a.needs.warmth = Math.min(100, a.needs.warmth + 0.6);
      // Warm and by the fire at night, there is nowhere better to be: they stay a while.
      if (a.needs.warmth < 95) return false;
      if (isNight(w.t) && s.progress++ < 12) { a.status = "Sitting by the fire"; return false; }
      return true;
    }
    case "eat": {
      const k = bestFood(w, a);
      if (!k) return "nothing to eat";
      s.act = { verb: "eat", items: [k] };
      const out = eat(w, a, k);
      if (out.effect) { finishAct(w, a, s, out, false); if (out.effect === "sick") see(w, a, `sick:${k}`, `${cap(nm(w, k))} can make you sick.`, 50); }
      else log(w, "eat", [a.id], a, `${a.name} ate ${an(nm(w, k))}.`);
      return true;
    }
    case "pick_up": {
      const t = within(w, a, `item:${s.arg}`, 0.5)?.thing;
      if (!t) return "it was gone";
      const n = Math.min(t.n ?? 1, 3);
      t.n = (t.n ?? 1) - n;
      if (t.n <= 0) removeThing(w, t); else mark(w, t);
      const got = giveItems(w, a, t.item!, n);
      if (!got) return "their hands were full";
      const word = nm(w, t.item!);
      log(w, "gather", [a.id], a, `${a.name} picked up ${got > 1 ? `${got} ${plural(word)}` : an(word)}.`);
      return true;
    }
    case "assist": {
      const b = agentById(w, s.arg);
      if (!b || !b.goal || s.progress++ > 30) return true;
      a.status = `Helping ${b.name}`;
      const theirs = b.plan[0];
      if (stepToward(w, a, b.px, b.py, 3) === "arrived" && theirs && (theirs.op === "act" || GATHER[theirs.op])) theirs.progress += 1;
      return false;
    }
    case "act": {
      const b = a.beliefs[s.key ?? ""];
      if (!b) return "forgot how";
      s.act ??= actFromBelief(b);
      const r = doAct(w, a, s);
      if (r === "wait") return false;
      if (typeof r === "string") return r;
      finishAct(w, a, s, r, false);
      return r.ok ? true : r.text;
    }
    case "tinker": {
      if (s.act) {
        const r = doAct(w, a, s);
        if (r === "wait") return false;
        if (typeof r === "string") { a.tried[actSig(s.act)] = (a.tried[actSig(s.act)] ?? 0) + 1; log(w, "tinker", [a.id], a, `${a.name} tried to ${actText(w, s.act).toLowerCase()}, but ${r}.`); return true; }
        finishAct(w, a, s, r, true);
        return true;
      }
      if (tinkerWait.has(a.id)) return false;
      const options = tinkerOptions(w, a, s.arg);
      if (!options.length) return "had nothing to try";
      tinkerWait.add(a.id);
      a.status = "Turning things over in their hands";
      chooseTinker(w, a, options.map((o) => o.text))
        .then((text) => {
          const o = options.find((x) => x.text === text)!;
          s.act = structuredClone(o.act);
          s.started = w.t;
          trace("brain", "tinker_choice", { chose: text, from: options.length }, a.id);
        })
        .catch((e) => { trace("brain", "error", { error: String(e) }, a.id); a.plan = []; })
        .finally(() => tinkerWait.delete(a.id));
      return false;
    }
    case "social": {
      const b = agentById(w, a.goal?.target);
      if (!b) return "they weren't around";
      if (s.progress === 0) {
        if (b.engaged || b.down > w.t) return false;
        if (meters(a, b) > 2.5) { a.plan.unshift({ op: "goto", arg: "agent", progress: 0 }); return false; }
        s.progress = 1;
        a.engaged = b.id;
        b.engaged = a.id;
        a.status = `With ${b.name}`;
        b.status = `With ${a.name}`;
        interact(w, a, b, s.arg!).catch((e) => { console.error(`interact ${a.name}->${b.name}:`, e); trace("social", "error", { error: String(e) }, a.id); })
          .finally(() => { a.engaged = null; b.engaged = null; s.progress = 2; });
        return false;
      }
      return s.progress === 2;
    }
  }
  const g = GATHER[s.op];
  if (!g) return true;
  const b = lightOn(w, a).bright;
  a.status = GATHER_STATUS[s.op] + (b < DARK ? " in the dark" : "");
  if ((s.progress += (1 + level(a.skills.foraging ?? 0) * 0.1) * workRate(b)) < 2.5) return false;
  const t = within(w, a, g.place, 0.5)?.thing;
  if (!t) return `the ${g.place} was gone`;
  let n = g.n;
  if (t.kind === "bush") {
    n = Math.min(t.n!, 2 + Math.floor(level(a.skills.foraging ?? 0) / 4));
    t.n! -= n;
    t.hp = (t.hp ?? 20) - 3;
    mark(w, t);
  } else if (t.kind === "reeds") {
    t.hp = (t.hp ?? 6) - 3;
    if (t.hp <= 0) removeThing(w, t); else mark(w, t);
  } else if (g.place === "resin") {
    t.resin = Math.max(0, (t.resin ?? 1) - 1);
    mark(w, t);
  } else if (t.kind === "clay") {
    if (Math.random() < 0.25) removeThing(w, t);
  } else removeThing(w, t);
  giveItems(w, a, g.item, n);
  // what is carried off a plant is taken from the soil it grew on
  if (t.kind === "bush" || t.kind === "mushroom" || t.kind === "herb" || t.kind === "reeds") enrich(w, t.px, t.py, -0.004 * n);
  if (t.kind === "bush" || t.kind === "mushroom" || t.kind === "herb") gain(w, a, "foraging", 2);
  log(w, "gather", [a.id], a, `${a.name} gathered ${n > 1 ? `${n} ${plural(nm(w, g.item))}` : an(nm(w, g.item))}.`);
  return true;
}

// ---------- people ----------
const gifts = (w: World, a: Agent) => [...new Set(a.inv.map((s) => s.k))].map((k) => w.kinds[k]).filter((k) => k && !isTool(k));
const pickGift = (w: World, a: Agent) => gifts(w, a).sort((x, y) => p(y, "edible") - p(x, "edible"))[0]?.id ?? null;
const most = (w: World, a: Agent, except?: string) => {
  const c = counts(a);
  return Object.keys(c).filter((k) => k !== except && !isTool(w.kinds[k])).sort((x, y) => c[y] - c[x])[0] ?? null;
};
function defended(w: World, defender: Agent, victimId: string) {
  const v = agentById(w, victimId);
  if (!v || v === defender) return;
  const text = `${defender.name} fought off a wolf that was attacking ${v.name}.`;
  log(w, "defend", [defender.id, v.id], v, text);
  reflect(w, v, defender, text).then((r) => {
    if (r.bond !== "none") log(w, "bond", [v.id], v, `${v.name} will remember this about ${defender.name}: ${r.bond.replaceAll("_", " ")}.`);
  }).catch(() => {});
}

async function interact(w: World, a: Agent, b: Agent, kind: string) {
  const ra = (a.rel[b.id] ??= newRel(w.t));
  (b.rel[a.id] ??= newRel(w.t));
  const first = ra.history.length === 0 && b.rel[a.id].history.length === 0;
  let text = "";
  // What the camp gets to see: an act that landed on someone, and whether the two of them warmed to each other or not.
  let deed: { act: string; value: number; items?: string[]; by?: Agent; against?: Agent } | null = null;
  let warm = false, turnedAway = false;
  const reply = (situation: string, opts: Record<string, string>) => respond(w, b, a, situation, opts);
  const trait = (x: Agent, t: string) => x.traits[t] ?? 0;
  const bystanders = () => w.agents.filter((c) => c !== a && c !== b && c.down <= w.t && canSee(w, c, a, 30));
  switch (kind) {
    case "talk": {
      const r = await reply(`${a.name} walks up to ${b.name} to talk.`, { welcome: "Chat warmly", brush_off: "Brush them off" });
      if (r === "welcome") {
        a.needs.social = Math.min(100, a.needs.social + 20);
        b.needs.social = Math.min(100, b.needs.social + 20);
        gain(w, a, "charm", 3);
        const story = a.memory.filter((m) => !m.includes(b.name)).at(-1 - Math.floor(Math.random() * 3));
        if (story) gain(w, a, "storytelling", 2);
        // Talking passes on what you've seen of the world, and the customs you've heard spoken.
        for (const [k, v] of Object.entries(a.facts)) if (!b.facts[k] && Math.random() < 0.5) b.facts[k] = v;
        spread(w, a, b); spread(w, b, a);
        warm = true;
        text = `${a.name} and ${b.name}${first ? " met for the first time and" : ""} talked for a while.${story ? ` ${a.name} told ${b.name} about this: "${story.replace(/^Day \d+, \w+: /, "")}"` : ""}`;
      } else { turnedAway = true; text = `${a.name} tried to talk to ${b.name}, but ${b.name} brushed them off.`; }
      break;
    }
    case "give": {
      const item = pickGift(w, a);
      if (!item) return;
      const n = Math.min(count(a, item), item === "berry" ? 2 : 1);
      const r = await reply(`${a.name} offers ${b.name} ${n} ${nm(w, item)} as a gift.`, { accept: "Accept the gift", refuse: "Refuse it" });
      if (r === "accept") {
        takeItems(a, item, n); giveItems(w, b, item, n);
        b.rel[a.id].ledger++; ra.ledger--;
        warm = true;
        deed = { act: "give", value: valueOf(w, item) * n, items: Array(n).fill(item) };
        text = `${a.name} gave ${b.name} ${n} ${nm(w, item)}.${b.needs.food < 25 && p(w.kinds[item], "edible") ? ` ${b.name} was starving.` : ""}`;
      } else { turnedAway = true; text = `${b.name} refused ${a.name}'s gift of ${nm(w, item)}.`; }
      break;
    }
    case "trade": {
      const give = most(w, a), want = most(w, b, give ?? undefined);
      if (!give || !want) return;
      gain(w, a, "bargaining", 2);
      const r = await reply(`${a.name} offers ${b.name} 1 ${nm(w, give)} in exchange for 1 ${nm(w, want)}.`, { accept: "Make the trade", refuse: "Turn it down" });
      if (r === "accept") {
        takeItems(a, give); giveItems(w, b, give); takeItems(b, want); giveItems(w, a, want);
        gain(w, a, "bargaining", 3);
        warm = true;
        text = `${a.name} traded 1 ${nm(w, give)} to ${b.name} for 1 ${nm(w, want)}.`;
      } else { turnedAway = true; text = `${b.name} turned down ${a.name}'s offer to trade ${nm(w, give)} for ${nm(w, want)}.`; }
      break;
    }
    case "share_meal": {
      const f = bestFood(w, a);
      if (!f) return;
      const r = await reply(`${a.name} invites ${b.name} to share some food and eat together.`, { join: "Eat together", decline: "Decline" });
      if (r === "join") {
        takeItems(a, f);
        b.needs.food = Math.min(100, b.needs.food + p(w.kinds[f], "edible") * 100);
        const g = bestFood(w, a);
        if (g) { takeItems(a, g); a.needs.food = Math.min(100, a.needs.food + p(w.kinds[g], "edible") * 100); }
        a.needs.social = Math.min(100, a.needs.social + 25);
        b.needs.social = Math.min(100, b.needs.social + 25);
        b.rel[a.id].ledger++; ra.ledger--;
        warm = true;
        deed = { act: "share", value: valueOf(w, f), items: [f] };
        text = `${a.name} shared ${an(nm(w, f))} with ${b.name} and they ate together.`;
      } else { turnedAway = true; text = `${b.name} declined ${a.name}'s offer to eat together.`; }
      break;
    }
    case "share_fire": {
      if (!spot(w, a, "fire")) return;
      const r = await reply(`${a.name} invites ${b.name} to come sit by the fire together.`, { join: "Go sit by the fire", decline: "Decline" });
      if (r === "join") {
        for (const x of [a, b]) {
          x.goal = { type: "warm_up", since: w.t, odds: {}, fails: 0 };
          x.plan = [{ op: "goto", arg: "fire", progress: 0 }, { op: "warm_up", progress: 0 }];
          x.needs.social = Math.min(100, x.needs.social + 15);
        }
        warm = true;
        deed = { act: "share", value: 0.2 };
        text = `${a.name} and ${b.name} sat by the fire together.`;
      } else { turnedAway = true; text = `${b.name} declined ${a.name}'s invitation to sit by the fire.`; }
      break;
    }
    case "help": {
      const what = b.goal ? lower(goalText(w, b.goal.type, b.goal.target)) : "their work";
      const r = await reply(`${a.name} offers to help ${b.name} ${what}.`, { accept: "Accept the help", decline: "Say no thanks" });
      if (r === "accept") {
        a.goal = { type: "help", target: b.id, since: w.t, odds: a.goal?.odds ?? {}, fails: 0 };
        a.plan = [{ op: "assist", arg: b.id, progress: 0 }];
        b.rel[a.id].ledger++; ra.ledger--;
        warm = true;
        text = `${a.name} started helping ${b.name} ${what}.`;
      } else { turnedAway = true; text = `${b.name} turned down ${a.name}'s offer to help.`; }
      break;
    }
    case "teach": {
      const options = Object.keys(a.beliefs).filter((k) => !b.beliefs[k] && a.beliefs[k].wins > 0);
      if (!options.length) return;
      const key = options[Math.floor(Math.random() * options.length)];
      const what = sentence(w, a.beliefs[key].fields).replace(/\.$/, "");
      const ans = await reply(`${a.name} offers to show ${b.name} something they know: ${what}.`, { accept: "Learn from them", refuse: "Not interested" });
      if (ans === "accept") {
        teach(w, a, b, key);
        spread(w, a, b);
        gain(w, a, "teaching", 4);
        b.rel[a.id].ledger++; ra.ledger--;
        warm = true;
        deed = { act: "teach", value: 0.3 };
        text = `${a.name} showed ${b.name} that ${what.charAt(0).toLowerCase() + what.slice(1)}.${a.beliefs[key].spurious ? ` ${a.name} insisted you have to hold ${an(nm(w, a.beliefs[key].spurious!))} for it to work.` : ""}`;
      } else { turnedAway = true; text = `${b.name} wasn't interested when ${a.name} offered to show them something.`; }
      break;
    }
    case "beg": {
      const food = [...new Set(b.inv.map((s) => s.k))].filter((k) => p(w.kinds[k], "edible") >= 0.1).sort((x, y) => p(w.kinds[y], "edible") - p(w.kinds[x], "edible"))[0];
      if (!food) return;
      const r = await reply(`${a.name} asks ${b.name} for something to eat.${a.needs.food < 20 ? ` ${a.name} looks half starved.` : ""}`, { give: `Give ${a.name} some food`, refuse: "Refuse" });
      if (r === "give") {
        takeItems(b, food); giveItems(w, a, food);
        ra.ledger++; b.rel[a.id].ledger--;
        warm = true;
        deed = { act: "give", value: valueOf(w, food), items: [food], by: b, against: a };
        text = `${a.name} asked ${b.name} for food, and ${b.name} gave them ${an(nm(w, food))}.`;
      } else {
        turnedAway = true;
        deed = { act: "refused_food", value: Math.max(0.1, (50 - a.needs.food) / 50), by: b, against: a };
        text = `${a.name} asked ${b.name} for food, and ${b.name} refused${a.needs.food < 25 ? ", though they were starving" : ""}.`;
      }
      break;
    }
    case "gossip": {
      const others = w.agents.filter((c) => c !== a && c !== b && a.rel[c.id]);
      const c = others.sort((x, y) => Math.abs(a.rel[y.id].affinity) - Math.abs(a.rel[x.id].affinity))[0];
      if (!c) return;
      const rc = a.rel[c.id];
      const said = Object.entries(rc.beliefs).filter(([, v]) => v! > 0.65 || v! < 0.35).map(([k, v]) => (v! > 0.65 ? k : `not ${k}`));
      const opinion = `${a.name} says they ${rc.affinity > 0.2 ? "like" : rc.affinity < -0.2 ? "dislike" : "don't know what to make of"} ${c.name}${said.length ? `, and that ${c.name} is ${said.join(", ")}` : ""}.`;
      const lie = trait(a, "deceitful") && rc.affinity < 0 && Math.random() < trait(a, "deceitful");
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
        spread(w, a, b);
      }
      text = `${a.name} told ${b.name} what they think of ${c.name}: "${told}" ${b.name} ${r === "believe" ? "believed it" : "doubted it"}.`;
      if (lie) log(w, "lie", [a.id], a, `${a.name} lied to ${b.name} about ${c.name}.`);
      // A lie someone saw through is something done to the one it was about.
      if (lie && r === "doubt") deed = { act: "lie", value: 0.2, against: c };
      break;
    }
    case "insult": {
      const r = await reply(`${a.name} insults and mocks ${b.name}.`, { shrug: "Shrug it off", insult_back: "Insult them back", walk_away: "Walk away hurt" });
      b.needs.social = Math.max(0, b.needs.social - 10);
      deed = { act: "insult", value: 0.1 };
      text = `${a.name} insulted ${b.name}. ${b.name} ${r === "shrug" ? "shrugged it off" : r === "insult_back" ? "insulted them right back" : "walked away hurt"}.`;
      break;
    }
    case "attack": {
      const weapon = bestWeapon(w, a);
      const dmg = strikeDamage(weapon ?? { id: "hands", name: "fists", props: { hard: 0.2, heavy: 0.1 } }, 0.1, a) * 2;
      b.needs.health = Math.max(0, b.needs.health - dmg);
      const r = await reply(`${a.name} attacks ${b.name}${weapon ? ` with ${an(weapon.name)}` : ""}!`, { fight_back: "Fight back", flee: "Run away", submit: "Give up and cower" });
      if (r === "fight_back") {
        const theirs = bestWeapon(w, b);
        a.needs.health = Math.max(0, a.needs.health - strikeDamage(theirs ?? { id: "hands", name: "fists", props: { hard: 0.2, heavy: 0.1 } }, 0.1, b) * 2);
      } else if (r === "flee") { b.goal = { type: "flee", since: w.t, odds: {}, fails: 0 }; b.plan = [{ op: "avoid", arg: a.id, progress: 0 }]; }
      a.cooldowns.attack = w.t + DAY;
      deed = { act: "attack", value: dmg / 40 };
      text = `${a.name} attacked ${b.name}${weapon ? ` with ${an(weapon.name)}` : ""}. ${b.name} ${r === "fight_back" ? "fought back" : r === "flee" ? "ran away" : "cowered and took it"}.`;
      trace("social", "attack", { dmg, weapon: weapon?.id, force: weapon ? force(weapon, a) : 0, reply: r }, a.id);
      break;
    }
    case "take": case "steal": {
      const item = most(w, b) ?? b.inv[0]?.k;
      if (!item) return;
      const hidden = kind === "steal";
      const eyes = (x: Agent) => 0.35 + trait(x, "observant") * 0.4 + trait(x, "suspicious") * 0.2 - level(a.skills.pickpocketing ?? 0) * 0.05;
      const noticed = !hidden || Math.random() < eyes(b);
      takeItems(b, item); giveItems(w, a, item);
      if (hidden) gain(w, a, "pickpocketing", 4);
      deed = { act: kind, value: valueOf(w, item), items: [item] };
      if (!noticed) {
        const saw = bystanders().filter((c) => Math.random() < eyes(c) * 0.6);
        const quiet = `${a.name} secretly stole ${an(nm(w, item))} from ${b.name}. ${b.name} didn't notice`;
        if (!saw.length) { log(w, "steal", [a.id], a, `${quiet}.`); return; }
        text = `${quiet}, but ${saw.map((c) => c.name).join(" and ")} saw it.`;
        log(w, "steal", [a.id, ...saw.map((c) => c.id)], a, text);
        incident(w, { act: "steal", by: a, against: b, at: a, text, value: deed.value, items: deed.items, seenBy: saw });
        return;
      }
      const r = await reply(
        hidden ? `${b.name} catches ${a.name} stealing ${an(nm(w, item))} from them.` : `${a.name} grabs ${an(nm(w, item))} from ${b.name} and keeps it.`,
        { let_it_go: "Let it go", confront: "Confront them and demand it back" },
      );
      const back = r === "confront" && Math.random() < 0.6;
      if (back) { takeItems(a, item); giveItems(w, b, item); deed.items = []; }
      text = `${a.name} ${hidden ? "was caught stealing" : "took"} ${an(nm(w, item))} from ${b.name}. ${b.name} ${r === "let_it_go" ? "let it go" : back ? "confronted them and got it back" : "confronted them, but didn't get it back"}.`;
      break;
    }
    default:
      return;
  }
  if (HOSTILE.includes(kind)) a.cooldowns[`hostile:${b.id}`] = w.t + DAY / 2;
  a.cooldowns[`social:${b.id}`] = w.t + 40;
  log(w, kind, [a.id, b.id], a, text);
  trace("social", kind, { with: b.id, text }, a.id);
  if (warm) friendly(w, a, b);
  if (turnedAway) snubbed(w, b, a);
  if (deed) incident(w, { act: deed.act, by: deed.by ?? a, against: deed.against ?? b, at: a, text, value: deed.value, items: deed.items, seenBy: [a, b, ...bystanders()] });
  await Promise.all([a, b].map((x) => {
    const other = x === a ? b : a;
    return reflect(w, x, other, text).then((r) => {
      if (r.bond !== "none") log(w, "bond", [x.id], x, `${x.name} will remember this about ${other.name}: ${r.bond.replaceAll("_", " ")}. They now see ${other.name} as ${an(x.rel[other.id].label)}.`);
    });
  }));
}

// A planted seed that grew teaches its planter the connection, and the world a new law.
onGrew((w, owner, from, at) => {
  const a = agentById(w, owner);
  if (!a) return;
  const fields = { verb: "plant", inputs: [from], gives: [], builds: "bush" };
  const knew = !!a.beliefs[beliefKey(fields)];
  record(w, a, { ok: true, text: "", uses: { [from]: 1 }, gives: {}, builds: "bush", fields, newKinds: [] }, DAY * 3, "seen");
  if (!knew) log(w, "discover", [a.id], at, `${a.name} realized the ${nm(w, from)} they pushed into the ground grew into a bush.`);
});

function burned(w: World) {
  for (const b of burnedHomes.splice(0)) {
    const owner = agentById(w, b.owner), lighter = agentById(w, b.by);
    if (!owner || !lighter || owner === lighter) continue;
    const text = `${lighter.name}'s fire spread and burned down ${owner.name}'s home.`;
    log(w, "burned", [owner.id, lighter.id], owner, text);
    incident(w, { act: "burned_home", by: lighter, against: owner, at: owner, text, value: 1, seenBy: [owner, ...w.agents.filter((b) => canSee(w, b, owner, VISION))] });
    reflect(w, owner, lighter, text).then((r) => {
      if (r.bond !== "none") log(w, "bond", [owner.id], owner, `${owner.name} will remember this about ${lighter.name}: ${r.bond.replaceAll("_", " ")}.`);
    }).catch(() => {});
  }
}

// ---------- needs ----------
function needs(w: World, a: Agent) {
  const n = a.needs, night = isNight(w.t), wx = w.weather;
  n.food = Math.max(0, n.food - 0.14 - (a.sickness ? 0.05 : 0));
  n.energy = Math.max(0, n.energy - (night ? 0.16 : 0.1));
  n.social = Math.max(0, n.social - 0.05);
  const worn = a.wearing ? p(w.kinds[a.wearing.k], "insulating") : 0;
  const home = homeOf(w, a), inside = !!home && reaches(a, home), air = airOn(w, a, inside);
  // Below 12C the body loses heat, the faster the harder the wind blows; above it, the air gives some back.
  const cold = Math.max(0, (12 - air.feels) / 110) * (night ? 1.2 : 1) * (wx.sky === "rain" || wx.sky === "storm" ? 1.3 : 1) * (1 - worn * 0.6);
  const mild = Math.max(0, (air.temp - 12) / 60);
  const fire = nearest(a, liveThings(w), (t) => t.kind === "fire" || (t.burning ?? 0) > 0.3);
  let heat = 0;
  if (fire && meters(a, fire) <= (fire.contained ? 5 : 4)) heat += fire.contained ? 1.1 : 0.9;
  if (inside) heat += 0.2 + (home.shelter?.insul ?? 0) * 0.8 + (home.shelter?.tier ?? 0) * 0.1;
  if (night) heat += Math.min(2, w.agents.filter((b) => b !== a && meters(a, b) <= 2).length) * 0.25;
  // A lit lamp in hand gives off a little warmth.
  if (a.inv.some((s) => s.k.startsWith("burning:") && p(w.kinds[s.k], "container") >= 0.5)) heat += 0.25;
  n.warmth = Math.max(0, Math.min(100, n.warmth + heat - cold + mild));
  if (n.food <= 0 || n.warmth <= 0) n.health -= 0.4;
  else if (n.food > 40 && n.warmth > 40 && !a.sickness) n.health = Math.min(100, n.health + 0.1);
  const flames = nearest(a, liveThings(w), (t) => (t.burning ?? 0) > 0.4);
  if (flames && meters(a, flames) <= 2) n.health -= 1.5;
}

function perceive(w: World, a: Agent) {
  for (const b of w.agents) {
    if (b === a || !canSee(w, a, b, VISION)) continue;
    if (meters(a, b) <= 30) a.near[b.id] = (a.near[b.id] ?? 0) + 1;
    if (!a.seen[b.id] || w.t - a.seen[b.id] > 150) {
      if (!a.rel[b.id]) log(w, "notice", [a.id], a, `${a.name} spotted a stranger: ${b.name}.`);
      a.nextDecide = Math.min(a.nextDecide, w.t);
      if (a.goal && w.t - a.goal.since > 5 && !a.engaged && !tinkerWait.has(a.id) && !["flee", "fight", "defend"].includes(a.goal.type)) { a.goal = null; a.plan = []; }
    }
    a.seen[b.id] = w.t;
  }
  if (a.engaged || a.thinking) return;
  const wolfId = attacked.get(a.id);
  const busy = a.goal && ["flee", "fight", "defend"].includes(a.goal.type);
  if (wolfId && !busy) {
    const weapon = bestWeapon(w, a);
    const bold = (a.traits.brave ?? 0) + (a.traits["hot-tempered"] ?? 0) + (weapon && p(weapon, "sharp") >= 0.5 ? 0.5 : 0);
    const fight = a.needs.health > 30 && Math.random() < 0.2 + bold * 0.5;
    a.goal = { type: fight ? "fight" : "flee", since: w.t, odds: {}, fails: 0 };
    a.plan = [{ op: fight ? "fight" : "flee", arg: a.id, progress: 0 }];
    trace("plan", "interrupt", { reason: "wolf", fight }, a.id);
    for (const b of w.agents) {
      if (b === a || b.down > w.t || b.engaged || meters(a, b) > 60 || (b.goal && ["flee", "fight", "defend"].includes(b.goal.type))) continue;
      const care = (b.rel[a.id]?.affinity ?? 0) + (b.traits.protective ?? 0) + (b.traits.brave ?? 0) * 0.5 + (b.traits.selfless ?? 0) * 0.5;
      if (Math.random() < care * 0.6) {
        b.goal = { type: "defend", target: a.id, since: w.t, odds: {}, fails: 0 };
        b.plan = [{ op: "goto", arg: "agent", progress: 0 }, { op: "fight", arg: a.id, progress: 0 }];
        log(w, "defend", [b.id, a.id], b, `${b.name} rushed to help ${a.name} against the wolf.`);
      }
    }
    return;
  }
  const flames = nearest(a, liveThings(w), (t) => !!t.burning && t.burning > 0.3);
  if (flames && meters(a, flames) <= 8 && !busy) {
    a.goal = { type: "flee", since: w.t, odds: {}, fails: 0 };
    a.plan = [{ op: "flee", progress: 0 }];
    see(w, a, "fire_spreads", "Fire spreads to anything dry and wooden nearby.", 60);
  }
}

// Desperate bodies don't deliberate: a starving person eats or looks for food, a freezing one seeks warmth.
function reflex(w: World, a: Agent) {
  const n = a.needs;
  const tries: string[] = [];
  if (n.food < 15) tries.push("eat", "forage");
  if (n.warmth < 15) tries.push("warm_up", "make_fire");
  if (n.energy < 8) tries.push("rest");
  for (const type of tries) {
    if (a.cooldowns[type] > w.t) continue;
    const steps = planGoal(w, a, type);
    if (!steps?.length) continue;
    a.goal = { type, since: w.t, odds: {}, fails: 0 };
    a.plan = steps;
    trace("plan", "reflex", { type, needs: n }, a.id);
    return true;
  }
  // Nothing warm to reach: get close to another body.
  if (n.warmth < 15 && !(a.cooldowns.huddle > w.t)) {
    const b = nearest(a, w.agents, (x) => x !== a && x.down <= w.t);
    if (b && meters(a, b) < 400) {
      a.cooldowns.huddle = w.t + 30;
      a.goal = { type: "stay_close", target: b.id, since: w.t, odds: {}, fails: 0 };
      a.plan = [{ op: "follow", arg: b.id, progress: 0 }];
      return true;
    }
  }
  return false;
}

function agentTick(w: World, a: Agent) {
  needs(w, a);
  const n = a.needs;
  if (a.down > w.t) { a.status = "Unconscious"; return; }
  if (n.health <= 0) {
    const cause = attacked.has(a.id) ? "their wounds" : a.sickness ? "sickness" : n.food <= 0 ? "hunger" : "cold";
    // A second collapse soon after the first is fatal.
    if (w.t - (a.cooldowns.collapsed ?? -Infinity) < DAY * 1.5) { die(w, a, cause); return; }
    a.cooldowns.collapsed = w.t;
    n.health = 25; n.food = Math.max(n.food, 15); n.warmth = Math.max(n.warmth, 20);
    a.down = w.t + 60;
    a.goal = null; a.plan = [];
    log(w, "collapse", [a.id], a, `${a.name} collapsed from ${cause}.`);
    for (const b of w.agents) if (b !== a && canSee(w, b, a, VISION) && !b.engaged && !b.thinking) { b.nextDecide = w.t; if (b.goal && !["flee", "fight", "defend"].includes(b.goal.type)) { b.goal = null; b.plan = []; } }
    return;
  }
  perceive(w, a);
  if (a.thinking || a.engaged) return;
  const critical = (["food", "energy", "warmth"] as const).find((k) => n[k] < 20);
  if (a.goal && critical && !NEED_FIX[critical](a.goal.type, w) && !["flee", "fight", "defend"].includes(a.goal.type) && !(a.cooldowns.interrupt > w.t)) {
    a.cooldowns.interrupt = w.t + 40;
    trace("plan", "interrupt", { reason: critical, was: a.goal.type }, a.id);
    a.goal = null; a.plan = [];
  }
  // Dark falls on whoever is out, or about to go out, after something they would have to see (gathering, exploring, hunting):
  // they give it up where they stand, unless a fire lights it or they are too cold or hungry to stop.
  if (a.goal && !(a.cooldowns.interrupt > w.t) && a.plan.some(foray) && n.food >= 15 && n.warmth >= 15 && lightOn(w, a).bright < DARK && !nearFire(w, a, 12)) {
    a.cooldowns.interrupt = w.t + 40;
    trace("plan", "interrupt", { reason: "dark", was: a.goal.type }, a.id);
    a.goal = null; a.plan = [];
  }
  // Walking a few hundred meters takes a good part of a day, so goals get a day, and big projects three.
  if (a.goal && w.t - a.goal.since > (a.goal.type.startsWith("make:") || a.goal.type === "build_shelter" || a.goal.type === "move_home" ? DAY * 3 : DAY)) endGoal(w, a, false, "took too long");
  if (!a.goal && reflex(w, a)) return;
  if (!a.goal) {
    if (w.t >= a.nextDecide) void think(w, a);
    else a.status = "Idle";
    return;
  }
  if (!a.plan.length) { endGoal(w, a, true); return; }
  const step = a.plan[0];
  const r = run(w, a);
  if (r === true) {
    a.plan.shift();
    const made = step.op === "act" && a.goal.type.startsWith("make:") && (a.beliefs[step.key ?? ""]?.out[a.goal.type.slice(5)] ?? 0) > 0;
    if (made) { endGoal(w, a, true); return; }
    if (!a.plan.length) {
      // Big projects are planned one ingredient at a time; keep going until the thing is made.
      if (a.goal.type.startsWith("make:") && (a.goal.stages ?? 0) < 20) {
        const next = planGoal(w, a, a.goal.type, a.goal.target);
        if (next?.length) { a.plan = next; a.goal.stages = (a.goal.stages ?? 0) + 1; return; }
      }
      endGoal(w, a, true);
    }
  } else if (typeof r === "string") {
    trace("plan", "step_failed", { op: step.op, key: step.key, why: r }, a.id);
    a.goal.fails++;
    if (a.goal.fails > 2 || ["tinker", "flee", "fight", "defend"].includes(a.goal.type)) { endGoal(w, a, false, r); return; }
    const steps = planGoal(w, a, a.goal.type, a.goal.target);
    if (!steps) endGoal(w, a, false, r);
    else a.plan = steps;
  }
}

export function tick(w: World) {
  w.t++;
  traceClock.t = w.t;
  timed("ecology", () => ecology(w));
  timed("life", () => life(w));
  burned(w);
  timed("groups", () => groups(w));
  if (w.t % DAY === 0) for (const a of w.agents) fadeBonds(a);
  if (w.t % DAY === DAY / 2) timed("shelve", () => shelve(w));
  timed("agents", () => { for (const a of [...w.agents]) if (w.agents.includes(a)) agentTick(w, a); });
  timed("journeys", () => travel(w));
  bump("ticks");
}

export function summary(w: World, a: Agent) {
  const weapon = bestWeapon(w, a);
  return {
    id: a.id, name: a.name, color: a.color, x: a.x, y: a.y, px: a.px, py: a.py, heading: a.heading, status: a.status,
    goal: a.goal?.type ?? null, goalText: a.goal ? goalText(w, a.goal.type, a.goal.target) : null, target: a.goal?.target ?? null,
    needs: a.needs, thinking: a.thinking, down: a.down > w.t, sick: !!a.sickness,
    wearing: a.wearing ? nm(w, a.wearing.k) : null, holding: weapon?.name ?? null,
    ...lifeSummary(w, a),
  };
}
export function agentDetail(w: World, a: Agent) {
  const camp = campOf(w, a.id);
  return {
    ...a, ...summary(w, a),
    goal: a.goal, sickness: a.sickness, pregnant: a.pregnant, children: a.children, born: a.born,
    plan: a.plan.map((s) => ({ op: s.op, arg: s.arg, progress: s.progress, label: stepLabel(w, a, s) })),
    beliefs: Object.fromEntries(Object.entries(a.beliefs).map(([k, b]) => [k, {
      key: k, text: beliefText(w, b), how: b.how, from: b.from, t: b.t, tries: b.tries, wins: b.wins,
      spurious: b.spurious ? nm(w, b.spurious) : undefined, law: b.law, gives: Object.keys(b.out),
    }])),
    inventoryText: a.inv.map((s) => describeKind(w.kinds[s.k])),
    camp: camp ? { id: camp.id, name: camp.name, leader: camp.leader, founded: camp.founded, standing: standing(camp, a.id) } : null,
    outcast: liveCamps(w).flatMap((c) => [
      (c.shunned[a.id]?.until ?? 0) > w.t ? { camp: c.name, how: "shunned", until: c.shunned[a.id].until } : null,
      (c.exiled[a.id]?.until ?? 0) > w.t ? { camp: c.name, how: "driven out", until: c.exiled[a.id].until } : null,
    ].filter(Boolean)),
    customsKnown: knownCustoms(w, a),
  };
}
export { beliefText };

// ---------- what anyone watching can see them doing ----------
// The one word for what a person is at, for the icon over their head: out cold, in a meeting (talking, giving,
// quarrelling, fighting), thinking, or the step of their plan they are on or walking to (resting is sleeping); else sick.
export type Activity =
  | "sleep" | "faint" | "talk" | "give" | "angry" | "steal" | "think" | "warm" | "eat" | "flee" | "fight" | "hunt" | "tend"
  | "store" | "tinker" | "chop" | "build" | "plant" | "dig" | "fire" | "craft" | "forage" | "collect" | "explore" | "help" | "sick";
// What each icon means, in the words the map's key and tooltips use.
export const ACTIVITY: Record<Activity, string> = {
  sleep: "sleeping or resting", faint: "collapsed, out cold", talk: "talking with someone", give: "giving, trading or sharing", angry: "quarrelling",
  steal: "taking or stealing", think: "making up their mind", warm: "warming up by a fire", eat: "eating", flee: "running away or keeping clear",
  fight: "fighting", hunt: "hunting", tend: "looking after someone", store: "putting things away or fetching them", tinker: "experimenting",
  chop: "chopping wood", build: "building", plant: "planting", dig: "digging", fire: "making or tending a fire", craft: "making something",
  forage: "picking food", collect: "gathering materials", explore: "exploring", help: "helping or keeping close to someone", sick: "sick",
};
const MEETING: Record<string, Activity> = {
  talk: "talk", gossip: "talk", teach: "talk", beg: "talk", give: "give", share_meal: "give", share_fire: "give", trade: "give",
  help: "help", tend: "tend", insult: "angry", attack: "fight", take: "steal", steal: "steal",
};
const STEP: Record<string, Activity> = {
  warm_up: "warm", eat: "eat", flee: "flee", avoid: "flee", fight: "fight", hunt: "hunt", tend: "tend", follow: "help", assist: "help",
  stash: "store", take_stored: "store", share: "store", take_shared: "store", raid: "steal", tinker: "tinker", wander: "explore", pick_up: "collect",
  pick_berries: "forage", pick_mushroom: "forage", pick_herb: "forage", pick_stick: "collect", pick_stone: "collect", pull_reeds: "collect", dig_clay: "dig", scrape_resin: "collect",
};
export function activity(w: World, a: Agent): Activity | null {
  if (a.down > w.t) return "faint";
  if (a.engaged) return MEETING[a.plan.find((s) => s.op === "social")?.arg ?? ""] ?? MEETING[a.goal?.type ?? ""] ?? "talk";
  if (a.thinking) return "think";
  // walking somewhere is walking to do what comes next
  const s = a.plan[0]?.op === "goto" ? a.plan[1] ?? a.plan[0] : a.plan[0];
  if (s) {
    if (s.op === "rest") return "sleep";
    if (s.op === "social") return MEETING[s.arg ?? ""] ?? "talk";
    if (s.op === "act") {
      const act = s.act ?? (s.key && a.beliefs[s.key] ? actFromBelief(a.beliefs[s.key]) : null);
      const target = act?.target?.kind ?? "";
      if (act?.verb === "strike" && ["tree", "stump", "fallen_log", "dead_bush"].includes(target)) return "chop";
      if (act?.verb === "place") return a.goal?.type === "make_fire" || a.goal?.type === "contain_fire" ? "fire" : "build";
      if (act?.verb === "plant") return "plant";
      if (act?.verb === "dig") return "dig";
      if (act?.verb === "rub" || act?.verb === "heat") return a.goal?.type === "make_fire" ? "fire" : "craft";
      if (act?.verb === "throw") return "hunt";
      if (act?.verb === "eat") return "eat";
      return "craft";
    }
    const step = STEP[s.op];
    if (step) return step;
  }
  return a.sickness ? "sick" : null;
}
// Where a person is headed, in tiles, while their step takes them somewhere: the place their goto names, the point they
// are exploring toward, or whoever they are following, helping, tending or meeting. Null when they are not going anywhere.
export function heading(w: World, a: Agent): { px: number; py: number } | null {
  const s = a.plan[0];
  if (!s || a.down > w.t || a.engaged) return null;
  if (s.op === "goto") { const t = spot(w, a, s.arg!); return t && { px: t.px, py: t.py }; }
  if (s.op === "wander") { const [px, py] = s.arg!.split(",").map(Number); return { px, py }; }
  if (s.op === "follow" || s.op === "assist" || s.op === "tend") { const b = agentById(w, s.arg); return b ? { px: b.px, py: b.py } : null; }
  if (s.op === "social") { const b = agentById(w, a.goal?.target); return b ? { px: b.px, py: b.py } : null; }
  if (s.op === "raid") { const h = thingById(w, s.arg); return h ? { px: h.px, py: h.py } : null; }
  if (s.op === "hunt") { const prey = nearest(a, w.animals, (m) => m.species === s.arg); return prey && { px: prey.px, py: prey.py }; }
  return null;
}
