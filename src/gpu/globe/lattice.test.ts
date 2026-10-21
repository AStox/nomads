// The window lattice: a point and its cell, neighbours across face edges and cube corners, the windows' frames, and the blend that
// covers every point. Run one case at a time: bun test ./src/gpu/globe/lattice.test.ts -t "<name>" --timeout 280000
// (no GPU is used here; the windows made at lattice cells are tested in windows.test.ts).
import { describe, expect, test } from "bun:test";
import { CELL, N } from "../../terrain/grid";
import { RADIUS_M, eastNorth, locateVec, makeGrid, step, type V3 } from "./grid";
import { BLEND_M, CELLS, LATTICE_N, blendWeight, cellAt, cellAtPlace, cellCentre, cellCorners, cellFrame, cellNeighbours, cellOfId, cellStep, cover, idOf, latticeStats, pixelOf, sample, type Cell } from "./lattice";
import { WINDOW_M, onPlane } from "./window";

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const arcM = (a: V3, b: V3) => 2 * Math.atan2(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2])) * RADIUS_M;
let seed = 12345;
const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const randomPoint = (): V3 => { const z = 2 * rand() - 1, p = 2 * Math.PI * rand(), h = Math.sqrt(1 - z * z); return [h * Math.cos(p), h * Math.sin(p), z]; };

describe("the window lattice", () => {
  test("a point's cell holds it, and a cell's centre finds its cell, for every cell", () => {
    for (let id = 0; id < CELLS; id++) {
      const c = cellOfId(id);
      expect(idOf(c)).toBe(id);
      expect(idOf(cellAt(cellCentre(c)))).toBe(id);
    }
    // a random point is inside its cell: on the inner side of each of the four edges (great circles through the corners)
    for (let k = 0; k < 2000; k++) {
      const p = randomPoint(), c = cellAt(p), q = cellCorners(c);
      for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4], nrm: V3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        expect(dot(nrm, p) * dot(nrm, cellCentre(c))).toBeGreaterThanOrEqual(-1e-12);
      }
    }
    // a place in degrees finds the same cell as its vector
    expect(idOf(cellAtPlace(0, 0))).toBe(idOf(cellAt([1, 0, 0])));
  });

  test("every cell has four neighbours that have it back, across face edges too, and three cells meet at each cube corner", () => {
    const d = [] as number[];
    let nullDiagonals = 0;
    for (let id = 0; id < CELLS; id++) {
      const c = cellOfId(id), nb = cellNeighbours(c);
      const edge = [0, 1, 2, 3].map((k) => cellStep(c, k));
      expect(new Set(edge.map(idOf)).size).toBe(4);
      edge.forEach((o, k) => {
        expect(nb[k]).toEqual(o);
        // the way back: the step the grid reports from o toward c is some direction whose step returns to c
        const s = step(makeGrid(LATTICE_N), c.face, c.X, c.Y, k);
        expect(idOf(cellStep(o, s.back))).toBe(id);
        d.push(arcM(cellCentre(c), cellCentre(o)));
      });
      nullDiagonals += nb.slice(4).filter((x) => x === null).length;
      // a diagonal neighbour is a neighbour of two of the edge neighbours
      nb.slice(4).forEach((o, k) => {
        if (!o) return;
        const via = [cellStep(edge[k], (k + 1) & 3), cellStep(edge[(k + 1) & 3], k)].map(idOf);
        expect(via).toContain(idOf(o));
      });
    }
    // 8 cube corners, 3 faces each, one missing diagonal in each of those 24 cells
    expect(nullDiagonals).toBe(24);
    // the three cells at a corner are neighbours of one another
    const corner = { face: 0, X: LATTICE_N - 1, Y: LATTICE_N - 1 }, nb = cellNeighbours(corner).filter(Boolean).map((c) => idOf(c!));
    expect(new Set(nb).size).toBe(nb.length);
    const [east, north] = [idOf(cellStep(corner, 0)), idOf(cellStep(corner, 1))];
    expect(new Set([cellOfId(east).face, cellOfId(north).face, 0]).size).toBe(3);
    expect(cellNeighbours(cellOfId(east)).map((c) => (c ? idOf(c) : -1))).toContain(north);
    // the distance between the centres of edge neighbours is the pitch: between the least and largest of latticeStats, face edges included
    const st = latticeStats();
    const least = d.reduce((a, b) => Math.min(a, b), Infinity), most = d.reduce((a, b) => Math.max(a, b), 0);
    expect(least).toBeGreaterThan(st.pitchMin * 0.97);
    expect(most).toBeLessThan(st.pitchMax * 1.03);
  });

  test("a cell's pitch fits the window less its two ramps, and the cells' ground size and skew are what the map gives", () => {
    const st = latticeStats();
    // the face centre's pitch is the largest and is within the plateau [derived: LATTICE_N is the least even count that makes it so]
    expect(st.pitchMax).toBeLessThanOrEqual(WINDOW_M - 2 * BLEND_M);
    // equal steps of an angle: the cells shrink to the cube's edge by the map's own area ratio (1.41, grid note) and shear to 60 degrees
    expect(st.areaMax / st.areaMin).toBeGreaterThan(1.3);
    expect(st.areaMax / st.areaMin).toBeLessThan(1.42);
    expect(st.skewMin).toBeGreaterThan(60);
    expect(st.skewMax).toBeLessThan(120);
    console.log(`lattice ${LATTICE_N} a face: pitch ${(st.pitchMin / 1000).toFixed(2)} to ${(st.pitchMax / 1000).toFixed(2)} km, area ${st.areaMin.toFixed(0)} to ${st.areaMax.toFixed(0)} km2, axes ${st.skewMin.toFixed(1)} to ${st.skewMax.toFixed(1)} degrees`);
  });

  test("a window's frame is orthonormal, right-handed, along the cell's X axis, and its turn is y's bearing from north", () => {
    let worstAxis = 0, maxTurn = 0;
    for (let id = 0; id < CELLS; id += 7) {
      const c = cellOfId(id), f = cellFrame(c), p = cellCentre(c);
      expect(Math.abs(dot(f.e, f.e) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.n, f.n) - 1)).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.e, f.n))).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.e, p))).toBeLessThan(1e-12);
      expect(Math.abs(dot(f.n, p))).toBeLessThan(1e-12);
      // e x n = outward
      const cr: V3 = [f.e[1] * f.n[2] - f.e[2] * f.n[1], f.e[2] * f.n[0] - f.e[0] * f.n[2], f.e[0] * f.n[1] - f.e[1] * f.n[0]];
      expect(dot(cr, p)).toBeGreaterThan(1 - 1e-12);
      // y's bearing: its east and north components
      const [east, north] = eastNorth(p);
      expect(Math.abs(Math.atan2(dot(f.n, east), dot(f.n, north)) - f.turn)).toBeLessThan(1e-12);
      maxTurn = Math.max(maxTurn, Math.abs(f.turn));
      // the east neighbour inside the face lies along x: the great circle of constant b is straight in the tangent plane
      if (c.X < LATTICE_N - 1) {
        const q = cellCentre(cellStep(c, 0)), [x, y] = onPlane(f, q);
        worstAxis = Math.max(worstAxis, Math.abs(Math.atan2(y, x)));
      }
    }
    expect(worstAxis).toBeLessThan(1e-3);
    // faces 4 and 5 turn all the way round
    expect(maxTurn).toBeGreaterThan(3);
    console.log(`frames: the east neighbour is along x to ${(worstAxis * 180 / Math.PI).toExponential(1)} degrees, the largest turn from north ${(maxTurn * 180 / Math.PI).toFixed(1)} degrees`);
  });

  test("every point stands on the plateau of some window, at most four windows hold it, and none beyond the nine cells do", () => {
    const points: V3[] = [];
    for (let k = 0; k < 20000; k++) points.push(randomPoint());
    // the cube's corners and points on its 12 edges, and either side of them
    const s = 1 / Math.sqrt(3);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) points.push([sx * s, sy * s, sz * s]);
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (let t = -0.99; t < 1; t += 0.11) {
      const v: V3[] = [[a, b, t], [a, t, b], [t, a, b]];
      for (const q of v) { const h = Math.hypot(...q); points.push([q[0] / h, q[1] / h, q[2] / h]); }
    }
    let most = 0, least = 1;
    for (const p of points) {
      const home = cellAt(p), ring = [home, ...cellNeighbours(home).filter(Boolean) as Cell[]];
      const raw = ring.map((c) => { const [x, y] = onPlane(cellFrame(c), p); return blendWeight(x, y); });
      expect(Math.max(...raw)).toBe(1);
      const cv = cover(p);
      expect(Math.abs(cv.reduce((a, o) => a + o.w, 0) - 1)).toBeLessThan(1e-12);
      most = Math.max(most, cv.length);
      least = Math.min(least, Math.max(...cv.map((o) => o.w)));
    }
    expect(most).toBeLessThanOrEqual(4);
    // cells two steps away never hold a point: the window's reach is under a pitch beyond the neighbour's
    for (let k = 0; k < 3000; k++) {
      const p = points[k], home = cellAt(p), near = new Set([idOf(home), ...cellNeighbours(home).filter(Boolean).map((c) => idOf(c!))]);
      for (const n1 of cellNeighbours(home)) {
        if (!n1) continue;
        for (const o of cellNeighbours(n1)) {
          if (!o || near.has(idOf(o))) continue;
          const [x, y] = onPlane(cellFrame(o), p);
          if (dot(cellCentre(o), p) < 0) continue;
          expect(blendWeight(x, y)).toBe(0);
        }
      }
    }
    console.log(`coverage: ${points.length} points, at most ${most} windows, the largest share at least ${least.toFixed(3)}`);
  });

  test("the blend weight is 0 at a window's edge, rises by a smoothstep over the ramp to 1, and the pixel map is the island grid's", () => {
    const h = WINDOW_M / 2;
    expect(blendWeight(h, 0)).toBe(0);
    expect(blendWeight(0, -h)).toBe(0);
    expect(blendWeight(h + 100, 0)).toBe(0);
    expect(blendWeight(0, 0)).toBe(1);
    expect(blendWeight(h - BLEND_M, h - BLEND_M)).toBe(1);
    expect(blendWeight(h - BLEND_M / 2, 0)).toBeCloseTo(0.5, 12);
    let prev = 0;
    for (let d = 0; d <= BLEND_M; d += BLEND_M / 32) { const w = blendWeight(h - d, 0); expect(w).toBeGreaterThanOrEqual(prev); prev = w; }
    // a cell's centre is at +0.5, x east and y against the plane's y
    expect(pixelOf(0, 0)).toEqual([N / 2, N / 2]);
    expect(pixelOf(CELL / 2 - (N / 2) * CELL, (N / 2) * CELL - CELL / 2)).toEqual([0.5, 0.5]);
    const f = Float32Array.from({ length: N * N }, (_, i) => (i % N) * 2 + Math.floor(i / N) * 3);
    expect(sample(f, 10.5, 20.5)).toBe(10 * 2 + 20 * 3);
    expect(sample(f, 10.75, 20.5)).toBeCloseTo(80.5, 4);
  });

  test("the same planet cell is found from the planet's own grid by any of its points", () => {
    // a cell's window centre lies in a tier-0 cell that locateVec finds, across face edges as well
    const g = makeGrid(256);
    for (let id = 0; id < CELLS; id += 97) {
      const q = locateVec(g, cellCentre(cellOfId(id)));
      expect(q.face).toBeGreaterThanOrEqual(0);
      expect(q.fx).toBeGreaterThanOrEqual(0);
      expect(q.fx).toBeLessThanOrEqual(1);
    }
  });
});
