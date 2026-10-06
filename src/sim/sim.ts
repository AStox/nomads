import {
  DAY, H, REACH, TILE_M, W, clock, dryAt, isNight, shoreOf, level, log, meters, reachOf, stageOf,
  type Act, type Agent, type Animal, type BondKind, type Step, type Thing, type Waiting, type World,
} from "./world";
import { THING_MATERIAL, depth, noun, p, plural, type Kind } from "./materials";
import {
  airy, applyRuling, arrowy, beside, count, counts, stave, digTick, diggable, eat, fireKind, fishClose, force, giveItems, greasy, heat, homeOf, join, mark, nearFire, openWater, place as placeItems, plant,
  fireHours, groundWord, hoursToDawn, leaveHome, pour, raining, reaches, removeThing, residentsOf, rubTick, shape, sheltered, shelterName, stash, strikeDamage, strikeTick, takeItems, throwReach, throwTick, unstash, wearIt, wet, WEATHER_NOW, type Fields, type Outcome,
} from "./physics";
import { die, life, lifeSummary } from "./life";
import { apart, beliefKey, beliefText, cameOff, conditionWords, differed, weighs, fieldsOf, found, groundKey, groundOfKey, holds, mixOf, odds, fades, noteTry, ofSpot, record, refine, refuted, restsOn, rethink, see, sentence, suspected, teach, testOf, watchers, type Belief } from "./beliefs";
import { COLLECT, GATHER, SOCIAL, SOCIAL_ITEM_NEEDS, edibleKinds, foodIn, plan, type Ctx, type PState, type PlanStep } from "./plan";
import { burnedHomes, ecology, onFireOut, onGrew, onWithered, trample, trapped, tread } from "./ecology";
import { FAUNA, HUNTED } from "./fauna";
import { attacked } from "./animals";
import { chooseTinker, decide, describeKind, fadeBonds, grudge, nameIt, newRel, reflect, respond, rule, sample, theorize, wonder, type Felt } from "./brain";
import { clock as traceClock, count as bump, timed, trace } from "./trace";
import { campOf, friendly, groups, incident, knownCustoms, liveCamps, share, sharedStore, snubbed, spread, standing, takeShared } from "./groups";
import { anyAround, around, liveThings, nearestThing, shelve, thingById } from "./space";
import { landOf, walk } from "./walk";
import { DARK, canSee, lightOn, moveRate, restRate, skyShare, workRate } from "./light";
import { ripening } from "./cues";
import { airOn } from "./air";
import { enrich, soilWaterAt } from "./soil";
import { travel } from "./journeys";
import { RULES, hooks } from "./rules";

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
  "experiment:home": "Try to make their shelter warmer or sturdier with what's at hand",
  tend_plants: "See to the young plants they've put in the ground",
  lay_by_wood: "Gather wood to keep the fire going through the night",
  "experiment:fire": "Try to find a way to make fire",
  "experiment:tool": "Try to make a better tool",
  "experiment:food": "Try new ways to get food",
  "experiment:fireside": "Try things by the fire to see what the heat does to them",
  collect_stones: "Collect stones",
  collect_sticks: "Collect sticks",
  collect_reeds: "Pull up reeds for fiber",
  collect_clay: "Dig up clay",
  collect_resin: "Scrape beads of resin off wounded trees",
  collect_bark: "Gather strips of bark",
  collect_ore: "Pick up the reddish stones lying about",
  make_fire: "Start a fire",
  tend_fire: "Keep the fire from going out",
  build_shelter: "Build or add to a shelter",
  move_home: "Leave their shelter and build a new one next to the home of someone they like",
  contain_fire: "Ring the fire with stones",
  plant: "Plant something to grow",
  cure: "Eat something that eases sickness",
  put_on: "Put on something warm",
  dig_pit: "Dig a pit",
  set_trap: "Hide a pit to trap animals",
  store_food: "Put food and goods away at home",
  stock_up: "Gather food that keeps and put it by at home for leaner days",
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
  ask_help: "Ask someone for help with what they can't manage on their own",
  move_in: "Ask to move in with someone",
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
  if (type.startsWith("test:")) { const [c, key] = testOf(type); return `Try to ${lower(actText(w, actOfFields(fieldsOf(key))))} ${conditionWords(c)} anyway, to see if it really won't work`; }
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
  warmth: (t) => ["warm_up", "share_fire", "make_fire", "tend_fire", "build_shelter", "move_home", "put_on", "contain_fire"].includes(t),
};
const isTool = (k?: Kind) => !!k && (k.verb === "join" || k.verb === "rub" || p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6);
// Roughly how much losing one of these costs someone: tools more than food, food more than raw stuff.
const valueOf = (w: World, k: string) => { const x = w.kinds[k]; return isTool(x) ? 0.45 : p(x, "edible") >= 0.1 ? 0.15 + p(x, "edible") * 0.5 : 0.1; };

// ---------- places ----------
type Place = { kinds: readonly string[]; ok?: (t: Thing, w: World) => boolean };
const THING_PLACES: Record<string, Place> = {
  // grass bears seed as the days draw in
  grain: { kinds: ["grass"], ok: (t, w) => ripening(w.t) && (t.hp ?? 3) > 1 },
  bush: { kinds: ["bush"], ok: (t) => (t.n ?? 0) > 0 && !t.burning },
  mushroom: { kinds: ["mushroom"] }, herb: { kinds: ["herb"] }, stick: { kinds: ["stick"] }, stone: { kinds: ["stone"] },
  reeds: { kinds: ["reeds"], ok: (t) => !t.burning }, clay: { kinds: ["clay"] }, tree: { kinds: ["tree"], ok: (t) => !t.burning },
  sapling: { kinds: ["sapling"] },
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
  const g = groundOfKey(kind);
  if (g) return groundsNear(w, a, g).get(g) ?? null;
  const f = THING_PLACES[kind];
  return f ? thingSpot(nearestThing(w, a.px, a.py, f.kinds, (t) => (!f.ok || f.ok(t, w)) && ok(t), SEARCH)) : null;
}
// The ground round about they could walk to and work, by what it looks like underfoot, looking out in rings to 100 m,
// clear of whatever else about a spot they've come to think gets in the way (shade, dry ground, crowding: a theory of
// theirs about the spot that holds there): the nearest spot of each kind of ground, or only of the kind asked for.
function groundsNear(w: World, a: Agent, word?: string) {
  const avoid = blamed(a);
  const found = new Map<string, Spot>();
  for (const r of [0, 5, 10, 20, 35, 55, 80, 100])
    for (let k = 0; k < (r ? 12 : 1); k++) {
      const ang = (k / 12) * Math.PI * 2, px = a.px + (Math.cos(ang) * r) / TILE_M, py = a.py + (Math.sin(ang) * r) / TILE_M;
      if (px < 0 || py < 0 || px >= W || py >= H || !dryAt(w, px, py) || !reachable(w, a, Math.floor(px), Math.floor(py))) continue;
      const g = groundWord(w, px, py);
      if (found.has(g) || (word && g !== word)) continue;
      if (avoid.length && avoid.some((t) => holds(t, conditionsNow(w, a, "plant", { px, py })))) continue;
      found.set(g, { px, py, reach: 1 });
      if (word) return found;
    }
  return found;
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
    reflect(w, a, fell, text, { feel: -1 }).then((r) => { if (r.bond !== "none") log(w, "bond", [a.id], a, `${a.name} will remember this about ${fell.name}: ${r.bond.replaceAll("_", " ")}.`); }).catch(() => {});
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
// Half a day's walk: as far off as a home can be and still be where someone goes to sleep or get warm.
const HOME_NEAR = 150;
export function ctxFor(w: World, a: Agent): Ctx {
  const d: Record<string, number> = {};
  // In the dark, unless they are freezing or starving, they plan around what they can see: a bush 300 m off is not a place to go.
  const blind = lightOn(w, a).bright < DARK && a.needs.food >= 15 && a.needs.warmth >= 15;
  // A home more than half a day's walk off is no place to go for the night or to warm up: they make do where they are.
  for (const k of [...Object.keys(THING_PLACES), "water", "home", "homesite", "store", ...HUNTED]) {
    const s = spot(w, a, k);
    if (s && (k !== "pit" || s.thing?.owner === a.id) && (k !== "home" || meters(a, s) <= HOME_NEAR) && (!blind || KNOWN[k] || canSee(w, a, s, SEARCH))) d[k] = meters(a, s) / STEP_M;
  }
  around(w, a.px, a.py, 600, ["item"], (t, m) => { if (t.item && reachable(w, a, t.x, t.y) && (!blind || canSee(w, a, t, SEARCH))) d[`item:${t.item}`] = Math.min(d[`item:${t.item}`] ?? 99, m / STEP_M); });
  const target = agentById(w, a.goal?.target);
  if (target) d.agent = meters(a, target) / STEP_M;
  // for someone who knows something to do to the ground, every kind of ground nearby: where they'd do it
  if (Object.values(a.beliefs).some((b) => (b.fields.verb === "plant" || b.fields.verb === "dig") && b.wins > 0))
    for (const [g, s] of groundsNear(w, a)) d[groundKey(g)] = meters(a, s) / STEP_M;
  const toxic = Object.values(a.beliefs).filter((b) => b.fields.verb === "eat" && b.fields.effect === "sick").map((b) => b.fields.inputs[0]);
  const home = homeOf(w, a);
  const store: Record<string, number> = {};
  for (const s of home?.store ?? []) store[s.k] = (store[s.k] ?? 0) + 1;
  const shared: Record<string, number> = {};
  const camp = sharedStore(w, a);
  if (camp && camp !== home) for (const s of camp.store ?? []) shared[s.k] = (shared[s.k] ?? 0) + 1;
  return { dist: d, beliefs: Object.values(a.beliefs), facts: a.facts, kinds: w.kinds, toxic, store, shared, now: conditionsNow(w, a) };
}
function pstate(w: World, a: Agent): PState {
  const fire = nearFire(w, a);
  return { inv: counts(a), at: fire ? fireKind(fire) : within(w, a, "home") ? "home" : null, flags: [] };
}
// How far someone will walk to try things at a fire: sixty meters, a couple of hours at a walk.
const FIRESIDE = 60;
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
  if (type.startsWith("experiment:")) {
    // Someone setting out to find a way to make something first gathers a few things to try it with, by what they're
    // like rather than a recipe: things they've seen burn for a fire, long things to lean together or soft ones to
    // cover with for a shelter, hard things and long ones for a tool. A couple of whichever lie about, or an armful
    // each to build with.
    const aim = type.slice(11), steps: Step[] = [], suits = AIM_STUFF[aim], armful = aim === "shelter" || aim === "home" ? 4 : 2;
    if (suits) {
      const about = Object.values(COLLECT).filter((k) => suits(w.kinds[k]) && count(a, k) < armful && (k === "stone" || k === "stick" || (ctx.dist[k === "fiber" ? "reeds" : k] ?? ctx.dist[`item:${k}`]) !== undefined));
      for (const k of about.sort(() => Math.random() - 0.5).slice(0, 2)) {
        const sub = plan(pstate(w, a), `have:${k}:${armful}`, ctx);
        if (sub) steps.push(...sub.map((st) => ({ op: st.op, arg: st.arg, key: st.key, progress: 0 })));
      }
    }
    // new ways with food, and anything to be tried in the heat, are tried at a fire if there is one close by; new ways
    // to build, on the shelter they sleep in
    if ((aim === "food" || aim === "fireside") && (ctx.dist.fire ?? Infinity) * STEP_M <= FIRESIDE && !nearFire(w, a)) steps.push({ op: "goto", arg: "fire", progress: 0 });
    if (aim === "home" && "home" in ctx.dist && !within(w, a, "home")) steps.push({ op: "goto", arg: "home", progress: 0 });
    return [...steps, ...mk("tinker", aim)];
  }
  if (type === "raid") { const h = [...liveThings(w)].find((t) => t.kind === "structure" && t.owner === target && t.store?.length); return h ? [{ op: "raid", arg: h.id, progress: 0 }] : null; }
  if (type === "stay_close") return mk("follow", target);
  if (type === "tend") return [{ op: "goto", arg: "agent", progress: 0 }, { op: "tend", arg: target, progress: 0 }];
  if (type === "flee" || type === "fight" || type === "defend") return mk(type === "flee" ? "flee" : "fight", target);
  if (type === "store_food" && homeOf(w, a)) return [{ op: "goto", arg: "home", progress: 0 }, { op: "stash", progress: 0 }];
  if (type.startsWith("test:")) {
    // what the theory is about, done here and now with the theory set aside
    const [, key] = testOf(type);
    const sub = plan(pstate(w, a), `try:${key}`, { ...ctx, testing: key });
    return sub ? sub.map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 })) : null;
  }
  if (type === "tend_plants") {
    // what they know works for a wilting plant, or else over to it to try what they're holding
    const known = plan(pstate(w, a), "tend_plants", ctx);
    if (known) return known.map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 }));
    return "sapling" in ctx.dist ? [{ op: "goto", arg: "sapling", progress: 0 }, ...mk("tinker", "food")] : null;
  }
  if (type === "lay_by_wood") {
    const fuel = Object.values(a.beliefs).find((b) => b.fields.builds === "fed_fire" && b.wins > 0)?.fields.inputs[0];
    const sub = fuel ? plan(pstate(w, a), `have:${fuel}:3`, ctx) : null;
    return sub ? sub.map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 })) : null;
  }
  if (type === "tend_fire") {
    // Whoever has seen wood laid on a fire keep it going that way; anyone else tries what they have on it.
    const known = plan(pstate(w, a), "tend_fire", ctx);
    if (known) return known.map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 }));
    return [...(nearFire(w, a) ? [] : [{ op: "goto", arg: "fire", progress: 0 }]), ...mk("tinker", "fireside")];
  }
  if (type === "stock_up") {
    // Food that keeps for weeks and grows wild (seed stripped from the grass, nuts under the trees), an armful more of
    // whichever is nearer to hand, carried home and put away.
    if (!("home" in ctx.dist)) return null;
    const keeps = Object.values(w.kinds).filter((k) => !k.made && p(k, "edible") >= 0.1 && (k.shelf ?? 0) >= 10);
    const runs = keeps.map((k) => plan(pstate(w, a), `have:${k.id}:${count(a, k.id) + 6}`, ctx)).filter((s): s is PlanStep[] => !!s).sort((x, y) => x.length - y.length);
    if (!runs.length) return null;
    return [...runs[0].map((s) => ({ op: s.op, arg: s.arg, key: s.key, progress: 0 })), { op: "goto", arg: "home", progress: 0 }, { op: "stash", progress: 0 }];
  }
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
    struggled(a, type, w);
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
// A need someone keeps failing to meet by their own efforts: each goal for it that comes to nothing while it's pressing
// counts, and the count goes when the need is met.
type Need = "food" | "warmth" | "energy";
function struggled(a: Agent, type: string, w: World) {
  for (const need of ["food", "warmth", "energy"] as Need[])
    if (a.needs[need] < 40 && NEED_FIX[need](type, w)) (a.struggles ??= {})[need] = (a.struggles[need] ?? 0) + 1;
}
// The need they've been failing at, if it's still pressing after two tries or more: the worst of them.
function struggling(a: Agent): Need | null {
  const now = (["food", "warmth", "energy"] as Need[]).filter((n) => (a.struggles?.[n] ?? 0) >= 2 && a.needs[n] < 40);
  return now.sort((x, y) => a.needs[x] - a.needs[y])[0] ?? null;
}
function endGoal(w: World, a: Agent, ok: boolean, why?: string) {
  if (!ok && a.goal) struggled(a, a.goal.type, w);
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
// Whether working on a shelter still seems worth it to them: there's none close by to sleep in, theirs needs mending,
// there are more people living in it than it sleeps, or what they last added still made it better. Two loads in a row
// that changed nothing tell them they're only burying the walls.
function shelterWork(w: World, a: Agent, home: Thing | null) {
  if (!home || meters(a, home) > HOME_NEAR || (home.hp ?? 100) < (home.maxHp ?? 100) * 0.7) return true;
  return residentsOf(w, home).length > (home.shelter?.room ?? 1) || (home.stale ?? 0) < 2;
}
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
  // Aimed experiments: they don't know how, but they know what they're after. Cold in the shelter they have, what
  // they're after is a better one.
  const knows = (b: string) => Object.values(a.beliefs).some((x) => x.fields.builds === b && x.wins > 0);
  if (holding) {
    add("experiment:shelter", !knows("shelter") && !home);
    add("experiment:home", !!home && !!within(w, a, "home") && a.needs.warmth < 50);
    add("experiment:fire", !knows("fire"));
    add("experiment:tool", true);
    add("experiment:food", a.needs.food < 70);
    add("experiment:fireside", !!fire && meters(a, fire) <= FIRESIDE);
  }
  // sticks and stones are about everywhere, but not quite: ask the planner for those; the rest go by where they grow
  for (const [type, k] of Object.entries(COLLECT)) add(type, !dark && count(a, k) < 6 && (k === "stone" || k === "stick" ? can(type) : (ctx.dist[k === "fiber" ? "reeds" : k] ?? ctx.dist[`item:${k}`]) !== undefined));
  const believes = Object.values(a.beliefs);
  const builds = (b: string) => believes.some((x) => x.fields.builds === b && x.wins > 0);
  add("make_fire", builds("fire") && (!fire || meters(a, fire) > 60) && can("make_fire"));
  // A fire close by that is burning down, or that plainly won't last the night, is something to do something about for
  // anyone with things in hand.
  const left = fire?.thing?.kind === "fire" && meters(a, fire) <= FIRESIDE ? fireHours(fire.thing) : Infinity;
  const dying = left < 4 || (isNight(w.t) && left < hoursToDawn(w.t));
  add("tend_fire", dying && holding && can("tend_fire"));
  // A theory of theirs about something they could do here and now: when they aren't in trouble (not starving, freezing,
  // hurt or spent), they might do it anyway to see whether it holds, the one resting on the least of all (beliefs.ts
  // restsOn) of those they could set about here, so one they can't (no seed in reach to test what they think of planting
  // in the rain) hides no other. Only where nothing else they blame it on holds as well (what they blame on a spot,
  // they'd keep clear of): a spark that dies in the rain at night says nothing about the dark to someone who blames the
  // rain. (Not when theories are never had, or known from the start: rules.ts RULES.learning.)
  if (RULES.learning === "seen" && a.needs.food >= 25 && a.needs.warmth >= 40 && a.needs.health >= 40 && a.needs.energy >= 15) {
    const now = ctx.now ?? [], doubts: { type: string; n: number }[] = [];
    for (const b of believes) for (const t of b.unless ?? []) {
      if (!holds(t, now) || b.unless?.some((o) => o !== t && !ofSpot(o) && holds(o, now))) continue;
      doubts.push({ type: `test:${t}@${b.key}`, n: restsOn(b, t) });
    }
    const doubt = doubts.sort((x, y) => x.n - y.n).find((d) => can(d.type));
    if (doubt) add(doubt.type, true);
  }
  // A young plant of theirs wilting where they can get to it: something to see to, by what they know or by trying things.
  const wilting = nearestThing(w, a.px, a.py, ["sapling"], (t) => t.owner === a.id && (t.hp ?? 5) < (t.maxHp ?? 5) * 0.8, 100);
  add("tend_plants", !!wilting && !dark && (holding || can("tend_plants")));
  // Someone who has watched a fire burn down with nothing at hand to feed it gets wood in before night falls.
  const fuel = a.facts.fuel_at_hand ? believes.find((b) => b.fields.builds === "fed_fire" && b.wins > 0)?.fields.inputs[0] : undefined;
  add("lay_by_wood", !!fuel && !dark && isNight(w.t + DAY / 6) && !!fire && meters(a, fire) <= FIRESIDE && count(a, fuel) < 3 && can("lay_by_wood"));
  add("build_shelter", builds("shelter") && shelterWork(w, a, home) && can("build_shelter"));
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
  // Laying by food that keeps, while there's room at home and something ripe to lay by.
  add("stock_up", !dark && !!home && (home.shelter?.tier ?? 0) >= 1 && (home.store?.length ?? 0) < 24 && can("stock_up"));
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
    if (hunter && prey && !dark && meters(a, prey) <= 400 && can(`hunt:${species}`)) opts[`hunt:${species}`] = goalText(w, `hunt:${species}`);
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
      // when what they've tried on their own keeps failing, anyone around might help
      if (kind === "ask_help") return !!struggling(a);
      if (kind === "move_in") return canMoveIn(w, a, b);
      if (kind === "attack") return (a.rel[b.id]?.affinity ?? 0) < -0.3 && b.needs.health > 30;
      if (kind === "raid") return meters(a, b) > 150 && [...liveThings(w)].some((t) => t.kind === "structure" && t.owner === b.id && t.store?.length && meters(a, t) <= 500);
      if (kind === "stay_close") return b.rel[a.id]?.label === "kin" || a.rel[b.id]?.label === "kin";
      return true;
    });
    if (!valid.length) continue;
    opts[kind] = GOALS[kind];
    targets[kind] = valid.map((b) => b.id);
  }
  // A probe narrows what they weigh to what it's about (rules.ts hooks).
  hooks.options?.(w, a, opts);
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
export const actFromBelief = (b: Belief) => actOfFields(b.fields);
function actOfFields(f: Fields): Act {
  if (f.verb === "strike") {
    // what they struck besides the thing struck: the tinder a spark is struck into
    const target = f.target ?? f.inputs[0];
    return { verb: "strike", items: f.inputs.filter((_, i) => i !== f.inputs.indexOf(target ?? "")), tool: f.tool ?? null, target: { kind: target } };
  }
  // a throw is at something: the kind of animal it was aimed at
  return { verb: f.verb as Act["verb"], items: f.verb === "rub" ? f.inputs.slice(0, 2) : [...f.inputs], tool: f.tool ?? null, shape: f.shape as Act["shape"], at: f.at ?? null, ...(f.target ? { target: { kind: f.target } } : {}) };
}
export function actText(w: World, act: Act): string {
  const tool = act.tool ? `the ${nm(w, act.tool)}` : "bare hands";
  const items = act.items.map((k) => nm(w, k));
  const same = items.length === 2 && items[0] === items[1];
  switch (act.verb) {
    case "strike": return `Strike ${act.target?.thing || act.target?.animal || ["tree", "bush", "boulder", "reeds", "stump", "dead_bush", "deer", "wolf"].includes(act.target?.kind ?? "") ? "the" : "a"} ${nm(w, act.target?.kind ?? "")} with ${act.tool ? tool : "bare hands"}${items.length ? ` over the ${items[0]}` : ""}`;
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
    case "pour": return act.target?.kind ? `Pour the water from the ${nm(w, w.kinds[act.items[0]]?.parts?.[0] ?? act.items[0])} over the young plant` : `Pour out the ${items[0]}`;
    case "wear": return `Wrap the ${items[0]} around themselves`;
    case "eat": return `Eat the ${items[0]}`;
    case "throw": return act.tool ? `Shoot the ${items[0]} at the ${act.target?.kind} with the ${nm(w, act.tool)}` : `Throw the ${items[0]} at the ${act.target?.kind}`;
    case "dig": return `Dig here with ${act.tool ? tool : "bare hands"}`;
  }
}
const actSig = (act: Act) => [act.verb, [...act.items].sort().join("+"), act.tool ?? "-", act.target?.kind ?? "-", act.at ?? "-", act.shape ?? "-"].join("|");

const SKILL: Record<string, (act: Act, w: World) => string> = {
  strike: (act, w) => act.target?.kind?.startsWith("hot:") || p(w.kinds[act.target?.kind ?? ""], "metal") >= 0.8 ? "smithing"
    : act.target?.kind === "tree" || act.target?.kind === "stump" ? "woodcutting" : act.target?.kind === "deer" || act.target?.kind === "wolf" ? "hunting" : ["stone", "bone", "boulder", "flint"].includes(act.target?.kind ?? "") ? "stonework" : "toolwork",
  rub: (act, w) => (act.items.some((k) => greasy(w.kinds[k])) ? "leatherworking" : act.items.some((k) => p(w.kinds[k], "flammable") >= 0.5) ? "firemaking" : act.items.some((k) => p(w.kinds[k], "edible") >= 0.1) ? "cooking" : "toolwork"),
  join: () => "crafting",
  heat: (act, w) => {
    const ks = act.items.map((k) => w.kinds[k]);
    return ks.some((k) => p(k, "metal") >= 0.3) ? "smithing" : ks.some((k) => p(k, "plastic") > 0.5) ? "pottery" : ks.some((k) => p(k, "insulating") >= 0.5 && p(k, "flexible") >= 0.5) ? "leatherworking" : ks.some((k) => p(k, "edible") > 0) ? "cooking" : "charcoal burning";
  },
  wet: () => "fishing", shape: () => "pottery", place: () => "building", plant: () => "farming", pour: () => "farming", wear: () => "crafting", eat: () => "foraging",
  throw: () => "throwing", dig: () => "digging",
};
function gain(w: World, a: Agent, skill: string, n: number) {
  const before = level(a.skills[skill] ?? 0);
  a.skills[skill] = (a.skills[skill] ?? 0) + n;
  if (level(a.skills[skill]) > before) log(w, "level", [a.id], a, `${a.name} got better at ${skill} (level ${level(a.skills[skill])}).`);
}

const DURATION: Record<string, number> = { join: 8, heat: 8, wet: 10, shape: 6, place: 3, plant: 3, pour: 2, wear: 2 };
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
export function doAct(w: World, a: Agent, s: Step): Outcome | "wait" | string {
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
    // close enough for the throw to fly true: a bow carries twice as far as an arm
    const range = throwReach(w, a, act);
    if (meters(a, prey) > range) {
      a.status = `Stalking the ${prey.species}`;
      if ((s.tries = (s.tries ?? 0) + 1) > 80) return `the ${prey.species} got away`;
      stepToward(w, a, prey.px, prey.py, range * 0.8);
      return "wait";
    }
    if (fumbles(w, a)) return "wait";
    a.status = actText(w, act);
    const r = throwTick(w, a, act, s);
    return r.done ? r.out! : "wait";
  }
  // water is poured over a young plant, walked over to first
  if (act.verb === "pour" && act.target?.kind) {
    act.target.thing ??= nearestThing(w, a.px, a.py, [act.target.kind], (x) => reachable(w, a, x.x, x.y), 25)?.id;
    const t = thingById(w, act.target.thing);
    if (!t) return "the young plant was gone";
    if (meters(a, t) > reachOf(t) + 0.5) {
      a.status = "Walking over to the young plant";
      if ((s.tries = (s.tries ?? 0) + 1) > 40) return "couldn't get to the young plant";
      return stepToward(w, a, t.px, t.py, reachOf(t)) === "stuck" ? "couldn't get to the young plant" : "wait";
    }
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
    case "plant": {
      // nowhere a theory of theirs about the spot holds, unless that's what they're out to see: then just such a spot
      const test = a.goal?.type.startsWith("test:") ? testOf(a.goal.type)[0] : null, avoid = blamed(a).filter((t) => t !== test);
      const fits = (at: Pos) => {
        const here = conditionsNow(w, a, "plant", at);
        return (!test || !ofSpot(test) || holds(test, here)) && !avoid.some((t) => holds(t, here));
      };
      return plant(w, a, act, (px, py) => fits({ px, py }));
    }
    case "pour": return pour(w, a, act);
    case "wear": return wearIt(w, a, act);
    case "eat": return eat(w, a, act.items[0]);
  }
  return "nothing to do";
}
const rulingsAt = new Map<number, number>();

// Conditions anyone can see they're working in, which might be why something works one time and not another; for
// what's done to the ground (planting, digging, watering), the spot itself (at): the ground, the shade of trees over
// it, how dry it is, and bushes and trees crowded round it, which tell as much as the weather does; and for what's
// dipped in the water (verb), whether any fish were swimming close by.
// hint: what the outcome would say if this were the reason, for the offline guess (Jev reads the outcome itself)
type Pos = { px: number; py: number };
// on, off: the weather in a word, and its lack, for telling Jev how it went like for like
const CONDITIONS: Record<string, { now: (w: World, a: Agent, at: Pos) => boolean; words: string; hint: RegExp; place?: true; verb?: string; on?: string; off?: string }> = {
  rain: { now: WEATHER_NOW.rain, words: "It was raining and there was nothing over their heads", hint: /damp|wet|rain|soak/, on: "raining", off: "dry" },
  dark: { now: WEATHER_NOW.dark, words: "It was dark", hint: /dark|couldn't see/, on: "dark", off: "light" },
  cold: { now: WEATHER_NOW.cold, words: "It was freezing", hint: /froze|frozen|freezing|ice/, on: "freezing", off: "above freezing" },
  wind: { now: WEATHER_NOW.wind, words: "A strong wind was blowing", hint: /wind|blew|gust/, on: "windy", off: "calm" },
  shade: { now: (w, _, at) => skyShare(w, at.px, at.py) < 0.5, words: "It was in the shade of trees", hint: /shade|under the trees/, place: true },
  dry: { now: (w, _, at) => soilWaterAt(w, at.px, at.py) < 0.5, words: "The ground there was dry", hint: /dry|parched/, place: true },
  crowded: { now: (w, _, at) => !!anyAround(w, at.px, at.py, 1.5, ["tree", "bush", "dead_bush"]), words: "Bushes or trees grew close round it", hint: /crowd|close round/, place: true },
  nofish: { now: (w, a, at) => !fishClose(w, a, at), words: "No fish were swimming close by", hint: /no fish/, verb: "wet" },
};
const GROUND_VERBS: Record<string, true> = { plant: true, dig: true, pour: true };
// verb: what they did, which brings in the spot (at: where it was done, if not where they stand) for what's done to the
// ground, and what bears only on that verb; without one, everything they could see
export const conditionsNow = (w: World, a: Agent, verb?: string, at: Pos = a) => {
  const ground = !verb || GROUND_VERBS[verb];
  const now = Object.keys(CONDITIONS).filter((c) => (ground || !CONDITIONS[c].place) && (!verb || !CONDITIONS[c].verb || CONDITIONS[c].verb === verb) && CONDITIONS[c].now(w, a, at));
  if (ground) now.push(groundKey(groundWord(w, at.px, at.py)));
  return now;
};
// What they've come to blame on a spot (shade, dry ground, crowding, the ground), whatever it was about: they'd do
// nothing to the ground anywhere a theory like that holds.
const blamed = (a: Agent) => [...new Set(Object.values(a.beliefs).flatMap((b) => b.unless ?? []).filter(ofSpot))];
const condition = (c: string) => CONDITIONS[c] ?? { words: `The ground there was ${groundOfKey(c)}`, hint: new RegExp(groundOfKey(c) ?? "$^") };
// What they've seen of it in a condition and out of it, in their words, for weighing a theory; and for the weather, how
// it went with it and without it in the mix of the other weather that tells the most (beliefs.ts apart), when other
// weather has come into it ("when it was dark but dry it has worked 3 of 9 times for them, and 4 of 12 when light and
// dry"). An old save's faded counts are told as what they round to.
const evidence = (b: Belief, c: string) => {
  const s = b.when?.[c] ?? { tries: 0, wins: 0 }, all = b.tally ?? { tries: 0, wins: 0 }, r = Math.round;
  const told = `it has worked ${r(s.wins)} of ${r(s.tries)} times for them like that, and ${r(all.wins - s.wins)} of ${r(all.tries - s.tries)} otherwise`;
  const { most, mixes } = apart(b, c), word = CONDITIONS[c];
  // the other weather that has come into it, as it was in that mix
  const others = [...new Set(Object.keys(mixes ?? {}).flatMap((k) => k.split("+")))].filter((x) => x !== c && CONDITIONS[x]?.on).sort();
  if (most === undefined || !mixes || !others.length || !word?.on) return told;
  const held = most ? most.split("+") : [], rest = others.map((x) => (held.includes(x) ? CONDITIONS[x].on : CONDITIONS[x].off));
  const inn = mixes[mixOf([...held, c])], out = mixes[most];
  return `${told}; when it was ${[word.on, ...rest].join(" and ")} it has worked ${r(inn.wins)} of ${r(inn.tries)} times, and ${r(out.wins)} of ${r(out.tries)} when it was ${[word.off, ...rest].join(" and ")}`;
};
const theorizing = new Set<string>();
// The theory they're putting to the test with this try of a way, if they set out to and it holds here (one about the
// spot holds where they chose to do it): a test whose weather has passed is an ordinary try.
const testingNow = (a: Agent, b: Belief, now: string[]) => {
  const test = a.goal?.type.startsWith("test:") ? testOf(a.goal.type) : null;
  return test && test[1] === b.key && (ofSpot(test[0]) || holds(test[0], now)) ? test[0] : null;
};
// How what they did went, counted all told, against each condition they did it in and in the mix of all of them, every
// try kept (beliefs.ts noteTry). A try where a theory of theirs holds is what can tell against it (the record it was
// formed on can't): over a few tries there it has come to do about as well as where the theory doesn't hold, like for
// like (fades), or it worked there (surprised). A failure where no theory of theirs holds, but one would but for a part
// of it, tells against that part (beliefs.ts refuted: it was windy, and it failed in the rain all the same). A failure of
// something that has worked for them sets them wondering what was different: a condition they were in is a suspect once
// it has done worse for them there than without it by more than chance would make it (beliefs.ts worseIn, like for like
// where it can be: the dark is no suspect for the rain that falls mostly at night), or when the failure itself points at
// it (the tinder too damp to catch) and it has done no better there than without it; likelier the worse and the more
// often (or Jev weighs the record itself), and bad luck likelier the more often it usually works. Whatever they settle
// on is their theory until what they see tells against it. text: what they saw of how it failed; done: when they did
// it, for what shows later; took: how long the doing took them, for what showed at once.
function judged(w: World, a: Agent, b: Belief, worked: boolean, now: string[], text: string, done = w.t, took?: number) {
  noteTry(b, worked, now);
  // for measuring how well they choose (scripts/theories.ts): the other ways they know to the same end
  const aimOf = (o: Belief) => o.fields.builds ?? Object.keys(o.out).sort().join("+"), aim = aimOf(b);
  const alts = aim ? Object.values(a.beliefs).filter((o) => o !== b && aimOf(o) === aim).map((o) => o.key) : [];
  const testing = !!testingNow(a, b, now);
  trace("theory", "attempt", { key: b.key, verb: b.fields.verb, now, worked, done, took, testing, ticks: b.ticks, aim, alts }, a.id);
  // with learning off, or every theory known from the start, nothing they see makes or unmakes one
  if (RULES.learning !== "seen") return;
  const hold = b.unless?.filter((t) => holds(t, now)) ?? [], faded = hold.filter((t) => fades(b, t));
  if (faded.length) {
    log(w, "theory", [a.id], a, `${a.name} came to think it makes no difference whether it's done ${faded.map(conditionWords).join(" or ")}: ${sentence(w, b.fields, undefined, b.later)}`);
    trace("theory", "dropped", { key: b.key, conds: faded, how: "record" }, a.id);
    rethink(b, faded);
  }
  if (worked) {
    for (const t of hold.filter((t) => !faded.includes(t))) surprised(w, a, b, t, now);
    return;
  }
  for (const r of refuted(b, now)) {
    refine(b, r.theory, r.to);
    log(w, "theory", [a.id], a, `${a.name} saw it fail all the same, and went back to thinking it won't work ${conditionWords(r.to)}: ${sentence(w, b.fields, undefined, b.later)}`);
    trace("theory", "refined", { key: b.key, from: r.theory, to: r.to, how: "failed" }, a.id);
  }
  const id = `${a.id}|${b.key}`;
  const suspects = suspected(b, now, (c) => condition(c).hint.test(text));
  if (!suspects.length || !b.wins || theorizing.has(id)) return;
  theorizing.add(id);
  const present = Object.fromEntries(suspects.map((c) => [c, `${condition(c).words} (${evidence(b, c)})`]));
  const lean: Record<string, number> = { luck: 1 + 3 * odds(b, null) };
  for (const c of suspects) { const d = apart(b, c); lean[c] = 1 + 10 * d.diff * Math.min(1, d.tries / 2) + (condition(c).hint.test(text) ? 6 : 0); }
  theorize(w, a, sentence(w, b.fields, undefined, b.later), text, present, lean)
    .then((c) => {
      if (!c || !a.beliefs[b.key] || b.unless?.includes(c)) return;
      b.unless = [...(b.unless ?? []), c];
      log(w, "theory", [a.id], a, `${a.name} decided it won't work ${conditionWords(c)}: ${sentence(w, b.fields, undefined, b.later)}`);
      trace("theory", "formed", { key: b.key, cond: c, when: b.when }, a.id);
    })
    .catch(() => {})
    .finally(() => theorizing.delete(id));
}
// What tells a try that worked apart from the failures a theory rests on (beliefs.ts differed), in words: this time
// something held that never did when it failed there, or something that always did, didn't.
const differenceWords = (part: string) => {
  const c = part.replace(/^!/, ""), words = condition(c).words;
  return part.startsWith("!") ? `${words} this time, and never when it failed there` : `Not this time: every time it failed there, ${words[0].toLowerCase()}${words.slice(1)}`;
};
// It worked where a theory of theirs said it wouldn't (now): by their own hand (the try already in their record), or
// before their eyes (by: whom they watched, which their record doesn't hold). If it has worked there at least as often
// as it failed, counting this time, the theory goes. Otherwise it isn't impossible there after all, but the failures
// it rests on aren't forgotten: they keep the theory and wonder what was different this time, something that held now
// and never with those failures, or held with all of them and not now (beliefs.ts differed). Whatever they settle on
// narrows the theory to just where it fails; if nothing, they know only that it works there now and then, and keep
// clear of it there as before, unless they set out to find out more.
function surprised(w: World, a: Agent, b: Belief, t: string, now: string[], by?: Agent) {
  const s = weighs(b, t), so = sentence(w, b.fields, undefined, b.later);
  if (s.wins + (by ? 1 : 0) >= s.fails) {
    log(w, "theory", [a.id], a, by ? `${a.name} watched ${by.name} do it ${conditionWords(t)}, and stopped thinking it couldn't be done: ${so}` : `${a.name} found it works ${conditionWords(t)} after all: ${so}`);
    trace("theory", "dropped", { key: b.key, conds: [t], how: by ? "watched" : "own" }, a.id);
    rethink(b, [t]);
    return;
  }
  const id = `${a.id}|${b.key}`;
  if (theorizing.has(id)) return;
  const options = differed(b, t, now).slice(0, 3);
  trace("theory", "possible", { key: b.key, cond: t, fails: s.fails, wins: s.wins, options: options.map((o) => o.theory), how: by ? "watched" : "own" }, a.id);
  const unsure = () => log(w, "theory", [a.id], a, `${a.name} ${by ? `saw ${by.name} do it` : "did it"} ${conditionWords(t)}, where it had failed ${s.fails} times, and can't say what was different: ${so}`);
  if (!options.length) { unsure(); return; }
  theorizing.add(id);
  const present = Object.fromEntries(options.map((o) => [o.theory, differenceWords(o.part)]));
  const lean = Object.fromEntries(options.map((o) => [o.theory, 1 + 10 * o.agree * Math.min(1, s.fails / 2)]));
  wonder(w, a, so, conditionWords(t), s.fails, present, lean)
    .then((to) => {
      if (!to || !a.beliefs[b.key] || !b.unless?.includes(t)) { unsure(); return; }
      refine(b, t, to);
      log(w, "theory", [a.id], a, `${a.name} worked out what was different, and now thinks it won't work ${conditionWords(to)}: ${so}`);
      trace("theory", "refined", { key: b.key, from: t, to, how: "differed" }, a.id);
    })
    .catch(() => {})
    .finally(() => theorizing.delete(id));
}
// They did what they believe works, and it came off or it didn't (beliefs.ts cameOff). What only shows later (a seed
// pushed into the ground) is judged when it shows (came, withered).
function attempted(w: World, a: Agent, b: Belief, out: Outcome, took: number) {
  if (out.later) return;
  const meant = cameOff(b, out);
  // an outcome that went into the books under another key (a rub that only got hot) still counts against this one
  if (beliefKey(out.fields) !== b.key) { b.tries++; if (meant) b.wins++; }
  const now = conditionsNow(w, a, b.fields.verb);
  judged(w, a, b, meant, now, out.text, w.t, took);
  // put to the test, and it held
  const test = a.goal?.type.startsWith("test:") ? testOf(a.goal.type) : null;
  if (test && test[1] === b.key && !meant && holds(test[0], now)) log(w, "theory", [a.id], a, `${a.name} tried it ${conditionWords(test[0])} to see, and it didn't work, as they'd thought: ${sentence(w, b.fields, undefined, b.later)}`);
}
// Everyone waiting on a thing, done waiting: their entries for it, taken off their lists.
function waitingOn(a: Agent, id: string) {
  const mine = a.waiting?.filter((e) => e.thing === id) ?? [];
  if (mine.length) a.waiting = a.waiting!.filter((e) => e.thing !== id);
  if (!a.waiting?.length) delete a.waiting;
  return mine;
}
// What they did days ago has come up: a seedling grown into a bush. It worked, under the conditions it was done in, and
// the first time it's how they learn it takes days, not hours.
function came(w: World, a: Agent, e: Waiting, at: Thing, builds: string) {
  const b = a.beliefs[e.key];
  if (!b) return;
  const took = w.t - e.t, first = !b.later;
  if (b.fields.verb === "plant") b.fields = { ...b.fields, builds };
  b.later = first ? took : Math.round(b.later! * 0.7 + took * 0.3);
  b.wins++;
  judged(w, a, b, true, e.now, "", e.t);
  b.law ??= (w.laws[b.key] ?? found(w, a, b.fields, b.ticks, false, [], b.later)).id;
  const days = took < DAY * 1.5 ? "a day" : `${Math.round(took / DAY)} days`;
  if (first) log(w, "discover", [a.id], at, b.fields.verb === "plant"
    ? `${a.name} realized the ${nm(w, b.fields.inputs[0])} they pushed into the ground ${days} ago has come up as ${builds === "grass" ? "grass" : an(builds)}.`
    : `${a.name} saw the young plant they watered ${days} ago come up as ${an(builds)}.`);
}
onGrew((w, t, builds) => { for (const a of w.agents) for (const e of waitingOn(a, t.id)) came(w, a, e, t, builds); });
onWithered((w, t, why) => {
  for (const a of w.agents) for (const e of waitingOn(a, t.id)) { const b = a.beliefs[e.key]; if (b) judged(w, a, b, false, e.now, why, e.t); }
});
// Once a day: what they were waiting on that's gone without coming up (burned, broken off for a stick) they stop waiting
// for, as they do anything waited on past all hope, neither telling them why.
function giveUpWaiting(w: World) {
  for (const a of w.agents) {
    if (!a.waiting) continue;
    a.waiting = a.waiting.filter((e) => thingById(w, e.thing) && w.t - e.t < DAY * 30);
    if (!a.waiting.length) delete a.waiting;
  }
}
// A fire burned down to nothing with someone who knows wood feeds a fire sitting by it empty-handed: next time, they'll
// have wood by them before night comes.
onFireOut((w, t, rained) => {
  if (rained) return;
  for (const a of w.agents) {
    if (a.down > w.t || meters(a, t) > FIRESIDE || a.facts.fuel_at_hand) continue;
    const fuel = Object.values(a.beliefs).find((b) => b.fields.builds === "fed_fire" && b.wins > 0)?.fields.inputs[0];
    if (!fuel || count(a, fuel)) continue;
    a.facts.fuel_at_hand = `A fire burns down to nothing unless there's ${plural(nm(w, fuel))} at hand to feed it.`;
    log(w, "learn", [a.id], a, `${a.name} watched the fire burn down with nothing at hand to feed it, and resolved to have ${plural(nm(w, fuel))} by them before night.`);
  }
});

// Everything that follows from an act finishing: beliefs, watchers, the chronicle, skills, names.
function finishAct(w: World, a: Agent, s: Step, out: Outcome, tinkering: boolean) {
  const act = s.act!;
  const ticks = Math.max(1, w.t - (s.started ?? w.t));
  trace("physics", "outcome", { act: actSig(act), ok: out.ok, text: out.text, uses: out.uses, gives: out.gives, builds: out.builds, effect: out.effect, numbers: out.numbers, ticks }, a.id);
  const knew = !!a.beliefs[beliefKey(out.fields)];
  const b = record(w, a, out, ticks);
  // done, with the result to show later: they'll know whether it worked when it does
  if (b && out.ok && out.later) (a.waiting ??= []).push({ key: b.key, thing: out.later, t: w.t, now: conditionsNow(w, a, act.verb, thingById(w, out.later) ?? a) });
  // Whoever lights a fire by rubbing watches the stick they rubbed catch and burn in it: wood feeds a fire.
  if (out.builds === "fire" && act.verb === "rub") {
    const fuel = act.items.find((k) => (out.uses[k] ?? 0) > 0);
    const fed: Fields = { verb: "place", inputs: fuel ? [fuel] : [], at: "fire", builds: "fed_fire", gives: [] };
    if (fuel && !a.beliefs[beliefKey(fed)]) record(w, a, { ok: true, text: "", uses: { [fuel]: 1 }, gives: {}, builds: "fed_fire", fields: fed, newKinds: [] }, 1, "seen");
  }
  // an experiment that came to nothing, or only to what it showed before, is one less thing to try
  if (tinkering && (!b || (!out.ok && knew))) a.tried[actSig(act)] = (a.tried[actSig(act)] ?? 0) + 1;
  // what bears on what they did, as anyone doing it would note it, for those watching who had thought it couldn't be done
  const seenNow = conditionsNow(w, a, act.verb);
  for (const x of watchers(w, a, out, ticks, seenNow)) for (const t of x.theories) surprised(w, x.who, x.b, t, seenNow, a);
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
  if (act.verb === "throw") return act.tool === k ? `shooting ${t}` : act.tool ? `shooting at ${t}` : `throwing at ${t}`;
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
// What someone after each aim would think to gather, by what it's like: what they've seen burn, what would lean
// together or cover, and to better a shelter they have, solid heavy things to wall it in; what is hard or long enough
// to make a tool of.
const roofing = (k?: Kind) => p(k, "long") >= 0.5 || p(k, "fibrous") >= 0.6 || p(k, "insulating") >= 0.3;
const AIM_STUFF: Record<string, (k?: Kind) => boolean> = {
  fire: (k) => p(k, "flammable") >= 0.5,
  shelter: roofing,
  home: (k) => roofing(k) || (p(k, "heavy") >= 0.4 && p(k, "hard") >= 0.5),
  tool: (k) => p(k, "hard") >= 0.5 || p(k, "long") >= 0.5,
};
type Option = { text: string; act: Act };
const AIM: Record<string, (act: Act, w: World) => boolean> = {
  shelter: (act) => act.verb === "place" || act.verb === "dig" || (act.verb === "join" && act.items.length >= 2),
  home: (act) => act.verb === "place" || (act.verb === "join" && act.items.length >= 2),
  fire: (act) => act.verb === "rub" || act.verb === "heat" || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]) || act.verb === "place",
  tool: (act) => act.verb === "join" || act.verb === "rub" || act.verb === "shape" || (act.verb === "strike" && !THING_MATERIAL[act.target?.kind ?? ""]),
  food: (act) => act.verb === "throw" || act.verb === "wet" || act.verb === "plant" || act.verb === "pour" || act.verb === "heat" || (act.verb === "strike" && ["deer", "wolf", "rabbit", "bush"].includes(act.target?.kind ?? "")),
  // at a fire: hold things in it, or set them in and around it
  fireside: (act) => act.verb === "heat" || act.verb === "place",
};
function tinkerOptions(w: World, a: Agent, aim?: string): Option[] {
  const c = counts(a);
  const held = Object.keys(c).filter((k) => !k.startsWith("rotten:"));
  const opts: Option[] = [];
  // What they already know works is no experiment: it's for their plans.
  const known = new Set(Object.values(a.beliefs).filter((b) => b.wins > 0).map((b) => actSig(actFromBelief(b))));
  const push = (act: Act) => { const sig = actSig(act); if ((a.tried[sig] ?? 0) < 2 && !known.has(sig)) opts.push({ text: actText(w, act), act }); };
  // Soft things like berries or fiber don't get swung, dug with, or ground against anything.
  const tools = [null, ...held.filter((k) => p(w.kinds[k], "hard") >= 0.2 || p(w.kinds[k], "heavy") >= 0.3)];
  // What's lying or growing within a stone's throw that they could walk over to and strike.
  const targets: string[] = [];
  around(w, a.px, a.py, 20, STRIKEABLE, (t) => { if (!t.burning) targets.push(t.kind); });
  const animalsNear = w.animals.filter((m) => meters(a, m) <= 60 && m.alt < 2 && THING_MATERIAL[m.species]).map((m) => m.species);
  for (const kind of new Set([...targets, ...animalsNear])) for (const tool of tools) push({ verb: "strike", items: [], tool, target: { kind } });
  const bows = held.filter((k) => stave(w.kinds[k]));
  for (const sp of new Set(w.animals.filter((m) => meters(a, m) <= 120 && m.alt < 2 && THING_MATERIAL[m.species]).map((m) => m.species)))
    for (const x of held) {
      if (p(w.kinds[x], "heavy") >= 0.3 || p(w.kinds[x], "sharp") >= 0.4) push({ verb: "throw", items: [x], target: { kind: sp } });
      if (arrowy(w.kinds[x])) for (const bow of bows) if (bow !== x) push({ verb: "throw", items: [x], tool: bow, target: { kind: sp } });
    }
  if (diggable(w, ...beside(w, a, 1)))
    for (const tool of tools) push({ verb: "dig", items: [], tool });
  for (const x of held) {
    const k = w.kinds[x];
    for (const tool of tools) if (tool !== x || c[x] >= 2) push({ verb: "strike", items: [], tool, target: { kind: x } });
    // Two hard things struck together over something fine and dry held under the blow, as for sparks.
    if (p(k, "hard") >= 0.5)
      for (const tool of tools.filter((t) => !!t && p(w.kinds[t], "hard") >= 0.5 && (t !== x || c[x] >= 2)))
        for (const f of held) if (f !== x && f !== tool && p(w.kinds[f], "fibrous") >= 0.5 && p(w.kinds[f], "flammable") >= 0.5) push({ verb: "strike", items: [f], tool, target: { kind: x } });
    if (within(w, a, "fire", 1)) {
      push({ verb: "heat", items: [x], at: "fire" });
      // Something soft and hollow can be squeezed or flapped at the flames while something else heats.
      for (const f of held) if (f !== x && airy(w.kinds[f])) push({ verb: "heat", items: [x], tool: f, at: "fire" });
    }
    if (openWater(w, a)) push({ verb: "wet", items: [x], at: "water" });
    if (p(k, "plastic") >= 0.6) { push({ verb: "shape", items: [x], shape: "bowl" }); push({ verb: "shape", items: [x], shape: "block" }); }
    if (p(k, "seed") > 0 || p(k, "edible") > 0) push({ verb: "plant", items: [x] });
    // water carried in something: over a young plant within reach, or out on the ground
    if (x.startsWith("full:")) {
      if (anyAround(w, a.px, a.py, 3, ["sapling"])) push({ verb: "pour", items: [x], target: { kind: "sapling" } });
      push({ verb: "pour", items: [x] });
    }
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
  const aimed = aim && AIM[aim] ? opts.filter((o) => AIM[aim](o.act, w)) : opts;
  return (aimed.length ? aimed : opts).sort(() => Math.random() - 0.5).slice(0, 100);
}
const tinkerWait = new Set<string>();

// ---------- running plan steps ----------
const GATHER_STATUS: Record<string, string> = {
  pick_berries: "Picking berries", pick_mushroom: "Gathering a mushroom", pick_herb: "Picking herbs", pick_stick: "Picking up a stick",
  pick_stone: "Picking up a stone", pull_reeds: "Pulling up reeds", dig_clay: "Digging clay", scrape_resin: "Scraping resin off a tree",
  strip_grain: "Stripping seed from the grass",
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
      a.status = `Keeping away from ${b.name}${shunReason(a, b)}`;
      // they walk off from someone they'd rather not meet, and run only from someone they fear
      stepAway(w, a, b, a.goal?.type === "flee" || (a.rel[b.id]?.beliefs.dangerous ?? 0) > 0.7);
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
      for (const b of seen) reflect(w, b, a, `I saw ${text}`, { feel: -1 }).catch(() => {});
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
          reflect(w, b, a, text, { feel: 2, bond: "saved_my_life" }).then((r) => { if (r.bond !== "none") log(w, "bond", [b.id], b, `${b.name} will remember this about ${a.name}: ${r.bond.replaceAll("_", " ")}.`); }).catch(() => {});
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
      // close enough to share warmth (needs: two meters)
      stepToward(w, a, b.px, b.py, 1.5);
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
      // What they've come to think won't work in the weather now, they don't start, or keep at once the weather turns
      // partway through (the rain coming on as they strike), unless it's what they set out to test, there and then: a
      // test whose weather has passed is an ordinary try, held to every theory of theirs like any other. (The spot was
      // weighed when they chose it.)
      const now = conditionsNow(w, a, b.fields.verb);
      if (!testingNow(a, b, now)) {
        const bar = b.unless?.find((t) => !ofSpot(t) && holds(t, now));
        if (bar) return `they think it won't work ${conditionWords(bar)}`;
      }
      s.act ??= actFromBelief(b);
      const r = doAct(w, a, s);
      if (r === "wait") return false;
      if (typeof r === "string") return r;
      finishAct(w, a, s, r, false);
      attempted(w, a, b, r, Math.max(1, w.t - (s.started ?? w.t)));
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
  } else if (g.place === "grain") {
    // stripping the heads leaves the tuft standing
    t.hp = (t.hp ?? 3) - 1;
    mark(w, t);
  } else removeThing(w, t);
  giveItems(w, a, g.item, n);
  // what is carried off a plant is taken from the soil it grew on
  if (t.kind === "bush" || t.kind === "mushroom" || t.kind === "herb" || t.kind === "reeds") enrich(w, t.px, t.py, -0.004 * n);
  if (t.kind === "bush" || t.kind === "mushroom" || t.kind === "herb") gain(w, a, "foraging", 2);
  log(w, "gather", [a.id], a, `${a.name} gathered ${n > 1 ? `${n} ${plural(nm(w, g.item))}` : an(nm(w, g.item))}.`);
  return true;
}

// ---------- people ----------
// Someone fond of another, or kin, or sweet on them, might ask to live in their shelter: one close by, with room to
// spare, better than any of their own.
function canMoveIn(w: World, a: Agent, b: Agent) {
  const h = homeOf(w, b), mine = homeOf(w, a), r = a.rel[b.id];
  if (!h || h === mine || (h.shelter?.tier ?? 0) < 1 || meters(a, h) > HOME_NEAR || residentsOf(w, h).length >= (h.shelter?.room ?? 1)) return false;
  const close = (r?.affinity ?? 0) > 0.4 || r?.label === "kin" || r?.label === "sweetheart";
  return close && (!mine || meters(a, mine) > HOME_NEAR || (mine.shelter?.tier ?? 0) < (h.shelter?.tier ?? 0));
}
// Why someone keeps away from another, in a few words: the worst wrong they remember of them, how they feel, or their
// own nature.
const WRONG_WORDS: Partial<Record<BondKind, string>> = {
  stole_from_me: "who stole from them", humiliated_me: "who mocked them", lied_to_me: "who lied to them",
  destroyed_my_home: "whose fire burned their home", refused_me: "who turned them away", rival: "their rival",
};
function shunReason(a: Agent, b: Agent) {
  const r = a.rel[b.id];
  const worst = r?.bonds.filter((x) => WRONG_WORDS[x.kind]).sort((x, y) => y.weight - x.weight)[0];
  if (worst) return `, ${WRONG_WORDS[worst.kind]}`;
  if (grudge(a, b.id) > 0.3) return ", whom they dislike";
  return a.traits.loner || a.traits.shy ? ", keeping to themselves" : "";
}
// Whether knowing this would help someone with what they're going short of: a fire, a roof or something to wrap up in
// for the cold; food, or a way to grow or trap it, for hunger.
const WARMS = ["fire", "hearth", "shelter", "worn"];
function answers(w: World, b: Belief, who: Agent) {
  if (who.needs.warmth < 50 && WARMS.includes(b.fields.builds ?? "")) return true;
  return who.needs.food < 50 && (Object.keys(b.out).some((k) => p(w.kinds[k], "edible") >= 0.1) || b.fields.builds === "bush" || b.fields.builds === "trap");
}
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
  reflect(w, v, defender, text, { feel: 2, bond: "defended_me" }).then((r) => {
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
  // how it landed on each of them, for an offline reflection (Jev reads the event itself)
  const felt: { a: Felt; b: Felt } = { a: {}, b: {} };
  const rebuffed = () => { felt.a = { feel: -1, bond: "refused_me" }; };
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
        felt.a = felt.b = { feel: 1 };
        text = `${a.name} and ${b.name}${first ? " met for the first time and" : ""} talked for a while.${story ? ` ${a.name} told ${b.name} about this: "${story.replace(/^Day \d+, \w+: /, "")}"` : ""}`;
      } else { turnedAway = true; rebuffed(); text = `${a.name} tried to talk to ${b.name}, but ${b.name} brushed them off.`; }
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
        felt.b = { feel: 1, bond: "gave_me_food" }; felt.a = { feel: 0.5, bond: "owes_me" };
        text = `${a.name} gave ${b.name} ${n} ${nm(w, item)}.${b.needs.food < 25 && p(w.kinds[item], "edible") ? ` ${b.name} was starving.` : ""}`;
      } else { turnedAway = true; rebuffed(); text = `${b.name} refused ${a.name}'s gift of ${nm(w, item)}.`; }
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
        felt.a = felt.b = { feel: 0.5 };
        text = `${a.name} traded 1 ${nm(w, give)} to ${b.name} for 1 ${nm(w, want)}.`;
      } else { turnedAway = true; felt.a = { feel: -0.5 }; text = `${b.name} turned down ${a.name}'s offer to trade ${nm(w, give)} for ${nm(w, want)}.`; }
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
        felt.a = felt.b = { feel: 1, bond: "shared_a_meal" };
        text = `${a.name} shared ${an(nm(w, f))} with ${b.name} and they ate together.`;
      } else { turnedAway = true; rebuffed(); text = `${b.name} declined ${a.name}'s offer to eat together.`; }
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
        felt.a = felt.b = { feel: 1, bond: "shared_a_fire" };
        text = `${a.name} and ${b.name} sat by the fire together.`;
      } else { turnedAway = true; felt.a = { feel: -0.5 }; text = `${b.name} declined ${a.name}'s invitation to sit by the fire.`; }
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
        felt.b = { feel: 1, bond: "helped_me_work" }; felt.a = { feel: 0.5 };
        text = `${a.name} started helping ${b.name} ${what}.`;
      } else { turnedAway = true; felt.a = { feel: -0.5 }; text = `${b.name} turned down ${a.name}'s offer to help.`; }
      break;
    }
    case "teach": {
      const options = Object.keys(a.beliefs).filter((k) => !b.beliefs[k] && a.beliefs[k].wins > 0);
      if (!options.length) return;
      // What they show: what has served them most often, and above all what the other is going short of for want of it.
      const key = sample(Object.fromEntries(options.map((k) => [k, (1 + Math.min(10, a.beliefs[k].wins)) * (answers(w, a.beliefs[k], b) ? 4 : 1)])), 1);
      const what = sentence(w, a.beliefs[key].fields).replace(/\.$/, "");
      const ans = await reply(`${a.name} offers to show ${b.name} something they know: ${what}.`, { accept: "Learn from them", refuse: "Not interested" });
      if (ans === "accept") {
        teach(w, a, b, key);
        spread(w, a, b);
        gain(w, a, "teaching", 4);
        b.rel[a.id].ledger++; ra.ledger--;
        warm = true;
        deed = { act: "teach", value: 0.3 };
        felt.b = { feel: 1, bond: "taught_me" }; felt.a = { feel: 0.5 };
        text = `${a.name} showed ${b.name} that ${what.charAt(0).toLowerCase() + what.slice(1)}.${a.beliefs[key].spurious ? ` ${a.name} insisted you have to hold ${an(nm(w, a.beliefs[key].spurious!))} for it to work.` : ""}`;
      } else { turnedAway = true; felt.a = { feel: -0.5 }; text = `${b.name} wasn't interested when ${a.name} offered to show them something.`; }
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
        felt.a = { feel: 1.5, bond: "gave_me_food" }; felt.b = { feel: 0.5, bond: "owes_me" };
        text = `${a.name} asked ${b.name} for food, and ${b.name} gave them ${an(nm(w, food))}.`;
      } else {
        turnedAway = true;
        deed = { act: "refused_food", value: Math.max(0.1, (50 - a.needs.food) / 50), by: b, against: a };
        felt.a = { feel: -1.5, bond: "refused_me" };
        text = `${a.name} asked ${b.name} for food, and ${b.name} refused${a.needs.food < 25 ? ", though they were starving" : ""}.`;
      }
      break;
    }
    case "ask_help": {
      // What they can't manage, and what the one asked could do about it: share food, a fire or a roof, show how they
      // manage it themselves, or simply stay close to share their body's warmth, or go out looking for food with them.
      const need = struggling(a);
      if (!need) return;
      const plight = { food: "can't find enough to eat", warmth: "can't get warm", energy: "can't get any rest" }[need];
      const h = homeOf(w, b), fire = spot(w, b, "fire"), food = bestFood(w, b), search = need === "food" ? planGoal(w, a, "forage") : null;
      const roomy = !!h && (h.shelter?.tier ?? 0) >= 1 && meters(b, h) <= HOME_NEAR && residentsOf(w, h).length < (h.shelter?.room ?? 1);
      const lessons = Object.keys(b.beliefs).filter((k) => !a.beliefs[k] && b.beliefs[k].wins > 0 && answers(w, b.beliefs[k], a));
      const opts: Record<string, string> = {};
      if (need === "food" && food) opts.give = `Give ${a.name} some food`;
      if (search?.length) opts.forage_with = `Go out looking for food with ${a.name}`;
      if (need !== "food" && fire && meters(b, fire) <= 100) opts.share_fire = `Bring ${a.name} to the fire`;
      if (need !== "food" && roomy) opts.take_in = `Take ${a.name} into their ${shelterName(w, h!)}`;
      if (need !== "food") opts.huddle = `Keep ${a.name} close, to share their warmth`;
      if (lessons.length) opts.show = `Show ${a.name} how they manage it themselves`;
      opts.refuse = "Turn them away";
      const r = await reply(`${a.name} comes to ${b.name} for help: ${a.name} ${plight}, and nothing they've tried on their own has worked.`, opts);
      if (r === "refuse") {
        turnedAway = true;
        felt.a = { feel: -1.5, bond: "refused_me" };
        deed = { act: "refused_help", value: Math.max(0.1, (40 - a.needs[need]) / 40), by: b, against: a };
        text = `${a.name} came to ${b.name} for help because they ${plight}, and ${b.name} turned them away.`;
        break;
      }
      warm = true;
      delete a.struggles?.[need];
      b.rel[a.id].ledger--; ra.ledger++;
      if (r === "give" && food) {
        takeItems(b, food); giveItems(w, a, food);
        felt.a = { feel: 1.5, bond: "gave_me_food" }; felt.b = { feel: 0.5 };
        deed = { act: "give", value: valueOf(w, food), items: [food], by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} gave them ${an(nm(w, food))}.`;
      } else if (r === "share_fire") {
        for (const x of [a, b]) { x.goal = { type: "warm_up", since: w.t, odds: {}, fails: 0 }; x.plan = [{ op: "goto", arg: "fire", progress: 0 }, { op: "warm_up", progress: 0 }]; }
        felt.a = { feel: 1.5, bond: "shared_a_fire" }; felt.b = { feel: 0.5, bond: "shared_a_fire" };
        deed = { act: "share", value: 0.3, by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} brought them to the fire to get warm.`;
      } else if (r === "take_in" && h) {
        const mine = homeOf(w, a);
        if (mine && mine !== h) leaveHome(w, a, mine);
        a.home = h.id;
        a.goal = { type: "warm_up", since: w.t, odds: {}, fails: 0 };
        a.plan = [{ op: "goto", arg: "home", progress: 0 }, { op: "warm_up", progress: 0 }];
        felt.a = { feel: 2, bond: "saved_my_life" }; felt.b = { feel: 0.5 };
        deed = { act: "take_in", value: 0.5, by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} took them into their ${shelterName(w, h)} to live.`;
      } else if (r === "huddle") {
        a.goal = { type: "stay_close", target: b.id, since: w.t, odds: {}, fails: 0 };
        a.plan = [{ op: "follow", arg: b.id, progress: 0 }];
        felt.a = { feel: 1.5, bond: "shared_a_fire" }; felt.b = { feel: 0.5 };
        deed = { act: "share", value: 0.2, by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} kept them close to share their warmth.`;
      } else if (r === "forage_with" && search?.length) {
        a.goal = { type: "forage", since: w.t, odds: {}, fails: 0 };
        a.plan = search;
        b.goal = { type: "help", target: a.id, since: w.t, odds: {}, fails: 0 };
        b.plan = [{ op: "assist", arg: a.id, progress: 0 }];
        felt.a = { feel: 1, bond: "helped_me_work" }; felt.b = { feel: 0.5 };
        deed = { act: "share", value: 0.2, by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} went out looking for food with them.`;
      } else if (lessons.length) {
        const key = sample(Object.fromEntries(lessons.map((k) => [k, 1 + Math.min(10, b.beliefs[k].wins)])), 1);
        teach(w, b, a, key);
        felt.a = { feel: 1.5, bond: "taught_me" }; felt.b = { feel: 0.5 };
        deed = { act: "teach", value: 0.3, by: b, against: a };
        text = `${a.name} came to ${b.name} for help, and ${b.name} showed them that ${lower(sentence(w, b.beliefs[key].fields))}`;
      }
      break;
    }
    case "move_in": {
      const h = homeOf(w, b);
      if (!h || !canMoveIn(w, a, b)) return;
      const r = await reply(`${a.name} asks to come and live with ${b.name} in their ${shelterName(w, h)}.`, { welcome_in: "Make room for them", refuse: "Say no" });
      if (r === "welcome_in") {
        const mine = homeOf(w, a);
        if (mine) leaveHome(w, a, mine);
        a.home = h.id;
        warm = true;
        felt.a = { feel: 1.5 }; felt.b = { feel: 0.5 };
        deed = { act: "take_in", value: 0.4, by: b, against: a };
        text = `${b.name} made room for ${a.name}, who came to live with them in their ${shelterName(w, h)}.`;
      } else { turnedAway = true; rebuffed(); text = `${b.name} wouldn't have ${a.name} living with them.`; }
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
      felt.a = felt.b = { feel: r === "believe" ? 0.5 : 0 };
      if (lie && r === "doubt") felt.b = { feel: -1, bond: "lied_to_me" };
      break;
    }
    case "insult": {
      const r = await reply(`${a.name} insults and mocks ${b.name}.`, { shrug: "Shrug it off", insult_back: "Insult them back", walk_away: "Walk away hurt" });
      b.needs.social = Math.max(0, b.needs.social - 10);
      deed = { act: "insult", value: 0.1 };
      felt.b = { feel: -1.5, bond: "humiliated_me" }; felt.a = r === "insult_back" ? { feel: -1, bond: "humiliated_me" } : { feel: -0.5 };
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
      felt.b = { feel: -2, bond: "rival" }; felt.a = { feel: -1, bond: "rival" };
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
      felt.b = { feel: r === "let_it_go" ? -1 : -2, bond: "stole_from_me" }; felt.a = { feel: -0.5 };
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
    return reflect(w, x, other, text, x === a ? felt.a : felt.b).then((r) => {
      if (r.bond !== "none") log(w, "bond", [x.id], x, `${x.name} will remember this about ${other.name}: ${r.bond.replaceAll("_", " ")}. They now see ${other.name} as ${an(x.rel[other.id].label)}.`);
    });
  }));
}

function burned(w: World) {
  for (const b of burnedHomes.splice(0)) {
    const owner = agentById(w, b.owner), lighter = agentById(w, b.by);
    if (!owner || !lighter || owner === lighter) continue;
    const text = `${lighter.name}'s fire spread and burned down ${owner.name}'s home.`;
    log(w, "burned", [owner.id, lighter.id], owner, text);
    incident(w, { act: "burned_home", by: lighter, against: owner, at: owner, text, value: 1, seenBy: [owner, ...w.agents.filter((b) => canSee(w, b, owner, VISION))] });
    reflect(w, owner, lighter, text, { feel: -2, bond: "destroyed_my_home" }).then((r) => {
      if (r.bond !== "none") log(w, "bond", [owner.id], owner, `${owner.name} will remember this about ${lighter.name}: ${r.bond.replaceAll("_", " ")}.`);
    }).catch(() => {});
  }
}

// ---------- needs ----------
function needs(w: World, a: Agent) {
  const n = a.needs, night = isNight(w.t), wx = w.weather;
  if (a.struggles) for (const k of Object.keys(a.struggles) as Need[]) if (n[k] > 60) delete a.struggles[k];
  n.food = Math.max(0, n.food - 0.12 - (a.sickness ? 0.05 : 0));
  n.energy = Math.max(0, n.energy - (night ? 0.16 : 0.1));
  n.social = Math.max(0, n.social - 0.05);
  const worn = a.wearing ? p(w.kinds[a.wearing.k], "insulating") : 0;
  // Walls keep the cold off whoever is in them, whoever put them up: their own home, or any lean-to or better they're in.
  const own = homeOf(w, a), sheltering = (t: Thing) => (t.shelter?.tier ?? 0) >= 1 && reaches(a, t);
  const roof = own && sheltering(own) ? own : nearestThing(w, a.px, a.py, ["structure"], sheltering, 6);
  const inside = !!roof, air = airOn(w, a, inside);
  // Below 12C the body loses heat, the faster the harder the wind blows, and faster still wet through; above it, the
  // air gives some back.
  const cold = Math.max(0, (12 - air.feels) / 110) * (night ? 1.2 : 1) * ((wx.sky === "rain" || wx.sky === "storm") && !inside ? 1.3 : 1) * (1 - worn * 0.6);
  const mild = Math.max(0, (air.temp - 12) / 60);
  const fire = nearest(a, liveThings(w), (t) => t.kind === "fire" || (t.burning ?? 0) > 0.3);
  let heat = 0;
  if (fire && meters(a, fire) <= (fire.contained ? 5 : 4)) heat += fire.contained ? 1.1 : 0.9;
  if (roof) heat += 0.2 + (roof.shelter?.insul ?? 0) * 0.8 + (roof.shelter?.tier ?? 0) * 0.1;
  if (night) heat += Math.min(2, w.agents.filter((b) => b !== a && meters(a, b) <= 2).length) * 0.25;
  // Out in the sun a body soaks up warmth: a clear midday sun (some 60,000 lux) all but makes up for a cool breeze.
  else if (!inside) heat += 0.05 * Math.min(1, lightOn(w, a).lux / 60000);
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
  // with no fire or roof to reach, and none to be lit in the rain, anyone who knows how throws up a lean-to
  if (n.warmth < 15) tries.push("warm_up", "make_fire", "build_shelter");
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
    struggled(a, "warm_up", w);
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
    // a test is done once it has been tried, whatever came of it
    if (a.goal.type.startsWith("test:") && step.op === "act" && step.key === testOf(a.goal.type)[1]) { endGoal(w, a, true); return; }
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
  if (w.t % DAY === DAY / 2) { timed("shelve", () => shelve(w)); giveUpWaiting(w); }
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
  strip_grain: "forage",
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
      if (act?.verb === "plant" || act?.verb === "pour") return "plant";
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
