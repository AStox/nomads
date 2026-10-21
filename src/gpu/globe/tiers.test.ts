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
import { drainage, tiersOf } from "./tiers";
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
    let worst = 0;
    for (let c = 0; c < N0; c++) worst = Math.max(worst, Math.abs(sum[c] / 16 - height[c] * 256));
    console.log(`tier 2 worst parent mean off by ${(worst / 256).toFixed(3)} m`);
    expect(worst).toBeLessThan(64);
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
