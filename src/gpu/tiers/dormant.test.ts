import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "../device";
import { readback, storage } from "../kernel";
import { mul64, qexp } from "../fixed";
import { next32 } from "../rand";
import { CELLS, CELL_MM } from "../wgsl/index";
import { N } from "../../terrain/grid";
import { DAY } from "../../sim/world";
import { type Field, Store, idOf, loadStore, slotOfId } from "../store";
import { type Obj, type Pending, PENDING } from "../mirror";
import { Drivers, HOUR } from "./drivers";
import { Dormant, type DormantInput, StaticDormant, cellAt } from "./dormant";
import { drvAccess } from "../wgsl/drivers";
import { access } from "../wgsl/alloc";
import { FIXED } from "../wgsl/fixed";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const held = (o: Obj | null | Pending): Obj => { if (!o || o === PENDING) throw new Error(`the mirror holds ${String(o)}`); return o; };

test("an hour is twelve of the world's ticks", () => {
  expect(HOUR * 24).toBe(DAY);
});

// ---------- a log's moisture and decay ----------
// Rain in hundredths of a millimetre an hour and air warmth above freezing in hundredths of a degree, from a hash of
// (cell, hour): a synthetic weather that differs from cell to cell and hour to hour.
const WEATHER = `
let r = philox(vec4u(cell, hour, 0u, 0u), vec2u(77u, 5u));
var rain = 0i;
if ((r.x & 255u) < 40u) { rain = i32(r.y % 900u); }
let diurnal = abs(i32(hour % 24u) - 12i) * 60i;
let air = 600i - diurnal + i32(r.z % 1000u) - 500i;
set_rain(cell, rain);
set_warm(cell, max(air, 0i));`;
const CHANNELS = [
  { name: "rain", unit: "mm/h", scale: 100, bound: 5000 },
  { name: "warm", unit: "degC h above 0", scale: 100, bound: 4000 },
];
const ATTRS: Field[] = [{ name: "w0", type: "i32", unit: "moisture", scale: 1 }, { name: "m0", type: "u32", unit: "g", scale: 1 }];
const STATE: Field[] = [
  { name: "wet", type: "i32", unit: "moisture", scale: 1 },
  { name: "dh", type: "u32", unit: "degC h", scale: 100 },
  { name: "mass", type: "u32", unit: "g", scale: 1 },
];
// The law: moisture gains three units a hundredth of a millimetre of rain and loses one a hundredth of a degree-hour
// of warmth; mass decays as e^-(degree-hours / 16) in Q16.16. A function of accumulated drivers.
const LAW = `
out_wet = attr_w0 + 3i * I_rain - I_warm;
out_dh = bitcast<u32>(I_warm);
let p = mul64(attr_m0, bitcast<u32>(qexp(-i32(out_dh >> 4u))));
out_mass = (p.x >> 16u) | (p.y << 16u);`;
const massOf = (m0: number, dh: number) => { const p = mul64(m0, qexp(-(dh >>> 4)) >>> 0); return ((p[0] >>> 16) | (p[1] << 16)) >>> 0; };
const law = (v: DormantInput) => ({ wet: (v.attr.w0 + Math.imul(3, v.I.rain) - v.I.warm) | 0, dh: v.I.warm >>> 0, mass: massOf(v.attr.m0, v.I.warm >>> 0) });
// The same log stepped hourly as an active object: each hour's recorded values added to its state.
const STEP = (cap: number, fields: readonly Field[], d: Drivers) => `
${FIXED}
struct Params { cap: u32, a: u32, b: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> drv: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${access("o", "b", "P.cap", { fields }, true)}
${drvAccess(d.layout)}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= ${cap}u || !o_alive(i)) { return; }
  let cell = cell_of(o_x(i), o_y(i));
  let h = drv_hour() - 1u;
  let rain = drv_at(CH_RAIN, cell, h);
  let warm = drv_at(CH_WARM, cell, h);
  o_set_wet(i, o_wet(i) + 3i * rain - warm);
  let dh = o_dh(i) + bitcast<u32>(warm);
  o_set_dh(i, dh);
  let p = mul64(o_m0(i), bitcast<u32>(qexp(-i32(dh >> 4u))));
  o_set_mass(i, (p.x >> 16u) | (p.y << 16u));
}`;

const LOGS = 600, TREES = 300, C = 4096, R = 49;
const placeOf = (i: number) => ({ x: ((i * 7919) % 40) * CELL_MM + ((i * 104729) % CELL_MM), y: ((i * 31) % 12) * CELL_MM + ((i * 7) % CELL_MM) });
const INIT = `
child_set_x(slot, parent_x(parent) + 1000u);
child_set_y(slot, parent_y(parent));
child_set_w0(slot, i32(parent) - 50i);
child_set_m0(slot, 20000u + parent * 7u);`;

// Logs lying dormant for 30 days of recorded weather, and the same logs as active objects stepped hourly: 600 laid by
// the CPU at hour 0, 300 born of trees on the GPU at hour 100 (so with anchors that aren't zero). Then one dormant log
// is touched and lives a day on as an active object.
async function logs(g: Gpu) {
  const s = new Store(g);
  const d = new Drivers(s, { channels: CHANNELS, hours: R - 1 });
  const T = new Dormant(s, d, { dormant: "log", active: "logup", capacity: C, activeCapacity: C, channels: ["rain", "warm"], attrs: ATTRS, state: STATE, wgsl: LAW, ts: law, life: 24 * 365 * 20 });
  s.declare({ name: "tree", capacity: TREES, placed: true, fields: [] });
  const up = s.kind("logup"), ones = storage(g, new Uint32Array(TREES).fill(1));
  s.law({ name: "weather", due: (t) => t % HOUR === 0, run: () => { d.write(WEATHER); d.advance(); } });
  s.law({ name: "logs", due: (t) => t % HOUR === 0, run: (st) => st.run(STEP(C, up.fields, d), [up.body, d.ring], [C / 256], [C, 0, 0, 0]) });
  s.law({ name: "fall", due: (t) => t === 100 * HOUR, run: (st) => {
    T.births("tree", ones, INIT);
    st.births("tree", "logup", ones, `${INIT}\nchild_set_born(slot, drv_hour()); child_set_wet(slot, i32(parent) - 50i); child_set_mass(slot, 20000u + parent * 7u);`, { bufs: [{ name: "drv", buf: d.ring }], wgsl: drvAccess(d.layout) });
  } });
  for (let i = 0; i < LOGS; i++) {
    const at = placeOf(i), w0 = (i % 97) - 40, m0 = 10000 + i * 13;
    held(T.lay({ ...at, w0, m0 }) as Obj | Pending);
    s.spawn("logup", { ...at, born: 0, w0, m0, wet: w0, dh: 0, mass: m0 });
  }
  for (let i = 0; i < TREES; i++) s.spawn("tree", placeOf(LOGS + i));
  for (let h = 1; h <= 720; h++) await s.step(h * HOUR);
  const out = storage(g, STATE.length * C * 4);
  T.evaluate(out);
  s.flush();
  const now = new Uint32Array(await readback(g, out));
  const dormant = await s.read("log", "body"), active = await s.read("logup", "body");
  const sums = new Uint32Array(await readback(g, d.ring));
  // touching log 5: pending until its record has landed, and then its cell's sums, with no hour committed since
  const id = idOf(s.kind("log").n, 5, 1);
  const first = T.touch(id);
  await s.step(720 * HOUR + 1);
  expect(T.touch(id)).toBe(PENDING);
  await s.step(720 * HOUR + 2);
  const promoted = held(T.touch(id));
  const record = { ...promoted.v };
  for (let h = 721; h <= 744; h++) await s.step(h * HOUR);
  const later = await s.read("logup", "body");
  out.destroy();
  ones.destroy();
  return { s, T, now, dormant, active, sums, first, promoted, record, later, hour: d.hour, id };
}

test("a dormant log's moisture and mass after 30 days equal the same log stepped hourly over the same drivers, bit for bit, on both adapters", async () => {
  const a = await logs(await theGpu());
  const fields = a.s.kind("log").fields, uf = a.s.kind("logup").fields;
  const at = (f: string) => fields.findIndex((x) => x.name === f) + 1, ua = (f: string) => uf.findIndex((x) => x.name === f) + 1;
  const n = LOGS + TREES;
  let differ = 0, changed = 0;
  for (let i = 0; i < n; i++) {
    expect(a.dormant[i] & 1).toBe(1);
    // the twin, from the record and its cell's sums at hour 720 (ring slot 720 mod R)
    const v: Record<string, number> = {};
    for (const f of fields) v[f.name] = f.type === "i32" ? a.dormant[at(f.name) * C + i] | 0 : a.dormant[at(f.name) * C + i];
    const cell = cellAt(v.x, v.y), sums = Uint32Array.of(a.sums[(720 % R) * CELLS + cell], a.sums[(R + (720 % R)) * CELLS + cell]);
    const twin = a.T.stateOf(v, sums, 720);
    STATE.forEach((f, k) => {
      const gpu = f.type === "i32" ? a.now[k * C + i] | 0 : a.now[k * C + i];
      const stepped = f.type === "i32" ? a.active[ua(f.name) * C + i] | 0 : a.active[ua(f.name) * C + i];
      if (gpu !== twin[f.name] || gpu !== stepped) differ++;
    });
    if (i >= LOGS) expect(v.born).toBe(100);
    if (i >= LOGS) expect(v.arain + v.awarm).toBeGreaterThan(0);
    if (twin.wet !== v.w0 && twin.mass !== v.m0) changed++;
  }
  expect(differ).toBe(0);
  expect(changed).toBe(n);
  expect(a.hour).toBe(744);
  // the touched log: pending first; then its identity and its state at hour 720, and a day stepped as active equal
  // to its own hourly twin
  expect(a.first).toBe(PENDING);
  expect([a.record.oslot, a.record.ogen]).toEqual([5, 1]);
  expect([a.record.wet, a.record.dh, a.record.mass]).toEqual([a.now[5] | 0, a.now[C + 5], a.now[2 * C + 5]]);
  expect(a.s.mirror.get(a.id)).toBeNull();
  const slot = slotOfId(a.promoted.id);
  for (const f of ["wet", "dh", "mass"]) expect(a.later[ua(f) * C + slot]).toBe(a.later[ua(f) * C + 5]);
  expect(a.T.touch(a.id)).toBe(a.s.mirror.get(a.promoted.id));
  low = await openGpu("low-power");
  const b = await logs(low);
  expect(Buffer.from(b.now.buffer).equals(Buffer.from(a.now.buffer))).toBe(true);
  expect(Buffer.from(b.later.buffer).equals(Buffer.from(a.later.buffer))).toBe(true);
}, 300_000);

// ---------- static stones ----------
const STONE = `
out_x = x0 + next32() % ${CELL_MM}u;
out_y = y0 + next32() % ${CELL_MM}u;
out_dia = 20u + (next32() >> 22u);`;
const stone = (cell: number) => {
  const x0 = (cell % N) * CELL_MM, y0 = Math.floor(cell / N) * CELL_MM;
  return { x: x0 + (next32() % CELL_MM), y: y0 + (next32() % CELL_MM), dia: 20 + (next32() >>> 22) };
};

test("a static dormant stone stores nothing until moved, and then is stored at its new place", async () => {
  const g = await theGpu(), s = new Store(g);
  const counts = Uint32Array.from({ length: CELLS }, (_, c) => Math.imul(c, 2654435761) >>> 27);
  const S = new StaticDormant(s, { name: "stone", capacity: 64, counts, attrs: [{ name: "dia", type: "u32", unit: "mm", scale: 1 }], seed: 0x5eed, stream: 3, wgsl: STONE, ts: stone });
  const cell = 3 * N + 9, n = counts[cell], row = 4, out = storage(g, n * row * 4);
  expect(n).toBeGreaterThan(5);
  await s.step(1);
  expect(s.kind("stone").peek.tail).toBe(0);
  expect(S.moved).toBe(0);
  const enumerate = async () => { S.enumerate(cell, out); s.flush(); return new Uint32Array(await readback(g, out)); };
  const before = await enumerate(), twin = S.members(cell);
  expect(twin.length).toBe(n);
  twin.forEach((m, k) => expect([before[k * row], before[k * row + 1], before[k * row + 2], before[k * row + 3]]).toEqual([1, m.v.x, m.v.y, m.v.dia]));
  // member 2 moved to a cell far away
  const was = twin[2].v, to = { x: 200 * CELL_MM + 5, y: 100 * CELL_MM + 7 };
  const obj = S.lift(cell, 2, to);
  s.mirror.watch("there", { x0: 200, y0: 100, x1: 200, y1: 100 });
  await s.step(2);
  const K = s.kind("stone"), body = await s.read("stone", "body"), f = (name: string) => (K.field[name] + 1) * 64;
  expect(K.peek.tail).toBe(1);
  expect(body[0] & 1).toBe(1);
  expect([body[f("x")], body[f("y")], body[f("ocell")], body[f("ok")], body[f("dia")]]).toEqual([to.x, to.y, cell, 2, was.dia]);
  const page = s.mirror.cell("stone", 200, 100);
  if (page === PENDING) throw new Error("the watched cell is pending");
  expect(page.map((o) => o.id)).toEqual([obj.id]);
  const after = await enumerate();
  expect(after[2 * row]).toBe(0);
  expect(S.members(cell).map((m) => m.k)).toEqual(twin.map((m) => m.k).filter((k) => k !== 2));
  const m = S.member(cell, 2);
  expect(m && "moved" in m ? m.moved.id : -1).toBe(obj.id);
  console.log(`static stones: ${counts.reduce((x, y) => x + y, 0)} members held in ${S.bytes()} bytes, ${S.moved} moved and stored in kind stone`);
  out.destroy();
});

// ---------- saving ----------
// A small world of weather, dormant logs and their active twins, made the same way on a store and on its reload.
function logWorld(s: Store) {
  const d = new Drivers(s, { channels: CHANNELS, hours: R - 1 });
  const T = new Dormant(s, d, { dormant: "log", active: "logup", capacity: C, activeCapacity: C, channels: ["rain", "warm"], attrs: ATTRS, state: STATE, wgsl: LAW, ts: law, life: 24 * 365 * 20 });
  const up = s.kind("logup");
  s.law({ name: "weather", due: (t) => t % HOUR === 0, run: () => { d.write(WEATHER); d.advance(); } });
  s.law({ name: "logs", due: (t) => t % HOUR === 0, run: (st) => st.run(STEP(C, up.fields, d), [up.body, d.ring], [C / 256], [C, 0, 0, 0]) });
  return { d, T };
}

test("drivers, dormant logs and a promotion saved mid-run and loaded give the same hashes, and go on the same", async () => {
  const g = await theGpu(), s = new Store(g), { T } = logWorld(s);
  for (let i = 0; i < 50; i++) T.lay({ ...placeOf(i), w0: i, m0: 5000 + i });
  for (let h = 1; h <= 30; h++) await s.step(h * HOUR);
  const id = idOf(s.kind("log").n, 3, 1);
  T.touch(id);
  await s.step(30 * HOUR + 1);
  T.touch(id);
  await s.step(30 * HOUR + 2);
  const promoted = held(T.touch(id));
  // a log laid after the last tick in a landed cell, its spawn still queued, is saved with the queue
  const late = T.lay({ x: placeOf(3).x + 5, y: placeOf(3).y, w0: 1, m0: 7000 });
  expect(late).not.toBe(PENDING);
  const t = loadStore(g, await s.dump()), back = logWorld(t);
  expect(await t.hash()).toBe(await s.hash());
  expect(back.d.hour).toBe(30);
  for (let h = 31; h <= 54; h++) { await s.step(h * HOUR); await t.step(h * HOUR); }
  expect(await t.hash()).toBe(await s.hash());
  // the promotion is remembered: touching the log again leads to the same active object, no new one
  const again = back.T.touch(id);
  expect(again === PENDING || again?.id === promoted.id).toBe(true);
  expect(t.queue.length).toBe(0);
  s.destroy(); t.destroy();
}, 120_000);

test("a static kind's moved members saved and loaded stay moved, and the stores go on the same", async () => {
  const g = await theGpu(), counts = Uint32Array.from({ length: CELLS }, (_, c) => Math.imul(c, 2654435761) >>> 27);
  const make = (s: Store) => new StaticDormant(s, { name: "stone", capacity: 64, counts, attrs: [{ name: "dia", type: "u32", unit: "mm", scale: 1 }], seed: 0x5eed, stream: 3, wgsl: STONE, ts: stone });
  const s = new Store(g), S = make(s), cell = 3 * N + 9;
  S.lift(cell, 1, { x: 100 * CELL_MM, y: 100 * CELL_MM });
  await s.step(1);
  const queued = S.lift(cell, 4);
  const t = loadStore(g, await s.dump()), back = make(t);
  expect(await t.hash()).toBe(await s.hash());
  expect(back.moved).toBe(2);
  await s.step(2);
  await t.step(2);
  expect(await t.hash()).toBe(await s.hash());
  const m = back.member(cell, 4);
  expect(m && "moved" in m ? m.moved.id : -1).toBe(queued.id);
  expect(back.members(cell).map((x) => x.k)).toEqual(S.members(cell).map((x) => x.k));
  const row = 4, out = storage(g, counts[cell] * row * 4);
  back.enumerate(cell, out);
  t.flush();
  const got = new Uint32Array(await readback(g, out));
  expect([got[1 * row], got[4 * row], got[2 * row]]).toEqual([0, 0, 1]);
  out.destroy(); s.destroy(); t.destroy();
}, 60_000);

// ---------- the review's cases ----------
test("an enumeration recorded before a lift in the same encoder reads the members as they were", async () => {
  const g = await theGpu(), s = new Store(g), counts = Uint32Array.from({ length: CELLS }, (_, c) => (c % 7) + 5);
  const S = new StaticDormant(s, { name: "stone", capacity: 64, counts, attrs: [{ name: "dia", type: "u32", unit: "mm", scale: 1 }], seed: 0x5eed, stream: 3, wgsl: STONE, ts: stone });
  const cell = 5 * N + 2, row = 4, before = storage(g, counts[cell] * row * 4), after = storage(g, counts[cell] * row * 4);
  // look, then take, then look again, all before one submit (twice, so the list grows past its first buffer)
  for (const k of [1, 3]) {
    S.enumerate(cell, before);
    S.lift(cell, k);
    S.enumerate(cell, after);
    s.flush();
    const was = new Uint32Array(await readback(g, before)), now = new Uint32Array(await readback(g, after));
    expect(was[k * row]).toBe(1);
    expect(now[k * row]).toBe(0);
  }
  before.destroy(); after.destroy(); s.destroy();
});

test("a dormant law that reads its cell gives the promoted object exactly the GPU's state", async () => {
  const g = await theGpu(), s = new Store(g);
  const d = new Drivers(s, { channels: CHANNELS, hours: R - 1 });
  const W: Field[] = [{ name: "w", type: "i32", unit: "", scale: 1 }];
  const T = new Dormant(s, d, {
    dormant: "twig", active: "twigup", capacity: 256, activeCapacity: 256, channels: ["rain"], attrs: [], state: W, life: 1000,
    wgsl: "out_w = I_rain * i32(cell % 13u + 1u) - i32(cell);", ts: (v) => ({ w: (Math.imul(v.I.rain, (v.cell % 13) + 1) - v.cell) | 0 }),
  });
  s.law({ name: "weather", due: (t) => t % HOUR === 0, run: () => { d.write(WEATHER); d.advance(); } });
  for (let i = 0; i < 20; i++) T.lay(placeOf(i));
  for (let h = 1; h <= 40; h++) await s.step(h * HOUR);
  const out = storage(g, 256 * 4);
  T.evaluate(out);
  s.flush();
  const gpu = new Int32Array(await readback(g, out));
  const ids = Array.from({ length: 20 }, (_, i) => idOf(s.kind("twig").n, i, 1));
  for (const id of ids) T.touch(id);
  await s.step(40 * HOUR + 1);
  for (const id of ids) T.touch(id);
  await s.step(40 * HOUR + 2);
  const promoted = ids.map((id) => held(T.touch(id)));
  promoted.forEach((o, i) => expect(o.v.w).toBe(gpu[i]));
  expect(new Set(promoted.map((o) => cellAt(o.v.x, o.v.y))).size).toBeGreaterThan(5);
  out.destroy(); d.destroy(); s.destroy();
});

test("two driver histories on one store each land their own cells' sums", async () => {
  const g = await theGpu(), s = new Store(g);
  const a = new Drivers(s, { name: "air", channels: [{ name: "x", unit: "", scale: 1, bound: 100_000 }], hours: 4 });
  const b = new Drivers(s, { name: "soil", channels: [{ name: "y", unit: "", scale: 1, bound: 300_000 }], hours: 4 });
  s.law({ name: "w", due: () => true, run: () => { a.write("set_x(cell, i32(cell));"); a.advance(); b.write("set_y(cell, 1000i + 2i * i32(cell));"); b.advance(); } });
  const A = 7 * N + 3, B = 200 * N + 100;
  await s.step(1);
  expect(a.sums(A)).toBe(PENDING);
  expect(b.sums(B)).toBe(PENDING);
  await s.step(2);
  // each history's landing holds its own cell's sums: asked again, they come with tick 3's landing at hour 3
  expect(Array.from(a.sums(A) as Uint32Array)).toEqual([2 * A]);
  expect(Array.from(b.sums(B) as Uint32Array)).toEqual([2 * (1000 + 2 * B)]);
  await s.step(3);
  expect(Array.from(a.sums(A) as Uint32Array)).toEqual([3 * A]);
  expect(Array.from(b.sums(B) as Uint32Array)).toEqual([3 * (1000 + 2 * B)]);
  a.destroy(); b.destroy(); s.destroy();
});

test("a dormant member read past its life fails loudly, on the CPU and on the GPU", async () => {
  const g = await theGpu(), s = new Store(g);
  const d = new Drivers(s, { channels: CHANNELS, hours: R - 1 });
  const T = new Dormant(s, d, { dormant: "log", active: "logup", capacity: 64, activeCapacity: 64, channels: ["rain", "warm"], attrs: ATTRS, state: STATE, wgsl: LAW, ts: law, life: 6 });
  s.law({ name: "weather", due: (t) => t % HOUR === 0, run: () => { d.write(WEATHER); d.advance(); } });
  T.lay({ ...placeOf(0), w0: 0, m0: 100 });
  for (let h = 1; h <= 6; h++) await s.step(h * HOUR);
  const out = storage(g, STATE.length * 64 * 4), id = idOf(s.kind("log").n, 0, 1);
  // at its life it is still read
  T.evaluate(out);
  await s.step(6 * HOUR + 1);
  for (let h = 7; h <= 8; h++) await s.step(h * HOUR);
  // past it: touching throws, and an evaluation makes the next landing throw
  expect(T.touch(id)).toBe(PENDING);
  await s.step(8 * HOUR + 1);
  expect(T.touch(id)).toBe(PENDING);
  await s.step(8 * HOUR + 2);
  expect(() => T.touch(id)).toThrow(/past its life of 6 hours/);
  T.evaluate(out);
  await expect(s.step(8 * HOUR + 3)).rejects.toThrow(/1 members were evaluated past their life/);
  out.destroy(); d.destroy(); s.destroy();
});
