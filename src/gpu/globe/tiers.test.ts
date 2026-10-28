// The coarse-to-fine chain on a staged planet (a ridge along the edge of faces 0 and 1, tiers 1 to 2): one drainage network over the last tier across face and tile edges, the same bytes
// made twice and made in calls of one step (a state kept between them), and each tier-0 cell's total height kept to under a metre a cell. Each case alone:
//   bun test ./src/gpu/globe/tiers.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../device";
import { BakeDir } from "./bakedir";
import { FACES, centre, tierGrid } from "./grid";
import { refineSmooth } from "./regional";
import { TIER_LAWS, drainage, tiersOf, type TierLaw } from "./tiers";
import { streamTier } from "./tiers-stream";
import type { Planet } from "./window";

afterAll(releaseGpu);
const g0 = tierGrid(0), N0 = FACES * 256 * 256, DEG = Math.PI / 180, STEPS = [0, 3, 3];
// A ridge of 2.5 km along the meridian at 45 degrees east (the edge of faces 0 and 1), land within 40 degrees of the equator, sea at -1.5 km elsewhere
const height = Float32Array.from({ length: N0 }, (_, i) => {
  const f = Math.floor(i / 65536), r = i - f * 65536, Y = Math.floor(r / 256), p = centre(g0, f, r - Y * 256, Y), lat = Math.asin(p[2]) / DEG, lon = Math.atan2(p[1], p[0]) / DEG, d = Math.abs(lon - 45);
  return Math.abs(lat) < 40 && d < 12 ? 50 + 2450 * Math.exp(-((d / 5) ** 2)) : -1500;
});
const planet = {
  n: N0, radius: g0.radius, height, pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === 3 ? 2000 : 0)),
  seasons: [0, 1, 2, 3].map(() => ({ rain: new Float32Array(N0).fill(200) })),
} as unknown as Planet;
const fresh = () => new BakeDir(mkdtempSync(join(tmpdir(), "tiers-")));
const hash = (a: ArrayBufferView) => Bun.hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).toString(16);

describe("the tiers made one from the one above", () => {
  test("the last tier is one drainage network across face and tile edges, and each tier-0 cell keeps its height", async () => {
    const dir = fresh(), p = await tiersOf(await theGpu(), planet, dir, Infinity, 2, STEPS);
    expect(p.done).toBe(true);
    const h = dir.i32("t2-height"), d = drainage(2, h, dir.u32("t2-to"), dir.i32("t2-flooded"));
    expect(d.bad).toBe(0);
    expect(d.land).toBeGreaterThan(50000);
    expect(d.acrossFaces).toBeGreaterThan(50);
    expect(d.acrossTiles).toBeGreaterThan(5);
    // the children of a tier-0 cell sum to what the cell was, to under a metre a child (what is carried between steps is not in the heights)
    const sum = new Float64Array(N0), fn = 1024, cells = fn * fn;
    for (let i = 0; i < h.length; i++) { const f = Math.floor(i / cells), r = i - f * cells; sum[(f * 256 + (Math.floor(r / fn) >> 2)) * 256 + ((r % fn) >> 2)] += h[i]; }
    // the island's steps are long (26 My first): a coast beside a cell of great loss (here the staged ridge's foot over a 1,500 m sea) cannot always give back what the smooth rise lends it, since land is
    // never lowered under one unit, so a few cells keep a debt (docs/research/globe/2026-10-22-planet-island-law.md); the rest hold the planet's mean to a metre
    const off = Array.from({ length: N0 }, (_, c) => Math.abs(sum[c] / 16 - height[c] * 256) / 256).sort((x, y) => x - y), worst = off[N0 - 1], p99 = off[Math.floor(N0 * 0.99)];
    console.log(`tier 2 worst parent mean off by ${worst.toFixed(3)} m, 99th percentile ${p99.toFixed(3)} m`);
    expect(p99).toBeLessThan(1);
    expect(worst).toBeLessThan(40);
  });

  test("the same bytes twice, and the same made in calls of one step", async () => {
    const gpu = await theGpu(), a = fresh(), b = fresh(), c = fresh();
    await tiersOf(gpu, planet, a, Infinity, 2, STEPS);
    await tiersOf(gpu, planet, b, Infinity, 2, STEPS);
    let calls = 0;
    for (;;) { calls++; if ((await tiersOf(gpu, planet, c, Infinity, 2, STEPS, undefined, 1)).done) break; if (calls > 20) throw new Error("did not finish"); }
    expect(calls).toBeGreaterThanOrEqual(5);
    for (const f of ["t1-height.i32", "t2-height.i32", "t2-to.u32", "t2-acc.u32", "t2-flooded.i32"]) {
      expect(hash(new Uint8Array(b.raw(f)))).toBe(hash(new Uint8Array(a.raw(f))));
      expect(hash(new Uint8Array(c.raw(f)))).toBe(hash(new Uint8Array(a.raw(f))));
    }
    console.log(`chain hash ${hash(new Uint8Array(a.raw("t2-height.i32")))}, ${calls} calls`);
  });
});

describe("the band-limited hold of a tier", () => {
  const lawsWith = (route: Partial<TierLaw["route"]>): readonly TierLaw[] => TIER_LAWS.map((l, t) => (t === 1 ? { ...l, route: { ...l.route, ...route } } : l));
  test("tier 1 on the band-limited hold: valid drainage, the same bytes twice, and not the box hold's heights", async () => {
    const gpu = await theGpu(), a = fresh(), b = fresh(), box = fresh(), laws = lawsWith({ band: 1 });
    await tiersOf(gpu, planet, a, Infinity, 2, STEPS, undefined, Infinity, laws);
    await tiersOf(gpu, planet, b, Infinity, 2, STEPS, undefined, Infinity, laws);
    await tiersOf(gpu, planet, box, Infinity, 2, STEPS);
    for (const f of ["t1-height.i32", "t2-height.i32"]) expect(hash(new Uint8Array(b.raw(f)))).toBe(hash(new Uint8Array(a.raw(f))));
    expect(hash(new Uint8Array(a.raw("t1-height.i32")))).not.toBe(hash(new Uint8Array(box.raw("t1-height.i32"))));
    const d = drainage(2, a.i32("t2-height"), a.u32("t2-to"), a.i32("t2-flooded"));
    expect(d.bad).toBe(0); expect(d.land).toBeGreaterThan(50000);
  });
});

describe("a tier with no steps", () => {
  test("tier 1 with no steps is refineSmooth of tier 0 and its 2 by 2 means are tier 0's; tier 2 then holds those means", async () => {
    const gpu = await theGpu(), dir = fresh();
    await tiersOf(gpu, planet, dir, Infinity, 2, [0, 0, 3]);
    const parent = Float32Array.from(height, (v) => v * 256), want = refineSmooth(parent, 0), got = dir.i32("t1-height");
    expect(got.length).toBe(want.length);
    let differ = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) differ++;
    expect(differ).toBe(0);
    const m1 = new Float64Array(N0), m2 = new Float64Array(N0), h2 = dir.i32("t2-height");
    for (let i = 0; i < got.length; i++) { const f = Math.floor(i / 262144), r = i - f * 262144; m1[(f * 256 + (Math.floor(r / 512) >> 1)) * 256 + ((r % 512) >> 1)] += got[i] / 4; }
    for (let i = 0; i < h2.length; i++) { const f = Math.floor(i / 1048576), r = i - f * 1048576; m2[(f * 256 + (Math.floor(r / 1024) >> 2)) * 256 + ((r % 1024) >> 2)] += h2[i] / 16; }
    const e1 = Array.from({ length: N0 }, (_, c) => Math.abs(m1[c] - parent[c]) / 256).sort((x, y) => x - y), e2 = Array.from({ length: N0 }, (_, c) => Math.abs(m2[c] - parent[c]) / 256).sort((x, y) => x - y);
    console.log(`skipped tier 1 means against tier 0: max ${e1[N0 - 1].toFixed(4)} m; tier 2 against tier 0: p99 ${e2[Math.floor(N0 * 0.99)].toFixed(3)} m`);
    expect(e1[N0 - 1]).toBeLessThan(0.01);
    expect(e2[Math.floor(N0 * 0.99)]).toBeLessThan(1);
  });

  test("the streamed chain with tier 1 skipped (zero steps) writes the in-memory chain's files", async () => {
    const gpu = await theGpu(), mem = fresh(), str = fresh(), steps = [0, 0, 3];
    await tiersOf(gpu, planet, mem, Infinity, 2, steps);
    expect((await streamTier(gpu, planet, str, 1, 2, Infinity, { steps })).done).toBe(true);
    expect((await streamTier(gpu, planet, str, 2, 2, Infinity, { steps })).done).toBe(true);
    for (const f of ["t1-height.i32", "t2-height.i32", "t2-to.u32", "t2-acc.u32", "t2-flooded.i32"]) expect(hash(new Uint8Array(str.raw(f)))).toBe(hash(new Uint8Array(mem.raw(f))));
  });
});
