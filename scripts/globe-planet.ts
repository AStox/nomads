// The planet (391.1 km radius, tier 0 of 256 cells a face of 2.4 km, the 75 m tier being tier 5: grid.ts PLANET_*): a seed's planet built by stages into a store
// under the bake directory's small/store (bakedir.ts PLANET_STORE), measured, and drawn. Each stage is its own command and stays under five minutes.
//   bun scripts/globe-planet.ts --seed 1 --stage chain       # tectonics with erosion, in parts of --budget 150 s: run it until it says kept
//   bun scripts/globe-planet.ts --seed 1 --stage climate0
//   bun scripts/globe-planet.ts --seed 1 --stage ice         # in parts of --budget 240 s: run it until it says kept
//   bun scripts/globe-planet.ts --seed 1 --stage climate1
//   bun scripts/globe-planet.ts --seed 1 --report            # statistics (JSON) and equirectangular maps under --out small/391km/<seed> in the bake directory
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { LAPSE } from "../src/terrain/climate";
import { SEASON_COUNT, buildStage, readPlanet, type Planet, type Stage } from "../src/gpu/globe/window";
import { PLANET_RADIUS_M, tierGrid, type Grid } from "../src/gpu/globe/grid";
import { PLANET_STORE } from "../src/gpu/globe/bakedir";
import { hypsometry, neighbourTables, rivers } from "../src/gpu/globe/erosion";
import { cellAreas, cellVectors, neighbours } from "../src/gpu/globe/tectonics";
import { RANGE_Z_M } from "../src/gpu/globe/tectonics";
import { circulationOf, planetOf } from "../src/gpu/globe/atmosphere";
import { eastNorth } from "../src/gpu/globe/grid";
import { diskStore, sourceKey } from "./globe-window";
import { equirect, heightColor, mix, ramp, type Layer } from "./globe-maps";
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const DEG = Math.PI / 180;
export const STORE = process.env.NOMADS_STORE ?? "/tmp/planet-small/store";
export const smallStore = () => diskStore(STORE, sourceKey(undefined, PLANET_RADIUS_M));

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

// The Earth-like facts, fixed before the planets were looked at (R1780). Each is a measure and Earth's value it is read against [cited from memory: UNVERIFIED unless said]:
//  1 winds: the zonal-mean prevailing surface wind is easterly (trades) in 5 to 25 degrees, westerly in 35 to 60 and easterly poleward of 70; Earth's trades -3 to -6 m/s, westerlies +3 to +8;
//  2 belts: the zonal-mean rain has a tropical maximum (0 to 10 degrees), a subtropical minimum (25 to 35) below both it and the mid-latitude belt (45 to 55) by a fifth;
//  3 rain shadow: over land above 1 km with a km of relief in its 3 by 3 cells, the rain two cells downwind over the rain two cells upwind is under 0.8 (Earth: well under 1);
//  4 west coast: at 40 to 60 degrees, land with the sea to its west is wetter than land with the sea to its east, by a fifth, and has the smaller seasonal range of air (Earth: Vancouver Island and Norway against Newfoundland and Labrador);
//  5 polar ice: over half of the land poleward of 70 degrees under ice now, and the equator to pole contrast of the year's sea-level air at least 35 K (Earth: Greenland 80%, Antarctica 98%, 50 K);
//  6 ranges (amended by Unit 4c: rock sets a range's width, not the radius): the mean width (area over length) of the five longest ranges over 2 km is 150 to 400 km [cited: the Himalaya 200 to 400 km
//    (Britannica), 250 to 350 km (ETH Zurich structural geology notes, files.ethz.ch/structuralgeology), 595,000 km2 over 2,500 km is 238; the Alps 207,000 km2 over 1,200 km is 172 km (Britannica)], and the highest summit of each is over 4 km.
export function facts(p: Planet) {
  const g = tierGrid(0, p.radius), N = p.n, areas = cellAreas(g), vec = cellVectors(g), nb = neighbours(g), h = p.height, R = p.radius / 1000;
  const lat = Float64Array.from({ length: N }, (_, i) => (Math.asin(vec[3 * i + 2]) * 180) / Math.PI);
  const mean4 = (f: (s: Planet["seasons"][number]) => Float32Array) => { const o = new Float64Array(N); for (const s of p.seasons) { const a = f(s); for (let i = 0; i < N; i++) o[i] += a[i] / SEASON_COUNT; } return o; };
  const u = mean4((s) => s.windE), v = mean4((s) => s.windN), rain = new Float64Array(N);
  for (const s of p.seasons) for (let i = 0; i < N; i++) rain[i] += s.rain[i];
  const band = (f: ArrayLike<number>, lo: number, hi: number, only: (i: number) => boolean = () => true) => { let s = 0, a = 0; for (let i = 0; i < N; i++) { const l = Math.abs(lat[i]); if (l >= lo && l < hi && only(i)) { s += f[i] * areas[i]; a += areas[i]; } } return a > 0 ? s / a : NaN; };
  // 1
  const zonal = Array.from({ length: 18 }, (_, b) => +band(u, b * 5, b * 5 + 5).toFixed(2)), mid = (a: number, b: number) => band(u, a, b), signs = [mid(5, 25) < 0, mid(35, 60) > 0, mid(70, 90) < 0];
  // 2
  const wet = (a: number, b: number) => band(rain, a, b), tropic = wet(0, 10), sub = wet(25, 35), midlat = wet(45, 55);
  // 3 and 4: neighbours of a cell by geographic direction; a step along (e, n) takes the neighbour whose bearing is nearest it
  const bearing = (i: number, j: number): [number, number] => {
    const [E, Nn] = eastNorth([vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]]);
    const d = [vec[3 * j] - vec[3 * i], vec[3 * j + 1] - vec[3 * i + 1], vec[3 * j + 2] - vec[3 * i + 2]];
    return [d[0] * E[0] + d[1] * E[1] + d[2] * E[2], d[0] * Nn[0] + d[1] * Nn[1] + d[2] * Nn[2]];
  };
  const toward = (i: number, e: number, n: number): number => {
    let best = -2, to = i;
    for (let d = 0; d < 4; d++) { const j = nb[4 * i + d], [be, bn] = bearing(i, j), c = (be * e + bn * n) / (Math.hypot(be, bn) * Math.hypot(e, n) || 1); if (c > best) { best = c; to = j; } }
    return to;
  };
  const steps = (i: number, e: number, n: number, k: number) => { let j = i; for (let s = 0; s < k; s++) j = toward(j, e, n); return j; };
  let lee = 0, wind = 0, sample = 0;
  const relief = (i: number) => { let lo = h[i], hi = h[i]; for (let d = 0; d < 4; d++) { const j = nb[4 * i + d]; lo = Math.min(lo, h[j]); hi = Math.max(hi, h[j]); } return hi - lo; };
  for (let i = 0; i < N; i++) {
    if (h[i] < 1000 || Math.hypot(u[i], v[i]) < 0.5) continue;
    if (relief(i) < 1000) continue;
    const down = steps(i, u[i], v[i], 2), up = steps(i, -u[i], -v[i], 2);
    if (h[down] <= 0 || h[up] <= 0) continue;
    lee += rain[down]; wind += rain[up]; sample++;
  }
  // 4: coast cells by the side the sea is on
  const westRain: number[] = [], eastRain: number[] = [], westRange: number[] = [], eastRange: number[] = [];
  const range = (i: number) => { const t = p.seasons.map((s) => s.t[i] - LAPSE * Math.max(0, h[i])); return Math.max(...t) - Math.min(...t); };
  for (let i = 0; i < N; i++) {
    const l = Math.abs(lat[i]);
    if (h[i] <= 0 || l < 40 || l > 60) continue;
    const j = steps(i, -1, 0, 1), k = steps(i, 1, 0, 1);
    if (h[j] <= 0 && h[k] > 0) { westRain.push(rain[i]); westRange.push(range(i)); }
    if (h[k] <= 0 && h[j] > 0) { eastRain.push(rain[i]); eastRange.push(range(i)); }
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  // 5
  let polarLand = 0, polarIce = 0;
  for (let i = 0; i < N; i++) if (Math.abs(lat[i]) >= 70 && h[i] > 0) { polarLand += areas[i]; if (p.ice.nowM[i] > 0) polarIce += areas[i]; }
  const airT = mean4((s) => s.t), eq = band(airT, 0, 10), pole = band(airT, 80, 90);
  // 6
  const high = Uint8Array.from(h, (z) => (z > RANGE_Z_M ? 1 : 0)), hc = components(g, high);
  const ranges = hc.cells.map((c) => ({ km: extentKm(vec, c, R), a: c.reduce((s, i) => s + areas[i], 0) * R * R, top: c.reduce((m, i) => Math.max(m, h[i]), 0) })).filter((r) => r.km > 0).sort((a, b) => b.km - a.km).slice(0, 5);
  const widths = ranges.map((r) => r.a / r.km / R);
  const c = circulationOf(planetOf({ radius: p.radius }));
  return {
    circulation: { dayMinutes: +(planetOf({ radius: p.radius }).dayS / 60).toFixed(1), hadleyEdgeDeg: +((c.hadley * 180) / Math.PI).toFixed(1), polarFrontDeg: +((c.polarFront * 180) / Math.PI).toFixed(1) },
    winds: { zonalMeanEastMs5DegBands: zonal, tradesEasterly: signs[0], westerlies: signs[1], polarEasterlies: signs[2], pass: signs.every(Boolean) },
    belts: { rainMm: { tropic: Math.round(tropic), subtropic: Math.round(sub), midlat: Math.round(midlat) }, pass: sub < 0.8 * tropic && sub < 0.8 * midlat },
    rainShadow: { leeOverWindward: +(lee / wind).toFixed(2), cells: sample, pass: lee / wind < 0.8 },
    westCoast: { cellsWestSea: westRain.length, cellsEastSea: eastRain.length, rainWestMm: Math.round(avg(westRain)), rainEastMm: Math.round(avg(eastRain)), rangeWestK: +avg(westRange).toFixed(1), rangeEastK: +avg(eastRange).toFixed(1), pass: avg(westRain) > 1.2 * avg(eastRain) && avg(westRange) < avg(eastRange) },
    polarIce: { polarLandUnderIce: +(polarIce / Math.max(1e-12, polarLand)).toFixed(2), equatorToPoleK: +(eq - pole).toFixed(1), pass: polarIce / Math.max(1e-12, polarLand) > 0.5 && eq - pole >= 35 },
    ranges: { longestKm: ranges.map((r) => Math.round(r.km)), meanWidthKm: widths.map((w) => Math.round(w * R)), highestM: ranges.map((r) => Math.round(r.top)), pass: widths.length > 0 && widths.every((w) => w * R >= 150 && w * R <= 400) && ranges.every((r) => r.top > 4000) },
  };
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
    facts: facts(p),
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
    const done = await buildStage(gpu, seed, stage as Stage, store, Number(arg("budget", stage === "chain" ? "150" : "240")), PLANET_RADIUS_M);
    console.log(`planet ${seed} ${stage}: ${done ? "kept" : "part kept, run again"} in ${spent()} s`);
    return;
  }
  if (process.argv.includes("--report")) {
    const p = await readPlanet(seed, store), out = arg("out", join(PLANET_STORE, "..", "391km", String(seed)));
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
