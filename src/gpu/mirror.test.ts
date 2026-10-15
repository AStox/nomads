import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "./device";
import { CELL_MM } from "./wgsl/index";
import { type KindSpec, Store, slotOfId } from "./store";
import { type Obj, type Pending, PENDING } from "./mirror";

afterAll(releaseGpu);

const LOG: KindSpec = {
  name: "log", capacity: 1000, placed: true,
  fields: [{ name: "mass", type: "u32", unit: "g", scale: 1 }, { name: "wet", type: "i32", unit: "fraction", scale: 65536 }],
};
// An object the mirror holds, or a failure saying what it held instead.
const held = (o: Obj | null | Pending): Obj => { if (!o || o === PENDING) throw new Error(`the mirror holds ${String(o)}`); return o; };
const mm = (cells: number) => Math.round(cells * CELL_MM);

test("a delta queued on a tick shows in the mirror at once and in GPU state after the next upload", async () => {
  const s = new Store(await theGpu());
  s.declare(LOG);
  s.mirror.watch("camp", { x0: 10, y0: 10, x1: 12, y1: 12 });
  const log = s.spawn("log", { x: mm(11.5), y: mm(11.5), mass: 5000, wet: -3 });
  expect(s.mirror.cell("log", 11, 11)).toBe(PENDING);
  await s.step(1);
  const id = log.id, slot = slotOfId(id);
  expect(id).toBeGreaterThanOrEqual(0);
  expect(held(s.mirror.get(id)).v).toEqual({ x: mm(11.5), y: mm(11.5), mass: 5000, wet: -3 });
  // tick 2: queued while the tick's CPU work goes on, after its upload
  s.begin(2);
  s.set(id, "mass", 4200);
  expect(held(s.mirror.get(id)).v.mass).toBe(4200);
  await s.land();
  expect(held(s.mirror.get(id)).v.mass).toBe(4200); // laid over the landing, which doesn't have it yet
  expect((await s.read("log", "body"))[3 * LOG.capacity + slot]).toBe(5000);
  // tick 3 uploads it
  await s.step(3);
  expect((await s.read("log", "body"))[3 * LOG.capacity + slot]).toBe(4200);
  expect(held(s.mirror.get(id)).v.mass).toBe(4200);
  // a kill leaves the mirror at once, and a move takes the object to its new cell
  const other = s.spawn("log", { x: mm(10.2), y: mm(10.2), mass: 1 });
  expect(s.mirror.cell("log", 10, 10)).toEqual([other]);
  s.set(id, "x", mm(12.5));
  expect(s.mirror.cell("log", 11, 11)).toEqual([]);
  expect(s.mirror.cell("log", 12, 11)).toEqual([held(s.mirror.get(id))]);
  s.kill(id);
  expect(s.mirror.get(id)).toBeNull();
  expect(s.mirror.cell("log", 12, 11)).toEqual([]);
  await s.step(4);
  expect(s.mirror.get(id)).toBeNull();
  expect(held(s.mirror.get(other.id)).v.mass).toBe(1);
  expect((await s.read("log", "body"))[slot] & 1).toBe(0);
});

test("a lookup outside every window is pending, and answered the next tick", async () => {
  const s = new Store(await theGpu());
  s.declare(LOG);
  const far = s.spawn("log", { x: mm(200.5), y: mm(100.5), mass: 77 });
  await s.step(1);
  expect(s.mirror.cell("log", 200, 100)).toBe(PENDING);
  expect(s.mirror.get(far.id)).toBe(PENDING);
  await s.step(2);
  const page = s.mirror.cell("log", 200, 100);
  if (page === PENDING) throw new Error("still pending a tick later");
  expect(page.map((o) => o.v.mass)).toEqual([77]);
  expect(held(s.mirror.get(far.id)).v.mass).toBe(77);
  // asked again, it stays; left alone for a tick, it goes
  await s.step(3);
  expect(s.mirror.cell("log", 200, 100)).not.toBe(PENDING);
  await s.step(4);
  await s.step(5);
  expect(s.mirror.cell("log", 200, 100)).toBe(PENDING);
});

test("a kill by a stale id over a recycled slot leaves the new object alone, in the mirror and on the GPU", async () => {
  const s = new Store(await theGpu());
  s.declare(LOG);
  s.mirror.watch("camp", { x0: 3, y0: 3, x1: 3, y1: 3 });
  const a = s.spawn("log", { x: mm(3.5), y: mm(3.5), mass: 10 });
  await s.step(1);
  const old = a.id;
  s.kill(old);
  await s.step(2);
  const b = s.spawn("log", { x: mm(3.5), y: mm(3.5), mass: 20 });
  await s.step(3);
  expect(slotOfId(b.id)).toBe(slotOfId(old));
  expect(held(s.mirror.get(b.id)).v.mass).toBe(20);
  s.kill(old);
  expect(s.mirror.get(old)).toBeNull();
  expect(held(s.mirror.get(b.id)).v.mass).toBe(20);
  expect(s.mirror.cell("log", 3, 3)).toEqual([held(s.mirror.get(b.id))]);
  s.set(b.id, "mass", 21);
  expect(held(s.mirror.get(b.id)).v.mass).toBe(21);
  await s.step(4);
  const body = await s.read("log", "body"), slot = slotOfId(b.id);
  expect(body[slot] & 1).toBe(1);
  expect(body[3 * LOG.capacity + slot]).toBe(21);
  expect(held(s.mirror.get(b.id)).v.mass).toBe(21);
  expect(s.mirror.get(old)).toBeNull();
});

test("a still kind the GPU hasn't changed keeps its pages, and copies only the cells newly watched", async () => {
  const s = new Store(await theGpu());
  s.declare({ ...LOG, name: "rock", still: true });
  const page = (cx: number, cy: number): Obj[] => { const p = s.mirror.cell("rock", cx, cy); if (p === PENDING) throw new Error(`cell ${cx}, ${cy} is pending`); return p; };
  s.mirror.watch("camp", { x0: 5, y0: 5, x1: 5, y1: 5 });
  s.spawn("rock", { x: mm(5.5), y: mm(5.5), mass: 1 });
  const b = s.spawn("rock", { x: mm(6.5), y: mm(5.5), mass: 2 });
  await s.step(1);
  const a = page(5, 5)[0];
  expect(a.v.mass).toBe(1);
  // nothing changed on the GPU: the same objects, nothing copied
  await s.step(2);
  expect(page(5, 5)[0]).toBe(a);
  // a cell newly watched is copied, the rest kept
  s.mirror.watch("camp", { x0: 5, y0: 5, x1: 6, y1: 5 });
  await s.step(3);
  expect(page(5, 5)[0]).toBe(a);
  expect(page(6, 5).map((o) => o.v.mass)).toEqual([2]);
  // a change makes the next landing copy everything afresh
  s.set(b.id, "mass", 3);
  await s.step(4);
  expect(page(5, 5)[0]).not.toBe(a);
  expect(page(5, 5)[0].v).toEqual(a.v);
  expect(page(6, 5)[0].v.mass).toBe(3);
});
