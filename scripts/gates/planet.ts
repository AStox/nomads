// Whole-planet gates on a tier's heights (tier 0: the chain's planet; tier 3: the carry), face-major cells `(face * fn + Y) * fn + X`, metres above the sea (sea level 0).
//
// Every share is area weighted: a cell's weight is its solid angle on the cube sphere (grid.ts areaSr, the gnomonic equiangular cell), so a cell near a face's corner counts less than one at
// its centre. Land = height above 0.
//  landShare       area of land cells over the planet's. Earth 0.29.
//  landHeight      area-weighted mean, p50, p90, p99 (0.5 m histogram bins) and max of the land cells' heights. Earth land median 408 m, mean 673 to 840 m (the brief's targets).
//  hypsometry      the share of the planet's area (and of the land's) in height bins (m): <-4000, -4000..-2000, -2000..-1000, -1000..-500, -500..0, 0..200, 200..500, 500..1000, 1000..1500,
//                  1500..2000, 2000..3000, 3000..4000, above 4000.
//  components      land components by 4-neighbour connection across the cube's face edges (grid.ts step); the count, the largest five as a share of the planet's area and the land's.
//  relief10        the share of land windows (`inland`: every cell of the disc above sea level; `centred`: centred on a land cell, a coastal disc then reaches the shelf) whose 10 km relief exceeds 1000 / 1500 / 2000 m; relief = maximum minus minimum height of the cells whose centres lie within 5 km of the
//                  window's centre cell (a disc of radius 5 km in the local cell width, equals the chain's 21-cell window at the mean tier-0 width 2,211 m); windows are the land cells (tier 0) or
//                  every 2nd land cell in X and Y (tier 3, `stride`), area weighted. Earth: under 5 % of land above 1000 m and under 2 % above 1500 m (Montgomery and Brandon 2002, Earth Planet.
//                  Sci. Lett. 201, 481-489).
//  summit          the highest cell: height, latitude, longitude, face and cell.
//  coastRuns       (tier 0) the coast as the closed polylines of cell corners between a land cell and a sea cell (4-neighbour); runs by a greedy partition from each loop's first corner,
//                  each run the longest stretch all of whose corners lie within 2.5 km of the great circle through its ends (cross-track distance); counts and share of the coast's length in
//                  runs of at least 40, 100 and 150 km, and the longest run. A staircase coast along a lattice diagonal stays within one cell (2.2 km) so it counts as straight, the lock's signature.
import { areaSr, centre, latLon, locateVec, makeGrid, pointAt, step, vertex, type Grid, type V3 } from "../../src/gpu/globe/grid";

export interface Field { fn: number; h: Float32Array; radius: number }

export function areaTable(g: Grid): Float64Array {
  const a = new Float64Array(g.fn * g.fn);
  for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) a[Y * g.fn + X] = areaSr(g, X, Y);
  return a;
}

const BINS = 0.5, HMAX = 12000;
function quantiles(values: Float32Array, weights: (i: number) => number, keep: (i: number) => boolean, qs: number[]): { qs: number[]; mean: number; max: number; area: number } {
  const hist = new Float64Array(Math.ceil(HMAX / BINS) + 1);
  let total = 0, sum = 0, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (!keep(i)) continue;
    const w = weights(i), v = values[i];
    total += w; sum += w * v; if (v > max) max = v;
    hist[Math.min(hist.length - 1, Math.max(0, Math.floor(v / BINS)))] += w;
  }
  const out = qs.map((q) => { let c = 0; for (let b = 0; b < hist.length; b++) { c += hist[b]; if (c >= q * total) return b * BINS + BINS / 2; } return max; });
  return { qs: out, mean: sum / total, max, area: total };
}

export const HYPSO_EDGES = [-4000, -2000, -1000, -500, 0, 200, 500, 1000, 1500, 2000, 3000, 4000];

export function landStats(f: Field, areaAt: (i: number) => number) {
  const { h } = f, all = quantiles(h, areaAt, () => true, []), land = quantiles(h, areaAt, (i) => h[i] > 0, [0.5, 0.9, 0.99]);
  const bins = new Float64Array(HYPSO_EDGES.length + 1), landBins = new Float64Array(HYPSO_EDGES.length + 1);
  for (let i = 0; i < h.length; i++) {
    let b = 0; while (b < HYPSO_EDGES.length && h[i] >= HYPSO_EDGES[b]) b++;
    const w = areaAt(i); bins[b] += w; if (h[i] > 0) landBins[b] += w;
  }
  const lab = (b: number) => (b === 0 ? `<${HYPSO_EDGES[0]}` : b === HYPSO_EDGES.length ? `>=${HYPSO_EDGES[b - 1]}` : `${HYPSO_EDGES[b - 1]}..${HYPSO_EDGES[b]}`);
  const share = (a: Float64Array, t: number) => Object.fromEntries([...a].map((v, b) => [lab(b), +(v / t).toFixed(5)]));
  return {
    landShare: +(land.area / all.area).toFixed(5),
    landHeight: { mean: +land.mean.toFixed(1), p50: +land.qs[0].toFixed(1), p90: +land.qs[1].toFixed(1), p99: +land.qs[2].toFixed(1), max: +land.max.toFixed(1) },
    hypsometryPlanet: share(bins, all.area), hypsometryLand: share(landBins, land.area),
  };
}

export function components(f: Field, g: Grid, area: Float64Array) {
  const n = f.h.length, fn = f.fn, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join = (a: number, b: number) => { if (f.h[a] <= 0 || f.h[b] <= 0) return; const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let face = 0; face < 6; face++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const i = (face * fn + Y) * fn + X;
    if (f.h[i] <= 0) continue;
    if (X < fn - 1) join(i, i + 1);
    if (Y < fn - 1) join(i, i + fn);
    if (X === fn - 1 || Y === fn - 1 || X === 0 || Y === 0) for (let d = 0; d < 4; d++) { const s = step(g, face, X, Y, d); join(i, (s.face * fn + s.Y) * fn + s.X); }
  }
  const sum = new Float64Array(n);
  let landArea = 0, planetArea = 0;
  for (let i = 0; i < n; i++) { const w = area[i % (fn * fn)]; planetArea += w; if (f.h[i] > 0) { sum[find(i)] += w; landArea += w; } }
  const roots: number[] = [];
  for (let i = 0; i < n; i++) if (sum[i] > 0) roots.push(i);
  roots.sort((a, b) => sum[b] - sum[a]);
  const top = roots.slice(0, 5);
  return { count: roots.length, top5PlanetShare: top.map((r) => +(sum[r] / planetArea).toFixed(5)), top5LandShare: top.map((r) => +(sum[r] / landArea).toFixed(5)) };
}

// the extended array of a face: halo cells past the edge read from the cell that holds their place (nearest cell, to within a cell)
function extended(f: Field, g: Grid, face: number, H: number): Float32Array {
  const fn = f.fn, W = fn + 2 * H, e = new Float32Array(W * W);
  for (let y = -H; y < fn + H; y++) for (let x = -H; x < fn + H; x++) {
    if (x >= 0 && x < fn && y >= 0 && y < fn) e[(y + H) * W + x + H] = f.h[(face * fn + y) * fn + x];
    else { const p = locateVec(g, pointAt(g, face, x, y)); e[(y + H) * W + x + H] = f.h[(p.face * fn + p.Y) * fn + p.X]; }
  }
  return e;
}

export interface ReliefShares { windows: number; above1000: number; above1500: number; above2000: number; p50M: number; p90M: number }
export interface Relief10 { stride: number; inland: ReliefShares; centred: ReliefShares }

export function relief10(f: Field, g: Grid, area: Float64Array, stride = 1, radiusM = 5000): Relief10 {
  let amin = Infinity;
  for (let i = 0; i < area.length; i++) if (area[i] < amin) amin = area[i];
  const fn = f.fn, thresholds = [1000, 1500, 2000], widthMin = g.radius * Math.sqrt(amin), H = Math.ceil(radiusM / widthMin) + 2, W = fn + 2 * H;
  const sets = { inland: [] as { r: number; w: number }[], centred: [] as { r: number; w: number }[] };
  for (let face = 0; face < 6; face++) {
    const e = extended(f, g, face, H);
    for (let Y = 0; Y < fn; Y += stride) for (let X = 0; X < fn; X += stride) {
      if (!(f.h[(face * fn + Y) * fn + X] > 0)) continue;
      const w = area[Y * fn + X], r = radiusM / (g.radius * Math.sqrt(w)), R = Math.floor(r);
      let mx = -Infinity, mn = Infinity;
      for (let dy = -R; dy <= R; dy++) {
        const hw = Math.floor(Math.sqrt(r * r - dy * dy)), row = (Y + dy + H) * W + X + H;
        for (let dx = -hw; dx <= hw; dx++) { const v = e[row + dx]; if (v > mx) mx = v; if (v < mn) mn = v; }
      }
      sets.centred.push({ r: mx - mn, w });
      if (mn > 0) sets.inland.push({ r: mx - mn, w });
    }
  }
  const shares = (list: { r: number; w: number }[]): ReliefShares => {
    let wsum = 0;
    const above = [0, 0, 0];
    for (const q of list) { wsum += q.w; for (let t = 0; t < 3; t++) if (q.r > thresholds[t]) above[t] += q.w; }
    list.sort((a, b) => a.r - b.r);
    let c = 0, p50 = 0, p90 = 0;
    for (const q of list) { c += q.w; if (!p50 && c >= 0.5 * wsum) p50 = q.r; if (!p90 && c >= 0.9 * wsum) p90 = q.r; }
    return { windows: list.length, above1000: +(above[0] / wsum).toFixed(4), above1500: +(above[1] / wsum).toFixed(4), above2000: +(above[2] / wsum).toFixed(4), p50M: +p50.toFixed(0), p90M: +p90.toFixed(0) };
  };
  return { stride, inland: shares(sets.inland), centred: shares(sets.centred) };
}

export function summit(f: Field, g: Grid) {
  let best = 0;
  for (let i = 1; i < f.h.length; i++) if (f.h[i] > f.h[best]) best = i;
  const fn = f.fn, face = Math.floor(best / (fn * fn)), Y = Math.floor((best % (fn * fn)) / fn), X = best % fn, ll = latLon(centre(g, face, X, Y));
  return { heightM: +f.h[best].toFixed(1), latDeg: +((ll.lat * 180) / Math.PI).toFixed(3), lonDeg: +((ll.lon * 180) / Math.PI).toFixed(3), face, X, Y };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a: V3, b: V3) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

// The coast loops as lists of unit vectors (cell corners).
export function coastLoops(f: Field, g: Grid): V3[][] {
  const fn = f.fn, ids = new Map<string, number>(), pts: V3[] = [], edges: [number, number][] = [];
  const vid = (face: number, i: number, j: number) => {
    const p = vertex(g, face, i, j), k = `${Math.round(p[0] * 1e9)},${Math.round(p[1] * 1e9)},${Math.round(p[2] * 1e9)}`;
    let id = ids.get(k);
    if (id === undefined) { id = pts.length; ids.set(k, id); pts.push(p); }
    return id;
  };
  const corners = [[1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 0, 1], [0, 0, 1, 0]];
  for (let face = 0; face < 6; face++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    if (!(f.h[(face * fn + Y) * fn + X] > 0)) continue;
    for (let d = 0; d < 4; d++) {
      const s = step(g, face, X, Y, d);
      if (f.h[(s.face * fn + s.Y) * fn + s.X] > 0) continue;
      const [a, b, c, e] = corners[d];
      edges.push([vid(face, X + a, Y + b), vid(face, X + c, Y + e)]);
    }
  }
  const inc: number[][] = pts.map(() => []);
  edges.forEach(([a, b], i) => { inc[a].push(i); inc[b].push(i); });
  const used = new Uint8Array(edges.length), loops: V3[][] = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const loop = [edges[s][0]];
    let cur = edges[s][1];
    for (;;) {
      loop.push(cur);
      const next = inc[cur].find((e) => !used[e]);
      if (next === undefined) break;
      used[next] = 1;
      cur = edges[next][0] === cur ? edges[next][1] : edges[next][0];
    }
    loops.push(loop.map((v) => pts[v]));
  }
  return loops;
}

export interface CoastRuns { loops: number; coastKm: number; longestRunKm: number; tolKm: number; runs: Record<string, { count: number; coastShare: number }> }

export function coastRuns(loops: V3[][], radiusM: number, tolM = 2500, lengthsKm = [40, 100, 150]): CoastRuns {
  const runs: number[] = [];
  let total = 0;
  for (const p of loops) {
    const seg = p.map((v, i) => (i ? angle(p[i - 1], v) * radiusM : 0));
    total += seg.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < p.length - 1) {
      let j = i + 1, len = seg[j];
      for (let e = i + 2; e < p.length; e++) {
        const nrm = cross(p[i], p[e]), nl = Math.hypot(...nrm);
        if (nl < 1e-12) break;
        let ok = true;
        for (let m = i + 1; m < e && ok; m++) ok = Math.abs(Math.asin(dot(p[m], nrm) / nl)) * radiusM <= tolM;
        if (!ok) break;
        j = e; len += seg[e];
      }
      runs.push(len); i = j;
    }
  }
  const out: CoastRuns = { loops: loops.length, coastKm: +(total / 1000).toFixed(0), longestRunKm: +(runs.reduce((a, b) => Math.max(a, b), 0) / 1000).toFixed(1), tolKm: tolM / 1000, runs: {} };
  for (const L of lengthsKm) {
    const sel = runs.filter((r) => r >= L * 1000);
    out.runs[`${L}km`] = { count: sel.length, coastShare: +(sel.reduce((a, b) => a + b, 0) / total).toFixed(4) };
  }
  return out;
}

// All the whole-planet measures of a tier's field, one JSON-ready record per measure.
export function planetMeasures(f: Field, opts: { stride?: number; coast?: boolean; log?: (s: string) => void } = {}): Record<string, unknown> {
  const g = makeGrid(f.fn, f.radius), area = areaTable(g), fn2 = f.fn * f.fn, areaAt = (i: number) => area[i % fn2], log = opts.log ?? (() => {});
  const out: Record<string, unknown> = {};
  Object.assign(out, landStats(f, areaAt)); log("land stats");
  out.components = components(f, g, area); log("components");
  out.relief10 = relief10(f, g, area, opts.stride ?? 1); log("relief");
  out.summit = summit(f, g);
  if (opts.coast) { out.coastRuns = coastRuns(coastLoops(f, g), f.radius); log("coast"); }
  return out;
}
