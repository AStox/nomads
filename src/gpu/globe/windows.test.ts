// Windows at lattice cells, made and kept: a window of a cell is the same bytes in any visit order and through the store, the queue
// makes what is asked for first and the camera's cells nearest first, and the cells a camera needs cover what it sees. Run one case
// at a time: bun test ./src/gpu/globe/windows.test.ts -t "<name>" --timeout 280000
// The first case makes four windows on a staged planet (src/gpu/globe/staged.ts) and takes some two minutes.
import { afterAll, describe, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { skyAt } from "../../sim/sky";
import { fromLatLon } from "./grid";
import { cellAtPlace, cellFrame, cellStep, cover, idOf, type Cell } from "./lattice";
import { SITE, coastPlanet } from "./staged";
import { frameAt, windowBytes, type Window } from "./window";
import { Windows, memoryWindowStore, packWindow, unpackWindow, wanted, windowAtCell } from "./windows";

afterAll(releaseGpu);
const hashOf = (w: Window) => Bun.hash(Buffer.concat(windowBytes(w))).toString(16);
const fake = (cell: Cell): Window => {
  const f = cellFrame(cell), n = idOf(cell);
  return {
    seed: 7, latDeg: f.latDeg, lonDeg: f.lonDeg, turn: f.turn, sky: skyAt(f.latDeg, f.turn),
    isle: { height: Float32Array.of(n, 1.5, NaN), rock: Uint8Array.of(1, 2, 3), driftDepth: Float32Array.of(0.25), wind: [1, -2], seasons: [{ precip: Float32Array.of(3, 4) }, { precip: Float32Array.of(5) }], rivers: [[[1, 2, 3]], []] } as unknown as Window["isle"],
    params: { upliftMYr: 1e-4, probeMeanM: [1, 2], inflow: [{ at: 5, cells: 3, m3s: [1, 2, 3, 4] }], place: { latDeg: f.latDeg, turn: f.turn } } as unknown as Window["params"],
    coarse: { heightM: 12.5, rainMm: [1, 2, 3, 4], surface: Float32Array.of(9, 8, 7) },
    seconds: { setup: 1, runs: [2, 3], rounds: [[192, 192], [384, 384]], rain: 4, water: 5, ground: 6, total: 7 },
  };
};

describe("windows at lattice cells", () => {
  test("a window made at a lattice cell is the same bytes in any visit order, and through its bytes", async () => {
    const gpu = await theGpu(), planet = coastPlanet(), A = cellAtPlace(SITE.lat, SITE.lon), B = cellStep(A, 1);
    const a1 = await windowAtCell(gpu, planet, A), b1 = await windowAtCell(gpu, planet, B);
    const b2 = await windowAtCell(gpu, planet, B), a2 = await windowAtCell(gpu, planet, A);
    console.log(`staged cells ${idOf(A)} and ${idOf(B)}: ${[a1, b1, b2, a2].map((w) => w.seconds.total.toFixed(1)).join(", ")} s; turn ${(a1.turn * 180 / Math.PI).toFixed(2)} and ${(b1.turn * 180 / Math.PI).toFixed(2)} degrees; hashes ${hashOf(a1)} ${hashOf(b1)}`);
    expect(hashOf(a2)).toBe(hashOf(a1));
    expect(hashOf(b2)).toBe(hashOf(b1));
    // the two cells are different ground
    expect(hashOf(a1)).not.toBe(hashOf(b1));
    // the window is in the cell's axes: its sky and the climate's place carry the turn, and its centre is the cell's
    expect(a1.turn).toBe(cellFrame(A).turn);
    expect(a1.params.place.turn).toBe(a1.turn);
    expect(a1.sky.turn).toBe(a1.turn);
    // through its bytes: every typed array and the numbers come back the same, and a store serves it
    const back = unpackWindow(packWindow(a1));
    expect(hashOf(back)).toBe(hashOf(a1));
    expect(JSON.stringify(back.params)).toBe(JSON.stringify(a1.params));
    expect(Array.from(back.coarse.surface)).toEqual(Array.from(a1.coarse.surface));
    expect(back.seconds).toEqual(a1.seconds);
    expect(back.sky.sunAt(10, 12)).toEqual(a1.sky.sunAt(10, 12));
    // pinned (this engine's, this staged planet's; re-record when the window's laws change and say so)
    expect(hashOf(a1)).toBe(PIN.a);
    expect(hashOf(b1)).toBe(PIN.b);
  }, 280000);

  test("a window packs to bytes and back with its nested arrays, its NaNs and its lists", () => {
    const w = fake(cellAtPlace(10, 20)), back = unpackWindow(packWindow(w));
    expect(back.isle.height[0]).toBe(w.isle.height[0]);
    expect(Number.isNaN(back.isle.height[2])).toBe(true);
    expect(back.isle.rock).toEqual(w.isle.rock);
    expect(back.isle.seasons[1].precip).toEqual(w.isle.seasons[1].precip);
    expect(back.isle.rivers).toEqual(w.isle.rivers);
    expect(back.isle.wind).toEqual([1, -2]);
    expect(back.params.inflow).toEqual(w.params.inflow);
    expect(back.coarse.surface).toEqual(w.coarse.surface);
    expect(back.latDeg).toBe(w.latDeg);
    expect(back.sky.latDeg).toBe(w.latDeg);
    expect(back.sky.turn).toBe(w.turn);
  });

  test("the queue makes a fetched cell before the camera's, the camera's nearest first, each once, and the store serves a second cache", async () => {
    const made: number[] = [], planet = coastPlanet(), store = memoryWindowStore(), gates = new Map<number, PromiseWithResolvers<void>>();
    const gate = (id: number) => { if (!gates.has(id)) gates.set(id, Promise.withResolvers<void>()); return gates.get(id)!; };
    // a maker that waits for the test to let it go
    const slow = async (_g: unknown, _p: unknown, c: Cell) => { made.push(idOf(c)); await gate(idOf(c)).promise; return fake(c); };
    const quick = async (_g: unknown, _p: unknown, c: Cell) => { made.push(idOf(c)); return fake(c); };
    const settle = async (cond: () => boolean) => { for (let i = 0; i < 1000 && !cond(); i++) await Promise.resolve(); expect(cond()).toBe(true); };
    const cells = [cellAtPlace(0, 0), cellAtPlace(0, 3), cellAtPlace(0, 6), cellAtPlace(0, 9)], ids = cells.map(idOf);
    const ws = new Windows({} as never, planet, store, "k", 2, slow);
    ws.want(cells.slice(0, 3));
    await settle(() => made.length === 1);
    const urgent = ws.fetch(cells[3]);
    gate(ids[0]).resolve();
    await settle(() => made.length === 2);
    // the first prefetch was being made when the fetch came in, which then goes before the rest of the camera's, in its order
    gate(ids[3]).resolve();
    await urgent;
    gate(ids[1]).resolve();
    gate(ids[2]).resolve();
    await settle(() => made.length === 4);
    await ws.fetch(cells[2]);
    expect(made).toEqual([ids[0], ids[3], ids[1], ids[2]]);
    // a new want replaces the pending prefetches (the window being made is not stopped)
    made.length = 0;
    const ws2 = new Windows({} as never, planet, memoryWindowStore(), "k", 2, slow);
    ws2.want(cells);
    await settle(() => made.length === 1);
    ws2.want([cells[2]]);
    gate(ids[0]).resolve();
    await ws2.fetch(cells[2]);
    expect(made).toEqual([ids[0], ids[2]]);
    // asking twice makes once and gives the same window; a cache over the same store reads it back instead of making it
    made.length = 0;
    const ws3 = new Windows({} as never, planet, store, "k", 2, quick);
    const [w1, w2] = await Promise.all([ws3.fetch(cells[1]), ws3.fetch(cells[1])]);
    expect(w1).toBe(w2);
    expect(made).toEqual([]);
    expect(ws3.log.at(-1)!.fromStore).toBe(true);
    // another sources key is another key: nothing is read back
    await new Windows({} as never, planet, store, "other", 2, quick).fetch(cells[1]);
    expect(made).toEqual([ids[1]]);
    // two windows are kept, the least recently used leaving first
    expect(ws3.peek(cells[1])).toBeDefined();
    await ws3.fetch(cells[0]);
    await ws3.fetch(cells[2]);
    expect(ws3.peek(cells[1])).toBeUndefined();
  });

  test("a cell whose window cannot be made rejects, once, and the queue goes on", async () => {
    const made: number[] = [], bad = cellAtPlace(0, 0), good = cellAtPlace(0, 3);
    const make = async (_g: unknown, _p: unknown, c: Cell) => { made.push(idOf(c)); if (idOf(c) === idOf(bad)) throw new Error("a flow passes 5000 m3 a second"); return fake(c); };
    const ws = new Windows({} as never, coastPlanet(), memoryWindowStore(), "k", 2, make);
    ws.want([bad, good]);
    await expect(ws.fetch(bad)).rejects.toThrow("a flow passes");
    await ws.fetch(good);
    await expect(ws.fetch(bad)).rejects.toThrow("a flow passes");
    ws.want([bad]);
    expect(made).toEqual([idOf(bad), idOf(good)]);
  });

  test("the cells a camera needs cover every point it sees, the home cell first, and the ones ahead come after, nearest first", () => {
    const focus = fromLatLon((10 * Math.PI) / 180, (20 * Math.PI) / 180), view = 6000;
    const cells = wanted(focus, null, view, 0), ids = new Set(cells.map(idOf));
    expect(idOf(cells[0])).toBe(idOf(cellAtPlace(10, 20)));
    expect(ids.size).toBe(cells.length);
    // every point within the view has all its windows in the list
    let seed = 5;
    const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const f = frameAt(10, 20);
    for (let k = 0; k < 500; k++) {
      const r = view * Math.sqrt(rand()), a = rand() * 2 * Math.PI, x = r * Math.cos(a), y = r * Math.sin(a);
      const p = [f.c[0] + (x * f.e[0] + y * f.n[0]) / 2e6, f.c[1] + (x * f.e[1] + y * f.n[1]) / 2e6, f.c[2] + (x * f.e[2] + y * f.n[2]) / 2e6], h = Math.hypot(p[0], p[1], p[2]);
      for (const o of cover([p[0] / h, p[1] / h, p[2] / h])) if (o.w >= 0.5) expect(ids.has(idOf(o.cell))).toBe(true);
    }
    // a camera moving east along the equator at 3 km a window's length ahead wants more cells, and the added ones lie ahead
    const heading = fromLatLon(0, (20.5 * Math.PI) / 180), ahead = wanted(focus, [heading[0] - focus[0], heading[1] - focus[1], heading[2] - focus[2]], view, 30000);
    expect(ahead.length).toBeGreaterThan(cells.length);
    expect(ahead.slice(0, cells.length).map(idOf)).toEqual(cells.map(idOf));
    const last = cellFrame(ahead.at(-1)!).c, here = cellFrame(cells[0]).c;
    const forward = last[0] * (heading[0] - focus[0]) + last[1] * (heading[1] - focus[1]) + last[2] * (heading[2] - focus[2]) - (here[0] * (heading[0] - focus[0]) + here[1] * (heading[1] - focus[1]) + here[2] * (heading[2] - focus[2]));
    expect(forward).toBeGreaterThan(0);
  });
});

// Recorded for the staged planet's cells at SITE (src/gpu/globe/staged.ts) and the cell north of it; see the first case.
const PIN = { a: "19f56f8995fb4be9", b: "75feb8a3065da9eb" };
