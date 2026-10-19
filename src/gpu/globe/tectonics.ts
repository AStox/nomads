// Plate tectonics on the globe, host side: the plates and what the seed decides (seeds, Euler poles, rates, hot spots, the
// arcs' clocks), the starting planet, the kernels' driver (wgsl/globe-tectonics.ts) with the TypeScript twin of every kernel
// (checked bit for bit in tectonics.test.ts), and what is read off the result: height, thickness, rock, plates, boundary
// classes, land fraction, continents and ranges. The laws, constants and their sources: docs/research/globe/
// 2026-10-19-tectonics-impl.md (what was built, here) and 2026-10-19-tectonics.md (the research it follows).
//
// The model in a paragraph. The planet is the tier-0 cube-sphere grid; each cell is one parcel of one of a few rigid
// plates and holds five volumes of rock (basalt, sediment, metasediment, granitoid, volcanic). A step of a few My carries
// every parcel by its plate's rotation and shares its volumes among the four cells it lands nearest (cloud in cell: exact,
// conservative, a diffusion of 1/6 cell^2 a step in each axis when the shift is uniform in its fraction). Where plates part,
// the bare area becomes new basalt (a ridge); where they overlap, the plate that stands higher rides over, the other's
// basalt goes under (a trench) and its sediment and other rock are scraped on (a wedge, a terrane, a collision), the
// crust thickening by that sum. Arcs are added over the slab at their distance from the trench, hot spots under their
// fixed points, pelagic sediment on the sea floor; crust past the thickness limit flows sideways. Height is isostasy: a
// column's buoyancy against the mantle's, with the thermal buoyancy of young ocean floor.
import { type Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { divw, mul64 } from "../fixed";
import { next32, rinit } from "../rand";
import {
  EDGES, FACES, FRAMES, RADIUS_M, TAB, TILE_WORDS, areaSr, buildTables, cellId, centre, fieldWords, haloSource, inTile, slotOf, step, tierGrid, tileCount, wordAt,
  type Grid, type Tables, type V3,
} from "./grid";
import { ACCF, FLD, FLUX, NEXT, PHYS, tectonicsWgsl, type TectonicsLayout } from "../wgsl/globe-tectonics";

export { ACCF, FLD, FLUX, PHYS };

// ---------- 1. parameters ----------
export interface Params {
  seed: number;
  plates: number; // [design: about 10 for this small planet, plan Unit 2]
  spanMy: number; // [design: about 200 My, Cortial et al. 250 My to a realistic planet, R1410]
  stepMy: number; // [cited R1410: dt 2 My]
  seaLevel: number; // m above the reference level (the level 35 km of continental crust stands at); a parameter [plan Unit 2]
  continentShare: number; // share of the planet's area that starts as continental crust, margins included [analogue: 39% on Earth, R1411 app. B]
  hotspots: number; // [analogue: Earth has some 40; a planet a tenth of the area gets about 5]
  speedScale: number; // plate speeds as a share of the cited ones; 1 keeps Earth's, the default scales them by radius over Earth's (the research note's fallback: no source gives the scaling) [design, gap]
  radius: number; // m [design: the operator's decision of 2026-10-19]
}
export const DEFAULTS: Params = { seed: 1, plates: 10, spanMy: 200, stepMy: 2, seaLevel: 0, continentShare: 0.39, hotspots: 5, speedScale: RADIUS_M / 6_371_000, radius: RADIUS_M };

// Plate speed (the speed at 90 degrees from the pole), km a My = mm a year: drawn log-uniformly between the slowest and
// fastest spreading rates DeMets et al. measured, 9.7 and 154.4 mm/yr, cut at Cortial et al.'s cap of 100 mm/yr [cited
// R1412, R1410]; the shape of the distribution [design]. [gap] Earth's speeds are used as they are on a body a third of
// Earth's radius: no source gives the scaling (the research note's gap 1).
export const SPEED_LO_MM = 10, SPEED_HI_MM = 100;
// A hot spot's output, km3 a year: 0.01 to 0.1 [UNVERIFIED: Hawaii's order of 0.1 is remembered, not read], over a footprint of radius 100 km [UNVERIFIED].
export const HOT_FLUX_LO = 0.01, HOT_FLUX_HI = 0.1, HOT_RADIUS_KM = 100;
// Arc magmatism: a background of 14 km3 a My for each km of arc and flare-ups of 75 to 150 lasting 5 to 20 My every 30 to
// 70 My [cited R1415]; the clock's phase and the draw within those ranges are the seed's [design]; half the magma is new
// crust [cited R1415: a crustal half and a mantle half]; the arc 50 km wide [cited R1415]. [gap] the flux is a Cordilleran
// arc's, not derived from the slab (the research note's gap 3), and nothing delaminates (gap 4).
export const ARC = { bg: 14, flareLo: 75, flareHi: 150, periodLo: 30, periodHi: 70, lenLo: 5, lenHi: 20, newShare: 0.5, widthKm: 50 };
// Pelagic sediment on the sea floor: layer 1 is about 1 km on floor of mean age 100 My [cited R1411 sec. 1.1], so 10 m a My [derived].
export const PELAGIC_M_PER_MY = 10;
// The ocean floor's depth below the ridge: 2.5 km plus 0.355 km sqrt(age in My) [cited R1411 eq. 4.209, derived], capped at the plate model's old-age depth of 6.4 km [UNVERIFIED: remembered Parsons and Sclater].
export const RIDGE_DEPTH_M = 2500, DEPTH_COEF_M = 355, OLD_DEPTH_M = 6400;
// The oldest floor at the start: 200 My [UNVERIFIED: Earth's oldest sea floor, about 180 to 200 My, is remembered]; the clock of the last orogeny at the start, 200 My [design: none in the span before].
export const START_AGE_CAP_MY = 200, START_ORG_MY = 200;
// The start's continents: how the seed's blobs are laid, and the margin's taper in cells [design]: 30 km of crust at the coast rising to 40 km (the mean of Appendix B of R1411) four
// cells in; a platform cover of 2 km at the coast thinning to none 12 cells in [gap: no passive-margin law is read].
export const START = { coastKm: 30, coreKm: 40, taperCells: 4, coverM: 2000, coverCells: 12, bigCaps: 16, smallCaps: 48, boundaryGap: 6 };
// START.boundaryGap: a continent starts at least this many cells (about 75 km) from any plate boundary, so every continent is carried by one plate: a plate boundary through a continent at the start would be an
// arbitrary tear [design]; the boundaries that cross continents later are made by the plates' own motion.
// A boundary is a transform where the normal part of the relative velocity is under sin(20 degrees) of it [design].
export const TRANSFORM_SIN = Math.sin((20 * Math.PI) / 180);
// Land: a cell whose surface stands above sea level. A continent: land of at least 1% of the planet; a range: land over 2 km above sea level [design].
export const CONTINENT_MIN_SHARE = 0.01, RANGE_Z_M = 2000;

// Lithology classes, by origin.
export const LITH = { basalt: 0, sediment: 1, metasediment: 2, granitoid: 3, volcanic: 4 } as const;
export const LITH_NAMES = ["basalt", "sediment", "metasediment", "granitoid", "volcanic"] as const;
// The rock that shows at the surface: a cover of sediment or of volcanic rock if it is 1 km thick or more [design: a mappable cover; the pelagic sediment of the sea floor is at most 1 km], else the thickest of basalt, metasediment, granitoid.
export const COVER_MIN_M = 1000;

// ---------- 2. plates, hot spots, arcs: what the seed decides ----------
export interface Plate { seed: V3; pole: V3; speedMmYr: number; rate: number } // rate: rad a My
export interface Hotspot { dir: V3; fluxKm3Yr: number; radiusKm: number; peakM: number }

// Uniform draws in [0, 1) from the counter-based stream of (seed, stream, id): Philox, never Math.random.
function draws(seed: number, stream: number, id: number): () => number {
  rinit(seed, stream, id, 0);
  return () => next32() / 4294967296;
}
const sphere = (a: number, b: number): V3 => { const z = 2 * a - 1, l = 2 * Math.PI * b, r = Math.sqrt(1 - z * z); return [r * Math.cos(l), r * Math.sin(l), z]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crossV = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function makePlates(p: Params): Plate[] {
  const out: Plate[] = [];
  for (let i = 0; i < p.plates; i++) {
    const u = draws(p.seed, 1, i);
    const seed = sphere(u(), u()), pole = sphere(u(), u());
    const speedMmYr = SPEED_LO_MM * (SPEED_HI_MM / SPEED_LO_MM) ** u() * p.speedScale;
    // 1 mm a year is 1 km a My, so the rate is the speed over the radius in km
    out.push({ seed, pole, speedMmYr, rate: speedMmYr / (p.radius / 1000) });
  }
  return out;
}
export function makeHotspots(p: Params): Hotspot[] {
  const out: Hotspot[] = [];
  const area = Math.PI * HOT_RADIUS_KM ** 2 / 3; // km2: a cone's volume is a third of base times height
  for (let h = 0; h < p.hotspots; h++) {
    const u = draws(p.seed, 4, h);
    const dir = sphere(u(), u()), fluxKm3Yr = HOT_FLUX_LO * (HOT_FLUX_HI / HOT_FLUX_LO) ** u();
    out.push({ dir, fluxKm3Yr, radiusKm: HOT_RADIUS_KM, peakM: Math.min(25_000, Math.round((fluxKm3Yr * 1e6 * p.stepMy * 1000) / area)) });
  }
  return out;
}
// The net crust an arc adds a step to each cell of its band, m, per plate and step (0 to steps): half of the clock's flux
// over the arc's width.
export function makeArcs(p: Params, steps: number): Int32Array {
  const out = new Int32Array(p.plates * (steps + 1));
  for (let i = 0; i < p.plates; i++) {
    const u = draws(p.seed, 5, i);
    const period = ARC.periodLo + (ARC.periodHi - ARC.periodLo) * u(), len = ARC.lenLo + (ARC.lenHi - ARC.lenLo) * u(), phase = period * u(), flare = ARC.flareLo + (ARC.flareHi - ARC.flareLo) * u();
    for (let s = 0; s <= steps; s++) {
      const flux = ARC.bg + (((s * p.stepMy + phase) % period) < len ? flare : 0);
      out[i * (steps + 1) + s] = Math.round(((ARC.newShare * flux * p.stepMy) / ARC.widthKm) * 1000);
    }
  }
  return out;
}

// The rotation of one step about a pole, a 3 by 3 matrix row by row (Rodrigues' formula).
export function rotation(e: V3, angle: number): number[] {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, [x, y, z] = e;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}

// ---------- 3. the setup: everything the kernels read besides the fields ----------
export interface Sweeps { gap: number; smooth: number; dist: number; topple: number }
export interface Setup {
  params: Params;
  grid: Grid;
  plates: Plate[];
  hotspots: Hotspot[];
  steps: number;
  arcM: Int32Array;
  layout: TectonicsLayout;
  Q: Int32Array;
  // Sweeps of the relaxations that each step runs (all even, so the double buffers end where they began): the plate of bare cells
  // spreads from its neighbours, the plate map's smoothing, the trench distance, the flow of overthick crust [design: numerical convergence, not a law].
  sweeps: Sweeps;
}
export const DEFAULT_SWEEPS: Sweeps = { gap: 16, smooth: 2, dist: 16, topple: 32 };

// The ocean floor's thermal buoyancy by age (units of 0.5 My), kg/m2 per the isostasy in wgsl/globe-tectonics.ts: the
// reference column's buoyancy less what a floor of that depth takes (water against mantle) less the 6 km of basalt's own.
export function thermalTable(): Int32Array {
  const out = new Int32Array(PHYS.AGE_MAX + 1), phi0 = PHYS.H0 * (PHYS.RHO_M - 2800);
  for (let i = 0; i <= PHYS.AGE_MAX; i++) {
    const t = i * PHYS.AGE_UNIT_MY, depth = Math.min(RIDGE_DEPTH_M + DEPTH_COEF_M * Math.sqrt(t), OLD_DEPTH_M);
    out[i] = Math.round(phi0 - depth * (PHYS.RHO_M - PHYS.RHO_W) - PHYS.H_OC * (PHYS.RHO_M - PHYS.RHO[0]));
  }
  return out;
}

const Q30 = 2 ** 30;
// parts: plates, hot spots or arcs to use in place of the seed's (the tests stage a collision with plates of their own).
export function makeSetup(over: Partial<Params> = {}, sweeps: Sweeps = DEFAULT_SWEEPS, parts: { plates?: Plate[]; hotspots?: Hotspot[]; arcM?: Int32Array } = {}): Setup {
  const params = { ...DEFAULTS, ...over };
  const grid = tierGrid(0, params.radius), steps = Math.round(params.spanMy / params.stepMy);
  const plates = parts.plates ?? makePlates(params), hotspots = parts.hotspots ?? makeHotspots(params), arcM = parts.arcM ?? makeArcs({ ...params, plates: plates.length }, steps);
  const NP = plates.length, NH = hotspots.length, fn = grid.fn;
  const rot = 0, node = rot + NP * 9, phith = node + fn + 1, arc = phith + PHYS.AGE_MAX + 1, hot = arc + arcM.length, words = hot + NH * 6;
  const Q = new Int32Array(words);
  plates.forEach((pl, i) => rotation(pl.pole, pl.rate * params.stepMy).forEach((v, k) => { Q[rot + i * 9 + k] = Math.round(v * Q30); }));
  for (let i = 0; i <= fn; i++) Q[node + i] = Math.round(grid.node[i] * Q30);
  Q.set(thermalTable(), phith);
  Q.set(arcM, arc);
  hotspots.forEach((h, i) => {
    Q[hot + i * 6] = Math.round(h.dir[0] * Q30); Q[hot + i * 6 + 1] = Math.round(h.dir[1] * Q30); Q[hot + i * 6 + 2] = Math.round(h.dir[2] * Q30);
    Q[hot + i * 6 + 3] = Math.round(Math.cos((h.radiusKm * 1000) / params.radius) * Q30); Q[hot + i * 6 + 4] = h.peakM;
  });
  return { params, grid, plates, hotspots, steps, arcM, layout: { fn, plates: NP, hotspots: NH, steps, rot, node, phith, arc, hot, words }, Q, sweeps };
}

// The grid's tables with the cell centres (a unit vector in Q30, three fields) appended, which the kernels read.
const tables = new Map<number, { tab: Tables; T: Int32Array }>();
export function extTables(g: Grid): { tab: Tables; T: Int32Array } {
  const key = g.fn * 1e9 + g.radius;
  let t = tables.get(key);
  if (!t) {
    const tab = buildTables(g), tw = tab.tw, T = new Int32Array(tab.words.length + 3 * tw);
    T.set(tab.words);
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < g.fn; Y++)
        for (let X = 0; X < g.fn; X++) {
          const c = centre(g, f, X, Y), at = slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y);
          for (let k = 0; k < 3; k++) T[(TAB.COUNT + k) * tw + at] = Math.round(c[k] * Q30);
        }
    tables.set(key, (t = { tab, T }));
  }
  return t;
}

// ---------- 4. the grid as flat arrays, for the starting planet and the analyses ----------
// Cells are numbered cellId = (face * fn + Y) * fn + X; the four neighbours of a cell (east, north, west, south of its face).
const nbCache = new Map<Grid, Int32Array>(), vecCache = new Map<Grid, Float64Array>();
export function neighbours(g: Grid): Int32Array {
  let nb = nbCache.get(g);
  if (!nb) {
    nb = new Int32Array(4 * FACES * g.fn * g.fn);
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < g.fn; Y++)
        for (let X = 0; X < g.fn; X++) {
          const c = cellId(g, f, X, Y);
          for (let d = 0; d < 4; d++) { const s = step(g, f, X, Y, d); nb[4 * c + d] = cellId(g, s.face, s.X, s.Y); }
        }
    nbCache.set(g, nb);
  }
  return nb;
}
export function cellVectors(g: Grid): Float64Array {
  let v = vecCache.get(g);
  if (!v) {
    v = new Float64Array(3 * FACES * g.fn * g.fn);
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < g.fn; Y++)
        for (let X = 0; X < g.fn; X++) { const c = centre(g, f, X, Y), i = cellId(g, f, X, Y); v[3 * i] = c[0]; v[3 * i + 1] = c[1]; v[3 * i + 2] = c[2]; }
    vecCache.set(g, v);
  }
  return v;
}
// Each cell's area in steradians, flat.
export function cellAreas(g: Grid): Float64Array {
  const out = new Float64Array(FACES * g.fn * g.fn);
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) out[cellId(g, f, X, Y)] = areaSr(g, X, Y);
  return out;
}
const vecOf = (v: Float64Array, i: number): V3 => [v[3 * i], v[3 * i + 1], v[3 * i + 2]];
// The word of every cell in the padded layout, in flat order, and back.
export function padMap(g: Grid): Int32Array {
  const out = new Int32Array(FACES * g.fn * g.fn);
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) out[cellId(g, f, X, Y)] = wordAt(g, f, X, Y);
  return out;
}

// ---------- 5. boundaries by relative velocity ----------
export const BOUNDARY = { none: 0, convergent: 1, divergent: 2, transform: 3 } as const;
// The velocity of a plate at a point, km a My: rate * R (pole x point).
function velocity(pl: Plate, x: V3, radiusKm: number): V3 {
  const c = crossV(pl.pole, x);
  return [c[0] * pl.rate * radiusKm, c[1] * pl.rate * radiusKm, c[2] * pl.rate * radiusKm];
}
export interface Boundaries { cls: Uint8Array; speed: Float32Array } // per cell: the class of the strongest boundary with a neighbour, and the relative speed there, km a My
// Boundaries from relative velocity: a cell with a neighbour of another plate takes, from the neighbour with the largest
// normal part, the class of the relative velocity of the two plates at the midpoint resolved along the line between the
// cells: closing is convergent, opening divergent, and a normal part under TRANSFORM_SIN of the speed a transform.
export function classifyBoundaries(g: Grid, plate: ArrayLike<number>, plates: Plate[]): Boundaries {
  const N = FACES * g.fn * g.fn, nb = neighbours(g), vec = cellVectors(g), R = g.radius / 1000;
  const cls = new Uint8Array(N), speed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const pa = plate[i];
    if (pa >= plates.length) continue;
    let bestN = 0, bestC = 0, bestS = 0;
    const x = vecOf(vec, i);
    for (let d = 0; d < 4; d++) {
      const j = nb[4 * i + d], pb = plate[j];
      if (pb === pa || pb >= plates.length) continue;
      const y = vecOf(vec, j);
      const m: V3 = [x[0] + y[0], x[1] + y[1], x[2] + y[2]], mn = Math.hypot(...m), mm: V3 = [m[0] / mn, m[1] / mn, m[2] / mn];
      let n: V3 = [y[0] - x[0], y[1] - x[1], y[2] - x[2]];
      const nd = dot(n, mm);
      n = [n[0] - nd * mm[0], n[1] - nd * mm[1], n[2] - nd * mm[2]];
      const nl = Math.hypot(...n);
      n = [n[0] / nl, n[1] / nl, n[2] / nl];
      const va = velocity(plates[pa], mm, R), vb = velocity(plates[pb], mm, R), rel: V3 = [vb[0] - va[0], vb[1] - va[1], vb[2] - va[2]];
      const normal = dot(rel, n), s = Math.hypot(...rel);
      if (Math.abs(normal) >= bestN) { bestN = Math.abs(normal); bestC = Math.abs(normal) < TRANSFORM_SIN * s ? BOUNDARY.transform : normal < 0 ? BOUNDARY.convergent : BOUNDARY.divergent; bestS = s; }
    }
    cls[i] = bestC; speed[i] = bestS;
  }
  return { cls, speed };
}

// ---------- 6. the starting planet ----------
// Multi-source breadth-first search over the four-neighbour graph: for each cell the number of steps to the nearest source
// and which it is.
function bfs(g: Grid, sources: Iterable<number>, allowed?: (i: number) => boolean) {
  const N = FACES * g.fn * g.fn, nb = neighbours(g), dist = new Int32Array(N).fill(-1), from = new Int32Array(N).fill(-1);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  for (const s of sources) { dist[s] = 0; from[s] = s; queue[tail++] = s; }
  while (head < tail) {
    const i = queue[head++];
    for (let d = 0; d < 4; d++) {
      const j = nb[4 * i + d];
      if (dist[j] >= 0 || (allowed && !allowed(j))) continue;
      dist[j] = dist[i] + 1; from[j] = from[i]; queue[tail++] = j;
    }
  }
  return { dist, from };
}

// A column of rock, thicknesses in m: what a cell holds. ageMy is the basalt's age; orogenyMy the time since the column last grew.
export interface Column { basalt?: number; sediment?: number; metasediment?: number; granitoid?: number; volcanic?: number; ageMy?: number; orogenyMy?: number; plate: number }
// The state (every field in the padded layout) of a planet whose cell i (flat order) holds column(i).
export function stateFrom(set: Setup, tab: Tables, column: (i: number) => Column): Int32Array {
  const g = set.grid, fw = fieldWords(g), S = new Int32Array(FLD.COUNT * fw);
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) {
        const i = cellId(g, f, X, Y), at = wordAt(g, f, X, Y), a = tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)], c = column(i);
        const v = [c.basalt ?? 0, c.sediment ?? 0, c.metasediment ?? 0, c.granitoid ?? 0, c.volcanic ?? 0].map((h) => Math.floor((Math.max(0, h) * a) / 16));
        v.forEach((x, k) => { S[(FLD.VB + k) * fw + at] = x; });
        S[FLD.AGB * fw + at] = (v[0] >> PHYS.AGE_SHIFT) * Math.round((c.ageMy ?? 0) / PHYS.AGE_UNIT_MY);
        S[FLD.ORG * fw + at] = ((v[0] + v[1] + v[2] + v[3] + v[4]) >> PHYS.AGE_SHIFT) * Math.round((c.orogenyMy ?? START_ORG_MY) / PHYS.AGE_UNIT_MY);
        S[FLD.PL * fw + at] = c.plate;
      }
  return S;
}

export interface Start {
  S: Int32Array; // every field of the state in the padded layout (FLD.COUNT fields)
  plate: Uint8Array; // flat
  continental: Uint8Array; // flat, 1 where the planet starts with continental crust
  field: Float64Array; // the seed's blob field the continents are cut from
}
// The planet at time zero from the seed: the plates' Voronoi cells by great-circle distance to the seeds; continents where
// a seed-drawn field of blobs is highest, cut so that they cover the share asked for; a continental column that thickens
// from the coast inward; ocean floor aged by its distance from the nearest divergent boundary at the plates' half spreading
// rate there; pelagic sediment from that age.
export function startingState(set: Setup, tab: Tables): Start {
  const g = set.grid, N = FACES * g.fn * g.fn, vec = cellVectors(g), areas = cellAreas(g), p = set.params, radiusKm = g.radius / 1000;
  const plate = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const x = vecOf(vec, i);
    let best = -2, bp = 0;
    set.plates.forEach((pl, k) => { const d = dot(x, pl.seed); if (d > best) { best = d; bp = k; } });
    plate[i] = bp;
  }
  // continents: blobs of Gaussian profile in the angle to their centres
  const caps: { c: V3; sigma: number; amp: number }[] = [];
  for (let k = 0; k < START.bigCaps + START.smallCaps; k++) {
    const u = draws(p.seed, 2, k), big = k < START.bigCaps;
    const c = sphere(u(), u()), lo = big ? 12 : 3, hi = big ? 35 : 8, sigma = ((lo * (hi / lo) ** u()) * Math.PI) / 180, amp = (big ? 1 : 0.35) * (2 * u() - 1);
    caps.push({ c, sigma, amp });
  }
  const field = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = vecOf(vec, i);
    let s = 0;
    for (const cp of caps) { const a = Math.acos(Math.max(-1, Math.min(1, dot(x, cp.c)))) / cp.sigma; s += cp.amp * Math.exp(-a * a); }
    field[i] = s;
  }
  const nb = neighbours(g);
  const edge: number[] = [];
  for (let i = 0; i < N; i++) if ([0, 1, 2, 3].some((d) => plate[nb[4 * i + d]] !== plate[i])) edge.push(i);
  const fromEdge = bfs(g, edge).dist;
  const order = Array.from({ length: N }, (_, i) => i).filter((i) => fromEdge[i] >= START.boundaryGap).sort((a, b) => field[b] - field[a] || a - b);
  const continental = new Uint8Array(N);
  let acc = 0;
  for (const i of order) { if (acc >= p.continentShare * 4 * Math.PI) break; continental[i] = 1; acc += areas[i]; }
  // distance inland from the coast, in cells
  const coast: number[] = [];
  for (let i = 0; i < N; i++) if (continental[i] && [0, 1, 2, 3].some((d) => !continental[nb[4 * i + d]])) coast.push(i);
  const inland = bfs(g, coast, (i) => continental[i] === 1).dist;
  // sea floor age from the nearest divergent boundary
  const bd = classifyBoundaries(g, plate, set.plates), ridges: number[] = [];
  for (let i = 0; i < N; i++) if (bd.cls[i] === BOUNDARY.divergent) ridges.push(i);
  const near = bfs(g, ridges);
  const ageMy = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (continental[i]) continue;
    const r = near.from[i];
    if (r < 0) { ageMy[i] = 100; continue; } // no ridge on the planet: the mean age of Earth's floor, 100 My [cited R1411 sec. 1.1]
    const ang = 2 * Math.asin(Math.min(1, Math.hypot(vec[3 * i] - vec[3 * r], vec[3 * i + 1] - vec[3 * r + 1], vec[3 * i + 2] - vec[3 * r + 2]) / 2));
    ageMy[i] = Math.min(START_AGE_CAP_MY, (ang * radiusKm) / Math.max(bd.speed[r] / 2, 1));
  }
  const S = stateFrom(set, tab, (i) => {
    if (continental[i]) {
      const d = inland[i], taper = Math.min(1, d / START.taperCells), h = (START.coastKm + (START.coreKm - START.coastKm) * taper) * 1000, cover = START.coverM * (1 - Math.min(1, d / START.coverCells));
      return { sediment: cover, granitoid: h - cover, plate: plate[i] };
    }
    return { basalt: PHYS.H_OC, sediment: Math.min(1000, PELAGIC_M_PER_MY * ageMy[i]), ageMy: ageMy[i], plate: plate[i] };
  });
  return { S, plate, continental, field };
}

// ---------- 7. the twin: every kernel in TypeScript ----------
interface Cell { face: number; X: number; Y: number }
const shrBig = (x: bigint, n: bigint) => (x < 0n ? -((-x + (1n << (n - 1n))) >> n) : (x + (1n << (n - 1n))) >> n);

export class Twin {
  readonly S: Int32Array;
  readonly A: Uint32Array;
  readonly g: Grid;
  readonly fw: number;
  readonly tw: number;
  readonly flux: bigint[] = Array.from({ length: FLUX.COUNT }, () => 0n);
  private readonly T: Int32Array;
  private readonly Q: Int32Array;
  constructor(readonly set: Setup, ext: { tab: Tables; T: Int32Array }, start: Int32Array) {
    this.g = set.grid; this.fw = fieldWords(this.g); this.tw = ext.tab.tw; this.T = ext.T; this.Q = set.Q;
    this.S = start.slice();
    this.A = new Uint32Array(ACCF.COUNT * this.fw);
  }
  private at(f: number, c: Cell) { return f * this.fw + wordAt(this.g, c.face, c.X, c.Y); }
  rs(f: number, c: Cell) { return this.S[this.at(f, c)] >>> 0; }
  ws(f: number, c: Cell, v: number) { this.S[this.at(f, c)] = v | 0; }
  private area(c: Cell) { return this.T[slotOf(this.g, c.face, c.X, c.Y) * TILE_WORDS + inTile(c.X, c.Y)]; }
  private cell(idx: number): Cell {
    const g = this.g, T = g.tiles, slot = Math.floor(idx / 65536), c = idx % 65536, face = Math.floor(slot / (T * T)), rem = slot % (T * T);
    return { face, X: (rem % T) * 256 + (c & 255), Y: Math.floor(rem / T) * 256 + (c >> 8) };
  }
  private cells(): number { return tileCount(this.g) * 65536; }
  // The neighbour in direction d (0 east, 1 north, 2 west, 3 south) and the quarter turns of the axes there.
  private nbr(c: Cell, d: number) {
    const dx = d === 0 ? 1 : d === 2 ? -1 : 0, dy = d === 1 ? 1 : d === 3 ? -1 : 0, s = haloSource(this.g, c.face, c.X + dx, c.Y + dy)!;
    return { cell: { face: s.face, X: s.X, Y: s.Y } as Cell, rot: s.turn };
  }
  private vtot(f: number, c: Cell) { let s = 0; for (let k = 0; k < 5; k++) s = (s + this.rs(f + k, c)) >>> 0; return s; }

  thick(v: number, a: number) { return Math.floor(v / a) * 16 + Math.floor(((v % a) * 16) / a); }
  elevOf(vb: number, vs: number, vm: number, vg: number, vv: number, agb: number, a: number): number {
    const hb = this.thick(vb, a), R = PHYS.RHO.map((r) => PHYS.RHO_M - r);
    const phi = hb * R[0] + this.thick(vs, a) * R[1] + this.thick(vm, a) * R[2] + this.thick(vg, a) * R[3] + this.thick(vv, a) * R[4];
    const nb = vb >>> PHYS.AGE_SHIFT, age = nb > 0 ? Math.min(Math.floor(agb / nb), PHYS.AGE_MAX) : 0;
    const pr = mul64(this.Q[this.set.layout.phith + age] >>> 0, Math.min(hb, PHYS.H_OC)), th = divw(pr[1], pr[0], PHYS.H_OC)[0];
    const d = phi + th - PHYS.H0 * (PHYS.RHO_M - 2800);
    return Math.trunc(d / (d < 0 ? PHYS.RHO_M - PHYS.RHO_W : PHYS.RHO_M));
  }
  elev() {
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), a = this.area(c);
      this.ws(FLD.Z, c, this.elevOf(this.rs(FLD.VB, c), this.rs(FLD.VB + 1, c), this.rs(FLD.VB + 2, c), this.rs(FLD.VB + 3, c), this.rs(FLD.VB + 4, c), this.rs(FLD.AGB, c), a));
    }
  }

  // Where the parcel of cell c on plate p lands: four cells and weights (Q16, summing to 2^16).
  stencil(idx: number, c: Cell, p: number): { w: number[]; c: Cell[] } {
    const L = this.set.layout, Q = this.Q, cn = this.tw;
    const v = [0, 1, 2].map((k) => BigInt(this.T[(TAB.COUNT + k) * cn + idx]));
    const r = [0, 1, 2].map((row) => Number(shrBig(BigInt(Q[L.rot + p * 9 + row * 3]) * v[0] + BigInt(Q[L.rot + p * 9 + row * 3 + 1]) * v[1] + BigInt(Q[L.rot + p * 9 + row * 3 + 2]) * v[2], 30n)));
    const dd = [r[0], r[1], -r[0], -r[1], r[2], -r[2]];
    let face = 0, best = dd[0];
    for (let f = 1; f < 6; f++) if (dd[f] > best) { best = dd[f]; face = f; }
    const w = Math.max(best, 1), axis = (u: readonly number[]) => u.findIndex((x) => x !== 0), sgn = (u: readonly number[]) => u[axis(u)];
    const fr = FRAMES[face];
    const ua = sgn(fr.ex) * r[axis(fr.ex)], vb = sgn(fr.ey) * r[axis(fr.ey)];
    const ratio = (num: number) => {
      const m = Math.abs(num);
      let q = divw(Math.min(m >>> 2, w - 1), (m << 30) >>> 0, w)[0];
      q = Math.min(q, 0x3fffffff);
      return num < 0 ? -q : q;
    };
    const rx = ratio(ua), ry = ratio(vb);
    const bits = Math.round(Math.log2(L.fn)), find = (rho: number) => {
      let lo = 0, hi = L.fn;
      for (let i = 0; i < bits; i++) { const mid = (lo + hi) >> 1; if (Q[L.node + mid] <= rho) lo = mid; else hi = mid; }
      return lo;
    };
    const X = find(rx), Y = find(ry);
    const frac = (k: number, rho: number) => {
      const diff = rho - Q[L.node + k], width = Q[L.node + k + 1] - Q[L.node + k];
      return divw(Math.min(diff >>> 16, width - 1), (diff << 16) >>> 0, width)[0];
    };
    const fx = frac(X, rx), fy = frac(Y, ry);
    let nx = X + 1, wxn = fx - 32768, wxo = 65536 - (fx - 32768);
    if (fx < 32768) { nx = X - 1; wxn = 32768 - fx; wxo = 32768 + fx; }
    let ny = Y + 1, wyn = fy - 32768, wyo = 65536 - (fy - 32768);
    if (fy < 32768) { ny = Y - 1; wyn = 32768 - fy; wyo = 32768 + fy; }
    const own: Cell = { face, X, Y }, pick = (xx: number, yy: number): Cell => { const s = haloSource(this.g, face, xx, yy); return s ? { face: s.face, X: s.X, Y: s.Y } : own; };
    const w1 = Math.floor((wxn * wyo) / 65536), w2 = Math.floor((wxo * wyn) / 65536), w3 = Math.floor((wxn * wyn) / 65536);
    return { w: [65536 - w1 - w2 - w3, w1, w2, w3], c: [own, pick(nx, Y), pick(X, ny), pick(nx, ny)] };
  }
  private accAt(f: number, c: Cell) { return f * this.fw + wordAt(this.g, c.face, c.X, c.Y); }
  claim() {
    const A = this.A;
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx);
      if (this.vtot(FLD.VB, c) === 0) continue;
      const p = this.rs(FLD.PL, c);
      if (p >= this.set.layout.plates) continue;
      const a = this.area(c), rank = Math.min(Math.max(this.S[this.at(FLD.Z, c)] + PHYS.RANK_BIAS, 0), 65534) + 1;
      const { w, c: hc } = this.stencil(idx, c, p);
      for (let k = 0; k < 4; k++) {
        if (w[k] === 0) continue;
        const cv = (a * w[k] + 32768) >>> 16, d = hc[k];
        A[this.accAt(ACCF.COV, d)] += cv;
        if (cv >= PHYS.RANK_MIN) { const kr = this.accAt(ACCF.KR, d); A[kr] = Math.max(A[kr], ((rank << 8) | p) >>> 0); }
        if (cv >= PHYS.CLAIM_MIN) { const kc = this.accAt(ACCF.KC, d); A[kc] = Math.max(A[kc], ((cv << 8) | p) >>> 0); }
      }
    }
  }
  winnerOf(d: Cell, ad: number, cov: number): number {
    const over = cov * 16 > ad * PHYS.OVER_NUM, key = over ? this.A[this.accAt(ACCF.KR, d)] : this.A[this.accAt(ACCF.KC, d)];
    return key !== 0 ? key & 255 : 255;
  }
  deposit() {
    const A = this.A, part = (v: number, w: number) => { const p = mul64(v, w); return ((p[0] >>> 16) | (p[1] << 16)) >>> 0; };
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx);
      if (this.vtot(FLD.VB, c) === 0) continue;
      const p = this.rs(FLD.PL, c);
      if (p >= this.set.layout.plates) continue;
      const v = [this.rs(FLD.VB, c), this.rs(FLD.VB + 1, c), this.rs(FLD.VB + 2, c), this.rs(FLD.VB + 3, c), this.rs(FLD.VB + 4, c), this.rs(FLD.AGB, c), this.rs(FLD.ORG, c)];
      const a = this.area(c), { w, c: hc } = this.stencil(idx, c, p);
      for (let k = 0; k < 4; k++) {
        if (w[k] === 0) continue;
        const d = hc[k], wp = this.winnerOf(d, this.area(d), A[this.accAt(ACCF.COV, d)]);
        if (wp === 255 || wp === p) { const at = this.accAt(ACCF.COVW, d); A[at] = (A[at] + ((a * w[k] + 32768) >>> 16)) >>> 0; }
      }
      for (let j = 0; j < NEXT; j++) {
        const p1 = part(v[j], w[1]), p2 = part(v[j], w[2]), p3 = part(v[j], w[3]), share = [(v[j] - p1 - p2 - p3) >>> 0, p1, p2, p3];
        for (let k = 0; k < 4; k++) {
          if (w[k] === 0) continue;
          const d = hc[k], cov = A[this.accAt(ACCF.COV, d)], wp = this.winnerOf(d, this.area(d), cov), base = wp === 255 || wp === p ? ACCF.W : ACCF.L, at = this.accAt(base + j, d);
          A[at] = (A[at] + share[k]) >>> 0;
        }
      }
    }
  }
  resolve() {
    const A = this.A;
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), a = this.area(c), cov = A[this.accAt(ACCF.COV, c)];
      const over = cov * 16 > a * PHYS.OVER_NUM, gap = cov * 16 < a * PHYS.GAP_NUM, wp = this.winnerOf(c, a, cov);
      const W = (j: number) => A[this.accAt(ACCF.W + j, c)], L = (j: number) => A[this.accAt(ACCF.L + j, c)];
      const nv: number[] = [];
      for (let j = 0; j < NEXT; j++) nv.push((W(j) + L(j)) >>> 0);
      let lost = 0;
      if (over) {
        const covL = cov - A[this.accAt(ACCF.COVW, c)];
        let q = 0;
        if (covL > 0) { const x = Math.min(cov - a, covL); q = divw(x >>> 16, (x << 16) >>> 0, covL)[0]; }
        const u = nv.map((_, j) => { const p = mul64(L(j), q); return ((p[0] >>> 16) | (p[1] << 16)) >>> 0; });
        lost = u[0];
        nv[0] = (nv[0] - u[0]) >>> 0; nv[1] = (nv[1] - u[1]) >>> 0; nv[2] = (nv[2] + u[1]) >>> 0; nv[5] = (nv[5] - u[5]) >>> 0; nv[6] = 0;
      }
      let fresh = 0;
      if (gap) { fresh = Math.floor(((a - cov) * PHYS.H_OC) / 16); nv[0] = (nv[0] + fresh) >>> 0; }
      for (let j = 0; j < NEXT; j++) this.ws(FLD.VB + j, c, nv[j]);
      this.ws(FLD.PL, c, cov === 0 ? 255 : wp);
      this.ws(FLD.SUB, c, lost);
      this.flux[FLUX.NEW] += BigInt(fresh); this.flux[FLUX.SUB] += BigInt(lost);
    }
  }
  gapfill(src: number, dst: number, sweep: number) {
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), own = this.rs(src, c);
      let out = own;
      if (own === 255) {
        const cand: number[] = [];
        for (let d = 0; d < 4; d++) { const q = this.rs(src, this.nbr(c, d).cell); if (q !== 255) cand.push(q); }
        if (cand.length > 0) {
          let h = (Math.imul(idx, 2654435761) + Math.imul(sweep, 40503)) >>> 0;
          h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
          h = (h ^ (h >>> 13)) >>> 0;
          out = cand[h % cand.length];
        }
      }
      this.ws(dst, c, out);
    }
  }
  smooth(src: number, dst: number) {
    const offs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), own = this.rs(src, c), seen: number[] = [];
      let same = 0;
      for (const [dx, dy] of offs) {
        const s = haloSource(this.g, c.face, c.X + dx, c.Y + dy);
        if (!s) { seen.push(255); continue; }
        const q = this.rs(src, { face: s.face, X: s.X, Y: s.Y });
        seen.push(q);
        if (q === own) same++;
      }
      let out = own;
      if (same <= PHYS.SMOOTH_SAME)
        for (const q of seen) {
          if (q === own || q === 255) continue;
          if (seen.filter((x) => x === q).length >= PHYS.SMOOTH_VOTES) { out = q; break; }
        }
      this.ws(dst, c, out);
    }
  }
  distInit() { for (let idx = 0; idx < this.cells(); idx++) { const c = this.cell(idx); this.ws(FLD.DIST, c, this.rs(FLD.SUB, c) > 0 ? 0 : PHYS.DIST_INF); } }
  distSweep(src: number, dst: number) {
    const offs: [number, number, number][] = [[1, 0, PHYS.CHAMFER_AXIS], [0, 1, PHYS.CHAMFER_AXIS], [-1, 0, PHYS.CHAMFER_AXIS], [0, -1, PHYS.CHAMFER_AXIS], [1, 1, PHYS.CHAMFER_DIAG], [-1, 1, PHYS.CHAMFER_DIAG], [-1, -1, PHYS.CHAMFER_DIAG], [1, -1, PHYS.CHAMFER_DIAG]];
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), pl = this.rs(FLD.PL, c);
      let best = this.rs(src, c);
      if (this.rs(FLD.SUB, c) > 0) best = 0;
      for (const [dx, dy, cost] of offs) {
        const s = haloSource(this.g, c.face, c.X + dx, c.Y + dy);
        if (!s) continue;
        const nb = { face: s.face, X: s.X, Y: s.Y };
        if (this.rs(FLD.PL, nb) !== pl) continue;
        best = Math.min(best, this.rs(src, nb) + cost);
      }
      this.ws(dst, c, Math.min(best, PHYS.DIST_INF));
    }
  }
  magma(stepNo: number, dtUnits: number, pelagicM: number) {
    const L = this.set.layout, Q = this.Q, cn = this.tw;
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), a = this.area(c);
      let vb = this.rs(FLD.VB, c), vs = this.rs(FLD.VB + 1, c), vm = this.rs(FLD.VB + 2, c), vg = this.rs(FLD.VB + 3, c), vv = this.rs(FLD.VB + 4, c), agb = this.rs(FLD.AGB, c), org = this.rs(FLD.ORG, c);
      const pl = this.rs(FLD.PL, c), d = this.rs(FLD.DIST, c);
      let event = false, arcAdd = 0, hotAdd = 0, pelAdd = 0;
      if (d >= PHYS.ARC_LO && d <= PHYS.ARC_HI && pl < L.plates) {
        const dh = Math.max(Q[L.arc + pl * (L.steps + 1) + stepNo], 0);
        arcAdd = Math.floor((dh * a) / 16);
        const vol = Math.floor(arcAdd / (PHYS.PLUTON_PER_VOLCANIC + 1));
        vv = (vv + vol) >>> 0; vg = (vg + (arcAdd - vol)) >>> 0;
        if (arcAdd > 0) event = true;
      }
      const cv = [0, 1, 2].map((k) => BigInt(this.T[(TAB.COUNT + k) * cn + idx]));
      for (let h = 0; h < L.hotspots; h++) {
        const o = L.hot + h * 6, cosd = Number(shrBig(BigInt(Q[o]) * cv[0] + BigInt(Q[o + 1]) * cv[1] + BigInt(Q[o + 2]) * cv[2], 30n)), cosr = Q[o + 3];
        if (cosd >= cosr) {
          const diff = cosd - cosr, span = 1073741824 - cosr, q = divw(Math.min(diff >>> 16, span - 1), (diff << 16) >>> 0, span)[0];
          const dh = Math.floor((Q[o + 4] * q) / 65536), vol = Math.floor((dh * a) / 16);
          vv = (vv + vol) >>> 0; hotAdd += vol;
          if (vol > 0) event = true;
        }
      }
      if (vb > 0 && vb >= vm + vg + vv && !event) { pelAdd = Math.floor((pelagicM * a) / 16); vs = (vs + pelAdd) >>> 0; }
      if (event) org = 0;
      const vt = (vb + vs + vm + vg + vv) >>> 0;
      agb = Math.min(agb + (vb >>> PHYS.AGE_SHIFT) * dtUnits, (vb >>> PHYS.AGE_SHIFT) * PHYS.AGE_MAX);
      org = Math.min(org + (vt >>> PHYS.AGE_SHIFT) * dtUnits, (vt >>> PHYS.AGE_SHIFT) * PHYS.AGE_MAX);
      this.ws(FLD.VB + 1, c, vs); this.ws(FLD.VB + 3, c, vg); this.ws(FLD.VB + 4, c, vv); this.ws(FLD.AGB, c, agb); this.ws(FLD.ORG, c, org);
      this.flux[FLUX.ARC] += BigInt(arcAdd); this.flux[FLUX.HOT] += BigInt(hotAdd); this.flux[FLUX.PEL] += BigInt(pelAdd);
    }
  }
  private capOf(base: number, c: Cell) { const vt = this.vtot(base, c), cp = Math.floor((PHYS.H_MAX * this.area(c)) / 16); return vt < cp ? cp - vt : 0; }
  private outFrac(base: number, c: Cell) {
    const vt = this.vtot(base, c), cp = Math.floor((PHYS.H_MAX * this.area(c)) / 16);
    if (vt <= cp) return 0;
    const ex = vt - cp;
    return divw(ex >>> 16, (ex << 16) >>> 0, vt)[0];
  }
  private shareTo(base: number, j: Cell, d: number) {
    const f = this.outFrac(base, j);
    if (f === 0) return 0;
    let room = 0, mine = 0;
    for (let e = 0; e < 4; e++) { const r = this.capOf(base, this.nbr(j, e).cell); room += r; if (e === d) mine = r; }
    if (room === 0) return f >>> 2;
    const pr = mul64(f, mine);
    return divw(pr[1], pr[0], room)[0];
  }
  topple(fa: number, fb: number) {
    const part = (v: number, w: number) => { const p = mul64(v, w); return ((p[0] >>> 16) | (p[1] << 16)) >>> 0; };
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), outS: number[] = [], inS: number[] = [], inN: Cell[] = [];
      for (let d = 0; d < 4; d++) {
        outS.push(this.shareTo(fa, c, d));
        const nb = this.nbr(c, d);
        inN.push(nb.cell);
        inS.push(this.shareTo(fa, nb.cell, (d + 2 + nb.rot) & 3));
      }
      for (let j = 0; j < NEXT; j++) {
        const v = this.rs(fa + j, c);
        let o = 0, i = 0;
        for (let d = 0; d < 4; d++) { o = (o + part(v, outS[d])) >>> 0; i = (i + part(this.rs(fa + j, inN[d]), inS[d])) >>> 0; }
        this.ws(fb + j, c, (v - o + i) >>> 0);
      }
    }
  }
  trim(base: number) {
    const part = (v: number, w: number) => { const p = mul64(v, w); return ((p[0] >>> 16) | (p[1] << 16)) >>> 0; };
    for (let idx = 0; idx < this.cells(); idx++) {
      const c = this.cell(idx), f = this.outFrac(base, c);
      if (f === 0) continue;
      let cut = 0;
      for (let j = 0; j < NEXT; j++) {
        const v = this.rs(base + j, c), o = part(v, f);
        if (j < 5) cut += o;
        this.ws(base + j, c, (v - o) >>> 0);
      }
      this.flux[FLUX.TRIM] += BigInt(cut);
    }
  }
  // One step of everything, as the driver runs it.
  step(stepNo: number) {
    const sw = this.set.sweeps, dtUnits = Math.round(this.set.params.stepMy / PHYS.AGE_UNIT_MY), pelM = Math.round(PELAGIC_M_PER_MY * this.set.params.stepMy);
    this.A.fill(0);
    this.elev(); this.claim(); this.deposit(); this.resolve();
    for (let s = 0; s < sw.gap; s++) this.gapfill(s % 2 === 0 ? FLD.PL : FLD.PL2, s % 2 === 0 ? FLD.PL2 : FLD.PL, s);
    for (let s = 0; s < sw.smooth; s++) this.smooth(s % 2 === 0 ? FLD.PL : FLD.PL2, s % 2 === 0 ? FLD.PL2 : FLD.PL);
    this.distInit();
    for (let s = 0; s < sw.dist; s++) this.distSweep(s % 2 === 0 ? FLD.DIST : FLD.DIST2, s % 2 === 0 ? FLD.DIST2 : FLD.DIST);
    this.magma(stepNo, dtUnits, pelM);
    for (let s = 0; s < sw.topple; s++) this.topple(s % 2 === 0 ? FLD.VB : FLD.E2, s % 2 === 0 ? FLD.E2 : FLD.VB);
    this.trim(FLD.VB);
  }
}

// ---------- 8. the kernels on a device ----------
const modules = new Map<string, string>();
function wgslOf(set: Setup): string {
  const key = JSON.stringify(set.layout);
  let m = modules.get(key);
  if (!m) { m = tectonicsWgsl(EDGES, set.layout, FRAMES); modules.set(key, m); }
  return m;
}

// The planet on a device: its fields, the tables, and the kernels' dispatches recorded into one command buffer for each
// step (a step is some 200 dispatches).
export class Tectonics {
  readonly S: GPUBuffer;
  private readonly T: GPUBuffer;
  private readonly Qb: GPUBuffer;
  private readonly A: GPUBuffer;
  private readonly pars = new Map<string, GPUBuffer>();
  private readonly groups = new Map<string, GPUBindGroup>();
  readonly g: Grid;
  readonly fw: number;
  private enc: GPUCommandEncoder | null = null;
  private wgsl: string;
  stepNo = 0;
  constructor(readonly gpu: Gpu, readonly set: Setup, ext: { tab: Tables; T: Int32Array }, start: Int32Array) {
    this.g = set.grid; this.fw = fieldWords(this.g);
    this.S = storage(gpu, start);
    this.T = storage(gpu, ext.T);
    this.Qb = storage(gpu, set.Q);
    this.A = storage(gpu, (ACCF.COUNT * this.fw + FLUX.COUNT * 4) * 4);
    this.wgsl = wgslOf(set);
  }
  private rec(entry: string, par: Record<number, number>, threads: number) {
    const g = this.g, key = entry + JSON.stringify(par);
    let P = this.pars.get(key);
    if (!P) {
      const w = new Uint32Array(64);
      w[0] = g.tiles; w[1] = g.fn; w[2] = tileCount(g);
      for (const [k, v] of Object.entries(par)) w[Number(k)] = v;
      P = storage(this.gpu, w);
      this.pars.set(key, P);
    }
    const p = pipeline(this.gpu, this.wgsl, entry);
    let bind = this.groups.get(key);
    if (!bind) {
      bind = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.S, this.T, P, this.A, this.Qb].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.groups.set(key, bind);
    }
    const pass = this.enc!.beginComputePass(), [gx, gy] = cover(this.gpu, threads);
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(gx, gy); pass.end();
  }
  private begin() { this.enc = this.gpu.device.createCommandEncoder(); }
  private submit() { this.gpu.device.queue.submit([this.enc!.finish()]); this.enc = null; }
  // The kernels of one named piece of a step, for the tests that compare a piece against its twin.
  piece(name: "elev" | "claim" | "deposit" | "resolve", par: Record<number, number> = {}) {
    this.begin();
    if (name === "claim") this.enc!.clearBuffer(this.A, 0, ACCF.COUNT * this.fw * 4);
    this.rec(name, par, tileCount(this.g) * 65536);
    this.submit();
  }
  clearAccumulators() { this.begin(); this.enc!.clearBuffer(this.A, 0, ACCF.COUNT * this.fw * 4); this.submit(); }
  // One step of everything.
  step() {
    const sw = this.set.sweeps, n = tileCount(this.g) * 65536, dtUnits = Math.round(this.set.params.stepMy / PHYS.AGE_UNIT_MY), pelM = Math.round(PELAGIC_M_PER_MY * this.set.params.stepMy);
    this.begin();
    this.enc!.clearBuffer(this.A, 0, ACCF.COUNT * this.fw * 4);
    for (const e of ["elev", "claim", "deposit", "resolve"]) this.rec(e, {}, n);
    for (let s = 0; s < sw.gap; s++) this.rec("gapfill", { 16: s % 2 === 0 ? FLD.PL : FLD.PL2, 17: s % 2 === 0 ? FLD.PL2 : FLD.PL, 18: s }, n);
    for (let s = 0; s < sw.smooth; s++) this.rec("plateSmooth", { 16: s % 2 === 0 ? FLD.PL : FLD.PL2, 17: s % 2 === 0 ? FLD.PL2 : FLD.PL }, n);
    this.rec("distInit", {}, n);
    for (let s = 0; s < sw.dist; s++) this.rec("distSweep", { 16: s % 2 === 0 ? FLD.DIST : FLD.DIST2, 17: s % 2 === 0 ? FLD.DIST2 : FLD.DIST }, n);
    this.rec("magma", { 19: dtUnits, 20: pelM, 21: this.stepNo }, n);
    for (let s = 0; s < sw.topple; s++) this.rec("topple", { 16: s % 2 === 0 ? FLD.VB : FLD.E2, 17: s % 2 === 0 ? FLD.E2 : FLD.VB }, n);
    this.rec("trim", { 16: FLD.VB }, n);
    this.submit();
    this.stepNo++;
  }
  // The heights of the planet as it stands (the elevation kernel on the present fields).
  elevate() { this.begin(); this.rec("elev", {}, tileCount(this.g) * 65536); this.submit(); }
  async done() { await this.gpu.device.queue.onSubmittedWorkDone(); }
  async read(): Promise<Int32Array> {
    await this.done();
    return new Int32Array(await readback(this.gpu, this.S, FLD.COUNT * this.fw * 4));
  }
  async readAccumulators(): Promise<Uint32Array> {
    await this.done();
    return new Uint32Array(await readback(this.gpu, this.A, ACCF.COUNT * this.fw * 4));
  }
  // The six fluxes in volume units, summed over the run so far: new basalt, basalt subducted, arc rock, hot spot rock, pelagic sediment, crust cut at the thickness limit.
  async fluxes(): Promise<bigint[]> {
    await this.done();
    const w = new Uint32Array(await readback(this.gpu, this.A, FLUX.COUNT * 16, ACCF.COUNT * this.fw * 4));
    return Array.from({ length: FLUX.COUNT }, (_, k) => [0, 1, 2, 3].reduce((s, l) => s + (BigInt(w[k * 4 + l]) << BigInt(8 * l)), 0n));
  }
  release() {
    for (const b of [this.S, this.T, this.Qb, this.A, ...this.pars.values()]) b.destroy();
    this.pars.clear(); this.groups.clear();
  }
}

// ---------- 9. reading the result ----------
// A field of S in flat cell order.
export function unpad(g: Grid, S: Int32Array, field: number): Int32Array {
  const fw = fieldWords(g), out = new Int32Array(FACES * g.fn * g.fn);
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) out[cellId(g, f, X, Y)] = S[field * fw + wordAt(g, f, X, Y)];
  return out;
}
// The total of each rock's volume over the planet, the five pools, in volume units (a bigint: the sum passes 2^32).
export function totals(g: Grid, S: Int32Array): bigint[] {
  const fw = fieldWords(g), out = [0n, 0n, 0n, 0n, 0n];
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) { const at = wordAt(g, f, X, Y); for (let k = 0; k < 5; k++) out[k] += BigInt(S[(FLD.VB + k) * fw + at] >>> 0); }
  return out;
}

export interface Derived {
  n: number;
  thickness: Float32Array; // crust and sediment together, m
  height: Float32Array; // surface height above sea level, m (negative under the sea)
  land: Uint8Array;
  continental: Uint8Array; // 1 where the basement is continental or arc rock (the non-basalt rock outweighs the basalt)
  ageMy: Float32Array; // basalt's age, My (0 where there is no basalt)
  orogenyMy: Float32Array; // time since the column last grew by convergence, an arc or a hot spot, My
  lith: Uint8Array; // the surface rock's class
  plate: Uint8Array;
  pools: Float32Array[]; // thickness of each rock, m
}
// Everything the maps and checks read, in flat cell order, from the fields (the elevation field must be current).
export function derive(set: Setup, tab: Tables, S: Int32Array): Derived {
  const g = set.grid, N = FACES * g.fn * g.fn, fw = fieldWords(g), sea = set.params.seaLevel;
  const d: Derived = {
    n: N, thickness: new Float32Array(N), height: new Float32Array(N), land: new Uint8Array(N), continental: new Uint8Array(N), ageMy: new Float32Array(N), orogenyMy: new Float32Array(N),
    lith: new Uint8Array(N), plate: new Uint8Array(N), pools: Array.from({ length: 5 }, () => new Float32Array(N)),
  };
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) {
        const i = cellId(g, f, X, Y), at = wordAt(g, f, X, Y), a = tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
        const h = [0, 1, 2, 3, 4].map((k) => { const v = S[(FLD.VB + k) * fw + at] >>> 0; return Math.floor(v / a) * 16 + Math.floor(((v % a) * 16) / a); });
        h.forEach((x, k) => { d.pools[k][i] = x; });
        const total = h[0] + h[1] + h[2] + h[3] + h[4];
        d.thickness[i] = total;
        d.height[i] = S[FLD.Z * fw + at] - sea;
        d.land[i] = d.height[i] > 0 ? 1 : 0;
        d.continental[i] = h[2] + h[3] + h[4] > h[0] ? 1 : 0;
        const vb = S[FLD.VB * fw + at] >>> 0, nb = vb >>> PHYS.AGE_SHIFT;
        d.ageMy[i] = nb > 0 ? (Math.min(Math.floor((S[FLD.AGB * fw + at] >>> 0) / nb), PHYS.AGE_MAX) * PHYS.AGE_UNIT_MY) : 0;
        const vt = (vb + (S[(FLD.VB + 1) * fw + at] >>> 0) + (S[(FLD.VB + 2) * fw + at] >>> 0) + (S[(FLD.VB + 3) * fw + at] >>> 0) + (S[(FLD.VB + 4) * fw + at] >>> 0)) >>> 0, nt = vt >>> PHYS.AGE_SHIFT;
        d.orogenyMy[i] = nt > 0 ? (Math.min(Math.floor((S[FLD.ORG * fw + at] >>> 0) / nt), PHYS.AGE_MAX) * PHYS.AGE_UNIT_MY) : 0;
        d.plate[i] = S[FLD.PL * fw + at];
        d.lith[i] = h[1] >= COVER_MIN_M ? LITH.sediment : h[4] >= COVER_MIN_M ? LITH.volcanic : h[0] >= h[2] && h[0] >= h[3] ? LITH.basalt : h[3] >= h[2] ? LITH.granitoid : LITH.metasediment;
      }
  return d;
}

// ---------- 10. measures ----------
// The share of the planet's area that is land, by true cell area.
export function landFraction(g: Grid, d: Derived): number {
  const areas = cellAreas(g);
  let land = 0;
  for (let i = 0; i < d.n; i++) if (d.land[i]) land += areas[i];
  return land / (4 * Math.PI);
}
// Connected sets of cells under a mask (four-neighbour, across tile and face edges): the sets' areas as a share of the planet.
export function components(g: Grid, mask: ArrayLike<number>): { label: Int32Array; areas: number[]; cells: number[] } {
  const N = FACES * g.fn * g.fn, nb = neighbours(g), areas = cellAreas(g), label = new Int32Array(N).fill(-1), out: number[] = [], count: number[] = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = out.length;
    let sp = 0, area = 0, cells = 0;
    stack[sp++] = s; label[s] = id;
    while (sp > 0) {
      const i = stack[--sp];
      area += areas[i]; cells++;
      for (let d = 0; d < 4; d++) { const j = nb[4 * i + d]; if (mask[j] && label[j] < 0) { label[j] = id; stack[sp++] = j; } }
    }
    out.push(area / (4 * Math.PI)); count.push(cells);
  }
  return { label, areas: out, cells: count };
}
// The number of continents: connected land of at least CONTINENT_MIN_SHARE of the planet.
export const continentCount = (g: Grid, d: Derived) => components(g, d.land).areas.filter((a) => a >= CONTINENT_MIN_SHARE).length;
// The longest range: the longest shortest path through any connected set of cells over RANGE_Z_M above sea level, in km (chamfer
// 5 and 7 over eight neighbours, measured from the set's farthest cell to the farthest from that: a diameter, so a ring is
// half its circumference).
export function longestRangeKm(g: Grid, d: Derived, minM = RANGE_Z_M): number {
  const N = d.n, mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = d.height[i] > minM ? 1 : 0;
  const { label, cells } = components(g, mask), nb = neighbours(g), cellKm = (g.radius * g.width) / 1000;
  const far = (s: number, id: number) => {
    const dist = new Map<number, number>([[s, 0]]), todo: number[][] = [[s]];
    let best = s, bestD = 0;
    for (let level = 0; level < todo.length; level++)
      for (const i of todo[level] ?? []) {
        if (dist.get(i)! !== level) continue;
        if (level > bestD) { bestD = level; best = i; }
        for (let k = 0; k < 8; k++) {
          const a = nb[4 * i + (k & 3)], j = k < 4 ? a : nb[4 * a + ((k + 1) & 3)], cost = k < 4 ? 5 : 7;
          if (label[j] !== id) continue;
          const nd = level + cost;
          if ((dist.get(j) ?? Infinity) > nd) { dist.set(j, nd); (todo[nd] ??= []).push(j); }
        }
      }
    return { best, bestD };
  };
  let longest = 0;
  const first = new Map<number, number>();
  for (let i = 0; i < N; i++) if (label[i] >= 0 && !first.has(label[i])) first.set(label[i], i);
  for (const [id, s] of first) {
    if (cells[id] < 8) continue;
    const a = far(s, id), b = far(a.best, id);
    longest = Math.max(longest, (b.bestD / 5) * cellKm);
  }
  return longest;
}

// Cells within `limit` steps of the cells under a mask, by breadth-first search over the four neighbours: the distance in
// cells, or -1 beyond the limit.
export function distanceFrom(g: Grid, mask: ArrayLike<number>, limit: number): Int32Array {
  const N = FACES * g.fn * g.fn, nb = neighbours(g), dist = new Int32Array(N).fill(-1), queue: number[] = [];
  for (let i = 0; i < N; i++) if (mask[i]) { dist[i] = 0; queue.push(i); }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    if (dist[i] >= limit) continue;
    for (let d = 0; d < 4; d++) { const j = nb[4 * i + d]; if (dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); } }
  }
  return dist;
}

// ---------- 11. a whole run, and the checks ----------
export interface Planet {
  start: Start;
  S0: Int32Array; // the starting fields with the elevation worked out
  S: Int32Array; // the final fields (elevation current)
  fluxes: bigint[]; // over the run: new basalt, basalt subducted, arc rock, hot spot rock, pelagic sediment, crust cut at the limit (volume units)
}
// Make the planet from the seed (or start from the state given) and run it for the whole span on the device given.
export async function runPlanet(gpu: Gpu, set: Setup, onStep?: (tec: Tectonics, step: number) => void | Promise<void>, from?: Start): Promise<Planet> {
  const ext = extTables(set.grid), start = from ?? startingState(set, ext.tab), tec = new Tectonics(gpu, set, ext, start.S);
  try {
    tec.elevate();
    const S0 = await tec.read();
    for (let s = 0; s < set.steps; s++) { tec.step(); if (onStep) await onStep(tec, s); }
    tec.elevate();
    return { start, S0, S: await tec.read(), fluxes: await tec.fluxes() };
  } finally {
    tec.release();
  }
}

export interface Measures {
  landStart: number; land: number;
  continentsStart: number; continents: number;
  longestRangeKm: number; rangeShare: number; // the share of the planet over 2 km above sea level
  rangeNearConvergent: number; // the share of those cells within 12 cells (about 150 km) of a boundary that is convergent by relative velocity
  nearConvergentBaseline: number; // the same share for all the planet's cells: what a map with no relation to the boundaries would give
  highAtBoundary: { convergent: number; divergent: number; transform: number }; // the share of the cells on each class of boundary that stand over 2 km
  ageMedianMy: number; ageMaxMy: number; olderThan200: number; // of the sea floor (basalt-dominated cells)
  thicknessMin: number; thicknessMax: number; // crust and sediment, m, over the whole planet
  residual: bigint; // the change in all five volumes less the fluxes' account: zero when the books balance
  unplated: number; // cells with no plate
}
// What the checks of the plan's unit read off a finished run.
export function measure(set: Setup, tab: Tables, planet: Planet): Measures {
  const g = set.grid, d = derive(set, tab, planet.S), dStart = derive(set, tab, planet.S0), N = d.n, areas = cellAreas(g);
  const bd = classifyBoundaries(g, d.plate, set.plates), conv = new Uint8Array(N);
  for (let i = 0; i < N; i++) conv[i] = bd.cls[i] === BOUNDARY.convergent ? 1 : 0;
  const near = distanceFrom(g, conv, 12);
  let range = 0, rangeNear = 0, rangeArea = 0, unplated = 0, tmin = Infinity, tmax = 0, sea = 0, older = 0;
  const ages: number[] = [], onB = [0, 0, 0, 0], highB = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    if (d.height[i] > RANGE_Z_M) { range++; rangeArea += areas[i]; if (near[i] >= 0) rangeNear++; }
    if (d.plate[i] === 255) unplated++;
    onB[bd.cls[i]]++;
    if (d.height[i] > RANGE_Z_M) highB[bd.cls[i]]++;
    tmin = Math.min(tmin, d.thickness[i]); tmax = Math.max(tmax, d.thickness[i]);
    if (!d.continental[i] && d.pools[0][i] > 0) { sea++; ages.push(d.ageMy[i]); if (d.ageMy[i] > 200) older++; }
  }
  ages.sort((a, b) => a - b);
  const sum = (a: bigint[]) => a.reduce((s, x) => s + x, 0n), f = planet.fluxes;
  const residual = sum(totals(g, planet.S)) - sum(totals(g, planet.start.S)) - (f[FLUX.NEW] + f[FLUX.ARC] + f[FLUX.HOT] + f[FLUX.PEL]) + f[FLUX.SUB] + f[FLUX.TRIM];
  return {
    landStart: landFraction(g, dStart), land: landFraction(g, d), continentsStart: continentCount(g, dStart), continents: continentCount(g, d),
    longestRangeKm: longestRangeKm(g, d), rangeShare: rangeArea / (4 * Math.PI), rangeNearConvergent: range > 0 ? rangeNear / range : 1, nearConvergentBaseline: near.reduce((s, v) => s + (v >= 0 ? 1 : 0), 0) / N,
    highAtBoundary: { convergent: highB[BOUNDARY.convergent] / Math.max(1, onB[BOUNDARY.convergent]), divergent: highB[BOUNDARY.divergent] / Math.max(1, onB[BOUNDARY.divergent]), transform: highB[BOUNDARY.transform] / Math.max(1, onB[BOUNDARY.transform]) },
    ageMedianMy: ages[Math.floor(ages.length / 2)], ageMaxMy: ages[ages.length - 1], olderThan200: sea > 0 ? older / sea : 0,
    thicknessMin: tmin, thicknessMax: tmax, residual, unplated,
  };
}
