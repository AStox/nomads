// The six gaps the island generator is measured against Bornholm by (docs/research/terrain-constants.md secs. 9 to 12 and
// fire-constants.md sec. 34), over many seeds, on the GPU chain. Land is the ground above the sea outside the lakes.
//   bun scripts/island-gaps.ts --seeds 24 [--from 1]
import { generateIslandGpu } from "../src/gpu/terrain/island";
import { rng } from "../src/sim/world";
import { CELL, LEN, N } from "../src/terrain/grid";
import { exit, holdGpu } from "./seeded";
import { theGpu } from "../src/gpu/device";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const count = Number(arg("seeds", "24")), from = Number(arg("from", "1"));
console.log(`gpu: ${await holdGpu()}`);
const g = await theGpu();

// Cells' distance from the sea, m: a two-pass chamfer over the grid (4-neighbour steps of one cell, so a little long on
// the diagonals, which is the side the coast and inland bands err on).
function seaDistance(isle: { height: Float32Array; water: Float32Array }) {
  const d = new Float32Array(LEN).fill(1e9);
  for (let i = 0; i < LEN; i++) if (isle.height[i] <= 0 && isle.water[i] > 0) d[i] = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const i = y * N + x; if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1); if (y > 0) d[i] = Math.min(d[i], d[i - N] + 1); }
  for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) { const i = y * N + x; if (x < N - 1) d[i] = Math.min(d[i], d[i + 1] + 1); if (y < N - 1) d[i] = Math.min(d[i], d[i + N] + 1); }
  return d.map((v) => v * CELL);
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

type Row = Record<string, number>;
const rows: Row[] = [];
for (let seed = from; seed < from + count; seed++) {
  const t0 = performance.now();
  const s = (await generateIslandGpu(rng(seed), g)) as unknown as Record<string, Float32Array>;
  const dist = seaDistance(s as { height: Float32Array; water: Float32Array });
  const land: number[] = [], ground: number[] = [];
  for (let i = 0; i < LEN; i++) { if (s.height[i] > 0) ground.push(i); if (s.height[i] > 0 && !(s.water[i] > 0)) land.push(i); }
  const share = (f: string) => mean(land.map((i) => s[f][i]));
  const coast = land.filter((i) => dist[i] <= 1000), inland = land.filter((i) => dist[i] >= 2000);
  // lakes: 4-connected components of standing water on ground above the sea
  const seen = new Uint8Array(LEN);
  let lakes = 0, big = 0, lakeCells = 0;
  for (const i of ground) {
    if (!(s.water[i] > 0) || seen[i]) continue;
    lakes++;
    let cells = 0;
    const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!; lakeCells++; cells++;
      const x = c % N, y = (c - x) / N;
      for (const j of [x > 0 ? c - 1 : -1, x < N - 1 ? c + 1 : -1, y > 0 ? c - N : -1, y < N - 1 ? c + N : -1]) if (j >= 0 && !seen[j] && s.height[j] > 0 && s.water[j] > 0) { seen[j] = 1; stack.push(j); }
    }
    if (cells * CELL * CELL >= 5e4) big++;
  }
  const offPeat = land.filter((i) => !(s.peat[i] > 0.5));
  rows.push({
    seed, ms: performance.now() - t0, landKm2: (land.length * CELL * CELL) / 1e6,
    rain: mean(land.map((i) => s.precip[i])), coastRain: mean(coast.map((i) => s.precip[i])), inlandRain: mean(inland.map((i) => s.precip[i])),
    lakes, bigLakes: big, lakePct: (100 * lakeCells) / ground.length,
    tableMedian: median(land.map((i) => s.table[i])), tableAtGround: (100 * land.filter((i) => s.table[i] < 0.01).length) / land.length,
    winterWithin02: (100 * land.filter((i) => s.winterTable[i] < 0.2).length) / land.length,
    tree: 100 * share("tree"), open: 100 * (1 - share("tree")), marsh: 100 * share("marsh"), bare: 100 * share("bare"), shrub: 100 * share("shrub"), grass: 100 * share("grass"),
    peatOver05: (100 * land.filter((i) => s.peat[i] > 0.5).length) / land.length, peatDryWithin03: (100 * land.filter((i) => s.dryTable[i] <= 0.3).length) / land.length,
    carbonOffPeat: median(offPeat.map((i) => s.carbon[i])),
  });
}
const cols: [string, string, string][] = [
  ["rain", "land mean rain, mm a year", "672 (R485)"], ["coastRain", "within 1 km of the sea", "634"], ["inlandRain", "2 km or more inland", "701"],
  ["lakes", "lakes of any size", ""], ["bigLakes", "lakes of 5 ha or more", "18 assessed lakes (R534)"], ["lakePct", "lake area, % of ground", "0.45 (R528, R534)"],
  ["tableMedian", "median water table depth, m", "a few metres in the basement (R522, R530)"], ["tableAtGround", "table under 1 cm, % of land", ""],
  ["winterWithin02", "winter table under 0.2 m, % of land", ""],
  ["tree", "tree, % of land", "81 to 92 before farming (R621)"], ["open", "open (all but trees), % of land", "8.4 to 19.4 before farming (R621, R639)"],
  ["marsh", "marsh, % of land", "1.3 meadow and bog now (R612)"], ["bare", "bare, % of land", ""],
  ["peatOver05", "peat over 0.5 m, % of land", "bog 0.3 (R613)"], ["peatDryWithin03", "deepest table within 0.3 m, % of land", "bog 0.3 (R613)"],
  ["carbonOffPeat", "organic carbon off peat, 0 to 23 cm, median t/ha", "72 in 0 to 30 cm (R598)"],
];
console.log(`\n${rows.length} seeds from ${from}, ${mean(rows.map((r) => r.ms)).toFixed(0)} ms an island, land ${mean(rows.map((r) => r.landKm2)).toFixed(0)} km2\n`);
console.log(`${"".padEnd(48)}${"median".padStart(9)}${"min".padStart(9)}${"max".padStart(9)}   Bornholm`);
for (const [k, label, target] of cols) {
  const v = rows.map((r) => r[k]);
  console.log(`${label.padEnd(48)}${median(v).toFixed(2).padStart(9)}${Math.min(...v).toFixed(2).padStart(9)}${Math.max(...v).toFixed(2).padStart(9)}   ${target}`);
}
console.log(`\ncoast minus inland rain, median: ${median(rows.map((r) => r.inlandRain - r.coastRain)).toFixed(0)} mm (Bornholm +67)`);
await exit();
