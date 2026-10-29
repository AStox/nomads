// How much of the coast and of its straight runs sits on a plate boundary. RAW_DIR=<dump> bun scratch/lattice3.ts
//   plate-boundary edges: 4-neighbour cells on different plates; straight runs as lattice0.ts. "near": within K cells (4-neighbour steps) of a plate-boundary cell.
import { raw } from "./labload";
import { FACES, cellId, tierGrid } from "../src/gpu/globe/grid";
import { neighbours } from "../src/gpu/globe/tectonics";
import { edgeRunsBy } from "./lattice0";
import { runs } from "./lattice1";
const r = raw(), g = tierGrid(0), nb = neighbours(g), N = FACES * g.fn * g.fn, h = r.height, K = 4;
const pb = edgeRunsBy(r.plate, (a, b) => a !== b);
console.log(`plate boundary edges ${pb.total} (cross-face ${pb.cross}); shares >=6/10/16 ${pb.shares.map((x) => x.toFixed(3)).join("/")}`);
const dist = new Int16Array(N).fill(-1), q: number[] = [];
for (let i = 0; i < N; i++) for (let d = 0; d < 4; d++) if (r.plate[nb[4 * i + d]] !== r.plate[i]) { dist[i] = 0; q.push(i); break; }
for (let k = 0; k < q.length; k++) { const c = q[k]; if (dist[c] >= K) continue; for (let d = 0; d < 4; d++) { const j = nb[4 * c + d]; if (dist[j] < 0) { dist[j] = dist[c] + 1; q.push(j); } } }
let near = 0; for (let i = 0; i < N; i++) if (dist[i] >= 0) near++;
console.log(`cells within ${K} of a plate boundary: ${(near / N).toFixed(3)} of the planet`);
// coast edges (land/sea, every one) and the ones in runs of >= 6 / >= 10 lattice-aligned edges
for (const jump of [0, 300]) {
  const rs = runs(h, jump); let tot = 0, nearTot = 0, run6 = 0, run6Near = 0, run10 = 0, run10Near = 0;
  for (const u of rs) {
    for (let k = 0; k < u.len; k++) {
      const X = u.axis === "col" ? u.line : u.at + k, Y = u.axis === "col" ? u.at + k : u.line, c = cellId(g, u.f, X, Y), isNear = dist[c] >= 0 || dist[nb[4 * c + (u.axis === "col" ? 0 : 1)]] >= 0;
      tot++; if (isNear) nearTot++;
      if (u.len >= 6) { run6++; if (isNear) run6Near++; }
      if (u.len >= 10) { run10++; if (isNear) run10Near++; }
    }
  }
  console.log(`coast edges jump>${jump}: ${tot}, near a plate boundary ${(nearTot / tot).toFixed(3)}; in runs>=6: ${run6}, near ${(run6Near / run6).toFixed(3)}; in runs>=10: ${run10}, near ${(run10Near / Math.max(run10, 1)).toFixed(3)}`);
}
