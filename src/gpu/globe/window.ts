// The window: the game's 19.2 km ground of 75 m cells refined from the planet at a place, in place of an island generated from
// Bornholm's tables (docs/research/globe/2026-10-19-window-impl.md, R1700 to R1749). Three parts:
// - the planet (planetOf): the chain run once (tectonics with erosion, the atmosphere, an orbit-forced ice cycle with the sea's
//   return, the atmosphere again on the bed the ice left) and the coarse fields a window reads, kept by stage so that a stage can
//   be run by itself and kept between runs (a PlanetStore);
// - the landings (landingsOf): candidate places ranked by a measured criterion;
// - the window's inputs (windowInputs, below the planet): the coarse fields carried to the window's cells by a conservative
//   remap and the window's parameters, which the island stages then run under (gpu/terrain/island.ts generateWindow).
import type { Gpu } from "../device";
import { philox } from "../rand";
import { MOST_TOTAL_M, cloudDelays, type Delays, type RainSeason } from "../terrain/rain";
import type { ClimatePlace } from "../terrain/climate";
import { generateWindow, type WindowStages } from "../terrain/island";
import { windowUpstreamGpu, type WindowLay } from "../terrain/upstream";
import type { Inflow } from "../terrain/water";
import { CELL, LEN, N } from "../../terrain/grid";
import { DOLERITE, GRANITE, SANDSTONE, TILL_MAX } from "../../terrain/geology";
import { SCOUR, type Island } from "../../terrain/island";
import { COARSE, H_W, LAPSE, ROSE, SEASONS, WET_ROSE, meanWay, turned } from "../../terrain/climate";
import { YEAR_S } from "../../terrain/water";
import { skyAt, type Sky } from "../../sim/sky";
import { SEASON_S as SEASON_S_PLANET, climateGpu, type Climate as GlobeClimate } from "./atmosphere";
import { runChain } from "./erosion";
import { FACES, RADIUS_M, areaSr, cellId, eastNorth, fromLatLon, locateVec, meanAreaM2, tierGrid, type V3 } from "./grid";
import { IF, IceGpu, defaultLaw, forcingTable, lgmForcing, orbitOf, runIce, seaState } from "./ice";
import { DEFAULTS, cellAreas, cellVectors, derive, extTables, makeSetup, neighbours } from "./tectonics";

// ---------- the planet ----------
export const SEASON_COUNT = 4;
// What a window reads of each season, in cell order on tier 0 (the atmosphere's seasons: spring, summer, autumn, winter).
export interface PlanetSeason {
  t: Float32Array; // C, the air's sea-level temperature
  rain: Float32Array; snow: Float32Array; runoff: Float32Array; // mm of water over the season (rain is all of it, snow included)
  windE: Float32Array; windN: Float32Array; // m/s, the prevailing surface wind (the vector mean)
  sst: Float32Array; // C, the sea's surface (0 on land)
}
export interface Planet {
  seed: number;
  n: number; // cells (tier 0)
  height: Float32Array; // m above the present sea, the bed the ice left (negative under the sea)
  pools: Float32Array[]; // m of basalt, sediment, metasediment, granitoid, volcanic in each column (tectonics' LITH order), as the chain left them
  to: Uint32Array; // the chain's receivers (erosion's flow on the bed before the ice)
  acc: Uint32Array; // the chain's discharge area: 1/512 of the mean cell at the reference rain (erosion.ts accToM2)
  seasons: PlanetSeason[]; // on the bed the ice left, at the present sea
  // the ice at the cycle's greatest volume and now (the sea's return leaves some), the rock it cut and the sediment it laid over the cycle, m
  ice: { maxM: Float32Array; nowM: Float32Array; cutM: Float32Array; laidM: Float32Array };
  sea: { lowM: number; nowM: number }; // the lowest sea of the cycle and the present one, m against the ice-free sea
}

// The chain's settings: the erosion unit's whole chain as the ranges note ran it (200 My of tectonics with four 0.5 My substeps of
// erosion after each step, the atmosphere's rain at 0 and 100 My, then 50 My of erosion alone) [design: the ranges note's run, R1711].
export const CHAIN = { spanMy: DEFAULTS.spanMy, plates: DEFAULTS.plates, substeps: 4, rainEveryMy: 100, afterMy: 50 };
// The ice: 20 kyr held at no offset (the interglacial), one 100 kyr cycle of the orbit's forcing scaled to the cited glacial
// cooling (ice.ts lgmForcing, R1647), then 20 kyr at no offset for the sea's return; the sea and the forcing every 500 years and the
// least step 2 years, the ice unit's own [design: the ice note's cycle, its first 40 kyr shortened to 20 so a run fits its stages, R1711].
export const ICE_CYCLE = { spinYr: 20_000, cycleYr: 100_000, returnYr: 20_000, outerYr: 500, dtMin: 2 };
const ICE_YEARS = ICE_CYCLE.spinYr + ICE_CYCLE.cycleYr + ICE_CYCLE.returnYr;

// The stages, each kept by itself: the chain, the climate of the chain's planet (the ice's input), the ice (in parts: a part's
// state is kept so the cycle can be resumed), and the climate of the bed the ice left.
export const STAGES = ["chain", "climate0", "ice", "climate1"] as const;
export type Stage = (typeof STAGES)[number];
export interface PlanetStore {
  get(seed: number, name: string): Promise<Uint8Array | null>;
  put(seed: number, name: string, bytes: Uint8Array): Promise<void>;
}
// A store in memory, for one process.
export const memoryStore = (): PlanetStore => {
  const m = new Map<string, Uint8Array>();
  return { get: async (s, n) => m.get(`${s}/${n}`) ?? null, put: async (s, n, b) => { m.set(`${s}/${n}`, b); } };
};

// A record of named typed arrays and a JSON head, as bytes: [head length u32][head JSON][arrays, 4-byte aligned].
type Arr = Float32Array | Uint32Array | Int32Array;
export function packRecord(meta: Record<string, unknown>, arrays: Record<string, Arr>): Uint8Array {
  const names = Object.keys(arrays), head = JSON.stringify({ meta, arrays: names.map((n) => [n, arrays[n].constructor.name, arrays[n].length]) });
  const hb = new TextEncoder().encode(head), pad = (4 - ((4 + hb.length) % 4)) % 4;
  let size = 4 + hb.length + pad;
  for (const n of names) size += arrays[n].byteLength;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, hb.length, true);
  out.set(hb, 4);
  let at = 4 + hb.length + pad;
  for (const n of names) { out.set(new Uint8Array(arrays[n].buffer, arrays[n].byteOffset, arrays[n].byteLength), at); at += arrays[n].byteLength; }
  return out;
}
export function unpackRecord(bytes: Uint8Array): { meta: Record<string, any>; arrays: Record<string, Arr> } {
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as { meta: Record<string, any>; arrays: [string, string, number][] };
  const Kinds: Record<string, { new (b: ArrayBuffer): Arr }> = { Float32Array, Uint32Array, Int32Array };
  let at = 4 + len + ((4 - ((4 + len) % 4)) % 4);
  const arrays: Record<string, Arr> = {};
  for (const [n, kind, count] of head.arrays) {
    const b = bytes.slice(at, at + count * 4);
    arrays[n] = new Kinds[kind](b.buffer);
    at += count * 4;
  }
  return { meta: head.meta, arrays };
}

// The atmosphere's four seasons on a height field; its 2 day window is halved where the rain passes its accumulator, as the
// erosion unit's script does (the rain is scaled to the season by the window's length, so a shorter one is a snapshot of the same state).
async function climateOf(gpu: Gpu, height: Float32Array): Promise<GlobeClimate> {
  for (let windowDays = 2; ; windowDays /= 2) {
    try { return await climateGpu(gpu, tierGrid(0), height, { seaLevel: 0 }, { windowDays }); }
    catch (e) { if (windowDays <= 0.25 || !String(e).includes("accumulator")) throw e; }
  }
}
const annualRain = async (gpu: Gpu, height: Float32Array) => {
  const c = await climateOf(gpu, height), out = new Float32Array(height.length);
  for (const s of c.seasons) for (let i = 0; i < out.length; i++) out[i] += s.rain[i];
  return out;
};

async function chainStage(gpu: Gpu, seed: number): Promise<Uint8Array> {
  const set = makeSetup({ seed, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0 }), ext = extTables(set.grid);
  const res = await runChain(gpu, set, { rain: (h) => annualRain(gpu, h), rainEveryMy: CHAIN.rainEveryMy, substeps: CHAIN.substeps, afterMy: CHAIN.afterMy });
  const d = derive(set, ext.tab, res.S), arrays: Record<string, Arr> = { height: d.height, to: res.flow.to, acc: res.flow.acc };
  d.pools.forEach((p, k) => { arrays[`pool${k}`] = p; });
  return packRecord({ seconds: res.seconds }, arrays);
}
function climateRecord(c: GlobeClimate): Uint8Array {
  const arrays: Record<string, Arr> = {};
  c.seasons.forEach((s, k) => {
    arrays[`t${k}`] = s.seaLevelTemperature; arrays[`rain${k}`] = s.rain; arrays[`snow${k}`] = s.snow; arrays[`runoff${k}`] = s.runoff;
    arrays[`windE${k}`] = s.windE; arrays[`windN${k}`] = s.windN; arrays[`sst${k}`] = s.sst;
  });
  return packRecord({}, arrays);
}

// The ice's volume field as thickness in m on each cell (v * 16 / the cell's area weight).
const thickness = (v: Int32Array, aw: Int32Array) => Float32Array.from(v, (x, i) => (x * 16) / aw[i]);

// The ice cycle, resumed from the part kept: runs outer steps until `budgetS` seconds have passed or the cycle is done, and keeps
// its state. Returns whether the cycle is done.
async function iceStage(gpu: Gpu, seed: number, store: PlanetStore, budgetS: number): Promise<boolean> {
  const chain = unpackRecord((await store.get(seed, "chain"))!), clim = unpackRecord((await store.get(seed, "climate0"))!);
  const g = tierGrid(0), ext = extTables(g), N = FACES * g.fn * g.fn;
  const inp = { bed: chain.arrays.height as Float32Array, ts: [0, 1, 2, 3].map((k) => clim.arrays[`t${k}`]), precip: [0, 1, 2, 3].map((k) => clim.arrays[`rain${k}`]) };
  const ice = new IceGpu(gpu, ext.tab, inp, defaultLaw());
  try {
    const o = orbitOf(seed), f = lgmForcing(o, ICE_CYCLE.cycleYr, ICE_CYCLE.outerYr);
    const part = await store.get(seed, "ice-part");
    let t = 0, maxKm3 = -1, lowM = 0, maxIce: Int32Array = new Int32Array(N);
    if (part) {
      const p = unpackRecord(part);
      ice.writeState(p.arrays.state as Int32Array);
      ice.seaM = p.meta.seaM; ice.dtYr = p.meta.dtYr; t = p.meta.tYr; maxKm3 = p.meta.maxKm3; lowM = p.meta.lowM; maxIce = p.arrays.maxIce as Int32Array;
    }
    const offset = (u: number) => (u < ICE_CYCLE.spinYr || u >= ICE_CYCLE.spinYr + ICE_CYCLE.cycleYr ? 0 : forcingTable(o, u - ICE_CYCLE.spinYr, f));
    const t0 = performance.now();
    while (t < ICE_YEARS - 1e-9 && (performance.now() - t0) / 1000 < budgetS) {
      const span = Math.min(ICE_CYCLE.outerYr * 20, ICE_YEARS - t), from = t;
      await runIce(ice, {
        years: span, outerYr: ICE_CYCLE.outerYr, dtMin: ICE_CYCLE.dtMin, offset: (u) => offset(from + u),
        onOuter: async (r) => {
          if (r.iceKm3 > maxKm3) { maxKm3 = r.iceKm3; maxIce = await ice.read(IF.ICE); }
          lowM = Math.min(lowM, r.seaM);
        },
      });
      t += span;
    }
    const done = t >= ICE_YEARS - 1e-9;
    if (!done) {
      await store.put(seed, "ice-part", packRecord({ tYr: t, seaM: ice.seaM, dtYr: ice.dtYr, maxKm3, lowM }, { state: await ice.readState(), maxIce }));
      return false;
    }
    const [bed, rck, sed, now] = await Promise.all([IF.BED, IF.RCK, IF.SED, IF.ICE].map((k) => ice.read(k)));
    const sea = await seaState(ice, ice.seaM);
    const cutM = thickness(rck, ice.aw), laidM = thickness(sed, ice.aw), after = Float32Array.from(bed, (b, i) => b / 64 - cutM[i] + laidM[i]);
    await store.put(seed, "ice", packRecord({ maxKm3, lowM, nowM: sea.seaM }, { after, cutM, laidM, maxM: thickness(maxIce, ice.aw), nowIceM: thickness(now, ice.aw) }));
    return true;
  } finally {
    ice.release();
  }
}

// Runs one stage of a seed's planet (each stage needs the ones before it kept); the ice stage may stop at `budgetS` and be
// called again. Returns whether the stage is now kept.
export async function buildStage(gpu: Gpu, seed: number, stage: Stage, store: PlanetStore, budgetS = Infinity): Promise<boolean> {
  if (await store.get(seed, stage)) return true;
  if (stage === "chain") { await store.put(seed, "chain", await chainStage(gpu, seed)); return true; }
  if (stage === "climate0") {
    const chain = unpackRecord((await store.get(seed, "chain"))!);
    await store.put(seed, "climate0", climateRecord(await climateOf(gpu, chain.arrays.height as Float32Array)));
    return true;
  }
  if (stage === "ice") return iceStage(gpu, seed, store, budgetS);
  const ice = unpackRecord((await store.get(seed, "ice"))!), now = ice.meta.nowM as number;
  const height = Float32Array.from(ice.arrays.after, (h) => h - now);
  await store.put(seed, "climate1", climateRecord(await climateOf(gpu, height)));
  return true;
}

// The planet of a seed: every stage not kept is run (the whole chain takes some 6 to 8 minutes on the M3 Pro), then the fields
// are read from the store. A seed's planet is kept in memory for the process.
const planets = new Map<number, Promise<Planet>>();
export function planetOf(gpu: Gpu, seed: number, store: PlanetStore = memoryStore()): Promise<Planet> {
  let p = planets.get(seed);
  if (!p) {
    p = (async () => {
      for (const s of STAGES) while (!(await buildStage(gpu, seed, s, store)));
      return readPlanet(seed, store);
    })();
    planets.set(seed, p);
    p.catch(() => planets.delete(seed));
  }
  return p;
}
// The planet from the kept stages.
export async function readPlanet(seed: number, store: PlanetStore): Promise<Planet> {
  const get = async (n: string) => { const b = await store.get(seed, n); if (!b) throw new Error(`planet ${seed}: the ${n} stage is not kept`); return unpackRecord(b); };
  const [chain, ice, clim] = await Promise.all([get("chain"), get("ice"), get("climate1")]);
  const now = ice.meta.nowM as number, n = chain.arrays.height.length;
  const f32 = (r: { arrays: Record<string, Arr> }, k: string) => r.arrays[k] as Float32Array;
  return {
    seed, n,
    height: Float32Array.from(f32(ice, "after"), (h) => h - now),
    pools: [0, 1, 2, 3, 4].map((k) => f32(chain, `pool${k}`)),
    to: chain.arrays.to as Uint32Array, acc: chain.arrays.acc as Uint32Array,
    seasons: [0, 1, 2, 3].map((k) => ({ t: f32(clim, `t${k}`), rain: f32(clim, `rain${k}`), snow: f32(clim, `snow${k}`), runoff: f32(clim, `runoff${k}`), windE: f32(clim, `windE${k}`), windN: f32(clim, `windN${k}`), sst: f32(clim, `sst${k}`) })),
    ice: { maxM: f32(ice, "maxM"), nowM: f32(ice, "nowIceM"), cutM: f32(ice, "cutM"), laidM: f32(ice, "laidM") },
    sea: { lowM: ice.meta.lowM as number, nowM: now },
  };
}
// The discharge area a cell of the planet gathers, m2 at the reference rain (erosion.ts accToM2).
export const dischargeM2 = (acc: number) => (acc * meanAreaM2(tierGrid(0))) / 512;

// ---------- where a window sits: a local plane on the sphere ----------
const DEG = Math.PI / 180;
// The window's side, m: the island grid's (terrain/grid.ts N cells of CELL m).
export const WINDOW_M = N * CELL;
// The tangent plane at the window's centre: x east, y north in m; a point of the plane goes to the sphere by the gnomonic map
// (19.2 km on a radius of 2,000 km is 4.8 milliradians of arc: the map's stretch over it is under 6e-6) [derived].
export interface Frame { c: V3; e: V3; n: V3; latDeg: number; lonDeg: number }
export function frameAt(latDeg: number, lonDeg: number): Frame {
  const c = fromLatLon(latDeg * DEG, lonDeg * DEG), [e, n] = eastNorth(c);
  return { c, e, n, latDeg, lonDeg };
}
const onSphere = (f: Frame, x: number, y: number): V3 => {
  const p = [f.c[0] + (x * f.e[0] + y * f.n[0]) / RADIUS_M, f.c[1] + (x * f.e[1] + y * f.n[1]) / RADIUS_M, f.c[2] + (x * f.e[2] + y * f.n[2]) / RADIUS_M], r = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / r, p[1] / r, p[2] / r];
};
// A point of the sphere (unit vector) on the plane, m east and north.
const onPlane = (f: Frame, p: ArrayLike<number>): [number, number] => {
  const d = p[0] * f.c[0] + p[1] * f.c[1] + p[2] * f.c[2];
  return [(RADIUS_M * (p[0] * f.e[0] + p[1] * f.e[1] + p[2] * f.e[2])) / d, (RADIUS_M * (p[0] * f.n[0] + p[1] * f.n[1] + p[2] * f.n[2])) / d];
};
const g0 = () => tierGrid(0);
const coarseAt = (p: V3) => { const g = g0(), q = locateVec(g, p); return cellId(g, q.face, q.X, q.Y); };
// The side of a square of a tier-0 cell's area, m (12.3 km at a face's centre, 8.7 km at its corners).
const coarseSide = (cell: number) => { const g = g0(), X = cell % g.fn, Y = Math.floor(cell / g.fn) % g.fn; return Math.sqrt(areaSr(g, X, Y)) * RADIUS_M; };
const vec = (i: number): V3 => { const v = cellVectors(g0()); return [v[3 * i], v[3 * i + 1], v[3 * i + 2]]; };
// The tier-0 cells round a cell, `steps` neighbour steps out (four neighbours a step, across tile and face edges).
function around(cell: number, steps: number): number[] {
  const nb = neighbours(g0()), seen = new Set([cell]);
  let ring = [cell];
  for (let s = 0; s < steps; s++) {
    const next: number[] = [];
    for (const c of ring) for (let d = 0; d < 4; d++) { const k = nb[4 * c + d]; if (!seen.has(k)) { seen.add(k); next.push(k); } }
    ring = next;
  }
  return [...seen];
}
// The tier-0 cells a window centred at `f` overlaps: those within half the window and half a cell of its centre along both axes [design: the cells' squares taken as aligned with the window's].
function reachOf(f: Frame, cell: number): number[] {
  const half = WINDOW_M / 2 + coarseSide(cell) / 2;
  return around(cell, 3).filter((k) => { const [x, y] = onPlane(f, vec(k)); return Math.abs(x) < half && Math.abs(y) < half; });
}

// ---------- the landings ----------
// A landing: a land cell of tier 0 where the window centred on it holds the sea, ground over RELIEF_M above it, a river whose
// mean flow now is at least RIVER_M3S (the present climate's runoff summed down the chain's receivers: upstreamOf) and a mean
// year of rain over its land of at least RAIN_MM, with no ice standing on it now (the island's stages have no glacier) [design:
// the operator's picture of mountains, valleys and rivers grading to a coast, put as five measures, R1705]. Landings are ranked by
// the highest ground the window holds, and no two lie within SPACING cells of each other.
export const LANDING = { reliefM: 1000, riverM3s: 5, rainMm: 500, spacing: 5 };
export interface Landing {
  cell: number; latDeg: number; lonDeg: number;
  summitM: number; seaShare: number; riverM3s: number; // over the window's reach: the highest ground, the share of its cells under the sea, the largest river's mean flow
  rainMm: number; tC: number; glaciated: boolean; // the mean year of rain over the reach's land, the centre's mean sea-level air, and whether ice stood in the reach at the glacial maximum
}
// How many land cells each measure let through, in order: the cells off the poles, then with sea, relief, a river, rain, no ice.
export const landingCounts: number[] = [];
export function landingsOf(planet: Planet, count = 10): Landing[] {
  const all: Landing[] = [], passed = [0, 0, 0, 0, 0, 0], basins = upstreamOf(planet);
  for (let i = 0; i < planet.n; i++) {
    if (planet.height[i] <= 0) continue;
    const v = vec(i), lat = Math.asin(v[2]) / DEG, lon = Math.atan2(v[1], v[0]) / DEG;
    if (Math.abs(lat) > 85) continue; // the plane's east is undefined at a pole
    passed[0]++;
    const reach = reachOf(frameAt(lat, lon), i);
    let summit = -Infinity, sea = 0, river = 0, iceNow = 0, iceMax = 0, rain = 0, landN = 0;
    for (const k of reach) {
      summit = Math.max(summit, planet.height[k]);
      iceNow = Math.max(iceNow, planet.ice.nowM[k]); iceMax = Math.max(iceMax, planet.ice.maxM[k]);
      if (planet.height[k] <= 0) { sea++; continue; }
      river = Math.max(river, (basins.runoff[0][k] + basins.runoff[1][k] + basins.runoff[2][k] + basins.runoff[3][k]) / YEAR_S);
      for (const s of planet.seasons) rain += s.rain[k];
      landN++;
    }
    rain /= landN;
    const ok = [sea > 0, summit >= LANDING.reliefM, river >= LANDING.riverM3s, rain >= LANDING.rainMm, iceNow === 0];
    let k = 0;
    while (k < ok.length && ok[k]) passed[++k]++;
    if (k < ok.length) continue;
    let t = 0;
    for (const s of planet.seasons) t += s.t[i] / SEASON_COUNT;
    all.push({ cell: i, latDeg: lat, lonDeg: lon, summitM: summit, seaShare: sea / reach.length, riverM3s: river, rainMm: rain, tC: t, glaciated: iceMax > 0 });
  }
  landingCounts.splice(0, landingCounts.length, ...passed);
  all.sort((a, b) => b.summitM - a.summitM || a.cell - b.cell);
  const out: Landing[] = [], taken = new Set<number>();
  for (const l of all) {
    if (out.length >= count) break;
    if (taken.has(l.cell)) continue;
    out.push(l);
    for (const k of around(l.cell, LANDING.spacing)) taken.add(k);
  }
  return out;
}

// ---------- the coarse fields on the window's cells: a conservative remap ----------
// Each window cell's centre, and a margin round the window, is located on tier 0 (the piecewise-constant field of the cells,
// which is exactly the cells' areas of overlap at 75 m), then smoothed by a box one coarse cell wide along x and along y
// (which carries a piecewise-constant field to the bilinear one between cell centres where the cells are aligned with the
// window [derived]), and shifted by one constant so that the window's mean is the overlap-weighted mean of the coarse cells it
// covers: the mean is kept to rounding [design: R1700].
export interface Remap {
  ids: Int32Array; m: number; pad: number; box: number; // the coarse cell of each sample of the padded grid (m x m), the margin and the box, samples
}
export function remapOf(f: Frame): Remap {
  const centre = coarseAt(f.c), box = 2 * Math.floor(coarseSide(centre) / CELL / 2) + 1, pad = (box - 1) / 2 + 1, m = N + 2 * pad, ids = new Int32Array(m * m);
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) ids[j * m + i] = coarseAt(onSphere(f, (i - pad + 0.5 - N / 2) * CELL, -(j - pad + 0.5 - N / 2) * CELL));
  return { ids, m, pad, box };
}
// The overlap-weighted mean of a coarse field over the window (the window's own cells of the padded grid).
export function coarseMean(r: Remap, field: ArrayLike<number>): number {
  let s = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) s += field[r.ids[(y + r.pad) * r.m + x + r.pad]];
  return s / LEN;
}
export function remap(r: Remap, field: ArrayLike<number>): Float32Array {
  const { m, pad, box } = r, h = (box - 1) / 2, a = new Float64Array(m * m), b = new Float64Array(m * N);
  for (let k = 0; k < m * m; k++) a[k] = field[r.ids[k]];
  // along x, then y: a running sum over the box
  for (let j = 0; j < m; j++) {
    let s = 0;
    for (let i = pad - h; i <= pad + h; i++) s += a[j * m + i];
    for (let x = 0; x < N; x++) { b[j * N + x] = s / box; s += a[j * m + pad + x + h + 1] - a[j * m + pad + x - h]; }
  }
  const out = new Float64Array(LEN);
  let mean = 0;
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let j = pad - h; j <= pad + h; j++) s += b[j * N + x];
    for (let y = 0; y < N; y++) { out[y * N + x] = s / box; mean += s / box; if (y + 1 < N) s += b[(pad + y + h + 1) * N + x] - b[(pad + y - h) * N + x]; }
  }
  const shift = coarseMean(r, field) - mean / LEN;
  return Float32Array.from(out, (v) => v + shift);
}
// The coarse field just beyond each edge cell of the window, smoothed as the remap smooths it (the box one coarse cell wide
// one cell out along the edge's outward normal; at a corner the lower of the two) and shifted as the remapped field at the
// edge cell is, NaN off the edge. `remapped` is remap(r, field).
export function beyondEdge(r: Remap, field: ArrayLike<number>, remapped: Float32Array): Float32Array {
  const { m, pad, box } = r, h = (box - 1) / 2, out = new Float32Array(LEN).fill(NaN);
  const boxMean = (x: number, y: number) => {
    let s = 0;
    for (let j = pad + y - h; j <= pad + y + h; j++) for (let i = pad + x - h; i <= pad + x + h; i++) s += field[r.ids[j * m + i]];
    return s / (box * box);
  };
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = Math.floor(i / N);
    if (x !== 0 && y !== 0 && x !== N - 1 && y !== N - 1) continue;
    let low = Infinity;
    if (x === 0) low = Math.min(low, boxMean(-1, y));
    if (x === N - 1) low = Math.min(low, boxMean(N, y));
    if (y === 0) low = Math.min(low, boxMean(x, -1));
    if (y === N - 1) low = Math.min(low, boxMean(x, N));
    out[i] = low + remapped[i] - boxMean(x, y);
  }
  return out;
}

// ---------- the window's parameters ----------
// The rock of the island's table each class of the planet's stands for (tectonics LITH order: basalt, sediment,
// metasediment, granitoid, volcanic): basalt and the arcs' volcanic rock as the island's dolerite, the one mafic igneous rock
// it has [analogue; the volcanic rock's erodibility on the planet is a hundred times granite's, the dolerite's is granite's:
// gap]; sediment as sandstone, the rock the planet's erosion takes it for (erosion.ts K_SANDSTONE, R1561) [analogue]; the
// metasediment and the granitoid as the island's granite and gneiss [analogue: the erosion unit's K of both] (R1701).
export const ROCK_OF = [DOLERITE, SANDSTONE, GRANITE, GRANITE, DOLERITE];
// The stack from the top, as the erosion unit removes it (erosion.ts removal: sediment, volcanic, metasediment, granitoid, basalt).
const STACK_ORDER = [1, 4, 2, 3, 0];
export const rockAtDepth = (pools: readonly number[], depth: number) => {
  let d = depth;
  for (const k of STACK_ORDER) { if (d < pools[k]) return ROCK_OF[k]; d -= Math.max(0, pools[k]); }
  return ROCK_OF[0];
};
// The uplift the first erosion runs under, m a year: one whose steady relief stays well inside the words (U / K of granite is
// 14 m, times chi under a hundred on the window) [design: the steady state is linear in the uplift, R1702].
export const PROBE_UPLIFT = 1e-6;
export const MEAN_TOLERANCE = 0.005, MEAN_RUNS = 4;
// The till's greatest thickness the hydrology's transmissivity word holds over the meltwater sand of a scoured valley, m:
// 2^32 / (4 2^13) m2 a year over the sand's 3,156 m a year less the granite's, about 40 m; 30 m is taken [design: a format's
// bound, R1703].
export const TILL_MOST_M = 30;

export interface WindowParams {
  upliftMYr: number; // the uplift the steady state was found under: the erosion's, so that the window's mean height is the planet's
  probeMeanM: number[]; // the land's mean height after each erosion run, m above the lowstand's sea, and the target last
  scourM: number; tillM: number; shiftM: number; // the joint valleys' greatest scour, the till's thickness, the present sea over the lowstand's
  rain: RainSeason[]; delays: Delays[]; place: ClimatePlace; angle: number;
  inflow: (Inflow & { areaKm2: number; x: number; y: number })[];
  openEdge: number; // the edge cells water and rock leave over to the planet's surface beyond (R1717)
}
export interface Window {
  seed: number; latDeg: number; lonDeg: number;
  isle: Island; sky: Sky; params: WindowParams;
  coarse: { heightM: number; rainMm: number[]; surface: Float32Array }; // the overlap-weighted means of the planet's height and each season's rain over the window, and its smooth surface (m)
}

// The window's root of each land cell's receiver chain: the height its base level holds, the sea's (0), the held outlet's or an
// open edge's base level beyond the edge (`edgeBase`, NaN off the open edge).
function bases(up: { height: Float32Array; to: Int32Array; land: Uint8Array }, edgeBase: Float32Array): Float64Array {
  const out = new Float64Array(LEN).fill(NaN), path: number[] = [];
  for (let i = 0; i < LEN; i++) {
    if (!up.land[i] || !Number.isNaN(out[i])) continue;
    let j = i, v = 0;
    for (;;) {
      if (!Number.isNaN(out[j])) { v = out[j]; break; }
      path.push(j);
      const k = up.to[j];
      if (k === j) { v = Number.isNaN(edgeBase[j]) ? up.height[j] : edgeBase[j]; break; }
      if (!up.land[k]) { v = 0; break; }
      j = k;
    }
    for (const p of path) out[p] = v;
    path.length = 0;
  }
  return out;
}
const landMean = (land: Uint8Array, f: (i: number) => number) => { let s = 0, n = 0; for (let i = 0; i < LEN; i++) if (land[i]) { s += f(i); n++; } return n ? s / n : 0; };
const edge = (i: number) => { const x = i % N, y = Math.floor(i / N); return x === 0 || y === 0 || x === N - 1 || y === N - 1; };
const WINDOW_STREAM = 0x77696e64; // "wind"

// The parameters (t entering, t leaving) along the segment from (ax, ay) to (bx, by) where it is inside the square of half side
// `half` round the origin, or null where it misses it (Liang and Barsky's clipping).
function clip(ax: number, ay: number, bx: number, by: number, half: number): [number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [p, q] of [[-dx, ax + half], [dx, half - ax], [-dy, ay + half], [dy, half - ay]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  return t0 <= t1 ? [t0, t1] : null;
}
// What each tier-0 cell's basin gathers now: the area (m2), the year's rain (m3) and each season's runoff (m3) of the cells that
// drain to it down the chain's receivers, itself included, in the present climate.
const basinSums = new WeakMap<Planet, { area: Float64Array; rain: Float64Array; runoff: Float64Array[] }>();
export function upstreamOf(planet: Planet) {
  let s = basinSums.get(planet);
  if (!s) {
    const n = planet.n, areas = cellAreas(g0()), R2 = RADIUS_M * RADIUS_M, area = new Float64Array(n), rain = new Float64Array(n), runoff = [0, 1, 2, 3].map(() => new Float64Array(n));
    const into = new Int32Array(n), queue = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      area[i] = areas[i] * R2;
      for (let k = 0; k < SEASON_COUNT; k++) { rain[i] += (planet.seasons[k].rain[i] / 1000) * area[i]; runoff[k][i] = (planet.seasons[k].runoff[i] / 1000) * area[i]; }
      if (planet.to[i] !== i) into[planet.to[i]]++;
    }
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (into[i] === 0) queue[tail++] = i;
    while (head < tail) {
      const i = queue[head++], j = planet.to[i];
      if (j === i) continue;
      area[j] += area[i]; rain[j] += rain[i];
      for (let k = 0; k < SEASON_COUNT; k++) runoff[k][j] += runoff[k][i];
      if (--into[j] === 0) queue[tail++] = j;
    }
    basinSums.set(planet, (s = { area, rain, runoff }));
  }
  return s;
}
// The window of a planet at a place: the coarse fields remapped, then the island's stages run under them. Erosion runs to the
// steady state of an uplift at the lowstand's sea, every step ending with the threshold hillslopes' landslides (R1714), the
// water leaving where the planet's rivers leave the window, into its sea and over the edge where the planet's surface falls away
// beyond it (R1717): a first run at a small uplift, whose steady state is the base levels' heights plus the uplift times a field
// the rock and the network set (R1702), gives the uplift that would hold the planet's mean height and the rock by depth below
// the planet's surface; up to MEAN_RUNS more correct the uplift where the landslides make the mean grow more slowly than it;
// then the whole run.
export async function windowOf(gpu: Gpu, planet: Planet, latDeg: number, lonDeg: number): Promise<Window> {
  const f = frameAt(latDeg, lonDeg), r = remapOf(f), centre = coarseAt(f.c);
  const surface = remap(r, planet.height), pools = planet.pools.map((p) => remap(r, p));
  const shiftM = Math.max(0, planet.sea.nowM - planet.sea.lowM);
  const mean = (field: ArrayLike<number>) => coarseMean(r, field);
  const rainMm = planet.seasons.map((s) => mean(s.rain)), yearMm = rainMm.reduce((a, b) => a + b, 0);
  // the ice: did it override the place at the glacial maximum, and what did it lay
  const iceMax = mean(planet.ice.maxM), laid = mean(planet.ice.laidM);
  const scourM = iceMax > 0 ? SCOUR : 0, tillM = iceMax > 0 ? Math.min(laid, TILL_MOST_M) : TILL_MAX;

  // the planet's rivers across the window's edge (R1707): a tier-0 cell outside it draining to one whose segment crosses into it brings
  // its basin's water in; the first segment of an inside cell's chain to leave it is where the window's water goes out
  const half = WINDOW_M / 2, inflow: WindowParams["inflow"] = [], basins = upstreamOf(planet), outletAt = new Set<number>();
  const inside = (k: number) => { const [x, y] = onPlane(f, vec(k)); return Math.abs(x) < half && Math.abs(y) < half; };
  const cellOf = (x: number, y: number) => Math.min(N - 1, Math.max(0, Math.floor(-y / CELL + N / 2))) * N + Math.min(N - 1, Math.max(0, Math.floor(x / CELL + N / 2)));
  const near = around(centre, 3);
  for (const a of near) {
    const b = planet.to[a];
    if (b === a || planet.height[a] <= 0 || inside(a)) continue;
    const [ax, ay] = onPlane(f, vec(a)), [bx, by] = onPlane(f, vec(b)), t = clip(ax, ay, bx, by, half);
    if (!t) continue;
    const at = cellOf(ax + t[0] * (bx - ax), ay + t[0] * (by - ay));
    if (surface[at] + shiftM <= 0 || basins.rain[a] <= 0) continue;
    // its water: the runoff of each season the planet's climate gives the basin, summed down the planet's receivers; and, as the
    // erosion's discharge goes with drainage area at the window's one rain, the area that sheds the basin's rain there [derived]
    const m3s = basins.runoff.map((v) => v[a] / SEASON_S_PLANET), cells = Math.round(basins.rain[a] / Math.max(1e-3, yearMm / 1000) / (CELL * CELL));
    inflow.push({ at, cells, m3s, areaKm2: basins.area[a] / 1e6, x: at % N, y: Math.floor(at / N) });
  }
  for (const a of near) {
    if (!inside(a)) continue;
    for (let p = a, guard = 0; guard < 64; guard++) {
      const q = planet.to[p];
      if (q === p) break;
      if (!inside(q)) {
        const [px, py] = onPlane(f, vec(p)), [qx, qy] = onPlane(f, vec(q)), t = clip(px, py, qx, qy, half);
        if (t) outletAt.add(cellOf(px + t[1] * (qx - px), py + t[1] * (qy - py)));
        break;
      }
      p = q;
    }
  }
  const inflowCells = new Float32Array(LEN);
  for (const v of inflow) inflowCells[v.at] += v.cells;

  // the erosion (R1706): at the lowstand's sea, water leaving by the outlets, the sea and the open edge, uniform uplift on the rest of the land
  const h0 = Float32Array.from(surface, (v) => v + shiftM), land = Uint8Array.from(h0, (v) => (v > 0 ? 1 : 0));
  const outlet = new Uint8Array(LEN);
  for (const k of outletAt) if (land[k]) outlet[k] = 1;
  // the open edge (R1717): where the planet's surface falls away beyond an edge cell, water and rock leave over it to a base
  // level at that surface (the sea's, where it lies under the lowstand's sea) [derived]; the rest of the edge is closed
  const beyond = beyondEdge(r, planet.height, surface);
  const edgeBase = Float32Array.from(beyond, (b, i) => (land[i] && !outlet[i] && b < surface[i] ? Math.max(0, b + shiftM) : NaN));
  if (!outlet.includes(1) && land.every((v) => v === 1) && edgeBase.every(Number.isNaN)) {
    // a window with no sea, no open edge and no planet's river leaving it: its lowest edge cell [design]
    let low = 0;
    for (let i = 0; i < LEN; i++) if (edge(i) && h0[i] < h0[low]) low = i;
    outlet[low] = 1;
  }
  const lift = Float32Array.from(land, (v, i) => (v && !outlet[i] ? 1 : 0));
  const key = philox([Math.round(latDeg * 1e6) >>> 0, Math.round(lonDeg * 1e6) >>> 0, 0, 0], [planet.seed >>> 0, WINDOW_STREAM]);
  const poolsAt = (i: number) => pools.map((p) => p[i]);
  const rockTop = Uint8Array.from({ length: LEN }, (_, i) => rockAtDepth(poolsAt(i), 0));
  const lay = (rock: Uint8Array, u: number): WindowLay => ({ height: h0, land, rock, lift, outlet, base: edgeBase, inflow: inflowCells, upliftMYr: u, scourM, tillM, shiftM, key: [key[0], key[1]] });
  const target = landMean(land, (i) => h0[i]), probe: number[] = [];
  const solve = async (rock: Uint8Array, u: number) => {
    const { up } = await windowUpstreamGpu(gpu, lay(rock, u), false), base = bases({ height: up.height, to: up.to, land }, edgeBase);
    const b = landMean(land, (i) => base[i]), g = landMean(land, (i) => up.height[i] - base[i]);
    probe.push(landMean(land, (i) => up.height[i]));
    return { up, base, u: g > 0 ? Math.max(0, (u * (target - b)) / g) : 0 };
  };
  const first = await solve(rockTop, PROBE_UPLIFT);
  const k1 = first.u / PROBE_UPLIFT;
  const rock = Uint8Array.from({ length: LEN }, (_, i) => rockAtDepth(poolsAt(i), Math.max(0, h0[i] - (first.base[i] + k1 * (first.up.height[i] - first.base[i])))));
  // with the rock so laid the network still moves with the uplift, and where the landslides hold the slopes the land's mean no
  // longer grows in proportion to it: the uplift is corrected, first in proportion, then by the secant through the last two runs
  // (the mean grows with the uplift), until the land's mean is the planet's to MEAN_TOLERANCE, at most MEAN_RUNS runs [design]
  let u = first.u, last: [number, number] | null = null;
  for (let run = 0; run < MEAN_RUNS; run++) {
    const next = await solve(rock, u), m = probe[probe.length - 1];
    if (Math.abs(m - target) <= MEAN_TOLERANCE * Math.max(1, target)) break;
    const secant = last && m !== last[1] ? u + ((target - m) * (u - last[0])) / (m - last[1]) : NaN;
    last = [u, m];
    u = secant > 0 ? secant : next.u;
  }
  const { up } = await windowUpstreamGpu(gpu, lay(rock, u), true);
  probe.push(target);

  // the climate: each season's air, sea and wind from the planet; what the planet does not give, Bornholm's (terrain/climate.ts SEASONS)
  const ts = planet.seasons.map((s) => mean(s.t));
  const seaCells = (field: ArrayLike<number>) => { let s = 0, n = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const k = r.ids[(y + r.pad) * r.m + x + r.pad]; if (planet.height[k] <= 0) { s += field[k]; n++; } } return n ? s / n : NaN; };
  const sst = planet.seasons.map((s, k) => { const v = seaCells(s.sst); return Number.isNaN(v) ? ts[k] : v; });
  const wind = planet.seasons.map((s) => [mean(s.windE), mean(s.windN)]);
  // the way the wind blows in the code's bearings (x east, y south)
  const way = (e: number, n: number) => Math.atan2(-n, e);
  const angle = way(wind.reduce((a, w) => a + w[0], 0), wind.reduce((a, w) => a + w[1], 0));
  const rain: RainSeason[] = SEASONS.map((s, k) => ({
    t: ts[k], mm: rainMm[k], rains: s.rains, rainWind: s.rainWind, rainHumid: s.rainHumid,
    rose: turned(WET_ROSE, way(wind[k][0], wind[k][1]) - meanWay(ROSE)),
  }));
  // the cloud delays from the season's freezing level, the air's sea-level warmth over the lapse rate, where the island took
  // the soundings' (rain.ts ICE_SHARE) [derived: R1320 eq. 10's weight e^(-z_f / H_w), R1704]
  const delays = ts.map((t) => cloudDelays(Math.exp(-Math.max(0, t) / LAPSE / H_W)));
  const rainShape = planet.seasons.map((s) => remap(r, s.rain));
  const scaleRain = (made: Float32Array[]) => made.map((k, s) => {
    let mk = 0;
    for (let i = 0; i < LEN; i++) mk += k[i];
    mk /= LEN;
    const out = Float32Array.from(rainShape[s], (c, i) => Math.max(0, mk > 0 ? (c * k[i]) / mk : c));
    let mo = 0;
    for (let i = 0; i < LEN; i++) mo += out[i];
    mo /= LEN;
    return mo > 0 ? Float32Array.from(out, (v) => (v * rainMm[s]) / mo) : out;
  });
  const place = (made: Float32Array[]): ClimatePlace => {
    let most = 0;
    for (let i = 0; i < LEN; i++) most = Math.max(most, made[0][i] + made[1][i] + made[2][i] + made[3][i]);
    return {
      seasons: SEASONS.map((s, k) => ({ t: ts[k], sea: sst[k], humid0: s.humid0, beam: s.beam, glow: s.glow })),
      latDeg, rose: ROSE, snowShift: Math.max(0, Math.ceil(Math.log2(most / 3000))),
    };
  };
  // the orographic rain is linear in the heights and the background (Smith and Barstad, R487), so a relief whose total passes the
  // transform's words is reckoned at a power of two of it, with its background, and the remap above undoes the scale [derived, R1708]
  const detail = Float32Array.from(up.height, (h, i) => Math.max(0, h) - Math.max(0, surface[i]));
  let total = 0;
  for (let i = 0; i < LEN; i++) total += Math.abs(detail[i]);
  const down = 2 ** Math.max(0, Math.ceil(Math.log2(total / (COARSE * COARSE * MOST_TOTAL_M) + 1e-12)));
  const rainZ = Float32Array.from(detail, (z) => z / down);
  const stages: WindowStages = { rainZ, rain: rain.map((s) => ({ ...s, mm: s.mm / down })), delays, scaleRain, place, angle, inflow: inflow.filter((v) => up.land[v.at]) };
  const isle = await generateWindow(gpu, up, stages);
  const params: WindowParams = {
    upliftMYr: u, probeMeanM: probe, scourM, tillM, shiftM, rain, delays, place: place(isle.seasons.map((s) => s.precip)), angle, inflow,
    openEdge: edgeBase.reduce((n, b) => n + (Number.isNaN(b) ? 0 : 1), 0),
  };
  return { seed: planet.seed, latDeg, lonDeg, isle, sky: skyAt(latDeg), params, coarse: { heightM: mean(planet.height), rainMm, surface } };
}
// The fields a window's identity is pinned by (its tests' and its script's hash): the heights, the rock, the drift, the rain, the
// temperature, the water, the flow, the cover and the soil, as their bytes.
export const windowBytes = (w: Window): Uint8Array[] => {
  const i = w.isle;
  return [i.height, i.rock, i.drift, i.driftDepth, i.precip, i.temp, i.water, i.flow, i.tree, i.shrub, i.grass, i.marsh, i.bare, i.soil].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
};
