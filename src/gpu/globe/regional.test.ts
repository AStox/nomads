// The global finer tier (regional.ts): the remap keeps each tier-0 cell's total and reads only the cells round it, the flood and the receivers
// run across face edges as one forest rooted at the sea (checked against a priority flood on the CPU), and a step keeps each tier-0 cell's total
// height, is the same bytes twice and the same when resumed. Each case alone:
//   bun test ./src/gpu/globe/regional.test.ts -t "<name>" --timeout 280000
// The cases run on tier 1 (512 cells a face side, 1.5 million cells) from a staged ridge along the edge of faces 0 and 1.
import { afterAll, describe, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { defaultParams } from "./erosion";
import { FACES, centre, haloSource, tierGrid, type Grid } from "./grid";
import { Regional, parentOf, refineInts, remapAmounts, remapHeights, remapInts, tierTable, type TierState } from "./regional";
import type { Planet } from "./window";

afterAll(releaseGpu);
const TIER = 1, DEG = Math.PI / 180;
const g0 = tierGrid(0), g1 = tierGrid(TIER), N0 = FACES * 256 * 256, N1 = FACES * g1.fn * g1.fn;

// A ridge of 2.5 km along the cube edge between faces 0 and 1 (the meridian at 45 degrees east), land within 40 degrees of the equator and 12 degrees of it, sea at -1.5 km elsewhere.
const field = (g: Grid): Float32Array => {
  const out = new Float32Array(FACES * g.fn * g.fn);
  for (let f = 0, i = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++, i++) {
        const p = centre(g, f, X, Y), lat = Math.asin(p[2]) / DEG, lon = Math.atan2(p[1], p[0]) / DEG, d = Math.abs(lon - 45);
        out[i] = Math.abs(lat) < 40 && d < 12 ? 50 + 2450 * Math.exp(-((d / 5) ** 2)) : -1500;
      }
  return out;
};
const planetOf0 = () => ({ radius: g0.radius, pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === 3 ? 2000 : 0)) }) as unknown as Planet;
const hash = (a: Int32Array) => Bun.hash(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).toString(16);
const inputs = () => {
  const coarse = field(g0), planet = planetOf0();
  return { table: tierTable(planet, TIER, defaultParams({ dtYr: 1e6 })), height: remapHeights(TIER, coarse), rho: Int32Array.from({ length: N1 }, () => 256) };
};
// The four edge neighbours of a tier-1 cell (what the flood and the receivers read), across face edges as the grid gives them.
const neighbours8 = (id: number): number[] => {
  const cells = g1.fn * g1.fn, f = Math.floor(id / cells), Y = Math.floor((id - f * cells) / g1.fn), X = id - f * cells - Y * g1.fn, out: number[] = [];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const s = haloSource(g1, f, X + dx, Y + dy);
    if (s) out.push((s.face * g1.fn + s.Y) * g1.fn + s.X);
  }
  return out;
};

describe("the regional tier", () => {
  test("the remap keeps each tier-0 cell's total and reads only the cells round it", () => {
    let s = 12345;
    const rand = Float32Array.from({ length: N0 }, () => { s = (s * 1103515245 + 12345) >>> 0; return (s / 2 ** 32) * 3500 - 500; });
    const tier = 2, n = 16, out = remapHeights(tier, rand), sums = new Float64Array(N0);
    for (let i = 0; i < out.length; i++) sums[parentOf(tier, i)] += out[i];
    // the children of a tier-0 cell sum to 256 times its height times their number, to the unit
    for (let p = 0; p < N0; p++) expect(sums[p]).toBe(Math.round(rand[p] * 256 * n));
    // a cell on a face's edge changed: only the children of the cells round it (across the edge too) move
    const at = (0 * 256 + 100) * 256 + 255, moved = rand.slice();
    moved[at] += 700;
    const again = remapHeights(tier, moved), near = new Set([at]), f = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const h = haloSource(g0, f, 255 + dx, 100 + dy);
      if (h) near.add((h.face * 256 + h.Y) * 256 + h.X);
    }
    let changed = 0;
    for (let i = 0; i < out.length; i++) if (out[i] !== again[i]) { changed++; expect(near.has(parentOf(tier, i))).toBe(true); }
    expect(changed).toBeGreaterThan(n);
    // an amount keeps the children's mean and is never negative
    const rain = Float32Array.from(rand, (v) => Math.max(0, v)), amounts = remapAmounts(tier, rain), means = new Float64Array(N0);
    for (let i = 0; i < amounts.length; i++) { expect(amounts[i]).toBeGreaterThanOrEqual(0); means[parentOf(tier, i)] += amounts[i] / n; }
    for (let p = 0; p < N0; p += 97) expect(Math.abs(means[p] - rain[p])).toBeLessThan(1e-3 * Math.max(1, rain[p]));
  });

  test("the flood and the receivers across face edges make one forest rooted at the sea", async () => {
    const { table, height, rho } = inputs(), r = new Regional(await theGpu(), TIER, table, height, rho);
    try {
      await r.flow();
      const [to, flooded, acc, w, h] = await Promise.all([r.readField("TO"), r.readFlooded(), r.readField("ACC"), r.readField("W"), r.readH()]);
      let across = 0, land = 0, rooted = 0n, weight = 0n;
      for (let k = 0; k < N1; k++) {
        if (h[k] <= 0) { expect(to[k]).toBe(k); rooted += BigInt(acc[k] >>> 0); continue; }
        land++;
        weight += BigInt(w[k] >>> 0);
        expect(to[k]).not.toBe(k);
        expect(flooded[to[k]]).toBeLessThan(flooded[k]);
        expect(flooded[k]).toBeGreaterThanOrEqual(h[k]);
        if (Math.floor(to[k] / (g1.fn * g1.fn)) !== Math.floor(k / (g1.fn * g1.fn))) across++;
      }
      expect(land).toBeGreaterThan(20000);
      expect(across).toBeGreaterThan(5);
      // every drop of the land's weight arrives at the sea
      expect(rooted).toBe(weight);
      // the flooded surface is the priority flood's: least over every path to the sea of the greatest height on it plus a step for each cell, from a CPU search
      const f = new Int32Array(N1).fill(0x7fffffff), heap: number[] = [], SHIFT = 2 ** 21, OFF = 2 ** 24;
      const push = (i: number) => { const v = (f[i] + OFF) * SHIFT + i; heap.push(v); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p] <= heap[c]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
      const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let c = 0; for (;;) { const a = 2 * c + 1, b = a + 1; let m = c; if (a < heap.length && heap[a] < heap[m]) m = a; if (b < heap.length && heap[b] < heap[m]) m = b; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top % SHIFT; };
      for (let k = 0; k < N1; k++) if (h[k] <= 0) { f[k] = h[k]; push(k); }
      const done = new Uint8Array(N1);
      while (heap.length) {
        const i = pop();
        if (done[i]) continue;
        done[i] = 1;
        for (const j of neighbours8(i)) if (h[j] > 0 && !done[j] && Math.max(h[j], f[i] + 1) < f[j]) { f[j] = Math.max(h[j], f[i] + 1); push(j); }
      }
      let wrong = 0;
      for (let k = 0; k < N1; k++) if (f[k] !== flooded[k]) wrong++;
      expect(wrong).toBe(0);
    } finally { r.release(); }
  });

  test("a step keeps each tier-0 cell's total height, is the same twice and the same resumed", async () => {
    const { table, height, rho } = inputs(), gpu = await theGpu();
    const run = async (steps: number, from?: TierState) => {
      const r = new Regional(gpu, TIER, table, height, rho);
      try {
        if (from) r.load(from);
        for (let s = 0; s < steps; s++) await r.step();
        return await r.state((from?.steps ?? 0) + steps);
      } finally { r.release(); }
    };
    const a = await run(3);
    // each tier-0 cell's total height and carry are what they were
    const before = new Float64Array(N0), after = new Float64Array(N0);
    for (let i = 0; i < N1; i++) { before[parentOf(TIER, i)] += height[i]; after[parentOf(TIER, i)] += a.height[i]; }
    for (let p = 0; p < N0; p++) expect(after[p] + a.carry[p]).toBe(before[p]);
    // land stays land and the sea is not moved; the relief changed, cells both lowered and raised
    let lowered = 0, raised = 0;
    for (let i = 0; i < N1; i++) {
      expect(a.height[i] > 0).toBe(height[i] > 0);
      if (height[i] <= 0) expect(a.height[i]).toBe(height[i]);
      else if (a.height[i] < height[i]) lowered++; else if (a.height[i] > height[i]) raised++;
    }
    expect(lowered).toBeGreaterThan(1000);
    expect(raised).toBeGreaterThan(1000);
    // the same bytes twice, and 2 steps then 1 resumed from the kept state
    const b = await run(3), part = await run(2), resumed = await run(1, part);
    expect(hash(b.height)).toBe(hash(a.height));
    expect(hash(resumed.height)).toBe(hash(a.height));
    expect(Array.from(resumed.carry)).toEqual(Array.from(a.carry));
    // the uplift is a smooth field: the step across the edge between two tier-0 cells is no more than a third over a step inside one (a constant to a block made it 3 to 4 times)
    let edge = 0, inner = 0, ne = 0, ni = 0;
    const fn = g1.fn, B = 1 << TIER;
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < fn; Y++)
        for (let X = 0; X < fn - 1; X++) {
          const i = (f * fn + Y) * fn + X;
          if (a.height[i] <= 0 || a.height[i + 1] <= 0) continue;
          const d = Math.abs(a.height[i + 1] - a.height[i]);
          if (X % B === B - 1) { edge += d; ne++; } else { inner += d; ni++; }
        }
    console.log(`regional step hash ${hash(a.height)}, ${lowered} cells lowered, ${raised} raised, block edge ${(edge / ne / 256).toFixed(3)} m inside ${(inner / ni / 256).toFixed(3)} m`);
    expect(edge / ne).toBeLessThan((inner / ni) * 1.34);
    expect(hash(a.height)).toBe("bbd2995609f8c88");
  });
});

describe("the tiers made one from the one above", () => {
  test("a tier carried to the next keeps each parent's height to the unit and refineInts is the general remap", () => {
    let s = 777;
    const heights = Int32Array.from({ length: N1 }, () => { s = (s * 1103515245 + 12345) >>> 0; return Math.round((s / 2 ** 32) * 3500 * 256 - 500 * 256); });
    const fine = refineInts(TIER, heights), general = remapInts(TIER, TIER + 1, heights);
    expect(fine.length).toBe(4 * N1);
    expect(hash(fine)).toBe(hash(general));
    // the four children of a cell sum to four times its height
    const fn = 2 * g1.fn, total = new Float64Array(N1);
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < fn; Y++)
        for (let X = 0; X < fn; X++) total[(f * g1.fn + (Y >> 1)) * g1.fn + (X >> 1)] += fine[(f * fn + Y) * fn + X];
    for (let p = 0; p < N1; p++) expect(total[p]).toBe(4 * heights[p]);
  });
});
