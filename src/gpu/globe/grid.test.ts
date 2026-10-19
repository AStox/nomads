// The globe's sphere grid (grid.ts, wgsl/globe-grid.ts), tested one case at a time:
//   bun test ./src/gpu/globe/grid.test.ts -t "areas" --timeout 280000
// The geometry cases need no GPU; the halo, gradient and diffusion cases run the kernels and compare them bit for bit with
// their TypeScript twins. The measured numbers the cases state are in docs/research/globe/2026-10-19-grid.md.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import {
  EDGES, FACES, FRAMES, GlobeGpu, HALO, NEIGHBOURS8, PAD_WORDS, RADIUS_M, STATE, TAB, TILE, areaStats, areaSr, buildTables, cellId, cellWidthM, centre, eastNorth,
  fieldWords, fluxTwin, foOf, fromLatLon, gradientTwin, gradientWeights, haloSource, haloTwin, latLon, linkFloat, locate, locateVec, makeGrid, meanCellM, padded,
  planet, pointAt, slotOf, step, tierGrid, tileCount, totalMass, vertex, vertexWeights, wordAt, type Grid, type Tables, type V3,
} from "./grid";

afterAll(releaseGpu);

// A small deterministic stream of numbers in [0, 1).
function stream(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
}
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const hash = (a: Int32Array | Uint8Array) => new Bun.CryptoHasher("sha256").update(a).digest("hex");

let tab0: Tables | undefined;
const tables0 = () => (tab0 ??= buildTables(tierGrid(0)));

// ---- the planet ----
test("the planet's size and the grid's cell sizes follow from the radius", () => {
  const p = planet();
  expect(RADIUS_M).toBe(2_000_000);
  expect(p.area).toBeCloseTo(4 * Math.PI * 4e12, -3);
  expect(p.circumference).toBeCloseTo(2 * Math.PI * 2e6, 3);
  const g0 = tierGrid(0), g1 = tierGrid(1), g7 = tierGrid(7);
  expect(g0.fn).toBe(256);
  expect(g0.tiles).toBe(1);
  expect(g1.fn).toBe(512);
  expect(g1.tiles).toBe(2);
  // at the face's centre a tier-0 cell is a quarter circle over 256: 12.27 km; the side of a square of the mean cell's area is 11.31 km
  expect(cellWidthM(g0)).toBeCloseTo(((Math.PI / 2) * 2e6) / 256, 6);
  expect(cellWidthM(g0)).toBeGreaterThan(12_200);
  expect(cellWidthM(g0)).toBeLessThan(12_300);
  expect(meanCellM(g0)).toBeCloseTo(Math.sqrt((4 * Math.PI * 4e12) / (6 * 256 * 256)), 6);
  expect(meanCellM(g0)).toBeGreaterThan(11_300);
  expect(meanCellM(g0)).toBeLessThan(11_320);
  // each tier halves the cell
  expect(cellWidthM(g1)).toBeCloseTo(cellWidthM(g0) / 2, 9);
  expect(cellWidthM(g7)).toBeCloseTo(cellWidthM(g0) / 128, 9);
  // a planet of another radius scales everything and not the grid's shape
  const half = tierGrid(0, 1_000_000);
  expect(cellWidthM(half)).toBeCloseTo(cellWidthM(g0) / 2, 9);
  expect(foOf(g0, 1, 1)).toBeCloseTo(1 / ((4 * Math.PI * 4e12) / (6 * 256 * 256)), 20);
});

// ---- areas ----
test("areas sum to 4 pi R squared within the tabulated tolerance, and the distortion is the equiangular map's", () => {
  // Tolerances [derived]: the float sum of one face's fn^2 cells, six times, each cell's area carrying an error of a few units in
  // the last place of the corner terms (0.5 or so): the sum's relative error is under 6 fn^2 2^-52 / (4 pi). The integer weights
  // (Q15 of the mean area) each round by at most half a unit, so their sum is within 2^-16 of the sphere's at worst.
  for (const fn of [32, 64, 128, 256, 512]) {
    const s = areaStats(makeGrid(fn));
    expect(s.relError).toBeLessThan((6 * fn * fn * 2 ** -52) / (4 * Math.PI));
    expect(s.weightRelError).toBeLessThan(2 ** -16);
    // the area ratio of the largest cell (the face's centre) to the smallest (the edge's midpoint) tends to sqrt 2 from below
    expect(s.ratio).toBeLessThan(Math.SQRT2);
    expect(s.ratio).toBeGreaterThan(1.37);
  }
  // R squared: 4 pi R^2 in m2
  const g = tierGrid(0);
  let sum = 0;
  for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) sum += areaSr(g, X, Y) * g.radius * g.radius;
  expect(Math.abs(FACES * sum - planet().area) / planet().area).toBeLessThan(1e-12);
  // the plain gnomonic map (equal steps of the tangent, not of the angle), which this grid does not use: the ratio is over five
  const fn = 256, t = (i: number) => -1 + (2 * i) / fn, F = (u: number, v: number) => Math.atan2(u * v, Math.sqrt(1 + u * u + v * v));
  let lo = Infinity, hi = 0;
  for (let X = 0; X < fn; X++) for (let Y = 0; Y < fn; Y++) {
    const a = F(t(X + 1), t(Y + 1)) - F(t(X), t(Y + 1)) - F(t(X + 1), t(Y)) + F(t(X), t(Y));
    lo = Math.min(lo, a); hi = Math.max(hi, a);
  }
  expect(hi / lo).toBeGreaterThan(5);
});

test("the integer area weights of the tables sum to 4 pi and stay under 2^16", () => {
  const tab = tables0(), unitSr = (2 * Math.PI) / 3 / (256 * 256) / 2 ** 15;
  let sum = 0;
  for (let c = 0; c < tab.tw; c++) sum += tab.words[TAB.A * tab.tw + c];
  expect(Math.abs(sum * unitSr - 4 * Math.PI) / (4 * Math.PI)).toBeLessThan(2 ** -16);
  expect(tab.maxArea).toBeLessThan(65536);
  expect(tab.maxArea).toBeGreaterThan(38000);
});

// ---- lookup ----
test("lat lon to cell to lat lon round trip is exact for cells and 1e-14 for points", () => {
  const g = tierGrid(0);
  // every cell: its centre's lat/lon finds the cell, at the middle of it
  let worstFrac = 0;
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) {
        const { lat, lon } = latLon(centre(g, f, X, Y)), p = locate(g, lat, lon);
        if (p.face !== f || p.X !== X || p.Y !== Y) throw new Error(`cell ${f},${X},${Y} found as ${p.face},${p.X},${p.Y}`);
        worstFrac = Math.max(worstFrac, Math.abs(p.fx - 0.5), Math.abs(p.fy - 0.5));
      }
  expect(worstFrac).toBeLessThan(1e-9);
  // random points: the cell holds the point (fractions in [0, 1]) and the point comes back
  const rnd = stream(7);
  let worstXyz = 0, worstLat = 0, worstLon = 0;
  for (let k = 0; k < 200_000; k++) {
    const lat = Math.asin(2 * rnd() - 1), lon = (2 * rnd() - 1) * Math.PI;
    const p = locate(g, lat, lon);
    expect(p.fx).toBeGreaterThanOrEqual(0); expect(p.fx).toBeLessThanOrEqual(1);
    expect(p.fy).toBeGreaterThanOrEqual(0); expect(p.fy).toBeLessThanOrEqual(1);
    expect(p.tx).toBe(p.X >> 8); expect(p.i).toBe(p.X & 255);
    const back = pointAt(g, p.face, p.X, p.Y, p.fx, p.fy), ll = latLon(back);
    worstXyz = Math.max(worstXyz, dist(back, fromLatLon(lat, lon)));
    worstLat = Math.max(worstLat, Math.abs(ll.lat - lat));
    worstLon = Math.max(worstLon, Math.abs(Math.atan2(Math.sin(ll.lon - lon), Math.cos(ll.lon - lon))) * Math.cos(lat));
  }
  expect(worstXyz).toBeLessThan(1e-14);
  expect(worstLat).toBeLessThan(1e-14);
  expect(worstLon).toBeLessThan(1e-14);
  // points on the 12 edges and at the 8 corners (and just either side) land in a cell and come back
  const corners: V3[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz]);
  const onEdges: V3[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const t of [-0.9, -0.3, 0, 0.4, 0.99]) onEdges.push([a, b, t], [a, t, b], [t, a, b]);
  for (const v of [...corners, ...onEdges]) {
    const m = Math.hypot(...v);
    for (const jitter of [0, 1e-12, -1e-12]) {
      const p0: V3 = [v[0] / m + jitter, v[1] / m, v[2] / m], mm = Math.hypot(...p0), p: V3 = [p0[0] / mm, p0[1] / mm, p0[2] / mm];
      const c = locateVec(g, p), back = pointAt(g, c.face, c.X, c.Y, c.fx, c.fy);
      expect(c.X).toBeGreaterThanOrEqual(0); expect(c.X).toBeLessThan(g.fn);
      expect(dist(back, p)).toBeLessThan(1e-14);
    }
  }
});

test("a tier's cells nest in the tier above's: four children to a cell, vertices shared", () => {
  const g0 = tierGrid(0), g1 = tierGrid(1), rnd = stream(11);
  for (let k = 0; k < 3000; k++) {
    const f = Math.floor(rnd() * 6), X = Math.floor(rnd() * g0.fn), Y = Math.floor(rnd() * g0.fn);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const c = locateVec(g0, centre(g1, f, 2 * X + dx, 2 * Y + dy));
      expect([c.face, c.X, c.Y]).toEqual([f, X, Y]);
    }
    expect(dist(vertex(g1, f, 2 * X, 2 * Y), vertex(g0, f, X, Y))).toBeLessThan(1e-14);
    // the children's areas add up to the parent's
    let kids = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) kids += areaSr(g1, 2 * X + dx, 2 * Y + dy);
    expect(Math.abs(kids - areaSr(g0, X, Y))).toBeLessThan(1e-15);
  }
});

// ---- neighbours ----
test("every cell has four distinct neighbours, the relation is symmetric, across all 12 face edges and 8 corners", () => {
  const g = tierGrid(0), n = g.fn;
  const edgeVerts = (f: number, X: number, Y: number, d: number) =>
    d === 0 ? [vertex(g, f, X + 1, Y), vertex(g, f, X + 1, Y + 1)] : d === 1 ? [vertex(g, f, X, Y + 1), vertex(g, f, X + 1, Y + 1)]
      : d === 2 ? [vertex(g, f, X, Y), vertex(g, f, X, Y + 1)] : [vertex(g, f, X, Y), vertex(g, f, X + 1, Y)];
  // an along-edge direction of a cell's side: Y on an east or west side, X on a north or south one
  const alongCode = (s: number) => (s & 1 ? 0 : 1);
  const axis = (f: number, code: number): V3 => { const { ex, ey } = FRAMES[f]; return code === 0 ? ex : code === 1 ? ey : code === 2 ? [-ex[0], -ex[1], -ex[2]] : [-ey[0], -ey[1], -ey[2]]; };
  let crossing = 0, worstVertex = 0, minRatio = Infinity, maxRatio = 0;
  const w = g.width;
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < n; Y++)
      for (let X = 0; X < n; X++) {
        const ids = new Set<number>(), me = cellId(g, f, X, Y);
        for (let d = 0; d < 4; d++) {
          const s = step(g, f, X, Y, d), id = cellId(g, s.face, s.X, s.Y);
          expect(id).not.toBe(me);
          ids.add(id);
          // symmetric: the neighbour's step back is this cell, and back is the direction it took
          const r = step(g, s.face, s.X, s.Y, s.back);
          if (r.face !== f || r.X !== X || r.Y !== Y || r.back !== d) throw new Error(`asymmetric at ${f},${X},${Y} direction ${d}`);
          // the two cells share an edge: its two ends coincide whichever cell they are computed from
          const [a1, a2] = edgeVerts(f, X, Y, d), [b1, b2] = edgeVerts(s.face, s.X, s.Y, s.back);
          worstVertex = Math.max(worstVertex, Math.min(Math.max(dist(a1, b1), dist(a2, b2)), Math.max(dist(a1, b2), dist(a2, b1))));
          const ratio = dist(centre(g, f, X, Y), centre(g, s.face, s.X, s.Y)) / w;
          minRatio = Math.min(minRatio, ratio); maxRatio = Math.max(maxRatio, ratio);
          if (s.face !== f) {
            crossing++;
            // the edge's own direction (the along axis of the side) is the along axis of the side across, turned by `turn` quarter turns
            expect(dot3(axis(f, alongCode(d)), axis(s.face, (alongCode(d) + s.turn) & 3))).toBe(1);
            // and the step itself, in the new axes, goes into the face across: against the outward axis of the face we left
            expect(dot3(axis(s.face, (d + s.turn) & 3), FRAMES[f].n)).toBe(-1);
          } else expect(s.turn).toBe(0);
        }
        expect(ids.size).toBe(4);
      }
  expect(worstVertex).toBeLessThan(1e-12);
  // 6 faces, 4 sides of 256 cells less the corners counted twice
  expect(crossing).toBe(FACES * (4 * n - 4) + FACES * 4);
  // neighbours are about a cell width away (the cell is narrower toward a face's edge and corner)
  expect(minRatio).toBeGreaterThan(0.6);
  expect(maxRatio).toBeLessThan(1.1);
  // the table across: a side's face across faces back, and the sides come in pairs
  for (let f = 0; f < FACES; f++) for (let s = 0; s < 4; s++) {
    const e = EDGES[f][s], back = EDGES[e.face][e.side];
    expect(back.face).toBe(f);
    expect(back.side).toBe(s);
    expect(back.flip).toBe(e.flip);
  }
});

test("at each cube corner the three corner cells are neighbours of one another and no cell stands diagonal", () => {
  const g = tierGrid(0), n = g.fn;
  // the face-corner cells: 4 a face, 24 in all, grouped by the cube corner they touch
  const groups = new Map<string, number[]>();
  const nullDiagonals: string[] = [];
  for (let f = 0; f < FACES; f++)
    for (const [X, Y] of [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1]]) {
      const v = vertex(g, f, X === 0 ? 0 : n, Y === 0 ? 0 : n), key = v.map((x) => Math.round(x * 1e6)).join(",");
      groups.set(key, [...(groups.get(key) ?? []), cellId(g, f, X, Y)]);
      for (const [dx, dy] of NEIGHBOURS8.slice(4)) if (!haloSource(g, f, X + dx, Y + dy)) nullDiagonals.push(`${f},${X},${Y}`);
    }
  expect(groups.size).toBe(8);
  const ofId = (id: number): [number, number, number] => [Math.floor(id / (n * n)), id % n, Math.floor((id % (n * n)) / n)];
  for (const trio of groups.values()) {
    expect(trio.length).toBe(3);
    for (const id of trio) {
      const [f, X, Y] = ofId(id), around = new Set([0, 1, 2, 3].map((d) => { const s = step(g, f, X, Y, d); return cellId(g, s.face, s.X, s.Y); }));
      for (const other of trio) if (other !== id) expect(around.has(other)).toBe(true);
    }
  }
  // each of the 24 has exactly one missing diagonal, and no other cell has any
  expect(nullDiagonals.length).toBe(24);
  let others = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 1; Y < n - 1; Y++) for (const X of [0, n - 1]) for (const [dx, dy] of NEIGHBOURS8) if (!haloSource(g, f, X + dx, Y + dy)) others++;
  expect(others).toBe(0);
  // the vertex weights there give a third to each of the three cells
  const w = vertexWeights(g, 0, 0, 0);
  expect(w.cells.filter((c) => c).length).toBe(3);
  for (const x of w.w) if (x !== 0) expect(x).toBeCloseTo(1 / 3, 12);
});

// ---- the tables ----
test("tables: rounding margin, symmetric links, vertex weights that sum to one, byte identity and a golden hash", () => {
  const a = tables0(), b = buildTables(tierGrid(0));
  expect(hash(a.words)).toBe(hash(b.words));
  expect(a.margin).toBeGreaterThan(1e-8); // no scaled value within 1e-8 of a rounding tie in the last place
  expect(a.fragile).toBeLessThan(32); // of 8.3 million rounded words
  expect(a.maxFo).toBeGreaterThan(0.09);
  const { words, tw } = a, g = a.g;
  // a link has the same coefficients from both of its cells
  let worst = 0, sums = 0;
  for (let f = 0; f < FACES; f += 1)
    for (let Y = 0; Y < g.fn; Y += 7)
      for (let X = 0; X < g.fn; X += 5) {
        const at = slotOf(g, f, X, Y) * TILE * TILE + (Y & 255) * TILE + (X & 255);
        for (let d = 0; d < 4; d++) {
          const s = step(g, f, X, Y, d), bt = slotOf(g, s.face, s.X, s.Y) * TILE * TILE + (s.Y & 255) * TILE + (s.X & 255);
          worst = Math.max(worst, Math.abs(words[(TAB.K + d) * tw + at] - words[(TAB.K + s.back) * tw + bt]), Math.abs(words[(TAB.C + d) * tw + at] - words[(TAB.C + s.back) * tw + bt]));
          let sum = 0;
          for (let m = 0; m < 4; m++) sum += words[(TAB.V + 4 * d + m) * tw + at];
          if (sum !== 2 ** 20) sums++;
        }
      }
  expect(worst).toBe(0);
  expect(sums).toBe(0);
  expect(hash(a.words)).toBe("6bd51a89542b5c0e2ffeb2e486b35df10e6cc886d9559cfa9a9615f1fcc0038b");
});

// ---- halo exchange ----
function randomFields(g: Grid, count: number, seed: number, bound: number) {
  const rnd = stream(seed), fw = fieldWords(g), S = new Int32Array(fw * count);
  for (let f = 0; f < count; f++) {
    const one = padded(g, () => Math.floor((rnd() * 2 - 1) * bound));
    S.set(one, f * fw);
  }
  return S;
}

test("halo exchange: the kernel equals its twin in all three modes, at tier 0 (faces) and tier 1 (tiles on a face too)", async () => {
  const gpu = await theGpu();
  for (const tier of [0, 1]) {
    const g = tierGrid(tier);
    const fw = fieldWords(g);
    for (const mode of [HALO.copy, HALO.code, HALO.pair]) {
      const S = randomFields(g, 3, 5 + tier + mode, mode === HALO.code ? 5 : 100000);
      const run = new GlobeGpu(gpu, g, 3);
      run.write(0, S.subarray(0, fw)); run.write(1, S.subarray(fw, 2 * fw)); run.write(2, S.subarray(2 * fw));
      run.halo(0, mode, 1);
      const expected = S.slice();
      haloTwin(g, expected, 0, mode, 1);
      const got = new Int32Array(3 * fw);
      for (let f = 0; f < 3; f++) got.set(await run.read(f), f * fw);
      run.release();
      let bad = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== expected[i]) bad++;
      expect(bad).toBe(0);
    }
  }
});

test("halo exchange: copies the cell across, turns direction codes and vectors by the axes' rotation, and keeps a tile's own halos right", () => {
  const g = tierGrid(1), fw = fieldWords(g), T = g.tiles;
  // a field of the cell's own id, so the halo says which cell it was copied from
  const S = new Int32Array(4 * fw);
  S.set(padded(g, (f, X, Y) => cellId(g, f, X, Y)), 0);
  const rnd = stream(3);
  S.set(padded(g, () => Math.floor(rnd() * 4)), fw); // codes
  // (u, v) the unit vector of each cell's code
  const codes = S.subarray(fw, 2 * fw);
  const U = [1, 0, -1, 0], Vv = [0, 1, 0, -1];
  S.set(padded(g, () => 0), 2 * fw);
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
    const at = wordAt(g, f, X, Y);
    S[2 * fw + at] = U[codes[at]]; S[3 * fw + at] = Vv[codes[at]];
  }
  haloTwin(g, S, 0, HALO.copy); haloTwin(g, S, 1, HALO.code); haloTwin(g, S, 2, HALO.pair, 3);
  let checked = 0, corners = 0;
  for (let slot = 0; slot < tileCount(g); slot++) {
    const face = Math.floor(slot / (T * T)), ty = Math.floor((slot % (T * T)) / T), tx = slot % T;
    for (let pj = 0; pj < 258; pj++) for (let pi = 0; pi < 258; pi++) {
      if (pi > 0 && pi < 257 && pj > 0 && pj < 257) continue;
      const gx = tx * TILE + pi - 1, gy = ty * TILE + pj - 1, at = slot * PAD_WORDS + pj * 258 + pi, s = haloSource(g, face, gx, gy);
      if (!s) {
        corners++;
        // a corner of the cube: the code is "none" and the copy is the mean of the three cells (rounded down)
        expect(S[fw + at]).toBe(4);
        continue;
      }
      checked++;
      // the id copied is the neighbour's id
      expect(S[at]).toBe(cellId(g, s.face, s.X, s.Y));
      // the code, turned, points where the vector turned points
      const code = S[fw + at];
      expect([S[2 * fw + at], S[3 * fw + at]]).toEqual([U[code], Vv[code]]);
      expect(code).toBe((codes[wordAt(g, s.face, s.X, s.Y)] + 4 - s.turn) & 3);
    }
  }
  expect(corners).toBe(24); // the 24 tile corners at a cube's corner, each seen once
  expect(checked).toBeGreaterThan(0);
});

// ---- gradient ----
const axisTilt = ((): V3 => { const a = [0.3, -0.5, 0.8], n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; })();
// Fields with their gradients (east, north) per radian on the unit sphere.
const FIELDS: Record<string, { q: (p: V3) => number; grad: (p: V3) => [number, number]; lap?: number }> = {
  tilted: { q: (p) => dot3(axisTilt, p), grad: (p) => { const [e, n] = eastNorth(p); return [dot3(axisTilt, e), dot3(axisTilt, n)]; }, lap: -2 },
  cosLat: { q: (p) => Math.hypot(p[0], p[1]), grad: (p) => [0, -p[2]] },
  p3: { q: (p) => (5 * p[2] ** 3 - 3 * p[2]) / 2, grad: (p) => [0, ((15 * p[2] * p[2] - 3) / 2) * Math.hypot(p[0], p[1])], lap: -12 },
};

// The float gradient from the table's weights on a grid of fn cells, against the exact one: area-weighted rms and largest
// error in the field's unit per radian.
function gradientError(fn: number, name: string) {
  const g = makeGrid(fn), F = FIELDS[name], q = new Float64Array(FACES * fn * fn), id = (f: number, X: number, Y: number) => (f * fn + Y) * fn + X;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) q[id(f, X, Y)] = F.q(centre(g, f, X, Y));
  let l2 = 0, linf = 0, area = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const w = gradientWeights(g, f, X, Y), q0 = q[id(f, X, Y)];
    let ge = 0, gn = 0;
    NEIGHBOURS8.forEach(([dx, dy], d) => {
      const s = haloSource(g, f, X + dx, Y + dy);
      if (!s) return;
      ge += w[d] * (q[id(s.face, s.X, s.Y)] - q0); gn += w[8 + d] * (q[id(s.face, s.X, s.Y)] - q0);
    });
    const [ee, en] = F.grad(centre(g, f, X, Y)), err = Math.hypot(ge / g.width - ee, gn / g.width - en), a = areaSr(g, X, Y);
    l2 += err * err * a; area += a; linf = Math.max(linf, err);
  }
  return { l2: Math.sqrt(l2 / area), linf };
}

test("gradient: second order for a smooth field across face edges and corners; cos of latitude limited by its cone at the poles", () => {
  for (const name of ["tilted", "p3"]) {
    const e = [16, 32, 64, 128].map((fn) => gradientError(fn, name));
    for (let k = 1; k < e.length; k++) {
      expect(Math.log2(e[k - 1].l2 / e[k].l2)).toBeGreaterThan(1.9);
      expect(Math.log2(e[k - 1].linf / e[k].linf)).toBeGreaterThan(1.8);
    }
  }
  // cos of latitude is sqrt(x2 + y2): its gradient jumps in direction at the poles, the centres of faces 4 and 5; away from the
  // poles the error is second order, over the sphere it is first order in the rms and does not fall at the pole's own cells
  const e = [16, 32, 64, 128].map((fn) => gradientError(fn, "cosLat"));
  for (let k = 1; k < e.length; k++) {
    expect(Math.log2(e[k - 1].l2 / e[k].l2)).toBeGreaterThan(0.95);
    expect(e[k].linf).toBeGreaterThan(0.4);
  }
});

test("gradient: a solid-body rotation's velocity comes back from its stream function, to second order", () => {
  // the stream function is the tilted axis' cosine, psi = axis . r; the rotation is u = axis x r, whose east and north
  // components are (grad north, -grad east) of psi
  const errs = [16, 32, 64, 128].map((fn) => {
    const g = makeGrid(fn), q = new Float64Array(FACES * fn * fn), id = (f: number, X: number, Y: number) => (f * fn + Y) * fn + X;
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) q[id(f, X, Y)] = dot3(axisTilt, centre(g, f, X, Y));
    let worst = 0;
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
      const w = gradientWeights(g, f, X, Y), q0 = q[id(f, X, Y)], p = centre(g, f, X, Y), [e, n] = eastNorth(p);
      let ge = 0, gn = 0;
      NEIGHBOURS8.forEach(([dx, dy], d) => {
        const s = haloSource(g, f, X + dx, Y + dy);
        if (!s) return;
        ge += w[d] * (q[id(s.face, s.X, s.Y)] - q0); gn += w[8 + d] * (q[id(s.face, s.X, s.Y)] - q0);
      });
      const u = [axisTilt[1] * p[2] - axisTilt[2] * p[1], axisTilt[2] * p[0] - axisTilt[0] * p[2], axisTilt[0] * p[1] - axisTilt[1] * p[0]];
      const exact = [dot3(u, e), dot3(u, n)];
      worst = Math.max(worst, Math.hypot(gn / g.width - exact[0], -ge / g.width - exact[1]));
    }
    return worst;
  });
  for (let k = 1; k < errs.length; k++) expect(Math.log2(errs[k - 1] / errs[k])).toBeGreaterThan(1.8);
  expect(errs[3]).toBeLessThan(1e-4);
});

test("gradient kernel: equals its twin bit for bit, and the integer answer is within a last place of the float one", async () => {
  const gpu = await theGpu(), tab = tables0(), g = tab.g, fw = fieldWords(g);
  const AMP = 2 ** 19;
  const q = padded(g, (f, X, Y) => Math.round(AMP * (FIELDS.tilted.q(centre(g, f, X, Y)) + 0.5 * FIELDS.p3.q(centre(g, f, X, Y)))));
  const S = new Int32Array(STATE.COUNT * fw);
  S.set(q, 0);
  haloTwin(g, S, 0);
  const run = new GlobeGpu(gpu, tab);
  run.write(0, S.subarray(0, fw));
  run.halo(0);
  run.gradient(0, STATE.ge, STATE.gn);
  gradientTwin(tab, S, 0, STATE.ge, STATE.gn);
  const ge = await run.read(STATE.ge), gn = await run.read(STATE.gn);
  run.release();
  let bad = 0, worst = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y += 1) for (let X = 0; X < g.fn; X += 1) {
    const at = wordAt(g, f, X, Y);
    if (ge[at] !== S[STATE.ge * fw + at] || gn[at] !== S[STATE.gn * fw + at]) bad++;
  }
  expect(bad).toBe(0);
  // against the float weights applied to the same integers: each answer is Q6 (a unit of 1/64), rounded once
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y += 9) for (let X = 0; X < g.fn; X += 7) {
    const w = gradientWeights(g, f, X, Y), at = wordAt(g, f, X, Y), q0 = S[at];
    let e = 0, n = 0;
    NEIGHBOURS8.forEach(([dx, dy], d) => {
      const s = haloSource(g, f, X + dx, Y + dy);
      if (!s) return;
      const dq = S[wordAt(g, s.face, s.X, s.Y)] - q0;
      e += w[d] * dq; n += w[8 + d] * dq;
    });
    worst = Math.max(worst, Math.abs(ge[at] - e * 64), Math.abs(gn[at] - n * 64));
  }
  // the weights are Q28, so each of up to 8 products is off by 2^-29 of the difference (2^20 at most): a few last places
  expect(worst).toBeLessThan(1);
});

// ---- the operator, in float, to say why the cross term is there ----
function laplacianError(fn: number, name: string, cross: boolean) {
  const g = makeGrid(fn), F = FIELDS[name], q = new Float64Array(FACES * fn * fn), id = (f: number, X: number, Y: number) => (f * fn + Y) * fn + X;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) q[id(f, X, Y)] = F.q(centre(g, f, X, Y));
  const vertexValue = (f: number, vx: number, vy: number) => {
    const { cells, w } = vertexWeights(g, f, vx, vy);
    return cells.reduce((s, c, i) => s + (c ? w[i] * q[id(c.face, c.X, c.Y)] : 0), 0);
  };
  const ends = [[[1, 1], [1, 0]], [[0, 1], [1, 1]], [[0, 0], [0, 1]], [[1, 0], [0, 0]]];
  let l2 = 0, linf = 0, area = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const q0 = q[id(f, X, Y)];
    let sum = 0;
    for (let d = 0; d < 4; d++) {
      const s = step(g, f, X, Y, d), l = linkFloat(g, f, X, Y, d), [L, R] = ends[d];
      sum += l.kappa * (q[id(s.face, s.X, s.Y)] - q0);
      if (cross) sum -= l.cross * (vertexValue(f, X + L[0], Y + L[1]) - vertexValue(f, X + R[0], Y + R[1]));
    }
    const a = areaSr(g, X, Y), err = Math.abs(sum / a - F.lap! * F.q(centre(g, f, X, Y)));
    l2 += err * err * a; area += a; linf = Math.max(linf, err);
  }
  return { l2: Math.sqrt(l2 / area), linf };
}

test("diffusion operator in float: the two-point flux alone is wrong by L/h at a face's edge; with the cross term it is not", () => {
  const plain = [16, 32, 64].map((fn) => laplacianError(fn, "tilted", false));
  const fixed = [16, 32, 64].map((fn) => laplacianError(fn, "tilted", true));
  // the plain error grows as the grid is refined (a spurious source of a flux's size in a cell's area)
  expect(plain[2].linf).toBeGreaterThan(1.8 * plain[1].linf);
  expect(plain[2].linf).toBeGreaterThan(20);
  // with the cross term the error is a few percent of the field's Laplacian (2) at most and does not grow: it falls in the rms
  for (const e of fixed) expect(e.linf).toBeLessThan(0.1);
  expect(fixed[2].l2).toBeLessThan(fixed[1].l2);
  expect(fixed[1].l2).toBeLessThan(fixed[0].l2);
  expect(fixed[2].linf).toBeLessThan(plain[2].linf / 100);
  // a field of degree 3 (eigenvalue -12): bounded, not converging, at a few percent of its Laplacian
  const p3 = [16, 32, 64].map((fn) => laplacianError(fn, "p3", true));
  for (const e of p3) expect(e.linf).toBeLessThan(1.3);
});

// ---- diffusion ----
const FO = 0.09;
function bump(g: Grid, centreVec: V3, sigma: number, amp: number) {
  return padded(g, (f, X, Y) => {
    const c = centre(g, f, X, Y), ang = 2 * Math.atan2(dist(c, centreVec), Math.hypot(c[0] + centreVec[0], c[1] + centreVec[1], c[2] + centreVec[2]));
    return Math.round(amp * Math.exp(-((ang / (sigma * g.width)) ** 2)));
  });
}

async function diffusion(tab: Tables, q0: Int32Array, r0: Int32Array | null, steps: number) {
  const gpu = await theGpu(), run = new GlobeGpu(gpu, tab);
  run.writeTracer(q0, r0 ?? undefined);
  const done = run.diffuse(FO, steps), q = await run.read(done.q), r = await run.read(done.r);
  run.release();
  return { q, r };
}

// Mass on each face: the sum of q * a + r over the face's cells.
function faceMass(tab: Tables, S: Int32Array, q: number, r: number) {
  const g = tab.g, fw = fieldWords(g), out: bigint[] = [];
  for (let f = 0; f < FACES; f++) {
    let sum = 0n;
    for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
      const at = wordAt(g, f, X, Y);
      sum += BigInt(S[q * fw + at]) * BigInt(tab.words[slotOf(g, f, X, Y) * TILE * TILE + (Y & 255) * TILE + (X & 255)]) + BigInt(S[r * fw + at]);
    }
    out.push(sum);
  }
  return out;
}

// A tracer put on the cube's own symmetry (a bump of cells' width 3 round a corner, or round the middle of an edge) spreads
// over the faces that meet there alike: the faces' shares stay equal to a few parts in a million of the total, which a
// cell treated differently at the corner or across the edge would not give. The total is exact.
for (const [name, centreVec, faces] of [["a cube corner", [1, 1, 1] as V3, [0, 1, 4]], ["the middle of a face edge", [1, 0, 1] as V3, [0, 4]]] as const) {
  test(`diffusion: a tracer spread over ${name} keeps its total exactly and shares it among the faces there alike`, async () => {
    const tab = tables0(), g = tab.g, fw = fieldWords(g), v = centreVec.map((x) => x / Math.hypot(...centreVec)) as unknown as V3;
    const q0 = bump(g, v, 3, 2 ** 19), S0 = new Int32Array(STATE.COUNT * fw);
    S0.set(q0, 0);
    const before = totalMass(tab, S0, STATE.q, STATE.r);
    const { q, r } = await diffusion(tab, q0, null, 200);
    const S = new Int32Array(STATE.COUNT * fw);
    S.set(q, 0); S.set(r, fw);
    expect(totalMass(tab, S, 0, 1)).toBe(before);
    const share = faceMass(tab, S, 0, 1), start = faceMass(tab, S0, STATE.q, STATE.r);
    for (const f of faces) {
      expect(Number(((share[f] - share[faces[0]]) * 1000000n) / before)).toBeLessThanOrEqual(5);
      expect(Number(((share[f] - share[faces[0]]) * 1000000n) / before)).toBeGreaterThanOrEqual(-5);
      expect(share[f]).toBeGreaterThan(before / BigInt(faces.length + 1));
    }
    expect(start[faces[0]]).toBeGreaterThan(0n);
    // the tracer has spread: the peak is lower; the cross term is not monotone, so an undershoot is allowed but small
    let peak0 = 0, peak = 0, minQ = 0;
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
      const at = wordAt(g, f, X, Y);
      peak0 = Math.max(peak0, q0[at]); peak = Math.max(peak, q[at]); minQ = Math.min(minQ, q[at]);
    }
    expect(peak).toBeLessThan(peak0 / 4);
    expect(minQ).toBeGreaterThan(-peak0 / 10000);
  }, 200_000);
}

test("diffusion: a uniform field stays uniform and its remainders stay put, over a face edge and a cube corner", async () => {
  const tab = tables0(), g = tab.g, rnd = stream(21);
  const q0 = padded(g, () => 123456), r0 = padded(g, (f, X, Y) => Math.floor(rnd() * tab.words[slotOf(g, f, X, Y) * TILE * TILE + (Y & 255) * TILE + (X & 255)]));
  const { q, r } = await diffusion(tab, q0, r0, 25);
  let bad = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
    const at = wordAt(g, f, X, Y);
    if (q[at] !== 123456 || r[at] !== r0[at]) bad++;
  }
  expect(bad).toBe(0);
});

test("diffusion: the kernel equals its twin bit for bit (two steps, a bump over a cube corner and an edge)", async () => {
  const gpu = await theGpu(), tab = tables0(), g = tab.g, fw = fieldWords(g);
  const v1 = [1, 1, 1].map((x) => x / Math.sqrt(3)) as unknown as V3, v2 = [1, 0, 1].map((x) => x / Math.SQRT2) as unknown as V3;
  const a = bump(g, v1, 5, 2 ** 18), b = bump(g, v2, 7, 2 ** 18), q0 = a.map((x, i) => x + b[i]) as unknown as Int32Array;
  const S = new Int32Array(STATE.COUNT * fw);
  S.set(q0, 0);
  const foQ = Math.round(FO * 2 ** 24);
  // the twin: halo, step, halo, step
  haloTwin(g, S, STATE.q);
  fluxTwin(tab, S, foQ, STATE.q, STATE.r, STATE.q2, STATE.r2);
  haloTwin(g, S, STATE.q2);
  fluxTwin(tab, S, foQ, STATE.q2, STATE.r2, STATE.q, STATE.r);
  const run = new GlobeGpu(gpu, tab);
  run.write(STATE.q, q0);
  const done = run.diffuse(FO, 2);
  expect(done).toEqual({ q: STATE.q, r: STATE.r });
  const q = await run.read(done.q), r = await run.read(done.r);
  run.release();
  let bad = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
    const at = wordAt(g, f, X, Y);
    if (q[at] !== S[STATE.q * fw + at] || r[at] !== S[STATE.r * fw + at]) bad++;
  }
  expect(bad).toBe(0);
}, 200_000);

test("diffusion: refuses a diffusion number past the stable one and a tracer past the exact range", async () => {
  const gpu = await theGpu(), tab = tables0(), g = tab.g, run = new GlobeGpu(gpu, tab);
  expect(() => run.diffuse(tab.maxFo * 1.01, 1)).toThrow(/stable/);
  expect(() => run.diffuse(0.3, 1)).toThrow(/at most 0.25/);
  expect(() => run.diffuse(0, 1)).toThrow();
  expect(() => run.writeTracer(padded(g, () => 2 ** 20))).toThrow(/2\^20/);
  expect(() => run.writeTracer(padded(g, () => 1), padded(g, () => 65535))).toThrow(/remainder/);
  run.release();
});

test("diffusion: an eigenmode decays at its eigenvalue, to within the operator's own error", async () => {
  // Re (x + i y)^3 is a spherical harmonic of degree 3, so diffusion takes it down as exp(-12 D t / R^2); one step is D dt
  // = fo times the mean cell's area, so D dt / R^2 = fo * (2 pi / 3) / fn^2 a step.
  const tab = tables0(), g = tab.g, steps = 3000;
  const mode = (p: V3) => p[0] ** 3 - 3 * p[0] * p[1] * p[1];
  const q0 = padded(g, (f, X, Y) => Math.round(2 ** 19 * mode(centre(g, f, X, Y))));
  const { q } = await diffusion(tab, q0, null, steps);
  // the mode's amplitude: the projection on its own shape, weighted by the cells' areas
  const amp = (field: Int32Array) => {
    let num = 0, den = 0;
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
      const y = mode(centre(g, f, X, Y)), a = areaSr(g, X, Y);
      num += field[wordAt(g, f, X, Y)] * y * a; den += y * y * a;
    }
    return num / den;
  };
  const measured = Math.log(amp(q) / amp(q0)), exact = (-12 * steps * FO * ((2 * Math.PI) / 3)) / (g.fn * g.fn);
  expect(measured).toBeLessThan(0);
  // measured 8e-6 off (the discrete operator is conservative and its error in a smooth mode's projection is second order)
  expect(Math.abs(measured / exact - 1)).toBeLessThan(1e-3);
}, 200_000);

test("byte identity: two runs of the same diffusion on the GPU give the same words, and the words match a golden hash", async () => {
  const tab = tables0(), g = tab.g, v = [1, 1, 1].map((x) => x / Math.sqrt(3)) as unknown as V3;
  const q0 = bump(g, v, 6, 2 ** 19);
  const a = await diffusion(tab, q0, null, 60), b = await diffusion(tab, q0, null, 60);
  expect(hash(a.q)).toBe(hash(b.q));
  expect(hash(a.r)).toBe(hash(b.r));
  expect(hash(a.q)).toBe("3c27adefbfc207500373183a50739e05752eea3451575766dbf90ed89e20cb7f");
  expect(hash(a.r)).toBe("3321d185e37447988cbda8acc210cc9dde75df90e2352928803e7ae78316d8f2");
}, 200_000);

