// Per-step displacement of every plate's parcel at a cell, in tier-0 cell units along the cell's own X and Y axes (+ the speed), and the relative one between two plates.
//   bun scratch/vel0.ts face X Y [plateA plateB]
import { cellId, tierGrid, PLANET_RADIUS_M } from "../src/gpu/globe/grid";
import { cellVectors, makeSetup } from "../src/gpu/globe/tectonics";
import { CHAIN } from "../src/gpu/globe/window";
const g = tierGrid(0), vec = cellVectors(g), set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius: PLANET_RADIUS_M });
const [f, X, Y] = process.argv.slice(2, 5).map(Number), v = (x: number, y: number) => { const i = cellId(g, f, x, y); return [vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]]; };
const r = v(X, Y), ex = v(X + 1, Y).map((a, k) => (a - v(X - 1, Y)[k]) / 2), ey = v(X, Y + 1).map((a, k) => (a - v(X, Y - 1)[k]) / 2);
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const out: number[][] = [];
set.plates.forEach((p, k) => {
  const w = cross(p.pole, r).map((a) => a * p.rate * set.params.stepMy); // radians of arc per step
  const det = dot(ex, ex) * dot(ey, ey) - dot(ex, ey) ** 2, a = (dot(w, ex) * dot(ey, ey) - dot(w, ey) * dot(ex, ey)) / det, b = (dot(w, ey) * dot(ex, ex) - dot(w, ex) * dot(ex, ey)) / det;
  out.push([a, b]);
  console.log(`plate ${k}: speed ${p.speedMmYr.toFixed(2)} mm/yr, per step dX ${a.toFixed(3)} dY ${b.toFixed(3)} cells (axes: |ex| ${Math.sqrt(dot(ex, ex)).toFixed(5)} rad per cell)`);
});
if (process.argv[6]) { const [p, q] = process.argv.slice(5, 7).map(Number); console.log(`relative ${p} - ${q}: dX ${(out[p][0] - out[q][0]).toFixed(3)} dY ${(out[p][1] - out[q][1]).toFixed(3)}`); }
