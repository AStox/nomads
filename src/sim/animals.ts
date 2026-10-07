// What the animals do each tick: graze, wander, flee, hunt, swim, fly, perch and feed. Speeds are meters a tick of
// five minutes' game time, the way a person's are; what each kind is like is in fauna.ts.
import { THING_MATERIAL } from "./materials";
import { TILE_M, H, W, dryAt, groundOf, shoreByTile, shoreOf, isNight, landing, log, meters, walkable, wetAt, type Agent, type Animal, type AnimalSpecies, type Thing, type World } from "./world";
import { SIZE } from "../terrain/flora";
import { snowAt } from "./air";
import { breeding, coldBite, warmRate } from "./cues";
import { anyOf, liveThings, nearestThing, onPath, put, thingById } from "./space";
import { steer } from "./walk";
import { dropPile, mark, removeThing } from "./physics";
import { see } from "./beliefs";
import { trace } from "./trace";
import { FAUNA, addAnimal } from "./fauna";
import { DARK, lightOn } from "./light";

// Agents being attacked this tick, agent id -> wolf id.
export const attacked = new Map<string, string>();

type Near = { awake: Agent[]; fires: Thing[]; wolves: Animal[]; deer: Animal[]; rabbits: Animal[]; eagles: Animal[]; fish: Animal[] };
function closest<T extends { px: number; py: number }>(from: { px: number; py: number }, list: readonly T[], r: number, ok: (t: T) => boolean = () => true) {
  let best: T | null = null, bd = r;
  for (const o of list) { const d = meters(from, o); if (d <= bd && o !== (from as unknown) && ok(o)) { bd = d; best = o; } }
  return best;
}
const ground = (w: World, x: number, y: number) => walkable(w, x, y);
const air = () => true;
const passOf = (sp: AnimalSpecies) => (FAUNA[sp].ground ? ground : air);
// Where each kind can be at a point: fish in standing water, anything that walks on dry ground or ice, birds anywhere.
const pointOf = (sp: AnimalSpecies) => (sp === "fish" ? wetAt : FAUNA[sp].ground ? dryAt : air);
function face(an: Animal) { an.dx = Math.round(Math.cos(an.heading)); an.dy = Math.round(Math.sin(an.heading)); }
function setState(w: World, an: Animal, s: string) { if (an.state !== s) { an.state = s; an.since = w.t; } }
const inState = (w: World, an: Animal) => w.t - (an.since ?? w.t);
// A fixed per-animal number below n, so a flock doesn't fly at one height or wake all at once.
const quirk = (an: Animal, n: number) => (Math.imul(Number(an.id.slice(1)) || 1, 2654435761) >>> 0) % n;
function goTo(w: World, an: Animal, tx: number, ty: number, speed: number) { steer(w, an, tx, ty, speed, passOf(an.species), pointOf(an.species), an.species === "deer" || an.species === "wolf"); face(an); }
function away(w: World, an: Animal, from: { px: number; py: number }, speed: number) {
  const d = Math.hypot(an.px - from.px, an.py - from.py) || 1e-6;
  goTo(w, an, an.px + ((an.px - from.px) / d) * 0.2, an.py + ((an.py - from.py) / d) * 0.2, speed);
}
// A point pulled back inside the map, so nothing heads for somewhere it can never reach.
const onMap = (x: number, y: number): [number, number] => [Math.max(0.05, Math.min(W - 0.05, x)), Math.max(0.05, Math.min(W - 0.05, y))];
// Amble about near home, keeping one heading for a while.
function roam(w: World, an: Animal, r: number, speed: number, odds = 0.35) {
  const home = an.home ?? [an.px, an.py];
  if (!an.aim || Math.hypot(an.aim[0] - an.px, an.aim[1] - an.py) * TILE_M < 1 || Math.random() < 0.02) {
    const a = Math.random() * Math.PI * 2, d = (Math.random() * r) / TILE_M;
    an.aim = onMap(home[0] + Math.cos(a) * d, home[1] + Math.sin(a) * d);
  }
  if (Math.random() < odds) goTo(w, an, an.aim[0], an.aim[1], speed);
}
function carcass(w: World, an: Animal) {
  w.animals = w.animals.filter((x) => x !== an);
  for (const [k, n] of Object.entries(THING_MATERIAL[an.species]?.breaks ?? {})) dropPile(w, an.px, an.py, k, n);
}
const lift = (an: Animal, to: number, rate: number) => { an.alt = Math.round((an.alt + Math.max(-rate, Math.min(rate, to - an.alt))) * 10) / 10; };

// Grazing crops the grass tufts close by, down to a stub that grows back in its own time.
function nibble(w: World, an: Animal) {
  if (Math.random() > 0.02) return;
  const t = nearestThing(w, an.px, an.py, ["grass"], (g) => (g.hp ?? 0) > 1, 2);
  if (!t) return;
  t.hp = (t.hp ?? 3) - 1; t.size = Math.round(t.size * 80) / 100; mark(w, t);
}

// How much a grazer finds to eat at a point, 0..1 (the generator's cover): the grass the snow leaves to get at, and the
// twigs, buds and bark of shrubs and young trees, which stand above it.
function grassAt(w: World, px: number, py: number) {
  const { fine } = groundOf(w.seed), x = px * TILE_M - SIZE / 2, z = py * TILE_M - SIZE / 2, snow = snowAt(w, px, py);
  const browse = fine.fine(fine.cover.shrub, x, z) * 0.6 + fine.fine(fine.cover.tree, x, z) * 0.3;
  return Math.min(1, fine.fine(fine.cover.grass, x, z) * (1 - 0.7 * snow) + browse * (1 - 0.3 * snow));
}
const forage = (w: World, an: Animal) => grassAt(w, an.px, an.py);
// Better grazing than here, if there is any: the best of a few dry points out to r meters.
function pasture(w: World, an: Animal, r: number): [number, number] | null {
  let best: [number, number] | null = null, bv = forage(w, an) + 0.1;
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2, d = ((0.3 + Math.random() * 0.7) * r) / TILE_M, [x, y] = onMap(an.px + Math.cos(a) * d, an.py + Math.sin(a) * d);
    if (!dryAt(w, x, y)) continue;
    const v = grassAt(w, x, y);
    if (v > bv) { bv = v; best = [x, y]; }
  }
  return best;
}

function deer(w: World, d: Animal, n: Near) {
  // the cold burns more of what a deer has eaten, and the grass grows little in it
  const cold = coldBite(w.weather.temp);
  d.hunger -= 0.05 + 0.05 * cold;
  const threat = closest(d, n.wolves, 60) ?? closest(d, n.awake, 30);
  if (threat || d.hp < d.maxHp * 0.6) {
    setState(w, d, "flee");
    // A deer bolts only a few ticks before it has to slow to a trot.
    if (threat) away(w, d, threat, inState(w, d) > 4 ? 2 : FAUNA.deer.run);
    else roam(w, d, 40, FAUNA.deer.walk);
  } else {
    const food = d.hunger < 90 ? forage(w, d) : 0, grass = food > 0.25;
    setState(w, d, grass ? "graze" : "wander");
    if (grass) { d.hunger = Math.min(100, d.hunger + 0.35 * Math.min(1, food * 1.6) * (0.35 + 0.65 * warmRate(w.weather.temp))); nibble(w, d); }
    // Where the grass is poor, a hungry deer moves on to better and keeps to it.
    if (!grass && d.hunger < 85 && Math.random() < 0.05) { const better = pasture(w, d, 400); if (better) { d.home = better; d.aim = better; } }
    const mate = closest(d, n.deer, 200);
    if (mate && meters(d, mate) > 25 && Math.random() < 0.3) goTo(w, d, mate.px, mate.py, FAUNA.deer.walk);
    else if (!grass || Math.random() < 0.15) roam(w, d, 60, FAUNA.deer.walk);
    if (breeding(w.t) && mate && meters(d, mate) <= 10 && d.hunger > 55 && n.deer.length < 18 && Math.random() < 1 / 400) {
      n.deer.push(addAnimal(w, "deer", d.px, d.py, { home: d.home }));
      log(w, "birth", [], d, "A fawn was born.");
    }
  }
  if (d.hunger <= 0) { carcass(w, d); log(w, "death", [], d, "A deer starved."); }
}

// A wolf eats its fill at a kill and goes days before it needs another; a pack takes a deer every few days.
function wolf(w: World, wf: Animal, n: Near) {
  const cold = coldBite(w.weather.temp);
  wf.hunger -= 0.035 + 0.02 * cold;
  const fire = closest(wf, n.fires, 40), crowd = n.awake.filter((a) => meters(a, wf) <= 15).length >= 2;
  if (fire || crowd || wf.hp < wf.maxHp * 0.4) {
    setState(w, wf, "flee");
    const from = fire ?? closest(wf, n.awake, 30);
    if (from) away(w, wf, from, FAUNA.wolf.run);
    wf.target = undefined;
    return;
  }
  const meat = wf.hunger < 70 ? nearestThing(w, wf.px, wf.py, ["item"], (t) => t.item === "meat" || !!t.item?.startsWith("rotten:meat"), 80) : null;
  if (meat) {
    setState(w, wf, "eat");
    if (meters(wf, meat) <= 1.5) {
      meat.n = (meat.n ?? 1) - 1; wf.hunger = Math.min(100, wf.hunger + 30); mark(w, meat);
      if (meat.n <= 0) removeThing(w, meat);
    } else goTo(w, wf, meat.px, meat.py, FAUNA.wolf.walk * 2);
    return;
  }
  // whichever is nearer of a deer in sight or a rabbit close by
  const deerNear = wf.hunger < 50 ? closest(wf, n.deer, 400) : null, rabbitNear = wf.hunger < 50 ? closest(wf, n.rabbits, 200) : null;
  const prey = deerNear && rabbitNear ? (meters(wf, deerNear) < meters(wf, rabbitNear) ? deerNear : rabbitNear) : deerNear ?? rabbitNear;
  const lone = (a: Agent) => n.awake.every((b) => b === a || meters(a, b) > 30) && !closest(a, n.fires, 40);
  // A starving wolf takes anyone alone; a hungry one only someone out alone in the dark, or in a hard frost.
  const stalks = (a: Agent) => wf.hunger < 12 || (wf.hunger < 25 && (cold > 0.8 || lightOn(w, a).bright < DARK));
  const person = !prey && wf.hunger < 30 ? closest(wf, n.awake, 150, (a) => lone(a) && stalks(a)) : null;
  const target: Animal | Agent | null = person ?? prey;
  // Nothing in sight: a hungry pack follows the scent of the nearest herd, or of rabbits, and settles where it hunts.
  const scent = !target && wf.hunger < 50 ? closest(wf, n.deer, 3000) ?? closest(wf, n.rabbits, 1500) : null;
  if (scent) {
    setState(w, wf, "hunt"); wf.target = undefined;
    wf.home = [scent.px, scent.py];
    goTo(w, wf, scent.px, scent.py, FAUNA.wolf.walk * 2);
    return;
  }
  if (!target) {
    setState(w, wf, "wander"); wf.target = undefined;
    const pack = closest(wf, n.wolves, 300);
    if (pack && meters(wf, pack) > 30 && Math.random() < 0.3) goTo(w, wf, pack.px, pack.py, FAUNA.wolf.walk);
    else roam(w, wf, 150, FAUNA.wolf.walk);
    return;
  }
  setState(w, wf, "hunt");
  if (meters(wf, target) > 2) { goTo(w, wf, target.px, target.py, FAUNA.wolf.run); return; }
  setState(w, wf, "attack");
  if ("species" in target) {
    target.hp -= 6;
    if (target.hp <= 0) {
      carcass(w, target);
      log(w, "death", [], target, `Wolves brought down a ${target.species}.`);
      if (target.species === "deer") see(w, target, "breaks:deer", "A deer can be killed. It's all meat, hide, and bone inside.", 90);
    }
  } else {
    target.needs.health = Math.max(0, target.needs.health - 5);
    if (wf.target !== target.id) log(w, "wolf", [target.id], target, `A wolf attacked ${target.name}!`);
    wf.target = target.id;
    attacked.set(target.id, wf.id);
    trace("animal", "attack", { wolf: wf.id, victim: target.id, health: target.needs.health }, target.id);
  }
}

function rabbit(w: World, r: Animal, n: Near) {
  const diving = n.eagles.find((e) => e.state === "dive" && meters(e, r) < 30);
  const threat = closest(r, n.awake, 15) ?? closest(r, n.wolves, 40) ?? diving ?? null;
  // A rabbit bolts a few ticks, then freezes flat and hopes not to be seen.
  if (threat) { setState(w, r, "flee"); if (inState(w, r) <= 3) away(w, r, threat, FAUNA.rabbit.run); return; }
  setState(w, r, forage(w, r) > 0.25 ? "graze" : "wander");
  if (r.state === "graze") nibble(w, r);
  // Grazing rabbits sit still, then hop a couple of meters.
  roam(w, r, 25, 2, 0.12);
}

function fish(w: World, f: Animal) {
  setState(w, f, "swim");
  roam(w, f, 25, Math.random() < 0.05 ? FAUNA.fish.run : FAUNA.fish.walk, 0.6);
}

// A random point along the water's edge within r meters of a place.
function shoreNear(w: World, from: [number, number], r: number): [number, number] | null {
  const s = shoreOf(w);
  for (let tries = 0; tries < 60 && s.length; tries++) {
    const c = s[Math.floor(Math.random() * s.length)];
    if (Math.hypot(c.px - from[0], c.py - from[1]) * TILE_M <= r) return [c.px, c.py];
  }
  return edgeNear(w, { px: from[0], py: from[1] }, r);
}
// Up and away to aim, landing on arrival; returns true while still in the air.
function flight(w: World, an: Animal, cruise: number, land = 0) {
  if (!an.aim) return false;
  const d = Math.hypot(an.aim[0] - an.px, an.aim[1] - an.py) * TILE_M;
  if (d > 30) lift(an, cruise, 4);
  else lift(an, land, 3);
  if (d > 0.5) goTo(w, an, an.aim[0], an.aim[1], FAUNA[an.species].fly! * (an.alt > 2 ? 1 : 0.3));
  return d > 0.5 || Math.abs(an.alt - land) > 0.05;
}

// At the water's edge: standing water within a meter of the point, the shallows a heron wades.
const atEdge = (w: World, x: number, y: number) =>
  wetAt(w, x, y) || [0, 1, 2, 3, 4, 5, 6, 7].some((k) => wetAt(w, x + Math.cos((k * Math.PI) / 4) / TILE_M, y + Math.sin((k * Math.PI) / 4) / TILE_M));
// The nearest point along the water's edge within r meters, from the island's shore points: only the tiles within r
// are looked at, and among equally near points the first in shoreOf's order wins, as a scan of the whole coast would.
function edgeNear(w: World, from: { px: number; py: number }, r: number): [number, number] | null {
  const s = shoreOf(w), g = shoreByTile(w), reach = Math.ceil(r / TILE_M), x0 = Math.floor(from.px), y0 = Math.floor(from.py);
  let best = -1, bd = r;
  for (let y = Math.max(0, y0 - reach); y <= Math.min(H - 1, y0 + reach); y++)
    for (let x = Math.max(0, x0 - reach); x <= Math.min(W - 1, x0 + reach); x++)
      for (const i of g[y * W + x]) { const d = meters(from, s[i]); if (d < bd || (d === bd && i < best)) { bd = d; best = i; } }
  return best >= 0 ? [s[best].px, s[best].py] : null;
}
function heron(w: World, h: Animal, n: Near) {
  if (h.state === "fly") {
    if (!flight(w, h, 15)) { h.alt = 0; setState(w, h, atEdge(w, h.px, h.py) ? "wade" : "wander"); }
    return;
  }
  if (closest(h, n.awake, 30)) {
    h.aim = shoreNear(w, h.home ?? [h.px, h.py], 500) ?? h.aim;
    setState(w, h, "fly");
    return;
  }
  if (isNight(w.t)) { setState(w, h, "rest"); return; }
  // Off the edge: walk back to it if it's close, fly to the nearest stretch of shore if not.
  if (!atEdge(w, h.px, h.py)) {
    const edge = edgeNear(w, h, 600);
    if (!edge) { setState(w, h, "wander"); return; }
    if (meters(h, { px: edge[0], py: edge[1] }) > 15) { h.aim = edge; setState(w, h, "fly"); return; }
    setState(w, h, "wander");
    steer(w, h, edge[0], edge[1], FAUNA.heron.walk * 2, () => true, dryAt);
    return;
  }
  if (h.state === "feed" && inState(w, h) < 6) return;
  setState(w, h, Math.random() < 0.02 ? "feed" : "wade");
  // Stalking along the shallows, one slow step at a time, never leaving the edge.
  if (Math.random() < 0.2) {
    const a = h.heading + (Math.random() - 0.5) * 1.5;
    if (!steer(w, h, h.px + Math.cos(a) / TILE_M, h.py + Math.sin(a) / TILE_M, FAUNA.heron.walk, () => true, atEdge)) h.heading += Math.PI;
  }
}

function gull(w: World, g: Animal) {
  const home = g.home ?? [g.px, g.py];
  if (g.state === "rest") {
    if ((!isNight(w.t) && inState(w, g) > 40) || Math.random() < 0.002) setState(w, g, "fly");
    return;
  }
  if (g.state === "land") {
    // Settle wherever it is if the shore it wanted takes too long to reach: on the water or the beach alike.
    if (!flight(w, g, 12) || inState(w, g) > 40) { g.alt = 0; setState(w, g, "rest"); }
    return;
  }
  if (g.state === "feed") {
    lift(g, 0.5, 4);
    if (inState(w, g) > 5) setState(w, g, "fly");
    return;
  }
  if (isNight(w.t) || Math.random() < 0.003) { g.aim = shoreNear(w, home, 400) ?? onMap(g.px, g.py); setState(w, g, "land"); return; }
  if (Math.random() < 0.01 && wetAt(w, g.px, g.py)) { setState(w, g, "feed"); return; }
  setState(w, g, "fly");
  lift(g, 10 + quirk(g, 20), 2);
  roam(w, g, 400, FAUNA.gull.fly!, 1);
}

// What a bird can sit on, and how high its top is in meters.
const PERCH: Record<string, (t: Thing) => number> = {
  tree: (t) => t.size, stump: (t) => t.size, burnt_stump: (t) => t.size, boulder: (t) => t.size * 0.8, fallen_log: () => 0.5,
  structure: (t) => [0.5, 1.8, 2.5, 3.2][t.shelter?.tier ?? 0],
};
const perchHeight = (t?: Thing) => (t && PERCH[t.kind] ? Math.round(PERCH[t.kind](t) * 10) / 10 : 0);
// A perched bird sits on its perch's top, or on the ground if it has none; if the perch was cut, burned or taken away it
// takes off again.
function holdPerch(w: World, an: Animal) {
  const t = thingById(w, an.target);
  if (an.target && (!t || !PERCH[t.kind] || meters(an, t) > 1.5)) {
    an.target = undefined; an.aim = [an.px, an.py];
    setState(w, an, an.species === "eagle" ? "soar" : "fly");
    return false;
  }
  an.alt = perchHeight(t);
  return true;
}

function crow(w: World, c: Animal, n: Near) {
  const home = c.home ?? [c.px, c.py];
  const perch = () => {
    const tree = nearestThing(w, c.px, c.py, ["tree"], (t) => meters(c, t) > 15, 120);
    if (!tree) return false;
    c.aim = [tree.px, tree.py]; c.target = tree.id;
    setState(w, c, "fly");
    return true;
  };
  if (c.state === "fly") {
    const tree = thingById(w, c.target), perchable = !!tree && !!PERCH[tree.kind];
    if (!flight(w, c, 12, perchable ? perchHeight(tree) : 0)) { if (!perchable) c.target = undefined; setState(w, c, perchable ? "perch" : "feed"); }
    return;
  }
  if (c.state === "perch") {
    if (!holdPerch(w, c)) return;
    if (!isNight(w.t) && (inState(w, c) > 30 + quirk(c, 70) || Math.random() < 0.005)) {
      const a = Math.random() * Math.PI * 2, d = (Math.random() * 60) / TILE_M;
      c.aim = [home[0] + Math.cos(a) * d, home[1] + Math.sin(a) * d]; c.target = undefined;
      if (walkable(w, Math.floor(c.aim[0]), Math.floor(c.aim[1]))) setState(w, c, "fly");
    }
    return;
  }
  if (closest(c, n.awake, 15) || isNight(w.t)) { if (!perch()) roam(w, c, 30, FAUNA.crow.run); return; }
  // Crows pick at anything dead that's left lying about.
  const meat = nearestThing(w, c.px, c.py, ["item"], (t) => t.item === "meat" || !!t.item?.startsWith("rotten:"), 60);
  if (meat && meters(c, meat) > 1) { c.aim = [meat.px, meat.py]; c.target = undefined; setState(w, c, "fly"); return; }
  setState(w, c, "feed");
  if (meat && Math.random() < 0.02) { meat.n = (meat.n ?? 1) - 1; mark(w, meat); if (meat.n <= 0) removeThing(w, meat); }
  if (Math.random() < 0.004) { perch(); return; }
  roam(w, c, 40, FAUNA.crow.walk, 0.3);
}

function eagle(w: World, e: Animal, n: Near) {
  const home = e.home ?? [e.px, e.py];
  e.hunger = Math.max(0, e.hunger - 0.04);
  if (e.state === "feed") { lift(e, 0, 5); if (inState(w, e) > 20) setState(w, e, "soar"); return; }
  if (e.state === "perch") { if (holdPerch(w, e) && !isNight(w.t)) { e.target = undefined; setState(w, e, "soar"); } return; }
  if (isNight(w.t)) {
    const tree = nearestThing(w, home[0], home[1], ["tree"], (t) => t.size > 12, 300);
    e.aim = tree ? [tree.px, tree.py] : home;
    if (!flight(w, e, 60, perchHeight(tree ?? undefined))) { e.target = tree?.id; setState(w, e, "perch"); }
    return;
  }
  if (e.state === "dive") {
    const prey = w.animals.find((r) => r.id === e.target);
    if (!prey) { e.target = undefined; setState(w, e, "soar"); return; }
    const d = meters(e, prey);
    lift(e, 0, 15);
    goTo(w, e, prey.px, prey.py, FAUNA.eagle.fly!);
    if (e.alt < 2 && d < 3) {
      w.animals = w.animals.filter((x) => x !== prey);
      e.hunger = 100; e.target = undefined;
      setState(w, e, "feed");
    } else if (inState(w, e) > 12) { e.target = undefined; setState(w, e, "soar"); }
    return;
  }
  setState(w, e, "soar");
  // A hungry eagle stoops on a rabbit in the open or a fish near the surface; hungrier, it quarters the island for one.
  const prey = e.hunger < 50 ? closest(e, n.rabbits, 400, (r) => r.state !== "flee") ?? closest(e, n.fish, 400) : null;
  if (prey) { e.target = prey.id; setState(w, e, "dive"); return; }
  const far = e.hunger < 50 ? closest(e, [...n.rabbits, ...n.fish], Infinity) : null;
  if (far) { lift(e, 60, 3); goTo(w, e, far.px, far.py, FAUNA.eagle.fly!); return; }
  // Soaring: wide circles over home, drifting higher and lower on the air.
  lift(e, 60 + quirk(e, 60), 3);
  e.heading += 0.12;
  const r = 200 / TILE_M, ax = home[0] + Math.cos(e.heading) * r, ay = home[1] + Math.sin(e.heading) * r;
  goTo(w, e, ax, ay, FAUNA.eagle.fly!);
}

function butterfly(w: World, b: Animal, warm: boolean) {
  if (!warm || isNight(w.t)) { setState(w, b, "rest"); lift(b, 0.2, 0.5); return; }
  if (b.state === "feed") { if (inState(w, b) > 5 + quirk(b, 15)) setState(w, b, "flutter"); return; }
  const flower = thingById(w, b.target);
  if (flower) {
    goTo(w, b, flower.px, flower.py, FAUNA.butterfly.fly!);
    lift(b, flower.size * 0.6, 0.5);
    if (meters(b, flower) < 0.3) { b.target = undefined; setState(w, b, "feed"); }
    return;
  }
  b.target = undefined;
  if (Math.random() < 0.03) { b.target = nearestThing(w, b.px, b.py, ["flowers"], () => true, 8)?.id; if (b.target) return; }
  setState(w, b, "flutter");
  lift(b, 0.4 + Math.random() * 1.6, 0.6);
  roam(w, b, 30, FAUNA.butterfly.fly! * (0.4 + Math.random() * 0.6), 0.9);
}

// An animal that walks over a hidden pit falls in and stays there.
function caught(w: World, an: Animal, x0: number, y0: number) {
  const trap = onPath(w, x0, y0, an.px, an.py, 1, ["trap"], (t) => !t.caught);
  if (!trap) return;
  an.state = "trapped"; put(w, an, trap.px, trap.py); trap.caught = an.species; trap.until = w.t; mark(w, trap);
  const owner = w.agents.find((a) => a.id === trap.owner);
  log(w, "trap", owner ? [owner.id] : [], trap, `A ${an.species} fell into ${owner ? `${owner.name}'s` : "a"} hidden pit and couldn't get out.`);
  see(w, trap, "trap_works", "An animal that walks over a hidden pit falls in and is stuck.", 100);
}

export function animals(w: World) {
  const awake = w.agents.filter((a) => a.down <= w.t);
  const of = (s: AnimalSpecies) => w.animals.filter((a) => a.species === s);
  const fires = [...liveThings(w)].filter((t) => t.kind === "fire");
  const n: Near = { awake, fires, wolves: of("wolf"), deer: of("deer"), rabbits: of("rabbit"), eagles: of("eagle"), fish: of("fish") };
  const warm = warmRate(w.weather.temp) > 0.3;
  // Whether an animal is still about. One that goes takes the list with it (it is replaced, never cut down in place), so
  // the set of those about is made again only then.
  let list = w.animals, about = new Set(list);
  const still = (an: Animal) => { if (w.animals !== list) { list = w.animals; about = new Set(list); } return about.has(an); };
  for (const an of [...w.animals]) {
    if (an.state === "trapped" || !still(an)) continue;
    const x0 = an.px, y0 = an.py;
    switch (an.species) {
      case "deer": deer(w, an, n); break;
      case "wolf": wolf(w, an, n); break;
      case "rabbit": rabbit(w, an, n); break;
      case "fish": fish(w, an); break;
      case "heron": heron(w, an, n); break;
      case "gull": gull(w, an); break;
      case "crow": crow(w, an, n); break;
      case "eagle": eagle(w, an, n); break;
      case "butterfly": butterfly(w, an, warm); break;
    }
    if (FAUNA[an.species].ground && still(an)) caught(w, an, x0, y0);
  }
  // Animals swim across to the island when it empties out.
  const deerNow = w.animals.filter((a) => a.species === "deer").length, wolves = w.animals.filter((a) => a.species === "wolf");
  const ashore = (sp: AnimalSpecies, k: number, text: string) => {
    const e = landing(w);
    if (!e) return;
    for (let i = 0; i < k; i++) addAnimal(w, sp, e.px, e.py, { home: [e.px, e.py] });
    log(w, "birth", [], e, text);
  };
  if (deerNow < 4 && Math.random() < 1 / 1500) ashore("deer", 2, "A pair of deer swam ashore.");
  if (deerNow >= 8 && !wolves.length && Math.random() < 1 / 4000) ashore("wolf", 2, "Wolves came across the water, following the deer.");
  if (breeding(w.t) && wolves.length >= 2 && wolves.length < 6 && Math.random() < 1 / 4000) {
    addAnimal(w, "wolf", wolves[0].px, wolves[0].py, { home: wolves[0].home });
    log(w, "birth", [], wolves[0], "A wolf pup was born.");
  }
  const rabbits = n.rabbits.filter(still);
  if (breeding(w.t) && rabbits.length >= 2 && rabbits.length < 120 && Math.random() < rabbits.length / 2500) {
    const mom = rabbits[Math.floor(Math.random() * rabbits.length)];
    addAnimal(w, "rabbit", mom.px, mom.py, { home: mom.home, state: "graze" });
  }
  const fishes = w.animals.filter((a) => a.species === "fish");
  if (fishes.length && fishes.length < 200 && Math.random() < fishes.length / 6000) {
    const mom = fishes[Math.floor(Math.random() * fishes.length)];
    addAnimal(w, "fish", mom.px, mom.py, { home: mom.home });
  }
  // Butterflies live while the air is warm, and frost kills them; new ones hatch among the flowers as the days draw out.
  if (w.weather.temp < 2 && w.animals.some((a) => a.species === "butterfly")) w.animals = w.animals.filter((a) => a.species !== "butterfly");
  if (breeding(w.t) && warm && Math.random() < 0.05 && w.animals.filter((a) => a.species === "butterfly").length < 90) {
    const f = anyOf(w, "flowers");
    if (f) addAnimal(w, "butterfly", f.px, f.py, { home: [f.px, f.py], alt: 0.5, state: "flutter" });
  }
  for (const wf of w.animals.filter((a) => a.species === "wolf" && a.hunger <= 0)) { carcass(w, wf); log(w, "death", [], wf, "A wolf starved."); }
  // Anything else left without food weakens and dies; deer and wolves drop as carcasses above.
  for (const an of w.animals) if (an.hunger <= 0) an.hp -= 0.05;
  for (const an of w.animals.filter((a) => a.hp <= 0)) { w.animals = w.animals.filter((x) => x !== an); log(w, "death", [], an, an.hunger <= 0 ? `A ${an.species} starved.` : `A ${an.species} went through the ice and drowned.`); }
}
