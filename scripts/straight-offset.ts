// Does the sea-level offset of the chain's heights decide the pockets? The new planet's tier-0 heights (whole metres of bed plus a constant, .034) carried by the tiers' own smooth carry
// (refineSmooth, regional.ts) to tier 3 with the constant shifted by `shift` metres (no erosion: tiers 1 to 3 of the new law), then the pockets counted: sea cells (h <= 0) whose tier-0 parent is land
// above 0, by the parent's height (0-1, 1-5, 5-20, 20-100, >100 m), and the axis-aligned runs of sea-level edge of 5 km or more. CPU only, 2 GB.
//   bun scripts/straight-offset.ts <chain height.f32> <shift m> [shift ...]
import { readFileSync, writeFileSync } from "node:fs";
import { refineSmooth } from "../src/gpu/globe/regional";
const [chain, ...shifts] = process.argv.slice(2);
const b = readFileSync(chain), h0 = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const classes = [[0, 1], [1, 5], [5, 20], [20, 100], [100, 1e9]] as const;
for (const sh of shifts.map(Number)) {
  let cur: ArrayLike<number> = Float32Array.from(h0, (v) => (v + sh) * 256);
  for (let t = 0; t < 3; t++) cur = refineSmooth(cur, t);
  const t3 = cur as Int32Array, fn = 2048, under = classes.map(() => 0), parents = classes.map(() => 0);
  let land = 0, cells = 0, edges = 0, runs5 = 0, runEdge5 = 0;
  for (let f = 0; f < 6; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const p = h0[(f * 256 + (Y >> 3)) * 256 + (X >> 3)] + sh, v = t3[(f * fn + Y) * fn + X];
    cells++; if (v > 0) land++;
    if (p > 0) classes.forEach(([a, c], i) => { if (p > a && p <= c) { parents[i]++; if (v <= 0) under[i]++; } });
  }
  // axis-aligned runs of the sea-level line (see scripts/straight-coast.ts), per face
  for (let f = 0; f < 6; f++) {
    const vrun = new Int32Array(fn), flush = (n: number) => { edges += n; if (n * 0.3 >= 5) { runs5++; runEdge5 += n; } };
    for (let Y = 0; Y < fn; Y++) {
      const o = (f * fn + Y) * fn;
      for (let X = 0; X + 1 < fn; X++) { const e = t3[o + X] > 0 !== t3[o + X + 1] > 0; if (e) vrun[X]++; else if (vrun[X]) { flush(vrun[X]); vrun[X] = 0; } }
      if (Y + 1 < fn) { let run = 0; for (let X = 0; X < fn; X++) { const e = t3[o + X] > 0 !== t3[o + fn + X] > 0; if (e) run++; else if (run) { flush(run); run = 0; } } if (run) flush(run); }
    }
    for (let X = 0; X < fn; X++) if (vrun[X]) flush(vrun[X]);
  }
  console.log(`shift ${sh} m: tier-3 land share ${(land / cells).toFixed(4)}, sea-level edge ${(edges * 0.3).toFixed(0)} km, runs >= 5 km ${runs5} (${(100 * runEdge5 / edges).toFixed(1)}% of the edge); sea cells in land parents by parent height 0-1,1-5,5-20,20-100,>100 m: ${classes.map((_, i) => `${under[i]}/${parents[i]} ${(100 * under[i] / Math.max(1, parents[i])).toFixed(2)}%`).join("  ")}`);
  if (sh === Number(shifts[0])) writeFileSync(`${process.env.HOME}/.cache/nomads-scratch/t4/causes/offset-first-t3.i32`, new Uint8Array(t3.buffer, t3.byteOffset, t3.byteLength));
}
