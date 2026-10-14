import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { storage } from "./kernel";
import { philox } from "./rand";
import { CTL, CTL_WORDS } from "./wgsl/alloc";
import { CELLS, CELL_MM } from "./wgsl/index";
import { N } from "../terrain/grid";
import { type KindSpec, Store, genOfId, idOf, loadStore, slotOfId } from "./store";
import { type Obj, type Pending, PENDING } from "./mirror";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const TREE: KindSpec = { name: "tree", capacity: 1000, placed: true, fields: [] };
const SEED: KindSpec = {
  name: "seed", capacity: 5000, placed: true,
  fields: [{ name: "mass", type: "u32", unit: "mg", scale: 1 }, { name: "from", type: "i32", unit: "tree slot", scale: 1 }],
};
const SEEDING = `
child_set_x(slot, parent_x(parent) + k);
child_set_y(slot, parent_y(parent));
child_set_from(slot, i32(parent));
child_set_mass(slot, 100u + k);`;
const count = (p: number) => philox([p, 0, 0, 0], [7, 8])[0] & 3;
// An object the mirror holds, or a failure saying what it held instead.
const held = (o: Obj | null | Pending): Obj => { if (!o || o === PENDING) throw new Error(`the mirror holds ${String(o)}`); return o; };
const treeAt = (i: number) => ({ x: (i * 7919 * 1000) % 19_200_000, y: (i * 104729 * 1000) % 19_200_000 });

// 1,000 trees, every seventh dead; 600 seeds lying, every third dead and so free; then every live tree sheds 0 to 3
// seeds in one law.
async function seeding(g: Gpu) {
  const s = new Store(g);
  s.declare(TREE);
  s.declare(SEED);
  for (let i = 0; i < 1000; i++) s.spawn("tree", treeAt(i));
  for (let i = 0; i < 600; i++) s.spawn("seed", { x: 5000, y: 5000, mass: 9 });
  await s.step(1);
  for (let i = 0; i < 1000; i += 7) s.kill(idOf(0, i, 1));
  for (let i = 0; i < 600; i += 3) s.kill(idOf(1, i, 1));
  await s.step(2);
  const counts = storage(g, Uint32Array.from({ length: 1000 }, (_, p) => count(p)));
  s.law({ name: "seeding", due: (t) => t === 3, run: (st) => st.births("tree", "seed", counts, SEEDING) });
  await s.step(3);
  counts.destroy();
  return { body: await s.read("seed", "body"), alloc: await s.read("seed", "alloc"), hash: await s.hash() };
}

test("1,000 parents shedding 0 to 3 children give the same ids in the same order every run and on both adapters", async () => {
  const g = await theGpu();
  const a = await seeding(g), b = await seeding(g);
  low = await openGpu("low-power");
  const c = await seeding(low);
  expect(b.hash).toBe(a.hash);
  expect(c.hash).toBe(a.hash);
  // the rule itself: children in tree order, each tree's in turn, into the free seeds in index order and then the tail
  const free = Array.from({ length: 200 }, (_, i) => 3 * i);
  const C = SEED.capacity, want: { slot: number; from: number; k: number }[] = [];
  for (let p = 0; p < 1000; p++) if (p % 7) for (let k = 0; k < count(p); k++) want.push({ slot: 0, from: p, k });
  want.forEach((w, j) => { w.slot = j < free.length ? free[j] : 600 + j - free.length; });
  expect(want.length).toBeGreaterThan(1000);
  for (const w of want) {
    const gen = w.slot < 600 ? 2 : 1;
    expect(a.body[w.slot]).toBe((gen << 1) | 1);
    expect(a.body[4 * C + w.slot]).toBe(w.from);
    expect(a.body[3 * C + w.slot]).toBe(100 + w.k);
    expect(a.body[C + w.slot]).toBe(treeAt(w.from).x + w.k);
  }
  // after the tick's fixed point the free list is empty again and the tail is past the last child
  expect(a.alloc[CTL.nfree] - a.alloc[CTL.head]).toBe(0);
  expect(a.alloc[CTL.tail]).toBe(600 + want.length - free.length);
}, 60_000);

// Rabbits breeding into their own kind for two ticks: 300 born, every third killed (its slot free, its count still
// set, which the births must ignore), then each live one bears 0 to 3 young a tick, young of the first tick among the
// mothers of the second.
const RABBIT: KindSpec = { name: "rabbit", capacity: 4000, placed: true, fields: [{ name: "mother", type: "i32", unit: "rabbit slot", scale: 1 }] };
const LITTER = `
child_set_x(slot, parent_x(parent));
child_set_y(slot, parent_y(parent) + k);
child_set_mother(slot, i32(parent));`;
const litter = (t: number, p: number) => philox([p, t, 0, 0], [9, 9])[0] & 3;
async function breeding(g: Gpu) {
  const s = new Store(g);
  s.declare(RABBIT);
  for (let i = 0; i < 300; i++) s.spawn("rabbit", { x: i * 1000, y: 7 * i * 1000 });
  await s.step(1);
  for (let i = 0; i < 300; i += 3) s.kill(idOf(0, i, 1));
  await s.step(2);
  const counts = [3, 4].map((t) => storage(g, Uint32Array.from({ length: RABBIT.capacity }, (_, p) => litter(t, p))));
  s.law({ name: "breeding", due: (t) => t === 3 || t === 4, run: (st, t) => st.births("rabbit", "rabbit", counts[t - 3], LITTER) });
  await s.step(3);
  await s.step(4);
  for (const c of counts) c.destroy();
  return { body: await s.read("rabbit", "body"), hash: await s.hash() };
}

test("a kind breeding into itself gives the same ids every run and on both adapters, as the rule says", async () => {
  const a = await breeding(await theGpu()), b = await breeding(await theGpu());
  low ??= await openGpu("low-power");
  const c = await breeding(low);
  expect(b.hash).toBe(a.hash);
  expect(c.hash).toBe(a.hash);
  // the rule, stepped on the CPU: mothers are the slots alive when the tick's births begin, in slot order
  const C = RABBIT.capacity, word = new Uint32Array(C), x = new Uint32Array(C), y = new Uint32Array(C), mother = new Int32Array(C);
  for (let i = 0; i < 300; i++) { word[i] = i % 3 ? 3 : 2; x[i] = i * 1000; y[i] = 7 * i * 1000; }
  let tail = 300;
  for (const t of [3, 4]) {
    const free: number[] = [], mothers: number[] = [];
    for (let i = 0; i < tail; i++) (word[i] & 1 ? mothers : free).push(i);
    let j = 0;
    for (const p of mothers) for (let k = 0; k < litter(t, p); k++, j++) {
      const slot = j < free.length ? free[j] : tail + j - free.length;
      word[slot] = (((word[slot] >>> 1) + 1) << 1) | 1;
      x[slot] = x[p]; y[slot] = y[p] + k; mother[slot] = p;
    }
    tail += Math.max(0, j - free.length);
  }
  expect(tail).toBeGreaterThan(900);
  const want = [...word, ...x, ...y, ...Array.from(mother, (v) => v >>> 0)];
  let first = -1;
  for (let i = 0; i < want.length && first < 0; i++) if (a.body[i] !== want[i]) first = i;
  expect(first).toBe(-1);
}, 60_000);

test("spawns past the read-back free list wait a tick, with the deltas to them, and take the next free slots", async () => {
  const s = new Store(await theGpu());
  s.declare(SEED);
  s.mirror.watch("here", { x0: 0, y0: 0, x1: 0, y1: 0 });
  for (let i = 0; i < 3000; i++) s.spawn("seed", { x: 1000, y: 1000 });
  await s.step(1);
  const dead: number[] = [];
  for (let i = 0; i < 3000; i++) if (i % 3 !== 2) { s.kill(idOf(0, i, 1)); dead.push(i); }
  await s.step(2);
  // 1,500 spawns against 2,000 free slots, of which the landing read back 1,024
  const objs = Array.from({ length: 1500 }, (_, i) => s.spawn("seed", { x: 2000, y: 2000, mass: i }));
  const late = objs[1400], kept = idOf(0, 2, 1);
  s.set(late.id, "from", -5);
  s.set(kept, "mass", 77);
  await s.step(3);
  expect(objs.filter((o) => o.id >= 0).length).toBe(1024);
  expect(late.id).toBeLessThan(0);
  expect(held(s.mirror.get(late.id)).v.from).toBe(-5);
  await s.step(4);
  expect(objs.map((o) => slotOfId(o.id))).toEqual(dead.slice(0, 1500));
  expect(objs.every((o) => genOfId(o.id) === 2)).toBe(true);
  const body = await s.read("seed", "body"), C = SEED.capacity, at = slotOfId(late.id);
  expect(body[at]).toBe(5);
  expect(body[3 * C + at]).toBe(1400);
  expect(body[4 * C + at] | 0).toBe(-5);
  expect(body[3 * C + 2]).toBe(77);
  expect(held(s.mirror.get(late.id)).v).toEqual({ x: 2000, y: 2000, mass: 1400, from: -5 });
  const alloc = await s.read("seed", "alloc");
  expect(alloc[CTL.nfree] - alloc[CTL.head]).toBe(2000 - 1500);
});

test("a recycled slot carries a new generation, and the stale id resolves to nothing", async () => {
  const s = new Store(await theGpu());
  s.declare(SEED);
  s.mirror.watch("here", { x0: 0, y0: 0, x1: 0, y1: 0 });
  const a = s.spawn("seed", { x: 1000, y: 1000, mass: 7 });
  await s.step(1);
  const old = a.id;
  expect(genOfId(old)).toBe(1);
  s.kill(old);
  await s.step(2);
  const b = s.spawn("seed", { x: 2000, y: 2000, mass: 8 });
  await s.step(3);
  expect(slotOfId(b.id)).toBe(slotOfId(old));
  expect(genOfId(b.id)).toBe(2);
  expect(s.mirror.get(old)).toBeNull();
  expect(held(s.mirror.get(b.id)).v.mass).toBe(8);
  // a delta to the stale id does nothing on the GPU either
  s.set(old, "mass", 99);
  await s.step(4);
  const body = await s.read("seed", "body");
  expect(body[3 * SEED.capacity + slotOfId(b.id)]).toBe(8);
  expect(held(s.mirror.get(b.id)).v.mass).toBe(8);
});

test("deltas to one object in one tick apply in queue order, whatever order they arrive in", async () => {
  const run = async (shuffle: boolean) => {
    const s = new Store(await theGpu());
    s.declare(SEED);
    const objs = Array.from({ length: 3000 }, (_, i) => s.spawn("seed", { x: i * 1000, y: 0 }));
    await s.step(1);
    // three deltas to every object, queued round the objects so each one's are far apart, two of them on one field
    for (let r = 0; r < 3; r++) for (const [i, o] of objs.entries()) {
      if (r === 2 && i % 5 === 0) s.kill(o.id);
      else s.set(o.id, r === 1 && i % 2 ? "from" : "mass", 10 * r + (i % 10));
    }
    if (shuffle) {
      const q = s.queue;
      for (let i = q.length - 1; i > 0; i--) { const j = philox([i, 0, 0, 0], [1, 1])[0] % (i + 1); [q[i], q[j]] = [q[j], q[i]]; }
    }
    await s.step(2);
    return { body: await s.read("seed", "body"), objs };
  };
  const a = await run(false), b = await run(true), C = SEED.capacity;
  expect(Array.from(b.body)).toEqual(Array.from(a.body));
  for (const [i, o] of a.objs.entries()) {
    const slot = slotOfId(o.id);
    expect(a.body[slot] & 1).toBe(i % 5 === 0 ? 0 : 1);
    expect(a.body[3 * C + slot]).toBe(i % 5 === 0 ? (i % 2 ? i % 10 : 10 + (i % 10)) : 20 + (i % 10));
    expect(a.body[4 * C + slot]).toBe(i % 2 ? 10 + (i % 10) : 0);
  }
});

// Objects laid straight into a kind's buffers, as the generator will: slots 0 to n - 1 at generation 1, alive unless
// dead says not, their fields as at gives them.
function lay(s: Store, kind: string, n: number, at: (slot: number, field: number) => number, dead: (slot: number) => boolean = () => false) {
  const k = s.kind(kind), C = k.capacity, body = new Uint32Array((1 + k.fields.length) * C);
  for (let i = 0; i < n; i++) {
    body[i] = dead(i) ? 2 : 3;
    for (let f = 0; f < k.fields.length; f++) body[(1 + f) * C + i] = at(i, f);
  }
  s.g.device.queue.writeBuffer(k.body, 0, body);
  s.g.device.queue.writeBuffer(k.alloc, CTL.tail * 4, Uint32Array.of(n));
  k.peek.tail = n;
}
const cellOf = (x: number, y: number) => Math.min(Math.floor(y / CELL_MM), N - 1) * N + Math.min(Math.floor(x / CELL_MM), N - 1);

test("the index holds every live object exactly once, by cell, in slot order within a cell, on both adapters", async () => {
  const n = 300_000, place = (i: number, f: number) => {
    const h = philox([i, f, 0, 0], [3, 4])[0];
    // most in a few crowded cells, the rest anywhere, some past the island's edge
    return i % 3 ? (h % 4) * CELL_MM + (h >>> 20) : h % 20_000_000;
  };
  const dead = (i: number) => i % 11 === 0;
  const index = async (g: Gpu) => {
    const s = new Store(g);
    s.declare({ name: "stone", capacity: n + 1234, placed: true, fields: [] });
    lay(s, "stone", n, place, dead);
    await s.step(1);
    return { order: await s.read("stone", "order"), start: await s.read("stone", "start") };
  };
  const { order, start } = await index(await theGpu());
  const live = Array.from({ length: n }, (_, i) => i).filter((i) => !dead(i));
  const cell = Int32Array.from({ length: n }, (_, i) => cellOf(place(i, 0), place(i, 1)));
  const want = [...live].sort((a, b) => cell[a] - cell[b] || a - b), starts = new Uint32Array(CELLS + 1);
  for (const i of live) starts[cell[i] + 1]++;
  for (let c = 0; c < CELLS; c++) starts[c + 1] += starts[c];
  const same = (got: Uint32Array, wanted: ArrayLike<number>) => { for (let i = 0; i < wanted.length; i++) if (got[i] !== wanted[i]) return `differs at ${i}: ${got[i]} for ${wanted[i]}`; return "same"; };
  expect(same(order, want)).toBe("same");
  expect(same(start, starts)).toBe("same");
  low ??= await openGpu("low-power");
  const other = await index(low);
  expect(same(other.order, want)).toBe("same");
  expect(same(other.start, starts)).toBe("same");
}, 60_000);

test("a store saved and loaded has the same buffers, the same queued deltas, and goes on the same", async () => {
  const g = await theGpu(), s = new Store(g);
  s.declare(TREE);
  s.declare(SEED);
  for (let i = 0; i < 50; i++) s.spawn("tree", treeAt(i));
  await s.step(1);
  s.kill(idOf(0, 3, 1));
  await s.step(2);
  const pending = s.spawn("seed", { x: 1, y: 2, mass: 3 });
  s.set(idOf(0, 4, 1), "x", 12345);
  const bytes = await s.dump(), t = loadStore(g, bytes);
  expect(await t.hash()).toBe(await s.hash());
  expect(t.queue.length).toBe(2);
  await s.step(3);
  await t.step(3);
  expect(await t.hash()).toBe(await s.hash());
  expect(pending.id).toBeGreaterThanOrEqual(0);
  const alloc = await t.read("tree", "alloc");
  expect(alloc[CTL_WORDS + alloc[CTL.head]]).toBe(3);
});

// ---------- costs, reported, not gated ----------
const ms = async (g: Gpu, f: () => void | Promise<void>) => {
  await g.device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  await f();
  await g.device.queue.onSubmittedWorkDone();
  return Math.round((performance.now() - t0) * 100) / 100;
};

test("costs: births of 10^6 children, the index of 10^7 objects, a 64-cell window landing (reported)", async () => {
  const g = await theGpu(), rows: Record<string, number> = {};
  {
    const s = new Store(g), P = 500_000;
    s.declare({ name: "tree", capacity: P, placed: true, fields: [] });
    s.declare({ ...SEED, capacity: 1_000_000 });
    lay(s, "tree", P, (i, f) => (f ? i * 37 : i * 29) % 19_000_000);
    const counts = storage(g, new Uint32Array(P).fill(2));
    s.births("tree", "seed", counts, SEEDING); // compiles the pipelines
    s.flush();
    g.device.queue.writeBuffer(s.kind("seed").alloc, 0, new Uint32Array(CTL_WORDS));
    g.device.queue.writeBuffer(s.kind("seed").body, 0, new Uint32Array(1_000_000));
    rows["births of 10^6 children (ms)"] = await ms(g, () => { s.births("tree", "seed", counts, SEEDING); s.flush(); });
    const alloc = await s.read("seed", "alloc");
    expect(alloc[CTL.tail]).toBe(1_000_000);
    counts.destroy();
  }
  {
    const s = new Store(g), n = 10_000_000;
    s.declare({ name: "stem", capacity: n, placed: true, fields: [] });
    lay(s, "stem", n, (i, f) => philox([i, f, 0, 0], [5, 6])[0] % 19_200_000);
    const k = s.kind("stem");
    s.index(k);
    s.flush();
    rows["index of 10^7 objects (ms)"] = await ms(g, () => { s.index(k); s.flush(); });
    const start = await s.read("stem", "start");
    expect(start[CELLS]).toBe(n);
  }
  {
    // about 600 stems in each of 64 cells, the closed wood of the plan's table, among 10^6 elsewhere
    const s = new Store(g), n = 1_000_000, near = 64 * 600;
    s.declare({ name: "stem", capacity: n, placed: true, fields: [{ name: "girth", type: "u32", unit: "mm", scale: 1 }, { name: "age", type: "u32", unit: "day", scale: 1 }] });
    lay(s, "stem", n, (i, f) => (f === 2 ? i : f === 3 ? 7 : i < near ? ((i >> (f ? 3 : 0)) % 8) * CELL_MM + (i % 997) * 75 : 8 * CELL_MM + (philox([i, f, 0, 0], [5, 6])[0] % 10_000_000)));
    s.mirror.watch("view", { x0: 0, y0: 0, x1: 7, y1: 7 });
    await s.step(1);
    s.begin(2);
    await g.device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    await s.land();
    const t1 = performance.now();
    let seen = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const c = s.mirror.cell("stem", x, y); if (c === PENDING) throw new Error("a watched cell is pending"); seen += c.length; }
    const t2 = performance.now();
    rows["64-cell window landing, 38,400 objects: gather, copy, map (ms)"] = Math.round((t1 - t0) * 100) / 100;
    rows["the same 64 cells made into objects on the CPU (ms)"] = Math.round((t2 - t1) * 100) / 100;
    expect(seen).toBe(near);
  }
  console.log(`store costs on ${g.adapter}:`, rows);
}, 120_000);
