// What the representation tiers cost on the GPU, reported, not gated: recording an hour of drivers over every cell,
// 10^8 dormant members' states, an event-driven day of 10^8 individuals, a lumped step of 10^6 bins.
import { afterAll, expect, test } from "bun:test";
import { type Gpu, releaseGpu, theGpu } from "../device";
import { readback, storage } from "../kernel";
import { CTL } from "../wgsl/alloc";
import { type Kind, Store } from "../store";
import { Drivers } from "./drivers";
import { DAY } from "../../sim/ticks";
import { Dormant } from "./dormant";
import { Events } from "./events";
import { Lumped, DEATH } from "./lumped";

afterAll(releaseGpu);

const ms = async (g: Gpu, f: () => void) => {
  await g.device.queue.onSubmittedWorkDone();
  const t0 = performance.now();
  f();
  await g.device.queue.onSubmittedWorkDone();
  return Math.round((performance.now() - t0) * 100) / 100;
};
// Fills a kind's first n slots on the GPU: alive at generation 1, field f of slot i set by the WGSL expression
// fields[f] (of i), the tail past them.
function fill(s: Store, k: Kind, n: number, fields: string[]) {
  const src = `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) w: vec3u) {
  let i = g.x + g.y * w.x * 256u;
  if (i >= ${n}u) { return; }
  b[i] = 3u;
  ${fields.map((e, f) => `b[${f + 1}u * ${k.capacity}u + i] = ${e};`).join("\n  ")}
}`;
  const groups = Math.ceil(n / 256), x = Math.min(groups, 65535);
  s.run(src, [k.body], [x, Math.ceil(groups / x)]);
  s.g.device.queue.writeBuffer(k.alloc, CTL.tail * 4, Uint32Array.of(n));
  s.flush();
}
const HASH = (salt: number) => `((i * 0x9e3779b1u) ^ (i >> 15u) ^ ${salt}u) * 0x85ebca77u`;

test("costs: drivers, 10^8 dormant states, an event-driven day of 10^8, a lumped step of 10^6 bins (reported)", async () => {
  const g = await theGpu(), rows: Record<string, number | string> = {};
  {
    // four channels over every cell, a hashed writer, an hour at a time
    const s = new Store(g), chan = (name: string) => ({ name, unit: "", scale: 100, bound: 10_000 });
    const d = new Drivers(s, { channels: ["air", "rain", "canopy", "warm"].map(chan), hours: 48 });
    const W = `let r = philox(vec4u(cell, hour, 0u, 0u), vec2u(7u, 1u)); set_air(cell, i32(r.x % 3000u) - 1000i); set_rain(cell, i32(r.y % 500u)); set_canopy(cell, i32(r.z % 10000u)); set_warm(cell, max(i32(r.x % 3000u) - 1000i, 0i));`;
    d.write(W); d.advance(); s.flush();
    rows["drivers: an hour of 4 channels over 65,536 cells, written and committed (ms)"] = await ms(g, () => { for (let h = 0; h < 24; h++) { d.write(W); d.advance(); } s.flush(); }) / 24;
    rows["drivers: memory, 4 channels, 48 hours (MB)"] = Math.round(d.bytes() / 2 ** 20);
    d.destroy(); s.destroy();
  }
  {
    // 10^8 dormant sticks (x, y, born, one anchor: 20 bytes each with the slot word), their mass from degree-hours
    const s = new Store(g), N = 100_000_000;
    const d = new Drivers(s, { channels: [{ name: "warm", unit: "degC h", scale: 100, bound: 4000 }], hours: 24 });
    const T = new Dormant(s, d, { dormant: "stick", active: "stickup", capacity: N, activeCapacity: 1, channels: ["warm"], attrs: [], state: [{ name: "mass", type: "u32", unit: "g", scale: 1 }], wgsl: `out_mass = bitcast<u32>(qexp(-i32(bitcast<u32>(I_warm) >> 4u)));`, ts: () => ({}), life: 1000 });
    fill(s, s.kind("stick"), N, [`${HASH(1)} % 19200000u`, `${HASH(2)} % 19200000u`, "0u", "0u"]);
    for (let h = 0; h < 30; h++) { d.write(`set_warm(cell, i32((cell * 7u + hour * 13u) % 2000u));`); d.advance(); }
    const out = storage(g, 4 * N);
    T.evaluate(out); s.flush();
    rows["dormant: 10^8 states evaluated, each from its anchor and its cell's sums (ms)"] = await ms(g, () => { T.evaluate(out); s.flush(); });
    const some = new Uint32Array(await readback(g, out, 16));
    expect(some.some((v) => v !== 0)).toBe(true);
    rows["dormant: bytes a member (slot word, x, y, born, one anchor)"] = 20;
    out.destroy(); d.destroy(); s.destroy();
  }
  for (const [step, lg, K, label] of [[1, 8, 4096, "tick steps, p_max 2^-8"], [1, 16, 4096, "tick steps, p_max 2^-16"], [DAY, 8, 1 << 20, "day steps, p_max 2^-8"]] as const) {
    // 10^8 individuals with only next (8 bytes each), a constant hazard, their next candidates spread over twice the
    // mean wait from day 1 on (as if they had been running), and day 1 measured
    const s = new Store(g), N = 100_000_000;
    const k = s.declare({ name: "seedling", capacity: N, fields: [{ name: "next", type: "u32", unit: "tick", scale: 1 }] });
    const E = new Events(s, { kind: "seedling", seed: 1, stream: 1, step, lg, hazard: `return ${K}u;`, event: "self_kill(slot);" });
    fill(s, k, N, [`${DAY}u + (${HASH(3)} % ${2 ** (lg + 1)}u) * ${step}u`]);
    await g.device.queue.onSubmittedWorkDone();
    rows[`events, ${label}: a day of 10^8 (flag, scan, compact, events) (ms)`] = await ms(g, () => { E.day(1); s.flush(); });
    rows[`events, ${label}: candidates a day (expected)`] = Math.round((N * (DAY / step)) / 2 ** lg);
    E.destroy(); s.destroy();
  }
  {
    // 2^20 bins: every cell, 16 states, 1,000 to 20,000 members each; a day each bin's members die 1% and 3% move on
    const s = new Store(g), cells = 65536, states = 16;
    s.declare({ name: "bugup", capacity: 1, placed: true, fields: ["lkey", "le", "lsig"].map((name) => ({ name, type: "u32" as const, unit: "", scale: 1 })) });
    const L = new Lumped(s, {
      name: "bug", capacity: 3 << 20, contribs: 3 << 20, members: 1, seed: 7, stream: 2, dense: 0, lump: 0, active: "bugup", promote: "",
      law: `fn law(cell: u32, state: u32, tick: u32) -> Split { var sp: Split; sp.m = 2u; sp.t[0] = 42949673u; sp.t[1] = 171798692u; sp.s[0] = DEATH; sp.s[1] = (state + 1u) % 16u; sp.s[2] = state; _ = &inp; return sp; }`,
      ts: (_c, state) => ({ t: [42949673, 171798692], s: [DEATH, (state + 1) % 16, state] }),
    });
    for (let c = 0; c < cells; c++) for (let st = 0; st < states; st++) L.add(c, st, 1000 + (Math.imul(c * 16 + st, 0x9e3779b1) >>> 0) % 19000);
    L.step(DAY); s.flush();
    rows["lumped: step of 2^20 bins: split, contributions, sort, merge, compact (ms)"] = await ms(g, () => { L.step(2 * DAY); s.flush(); });
    const bins = await L.read();
    rows["lumped: bins after it"] = bins.length;
    rows["lumped: bytes a bin (two tables)"] = 32;
    rows["lumped: step scratch, bytes a bin and a contribution"] = "80 and 32";
    expect(bins.length).toBeGreaterThan(cells * states);
    L.destroy(); s.destroy();
  }
  console.log(`tier costs on ${g.adapter}:`, rows);
}, 600_000);
