import { DAY, groundOf, newWorld } from "../sim/world";
import { stemDriver } from "../sim/plants";
import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { readback, storage } from "./kernel";
import { type Field, Store, idOf } from "./store";
import { PENDING } from "./mirror";
import { HOUR } from "./tiers/drivers";
import { cellAt } from "./tiers/dormant";
import { access } from "./wgsl/alloc";
import { drvAccess } from "./wgsl/drivers";
import { FIXED } from "./wgsl/fixed";
import { CELLS, CELL_MM } from "./wgsl/index";
import { DIED, TEXELS, TEXELS_SIDE, TEXEL_MM } from "./wgsl/stems";
import { common } from "./wgsl/deadwood";
import {
  BIN_DAYS, BOULDERS_HA, CLAST_DIM, CLASTS, DAY_TICKS, Deadwood, STICK_DIA, capacities, ROT, STICKS_HA, STICK_K, YEAR_DAYS, YEAR_HOURS, clastLaw, deadLaw, fallRate, lam, lasts, leafCounts, logState, squareOf, stickOf,
  type ClastKind,
} from "./deadwood";
import type { DeadLaw } from "./wgsl/deadwood";
import { N } from "../terrain/grid";
import { SPECIES, clasts, dbhOf } from "../terrain/flora";
import { Flora } from "./flora";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const SEED = 0x5eed;
const U = (name: string): Field => ({ name, type: "u32", unit: "", scale: 1 });
const PLANT_FIELDS = ["what", "size", "seed", "q", "peak", "crop"].map(U);
const PINE = SPECIES.indexOf("pine"), ASPEN = SPECIES.indexOf("aspen");
const noClasts = (): Record<ClastKind, Uint32Array> => ({ pebble: new Uint32Array(CELLS), stone: new Uint32Array(CELLS), boulder: new Uint32Array(CELLS) });

// A stand of the test: the cells of a square block, every texel of them holding one tree (a plant object) whose crown
// covers the share cover(day) of it. The raster is written as the stems' law would file it.
type Stand = { cells: number[]; trees: number };
function stand(s: Store, x0: number, y0: number, side: number, height: number, what: number, extra = 0): Stand {
  const cells: number[] = [];
  for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) cells.push(y * N + x);
  const n = cells.length * 16, cols = { x: new Uint32Array(n), y: new Uint32Array(n), what: new Uint32Array(n), size: new Uint32Array(n) };
  cells.forEach((c, i) => {
    for (let j = 0; j < 16; j++) {
      const tx = (c % N) * 4 + (j % 4), ty = Math.floor(c / N) * 4 + Math.floor(j / 4), e = i * 16 + j;
      cols.x[e] = tx * TEXEL_MM + TEXEL_MM / 2; cols.y[e] = ty * TEXEL_MM + TEXEL_MM / 2; cols.what[e] = what << 8; cols.size[e] = height;
    }
  });
  s.declare({ name: "plant", capacity: n + extra, placed: true, still: true, fields: PLANT_FIELDS });
  s.write("plant", n, cols);
  return { cells, trees: n };
}
// The raster of a stand at a cover (Q16), every texel's tree filed.
function raster(g: Gpu, st: Stand, height: number, cover: number) {
  const start = new Uint32Array(TEXELS + 1), list = new Uint32Array(3 * st.trees), byTexel = new Map<number, number>();
  st.cells.forEach((c, i) => { for (let j = 0; j < 16; j++) byTexel.set((Math.floor(c / N) * 4 + Math.floor(j / 4)) * TEXELS_SIDE + (c % N) * 4 + (j % 4), i * 16 + j); });
  let p = 0;
  for (let t = 0; t < TEXELS; t++) {
    start[t] = p;
    const e = byTexel.get(t);
    if (e !== undefined) { list[3 * p] = e; list[3 * p + 1] = (height << 1) | 1; list[3 * p + 2] = cover; p++; }
  }
  start[TEXELS] = p;
  return { start, list };
}
function rasterBufs(g: Gpu, st: Stand, height: number) {
  const r = raster(g, st, height, 0);
  return { start: storage(g, r.start), list: storage(g, r.list) };
}

// ---------- steady state ----------
// A law sped up a hundred-fold and more, so a stand comes to its steady state within a few hundred days: sticks rot at
// 0.02 a day and fall in at the cited rate times as much; logs at 0.05 a day; snags fall at 0.05 a day at 40 cm.
function fast(seed: number): DeadLaw {
  const L = deadLaw(seed), K = (perDay: number) => Math.round((perDay / 24 / ROT) * 2 ** 40);
  const speed = 0.02 / (STICK_K / YEAR_DAYS);
  return {
    ...L, stick: K(0.02), litter: Math.round(L.litter * speed), logK: L.logK.map((k) => (k ? K(0.05) : 0)),
    fallK: L.fallK.map((k) => (k ? Math.round((0.05 / 24) * 2 ** 40) : 0)),
  };
}

test("a closed stand at steady state holds input / rate by piece class: sticks, and dead trees as snags and logs", async () => {
  const g = await theGpu(), s = new Store(g), H = 20_000, D = 400, DAYS = 300;
  const st = stand(s, 40, 40, 8, H, PINE, D * DAYS);
  const r = rasterBufs(g, st, H);
  g.device.queue.writeBuffer(r.list, 0, raster(g, st, H, 65536).list);
  // a stand kept whole: D stems a day starved where the trees stand (their crowns kept in the raster), written into
  // fresh slots dead and marked as the stems' law marks them
  const L = fast(SEED), dw = new Deadwood(SEED, noClasts(), { logs: D * DAYS + 4096, bins: 64 * 64 * 2 }, L);
  let next = st.trees;
  s.law({ name: "deaths", due: (t) => t % DAY_TICKS === 0, run: (st2) => {
    const k = st2.kind("plant"), xs = new Uint32Array(D).fill(40 * CELL_MM + 1000);
    const at = (f: string) => (1 + k.field[f]) * k.capacity * 4;
    const slots = Array.from({ length: D }, (_, i) => next + i);
    for (const [f, v] of [["x", xs], ["y", xs], ["what", new Uint32Array(D).fill(PINE << 8)], ["size", new Uint32Array(D).fill(H)], ["crop", new Uint32Array(D).fill(DIED)]] as const)
      g.device.queue.writeBuffer(k.body, at(f) + slots[0] * 4, v);
    g.device.queue.writeBuffer(k.body, slots[0] * 4, new Uint32Array(D).fill(2)); // generation 1, dead
    g.device.queue.writeBuffer(k.alloc, 2 * 4, Uint32Array.of(next + D));
    next += D;
  } });
  dw.attach(s, () => r);
  const sticks: number[] = [], pieces: number[] = [], snags: number[] = [];
  for (let d = 1; d <= DAYS; d++) {
    for (let h = 1; h <= 24; h++) await s.step(((d - 1) * 24 + h) * HOUR);
    if (d < 150) continue;
    const { tot } = dw.sweepBins(null), stv = dw.sweepLogs(false);
    s.flush();
    sticks.push(new Uint32Array(await readback(g, tot, 4))[0]);
    const states = new Uint32Array(await readback(g, stv));
    pieces.push(states.filter((v) => v === 1 || v === 2).length);
    snags.push(states.filter((v) => v === 1).length);
  }
  const mean = (a: number[]) => a.reduce((t, v) => t + v, 0) / a.length;
  // Input over the rate, as counted once a day just after the day's births: a pool fed I a day and losing a share k of
  // it a day holds I / (1 - e^-k) then, which is I / k but for the day's pulse [derived]. Sticks, the litterfall a day,
  // averaged over whole bins of BIN_DAYS (each bin's pulse spread over its days the same way); dead trees, D a day, and
  // the snags among them D losing both the rate and the fall.
  const held = (input: number, k: number) => input / (1 - Math.exp(-k));
  const perDay = (L.litter / 65536) * st.cells.length, cycles = sticks.slice(0, Math.floor(sticks.length / BIN_DAYS) * BIN_DAYS);
  const fall = (fallRate(L, PINE, Math.round(dbhOf("pine", H / 1000) * 10)) / 2 ** 40) * 24; // a day, at the stand's diameter
  expect(Math.abs(mean(cycles) / held(perDay, 0.02) - 1)).toBeLessThan(0.01);
  expect(Math.abs(mean(pieces) / held(D, 0.05) - 1)).toBeLessThan(0.01);
  expect(Math.abs(mean(snags) / held(D, 0.05 + fall) - 1)).toBeLessThan(0.02);
  console.log(JSON.stringify({ sticks: Math.round(mean(cycles)), sticksExpected: Math.round(held(perDay, 0.02)), inputOverRate: Math.round(perDay / 0.02), pieces: Math.round(mean(pieces)), piecesExpected: Math.round(held(D, 0.05)), snags: Math.round(mean(snags)), snagsExpected: Math.round(held(D, 0.05 + fall)) }));
  dw.destroy();
  s.destroy();
}, 600_000);

// ---------- dormant against stepped ----------
// The same sticks as active objects, each stepped hourly: the hour's rot added to its own sum, and whether it still lies.
const ACT: Field[] = ["cell", "u", "acc", "lies"].map(U);
const STEP = (cap: number, L: DeadLaw, d: Deadwood) => `
${FIXED}
${common(L)}
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> drv: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${access("o", "b", "P.cap", { fields: [U("x"), U("y"), ...ACT] }, true)}
${drvAccess(d.drivers!.layout)}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= ${cap}u || !o_alive(i)) { return; }
  let acc = o_acc(i) + bitcast<u32>(drv_at(CH_ROT, o_cell(i), drv_hour() - 1u));
  o_set_acc(i, acc);
  o_set_lies(i, select(0u, 1u, lasts(o_u(i), lam(acc, KSTICK))));
}`;

type Closing = { s: Store; dw: Deadwood; lies: Uint32Array; copies: { id: string; cell: number }[]; dormant: Set<string>; counts: Uint32Array; hour: number };
async function closing(g: Gpu): Promise<Closing> {
  const s = new Store(g), H = 15_000, DAYS = YEAR_DAYS;
  const st = stand(s, 100, 60, 4, H, PINE);
  const r = rasterBufs(g, st, H);
  // the canopy closes over the year: a fifth covered at first, whole at the end
  const coverOn = (d: number) => Math.round(65536 * (0.2 + (0.8 * d) / DAYS));
  g.device.queue.writeBuffer(r.list, 0, raster(g, st, H, coverOn(0)).list);
  s.law({ name: "canopy", due: (t) => t % DAY_TICKS === 0, run: (_, t) => g.device.queue.writeBuffer(r.list, 0, raster(g, st, H, coverOn(t / DAY_TICKS)).list) });
  const dw = new Deadwood(SEED, noClasts(), { logs: 1 << 16, bins: 4096 });
  dw.attach(s, () => r);
  s.declare({ name: "act", capacity: 1 << 18, placed: true, fields: ACT });
  s.mirror.watch("stand", { x0: 100, y0: 60, x1: 103, y1: 63 });
  await s.step(1);
  // every stick of the stand's pool as an active copy, before the first hour is committed
  const copies: { id: string; cell: number }[] = [];
  for (const c of st.cells) {
    const bins = s.mirror.cell("stickbin", c % N, Math.floor(c / N));
    if (bins === PENDING) throw new Error("the stand's bins haven't landed");
    for (const bin of bins) for (let k = 0; k < bin.v.n; k++) {
      const m = stickOf(SEED, c, bin.v.born, k);
      s.spawn("act", { x: m.x, y: m.y, cell: c, u: m.u, acc: 0, lies: 1 });
      copies.push({ id: `s${c}.${bin.v.born}.${k}`, cell: c });
    }
  }
  const act = s.kind("act");
  s.law({ name: "stepped", due: (t) => t % HOUR === 0, run: (st2) => st2.run(STEP(act.capacity, dw.law, dw), [act.body, dw.drivers!.ring], [act.capacity / 256], [act.capacity, 0, 0, 0]) });
  for (let h = 1; h <= DAYS * 24; h++) await s.step(h * HOUR);
  await s.step(DAYS * 24 * HOUR + 1);
  const body = await s.read("act", "body"), lies = body.subarray((1 + act.field.lies) * act.capacity, (2 + act.field.lies) * act.capacity);
  const { each } = dw.sweepBins(null);
  s.flush();
  const counts = new Uint32Array(await readback(g, each, s.kind("stickbin").capacity * 4));
  const dormant = new Set<string>();
  for (const c of st.cells) { const l = dw.sticksIn(c); if (l === PENDING) throw new Error("pending"); for (const p of l) dormant.add(p.id); }
  return { s, dw, lies: Uint32Array.from(lies.subarray(0, copies.length)), copies, dormant, counts, hour: dw.hourNow };
}

test("a dormant stick under a closing canopy queried after a year equals the same stick stepped hourly, on both adapters", async () => {
  const a = await closing(await theGpu());
  expect(a.hour).toBe(YEAR_HOURS);
  expect(a.copies.length).toBeGreaterThan(20_000);
  let differ = 0, lying = 0;
  a.copies.forEach((c, i) => { if ((a.lies[i] === 1) !== a.dormant.has(c.id)) differ++; lying += a.lies[i]; });
  expect(differ).toBe(0);
  // a year of rot at about 0.2 a year took about a sixth of them, the open start a little more
  expect(lying / a.copies.length).toBeGreaterThan(0.78);
  expect(lying / a.copies.length).toBeLessThan(0.84);
  // the GPU's own count of the bins agrees with both
  expect([...a.counts].reduce((t, v) => t + v, 0)).toBe(lying + litterSince(a));
  low = await openGpu("low-power");
  const b = await closing(low);
  expect(Buffer.from(b.lies.buffer).equals(Buffer.from(a.lies.buffer))).toBe(true);
  expect(Buffer.from(b.counts.buffer).equals(Buffer.from(a.counts.buffer))).toBe(true);
  for (const x of [a, b]) { x.dw.destroy(); x.s.destroy(); }
}, 600_000);
// The sticks the year's litterfall laid, which have no active copies: those of the bins born after the pool.
function litterSince(a: Closing) {
  let n = 0;
  for (const c of new Set(a.copies.map((x) => x.cell))) {
    const l = a.dw.sticksIn(c);
    if (l !== PENDING) n += l.filter((p) => !p.id.includes(".0.")).length;
  }
  return n;
}

// ---------- taking ----------
test("a picked stick never comes back: it is gone from its bin for good, and new sticks come only from litterfall", async () => {
  const g = await theGpu(), s = new Store(g), H = 15_000;
  const st = stand(s, 10, 10, 1, H, PINE);
  const r = rasterBufs(g, st, H);
  g.device.queue.writeBuffer(r.list, 0, raster(g, st, H, 65536).list);
  const dw = new Deadwood(SEED, noClasts(), { logs: 1 << 12, bins: 1024 });
  dw.attach(s, () => r);
  s.mirror.watch("here", { x0: 10, y0: 10, x1: 10, y1: 10 });
  await s.step(1);
  const cell = st.cells[0], before = dw.sticksIn(cell);
  if (before === PENDING) throw new Error("pending");
  expect(before.length).toBeGreaterThan(8000);
  const picked = before[17];
  dw.touch(picked, null);
  const seen = new Set<string>();
  for (let h = 1; h <= 3 * BIN_DAYS * 24; h++) {
    await s.step(h * HOUR);
    const now = dw.sticksIn(cell);
    if (now === PENDING) continue;
    for (const p of now) seen.add(p.id);
    expect(now.some((p) => p.id === picked.id)).toBe(false);
  }
  expect(dw.piece(picked.id)).toBeNull();
  // the new ones are the litterfall's, every one of a bin born since
  const fresh = [...seen].filter((id) => !before.some((p) => p.id === id));
  expect(fresh.length).toBeGreaterThan(0);
  for (const id of fresh) expect(Number(id.split(".")[1])).toBeGreaterThan(0);
  // the GPU's count leaves it out as the CPU does
  const { tot } = dw.sweepBins(null);
  s.flush();
  const now = dw.sticksIn(cell);
  if (now === PENDING) throw new Error("pending");
  expect(new Uint32Array(await readback(g, tot, 4))[0]).toBe(now.length);
  dw.destroy();
  s.destroy();
}, 300_000);

// ---------- logs ----------
test("a dead tree stands as a snag and falls as a log, its state on the GPU the twin's at every hour", async () => {
  const g = await theGpu(), s = new Store(g), H = 24_000, n = 2000;
  const st = stand(s, 30, 30, 2, H, ASPEN, n);
  const r = rasterBufs(g, st, H);
  g.device.queue.writeBuffer(r.list, 0, raster(g, st, H, 40000).list);
  const L = fast(SEED), dw = new Deadwood(SEED, noClasts(), { logs: 1 << 14, bins: 1024 }, L);
  dw.attach(s, () => r);
  s.mirror.watch("here", { x0: 30, y0: 30, x1: 31, y1: 31 });
  // the stand's trees die, a fifth of them on the first day
  const plant = s.kind("plant");
  for (let i = 0; i < st.trees / 5; i++) { const id = idOf(plant.n, i, 1); s.set(id, "crop", DIED); s.kill(id); }
  let checked = 0;
  for (let h = 1; h <= 30 * 24; h++) {
    await s.step(h * HOUR);
    if (h % 24 !== 1) continue;
    const stv = dw.sweepLogs(false);
    s.flush();
    const states = new Uint32Array(await readback(g, stv)), body = await s.read("log", "body"), k = s.kind("log");
    const at = (f: string, i: number) => body[(1 + k.field[f]) * k.capacity + i];
    for (let i = 0; i < k.capacity; i++) {
      if (states[i] === 3) continue;
      const v: Record<string, number> = {};
      for (const f of k.fields) v[f.name] = at(f.name, i);
      const rot = dw.rotAt(cellAt(v.x, v.y));
      if (rot === PENDING) throw new Error("pending");
      expect(states[i]).toBe(logState(L, v, rot, dw.hourNow));
      if (v.fr) expect(v.fr).toBe(fallRate(L, v.what, v.dia));
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(1000);
  dw.destroy();
  s.destroy();
}, 300_000);

// ---------- clasts ----------
test("a cell's clasts on the GPU are the twin's, square by square, and their sizes follow the power law", async () => {
  const g = await theGpu(), s = new Store(g);
  const counts = noClasts(), cell = 70 * N + 33;
  counts.pebble[cell] = 6000; counts.stone[cell] = 900; counts.boulder[cell] = 120;
  s.declare({ name: "plant", capacity: 1, placed: true, still: true, fields: PLANT_FIELDS });
  const dw = new Deadwood(SEED, counts, { logs: 1 << 10, bins: 1024 });
  const r = { start: storage(g, (TEXELS + 1) * 4), list: storage(g, 4) };
  dw.attach(s, () => r);
  for (const [ci, c] of CLASTS.entries()) {
    const n = counts[c.kind][cell], out = storage(g, n * 5 * 4);
    dw.clasts[ci].enumerate(cell, out);
    s.flush();
    const gpu = new Uint32Array(await readback(g, out));
    const twin = dw.clastsIn(c.kind, cell, 0, 0, N * CELL_MM, N * CELL_MM);
    expect(twin.length).toBe(n);
    const byK = new Map(twin.map((p) => [Number(p.id.split(".")[1]), p]));
    for (let k = 0; k < n; k++) {
      const p = byK.get(k)!;
      expect([gpu[5 * k], gpu[5 * k + 1], gpu[5 * k + 2], gpu[5 * k + 3], gpu[5 * k + 4]]).toEqual([1, p.x, p.y, Math.round(p.size * 1000), p.seed]);
    }
    // the cumulative law between the class's bounds: the share at or above the geometric middle
    const mid = Math.sqrt(c.lo * c.hi), above = twin.filter((p) => p.size * 1000 >= mid).length / n;
    const want = ((mid / c.lo) ** -2.9 - (c.hi / c.lo) ** -2.9) / (1 - (c.hi / c.lo) ** -2.9);
    if (n > 500) expect(Math.abs(above - want)).toBeLessThan(4 * Math.sqrt((want * (1 - want)) / n) + 0.002);
    out.destroy();
  }
  // the halvings: every square's members lie in it, and the square counts sum to the cell's
  const law = clastLaw(SEED, CLASTS[0]), leaves = leafCounts(law, cell, counts.pebble[cell]);
  expect(leaves.reduce((t, v) => t + v, 0)).toBe(counts.pebble[cell]);
  const [ix, iy] = squareOf(37), box = dw.clastsIn("pebble", cell, (cell % N) * CELL_MM + (ix * CELL_MM) / 16, Math.floor(cell / N) * CELL_MM + (iy * CELL_MM) / 16, (cell % N) * CELL_MM + ((ix + 1) * CELL_MM) / 16 - 1, Math.floor(cell / N) * CELL_MM + ((iy + 1) * CELL_MM) / 16 - 1);
  expect(box.length).toBe(leaves[37]);
  // one moved is left out where it lay
  const one = dw.clastsIn("stone", cell, 0, 0, N * CELL_MM, N * CELL_MM)[5];
  dw.touch(one, null);
  expect(dw.clastsIn("stone", cell, 0, 0, N * CELL_MM, N * CELL_MM).some((p) => p.id === one.id)).toBe(false);
  expect(dw.piece(one.id)).toBeNull();
  dw.destroy();
  s.destroy();
  expect(STICKS_HA).toBe(17000);
}, 300_000);

// ---------- seed 1 ----------
test("seed 1's deadwood and clasts: counts and volumes against the cited reserves, and the memory they take", async () => {
  const w = newWorld(1, 0), g = await theGpu(), s = new Store(g), ground = groundOf(1), flora = new Flora(ground.flora);
  flora.attach(s, stemDriver(w));
  const [pebble, stone, boulder] = clasts(ground.isle, 1, BOULDERS_HA, CLAST_DIM, CLASTS.map((c) => [c.lo / 1000, c.hi / 1000] as const));
  const room = capacities(ground.flora), dw = new Deadwood(1, { pebble, stone, boulder }, room);
  dw.attach(s, () => flora.raster());
  const t0 = performance.now();
  await s.step(1);
  const layMs = performance.now() - t0;
  // the pool as the world begins: sticks, snags and logs, their volumes, and the cover they lie under
  const measure = async () => {
    const { tot } = dw.sweepBins(null), st = dw.sweepLogs(false);
    s.flush();
    const sticks = new Uint32Array(await readback(g, tot, 4))[0], states = new Uint32Array(await readback(g, st)), body = await s.read("log", "body"), k = s.kind("log");
    const at = (f: string, i: number) => body[(1 + k.field[f]) * k.capacity + i];
    const vol = [0, 0, 0], n = [0, 0, 0], bySpecies: Record<string, number> = {};
    for (let i = 0; i < k.capacity; i++) {
      if (states[i] === 3 || states[i] === 0) continue;
      const d = at("dia", i) / 1000, l = at("len", i) / 1000;
      vol[states[i]] += (Math.PI / 4) * d * d * l; n[states[i]]++;
      bySpecies[SPECIES[at("what", i)]] = (bySpecies[SPECIES[at("what", i)]] ?? 0) + 1;
    }
    return { sticks, snags: n[1], logs: n[2], snagM3: vol[1], logM3: vol[2], bySpecies };
  };
  const pool = await measure();
  const cover = new Uint32Array(await readback(g, dw.buffers().find(([n]) => n === "cover")![1]));
  let coverHa = 0;
  for (const c of cover) coverHa += (c / 65536) * 0.5625;
  // a day of the stems' law and the deadwood's after it: the snags of the trees it killed
  const logs0 = pool.snags + pool.logs;
  for (let h = 1; h <= 24; h++) await s.step(h * (DAY / 24));
  const day = await measure();
  // what the deadwood's kernels cost on the GPU: the bins' and the logs' sweeps, an hour's rot, and a day's law with the
  // stems' (the second day, its kernels compiled)
  const gpuMs = async (f: () => void) => { await g.device.queue.onSubmittedWorkDone(); const t = performance.now(); f(); s.flush(); await g.device.queue.onSubmittedWorkDone(); return Math.round(performance.now() - t); };
  const binsMs = await gpuMs(() => dw.sweepBins(null)), logsMs = await gpuMs(() => dw.sweepLogs(false));
  for (let h = 25; h < 47; h++) await s.step(h * (DAY / 24));
  const hourMs = await gpuMs(() => s.begin(47 * (DAY / 24)));
  await s.land();
  const dayMs = await gpuMs(() => s.begin(2 * DAY));
  await s.land();
  // the stems' day alone, the deadwood's law left out for it (at the end, as it skips the deadwood's hour)
  const at = s.laws.findIndex((l) => l.name === "deadwood"), dead = s.laws.splice(at, 1);
  const stemsMs = await gpuMs(() => s.begin(3 * DAY));
  await s.land();
  s.laws.splice(at, 0, ...dead);
  const sum = (a: Uint32Array) => a.reduce((t, v) => t + v, 0), mb = (x: number) => Math.round(x / 2 ** 20);
  const stickM3 = pool.sticks * (Math.PI / 4) * STICK_DIA * STICK_DIA * 1;
  console.log(JSON.stringify({
    adapter: g.adapter, coverHa: Math.round(coverHa), layMs: Math.round(layMs),
    sticks: pool.sticks, sticksHa: Math.round(pool.sticks / coverHa), stickM3Ha: +(stickM3 / coverHa).toFixed(1),
    snags: pool.snags, logs: pool.logs, snagM3Ha: +(pool.snagM3 / coverHa).toFixed(1), logM3Ha: +(pool.logM3 / coverHa).toFixed(1), bySpecies: pool.bySpecies,
    snagsBornDay1: day.snags + day.logs - logs0,
    boulders: sum(boulder), stones: sum(stone), pebbles: sum(pebble),
    room, deadwoodMB: mb(dw.bytes()), binsMs, logsMs, hourMs, dayWithStemsMs: dayMs, stemsDayMs: stemsMs,
  }));
  expect(pool.sticks).toBeGreaterThan(1e7);
  expect(pool.logs + pool.snags).toBeGreaterThan(1e5);
  expect(dw.bytes()).toBeLessThan(0.5 * 2 ** 30);
  dw.destroy();
  flora.destroy();
  s.destroy();
}, 900_000);
