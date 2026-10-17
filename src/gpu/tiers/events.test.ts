import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "../device";
import { geowait, next32, philox, rinit } from "../rand";
import { CTL } from "../wgsl/alloc";
import { CELL_MM } from "../wgsl/index";
import { N } from "../../terrain/grid";
import { type Field, Store, loadStore } from "../store";
import { Drivers } from "./drivers";
import { DAY, HOUR } from "../../sim/ticks";
import { Events, NEVER, UNDRAWN } from "./events";
import { access } from "../wgsl/alloc";
import { drvAccess } from "../wgsl/drivers";
import { FIXED } from "../wgsl/fixed";
import { RAND } from "../wgsl/rand";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

const YEAR = 365, SEED = 0x5eed, STREAM = 9, VOLES = 1 << 16;
// Air in hundredths of a degree: a year's cold and warm (coldest on day 0) and noise by cell and hour.
const WEATHER = `
let r = philox(vec4u(cell, hour, 0u, 0u), vec2u(91u, 2u));
let day = i32((hour / 24u) % 365u);
set_air(cell, 1800i - 20i * abs(day - 182i) + i32(r.x % 600u) - 300i);`;
const airAt = (cell: number, hour: number) => {
  const r = philox([cell, hour, 0, 0], [91, 2])[0], day = Math.floor(hour / 24) % 365;
  return 1800 - 20 * Math.abs(day - 182) + (r % 600) - 300;
};
// The chance of dying a tick, times 2^32: a floor, and more the colder the hour.
const HAZARD = `
let air = drv_at(CH_AIR, cell_of(self_x(slot), self_y(slot)), c / ${HOUR}u);
return 16000u + u32(max(-air, 0i)) * 40u;`;
const hazardAt = (cell: number, c: number) => 16000 + Math.max(-airAt(cell, Math.floor(c / HOUR)), 0) * 40;
const DIE = `self_set_died(slot, c); self_kill(slot);`;
const FIELDS: Field[] = [{ name: "next", type: "u32", unit: "tick", scale: 1 }, { name: "died", type: "u32", unit: "tick", scale: 1 }];
const placeOf = (i: number) => ({ x: (i % 8) * CELL_MM + 1000, y: ((i >> 3) % 8) * CELL_MM + 1000 });
const cellOfVole = (i: number) => ((i >> 3) % 8) * N + (i % 8);

// The same law stepped every tick: each live vole draws its own word each tick of the day and dies when it falls
// under the hazard.
const PER_TICK = (fields: readonly Field[], d: Drivers) => `
${FIXED}
${RAND}
struct Params { cap: u32, d0: u32, d1: u32, c: u32 }
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@group(0) @binding(1) var<storage, read> drv: array<u32>;
@group(0) @binding(2) var<uniform> P: Params;
${access("self", "b", "P.cap", { fields }, true)}
${drvAccess(d.layout)}
fn hazard(slot: u32, c: u32) -> u32 {
${HAZARD}
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
  let slot = g.x;
  if (slot >= P.cap || !self_alive(slot)) { return; }
  for (var c = P.d0; c < P.d1; c++) {
    rinit(${SEED}u, 77u, slot, c);
    if (next32() < hazard(slot, c)) { self_set_died(slot, c); self_kill(slot); return; }
  }
}`;

function lay(s: Store, kind: string, n: number, at: (i: number, f: number) => number) {
  const k = s.kind(kind), C = k.capacity, body = new Uint32Array((1 + k.fields.length) * C);
  for (let i = 0; i < n; i++) {
    body[i] = 3;
    for (let f = 0; f < k.fields.length; f++) body[(1 + f) * C + i] = at(i, f);
  }
  s.g.device.queue.writeBuffer(k.body, 0, body);
  s.g.device.queue.writeBuffer(k.alloc, CTL.tail * 4, Uint32Array.of(n));
  k.peek.tail = n;
}

// A year of voles dying by the cold, event-driven, and (with ticks) the same voles stepped every tick.
async function year(g: Gpu, ticks: boolean) {
  const s = new Store(g);
  const d = new Drivers(s, { channels: [{ name: "air", unit: "degC", scale: 100, bound: 10_000 }], hours: 48 });
  s.declare({ name: "vole", capacity: VOLES, placed: true, fields: FIELDS });
  if (ticks) s.declare({ name: "tvole", capacity: VOLES, placed: true, fields: FIELDS });
  const E = new Events(s, { kind: "vole", seed: SEED, stream: STREAM, hazard: HAZARD, event: DIE, drivers: d });
  const per = ticks ? PER_TICK(s.kind("tvole").fields, d) : "";
  s.law({ name: "day", due: (t) => t % DAY === 0, run: (st, t) => {
    for (let h = 0; h < 24; h++) { d.write(WEATHER); d.advance(); }
    const day = t / DAY - 1;
    E.day(day);
    if (ticks) { const k = st.kind("tvole"); st.run(per, [k.body, d.ring], [VOLES / 64], [VOLES, day * DAY, (day + 1) * DAY, 0]); }
  } });
  lay(s, "vole", VOLES, (i, f) => [placeOf(i).x, placeOf(i).y, UNDRAWN | 0, 0][f]);
  if (ticks) lay(s, "tvole", VOLES, (i, f) => [placeOf(i).x, placeOf(i).y, 0, 0][f]);
  let most = 0;
  for (let day = 1; day <= YEAR; day++) { await s.step(day * DAY); most = Math.max(most, E.due); }
  return { s, body: await s.read("vole", "body"), tbody: ticks ? await s.read("tvole", "body") : null, most };
}

test("an event-driven population's deaths over a year match per-tick stepping within sampling error, and its kernels are bit-identical across adapters", async () => {
  const a = await year(await theGpu(), true), C = VOLES;
  const died = (body: Uint32Array) => {
    const months = new Array(12).fill(0);
    for (let i = 0; i < C; i++) if ((body[i] & 1) === 0) months[Math.min(11, Math.floor(body[4 * C + i] / ((YEAR * DAY) / 12)))]++;
    return months;
  };
  const ev = died(a.body), tk = died(a.tbody!), total = (m: number[]) => m.reduce((x, y) => x + y, 0);
  const z = ev.map((e, m) => (e - tk[m]) / Math.sqrt(e + tk[m]));
  console.log("deaths by month, event-driven:", ev.join(" "), "\n                 per tick:    ", tk.join(" "), "\n z:", z.map((v) => v.toFixed(2)).join(" "));
  for (const v of z) expect(Math.abs(v)).toBeLessThan(4.5);
  expect(Math.abs((total(ev) - total(tk)) / Math.sqrt(total(ev) + total(tk)))).toBeLessThan(4.5);
  expect(total(ev)).toBeGreaterThan(C / 4);
  // the kernel's twin, vole by vole: the same deaths at the same ticks
  const pmax = 2 ** 24, end = YEAR * DAY, later = (c: number, w: number) => (w >= NEVER - c ? NEVER : c + w + 1);
  for (let i = 0; i < 400; i++) {
    const key = (STREAM << 17) | 1;
    rinit(SEED, key, i, 0);
    let nx = later(0, geowait(pmax)), dead = -1;
    while (nx < end) {
      const c = nx;
      rinit(SEED, key, i, c);
      const u = next32();
      if (u >>> 8 < Math.min(hazardAt(cellOfVole(i), c), pmax)) { dead = c; break; }
      nx = later(c, geowait(pmax));
    }
    expect(dead < 0 ? a.body[i] & 1 : a.body[4 * C + i]).toBe(dead < 0 ? 1 : dead);
    if (dead < 0) expect(a.body[3 * C + i]).toBe(nx);
  }
  // a day's candidates come to about one each (2^-8 a tick), so most individuals are due every day
  expect(a.most).toBeGreaterThan(C / 4);
  low = await openGpu("low-power");
  const b = await year(low, false);
  expect(Buffer.from(b.body.buffer).equals(Buffer.from(a.body.buffer))).toBe(true);
}, 600_000);

test("an event-driven population saved mid-run and loaded gives the same hashes, and goes on the same", async () => {
  const g = await theGpu();
  const world = (s: Store) => {
    const d = new Drivers(s, { channels: [{ name: "air", unit: "degC", scale: 100, bound: 10_000 }], hours: 48 });
    s.adopt({ name: "vole", capacity: 4096, placed: true, fields: FIELDS });
    const E = new Events(s, { kind: "vole", seed: SEED, stream: STREAM, hazard: HAZARD, event: DIE, drivers: d });
    s.law({ name: "day", due: (t) => t % DAY === 0, run: (_, t) => { for (let h = 0; h < 24; h++) { d.write(WEATHER); d.advance(); } E.day(t / DAY - 1); } });
    return E;
  };
  const s = new Store(g);
  world(s);
  lay(s, "vole", 4096, (i, f) => [placeOf(i).x, placeOf(i).y, UNDRAWN | 0, 0][f]);
  for (let day = 1; day <= 10; day++) await s.step(day * DAY);
  const t = loadStore(g, await s.dump()), E = world(t);
  expect(await t.hash()).toBe(await s.hash());
  expect(E.end).toBe(10 * DAY);
  for (let day = 11; day <= 30; day++) { await s.step(day * DAY); await t.step(day * DAY); }
  expect(await t.hash()).toBe(await s.hash());
  const body = await t.read("vole", "body");
  expect(Array.from({ length: 4096 }, (_, i) => body[i] & 1).filter((a) => !a).length).toBeGreaterThan(0);
  s.destroy(); t.destroy();
}, 120_000);
