// The global discharge gather (discharge.ts): exact where a basin's sum passes 32 bits, across a face's edge, and on the real planet's tier 4 equal at a sample of cells to the walk up the
// forest. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/discharge.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { defaultParams } from "./erosion";
import { dischargeOf, gatherTwin, hiFile, loFile, ONES, readDischarge, sumUpstream, valueAt } from "./discharge";
import { FACES, centre, tierGrid, type Grid } from "./grid";
import { cellAcross } from "./patch";
import { Regional, remapHeights, tierTable } from "./regional";
import { BakeDir } from "./tiers";
import type { Planet } from "./window";

afterAll(releaseGpu);
const TIER = 1, DEG = Math.PI / 180, g0 = tierGrid(0), g1 = tierGrid(TIER), N0 = FACES * 256 * 256, N1 = FACES * g1.fn * g1.fn;
// a ridge along the cube edge between faces 0 and 1, sea elsewhere (regional.test.ts's staging)
const ridge = (): Float32Array => {
  const out = new Float32Array(N0);
  for (let f = 0, i = 0; f < FACES; f++)
    for (let Y = 0; Y < 256; Y++)
      for (let X = 0; X < 256; X++, i++) {
        const p = centre(g0, f, X, Y), lat = Math.asin(p[2]) / DEG, lon = Math.atan2(p[1], p[0]) / DEG, d = Math.abs(lon - 45);
        out[i] = Math.abs(lat) < 40 && d < 12 ? 50 + 2450 * Math.exp(-((d / 5) ** 2)) : -1500;
      }
  return out;
};
const planet0 = () => ({ radius: g0.radius, pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === 3 ? 2000 : 0)) }) as unknown as Planet;
const near8 = (g: Grid) => (id: number): number[] => {
  const cells = g.fn * g.fn, f = Math.floor(id / cells), Y = Math.floor((id - f * cells) / g.fn), X = id - f * cells - Y * g.fn, out: number[] = [];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) { const c = cellAcross(g, f, X + dx, Y + dy); if (c >= 0) out.push(c); }
  return out;
};

describe("the global discharge", () => {
  test("the gather is exact where a basin's sum passes 32 bits, across a face's edge", async () => {
    const gpu = await theGpu(), r = new Regional(gpu, TIER, tierTable(planet0(), TIER, defaultParams({ dtYr: 1e6 })), remapHeights(TIER, ridge()));
    try {
      await r.flow();
      const to = new Uint32Array((await r.readField("TO")).buffer), cells = g1.fn * g1.fn;
      // weights of about 4e8 a cell: any basin of 11 cells passes 2^32
      const w = Uint32Array.from({ length: N1 }, (_, k) => 400_000_000 + (Math.imul(k, 2654435761) >>> 28));
      const twin = gatherTwin(to, w), { lo, hi } = await r.gather64(w);
      let big = 0, wrong = 0, across = 0, most = 0;
      for (let k = 0; k < N1; k++) {
        if (lo[k] + hi[k] * 2 ** 32 !== twin[k]) wrong++;
        if (twin[k] >= 2 ** 32) big++;
        most = Math.max(most, twin[k]);
        if (to[k] !== k && Math.floor(to[k] / cells) !== Math.floor(k / cells)) across++;
      }
      expect(wrong).toBe(0);
      expect(big).toBeGreaterThan(1000);
      expect(across).toBeGreaterThan(50);
      expect(most).toBeGreaterThan(2 ** 40);
      // a forest given and not flooded sorts to the same sums
      const f = new Regional(gpu, TIER, new Uint32Array(20 * N0), new Int32Array(N1));
      try {
        await f.forest(to);
        const again = await f.gather64(w);
        expect(Bun.hash(again.lo)).toBe(Bun.hash(lo));
        expect(Bun.hash(again.hi)).toBe(Bun.hash(hi));
      } finally { f.release(); }
    } finally { r.release(); }
  });

  const real = new BakeDir("/tmp/planet-75m/1-c418e5fe9b5e");
  test.skipIf(!existsSync(real.path("t4-to.u32")))("on the real planet's tier 4 a cell's discharge is the sum of everything draining to it", async () => {
    const N = FACES * 4096 * 4096, scratch = "/tmp/planet-75m/water-scratch/discharge";
    mkdirSync(scratch, { recursive: true });
    const dir = new BakeDir(scratch), w = Uint32Array.from({ length: N }, (_, k) => 1 + (Math.imul(k, 2654435761) >>> 11)); // 1 to 2^21 a cell
    dir.write("weights.u32", w);
    dir.write("t4-to.u32", new Uint32Array(real.raw("t4-to.u32")));
    const p = await dischargeOf(await theGpu(), dir, 4, [{ from: "weights.u32", stem: "qtest" }, { from: ONES, stem: "cells" }], 280, (s) => console.log(s));
    expect(p.done).toBe(true);
    console.log(`discharge: both fields in ${p.seconds.toFixed(1)} s`);
    const q = readDischarge(dir, "qtest"), cells = readDischarge(dir, "cells"), to = new Uint32Array(dir.raw("t4-to.u32")), near = near8(tierGrid(4));
    // a sample of 1,000 cells: the greatest basins' mouths, other mouths and cells along rivers and hillslopes
    const mouths: number[] = [];
    for (let k = 0; k < N; k++) if (to[k] === k && cells.lo[k] > 3000) mouths.push(k);
    mouths.sort((a, b) => cells.lo[b] - cells.lo[a]);
    const sample = new Set<number>(mouths.slice(0, 20));
    let s = 7;
    for (let k = 0; k < 20 && mouths.length; k++) { s = (s * 1103515245 + 12345) >>> 0; sample.add(mouths[s % mouths.length]); }
    while (sample.size < 1000) { s = (s * 1103515245 + 12345) >>> 0; const k = s % N; if (to[k] !== k && cells.lo[k] < 20000) sample.add(k); }
    let past32 = 0, mostCells = 0, wrong = 0;
    for (const k of sample) {
      const sum = sumUpstream(to, (id) => w[id], near, k), n = sumUpstream(to, () => 1, near, k);
      if (valueAt(q, k) !== sum || cells.lo[k] !== n) wrong++;
      if (sum >= 2 ** 32) past32++;
      mostCells = Math.max(mostCells, n);
    }
    console.log(`discharge: ${sample.size} cells walked, ${past32} past 32 bits, the largest basin ${mostCells} cells`);
    expect(wrong).toBe(0);
    expect(past32).toBeGreaterThan(0);
    for (const f of [loFile("qtest"), hiFile("qtest"), "cells.u32", "weights.u32", "t4-to.u32"]) rmSync(dir.path(f), { force: true });
  });
});
