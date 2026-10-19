// Measure what the ranges are: the share of the planet over 2 and 4 km, the height-area curve's modes, land, continents, the relief within ranges at the
// cell size, the share of cells on a plate boundary, the books of arcs and of the cut, and the denudation when erosion runs.
//   bun scripts/globe-ranges.ts --seeds 1,2,3,4 [--speed 0.314] [--span 200] [--step 2] [--plates 10] [--hmax 70000] [--flow 320] [--eta 1e19] [--regional 32] [--wedge 54] [--load 32] [--smooth 2]
//        [--erosion 1 [--rain 1000] [--sub 4] [--after 0]] [--series 1] [--json out.json]
// --series prints, every 20 My of a tectonics run, the share of cells on a plate boundary by class, the connected pieces of the plates and the share over 2 km.
import { writeFileSync } from "node:fs";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { meanAreaM2 } from "../src/gpu/globe/grid";
import { DEFAULT_SWEEPS, FLUX, cellAreas, classifyBoundaries, components, derive, extTables, makeSetup, rangeMeasures, startingState, Tectonics, type Params } from "../src/gpu/globe/tectonics";
import { runChain } from "../src/gpu/globe/erosion";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const has = (name: string) => process.argv.includes(`--${name}`);
const seeds = arg("seeds", "1,2,3,4").split(",").map(Number);
const over: Partial<Params> = {};
if (has("speed")) over.speedScale = Number(arg("speed", "0"));
if (has("span")) over.spanMy = Number(arg("span", "0"));
if (has("step")) over.stepMy = Number(arg("step", "0"));
if (has("plates")) over.plates = Number(arg("plates", "0"));
if (has("hmax")) over.hMax = Number(arg("hmax", "0"));
if (has("eta")) over.flowEta = Number(arg("eta", "1e19"));
if (has("hotspots")) over.hotspots = Number(arg("hotspots", "0"));
const sweeps = { ...DEFAULT_SWEEPS, ...(has("flow") ? { flow: Number(arg("flow", "320")) } : {}), ...(has("smooth") ? { smooth: Number(arg("smooth", "2")) } : {}), ...(has("regional") ? { regional: Number(arg("regional", "32")) } : {}), ...(has("wedge") ? { wedge: Number(arg("wedge", "54")) } : {}), ...(has("load") ? { load: Number(arg("load", "32")) } : {}) };
const erosion = arg("erosion", "0") === "1", rainMm = Number(arg("rain", "1000")), sub = Number(arg("sub", "4")), after = Number(arg("after", "0"));
const gpu = await theGpu(), rows: unknown[] = [];
for (const seed of seeds) {
  const set = makeSetup({ seed, ...over }, sweeps), e = extTables(set.grid), g = set.grid, start = startingState(set, e.tab), t0 = performance.now();
  const unit = (meanAreaM2(g) * 16) / 2 ** 15 / 1e9; // km3 a volume unit
  let S: Int32Array, extra: Record<string, number> = {}, fluxes: bigint[] = [];
  if (erosion) {
    const res = await runChain(gpu, set, { rain: async () => rainMm, rainEveryMy: 1e9, substeps: sub, afterMy: after, params: { relief: !has("norelief") } }, start);
    S = res.S;
    const d = derive(set, e.tab, S), areas = cellAreas(g);
    let landM2 = 0;
    for (let i = 0; i < d.n; i++) if (d.height[i] > 0) landM2 += areas[i] * g.radius * g.radius;
    extra = { denudationMperMy: (Number(res.ledger.removed) * unit * 1e9) / landM2 / (set.params.spanMy + after) };
  } else {
    const tec = new Tectonics(gpu, set, e, start.S);
    for (let s = 0; s < set.steps; s++) {
      tec.step();
      if (has("series") && s % 10 === 9) {
        tec.elevate();
        const dd = derive(set, e.tab, await tec.read()), bb = classifyBoundaries(g, dd.plate, set.plates), n = dd.n, by = [0, 0, 0, 0];
        bb.cls.forEach((c) => { by[c]++; });
        let pcs = 0;
        for (let p = 0; p < set.plates.length; p++) pcs += components(g, dd.plate.map((x) => (x === p ? 1 : 0))).cells.length;
        console.log(`seed ${seed} t=${(s + 1) * set.params.stepMy} My: boundary ${((100 * (n - by[0])) / n).toFixed(2)}% (convergent ${((100 * by[1]) / n).toFixed(2)}, divergent ${((100 * by[2]) / n).toFixed(2)}, transform ${((100 * by[3]) / n).toFixed(2)}), plate pieces ${pcs}, over 2 km ${(100 * rangeMeasures(set, e.tab, dd).over2km).toFixed(1)}%`);
      }
    }
    tec.elevate();
    S = await tec.read();
    fluxes = await tec.fluxes();
    tec.release();
  }
  const d = derive(set, e.tab, S), m = rangeMeasures(set, e.tab, d);
  const bd = classifyBoundaries(g, d.plate, set.plates), boundary = bd.cls.reduce((n, c) => n + (c > 0 ? 1 : 0), 0) / bd.cls.length;
  let pieces = 0, small = 0;
  for (let p = 0; p < set.plates.length; p++) { const cc = components(g, d.plate.map((x) => (x === p ? 1 : 0))).cells; pieces += cc.length; small += cc.filter((n) => n < 200).length; }
  const row = { seed, ...m, ...extra, boundary, pieces, small, trimKm3: Number(fluxes[FLUX.TRIM] ?? 0n) * unit, arcKm3: Number(fluxes[FLUX.ARC] ?? 0n) * unit, newKm3: Number(fluxes[FLUX.NEW] ?? 0n) * unit, stackKm3: Number(fluxes[FLUX.STACK] ?? 0n) * unit, seconds: (performance.now() - t0) / 1000 };
  rows.push(row);
  console.log(JSON.stringify(row, (_, v) => (typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(4)) : v)));
}
if (has("json")) writeFileSync(arg("json", "/tmp/ranges.json"), JSON.stringify(rows, null, 1));
await releaseGpu();
process.exit(0);
