// The window: a seed's planet built by stages (each its own command, each under five minutes, kept in the planet store), the
// landings ranked, and windows refined from the planet with their maps.
//   bun scripts/globe-window.ts --seed 1 --stage chain       # tectonics with erosion, some 3 minutes
//   bun scripts/globe-window.ts --seed 1 --stage climate0    # the atmosphere of the chain's planet, under a minute
//   bun scripts/globe-window.ts --seed 1 --stage ice         # the ice cycle, in parts of --budget 240 s: run it until it says done
//   bun scripts/globe-window.ts --seed 1 --stage climate1    # the atmosphere of the bed the ice left
//   bun scripts/globe-window.ts --seed 1 --landings 10       # the ranked landings
//   bun scripts/globe-window.ts --seed 1 --windows 3         # the top windows' maps under --out /tmp/globe-window/<seed>
//   bun scripts/globe-window.ts --seed 1 --at "lat,lon"      # one window's maps
// The store is a directory of files (--planets, default /tmp/globe-window/planets), one directory a seed and a key of the globe's
// sources, so a planet made by other code is not read as this code's.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { STAGES, buildStage, landingCounts, landingsOf, readPlanet, windowBytes, windowOf, type Landing, type PlanetStore, type Stage, type Window } from "../src/gpu/globe/window";
import { CELL, LEN, N } from "../src/terrain/grid";
import { heightColor, mix, png, type RGB } from "./globe-maps";
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };

// The globe's sources whose change makes another planet: the key of a planet's directory.
const SOURCES = ["grid", "tectonics", "erosion", "atmosphere", "ice"].flatMap((n) => [`src/gpu/globe/${n}.ts`, `src/gpu/wgsl/globe-${n}.ts`]);
export function sourceKey(root = join(import.meta.dir, "..")): string {
  const h = createHash("sha256");
  for (const f of SOURCES) h.update(readFileSync(join(root, f)));
  return h.digest("hex").slice(0, 12);
}
export function diskStore(dir = process.env.NOMADS_PLANETS ?? "/tmp/globe-window/planets", key = sourceKey()): PlanetStore & { dir: (seed: number) => string } {
  const at = (seed: number) => join(dir, `${seed}-${key}`);
  return {
    dir: at,
    get: async (seed, name) => { const f = join(at(seed), `${name}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; },
    put: async (seed, name, bytes) => { mkdirSync(at(seed), { recursive: true }); writeFileSync(join(at(seed), `${name}.bin`), bytes); },
  };
}

// The window's hash: sha256 of the fields window.ts windowBytes names.
export function windowHash(w: Window): string {
  const h = createHash("sha256");
  for (const b of windowBytes(w)) h.update(b);
  return h.digest("hex");
}

// ---------- maps of a window, 2 px a cell ----------
const PX = 2;
function image(color: (i: number) => RGB): Buffer {
  const w = N * PX, rgb = new Uint8Array(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const c = color(Math.floor(y / PX) * N + Math.floor(x / PX)), o = (y * w + x) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
  return png(w, w, rgb);
}
// The ground shaded by a light from the north west at 45 degrees (the relief as it is), the sea and lakes blue, and the streams
// whose mean flow passes RIVER_M3S drawn (the channel mask is the bed, which on steep ground is nearly every cell).
const RIVER_M3S = 0.5;
function hillshade(w: Window): Buffer {
  const { height: z, water, flow } = w.isle, at = (x: number, y: number) => z[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
  const L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  return image((i) => {
    const x = i % N, y = Math.floor(i / N);
    if (water[i] > 0) return z[i] < 0 && water[i] >= -z[i] - 1e-3 ? heightColor(z[i]) : [70, 120, 200];
    if (flow[i] > RIVER_M3S) return [40, 90, 200];
    const dx = (at(x + 1, y) - at(x - 1, y)) / 150, dy = (at(x, y + 1) - at(x, y - 1)) / 150, nz = 1 / Math.hypot(dx, dy, 1);
    const shade = Math.max(0.15, -dx * nz * L[0] - dy * nz * L[1] + nz * L[2]);
    const c = heightColor(z[i]);
    return [c[0] * shade * 1.3, c[1] * shade * 1.3, c[2] * shade * 1.3].map((v) => Math.min(255, v)) as RGB;
  });
}
const ROCK_RGB: RGB[] = [[120, 100, 90], [215, 190, 120], [200, 200, 215], [220, 120, 120], [60, 70, 70]];
const rockMap = (w: Window) => image((i) => (w.isle.height[i] <= 0 ? [40, 60, 110] : ROCK_RGB[w.isle.rock[i]]));
const rainMap = (w: Window, most: number) => image((i) => mix([250, 240, 200], [20, 60, 170], w.isle.precip[i] / most));
function coverMap(w: Window): Buffer {
  const s = w.isle;
  return image((i) => {
    if (s.water[i] > 0) return [60, 110, 190];
    const parts: [number, RGB][] = [[s.tree[i], [30, 90, 40]], [s.shrub[i], [110, 130, 60]], [s.grass[i], [170, 200, 90]], [s.marsh[i], [80, 150, 140]], [s.bare[i], [150, 145, 140]], [s.sand[i], [220, 205, 150]]];
    const t = parts.reduce((a, [v]) => a + v, 0) || 1;
    return [0, 1, 2].map((k) => parts.reduce((a, [v, c]) => a + (v / t) * c[k], 0)) as RGB;
  });
}

// A window's numbers: its means against the planet's, its land, height, slope, water, rivers, channels and cover. The drainage
// density counts a cell's side of channel a channel cell; peat is ground under 0.4 m of it or more (a Histosol, WRB 2022).
function summary(w: Window) {
  const s = w.isle, sum = (a: ArrayLike<number>) => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };
  let land = 0, top = -Infinity, low = Infinity, lake = 0, flow = 0, chan = 0, river = 0, peat = 0;
  const slopes: number[] = [], cover = { tree: 0, shrub: 0, grass: 0, marsh: 0, bare: 0, sand: 0 };
  for (let i = 0; i < LEN; i++) {
    top = Math.max(top, s.height[i]);
    flow = Math.max(flow, s.flow[i]);
    if (s.height[i] <= 0) continue;
    land++;
    low = Math.min(low, s.height[i]);
    if (s.water[i] > 0) { lake++; continue; }
    const x = i % N, y = Math.floor(i / N);
    if (s.channel[i]) chan++;
    if (s.flow[i] > RIVER_M3S) river++;
    if (s.peat[i] >= 0.4) peat++;
    for (const k of Object.keys(cover) as (keyof typeof cover)[]) cover[k] += s[k][i];
    if (x > 0 && y > 0 && x < N - 1 && y < N - 1) slopes.push((Math.atan(Math.hypot(s.height[i + 1] - s.height[i - 1], s.height[i + N] - s.height[i - N]) / 150) * 180) / Math.PI);
  }
  slopes.sort((a, b) => a - b);
  const dry = land - lake, q = (p: number) => Math.round(slopes[Math.floor(p * (slopes.length - 1))] * 10) / 10;
  let landSum = 0;
  for (let i = 0; i < LEN; i++) if (s.height[i] > 0) landSum += s.height[i];
  return {
    at: `${w.latDeg.toFixed(2)}, ${w.lonDeg.toFixed(2)}`, meanHeightM: sum(s.height) / LEN, coarseHeightM: w.coarse.heightM, landMeanM: landSum / land,
    rainMm: w.isle.seasons.map((x) => sum(x.precip) / LEN), coarseRainMm: w.coarse.rainMm,
    landShare: land / LEN, topM: top, reliefM: top - low, slopeDeg: { p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99) },
    lakeCells: lake, lakes: s.lakes, biggestFlowM3s: flow, riverCells: river, channelShare: chan / dry, drainageKmPerKm2: (chan * CELL) / 1000 / ((dry * CELL * CELL) / 1e6),
    cover: Object.fromEntries(Object.entries(cover).map(([k, v]) => [k, Math.round((v / dry) * 1000) / 1000])), peatShare: peat / dry,
    upliftMmYr: w.params.upliftMYr * 1000, probeMeanM: w.params.probeMeanM, openEdge: w.params.openEdge, inflow: w.params.inflow.map((v) => ({ x: v.x, y: v.y, areaKm2: v.areaKm2, m3s: v.m3s })),
    tC: w.isle.seasons.map((x) => sum(x.temp) / LEN), angleDeg: (w.params.angle * 180) / Math.PI, snowShift: w.params.place.snowShift,
  };
}

const row = (l: Landing, k: number) =>
  `${String(k + 1).padStart(2)}  ${l.latDeg.toFixed(2).padStart(7)} ${l.lonDeg.toFixed(2).padStart(8)}  ${l.summitM.toFixed(0).padStart(6)}  ${(l.seaShare * 100).toFixed(0).padStart(4)}%  ${l.riverM3s.toFixed(1).padStart(8)}  ${l.rainMm.toFixed(0).padStart(6)}  ${l.tC.toFixed(1).padStart(5)}  ${l.glaciated ? "yes" : "no"}`;

async function main() {
  // --key reads a planet the globe's sources made before they changed (its directory's key), which the default would not
  const seed = Number(arg("seed", "1")), store = diskStore(arg("planets", process.env.NOMADS_PLANETS ?? "/tmp/globe-window/planets"), arg("key", "") || sourceKey());
  const stage = arg("stage", "");
  const gpu = await theGpu();
  if (stage) {
    if (!STAGES.includes(stage as Stage)) throw new Error(`--stage: one of ${STAGES.join(", ")}`);
    const t0 = performance.now(), done = await buildStage(gpu, seed, stage as Stage, store, Number(arg("budget", "240")));
    console.log(`planet ${seed} ${stage}: ${done ? "done" : "part kept, run it again"} in ${((performance.now() - t0) / 1000).toFixed(0)} s (${store.dir(seed)})`);
    return;
  }
  const planet = await readPlanet(seed, store), count = Number(arg("landings", "0")) || Number(arg("windows", "0"));
  const landings = landingsOf(planet, Math.max(count, 3));
  if (arg("landings", "")) {
    const c = landingCounts;
    console.log(`landings of seed ${seed}: the sea, ground over 1 km, a river of 5 m3/s and a year of 500 mm within the window's reach, no ice now; by the highest ground`);
    console.log(`land cells ${c[0]}; with the sea ${c[1]}, and over 1 km ${c[2]}, and a river ${c[3]}, and the rain ${c[4]}, and no ice ${c[5]}`);
    console.log(" #      lat      lon  summit   sea  river m3/s  rain  t sea  ice at max");
    landings.forEach((l, k) => console.log(row(l, k)));
  }
  const at = arg("at", ""), places = at ? [at.split(",").map(Number) as [number, number]] : landings.slice(0, Number(arg("windows", "0"))).map((l) => [l.latDeg, l.lonDeg] as [number, number]);
  const out = arg("out", `/tmp/globe-window/${seed}`);
  for (const [k, [lat, lon]] of places.entries()) {
    const t0 = performance.now(), w = await windowOf(gpu, planet, lat, lon), dir = join(out, at ? `at-${lat.toFixed(2)}_${lon.toFixed(2)}` : `landing-${k + 1}`);
    mkdirSync(dir, { recursive: true });
    let most = 0;
    for (let i = 0; i < LEN; i++) most = Math.max(most, w.isle.precip[i]);
    writeFileSync(join(dir, "hillshade.png"), hillshade(w)); writeFileSync(join(dir, "rock.png"), rockMap(w));
    writeFileSync(join(dir, "rain.png"), rainMap(w, most)); writeFileSync(join(dir, "cover.png"), coverMap(w));
    const s = { ...summary(w), hash: windowHash(w), seconds: (performance.now() - t0) / 1000, mostRainMm: most };
    writeFileSync(join(dir, "summary.json"), JSON.stringify(s, null, 1));
    console.log(dir, JSON.stringify(s));
  }
}

if (import.meta.main) {
  try { await main(); } finally { await releaseGpu(); }
  process.exit(0);
}
