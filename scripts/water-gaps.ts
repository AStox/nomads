// The water stage's budget on seeds 1 to 3, for judging a change to the groundwater: streams, springs, lakes, runoff to the
// sea, the groundwater's share at the mouths and the table (island-gaps.ts measures the six gaps over many seeds).
//   bun scripts/water-gaps.ts [--seeds 3] [--from 1]
import { climateGpu } from "../src/gpu/terrain/island";
import { hydrologyGpu } from "../src/gpu/terrain/water";
import { upstreamGpu } from "../src/gpu/terrain/upstream";
import { rng } from "../src/sim/world";
import { CELL, LEN, N } from "../src/terrain/grid";
import { exit, holdGpu } from "./seeded";
import { theGpu } from "../src/gpu/device";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const count = Number(arg("seeds", "3")), from = Number(arg("from", "1"));
console.log(`gpu: ${await holdGpu()}`);
const g = await theGpu();
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
for (let seed = from; seed < from + count; seed++) {
  const rand = rng(seed);
  const up = await upstreamGpu(g, rand);
  const air = await climateGpu(g, up.height, up.open, rand);
  const t0 = performance.now();
  const hy = await hydrologyGpu(g, { h: up.height, filled: up.filled, to: up.to, basin: up.basin, rock: up.rock, drift: up.drift, driftDepth: up.driftDepth, air });
  const ms = performance.now() - t0;
  const land: number[] = [];
  for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && !(hy.water[i] > 0)) land.push(i);
  const A = CELL * CELL, km2 = (land.length * A) / 1e6;
  let km = 0;
  for (const line of hy.rivers) for (let k = 1; k < line.length; k++) km += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]) * CELL / 1000;
  let q = 0;
  for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && !(up.filled[i] < 0) && up.filled[up.to[i]] < 0) q += hy.flow[i];
  const seen = new Uint8Array(LEN);
  let lakes = 0, big = 0, cells = 0;
  for (let i = 0; i < LEN; i++) {
    if (!(hy.water[i] > 0) || up.height[i] <= 0 || seen[i]) continue;
    lakes++;
    let n = 0;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!; n++; cells++;
      const x = c % N, y = (c - x) / N;
      for (const j of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, y > 0 ? c - N : -1, y < N - 1 ? c + N : -1]) if (j >= 0 && !seen[j] && up.height[j] > 0 && hy.water[j] > 0) { seen[j] = 1; stack.push(j); }
    }
    if (n * A >= 5e4) big++;
  }
  const t = land.map((i) => hy.table[i]);
  const sf = hy.seasonFlow.map((f) => { let s = 0; for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && up.filled[i] >= 0 && up.filled[up.to[i]] < 0) s += f[i]; return (s / km2) * 1000; });
  const base = (() => { let a = 0, b = 0; for (let i = 0; i < LEN; i++) if (up.height[i] > 0 && up.filled[i] >= 0 && up.filled[up.to[i]] < 0) { a += hy.flow[i] * hy.base[i]; b += hy.flow[i]; } return a / b; })();
  console.log(`seed ${seed}: ${ms.toFixed(0)} ms; streams ${km.toFixed(0)} km (${(km / km2).toFixed(2)} km/km2) in ${hy.rivers.length} lines; springs ${hy.springs.length}; lakes ${lakes} (${big} of 5 ha or more), ${((100 * cells) / (land.length + cells)).toFixed(2)}% of ground; runoff to the sea ${((q / km2) * 1000).toFixed(2)} l/s/km2 (seasons ${sf.map((v) => v.toFixed(1)).join(", ")}); groundwater share at mouths ${base.toFixed(3)}; table median ${median(t).toFixed(2)} m, under 1 cm ${((100 * t.filter((v) => v < 0.01).length) / t.length).toFixed(1)}%, winter under 0.2 m ${((100 * land.filter((i) => hy.winterTable[i] < 0.2).length) / land.length).toFixed(1)}%, dry within 0.3 m ${((100 * land.filter((i) => hy.dryTable[i] <= 0.3).length) / land.length).toFixed(1)}%`);
}
await exit();
