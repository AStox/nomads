// The one-cell ridges of a chain dump in runs of 4 or more (the lattice0.ts ridge definition): where, how long, how high, and what rock (volcanic share of the crust), the plate boundary and the 4-neighbour
// distance to it. RAW_DIR=<dump> bun scratch/ridge0.ts [n]
import { raw } from "./labload";
import { FACES, cellId, tierGrid } from "../src/gpu/globe/grid";
import { neighbours } from "../src/gpu/globe/tectonics";
const r = raw(), g = tierGrid(0), nb = neighbours(g), fn = g.fn, N = FACES * fn * fn, h = r.height;
const list: { len: number; f: number; axis: string; line: number; at: number; hmean: number; vol: number; pb: number }[] = [];
const dist = new Int16Array(N).fill(99), q: number[] = [];
for (let i = 0; i < N; i++) for (let d = 0; d < 4; d++) if (r.plate[nb[4 * i + d]] !== r.plate[i]) { dist[i] = 0; q.push(i); break; }
for (let k = 0; k < q.length; k++) { const c = q[k]; if (dist[c] >= 12) continue; for (let d = 0; d < 4; d++) { const j = nb[4 * c + d]; if (dist[j] === 99) { dist[j] = dist[c] + 1; q.push(j); } } }
const isR = (c: number, across: number, along: number) => h[c] > 0 && h[c] - h[nb[4 * c + across]] > 10 && h[c] - h[nb[4 * c + across + 2]] > 10 && Math.abs(h[c] - h[nb[4 * c + along]]) <= 30 && Math.abs(h[c] - h[nb[4 * c + along + 2]]) <= 30;
for (const [across, axis] of [[0, "col"], [1, "row"]] as const) for (let f = 0; f < FACES; f++) for (let l = 0; l < fn; l++) {
  let run = 0, start = 0, hs = 0, vs = 0, pb = 99;
  const flush = () => { if (run >= 4) list.push({ len: run, f, axis, line: l, at: start, hmean: hs / run, vol: vs / run, pb }); run = 0; hs = 0; vs = 0; pb = 99; };
  for (let p = 0; p < fn; p++) {
    const X = axis === "col" ? l : p, Y = axis === "col" ? p : l, c = cellId(g, f, X, Y);
    if (isR(c, across, 1 - across)) { if (!run) start = p; run++; hs += h[c]; vs += r.volcanic[c] / (r.basalt[c] + r.sediment[c] + r.metaSed[c] + r.granitoid[c] + r.volcanic[c]); pb = Math.min(pb, dist[c]); } else flush();
  }
  flush();
}
list.sort((a, b) => b.len - a.len);
const n = Number(process.argv[2] ?? 12), cells = list.reduce((a, b) => a + b.len, 0);
console.log(`${list.length} ridge runs >=4, ${cells} cells; near a plate boundary (<=2): ${(list.filter((x) => x.pb <= 2).reduce((a, b) => a + b.len, 0) / cells).toFixed(3)}; mean volcanic share ${(list.reduce((a, b) => a + b.vol * b.len, 0) / cells).toFixed(3)}`);
for (const x of list.slice(0, n)) console.log(`len ${x.len} f${x.f} ${x.axis}${x.line}[${x.at}] mean h ${x.hmean.toFixed(0)} m, volcanic share ${x.vol.toFixed(2)}, min plate-boundary distance ${x.pb}`);
