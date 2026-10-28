// Test of a bounded carry (what a fix could be, not part of the generator): the tiers' smooth carry (refineSmooth, regional.ts) with every child clamped to the minimum and maximum of its parent's 3 x 3
// neighbourhood at the tier above (the local-extremum bound of a limited reconstruction: Barth and Jespersen 1989, "The design and application of upwind schemes on unstructured meshes", AIAA 89-0366;
// the same bound as an essentially non-oscillatory reconstruction, Harten et al. 1987), then the parent's mean restored by spreading the miss over the children that can still move, 8 rounds.
// Parents on a face's rim are left as refineSmooth gave them. Tier 0 to 3 of the new planet's chain, CPU. Prints the pockets (scripts/straight-offset.ts) and the mean it held.
//   bun scripts/straight-limit.ts <chain height.f32> [--write <t3 out.i32>]
import { readFileSync, writeFileSync } from "node:fs";
import { refineSmooth } from "../src/gpu/globe/regional";
const [chain] = process.argv.slice(2), wi = process.argv.indexOf("--write");
const b = readFileSync(chain), h0 = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
let P: Int32Array | Float32Array = Float32Array.from(h0, (v) => v * 256);
for (let t = 0; t < 3; t++) {
  const fnp = 256 << t, fn = fnp * 2, C = refineSmooth(P, t), out = Int32Array.from(C);
  let miss = 0, clamped = 0;
  for (let f = 0; f < 6; f++) for (let Y = 1; Y < fnp - 1; Y++) for (let X = 1; X < fnp - 1; X++) {
    const p = f * fnp * fnp + Y * fnp + X;
    let lo = Infinity, hi = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const v = P[p + dy * fnp + dx]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const o = (f * fn + 2 * Y) * fn + 2 * X, idx = [o, o + 1, o + fn, o + fn + 1], v = idx.map((i) => Math.min(hi, Math.max(lo, C[i])));
    for (let k = 0; k < 4; k++) if (v[k] !== C[idx[k]]) clamped++;
    for (let r = 0; r < 8; r++) {
      const d = 4 * P[p] - (v[0] + v[1] + v[2] + v[3]);
      if (Math.abs(d) < 2) break;
      let free = 0; for (let k = 0; k < 4; k++) if (d > 0 ? v[k] < hi : v[k] > lo) free++;
      if (!free) break;
      for (let k = 0; k < 4; k++) if (d > 0 ? v[k] < hi : v[k] > lo) v[k] = Math.min(hi, Math.max(lo, v[k] + d / free));
    }
    for (let k = 0; k < 4; k++) out[idx[k]] = Math.round(v[k]);
    miss += Math.abs(4 * P[p] - (out[idx[0]] + out[idx[1]] + out[idx[2]] + out[idx[3]])) / 4 / 256;
  }
  console.log(`tier ${t + 1}: children clamped ${clamped}, mean miss per parent ${(miss / (6 * (fnp - 2) ** 2)).toFixed(4)} m`);
  P = out;
}
const t3 = P as Int32Array, fn = 2048, classes = [[0, 1], [1, 5], [5, 20], [20, 100], [100, 1e9]] as const, under = classes.map(() => 0), parents = classes.map(() => 0);
let land = 0, cells = 0, edges = 0, runs5 = 0, runEdge5 = 0;
for (let f = 0; f < 6; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
  const p = h0[(f * 256 + (Y >> 3)) * 256 + (X >> 3)], v = t3[(f * fn + Y) * fn + X];
  cells++; if (v > 0) land++;
  if (p > 0) classes.forEach(([a, c], i) => { if (p > a && p <= c) { parents[i]++; if (v <= 0) under[i]++; } });
}
for (let f = 0; f < 6; f++) {
  const vrun = new Int32Array(fn), flush = (n: number) => { edges += n; if (n * 0.3 >= 5) { runs5++; runEdge5 += n; } };
  for (let Y = 0; Y < fn; Y++) {
    const o = (f * fn + Y) * fn;
    for (let X = 0; X + 1 < fn; X++) { const e = t3[o + X] > 0 !== t3[o + X + 1] > 0; if (e) vrun[X]++; else if (vrun[X]) { flush(vrun[X]); vrun[X] = 0; } }
    if (Y + 1 < fn) { let run = 0; for (let X = 0; X < fn; X++) { const e = t3[o + X] > 0 !== t3[o + fn + X] > 0; if (e) run++; else if (run) { flush(run); run = 0; } } if (run) flush(run); }
  }
  for (let X = 0; X < fn; X++) if (vrun[X]) flush(vrun[X]);
}
console.log(`bounded carry, tier 3: land share ${(land / cells).toFixed(4)}, sea-level edge ${(edges * 0.3).toFixed(0)} km, runs >= 5 km ${runs5} (${((100 * runEdge5) / edges).toFixed(1)}% of the edge); sea cells in land parents by parent height 0-1,1-5,5-20,20-100,>100 m: ${classes.map((_, i) => `${under[i]}/${parents[i]} ${((100 * under[i]) / Math.max(1, parents[i])).toFixed(2)}%`).join("  ")}`);
if (wi > 0) writeFileSync(process.argv[wi + 1], new Uint8Array(t3.buffer, t3.byteOffset, t3.byteLength));
