// Look at the planet after tectonics with erosion between its steps: PNG maps (equirectangular and cube net) and the numbers the erosion
// unit reports (land, the share over 2 km, the height-area curve, rivers, basins, the books of eroded, deposited and dissolved rock).
//   bun scripts/globe-erosion-maps.ts --seed 1 --out /tmp/globe-erosion-1 [--span 200] [--sub 4] [--rain atmosphere|uniform|<mm a year>] [--rain-every 40]
//        [--n 1|2] [--k-scale 1] [--after 0 (My of erosion alone once the plates have stopped)] [--no-erosion] [--layers height,rivers,...] [--width 1440] [--zoom "lat,lon,spanDeg;..."]
// Layers: height, relief, lithology, rain, denudation (rock removed over the run, m), deposition (sediment laid, m), sediment (sediment cover, m), drainage
// (log of the discharge area), rivers (the big rivers over the relief), basins (each drainage basin its own colour), plus tectonics' own.
import { mkdirSync, writeFileSync } from "node:fs";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { climateGpu } from "../src/gpu/globe/atmosphere";
import { type Grid, cellId, locate, meanAreaM2, tierGrid } from "../src/gpu/globe/grid";
import { DEFAULTS, cellAreas, derive, extTables, landFraction, makeSetup, unpad, FLD, type Derived, type Setup } from "../src/gpu/globe/tectonics";
import { accToM2, defaultParams, hypsometry, kForN2, neighbourTables, rivers, runChain, type ChainResult } from "../src/gpu/globe/erosion";
import { classColor, heightColor, mix, png, ramp, tectonicLayers, writeLayers, type Layer, type RGB } from "./globe-maps";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (name: string) => process.argv.includes(`--${name}`);

// The atmosphere's annual rain on a height field (mm a year): the four seasons' rain summed.
let windowDays = 2;
export async function annualRain(height: Float32Array, seaLevel = 0): Promise<Float32Array> {
  const gpu = await theGpu(), g = tierGrid(0);
  // On the tectonic planet's steep windward flanks a 2 day window's rain passes what the atmosphere's accumulator holds (1,024 mm): a shorter window is
  // tried then and kept for the next call (the rain is scaled to the season by the window's length, so the answer is a snapshot of the same state).
  let c;
  for (; ; windowDays /= 2) {
    try { c = await climateGpu(gpu, g, height, { seaLevel }, { windowDays }); break; } catch (e) { if (windowDays <= 0.25 || !String(e).includes("accumulator")) throw e; }
  }
  console.log(`rain: atmosphere with a ${windowDays} day window`);
  const out = new Float32Array(height.length);
  for (const s of c.seasons) for (let i = 0; i < out.length; i++) out[i] += s.rain[i];
  return out;
}

export interface Summary {
  seed: number; landFraction: number; over2km: number; over4km: number; meanLandM: number; meanOceanM: number; landShare: number;
  seaSediment: { meanM: number; over1km: number; over5km: number }; landSediment: { meanM: number; over1km: number }; // the sediment pool's thickness, by area
  longestRiverKm: number; longestBasinKm2: number; basinsOver1e6: number; biggestBasinsKm2: number[];
  hypsometry: { edgeM: number; share: number }[];
  ledger: { removed: number; deposited: number; dissolved: number; carry: number }; // volume units
  removedKm3: number; meanDenudationMPerMy: number; seconds: number;
}

// spanMy: the My erosion ran (tectonics' span and any erosion after it).
export function summarise(set: Setup, d: Derived, res: ChainResult, spanMy: number, seed: number): Summary {
  const g = set.grid, hy = hypsometry(g, d.height), { nb, invd } = neighbourTables(g), rv = rivers(g, res.flow.to, d.height, invd, nb);
  const unitM3 = (meanAreaM2(g) * 16) / 2 ** 15, landM2 = rv.landKm2 * 1e6, areas = cellAreas(g);
  let seaA = 0, seaD = 0, seaS = 0, sea1 = 0, sea5 = 0, landS = 0, land1 = 0, landA = 0;
  for (let i = 0; i < d.n; i++) {
    const t = d.pools[1][i];
    if (d.height[i] <= 0) { seaA += areas[i]; seaD -= areas[i] * d.height[i]; seaS += areas[i] * t; if (t > 1000) sea1 += areas[i]; if (t > 5000) sea5 += areas[i]; }
    else { landA += areas[i]; landS += areas[i] * t; if (t > 1000) land1 += areas[i]; }
  }
  const num = (x: bigint) => Number(x);
  return {
    seed, seaSediment: { meanM: seaS / seaA, over1km: sea1 / seaA, over5km: sea5 / seaA }, landSediment: { meanM: landS / landA, over1km: land1 / landA }, landFraction: landFraction(g, d), over2km: hy.above(2000), over4km: hy.above(4000), meanLandM: hy.meanLandM, meanOceanM: seaA > 0 ? seaD / seaA : 0, landShare: hy.landShare,
    longestRiverKm: rv.longestKm, longestBasinKm2: rv.longestBasinKm2, basinsOver1e6: rv.over1e6, biggestBasinsKm2: rv.basins.slice(0, 6),
    hypsometry: hy.share.map((share, b) => ({ edgeM: hy.edges[b], share })),
    ledger: { removed: num(res.ledger.removed), deposited: num(res.ledger.deposited), dissolved: num(res.ledger.dissolved), carry: num(res.carry) },
    removedKm3: (num(res.ledger.removed) * unitM3) / 1e9, meanDenudationMPerMy: landM2 > 0 && spanMy > 0 ? (num(res.ledger.removed) * unitM3) / landM2 / spanMy : 0, seconds: res.seconds,
  };
}

// A text bar chart of the height-area curve in bands of 500 m: the share of the planet in each.
export function hypsometryText(hy: Summary["hypsometry"]): string {
  const bands = new Map<number, number>();
  for (const { edgeM, share } of hy) { const b = Math.floor(edgeM / 500) * 500; bands.set(b, (bands.get(b) ?? 0) + share); }
  return [...bands.entries()].sort((a, b) => b[0] - a[0]).filter(([, s]) => s > 1e-4).map(([b, s]) => `${String(b).padStart(6)} m ${(s * 100).toFixed(2).padStart(6)}% ${"#".repeat(Math.round(s * 400))}`).join("\n");
}

// A hillshaded close-up of a patch of the globe: latitude and longitude of its centre, its height in degrees of latitude, `px` pixels high and twice that wide
// at 1 / cos(latitude) the span in longitude. The light comes from the north west; relief is drawn six times steeper than it is.
export function regionMap(g: Grid, height: ArrayLike<number>, lat0: number, lon0: number, spanDeg: number, px = 720, exaggeration = 6): Buffer {
  const w = 2 * px, h = px, rgb = new Uint8Array(w * h * 3), D = Math.PI / 180, cell = (g.radius * Math.PI) / 2 / g.fn;
  const dlon = (2 * spanDeg * D) / w / Math.max(0.05, Math.cos(lat0 * D));
  const at = (lat: number, lon: number) => { const p = locate(g, lat, lon); return height[cellId(g, p.face, p.X, p.Y)]; };
  const step = (cell / g.radius) * 1.0;
  for (let y = 0; y < h; y++) {
    const lat = (lat0 + spanDeg * (0.5 - (y + 0.5) / h)) * D;
    for (let x = 0; x < w; x++) {
      const lon = lon0 * D + (x + 0.5 - w / 2) * dlon, z = at(lat, lon), cl = Math.max(0.05, Math.cos(lat));
      const gx = (at(lat, lon + step / cl) - at(lat, lon - step / cl)) / (2 * cell), gy = (at(lat + step, lon) - at(lat - step, lon)) / (2 * cell);
      const light = 0.6 + 0.5 * Math.max(-1, Math.min(1, exaggeration * (-0.7 * gx + 0.7 * gy))), c = z <= 0 ? ([30, 70, 130] as RGB) : heightColor(z), o = (y * w + x) * 3;
      rgb[o] = Math.min(255, c[0] * light); rgb[o + 1] = Math.min(255, c[1] * light); rgb[o + 2] = Math.min(255, c[2] * light);
    }
  }
  return png(w, h, rgb);
}

export function erosionLayers(g: Grid, d: Derived, res: ChainResult, S: Int32Array): Layer[] {
  const N = d.n, areaW = new Float64Array(N);
  // each cell's area weight, for turning volumes to thickness (V = H a / 16)
  const ext = extTables(g);
  for (let i = 0; i < N; i++) areaW[i] = ext.T[i];
  const thick = (v: Float64Array | undefined, i: number) => (v ? (v[i] * 16) / areaW[i] : 0);
  const acc = res.flow.acc, to = res.flow.to;
  const root = new Int32Array(N).fill(-1);
  const rootOf = (i: number) => { const path: number[] = []; let c = i; while (root[c] < 0 && to[c] !== c) { path.push(c); c = to[c]; } const r = root[c] >= 0 ? root[c] : c; root[c] = r; for (const p of path) root[p] = r; return r; };
  const sed = unpad(g, S, FLD.VB + 1);
  const blue: RGB = [20, 70, 220];
  return [
    { name: "height", color: (i) => heightColor(d.height[i]) },
    { name: "relief", color: (i) => (d.height[i] <= 0 ? [30, 70, 130] : heightColor(d.height[i])) },
    { name: "rain", color: (i) => ramp([[0, [250, 240, 210]], [400, [190, 220, 160]], [1000, [70, 160, 110]], [2500, [30, 90, 170]], [5000, [20, 30, 120]]], res.rain[i]) },
    { name: "denudation", color: (i) => ramp([[0, [245, 245, 245]], [500, [250, 220, 140]], [3000, [230, 120, 50]], [10000, [150, 30, 20]], [30000, [60, 0, 30]]], thick(res.removedV, i)) },
    { name: "deposition", color: (i) => ramp([[0, [245, 245, 245]], [300, [170, 210, 240]], [2000, [60, 120, 200]], [8000, [40, 40, 140]], [20000, [20, 0, 60]]], thick(res.depositedV, i)) },
    { name: "sediment", color: (i) => ramp([[0, [245, 245, 245]], [200, [235, 215, 150]], [1000, [200, 150, 80]], [5000, [140, 80, 40]], [15000, [70, 30, 10]]], (sed[i] >>> 0) * 16 / areaW[i]) },
    { name: "drainage", color: (i) => (d.height[i] <= 0 ? [20, 30, 60] : ramp([[0, [250, 250, 240]], [3, [200, 210, 160]], [5, [80, 160, 120]], [7, [30, 90, 170]], [9, [10, 20, 100]]], Math.log10(Math.max(1, accToM2(g, acc[i]) / 1e6)))) },
    { name: "rivers", color: (i) => (d.height[i] > 0 && accToM2(g, acc[i]) > 5e11 ? mix(blue, [0, 0, 0], Math.min(1, Math.log10(accToM2(g, acc[i]) / 5e11) / 2)) : d.height[i] <= 0 ? [30, 60, 100] : mix(heightColor(d.height[i]), [255, 255, 255], 0.45)) },
    { name: "basins", color: (i) => (d.height[i] <= 0 ? [20, 30, 60] : mix(classColor(rootOf(i)), [255, 255, 255], 0.15)) },
  ];
}

if (import.meta.main) {
  const seed = Number(arg("seed", "1")), out = arg("out", `/tmp/globe-erosion-${seed}`), width = Number(arg("width", "1440")), span = Number(arg("span", String(DEFAULTS.spanMy)));
  const want = arg("layers", "").split(",").filter(Boolean), sub = Number(arg("sub", "4")), rainMode = arg("rain", "atmosphere"), every = Number(arg("rain-every", "40"));
  const n = Number(arg("n", "1")) as 1 | 2, kScale = Number(arg("k-scale", "1"));
  const set = makeSetup({ seed, spanMy: span, plates: Number(arg("plates", String(DEFAULTS.plates))), seaLevel: Number(arg("sea", "0")) }), ext = extTables(set.grid), gpu = await theGpu();
  const base = defaultParams({ n });
  const K = base.K.map((k) => (n === 2 ? kForN2(k) : k) * kScale) as unknown as ErosionKs;
  const rain = rainMode === "atmosphere" ? (h: Float32Array) => annualRain(h, set.params.seaLevel) : async () => Number(rainMode === "uniform" ? 1000 : rainMode);
  const t0 = performance.now();
  const res = await runChain(gpu, set, { rain, rainEveryMy: every, substeps: flag("no-erosion") ? 0 : sub, track: true, afterMy: Number(arg("after", "0")), erodeFromMy: flag("no-erosion") ? 1e9 : 0, params: { n, K } });
  const d = derive(set, ext.tab, res.S), sum = summarise(set, d, res, flag("no-erosion") ? 0 : span + Number(arg("after", "0")), seed);
  mkdirSync(out, { recursive: true });
  const layers = [...erosionLayers(set.grid, d, res, res.S), ...tectonicLayers(set, d).filter((l) => ["lithology", "plates", "thickness"].includes(l.name))].filter((l) => want.length === 0 || want.includes(l.name));
  for (const p of writeLayers(set.grid, out, layers, width)) console.log(p);
  writeFileSync(`${out}/summary.json`, JSON.stringify(sum, null, 1));
  for (const z of arg("zoom", "").split(";").filter(Boolean)) { const [la, lo, sp] = z.split(",").map(Number); writeFileSync(`${out}/zoom-${la}-${lo}.png`, regionMap(set.grid, d.height, la, lo, sp)); }
  console.log(JSON.stringify({ ...sum, hypsometry: undefined }, null, 1));
  console.log(hypsometryText(sum.hypsometry));
  console.log(`total ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  await releaseGpu();
  process.exit(0);
}
type ErosionKs = readonly [number, number, number, number, number];
