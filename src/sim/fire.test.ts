import { afterAll, beforeAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, dryAt, newWorld, rng, type Thing, type World } from "./world";
import { HOUR, ticksOf } from "./ticks";
import { fire } from "./ecology";
import { bedAir, fireOf, fireOutput, removeThing, shelterOf } from "./physics";
import { anyOf, around, exists, liveThings, moistOf } from "./space";
import { advance, alight, kindle } from "./combustion";
import { CLASSES, toW } from "../gpu/moisture";
import { bedOf, partsOf, struck, warmed } from "./spread";
import { airAt } from "./air";
import { canopyAt } from "./light";
import { hooks } from "./rules";
import { traceListeners, type TraceEntry } from "./trace";
import { retire, tick as worldTick } from "./sim";
import { releaseGpu } from "../gpu/device";

// The plan's Unit 8 cases, each with its weather fixed from docs/research/fire-constants.md before spread.ts was run
// (sec. 30):
// - the air is a summer afternoon's, 18 C (sec. 25), under a clear sky;
// - dry is 10% in dead stuff of every thickness, the most a struck spark catches in (sec. 10); the grass is cured, the
//   growing season index under its green-up threshold (sec. 12);
// - a strong wind is the land's 90th percentile at head height, 6.9 m/s, and a wind the land's median, 4.2 m/s (sec. 25),
//   both blowing east;
// - a campfire is physics.ts fireOf's lay; lit in a wind it goes out within a minute (sec. 30c), so a campfire in a
//   wind is lit in still air two minutes before the wind gets up.
const DRY = 0.1, STRONG = 6.9, MEDIAN = 4.2, MIN = 60;
const m = (meters: number) => meters / TILE_M;

let w: World;
// the things that caught, by the trace fire() leaves
const caught = new Set<string>();
const listen = (e: TraceEntry) => {
  const d = e.data;
  if (e.sys === "fire" && e.kind === "spread" && d && typeof d === "object" && "to" in d && typeof d.to === "string") caught.add(d.to);
};
beforeAll(() => {
  w = newWorld(42);
  w.agents = [];
  w.animals = [];
  traceListeners.push(listen);
}, 120_000);
afterAll(async () => { traceListeners.splice(traceListeners.indexOf(listen), 1); await releaseGpu(); });

// A patch of open, dry ground well away from the last one, cleared of everything for 60 m round.
let scan = 0;
function patch() {
  for (; scan < 400; scan++) {
    const px = 40.5 + 3 * (scan % 20), py = 40.5 + 3 * Math.floor(scan / 20);
    w.weather.speed = 1;
    w.t++;
    if (!dryAt(w, px, py) || canopyAt(w, px, py) > 0 || airAt(w, px, py).wind < 0.8) continue;
    scan++;
    const all: Thing[] = [];
    around(w, px, py, 60, null, (t) => { all.push(t); });
    for (const t of all) removeThing(w, t);
    return { px, py };
  }
  throw new Error("no open ground");
}
// The weather over a patch: a clear summer afternoon, the head-height wind there blowing east, dead stuff of every
// class holding so much water (or, class by class, gpu/moisture.ts CLASSES: lying blades, twigs and sticks, a crown's
// dead twigs and sticks standing), and the grass cured.
function weather(at: { px: number; py: number }, wind: number, dead: number | number[] = DRY) {
  Object.assign(w.weather, { sky: "clear", temp: 18, wind: { dx: 1, dy: 0 }, speed: 1 });
  w.t++;
  w.weather.speed = wind / airAt(w, at.px, at.py).wind;
  const ms = typeof dead === "number" ? CLASSES.map(() => dead) : dead;
  w.weather.dead = { open: ms, shade: ms };
  delete w.weather.past;
  w.weather.gsi = { day: Math.floor(w.t / DAY), tmin: -5, vpd: 500, rain: 10, index: 0 };
}
// A step of fire, drawing brands from a seeded stream: the lane run for five minutes and landed, as a tick of fire was
// when these cases were written [design: the 300 s tick the cases' counts of steps were set against].
const STEP = 300;
const tick = () => { w.t += ticksOf(STEP); fire(w, [...liveThings(w)], STEP, true); };
function seeded<T>(seed: number, fn: () => T): T {
  const random = Math.random;
  Math.random = rng(seed);
  try { return fn(); } finally { Math.random = random; }
}
// A campfire lit in still air, burning two minutes.
function campfire(at: { px: number; py: number }) {
  weather(at, 0);
  const f = fireOf(w, at.px, at.py);
  f.bed = advance(f.bed!, 2 * MIN, bedAir(w, f));
  return f;
}

test("in still air a campfire never lights grass 2 m away, and grass touching its flames lights", () => {
  const at = patch();
  weather(at, 0);
  const f = fireOf(w, at.px, at.py);
  // tussocks 0.8 m across: one reaching to within 0.4 m of the fire's heart, under its base, and one 2 m off
  const touching = addThing(w, "grass", at.px + m(0.8), at.py, { size: 0.8 }), off = addThing(w, "grass", at.px - m(2.4), at.py, { size: 0.8 });
  let most = 0;
  for (let i = 0; i < 12 && exists(w, f); i++) { most = Math.max(most, fireOutput(w, f).flaming); seeded(i, tick); }
  expect(most).toBeGreaterThan(10);
  expect(caught.has(touching.id)).toBe(true);
  expect(caught.has(off.id)).toBe(false);
  expect(exists(w, off) && !off.bed).toBe(true);
}, 60_000);

test("in a strong wind, cured grass downwind of a campfire catches from its flames or brands, and the same grass upwind doesn't", () => {
  const at = patch();
  campfire(at);
  weather(at, STRONG);
  // tussocks 1.5 m across, either side: near ones 1.5 m off, in reach of the flame as it leans, and far ones 5 m off
  const [near, far] = [1.5, 5].map((d) => addThing(w, "grass", at.px + m(d), at.py, { size: 1.5 }));
  const [nearUp, farUp] = [1.5, 5].map((d) => addThing(w, "grass", at.px - m(d), at.py, { size: 1.5 }));
  for (let i = 0; i < 6; i++) seeded(100 + i, tick);
  expect(caught.has(near.id)).toBe(true);
  expect(caught.has(far.id)).toBe(true);
  expect(caught.has(nearUp.id)).toBe(false);
  expect(caught.has(farUp.id)).toBe(false);
}, 60_000);

test("a burning shelter lights a dry shelter 3 m downwind, and not one 3 m upwind", () => {
  const at = patch();
  weather(at, MEDIAN);
  // structures of ten sticks and six handfuls of fibre (a heap, by shelter.ts), 2.2 m across
  const hut = (dx: number) => addThing(w, "structure", at.px + m(dx), at.py, {
    parts: { fiber: 6, stick: 10 }, shelter: shelterOf(w, { fiber: 6, stick: 10 }), size: 2.2,
  });
  const burning = hut(0), down = hut(3), up = hut(-3), parts = partsOf(w, burning);
  burning.bed = kindle(bedOf(parts, warmed(burning, parts))!);
  for (let i = 0; i < 6; i++) seeded(200 + i, tick);
  expect(caught.has(down.id)).toBe(true);
  expect(caught.has(up.id)).toBe(false);
}, 60_000);

test("a lightning-struck tree in dry weather burns as a bed and leaves a burnt stump; in wet weather it doesn't light", () => {
  const at = patch();
  weather(at, 0, 0.35);
  // a felled oak's height (sec. 19a), its dead twigs too wet to carry a flame
  const wet = addThing(w, "tree", at.px + m(20), at.py, { size: 15, species: "oak" });
  expect(struck(w, wet)).toBeUndefined();
  weather(at, 0);
  const tree = addThing(w, "tree", at.px, at.py, { size: 15, species: "oak" });
  tree.bed = struck(w, tree);
  expect(tree.bed).toBeDefined();
  let steps = 0;
  for (; steps < DAY / ticksOf(STEP) && tree.bed; steps++) seeded(300 + steps, tick);
  // more than its twigs' flare: it burned on for an hour or more
  expect(steps).toBeGreaterThan(HOUR / ticksOf(STEP));
  expect(tree.kind).toBe("burnt_stump");
  expect(exists(w, tree)).toBe(true);
}, 60_000);

test("grass at 40% moisture doesn't catch from brands that light the same grass dry", () => {
  const brands = (dead: number) => {
    const at = patch(), f = campfire(at);
    weather(at, STRONG, dead);
    // 5 m downwind: past the flame's reach, under its brands (sec. 30c)
    const grass = addThing(w, "grass", at.px + m(5), at.py, { size: 1.5 });
    for (let i = 0; i < 6 && exists(w, f); i++) seeded(400 + i, tick);
    return caught.has(grass.id);
  };
  expect(brands(0.4)).toBe(false);
  expect(brands(DRY)).toBe(true);
}, 60_000);

test("a thing heated by a fire whose heat stops cools, and doesn't light later", () => {
  // fallen pine logs 9 m long (an 11 cm trunk) at 50% water, as wet as the sticks lying there (a log thicker than the
  // thickest class lying takes its water), the fine stuff dry, lying within a campfire's base: the fire lights one by
  // its third tick (sec. 30c)
  const log = () => {
    const at = patch(), f = campfire(at);
    weather(at, 0, [DRY, DRY, 0.5, DRY, DRY]);
    return { f, log: addThing(w, "fallen_log", at.px + m(0.3), at.py, { size: 9, species: "pine" }) };
  };
  const kept = log(), left = log();
  for (let i = 0; i < 2; i++) seeded(500 + i, tick);
  expect(left.log.absorbed?.[0]).toBeGreaterThan(0);
  expect(left.log.bed).toBeUndefined();
  // the second fire is put out, and its log left: it loses its heat as fast as its critical flux and the air take it,
  // and is cold within the half hour
  removeThing(w, left.f);
  let cold = 0;
  for (; cold < 6 && left.log.absorbed; cold++) seeded(502 + cold, tick);
  expect(left.log.absorbed).toBeUndefined();
  for (let i = 0; i < 12; i++) seeded(510 + i, tick);
  expect(caught.has(kept.log.id)).toBe(true);
  expect(caught.has(left.log.id)).toBe(false);
  expect(exists(w, left.log) && !left.log.bed).toBe(true);
}, 60_000);

test("a campfire stepped on its 10 s lane, as at a tick of 1 s, burns look for look as one stepped 300 s at a time, and goes out on the same tick", () => {
  const at = patch();
  // each tick's bed, stepped in runs of 300 / runs seconds, the last landing the tick's looks (ecology.ts fire)
  const burn = (runs: number) => {
    const t0 = w.t, f = campfire(at), beds: unknown[] = [];
    while (exists(w, f) && beds.length < 200) {
      w.t++;
      for (let k = 0; k < runs; k++) fire(w, exists(w, f) ? [f] : [], 300 / runs, k === runs - 1);
      beds.push(structuredClone(f.bed));
    }
    w.t = t0;
    return beds;
  };
  const once = burn(1), looked = burn(30);
  expect(once.length).toBeGreaterThan(3);
  expect(looked).toEqual(once);
}, 60_000);

test("a seeded world run on the GPU replays the same spread exactly", async () => {
  // the island's own grass, resident on the GPU with everything else: the tussock with the most grass round it of forty
  // drawn where a campfire a metre west of it stays alight its first minute, that campfire, and a dry, cured, windy
  // afternoon for an hour and a half, everything lying out holding DRY
  const run = async () => {
    const random = Math.random;
    Math.random = rng(7);
    const isle = newWorld(5);
    isle.agents = [];
    const pin = (x: World) => {
      Object.assign(x.weather, { sky: "clear", wind: { dx: 1, dy: 0.2 }, speed: 12 });
      x.weather.dead = { open: CLASSES.map(() => DRY), shade: CLASSES.map(() => DRY) };
      delete x.weather.past;
      x.weather.gsi = { day: Math.floor(x.t / DAY), tmin: -5, vpd: 500, rain: 10, index: 0 };
    };
    const spread: string[] = [];
    const watch = (e: TraceEntry) => { if (e.sys === "fire" && e.kind === "spread") spread.push(`${isle.t} ${JSON.stringify(e.data)}`); };
    try {
      await worldTick(isle);
      pin(isle);
      hooks.weather = pin;
      const dry = { m: toW(DRY), skin: toW(DRY) };
      await moistOf(isle)!.fill(CLASSES.map(() => dry), dry);
      const holds = (g: Thing) => {
        const f = fireOf(isle, g.px - m(1), g.py), lit = alight(advance(f.bed!, MIN, bedAir(isle, f)));
        removeThing(isle, f);
        return lit;
      };
      let best: Thing | null = null, most = -1;
      for (let i = 0; i < 40; i++) {
        const g = anyOf(isle, "grass", Math.random);
        let n = 0;
        if (g) around(isle, g.px, g.py, 20, ["grass"], () => { n++; });
        if (g && n > most && holds(g)) [best, most] = [g, n];
      }
      traceListeners.push(watch);
      const f = fireOf(isle, best!.px - m(1), best!.py);
      f.bed = advance(f.bed!, MIN, bedAir(isle, f));
      for (let i = 0; i < ticksOf(5400); i++) await worldTick(isle);
      return { spread, next: Math.random() };
    } finally {
      hooks.weather = undefined;
      if (traceListeners.includes(watch)) traceListeners.splice(traceListeners.indexOf(watch), 1);
      Math.random = random;
      await retire(isle);
    }
  };
  const first = await run(), again = await run();
  expect(first.spread.length).toBeGreaterThan(1);
  expect(again).toEqual(first);
}, 1_800_000);
