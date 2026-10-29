// Sediment on the sea near the coast, from the raw chain dump.
import { raw } from "./labload";
import { FLD, neighbours } from "../src/gpu/globe/tectonics";
import { cellId, FACES, wordAt } from "../src/gpu/globe/grid";
const r = raw(), N = r.n, nb = neighbours(r.grid), k = r.meta.kmPerUnit as number; // km3 per volume unit: 16 * unitSr * R^2 (grid.ts buildTables unitSr; thickness = v * 16 / a)
const land = new Uint8Array(N); let nl = 0;
for (let i = 0; i < N; i++) if (r.height[i] > 0) { land[i] = 1; nl++; }
console.log(`land share (cells) ${(nl / N).toFixed(4)}`);
let sedSea = 0, sedLand = 0;
const g = r.grid, fw = r.meta.fw as number;
for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
  const i = cellId(g, f, X, Y), v = r.S[(FLD.VB + 1) * fw + wordAt(g, f, X, Y)] >>> 0;
  if (land[i]) sedLand += v; else sedSea += v;
}
console.log(`sediment km3: sea ${(sedSea * k).toFixed(0)}, land ${(sedLand * k).toFixed(0)}`);
const L = r.meta.ledger;
console.log(`ledger km3: removed ${(Number(L.removed) * k).toFixed(0)}, deposited ${(Number(L.deposited) * k).toFixed(0)}, dissolved ${(Number(L.dissolved) * k).toFixed(0)}; carry ${(Number(r.meta.carry) * k).toFixed(0)}`);
// 4-neighbour distance from land, by breadth first search out to 10 cells
const dist = new Int16Array(N).fill(-1), q: number[] = [];
for (let i = 0; i < N; i++) if (land[i]) { dist[i] = 0; q.push(i); }
for (let h = 0; h < q.length; h++) { const c = q[h]; if (dist[c] >= 10) continue; for (let d = 0; d < 4; d++) { const j = nb[4 * c + d]; if (dist[j] < 0) { dist[j] = dist[c] + 1; q.push(j); } } }
const pct = (a: number[], p: number) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;
const row = (a: number[]) => { a.sort((x, y) => x - y); return `n ${String(a.length).padStart(6)}  ` + [0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((p) => `p${p * 100}=${pct(a, p).toFixed(1)}`).join(" "); };
for (const D of [1, 2, 3, 5, 10]) {
  const all: number[] = [];
  for (let i = 0; i < N; i++) if (!land[i] && dist[i] >= 1 && dist[i] <= D) {
    all.push(r.sediment[i]);
  }
  console.log(`sea within ${D}: sediment m  ${row(all)}`);
}
for (const D of [1, 2, 3, 5, 10]) {
  const bas: number[] = [];
  for (let i = 0; i < N; i++) if (!land[i] && dist[i] >= 1 && dist[i] <= D && r.granitoid[i] + r.metaSed[i] + r.volcanic[i] === 0) bas.push(r.sediment[i]);
  console.log(`basalt-only sea within ${D}: sediment m  ${row(bas)}`);
}
