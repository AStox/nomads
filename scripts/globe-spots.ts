// The planet's named places, chosen by meaning from a planet store and a bake's tier 3, so that the e2e and visual checks that used fixed coordinates on one planet can be pointed at the same
// kinds of place on another.
//   bun scripts/globe-spots.ts --store <NOMADS_STORE> --key <planet key> --bake <bake dir> [--out <prefix>] [--seed 1] [--home lat,lon] [--old "A=lat,lon;B=lat,lon;..."]
// The planet store is a directory of `<seed>-<key>/<stage>.bin` (scripts/globe-window.ts diskStore; window.ts readPlanet reads it). The bake dir holds the tier-3 files of
// docs/research/globe/2026-10-22-planet-bake-driver.md, in face-major order (cell = (face * 2048 + Y) * 2048 + X, grid.ts cellId on tierGrid(3)): t3-height.i32 (1/256 m, sea at 0), t3-to.u32 (the
// receivers' cell numbers; the bake driver may have spent it: `scripts/globe-water.ts --stage flow --tier 3` makes the same bytes from t3-height.i32 into a bake dir of one's own) and, if there, t3-acc.u32
// (checked against the catchments and shown, see R; the rest of the run needs only the first two). Writes
// <prefix>.json, <prefix>.md and <prefix>.png (an equirectangular map of tier 3, 2048 x 1024, the spots marked) and prints the table. --old gives other coordinates of the same names and the output
// says how far each is from the pick and what the ground is there. --home gives the home place where the ground tiles have already said it (see H).
//
// Words. Sea: the cells at or under 0 m (the flow's own: only a sea cell drains to itself) in 8-connected bodies of at least SMALL of the planet's area; the smaller bodies are hollows of the land and stay land.
// Land: every other cell. Landmass: a connected body of land (4 neighbours, across tile and face edges), ranked by area. SMALL: 0.5% of the planet's area, the least a landmass has to be to count [design].
// Inland distance of a land cell: the length of the shortest path of cell steps (8 neighbours, each step the great circle between the two cell centres) to a sea cell's centre; distance from land of a sea cell,
// the same to a land cell. A path of steps is within 8% above the great circle.
// A tier-5 cell is the one holding the tier-3 cell's centre. Ties go to the lowest cell number. Distances between places are great circles on the planet's radius.
//
// Rules ([design] marks a round design number, not a fit).
//  D  the highest summit: the highest tier-3 cell. Its range: the connected land at or over half its height [design], its area and its place named.
//  M  the highest summit at least 300 km [design] from D that is the highest ground within 20 km [design] of it (isolated) and stands at least 500 m [design] over the mean ground of that 20 km disc (sea
//     counted as 0 m).
//  R  the biggest river: the land cell whose receiver is at or under 0 m (the flow ends in such cells: its sea; the table says how big a body of them it is) and whose mean discharge is largest is the mouth. The discharge is the year's runoff of the planet's tier-0 cells (readPlanet seasons, mm) over
//     each tier-3 cell's area, in m3/s, summed down the tier-3 receivers. It is not t3-acc: the tier chain routes every cell with one reference rain, so t3-acc is the catchment's area in a fixed unit (the run
//     checks that at the mouths), which ranks the size of a basin and not the flow of its river; it is shown beside. Walking upstream by the donor of the largest discharge, the first cell whose discharge is
//     under half the mouth's is the half point (R-half); the walk ends at the head (a cell with no donor) and its length is the stem.
//  H  home: landing 1 of window.ts landingsOf (sea in reach, ground over 1 km, a river of 5 m3/s and 500 mm of rain, no ice, highest ground first); if no cell passes (the 1 km relief is the strict
//     one) the relief floor is dropped and the others rank by the highest ground. The page itself does not start at a landing: it starts at the tier-0 land cell with the most tree cover under 60 degrees
//     of latitude (demo/styles/isopixel/ground-at.js playPlace, read from the 75 m tier's ground tiles, which tier 3 does not carry), so pass that place with --home when the ground tiles exist.
//  E2 a point on a cube-face edge on land: the midpoint of the side two edge cells share (so on the edge great circle), both cells land and at least 40 km [design] inland, and at least 100 km [design]
//     from every cube corner; the one nearest home.
//  A  a forest: land 100 to 800 m high [design], at least 20 km [design] inland, on a landmass of at least SMALL, in a closed-forest climate: a year's rain over 1000 mm and a mean air temperature (the
//     four seasons' sea-level air less LAPSE of terrain/climate.ts times the height) from 8 to 26 C [design: the closed-forest climate the places were asked for]. The climate is the planet's, kept on tier 0, and a
//     tier-3 cell takes its tier-0 cell's. The rain classes are the Holdridge life-zone precipitation axis, which doubles from 125 mm (moist forest 1000 to 2000, wet forest 2000 to 4000, rain forest over 4000 mm);
//     the wettest class that has a region with a whole window of forest about a cell (a cell 9.6 km, half window.ts WINDOW_M, or more from the region's edge) gives A: the region is 4-connected, the
//     largest by area is taken and its centre is its deepest cell (the farthest from the region's edge by path distance).
//  B  land 300 to 1500 m high [design], at least 20 km inland, on a landmass of at least SMALL that is neither A's nor home's; the one nearest home.
//  C  sea at least 100 km [design] from any land; the one nearest home.
//  K3 a coast cell (land with a sea cell next to it) of the landmass that holds home; the one nearest A.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAMES, FACES, PLANET_RADIUS_M, areaSr, cellId, fromLatLon, latLon, locateVec, pointOf, step, tierGrid, type V3 } from "../src/gpu/globe/grid";
import { LANDING, WINDOW_M, landingCounts, landingsOf, readPlanet, type Planet } from "../src/gpu/globe/window";
import { LAPSE } from "../src/terrain/climate";
import { YEAR_S } from "../src/terrain/water";
import { diskStore } from "./globe-window";
import { heightColor, png } from "./globe-maps";

const arg = (name: string, d = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const T0 = performance.now(), log = (s: string) => console.error(`[${((performance.now() - T0) / 1000).toFixed(0).padStart(4)} s] ${s}`);
const DEG = Math.PI / 180;

// ---------- the design numbers ----------
const SMALL = 0.005; // [design] a landmass or sea body counted whole
const D_RANGE_SHARE = 0.5; // [design] a range is the ground over half its summit's height
const M_APART_M = 300_000, M_DISC_M = 20_000, M_RISE_M = 500; // [design]
const A_HIGH = [100, 800], A_INLAND_M = 20_000, A_T = [8, 26]; // [design] with the cited climate limits
const A_RAIN_BANDS = [4000, 2000, 1000]; // mm a year, wettest first: the forest provinces of the Holdridge precipitation axis, which doubles from 125 mm (rain, wet, moist)
const B_HIGH = [300, 1500], C_OPEN_M = 100_000; // [design]
const E_INLAND_M = 40_000, E_CORNER_M = 100_000; // [design]

// ---------- the grid ----------
const store = diskStore(arg("store", process.env.NOMADS_STORE ?? ""), arg("key"));
const bakeDir = arg("bake");
const seed = Number(arg("seed", "1"));
const outPrefix = arg("out", join(bakeDir || ".", "spots"));
const planet: Planet = await readPlanet(seed, store);
const R = planet.radius, g3 = tierGrid(3, R), g5 = tierGrid(5, R), g0 = tierGrid(0, R);
const FN = g3.fn, CELLS = FN * FN, N = FACES * CELLS, AREA_M2 = 4 * Math.PI * R * R;
log(`planet ${seed} read: radius ${(R / 1000).toFixed(1)} km${R === PLANET_RADIUS_M ? "" : " (not the 8192 x 75 m planet's)"}`);
const raw = (f: string) => { const b = readFileSync(join(bakeDir, f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const h = new Int32Array(raw("t3-height.i32"));
if (h.length !== N) throw new Error(`t3-height.i32 has ${h.length} cells, tier 3 of this planet has ${N}`);
const hm = (i: number) => h[i] / 256;

const faceOf = (i: number) => (i / CELLS) | 0;
const xyOf = (i: number): [number, number] => { const r = i - faceOf(i) * CELLS, Y = (r / FN) | 0; return [r - Y * FN, Y]; };
const U = (k: number) => Math.tan(((k + 0.5) / FN - 0.5) * (Math.PI / 2)); // the tangent at the centre of cell k along an axis, also beyond the face
const cellCentre = (i: number, out: Float64Array | number[] = new Float64Array(3)) => {
  const f = faceOf(i), [X, Y] = xyOf(i), u = g3.mid[X], v = g3.mid[Y], F = FRAMES[f], r = Math.sqrt(1 + u * u + v * v);
  out[0] = (F.n[0] + u * F.ex[0] + v * F.ey[0]) / r; out[1] = (F.n[1] + u * F.ex[1] + v * F.ey[1]) / r; out[2] = (F.n[2] + u * F.ex[2] + v * F.ey[2]) / r;
  return out;
};
const arc = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2], sx = a[0] + b[0], sy = a[1] + b[1], sz = a[2] + b[2];
  return 2 * Math.atan2(Math.hypot(dx, dy, dz), Math.hypot(sx, sy, sz));
};
const arcM = (a: ArrayLike<number>, b: ArrayLike<number>) => R * arc(a, b);
const ll = (p: ArrayLike<number>) => { const q = latLon([p[0], p[1], p[2]]); return { lat: q.lat / DEG, lon: q.lon / DEG }; };
const AREA = new Float64Array(CELLS); // m2 of the cell at (X, Y), the same on every face
for (let Y = 0; Y < FN; Y++) for (let X = 0; X < FN; X++) AREA[Y * FN + X] = areaSr(g3, X, Y) * R * R;
const areaOf = (i: number) => AREA[i - faceOf(i) * CELLS];

// The eight neighbours: 0 east, 1 north, 2 west, 3 south, then the diagonals (1, 1), (-1, 1), (-1, -1), (1, -1). Across a face edge the diagonal is the cell reached by either
// order of the two steps where both reach the same cell; at a cube's corner they differ and there is none (-1).
const DX = [1, 0, -1, 0, 1, -1, -1, 1], DY = [0, 1, 0, -1, 1, 1, -1, -1];
const stepId = (s: { face: number; X: number; Y: number }) => (s.face * FN + s.Y) * FN + s.X;
// The cell one step from (X, Y) on face f in direction d, and the step after it in direction e of the first cell's axes (turned with the edge it crossed).
function twice(f: number, X: number, Y: number, d: number, e: number): number {
  const s = step(g3, f, X, Y, d), t = step(g3, s.face, s.X, s.Y, (e + s.turn) & 3);
  return stepId(t);
}
function nbAt(i: number, f: number, X: number, Y: number, d: number): number {
  const x = X + DX[d], y = Y + DY[d];
  if (x >= 0 && x < FN && y >= 0 && y < FN) return i + DY[d] * FN + DX[d];
  if (d < 4) return stepId(step(g3, f, X, Y, d));
  const a = DX[d] > 0 ? 0 : 2, b = DY[d] > 0 ? 1 : 3, c1 = twice(f, X, Y, a, b), c2 = twice(f, X, Y, b, a);
  return c1 === c2 ? c1 : -1;
}
const nb = (i: number, d: number) => { const f = faceOf(i), [X, Y] = xyOf(i); return nbAt(i, f, X, Y, d); };

// ---------- bodies ----------
// Connected bodies (4 neighbours, or 8 with `eight`) of the cells where `mask` is set: each cell's root (-1 off the mask) and each root's area, m2.
function bodies(mask: (i: number) => boolean, eight = false): { root: Int32Array; area: Map<number, number> } {
  const parent = new Int32Array(N).fill(-1);
  const find = (a: number) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const join2 = (a: number, b: number) => { if (b < 0 || parent[b] < 0) return; const ra = find(a), rb = find(b); if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb; };
  for (let i = 0; i < N; i++) if (mask(i)) parent[i] = i;
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < FN; Y++)
      for (let X = 0; X < FN; X++) {
        const i = (f * FN + Y) * FN + X;
        if (parent[i] < 0) continue;
        if (X > 0 && Y > 0 && X < FN - 1 && Y < FN - 1) { join2(i, i + 1); join2(i, i + FN); if (eight) { join2(i, i + FN + 1); join2(i, i + FN - 1); } continue; }
        for (let d = 0; d < (eight ? 8 : 4); d++) join2(i, nbAt(i, f, X, Y, d));
      }
  const area = new Map<number, number>();
  for (let i = 0; i < N; i++) if (parent[i] >= 0) { const r = (parent[i] = find(i)); area.set(r, (area.get(r) ?? 0) + areaOf(i)); }
  return { root: parent, area };
}

// ---------- the shortest paths of cell steps ----------
// The great circle between a cell's centre and each of its eight neighbours' (the same on every face; a step across an edge takes the on-face continuation's).
const W = Array.from({ length: 8 }, () => new Float32Array(CELLS));
{
  const tan = new Float64Array(FN + 2), pt = (X: number, Y: number): V3 => pointOf(4, tan[X + 1], tan[Y + 1]);
  for (let k = -1; k <= FN; k++) tan[k + 1] = U(k);
  for (let Y = 0; Y < FN; Y++) for (let X = 0; X < FN; X++) { const p = pt(X, Y); for (let d = 0; d < 8; d++) W[d][Y * FN + X] = arcM(p, pt(X + DX[d], Y + DY[d])); }
}
// The steps that cross a face edge: from cell seamFrom[k] to seamTo[k], seamLen[k] m.
const seamFrom: number[] = [], seamTo: number[] = [], seamLen: number[] = [];
for (let f = 0; f < FACES; f++)
  for (let Y = 0; Y < FN; Y++)
    for (let X = 0; X < FN; X++) {
      if (X > 0 && Y > 0 && X < FN - 1 && Y < FN - 1) { X = FN - 2; continue; }
      const i = (f * FN + Y) * FN + X;
      for (let d = 0; d < 8; d++) { const j = nbAt(i, f, X, Y, d); if (j >= 0 && faceOf(j) !== f) { seamFrom.push(i); seamTo.push(j); seamLen.push(W[d][Y * FN + X]); } }
    }
// dist[i]: the length, m, of the shortest path of cell steps from a source (a cell of `src`, at 0) over the cells of `domain` (the cells the path may stand on), Infinity where none
// reaches. Sweeps over each face (forward and backward, as a chamfer transform) and across the face edges, repeated until nothing shortens.
function distance(src: Uint8Array, domain: Uint8Array): Float32Array {
  const dist = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < N; i++) if (src[i]) dist[i] = 0;
  let passes = 0;
  for (let changed = true; changed; passes++) {
    changed = false;
    for (let f = 0; f < FACES; f++) {
      const b = f * CELLS;
      for (let Y = 0; Y < FN; Y++)
        for (let X = 0; X < FN; X++) {
          const r = Y * FN + X, c = b + r;
          if (!domain[c]) continue;
          let best = dist[c];
          if (X > 0) best = Math.min(best, dist[c - 1] + W[2][r]);
          if (Y > 0) { best = Math.min(best, dist[c - FN] + W[3][r]); if (X > 0) best = Math.min(best, dist[c - FN - 1] + W[6][r]); if (X < FN - 1) best = Math.min(best, dist[c - FN + 1] + W[7][r]); }
          if (Math.fround(best) < dist[c]) { dist[c] = best; changed = true; }
        }
      for (let Y = FN - 1; Y >= 0; Y--)
        for (let X = FN - 1; X >= 0; X--) {
          const r = Y * FN + X, c = b + r;
          if (!domain[c]) continue;
          let best = dist[c];
          if (X < FN - 1) best = Math.min(best, dist[c + 1] + W[0][r]);
          if (Y < FN - 1) { best = Math.min(best, dist[c + FN] + W[1][r]); if (X < FN - 1) best = Math.min(best, dist[c + FN + 1] + W[4][r]); if (X > 0) best = Math.min(best, dist[c + FN - 1] + W[5][r]); }
          if (Math.fround(best) < dist[c]) { dist[c] = best; changed = true; }
        }
    }
    for (let k = 0; k < seamFrom.length; k++) {
      const a = seamFrom[k], c = seamTo[k];
      const nd = Math.fround(dist[a] + seamLen[k]);
      if (domain[c] && nd < dist[c]) { dist[c] = nd; changed = true; }
    }
  }
  log(`distance: ${passes} passes`);
  return dist;
}

// ---------- the sea, the landmasses, the distances ----------
const under = bodies((i) => h[i] <= 0, true);
const sea = new Uint8Array(N), hollows = { bodies: 0, biggestKm2: 0 };
for (let i = 0; i < N; i++) if (under.root[i] >= 0 && under.area.get(under.root[i])! >= SMALL * AREA_M2) sea[i] = 1;
for (const a of under.area.values()) if (a < SMALL * AREA_M2) { hollows.bodies++; hollows.biggestKm2 = Math.max(hollows.biggestKm2, Math.round(a / 1e6)); }
log(`sea: ${(100 * sea.reduce((s, x) => s + x, 0) / N).toFixed(1)}% of the cells, ${under.area.size - hollows.bodies} bodies; ${hollows.bodies} hollows under 0 m kept as land (the biggest ${hollows.biggestKm2} km2)`);
const isLand = (i: number) => !sea[i], isSea = (i: number) => sea[i] === 1;
const land = bodies(isLand);
const ranked = [...land.area.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
const rankOf = new Map(ranked.map(([r], k) => [r, k + 1]));
const landmassOf = (i: number) => land.root[i] < 0 ? 0 : rankOf.get(land.root[i])!;
const massAt = (rank: number) => ({ rank, areaKm2: Math.round(ranked[rank - 1][1] / 1e6), share: ranked[rank - 1][1] / AREA_M2 });
log(`landmasses: ${ranked.length}, the biggest ${(100 * ranked[0][1] / AREA_M2).toFixed(1)}% of the planet, ${ranked.filter((r) => r[1] >= SMALL * AREA_M2).length} of at least ${SMALL * 100}%`);
const big = (i: number) => land.area.get(land.root[i])! >= SMALL * AREA_M2;

const landMask = Uint8Array.from(sea, (s) => 1 - s), seaCoastMask = new Uint8Array(N), landCoastMask = new Uint8Array(N), landCoast: number[] = [];
for (let i = 0; i < N; i++) {
  const f = faceOf(i), [X, Y] = xyOf(i);
  for (let d = 0; d < 4; d++) {
    if (sea[nbAt(i, f, X, Y, d)] === sea[i]) continue;
    if (sea[i]) seaCoastMask[i] = 1; else { landCoastMask[i] = 1; landCoast.push(i); }
    break;
  }
}
const inland = distance(seaCoastMask, landMask);
log(`inland distance made (${landCoast.length} coast cells)`);
const offshore = distance(landCoastMask, sea);
log("distance from land made");

// ---------- the climate of a cell: tier 0 ----------
const n0 = planet.n;
const rain0 = new Float32Array(n0), runoff0 = new Float32Array(n0), t0 = new Float32Array(n0); // a year's rain and runoff, mm; the four seasons' mean sea-level air, C
for (const s of planet.seasons) for (let k = 0; k < n0; k++) { rain0[k] += s.rain[k]; runoff0[k] += s.runoff[k]; t0[k] += s.t[k] / planet.seasons.length; }
const tier0Of = (i: number) => { const f = faceOf(i), [X, Y] = xyOf(i); return (f * g0.fn + (Y >> 3)) * g0.fn + (X >> 3); };

// ---------- the places ----------
interface Spot {
  name: string; what: string; lat: number; lon: number; face: number;
  tier3: { X: number; Y: number }; tier5: { tx: number; ty: number; i: number; j: number; X: number; Y: number }; heightM: number;
  rule: string; numbers: Record<string, number | string | null>;
}
const spots: Spot[] = [];
function spotOf(name: string, what: string, p: ArrayLike<number>, rule: string, numbers: Spot["numbers"], i?: number): Spot {
  const q = locateVec(tierGrid(3, R), [p[0], p[1], p[2]]), cell = i ?? cellId(g3, q.face, q.X, q.Y), t5 = locateVec(g5, [p[0], p[1], p[2]]), { lat, lon } = ll(p);
  const s: Spot = { name, what, lat, lon, face: faceOf(cell), tier3: { X: xyOf(cell)[0], Y: xyOf(cell)[1] }, tier5: { tx: t5.tx, ty: t5.ty, i: t5.i, j: t5.j, X: t5.X, Y: t5.Y }, heightM: hm(cell), rule, numbers };
  spots.push(s);
  return s;
}
const cellSpot = (name: string, what: string, i: number, rule: string, numbers: Spot["numbers"]) => spotOf(name, what, cellCentre(i, [0, 0, 0]), rule, numbers, i);
const km = (m: number) => Math.round(m / 100) / 10;
const near = (a: ArrayLike<number>, i: number) => arcM(a, cellCentre(i, [0, 0, 0]));

// the ground with the sea at 0, for the picks over land
// D
let D = -1;
for (let i = 0; i < N; i++) if (h[i] > 0 && (D < 0 || h[i] > h[D])) D = i;
{
  const seen = new Set<number>([D]), q = [D];
  let area = 0, lo = 0;
  while (lo < q.length) { const c = q[lo++]; area += areaOf(c); for (let d = 0; d < 4; d++) { const j = nb(c, d); if (!seen.has(j) && h[j] >= D_RANGE_SHARE * h[D]) { seen.add(j); q.push(j); } } }
  cellSpot("D", "highest range", D, "the highest tier-3 summit", { summitM: hm(D), rangeCells: q.length, rangeAreaKm2: Math.round(area / 1e6), rangeOverHalfM: D_RANGE_SHARE * hm(D), landmass: landmassOf(D) });
}

// M
const stamp = new Int32Array(N);
let stampId = 0;
// The cells within `radiusM` of cell i0's centre (4-neighbour spread), each given to visit; visit returns true to stop.
function disc(i0: number, radiusM: number, visit: (j: number) => boolean | void): void {
  const c0 = cellCentre(i0, [0, 0, 0]), cos = Math.cos(radiusM / R), q: number[] = [i0], c = [0, 0, 0];
  stamp[i0] = ++stampId;
  for (let a = 0; a < q.length; a++) {
    if (visit(q[a])) return;
    for (let d = 0; d < 4; d++) {
      const j = nb(q[a], d);
      if (stamp[j] === stampId) continue;
      stamp[j] = stampId;
      cellCentre(j, c);
      if (c0[0] * c[0] + c0[1] * c[1] + c0[2] * c[2] >= cos) q.push(j);
    }
  }
}
{
  const dc = cellCentre(D, [0, 0, 0]), K = 33554432;
  let count = 0;
  for (let i = 0; i < N; i++) if (h[i] > 0) count++;
  const keys = new Float64Array(count);
  for (let i = 0, k = 0; i < N; i++) if (h[i] > 0) keys[k++] = h[i] * K + i;
  keys.sort();
  let found = -1, tried = 0, rise = 0, mean = 0;
  for (let k = keys.length - 1; k >= 0 && found < 0; k--) {
    const i = keys[k] % K, c = cellCentre(i, [0, 0, 0]);
    if (arcM(dc, c) < M_APART_M) continue;
    tried++;
    let top = true, sum = 0, n = 0;
    disc(i, M_DISC_M, (j) => { if (h[j] > h[i] || (h[j] === h[i] && j < i)) { top = false; return true; } sum += Math.max(0, h[j]) / 256; n++; });
    if (!top) continue;
    mean = sum / n; rise = hm(i) - mean;
    if (rise >= M_RISE_M) found = i;
  }
  cellSpot("M", "isolated mountain", found, `the highest summit over ${M_APART_M / 1000} km from D, highest within ${M_DISC_M / 1000} km, ${M_RISE_M} m over that disc's mean ground`, { summitM: hm(found), riseOverDiscMeanM: Math.round(rise), discMeanM: Math.round(mean), kmFromD: km(arcM(dc, cellCentre(found, [0, 0, 0]))), candidatesTried: tried, landmass: landmassOf(found) });
}

// R: the flow. The receivers are the bake's t3-to.u32 (or the file `bun scripts/globe-water.ts --stage flow --tier 3` makes from t3-height.i32 into a bake dir of one's own: the same bytes, checked on this
// planet's carry). The discharge is the bake's t3-acc.u32 where there is one: the tier chain routes with one reference rain on every cell, so it is the catchment's area in a fixed unit (checked below:
// its ratio to the catchment's area at the mouths); where there is none the catchment's area, summed down the receivers, stands in and ranks the same.
const toPath = join(bakeDir, "t3-to.u32");
if (!existsSync(toPath)) throw new Error(`${toPath} is missing: make it with NOMADS_STORE=<store> NOMADS_BAKE=<a dir of your own holding <seed>-<key>/t3-height.i32> bun scripts/globe-water.ts --stage flow --tier 3 --seed ${seed} --key ${arg("key")}`);
const to = new Uint32Array(raw("t3-to.u32"));
// Sum along the receivers from the cells upstream, over land (a chain stops where the receiver is not land).
function accumulate(recv: ArrayLike<number>, weight: (i: number) => number): Float64Array {
  const out = new Float64Array(N), into = new Uint8Array(N), queue = new Int32Array(N);
  for (let i = 0; i < N; i++) if (isLand(i)) { out[i] = weight(i); const j = recv[i]; if (j !== i && isLand(j)) into[j]++; }
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) if (isLand(i) && into[i] === 0) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++], j = recv[i];
    if (j === i || !isLand(j)) continue;
    out[j] += out[i];
    if (--into[j] === 0) queue[tail++] = j;
  }
  return out;
}
const catchment = accumulate(to, areaOf); // m2 of land draining to the cell, the cell included
// The discharge: the mean flow, m3/s, of the year's runoff (the planet's four seasons, tier 0, mm) off each cell's area, summed down the receivers. The bake's t3-acc is the catchment's area at one reference rain on
// every cell, in a fixed unit (checked below at the mouths), so it is a catchment's size and not a river's flow; it is shown beside the flow.
const discharge = accumulate(to, (i) => (areaOf(i) * runoff0[tier0Of(i)]) / 1000 / YEAR_S);
const storedAcc = existsSync(join(bakeDir, "t3-acc.u32")) ? new Uint32Array(raw("t3-acc.u32")) : null;
const acc = discharge;
const flowSource = `receivers: t3-to.u32; discharge: the year's runoff of tier 0 summed down them (m3/s)${storedAcc ? "; t3-acc.u32 checked and shown" : ""}`;
let mouth = -1, mouths = 0, accTotal = 0, areaMouth = -1;
for (let i = 0; i < N; i++)
  if (h[i] > 0 && h[to[i]] <= 0) {
    mouths++; accTotal += acc[i];
    if (mouth < 0 || acc[i] > acc[mouth]) mouth = i;
    if (areaMouth < 0 || catchment[i] > catchment[areaMouth]) areaMouth = i;
  }
if (storedAcc) {
  const ratio: number[] = [];
  for (let i = 0; i < N; i++) if (h[i] > 0 && h[to[i]] <= 0 && storedAcc[i] > 2e5) ratio.push((1e6 * storedAcc[i]) / catchment[i]);
  ratio.sort((a, b) => a - b);
  log(`t3-acc per km2 of catchment over ${ratio.length} mouths of acc over 2e5: lowest ${ratio[0].toFixed(1)}, median ${ratio[ratio.length >> 1].toFixed(1)}, highest ${ratio[ratio.length - 1].toFixed(1)}`);
}
log(`flow: ${flowSource}`);
{
  let cur = mouth, len = 0, half = -1, halfLen = 0;
  const c1 = [0, 0, 0], c2 = [0, 0, 0];
  for (;;) {
    let best = -1;
    for (let d = 0; d < 8; d++) {
      const j = nb(cur, d);
      if (j < 0 || !isLand(j) || to[j] !== cur || j === cur) continue;
      if (best < 0 || acc[j] > acc[best] || (acc[j] === acc[best] && j < best)) best = j;
    }
    if (best < 0) break;
    len += arcM(cellCentre(cur, c1), cellCentre(best, c2));
    cur = best;
    if (half < 0 && acc[cur] < acc[mouth] / 2) { half = cur; halfLen = len; }
  }
  const head = cur, hd = cellCentre(head, [0, 0, 0]), halfAt = half < 0 ? null : ll(cellCentre(half, [0, 0, 0])), areaAt = ll(cellCentre(areaMouth, [0, 0, 0]));
  cellSpot("R", "biggest river, mouth", mouth, "the largest mean discharge (the year's runoff summed down the tier-3 receivers) at a land cell whose receiver is at or under 0 m (where the flow ends: its own sea)", {
    dischargeM3s: Math.round(acc[mouth]), shareOfAllMouths: Math.round((1e4 * acc[mouth]) / accTotal) / 1e4, catchmentKm2: Math.round(catchment[mouth] / 1e6), t3AccAtMouth: storedAcc ? storedAcc[mouth] : null, mouthsCounted: mouths,
    seaBodyKm2: Math.round(under.area.get(under.root[to[mouth]])! / 1e6), stemKm: km(len), stemToHalfKm: km(halfLen), flow: flowSource, landmass: landmassOf(mouth),
    halfLat: halfAt && halfAt.lat, halfLon: halfAt && halfAt.lon, dischargeAtHalfM3s: half < 0 ? null : Math.round(acc[half]),
    headLat: ll(hd).lat, headLon: ll(hd).lon, headHeightM: hm(head), dischargeAtHeadM3s: Math.round(acc[head]),
    biggestCatchmentLat: areaAt.lat, biggestCatchmentLon: areaAt.lon, biggestCatchmentKm2: Math.round(catchment[areaMouth] / 1e6), dischargeThereM3s: Math.round(acc[areaMouth]), sameMouth: String(areaMouth === mouth),
  });
  if (half >= 0) cellSpot("R-half", "biggest river, half-discharge point on its stem", half, "walking upstream from the mouth by the donor of the largest discharge, the first cell under half the mouth's", { dischargeM3s: Math.round(acc[half]), halfOfMouth: Math.round((1e3 * acc[half]) / acc[mouth]) / 1e3, kmFromMouth: km(halfLen), catchmentKm2: Math.round(catchment[half] / 1e6) });
}

// Home
let landings = landingsOf(planet, 10), homeRule: string, reliefDropped = false;
const given = arg("home");
if (!given && landings.length === 0) { // no cell holds ground over RELIEF_M next to the sea: rank by the highest ground the other four measures leave
  const floor = LANDING.reliefM, passed = landingCounts.join(" ");
  LANDING.reliefM = 0;
  landings = landingsOf(planet, 10);
  LANDING.reliefM = floor;
  reliefDropped = true;
  log(`no landing: cells passing each measure in turn (off poles, sea, relief, river, rain, no ice) ${passed}; relief dropped`);
}
const L1 = landings[0] ?? null;
const [homeLat, homeLon] = given ? given.split(",").map(Number) : [L1!.latDeg, L1!.lonDeg];
const homeVec = [Math.cos(homeLat * DEG) * Math.cos(homeLon * DEG), Math.cos(homeLat * DEG) * Math.sin(homeLon * DEG), Math.sin(homeLat * DEG)];
const homeCell = (() => { const q = locateVec(g3, homeVec as unknown as V3); return cellId(g3, q.face, q.X, q.Y); })();
homeRule = given ? "given with --home (the page's start place: tier-0 land cell with the most tree cover under 60 degrees of latitude, from the ground tiles)"
  : `landing 1 of landingsOf: sea, ${reliefDropped ? "no relief floor (none passes the 1 km one)" : "ground over 1 km"}, a river of 5 m3/s and 500 mm of rain, no ice, highest ground first`;
spotOf("home", "the home island", homeVec, homeRule, {
  ...(given || !L1 ? {} : { summitInReachM: Math.round(L1.summitM), seaShare: Math.round(1e3 * L1.seaShare) / 1e3, riverM3s: Math.round(L1.riverM3s * 10) / 10, rainMm: Math.round(L1.rainMm), tC: Math.round(L1.tC * 10) / 10, glaciated: String(L1.glaciated), landingsFound: landings.length,
    nextLandings: landings.slice(1, 4).map((l) => `${l.latDeg.toFixed(2)},${l.lonDeg.toFixed(2)} (${Math.round(l.summitM)} m)`).join("; ") }),
  landmass: landmassOf(homeCell), tier0RainMm: Math.round(rain0[tier0Of(homeCell)]), tier0TempC: Math.round(10 * (t0[tier0Of(homeCell)] - LAPSE * Math.max(0, hm(homeCell)))) / 10,
}, homeCell);
const homeMass = landmassOf(homeCell);
const nearHome = (i: number) => near(homeVec, i);

// E2
{
  let best = -1, bestD = Infinity, bestP: number[] = [], seen = 0, bestN: Record<string, number | string> = {};
  const corners: number[][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx / Math.sqrt(3), sy / Math.sqrt(3), sz / Math.sqrt(3)]);
  for (let f = 0; f < FACES; f++)
    for (let s = 0; s < 4; s++)
      for (let a = 0; a < FN; a++) {
        const X = s === 0 ? FN - 1 : s === 2 ? 0 : a, Y = s === 1 ? FN - 1 : s === 3 ? 0 : a, i = (f * FN + Y) * FN + X, j = nbAt(i, f, X, Y, s);
        if (!isLand(i) || !isLand(j) || !(inland[i] >= E_INLAND_M) || !(inland[j] >= E_INLAND_M)) continue;
        const i0 = s === 0 ? FN : s === 2 ? 0 : X, j0 = s === 1 ? FN : s === 3 ? 0 : Y;
        const v0 = pointOf(f, g3.node[i0], g3.node[j0]), v1 = s & 1 ? pointOf(f, g3.node[i0 + 1], g3.node[j0]) : pointOf(f, g3.node[i0], g3.node[j0 + 1]);
        const m = [v0[0] + v1[0], v0[1] + v1[1], v0[2] + v1[2]], r = Math.hypot(m[0], m[1], m[2]), p = [m[0] / r, m[1] / r, m[2] / r];
        const corner = Math.min(...corners.map((c) => arcM(p, c)));
        if (corner < E_CORNER_M) continue;
        seen++;
        const d = arcM(p, homeVec);
        if (d < bestD) { bestD = d; best = i; bestP = p; bestN = { cornerKm: km(corner), faceAcross: faceOf(j), inlandKmThisFace: km(inland[i]), inlandKmOtherFace: km(inland[j]), heightAcrossM: hm(j) }; }
      }
  if (best >= 0) spotOf("E2", "cube-face edge on land", bestP, `the edge point (midpoint of two edge cells' shared side) on land, over ${E_INLAND_M / 1000} km inland and ${E_CORNER_M / 1000} km from every cube corner, nearest home`, { kmFromHome: km(bestD), edgeCellsPassing: seen, ...bestN }, best);
}

// A: the closed-forest climate, in the wettest class that holds a forest the size of a window
const forestCell = (i: number) => {
  const z = hm(i);
  if (!isLand(i) || z < A_HIGH[0] || z > A_HIGH[1] || !(inland[i] >= A_INLAND_M) || !big(i)) return false;
  const t = t0[tier0Of(i)] - LAPSE * z;
  return t >= A_T[0] && t <= A_T[1];
};
let A = -1;
{
  const forestCells = new Uint8Array(N);
  let count = 0;
  for (let i = 0; i < N; i++) if (forestCell(i)) { forestCells[i] = 1; count++; }
  log(`forest cells before the rain test (land, ${A_HIGH[0]} to ${A_HIGH[1]} m, ${A_INLAND_M / 1000} km inland, big landmass, ${A_T[0]} to ${A_T[1]} C): ${count}`);
  for (const lower of A_RAIN_BANDS) {
    const mask = new Uint8Array(N), ring = new Uint8Array(N);
    let cells = 0;
    for (let i = 0; i < N; i++) if (forestCells[i] && rain0[tier0Of(i)] >= lower) { mask[i] = 1; cells++; }
    if (cells === 0) { log(`rain over ${lower} mm: no cell`); continue; }
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const f = faceOf(i), [X, Y] = xyOf(i);
      for (let d = 0; d < 4; d++) { const j = nbAt(i, f, X, Y, d); if (!mask[j]) ring[j] = 1; }
    }
    const depth = distance(ring, mask), sel = bodies((i) => mask[i] === 1), deepest = new Map<number, number>();
    for (let i = 0; i < N; i++) if (mask[i]) { const r = sel.root[i], b = deepest.get(r); if (b === undefined || depth[i] > depth[b]) deepest.set(r, i); }
    let top = -1, whole = 0;
    for (const [r, i] of deepest) {
      if (depth[i] < WINDOW_M / 2) continue;
      whole++;
      if (top < 0 || sel.area.get(r)! > sel.area.get(sel.root[top])! || (sel.area.get(r)! === sel.area.get(sel.root[top])! && r < sel.root[top])) top = i;
    }
    log(`rain over ${lower} mm: ${cells} cells in ${deepest.size} regions, ${whole} hold a whole window`);
    if (top < 0) continue;
    A = top;
    let n = 0, sx = 0, sy = 0, sz = 0, rainSum = 0, tSum = 0, zSum = 0;
    const c = [0, 0, 0], root = sel.root[A];
    for (let i = 0; i < N; i++) if (sel.root[i] === root) { n++; cellCentre(i, c); sx += c[0]; sy += c[1]; sz += c[2]; rainSum += rain0[tier0Of(i)]; tSum += t0[tier0Of(i)] - LAPSE * hm(i); zSum += hm(i); }
    cellSpot("A", "forest", A, `the deepest cell of the largest 4-connected region of land ${A_HIGH[0]} to ${A_HIGH[1]} m high, ${A_INLAND_M / 1000} km inland, on a landmass of at least ${SMALL * 100}%, mean air ${A_T[0]} to ${A_T[1]} C, in the wettest rain class (over ${lower} mm a year) that has a region with a whole window (${WINDOW_M / 1000} km) of forest about a cell`, {
      rainClassOverMm: lower, rainMm: Math.round(rain0[tier0Of(A)]), meanTempC: Math.round(10 * (t0[tier0Of(A)] - LAPSE * hm(A))) / 10, regionAreaKm2: Math.round(sel.area.get(root)! / 1e6), regionCells: n, regions: deepest.size, regionsWithAWindow: whole,
      depthKm: km(depth[A]), regionMeanRainMm: Math.round(rainSum / n), regionMeanTempC: Math.round((10 * tSum) / n) / 10, regionMeanHeightM: Math.round(zSum / n), landmass: landmassOf(A), centroidLat: ll([sx, sy, sz]).lat, centroidLon: ll([sx, sy, sz]).lon,
    });
    break;
  }
  if (A < 0) throw new Error("A: no closed-forest region holds a window");
}
const aMass = landmassOf(A), aVec = cellCentre(A, [0, 0, 0]);

// B
{
  let best = -1, bd = Infinity, n = 0;
  for (let i = 0; i < N; i++) {
    const z = hm(i);
    if (!isLand(i) || z < B_HIGH[0] || z > B_HIGH[1] || !(inland[i] >= A_INLAND_M) || !big(i)) continue;
    const m = landmassOf(i);
    if (m === aMass || m === homeMass) continue;
    n++;
    const d = nearHome(i);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) cellSpot("B", "land on another landmass", best, `land ${B_HIGH[0]} to ${B_HIGH[1]} m high, ${A_INLAND_M / 1000} km inland, on a landmass of at least ${SMALL * 100}% that is neither A's nor home's, nearest home`, { kmFromHome: km(bd), cellsPassing: n, landmass: landmassOf(best), landmassAreaKm2: massAt(landmassOf(best)).areaKm2, inlandKm: km(inland[best]) });
}
// C
{
  let best = -1, bd = Infinity, n = 0;
  for (let i = 0; i < N; i++) {
    if (!isSea(i) || offshore[i] < C_OPEN_M) continue;
    n++;
    const d = nearHome(i);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) cellSpot("C", "open sea", best, `sea at least ${C_OPEN_M / 1000} km from any land, nearest home`, { kmFromHome: km(bd), cellsPassing: n, depthM: Math.round(hm(best)) });
}
// K3
{
  let best = -1, bd = Infinity, n = 0;
  for (const i of landCoast) {
    if (landmassOf(i) !== homeMass) continue;
    n++;
    const d = near(aVec, i);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) cellSpot("K3", "coast of the home landmass", best, "a land cell with a sea cell next to it on the landmass that holds home, nearest A", { kmFromA: km(bd), coastCells: n, landmass: homeMass, aLandmass: aMass, sameLandmassAsA: String(aMass === homeMass) });
}

// The same places in coordinates given with --old "A=lat,lon;B=lat,lon;...": each one's distance from the pick and what the ground is there, to tell whether they are the same feature.
interface Compare { name: string; lat: number; lon: number; pickKm: number; heightM: number; rainMm: number; meanTempC: number; landmass: number; inlandKm: number | null; offshoreKm: number | null; river20KmShareOfPick: number | null }
const compare: Compare[] = [];
for (const item of arg("old").split(";").filter(Boolean)) {
  const [name, pos] = item.split("="), [la, lo] = pos.split(",").map(Number), pick = spots.find((s) => s.name === name);
  if (!pick) continue;
  const v = fromLatLon(la * DEG, lo * DEG), q = locateVec(g3, v), i = cellId(g3, q.face, q.X, q.Y), k = tier0Of(i);
  let river = 0;
  if (name === "R") disc(i, M_DISC_M, (j) => { if (isLand(j) && acc[j] > river) river = acc[j]; });
  compare.push({
    name, lat: la, lon: lo, pickKm: km(arcM(v, fromLatLon(pick.lat * DEG, pick.lon * DEG))), heightM: Math.round(hm(i)), rainMm: Math.round(rain0[k]), meanTempC: Math.round(10 * (t0[k] - LAPSE * Math.max(0, hm(i)))) / 10, landmass: landmassOf(i),
    inlandKm: isLand(i) ? km(inland[i]) : null, offshoreKm: isSea(i) ? km(offshore[i]) : null, river20KmShareOfPick: name === "R" ? Math.round((1e3 * river) / acc[mouth]) / 1e3 : null,
  });
}

// ---------- the table ----------
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const rows = spots.map((s) => [s.name, s.lat.toFixed(2), s.lon.toFixed(2), String(s.face), `${s.tier5.tx},${s.tier5.ty}`, `${s.tier5.i},${s.tier5.j}`, `${Math.round(s.heightM)}`, s.rule]);
const head = ["name", "lat", "lon", "face", "t5 tile tx,ty", "cell i,j", "h3 m", "rule"];
const widths = head.map((hd, k) => Math.max(hd.length, ...rows.map((r) => (k < 7 ? r[k].length : 0))));
const table = [head, ...rows].map((r) => r.map((c, k) => (k < 7 ? pad(c, widths[k]) : c)).join("  ")).join("\n");
const numbers = spots.map((s) => `${s.name}: ${Object.entries(s.numbers).map(([k, v]) => `${k} ${v}`).join(", ")}`).join("\n");
const md = [
  `# Spots of planet ${seed}-${arg("key")}`, "", `Bake ${bakeDir}, store ${arg("store", process.env.NOMADS_STORE ?? "")}. Flow: ${flowSource}.`, "",
  "| name | what | lat | lon | face | t5 tile (tx, ty) | t5 cell (i, j) | tier-3 height m | rule |", "|---|---|---|---|---|---|---|---|---|",
  ...spots.map((s) => `| ${s.name} | ${s.what} | ${s.lat.toFixed(3)} | ${s.lon.toFixed(3)} | ${s.face} | ${s.tier5.tx}, ${s.tier5.ty} | ${s.tier5.i}, ${s.tier5.j} | ${s.heightM.toFixed(1)} | ${s.rule} |`),
  "", "## Numbers behind each pick", "", ...spots.map((s) => `- **${s.name}**: ${Object.entries(s.numbers).map(([k, v]) => `${k} ${v}`).join(", ")}`), "",
  ...(compare.length ? ["## The given coordinates against the picks", "", "| name | given lat, lon | km from the pick | height m | rain mm | mean air C | landmass | inland km | offshore km | river within 20 km, share of the pick's |", "|---|---|---|---|---|---|---|---|---|---|",
    ...compare.map((c) => `| ${c.name} | ${c.lat}, ${c.lon} | ${c.pickKm} | ${c.heightM} | ${c.rainMm} | ${c.meanTempC} | ${c.landmass} | ${c.inlandKm ?? ""} | ${c.offshoreKm ?? ""} | ${c.river20KmShareOfPick ?? ""} |`), ""] : []),
].join("\n");
console.log(table + "\n\n" + numbers + (compare.length ? "\n\ngiven coordinates:\n" + compare.map((c) => JSON.stringify(c)).join("\n") : ""));
writeFileSync(`${outPrefix}.json`, JSON.stringify({ seed, key: arg("key"), radiusM: R, flow: flowSource, landmasses: ranked.slice(0, 12).map(([, a], k) => ({ rank: k + 1, areaKm2: Math.round(a / 1e6), share: Math.round(1e4 * a / AREA_M2) / 1e4 })), spots, compare }, null, 1));
writeFileSync(`${outPrefix}.md`, md);

// ---------- the map ----------
const GLYPH: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"], B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."], C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."], E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"], H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"], M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"], R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"], "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
};
{
  const W2 = 2048, H2 = 1024, rgb = new Uint8Array(W2 * H2 * 3);
  for (let y = 0; y < H2; y++) {
    const lat = (0.5 - (y + 0.5) / H2) * Math.PI;
    for (let x = 0; x < W2; x++) {
      const lon = ((x + 0.5) / W2 - 0.5) * 2 * Math.PI, p = locateVec(g3, [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]), i = cellId(g3, p.face, p.X, p.Y), c = heightColor(sea[i] ? Math.min(hm(i), -1) : Math.max(hm(i), 1)), o = (y * W2 + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  const px = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W2 || y >= H2) return; const o = (y * W2 + x) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; };
  const COLOUR: Record<string, number[]> = { A: [0, 120, 0], B: [200, 120, 0], C: [0, 60, 200], D: [200, 0, 0], M: [200, 0, 120], R: [0, 140, 200], "R-half": [0, 140, 200], home: [0, 0, 0], E2: [120, 0, 200], K3: [90, 60, 0] };
  const LABEL: Record<string, string> = { home: "H", "R-half": "", E2: "E2", K3: "K3" };
  for (const s of spots) {
    const x = Math.round(((s.lon / 360) + 0.5) * W2 - 0.5), y = Math.round((0.5 - s.lat / 180) * H2 - 0.5), col = COLOUR[s.name] ?? [0, 0, 0], r = s.name === "R-half" ? 3 : 6;
    for (let dy = -r - 1; dy <= r + 1; dy++) for (let dx = -r - 1; dx <= r + 1; dx++) { const d = Math.hypot(dx, dy); if (d <= r + 1 && d > r - 1) px(x + dx, y + dy, d > r ? [255, 255, 255] : col); }
    const text = LABEL[s.name] ?? s.name;
    let ox = x + r + 4;
    for (const ch of text) {
      const gl = GLYPH[ch];
      if (!gl) continue;
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (gl[gy][gx] === "#") for (let sy = 0; sy < 2; sy++) for (let sx2 = 0; sx2 < 2; sx2++) {
        for (const [ex, ey] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) px(ox + gx * 2 + sx2 + ex, y - 7 + gy * 2 + sy + ey, [255, 255, 255]);
      }
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (gl[gy][gx] === "#") for (let sy = 0; sy < 2; sy++) for (let sx2 = 0; sx2 < 2; sx2++) px(ox + gx * 2 + sx2, y - 7 + gy * 2 + sy, col);
      ox += 12;
    }
  }
  writeFileSync(`${outPrefix}.png`, png(W2, H2, rgb));
}
log(`wrote ${outPrefix}.json, .md, .png`);

