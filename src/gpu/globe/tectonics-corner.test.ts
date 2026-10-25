// The tectonic move round a cube's corner (tectonics-corner.ts): the overlap of a rotated parcel with the cells is exact, and a rigid move covers every cell once there, where cloud in cell alone covered
// the cells beside a corner 0.89 to 1.25 times (measured on the 391 km planet's plate 3: min 0.8882, max 1.2385 over the cells within 4 of a corner, 0.91 to 1.12 within 8).
import { expect, test } from "bun:test";
import { PLANET_RADIUS_M, areaSr, tierGrid } from "./grid";
import { CHAIN } from "./window";
import { Twin, extTables, makeSetup, rotation, startingState } from "./tectonics";
import { CORNER_D, CORNER_K, cornerCells, cornerIndex, cornerTable, overlaps } from "./tectonics-corner";

const g = tierGrid(0, PLANET_RADIUS_M), n = g.fn;
const set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius: PLANET_RADIUS_M });
const turns = set.plates.map((pl) => rotation(pl.pole, pl.rate * set.params.stepMy));

test("the cells a rotated parcel overlaps have its own area to 1e-9, and the turn by nothing leaves it in its own cell", () => {
  for (const [f, X, Y] of [[3, 0, 0], [2, n - 1, 0], [5, 0, n - 1], [0, 1, 1], [4, 17, 3], [1, n - 1, n - 1], [3, 100, 100]]) {
    for (const R of turns.slice(0, 4)) {
      const sum = overlaps(g, f, X, Y, R).reduce((s, e) => s + e.sr, 0);
      expect(Math.abs(sum / areaSr(g, X, Y) - 1)).toBeLessThan(1e-9);
    }
  }
  const same = overlaps(g, 3, 0, 0, [1, 0, 0, 0, 1, 0, 0, 0, 1]).filter((e) => e.sr > 1e-9 * areaSr(g, 0, 0));
  expect(same.length).toBe(1);
  expect(same[0].id).toBe((3 * n + 0) * n + 0);
});

test("the table's shares sum to 2^16 for every plate and every parcel of the corner squares, the largest first, and keep at most CORNER_K cells", () => {
  const table = cornerTable(g, turns);
  expect(table.length).toBe(turns.length * cornerCells() * CORNER_K * 2);
  let most = 0;
  for (let at = 0; at < table.length; at += CORNER_K * 2) {
    let sum = 0, prev = 65537, e = 0;
    for (; e < CORNER_K && table[at + 2 * e + 1] > 0; e++) { sum += table[at + 2 * e + 1]; expect(table[at + 2 * e + 1]).toBeLessThanOrEqual(prev); prev = table[at + 2 * e + 1]; }
    expect(sum).toBe(65536);
    most = Math.max(most, e);
  }
  expect(most).toBeLessThanOrEqual(CORNER_K);
  expect(cornerIndex(n, 3, 0, 0)).toBe(((3 * 4) * CORNER_D) * CORNER_D);
  expect(cornerIndex(n, 3, 100, 100)).toBe(-1);
});

test("a rigid move covers each cell once round a cube's corner: plate 3's step, coverage over the cell's area within 0.5 % within 8 cells of every corner and 1.5 % within 16 (cloud in cell alone: 12 % within 8, 24 % within 4)", () => {
  const ext = extTables(set.grid), tw = new Twin(set, ext, startingState(set, ext.tab).S), cov = new Float64Array(6 * n * n);
  const area = (id: number) => ext.T[Math.floor(id / (n * n)) * 65536 + (id % (n * n))];
  for (let f = 0; f < 6; f++) for (let Y = 0; Y < n; Y++) for (let X = 0; X < n; X++) {
    const st = tw.stencil(f * 65536 + Y * 256 + X, { face: f, X, Y }, 3), a = area((f * n + Y) * n + X);
    expect(st.w.reduce((s, x) => s + x, 0)).toBe(65536);
    st.c.forEach((c, k) => { cov[(c.face * n + c.Y) * n + c.X] += (a * st.w[k]) / 65536; });
  }
  let near = 0, ring = 0;
  for (let id = 0; id < cov.length; id++) {
    const r = id % (n * n), Y = Math.floor(r / n), X = r % n, dist = Math.max(Math.min(X, n - 1 - X), Math.min(Y, n - 1 - Y)), dev = Math.abs(cov[id] / area(id) - 1);
    if (dist < 8) near = Math.max(near, dev);
    if (dist < 16) ring = Math.max(ring, dev);
  }
  expect(near).toBeLessThan(0.005);
  expect(ring).toBeLessThan(0.015);
});
