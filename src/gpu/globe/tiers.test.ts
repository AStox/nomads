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
import { defaultParams, landDiffusivity } from "./erosion";
import { XSTRIDE } from "../wgsl/globe-regional";
import { creepSubsOf, tierTable } from "./regional";
import { TIER_LAWS, drainage, tiersOf, type TierLaw } from "./tiers";
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

describe("the hold of a coarse tier (knobs: hold off, band-limited)", () => {
  const lawsWith = (route: Partial<TierLaw["route"]>): readonly TierLaw[] => TIER_LAWS.map((l, t) => (t === 1 ? { ...l, route: { ...l.route, ...route } } : l));
  const landMean = (h: Int32Array) => { let s = 0, n = 0; for (let i = 0; i < h.length; i++) if (h[i] > 0) { s += h[i]; n++; } return s / n / 256; };
  test("tier 1 not held to tier 0's cell means: the land comes out lower than the held tier's, and the next tier holds tier 1's own means", async () => {
    const gpu = await theGpu(), held = fresh(), off = fresh();
    await tiersOf(gpu, planet, held, Infinity, 2, STEPS);
    await tiersOf(gpu, planet, off, Infinity, 2, STEPS, undefined, Infinity, lawsWith({ holdOff: true }));
    const a = landMean(held.i32("t1-height")), b = landMean(off.i32("t1-height"));
    console.log(`tier 1 land mean: held ${a.toFixed(1)} m, hold off ${b.toFixed(1)} m`);
    expect(b).toBeLessThan(a - 5);
    // tier 2 holds the tier-0 cell means of the tier-1 field it starts from, not tier 0's: the 16 children of a tier-0 cell average what its 4 tier-1 children did, to a metre on 99% of the cells
    const h1 = off.i32("t1-height"), h2 = off.i32("t2-height"), m1 = new Float64Array(N0), m2 = new Float64Array(N0);
    for (let i = 0; i < h1.length; i++) { const f = Math.floor(i / 262144), r = i - f * 262144; m1[(f * 256 + (Math.floor(r / 512) >> 1)) * 256 + ((r % 512) >> 1)] += h1[i] / 4; }
    for (let i = 0; i < h2.length; i++) { const f = Math.floor(i / 1048576), r = i - f * 1048576; m2[(f * 256 + (Math.floor(r / 1024) >> 2)) * 256 + ((r % 1024) >> 2)] += h2[i] / 16; }
    const off1 = Array.from({ length: N0 }, (_, c) => Math.abs(m2[c] - m1[c]) / 256).sort((x, y) => x - y), off0 = Array.from({ length: N0 }, (_, c) => Math.abs(m2[c] - height[c] * 256) / 256).sort((x, y) => x - y);
    console.log(`tier 2 tier-0 means against tier 1's p99 ${off1[Math.floor(N0 * 0.99)].toFixed(3)} m, against tier 0's p99 ${off0[Math.floor(N0 * 0.99)].toFixed(1)} m`);
    expect(off1[Math.floor(N0 * 0.99)]).toBeLessThan(1);
    expect(off0[Math.floor(N0 * 0.99)]).toBeGreaterThan(10);
  });
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

describe("the land diffusivity of a coarse tier (NOMADS_DEFF_TIERS)", () => {
  test("a listed tier's table carries D_t in its creep words, every other word is the default's, and the explicit creep step stays under the stable number", () => {
    const prev = process.env.NOMADS_DEFF_TIERS, p = defaultParams({ dtYr: 26e6 });
    try {
      delete process.env.NOMADS_DEFF_TIERS;
      const base = [1, 2].map((t) => tierTable(planet, t, p, true)), subs0 = base.map(creepSubsOf);
      process.env.NOMADS_DEFF_TIERS = "1,2";
      const knob = [1, 2].map((t) => tierTable(planet, t, p, true));
      for (const [i, t] of [1, 2].entries()) {
        let other = 0, checked = 0, worst = 0;
        for (let c = 0; c < N0; c++) for (let w = 0; w < XSTRIDE; w++) {
          const a = base[i][c * XSTRIDE + w], b = knob[i][c * XSTRIDE + w];
          if (w >= 20 && w < 28) { if (a > 1e4) { checked++; worst = Math.max(worst, Math.abs(b / a / (landDiffusivity(planet.radius, t, p.creepLand) / p.creepLand) - 1)); } } else if (a !== b) other++;
        }
        expect(other).toBe(0); expect(checked).toBeGreaterThan(1000); expect(worst).toBeLessThan(1e-3);
        // the stable substep count of the table: the row sums of the nine-point stencil are at most 1/2 each substep
        const subs = creepSubsOf(knob[i]);
        let most = 0;
        for (let c = 0; c < N0; c++) { let sum = 0; for (let d = 0; d < 8; d++) sum += knob[i][c * XSTRIDE + 20 + d]; most = Math.max(most, sum / 2 ** 24 / subs); }
        expect(most).toBeLessThanOrEqual(0.5 + 1e-9); expect(subs).toBeGreaterThan(subs0[i]);
      }
    } finally { if (prev === undefined) delete process.env.NOMADS_DEFF_TIERS; else process.env.NOMADS_DEFF_TIERS = prev; }
  });
});
