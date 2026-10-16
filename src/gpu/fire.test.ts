// The fire's receivers (wgsl/fire.ts, driven by fire.ts): a tick of the GPU's law against the TypeScript twin bit for bit
// on both of the dev machine's adapters, over a batch that has every way the law goes: parts lit by a flame standing
// over them and by radiation, things lit by brands far downwind, things warming that don't light, and things cooling
// with no fire near (plan Unit 12).
import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { Store } from "./store";
import { Receivers, pack, receive, type Batch } from "./fire";
import { LIT, NONE, PT, PW, R, RW } from "./wgsl/fire";
import { blazeWords, keyOf, type Blaze } from "../sim/spread";
import { contact, exposure, group } from "../sim/combustion";
import { PHYS, woodOf } from "../sim/fuel";
import { TILE_M } from "../sim/world";

let low: Gpu | null = null;
afterAll(async () => { low?.device.destroy(); await releaseGpu(); });

// A seeded stream of numbers in [0, 1) for laying the batch out (mulberry32).
function stream(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
// Thirty looks of three beds round a point burning in a wind blowing east by a little south: a campfire, a burning bush
// and a burning tree, each blazing a little differently look by look; and 3,000 things round them out to 60 m, mostly
// downwind: grass, twigs, branches, logs and shelters' pieces, some already warm, at waters from bone dry to drowned.
function batch(seed: number): Batch {
  const rnd = stream(seed), cx = 4000, cy = 4000, len = Math.hypot(1, 0.2);
  const looks = Array.from({ length: 30 }, (_, k) => [0, 1, 2].map((bed) => {
    const lf = [0.8, 2.5, 9][bed] * (0.8 + 0.4 * rnd()), q = [60, 900, 20000][bed] * (0.7 + 0.6 * rnd()), cos = 0.5 + 0.5 * rnd();
    const b: Blaze = {
      px: cx + bed * 2 / TILE_M, py: cy + bed / TILE_M, q, lf, rb: [0.3, 0.9, 2][bed], heap: [0.25, 0.8, 1.5][bed], gas: q / 15000,
      cos, sin: Math.sqrt(1 - cos * cos), dx: 1 / len, dy: 0.2 / len, head: 2 + 6 * rnd(), veg: [0, 0.5, 3][(bed + k) % 3],
    };
    return blazeWords(b, bed);
  }));
  const pieces = [{ ...PHYS.fiber }, woodOf("pine", 0.0035, 0.002), woodOf("oak", 0.03, 0.5), woodOf("pine", 0.11, 4)];
  const receivers = Array.from({ length: 3000 }, (_, i) => {
    const d = 60 * rnd() ** 2, a = (rnd() < 0.7 ? 0.4 : Math.PI) * (2 * rnd() - 1), half = rnd() < 0.2 ? 0 : 1.5 * rnd();
    const words: number[] = new Array(RW).fill(0), np = 1 + Math.floor(5 * rnd());
    words[R.x] = Math.round((cx * TILE_M + d * Math.cos(a)) * 100); words[R.y] = Math.round((cy * TILE_M + d * Math.sin(a)) * 100);
    words[R.half] = Math.round(half * 100); words[R.key] = keyOf(`t${i}`);
    words[R.tinder] = rnd() < 0.8 ? Math.floor(np * rnd()) : NONE; words[R.odds] = Math.round(65536 * rnd());
    const parts = Array.from({ length: np }, () => {
      const phys = pieces[Math.floor(pieces.length * rnd())], m = rnd() < 0.1 ? 0.5 : 0.04 + 0.2 * rnd(), lo = rnd() < 0.5 ? 0 : 6 * rnd();
      const e = exposure(group(phys, 1, m), { temp: 18, wind: 6 * rnd(), rain: rnd() < 0.1 ? 1 : 0, veg: 0.5 }), v: number[] = new Array(PW).fill(0);
      v[PT.lo] = Math.round(lo * 100); v[PT.hi] = Math.round((lo + 0.05 + 3 * rnd()) * 100); v[PT.contact] = Math.round(contact(phys.d) * 65536);
      v[PT.loss] = Math.round(e.loss * 65536); v[PT.thin] = Math.round(e.thin * 256); v[PT.deep] = Math.round(e.deep * 256); v[PT.ok] = e.ok ? 1 : 0;
      v[PT.heat] = rnd() < 0.3 ? Math.round(e.thin * 256 * rnd()) : 0;
      return v;
    });
    return { words, parts };
  });
  return pack(seed, 123456, looks, receivers);
}
async function onGpu(g: Gpu, b: Batch) {
  const s = new Store(g), r = new Receivers();
  r.attach(s);
  let got: Uint32Array | null = null;
  r.queue(b, (o) => { got = o; });
  await s.step(1);
  s.destroy();
  return got!;
}

test("a tick of the receivers' law equals the twin bit for bit on both adapters, lighting by flame, radiation and brands, warming and cooling", async () => {
  const b = batch(0x5eed), twin = receive(b), lit = (r: number) => (twin[r] & LIT) !== 0;
  // every way the law goes is in the batch
  const heat = (r: number, j: number) => twin[b.nr + b.words[b.offR + RW * r + R.p0] + j] & 0x7fffffff;
  const start = (r: number, j: number) => b.words[b.offP + PW * (b.words[b.offR + RW * r + R.p0] + j) + PT.heat];
  const far = (r: number) => Math.hypot(b.words[b.offR + RW * r + R.x] - 400000 * TILE_M, b.words[b.offR + RW * r + R.y] - 400000 * TILE_M) > 2500;
  const all = Array.from({ length: b.nr }, (_, r) => r);
  expect(all.filter(lit).length).toBeGreaterThan(100);
  expect(all.filter((r) => lit(r) && far(r)).length).toBeGreaterThan(10);
  expect(all.filter((r) => !lit(r) && heat(r, 0) > start(r, 0)).length).toBeGreaterThan(10);
  expect(all.filter((r) => !lit(r) && heat(r, 0) < start(r, 0)).length).toBeGreaterThan(10);
  expect(new Set(all.filter(lit).map((r) => (twin[r] >>> 24) & 0x7f)).size).toBeGreaterThan(5);
  expect(await onGpu(await theGpu(), b)).toEqual(twin);
  low = await openGpu("low-power");
  expect(await onGpu(low, b)).toEqual(twin);
}, 600_000);

test("a batch queued again before the store took the last to the GPU has the last worked out by the twin, and the GPU's agrees", async () => {
  const s = new Store(await theGpu()), r = new Receivers(), a = batch(1), b = batch(2), got: Uint32Array[] = [];
  r.attach(s);
  r.queue(a, (o) => got.push(o));
  r.queue(b, (o) => got.push(o));
  await s.step(1);
  s.destroy();
  expect(got).toEqual([receive(a), receive(b)]);
}, 600_000);
