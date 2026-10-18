// The lake basins on seeds 1 to 3, for judging a change to the ice's valleys or the lake rule: how many closed hollows the
// upstream stage makes and how deep, how many are deep enough for a lake (basins), how many of those fill, and how big
// the lakes are, split by whether the ice scoured the hollow's cells (docs/research/generator/2026-10-18-lakes.md).
//   bun scripts/lake-gaps.ts [--seeds 3] [--from 1]
import { climateGpu } from "../src/gpu/terrain/island";
import { hydrologyGpu } from "../src/gpu/terrain/water";
import { rng } from "../src/sim/world";
import { upstream } from "../src/terrain/island";
import { CELL, LEN } from "../src/terrain/grid";
import { exit, holdGpu } from "./seeded";
import { theGpu } from "../src/gpu/device";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const count = Number(arg("seeds", "3")), from = Number(arg("from", "1"));
console.log(`gpu: ${await holdGpu()}`);
const g = await theGpu();
const ha = (cells: number) => (cells * CELL * CELL) / 1e4;
const quantile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

type Hollow = { cells: number; deepest: number; scoured: number; basin: boolean; lake: number };
for (let seed = from; seed < from + count; seed++) {
  const rand = rng(seed);
  let scour = new Float32Array(LEN);
  const up = upstream(rand, (s) => { if (s.stage === "ice") scour = Float32Array.from(s.scour); });
  const air = await climateGpu(g, up.height, up.open, rand);
  const hy = await hydrologyGpu(g, { h: up.height, filled: up.filled, to: up.to, basin: up.basin, rock: up.rock, drift: up.drift, driftDepth: up.driftDepth, air });
  const hollows = new Map<number, Hollow>();
  let ground = 0, scouredCells = 0;
  for (let i = 0; i < LEN; i++) {
    if (up.height[i] <= 0) continue;
    ground++;
    if (scour[i] > 0) scouredCells++;
    const id = up.hollow[i];
    if (id < 0) continue;
    const h = hollows.get(id) ?? { cells: 0, deepest: 0, scoured: 0, basin: !!up.basin[i], lake: 0 };
    h.cells++;
    h.deepest = Math.max(h.deepest, up.filled[i] - up.height[i]);
    if (scour[i] > 0) h.scoured++;
    if (hy.water[i] > 0) h.lake++;
    hollows.set(id, h);
  }
  const all = [...hollows.values()], basins = all.filter((h) => h.basin), lakes = basins.filter((h) => h.lake > 0);
  const scoured = basins.filter((h) => h.scoured > 0), size = lakes.map((h) => ha(h.lake));
  const lakeCells = lakes.reduce((a, h) => a + h.lake, 0), basinCells = basins.reduce((a, h) => a + h.cells, 0);
  console.log(`seed ${seed}: ground ${ha(ground) / 100} km2, ${scouredCells} cells scoured`);
  console.log(`  hollows ${all.length}, basins ${basins.length} (${scoured.length} with scoured cells), lakes ${lakes.length}; lake area ${ha(lakeCells).toFixed(0)} ha = ${((100 * lakeCells) / ground).toFixed(2)}% of ground, ${((100 * lakeCells) / Math.max(1, basinCells)).toFixed(0)}% of the basins' cells`);
  console.log(`  depth below spill, m: hollows p50 ${quantile(all.map((h) => h.deepest), 0.5).toFixed(1)} p90 ${quantile(all.map((h) => h.deepest), 0.9).toFixed(1)}, basins p50 ${quantile(basins.map((h) => h.deepest), 0.5).toFixed(1)} p90 ${quantile(basins.map((h) => h.deepest), 0.9).toFixed(1)} max ${Math.max(...basins.map((h) => h.deepest)).toFixed(1)}`);
  console.log(`  lake size, ha: p50 ${quantile(size, 0.5).toFixed(1)} p90 ${quantile(size, 0.9).toFixed(1)} max ${Math.max(...size).toFixed(0)}; ${size.filter((v) => v >= 5).length} of 5 ha or more hold ${size.filter((v) => v >= 5).reduce((a, b) => a + b, 0).toFixed(0)} of ${size.reduce((a, b) => a + b, 0).toFixed(0)} ha`);
}
await exit();
