import { afterAll, beforeAll, expect, test } from "bun:test";
import { DAY, TILE_M, addThing, dryAt, heldStore, islandOf, newWorld, rng, type Thing, type World } from "./world";
import { HOUR, ticksOf } from "./ticks";
import { fire } from "./ecology";
import { bedAir, fireOf, fireOutput, removeThing, shelterOf } from "./physics";
import { anyOf, around, deadwoodOf, exists, firesOf, liveThings, moistOf } from "./space";
import { advance, alight, kindle } from "./combustion";
import { CLASSES, toW } from "../gpu/moisture";
import { bedOf, partsOf, struck, warmed } from "./spread";
import { airAt } from "./air";
import { canopyAt } from "./light";
import { hooks } from "./rules";
import { traceListeners, type TraceEntry } from "./trace";
import { retire, tick as worldTick } from "./sim";
import { releaseGpu } from "../gpu/device";
import { LOOK_S } from "../gpu/wgsl/fire";
import { LAND_S } from "./lanes";
import { SPECIES } from "../terrain/flora";
import { CELL, N } from "../terrain/grid";
import { fallRate, stickOf } from "../gpu/deadwood";
import { PENDING } from "../gpu/mirror";
import { CELL_MM } from "../gpu/wgsl/index";

await Promise.all([42, 5].map(islandOf));

// The plan's Unit 8 cases, each with its weather fixed from docs/research/fire-constants.md before spread.ts was run
// (sec. 30), on a world resident on the GPU, its beds burning there as they do in play:
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
beforeAll(async () => {
  w = newWorld(42);
  w.agents = [];
  w.animals = [];
  traceListeners.push(listen);
  await worldTick(w);
}, 600_000);
afterAll(async () => { traceListeners.splice(traceListeners.indexOf(listen), 1); await retire(w); await releaseGpu(); });

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
// dead twigs and sticks standing), on the GPU's texels and logs as in the island's reference, and the grass cured.
async function weather(at: { px: number; py: number }, wind: number, dead: number | number[] = DRY) {
  Object.assign(w.weather, { sky: "clear", temp: 18, wind: { dx: 1, dy: 0 }, speed: 1 });
  w.t++;
  w.weather.speed = wind / airAt(w, at.px, at.py).wind;
  const ms = typeof dead === "number" ? CLASSES.map(() => dead) : dead;
  w.weather.dead = { open: ms, shade: ms };
  delete w.weather.past;
  w.weather.gsi = { day: Math.floor(w.t / DAY), tmin: -5, vpd: 500, rain: 10, index: 0 };
  await moistOf(w)!.fill(ms.map((x) => ({ m: toW(x), skin: toW(x) })), { m: toW(ms[2]), skin: toW(ms[2]) });
}
// The fire lane for so many seconds: a run each look, a landing each minute, and the beds' looks taken at the start of the
// next tick as sim.ts takes them, the whole run of the world's tick but for everything else the world does.
let runs = 0;
async function lane(seconds: number, things: () => Thing[] = () => [...liveThings(w)]) {
  const store = heldStore(w)!, beds = firesOf(w)!;
  for (let i = 0; i < seconds / LOOK_S; i++) {
    w.t += ticksOf(LOOK_S);
    const landing = ++runs % (LAND_S / LOOK_S) === 0;
    if (landing) store.begin(w.t);
    fire(w, things(), LOOK_S, landing);
    if (landing) await store.land();
    await beds.arrive();
  }
}
// A step of fire of five minutes, as a tick of fire was when these cases were written [design: the 300 s tick the cases'
// counts of steps were set against].
const STEP = 300;
const tick = () => lane(STEP);
async function seeded<T>(seed: number, fn: () => Promise<T>): Promise<T> {
  const random = Math.random;
  Math.random = rng(seed);
  try { return await fn(); } finally { Math.random = random; }
}
// A campfire lit in still air, burning two minutes.
async function campfire(at: { px: number; py: number }) {
  await weather(at, 0);
  const f = fireOf(w, at.px, at.py);
  f.bed = advance(f.bed!, 2 * MIN, bedAir(w, f));
  return f;
}

// ---------- deadwood where no one stands ----------
// The dead wood lies on the GPU (src/gpu/deadwood.ts), and the CPU reads the cells round people and the beds. These cases
// lay some where no window holds it, as the deadwood's own births would: a litterfall's bin of sticks in a cell, and dead
// pines 9 m long and 11 cm through, one lying and one standing.
const mm = (tiles: number) => Math.round(tiles * TILE_M * 1000);
const PINE = SPECIES.indexOf("pine" as never);
const BIN = 3000;
async function land() {
  const store = heldStore(w)!;
  store.begin(w.t);
  await store.land();
}
// The runs of the fire lane up to the next landing.
async function aligned() { while (runs % (LAND_S / LOOK_S)) await lane(LOOK_S); }
// A bin of sticks laid in a cell, and the one of them lying nearest a point (mm): its id and place.
function sticksNear(cx: number, cy: number, x: number, y: number) {
  const dw = deadwoodOf(w)!, cell = cy * N + cx, born = dw.hourNow, arot = dw.rotAt(cell);
  if (arot === PENDING) throw new Error("the rot sums haven't landed");
  heldStore(w)!.spawn("stickbin", { x: cx * CELL_MM + CELL_MM / 2, y: cy * CELL_MM + CELL_MM / 2, born, arot, n: BIN });
  let best = { k: 0, d: Infinity, x: 0, y: 0 };
  for (let k = 0; k < BIN; k++) {
    const s = stickOf(dw.law.seed, cell, born, k), d = Math.hypot(s.x - x, s.y - y);
    if (d < best.d) best = { k, d, x: s.x, y: s.y };
  }
  return { id: `s${cell}.${born}.${best.k}`, x: best.x, y: best.y };
}
// A dead pine of the cell's rot as it is now, lying or standing, at a place (mm); its id is the GPU's once uploaded.
function pineAt(x: number, y: number, standing: boolean) {
  const dw = deadwoodOf(w)!, cell = Math.floor(y / CELL_MM) * N + Math.floor(x / CELL_MM), arot = dw.rotAt(cell);
  if (arot === PENDING) throw new Error("the rot sums haven't landed");
  return heldStore(w)!.spawn("log", { x, y, born: dw.hourNow, arot, what: PINE, len: 9000, dia: 110, u: 0, uf: 0, fr: standing ? fallRate(dw.law, PINE, 110) : 0 });
}
const cellOf = (at: { px: number; py: number }) => ({ cx: Math.floor((at.px * TILE_M) / CELL), cy: Math.floor((at.py * TILE_M) / CELL) });

test("a bed where no one stands lights the sticks, the fallen log and the snag lying within its flames, and keeps the cells round it landed for what it lights next", async () => {
  const at = patch(), { cx, cy } = cellOf(at), store = heldStore(w)!;
  await weather(at, 0);
  await land();
  const stick = sticksNear(cx, cy, mm(at.px), mm(at.py)), log = pineAt(stick.x + 300, stick.y, false), snag = pineAt(stick.x - 300, stick.y, true);
  // no window holds the cell, and nothing has asked for it
  expect(store.mirror.landed("log", cx, cy)).toBeUndefined();
  expect(store.mirror.landed("stickbin", cx + 2, cy)).toBeUndefined();
  await aligned();
  fireOf(w, stick.x / (TILE_M * 1000), stick.y / (TILE_M * 1000));
  await seeded(600, () => lane(MIN));
  // the bed's window has brought the cells two away, which no lookup of anyone's asked for
  expect(store.mirror.landed("stickbin", cx + 2, cy)).toBeDefined();
  expect(store.mirror.landed("log", cx - 2, cy - 2)).toBeDefined();
  // and the water of what lies there: the texels of those cells came back with them
  expect(moistOf(w)!.texelAt((cx + 2) * CELL_MM + 1000, cy * CELL_MM + 1000, w.t)).toBeDefined();
  for (let i = 1; i < 12; i++) await seeded(600 + i, () => lane(MIN));
  expect(caught.has(stick.id)).toBe(true);
  expect(caught.has(`l${log.id}`)).toBe(true);
  expect(caught.has(`l${snag.id}`)).toBe(true);
  // every bed put out: the windows stay one landing, for the heat the last minute gave, and are let go at the next
  const windows = () => [...store.mirror["rects"].keys()].filter((k) => k.startsWith("fire:"));
  expect(windows().length).toBeGreaterThan(0);
  for (const t of [...liveThings(w)]) if (t.bed) removeThing(w, t);
  await seeded(650, () => lane(MIN));
  expect(windows().length).toBeGreaterThan(0);
  await seeded(651, () => lane(MIN));
  expect(windows()).toEqual([]);
}, 300_000);

test("a bed lit beside a burning one finds the sticks round it at its first look, in the minute it is lit", async () => {
  const at = patch(), { cx, cy } = cellOf(at);
  await weather(at, 0);
  await land();
  // the first bed burns a minute; sticks lie in the next cell east, 75 to 150 m from it, outside its own reach
  const next = sticksNear(cx + 1, cy, mm(at.px) + CELL_MM, mm(at.py));
  await aligned();
  fireOf(w, at.px, at.py);
  await seeded(700, () => lane(MIN));
  const second = fireOf(w, next.x / (TILE_M * 1000), next.y / (TILE_M * 1000));
  expect(exists(w, second)).toBe(true);
  await seeded(701, () => lane(MIN));
  expect(caught.has(next.id)).toBe(true);
}, 300_000);

test("in still air a campfire never lights grass 2 m away, and grass touching its flames lights", async () => {
  const at = patch();
  await weather(at, 0);
  const f = fireOf(w, at.px, at.py);
  // tussocks 0.8 m across: one reaching to within 0.4 m of the fire's heart, under its base, and one 2 m off
  const touching = addThing(w, "grass", at.px + m(0.8), at.py, { size: 0.8 }), off = addThing(w, "grass", at.px - m(2.4), at.py, { size: 0.8 });
  let most = 0;
  for (let i = 0; i < 12 && exists(w, f); i++) { most = Math.max(most, fireOutput(w, f).flaming); await seeded(i, tick); }
  expect(most).toBeGreaterThan(10);
  expect(caught.has(touching.id)).toBe(true);
  expect(caught.has(off.id)).toBe(false);
  expect(exists(w, off) && !off.bed).toBe(true);
}, 300_000);

test("in a strong wind, cured grass downwind of a campfire catches from its flames or brands, and the same grass upwind doesn't", async () => {
  const at = patch();
  await campfire(at);
  await weather(at, STRONG);
  // tussocks 1.5 m across, either side: near ones 1.5 m off, in reach of the flame as it leans, and far ones 5 m off
  const [near, far] = [1.5, 5].map((d) => addThing(w, "grass", at.px + m(d), at.py, { size: 1.5 }));
  const [nearUp, farUp] = [1.5, 5].map((d) => addThing(w, "grass", at.px - m(d), at.py, { size: 1.5 }));
  for (let i = 0; i < 6; i++) await seeded(100 + i, tick);
  expect(caught.has(near.id)).toBe(true);
  expect(caught.has(far.id)).toBe(true);
  expect(caught.has(nearUp.id)).toBe(false);
  expect(caught.has(farUp.id)).toBe(false);
}, 300_000);

test("a burning shelter lights a dry shelter 3 m downwind, and not one 3 m upwind", async () => {
  const at = patch();
  await weather(at, MEDIAN);
  // structures of ten sticks and six handfuls of fibre (a heap, by shelter.ts), 2.2 m across
  const hut = (dx: number) => addThing(w, "structure", at.px + m(dx), at.py, {
    parts: { fiber: 6, stick: 10 }, shelter: shelterOf(w, { fiber: 6, stick: 10 }), size: 2.2,
  });
  const burning = hut(0), down = hut(3), up = hut(-3), parts = partsOf(w, burning);
  burning.bed = kindle(bedOf(parts, warmed(burning, parts))!);
  for (let i = 0; i < 6; i++) await seeded(200 + i, tick);
  expect(caught.has(down.id)).toBe(true);
  expect(caught.has(up.id)).toBe(false);
}, 300_000);

test("a lightning-struck tree in dry weather burns as a bed and leaves a burnt stump; in wet weather it doesn't light", async () => {
  const at = patch();
  await weather(at, 0, 0.35);
  // a felled oak's height (sec. 19a), its dead twigs too wet to carry a flame
  const wet = addThing(w, "tree", at.px + m(20), at.py, { size: 15, species: "oak" });
  expect(struck(w, wet)).toBeUndefined();
  await weather(at, 0);
  const tree = addThing(w, "tree", at.px, at.py, { size: 15, species: "oak" });
  tree.bed = struck(w, tree);
  expect(tree.bed).toBeDefined();
  let steps = 0;
  for (; steps < DAY / ticksOf(STEP) && tree.bed; steps++) await seeded(300 + steps, tick);
  // more than its twigs' flare: it burned on for an hour or more
  expect(steps).toBeGreaterThan(HOUR / ticksOf(STEP));
  expect(tree.kind).toBe("burnt_stump");
  expect(exists(w, tree)).toBe(true);
}, 300_000);

test("grass at 40% moisture doesn't catch from brands that light the same grass dry", async () => {
  const brands = async (dead: number) => {
    const at = patch(), f = await campfire(at);
    await weather(at, STRONG, dead);
    // 5 m downwind: past the flame's reach, under its brands (sec. 30c)
    const grass = addThing(w, "grass", at.px + m(5), at.py, { size: 1.5 });
    for (let i = 0; i < 6 && exists(w, f); i++) await seeded(400 + i, tick);
    return caught.has(grass.id);
  };
  expect(await brands(0.4)).toBe(false);
  expect(await brands(DRY)).toBe(true);
}, 300_000);

test("a thing heated by a fire whose heat stops cools, and doesn't light later", async () => {
  // fallen pine logs 9 m long (an 11 cm trunk) at 50% water, as wet as the sticks lying there (a log thicker than the
  // thickest class lying takes its water), the fine stuff dry, lying within a campfire's base: the fire lights one by
  // its third tick (sec. 30c)
  const log = async () => {
    const at = patch(), f = await campfire(at);
    await weather(at, 0, [DRY, DRY, 0.5, DRY, DRY]);
    return { f, log: addThing(w, "fallen_log", at.px + m(0.3), at.py, { size: 9, species: "pine" }) };
  };
  const kept = await log(), left = await log();
  for (let i = 0; i < 2; i++) await seeded(500 + i, tick);
  expect(left.log.absorbed?.[0]).toBeGreaterThan(0);
  expect(left.log.bed).toBeUndefined();
  // the second fire is put out, and its log left: it loses its heat as fast as its critical flux and the air take it,
  // and is cold within the half hour
  removeThing(w, left.f);
  let cold = 0;
  for (; cold < 6 && left.log.absorbed; cold++) await seeded(502 + cold, tick);
  expect(left.log.absorbed).toBeUndefined();
  for (let i = 0; i < 12; i++) await seeded(510 + i, tick);
  expect(caught.has(kept.log.id)).toBe(true);
  expect(caught.has(left.log.id)).toBe(false);
  expect(exists(w, left.log) && !left.log.bed).toBe(true);
}, 300_000);

test("a campfire stepped on its 10 s lane, as at a tick of 1 s, burns look for look as one stepped 300 s at a time, and goes out on the same tick", async () => {
  const at = patch();
  // each step's bed, the fire lane run once for the step's 300 s, or a run for each look
  const burn = async (perRun: number) => {
    const t0 = w.t, f = await campfire(at), beds: unknown[] = [], fires = firesOf(w)!;
    while (exists(w, f) && beds.length < 200) {
      for (let k = 0; k < STEP / perRun; k++) {
        w.t += ticksOf(perRun);
        fire(w, exists(w, f) ? [f] : [], perRun, false);
        await fires.arrive();
      }
      beds.push(structuredClone(f.bed));
    }
    w.t = t0;
    return beds;
  };
  const once = await burn(STEP), looked = await burn(LOOK_S);
  expect(once.length).toBeGreaterThan(3);
  expect(looked).toEqual(once);
}, 300_000);

// What the windows of the beds cost a landing, printed and not asserted: the deadwood cells and words each landing copies
// (every kind it copies, by name) and the time it and the fire's work take, in a wood, with no bed burning, one, and five.
test("what a landing copies and costs with one bed burning and with five in a wood (printed)", async () => {
  const store = heldStore(w)!, mirror = store.mirror;
  for (const t of [...liveThings(w)]) if (t.bed) removeThing(w, t);
  let wood: { px: number; py: number } | null = null;
  for (let i = 0; i < 4096 && !wood; i++) {
    const px = 8.5 + 2 * (i % 64), py = 8.5 + 2 * Math.floor(i / 64);
    w.weather.speed = 5;
    w.t++;
    if (canopyAt(w, px, py) > 0.85 && airAt(w, px, py).wind > 0.8) wood = { px, py };
  }
  if (!wood) throw new Error("no wood");
  await weather(wood, 1);
  const kinds: Record<string, { cells: number; words: number }> = {};
  const land = mirror.land.bind(store.mirror);
  mirror.land = (k, ents, o, head, keep) => {
    const row = 2 + k.fields.length, got = (kinds[k.name] ??= { cells: 0, words: 0 });
    for (let e = 0; e < ents.length; e++) if ((ents[e] & 0x80000000) === 0 && o[head + 2 * e + 1] !== 0xffffffff) { got.cells++; got.words += o[head + 2 * e + 1] * row; }
    land(k, ents, o, head, keep);
  };
  const out = () => (store["scratchBufs"].get("out")?.size ?? 0) / 2 ** 20;
  const rows: Record<string, unknown>[] = [];
  const landing = async (label: string) => {
    await aligned();
    for (const k of Object.keys(kinds)) delete kinds[k];
    let beds = 0, fireMs = 0, landMs = 0;
    for (let i = 0; i < LAND_S / LOOK_S; i++) {
      w.t += ticksOf(LOOK_S);
      const last = i === LAND_S / LOOK_S - 1;
      runs++;
      if (last) store.begin(w.t);
      const t0 = performance.now();
      const things = [...liveThings(w)];
      beds = things.filter((t) => t.bed).length;
      await seeded(900 + runs, async () => fire(w, things, LOOK_S, last));
      fireMs += performance.now() - t0;
      if (last) { const t1 = performance.now(); await store.land(); landMs = performance.now() - t1; }
      await firesOf(w)!.arrive();
    }
    const dead = ["log", "logup", "stickbin", "stickup"].reduce((s, n) => ({ cells: s.cells + (kinds[n]?.cells ?? 0), words: s.words + (kinds[n]?.words ?? 0) }), { cells: 0, words: 0 });
    const every = Object.values(kinds).reduce((s, x) => ({ cells: s.cells + x.cells, words: s.words + x.words }), { cells: 0, words: 0 });
    rows.push({ label, beds, deadwoodCells: dead.cells, deadwoodKiB: Math.round((dead.words * 4) / 1024), allKindsCells: every.cells, allKindsKiB: Math.round((every.words * 4) / 1024), minuteFireMs: Math.round(fireMs), landMs: Math.round(landMs), outMiB: +out().toFixed(2), things: w.things.length });
  };
  await landing("none");
  const trees: Thing[] = [];
  const light = (n: number) => {
    for (let i = trees.length; i < n; i++) {
      const tree = addThing(w, "tree", wood!.px + m(14 * i), wood!.py, { size: 15, species: "oak" });
      tree.bed = struck(w, tree);
      if (!tree.bed) throw new Error("the tree didn't light");
      trees.push(tree);
    }
  };
  light(1);
  for (let i = 0; i < 3; i++) await landing(`one, minute ${i + 1}`);
  light(5);
  for (let i = 0; i < 3; i++) await landing(`five, minute ${i + 1}`);
  mirror.land = land;
  console.log(JSON.stringify(rows));
}, 300_000);
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
