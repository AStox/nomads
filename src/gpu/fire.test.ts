// The fire on the GPU (wgsl/beds.ts and wgsl/fire.ts, driven by fire.ts): a landing's beds and receivers against the
// TypeScript twins bit for bit on both of the dev machine's adapters. The receivers' batch has every way their law goes:
// parts lit by a flame standing over them and by radiation, things lit by brands far downwind, things warming that don't
// light, and things cooling with no fire near. The beds have every way theirs goes: lighting a share at a time, burning
// down to coals, blown out by the wind, heaped over and smouldering, ringed with stone, fed air, rained on, lit partway
// through the landing, going out, and taken up again from the state the GPU held (plan Unit 12).
import { afterAll, expect, test } from "bun:test";
import { type Gpu, openGpu, releaseGpu, theGpu } from "./device";
import { Store } from "./store";
import { Fire, NO_BLAZE, airWords, bedWords, burnBeds, pack, receive, type Batch, type Landed, type Work } from "./fire";
import { B, BW, LIT, NONE, NOWHERE, PT, PW, R, RW } from "./wgsl/fire";
import { blazeWords, keyOf, placeWords, type Blaze } from "../sim/spread";
import { advance, contact, exposure, feed, group, kindle, lay, type Air, type Bed, type Laid } from "../sim/combustion";
import { PHYS, woodOf, type Phys } from "../sim/fuel";
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
// 3,000 things round a point out to 60 m, mostly downwind of a wind blowing east by a little south: grass, twigs,
// branches, logs and shelters' pieces, some already warm, at waters from bone dry to drowned.
function receivers(rnd: () => number, cx: number, cy: number, n: number) {
  const pieces = [{ ...PHYS.fiber }, woodOf("pine", 0.0035, 0.002), woodOf("oak", 0.03, 0.5), woodOf("pine", 0.11, 4)];
  return Array.from({ length: n }, (_, i) => {
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
}
// Thirty looks of three beds round a point, each blazing a little differently look by look, as the CPU hands them to
// the receivers.
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
  return pack(seed, 123456, looks, receivers(rnd, cx, cy, 3000));
}
async function onGpu(g: Gpu, works: Work[]): Promise<Landed[]> {
  const s = new Store(g), f = new Fire(), got: Landed[] = [];
  f.attach(s);
  await f.ready();
  for (let i = 0; i < works.length; i++) {
    f.queue(works[i], (o) => got.push(o));
    await s.step(i + 1);
  }
  s.destroy();
  return got;
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
  const work: Work = { looks: 30, beds: [], batch: b };
  expect((await onGpu(await theGpu(), [work]))[0].receivers).toEqual(twin);
  low = await openGpu("low-power");
  expect((await onGpu(low, [work]))[0].receivers).toEqual(twin);
}, 300_000);

test("work queued again before the store took the last to the GPU has the last worked out by the twin, and the GPU's agrees", async () => {
  const s = new Store(await theGpu()), f = new Fire(), a = batch(1), b = batch(2), got: Uint32Array[] = [];
  f.attach(s);
  f.queue({ looks: 30, beds: [], batch: a }, (o) => got.push(o.receivers));
  f.queue({ looks: 30, beds: [], batch: b }, (o) => got.push(o.receivers));
  await s.step(1);
  s.destroy();
  expect(got).toEqual([receive(a), receive(b)]);
}, 300_000);

// ---------- the beds ----------
const TWIG = woodOf("generic", 0.0064, 0.008), STICK = PHYS.stick, LOG = PHYS.log;
const of = (phys: Phys, n: number, m: number): Laid => ({ phys, n, m });
const usual = () => [of(PHYS.fiber, 1, 0.06), of(TWIG, 10, 0.12), of(STICK, 5, 0.12), of(LOG, 2, 0.12)];
const STILL: Air = { temp: 10, wind: 0, rain: 0, veg: 0.1 };
// A burning tree's bed as spread.ts lays one: its leaves, live and dead twigs, branches and trunk, its dead twigs alight.
function tree(): Bed {
  const twig = woodOf("oak", 0.0035, 0.0002), b = lay([
    of({ ...PHYS.fiber }, 40000, 1.2), of(twig, 20000, 1.2), of({ ...twig }, 9000, 0.1), of(woodOf("oak", 0.06, 2), 60, 0.8), of(woodOf("oak", 0.35, 90), 14, 0.7),
  ])!;
  b.groups[2] = { ...b.groups[2], lit: true, inside: 1 };
  return b;
}
// Beds of every kind, each with the air at each look of a landing of 30 looks: steady, gusting, rained on, under trees
// and over bare ground, a few with looks they don't take.
type Burning = { bed: Bed; air: (k: number) => Air | null; place: { x: number; y: number; dx: number; dy: number } };
function beds(seed: number): Burning[] {
  const rnd = stream(seed), len = Math.hypot(1, 0.3);
  const small = advance(kindle(lay(usual())!), 120, STILL);
  const list: { bed: Bed; air: (k: number) => Air | null }[] = [
    { bed: kindle(lay(usual())!), air: () => ({ ...STILL, wind: 1 + 3 * rnd() }) },
    { bed: feed(small, [of(LOG, 3, 0.12)]), air: () => STILL },
    { bed: kindle(lay([of(PHYS.fiber, 1, 0.06)])!), air: () => STILL },
    { bed: small, air: () => ({ ...STILL, wind: 10 + 4 * rnd() }) },
    { bed: small, air: () => ({ ...STILL, covered: true, rain: 0 }) },
    { bed: small, air: () => ({ ...STILL, wind: 8, ring: { tall: 0.15, width: 3 } }) },
    { bed: small, air: (k) => ({ ...STILL, blown: k < 12 ? 11.8 : 0 }) },
    { bed: small, air: () => ({ ...STILL, rain: 7.8 }) },
    { bed: kindle(lay([of(PHYS.fiber, 1, 0.06), of(TWIG, 10, 0.35)])!), air: () => STILL },
    { bed: tree(), air: () => ({ temp: 18, wind: 3 + 3 * rnd(), rain: 0, veg: 3 }) },
    { bed: tree(), air: () => ({ temp: 18, wind: 5, rain: 0, veg: 0 }) },
    { bed: kindle(lay(usual())!), air: (k) => (k < 9 ? null : { ...STILL, wind: 2, veg: 0.5 }) },
  ];
  return list.map((x, i) => ({ ...x, place: placeWords({ px: 4000 + (3 * i) / TILE_M, py: 4000 + (2 * (i % 3)) / TILE_M, dx: 1 / len, dy: 0.3 / len }) }));
}
function work(list: Burning[], from: Bed[], looks: number, seed: number, offset: number, fresh: boolean): Work {
  const rnd = stream(seed);
  const airs = list.map((x) => Array.from({ length: looks }, (_, k) => { const a = x.air(k + offset); return a ? airWords(a, x.place) : null; }));
  const batch = pack(seed, 777 + offset, Array.from({ length: looks }, () => list.map(() => [...NO_BLAZE])), receivers(rnd, 4000 + 18 / TILE_M, 4000, 800));
  return { looks, beds: list.map((_, j) => ({ slot: j * 3 + 1, bed: from[j], fresh, airs: airs[j] })), batch };
}
// A landing's words for comparing: each bed's state (its records numbered as first laid), its status, the blazes and
// the receivers.
const words = (l: Landed, phys: Phys[][]) => ({
  beds: l.beds.map((b, j) => [b.gone, b.reach, b.far, ...bedWords(b.bed, [...phys[j]])]), blazes: [...l.blazes], receivers: [...l.receivers],
});

test("two landings of the beds' law equal the twin bit for bit on both adapters, lighting, burning, smouldering and going out", async () => {
  const list = beds(0xbed5), phys = list.map((x) => { const p: Phys[] = []; bedWords(x.bed, p); return p; });
  const first = work(list, list.map((x) => x.bed), 30, 11, 0, true), a = burnBeds(first);
  const second = work(list, a.beds.map((b) => b.bed), 30, 12, 30, false), b = burnBeds(second);
  // every way the law goes is in the twin's landings
  const both = [...a.beds, ...b.beds];
  expect(both.some((x) => x.gone > 0)).toBe(true);
  expect(both.some((x) => x.gone === 0 && x.bed.coals.length > 0)).toBe(true);
  expect(a.beds.some((x, j) => x.bed.groups.length > list[j].bed.groups.length)).toBe(true);
  expect(both.some((x) => x.far > x.reach)).toBe(true);
  const blazes = [...a.blazes, ...b.blazes];
  expect(blazes.filter((_, i) => i % BW === B.x && blazes[i] === NOWHERE).length).toBeGreaterThan(10);
  expect(blazes.filter((v, i) => i % BW === B.gb && v > 0).length).toBeGreaterThan(10);
  expect(a.receivers.slice(0, first.batch.nr).some((v) => (v & LIT) !== 0)).toBe(true);
  const twin = [words(a, phys), words(b, phys)];
  for (const g of [await theGpu(), low ?? (low = await openGpu("low-power"))]) {
    const got = await onGpu(g, [first, second]);
    expect(got.map((l) => words(l, phys))).toEqual(twin);
  }
}, 300_000);
