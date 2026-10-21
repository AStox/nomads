// The small planet (195.6 km radius, tier 0 of 256 cells a face of 1.2 km, the 75 m tier being tier 4): a seed's planet built by stages into a store
// under /tmp/planet-small/store, measured, and drawn. Each stage is its own command and stays under five minutes.
//   bun scripts/globe-planet.ts --seed 1 --stage chain       # tectonics with erosion, in parts of --budget 150 s: run it until it says kept
//   bun scripts/globe-planet.ts --seed 1 --stage climate0
//   bun scripts/globe-planet.ts --seed 1 --stage ice         # in parts of --budget 240 s: run it until it says kept
//   bun scripts/globe-planet.ts --seed 1 --stage climate1
//   bun scripts/globe-planet.ts --seed 1 --report            # statistics (JSON) and equirectangular maps under --out /tmp/planet-small/<seed>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { LAPSE } from "../src/terrain/climate";
import { SEASON_COUNT, buildStage, readPlanet, type Planet, type Stage } from "../src/gpu/globe/window";
import { SMALL_RADIUS_M, tierGrid, type Grid } from "../src/gpu/globe/grid";
import { hypsometry, neighbourTables, rivers } from "../src/gpu/globe/erosion";
import { cellAreas, cellVectors, neighbours } from "../src/gpu/globe/tectonics";
import { RANGE_Z_M } from "../src/gpu/globe/tectonics";
import { diskStore, sourceKey } from "./globe-window";
import { equirect, heightColor, mix, ramp, type Layer } from "./globe-maps";
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const DEG = Math.PI / 180;
export const STORE = "/tmp/planet-small/store";
export const smallStore = () => diskStore(STORE, sourceKey(undefined, SMALL_RADIUS_M));

// Connected components over the four neighbours of the cells where `mask` holds: the label of each cell (-1 off the mask) and the cells of each component.
function components(g: Grid, mask: Uint8Array) {
  const nb = neighbours(g), label = new Int32Array(mask.length).fill(-1), cells: number[][] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = cells.length, list = [s];
    label[s] = id;
    for (let h = 0; h < list.length; h++) for (let d = 0; d < 4; d++) { const j = nb[4 * list[h] + d]; if (mask[j] && label[j] < 0) { label[j] = id; list.push(j); } }
    cells.push(list);
  }
  return { label, cells };
}
// The greatest distance between two cells of a set (by great-circle arcs between a sample of 300 of them), km.
function extentKm(vec: Float64Array, list: number[], radiusKm: number): number {
  const step = Math.max(1, Math.floor(list.length / 300)), pick = list.filter((_, k) => k % step === 0);
  let best = 1;
  for (const a of pick) for (const b of pick) best = Math.min(best, vec[3 * a] * vec[3 * b] + vec[3 * a + 1] * vec[3 * b + 1] + vec[3 * a + 2] * vec[3 * b + 2]);
  return Math.acos(Math.max(-1, best)) * radiusKm;
}

export function report(p: Planet) {
  const g = tierGrid(0, p.radius), N = p.n, areas = cellAreas(g), vec = cellVectors(g), R = p.radius / 1000, km2 = (sr: number) => sr * R * R;
  const lat = Float64Array.from({ length: N }, (_, i) => Math.asin(vec[3 * i + 2]) / DEG);
  const h = p.height, land = Uint8Array.from(h, (z) => (z > 0 ? 1 : 0));
  const total = 4 * Math.PI, share = (pred: (i: number) => boolean) => { let a = 0; for (let i = 0; i < N; i++) if (pred(i)) a += areas[i]; return a / total; };
  const hyp = hypsometry(g, h);
  const cellKm = [Math.min(...areas), Math.max(...areas)].map((a) => Math.sqrt(a) * R);
  // continents and ranges
  const lc = components(g, land), big = lc.cells.map((c) => ({ c, a: c.reduce((s, i) => s + areas[i], 0) / total })).sort((a, b) => b.a - a.a);
  const continents = big.filter((b) => b.a >= 0.01);
  const high = Uint8Array.from(h, (z) => (z > RANGE_Z_M ? 1 : 0)), hc = components(g, high), ranges = hc.cells.map((c) => ({ n: c.length, km: extentKm(vec, c, R), a: c.reduce((s, i) => s + areas[i], 0) / total })).sort((a, b) => b.km - a.km);
  // rain belts: the year's rain by 10 degree band of latitude, over all cells and over land
  const rain = new Float32Array(N), t = new Float32Array(N), snow = new Float32Array(N);
  for (const s of p.seasons) for (let i = 0; i < N; i++) { rain[i] += s.rain[i]; t[i] += s.t[i] / SEASON_COUNT; snow[i] += s.snow.length ? s.snow[i] : 0; }
  const band = (f: (i: number) => number, only: (i: number) => boolean) => Array.from({ length: 18 }, (_, b) => {
    let s = 0, a = 0;
    for (let i = 0; i < N; i++) if (Math.floor((lat[i] + 90) / 10) === b && only(i)) { s += f(i) * areas[i]; a += areas[i]; }
    return a > 0 ? Math.round(s / a) : null;
  });
  const dryLand = share((i) => land[i] === 1 && rain[i] < 250) / Math.max(1e-9, share((i) => land[i] === 1));
  const iceNow = share((i) => p.ice.nowM[i] > 0), iceMax = share((i) => p.ice.maxM[i] > 0);
  let iceMaxM = 0; for (let i = 0; i < N; i++) iceMaxM = Math.max(iceMaxM, p.ice.maxM[i]);
  const { nb, invd } = neighbourTables(g), rv = rivers(g, p.to, h, invd, nb);
  let wind = 0, maxWind = 0;
  for (const s of p.seasons) for (let i = 0; i < N; i++) { const w = Math.hypot(s.windE[i], s.windN[i]); wind += (w * areas[i]) / total / SEASON_COUNT; maxWind = Math.max(maxWind, w); }
  const mean = (f: (i: number) => number, only: (i: number) => boolean) => { let s = 0, a = 0; for (let i = 0; i < N; i++) if (only(i)) { s += f(i) * areas[i]; a += areas[i]; } return a > 0 ? s / a : NaN; };
  return {
    seed: p.seed, radiusKm: R, cellsTier0: N, tier0CellKm: cellKm, areaKm2: km2(total),
    landShare: hyp.landShare, meanLandM: hyp.meanLandM, maxM: Math.max(...h), minM: Math.min(...h),
    over1km: hyp.above(1000), over2km: hyp.above(2000), over4km: hyp.above(4000),
    continents: continents.map((b) => ({ share: +b.a.toFixed(4), km2: Math.round(km2(b.a * total)) })), landComponents: lc.cells.length,
    ranges: { count: ranges.length, shareOver2km: share((i) => h[i] > RANGE_Z_M), longestKm: ranges.slice(0, 5).map((r) => Math.round(r.km)) },
    rainMmYr: { global: mean((i) => rain[i], () => true), land: mean((i) => rain[i], (i) => land[i] === 1), landDryShare: dryLand, bandAll: band((i) => rain[i], () => true), bandLand: band((i) => rain[i], (i) => land[i] === 1) },
    airC: { global: mean((i) => t[i], () => true), equator: band((i) => t[i], () => true)[9], pole: band((i) => t[i], () => true)[17], bandAll: band((i) => t[i], () => true) },
    windMs: { mean: wind, max: maxWind },
    ice: { nowShare: iceNow, maxShare: iceMax, maxThicknessM: iceMaxM, seaLowM: p.sea.lowM, seaNowM: p.sea.nowM },
    rivers: { longestKm: rv.longestKm, longestBasinKm2: rv.longestBasinKm2, mouths: rv.mouthCells, largestBasinsKm2: rv.basins.slice(0, 5).map(Math.round), basinsOver1e4Km2: rv.basins.filter((b) => b >= 1e4).length, landKm2: rv.landKm2 },
    sedimentLandM: mean((i) => p.pools[1][i], (i) => land[i] === 1),
  };
}

function maps(p: Planet, out: string) {
  mkdirSync(out, { recursive: true });
  const g = tierGrid(0, p.radius), N = p.n, h = p.height, areas = cellAreas(g), meanSr = (4 * Math.PI) / N;
  const rain = new Float32Array(N), t = new Float32Array(N);
  for (const s of p.seasons) for (let i = 0; i < N; i++) { rain[i] += s.rain[i]; t[i] += s.t[i] / SEASON_COUNT; }
  const RIVER_CELLS = 200; // a river is drawn where the cell's discharge area is this many mean cells at the reference rain [design: a picture's cut]
  const layers: Layer[] = [
    { name: "height", color: (i) => heightColor(h[i]) },
    { name: "rain", color: (i) => (h[i] <= 0 ? [30, 50, 90] : ramp([[0, [235, 220, 170]], [400, [190, 200, 120]], [1000, [60, 150, 70]], [2000, [20, 90, 150]], [4000, [60, 30, 140]]], rain[i])) },
    { name: "air", color: (i) => ramp([[-30, [90, 40, 160]], [-10, [60, 110, 220]], [5, [90, 190, 190]], [15, [150, 210, 90]], [25, [240, 190, 60]], [35, [210, 60, 40]]], t[i] - (h[i] > 0 ? LAPSE * h[i] : 0)) },
    { name: "ice", color: (i) => (p.ice.nowM[i] > 0 ? [250, 250, 255] : p.ice.maxM[i] > 0 ? [170, 200, 235] : h[i] <= 0 ? [30, 60, 110] : mix([90, 120, 80], [170, 160, 140], Math.min(1, h[i] / 3000))) },
    { name: "rivers", color: (i) => (h[i] <= 0 ? [20, 40, 90] : p.acc[i] >= RIVER_CELLS * 512 * (areas[i] / meanSr) ? [90, 170, 255] : mix([70, 90, 60], [220, 215, 200], Math.min(1, h[i] / 4000))) },
  ];
  for (const l of layers) writeFileSync(join(out, `${l.name}.png`), equirect(g, l, 1440));
}

async function main() {
  const seed = Number(arg("seed", "1")), store = smallStore(), t0 = performance.now(), spent = () => ((performance.now() - t0) / 1000).toFixed(0);
  const stage = arg("stage", "");
  if (stage) {
    const gpu = await theGpu();
    const done = await buildStage(gpu, seed, stage as Stage, store, Number(arg("budget", stage === "chain" ? "150" : "240")), SMALL_RADIUS_M);
    console.log(`planet ${seed} ${stage}: ${done ? "kept" : "part kept, run again"} in ${spent()} s`);
    return;
  }
  if (process.argv.includes("--report")) {
    const p = await readPlanet(seed, store), out = arg("out", join("/tmp/planet-small", String(seed)));
    mkdirSync(out, { recursive: true });
    const r = report(p);
    writeFileSync(join(out, "summary.json"), JSON.stringify(r, null, 1));
    maps(p, out);
    console.log(JSON.stringify(r));
  }
}
if (import.meta.main) {
  try { await main(); } finally { await releaseGpu(); }
  process.exit(0);
}
