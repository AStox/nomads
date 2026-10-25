// A patch lays a tile and its halo flat across a face's edges: no cell twice, the tile in the middle, the first ring the grid's own halo, and every pair of neighbours in the
// patch is a cell width apart on the sphere however deep past an edge (the unfolding is continuous). Each case alone: bun test ./src/gpu/globe/patch.test.ts -t "<name>"
import { describe, expect, test } from "bun:test";
import { centre, haloSource, tierGrid } from "./grid";
import { cellAcross, cornerCells, gather, localOf, patchOf, scatter, tileAt, tileCount } from "./patch";

const TIER = 1, HALO = 40, g = tierGrid(TIER), n = g.fn;
const angle = (a: number[], b: number[]) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe("a patch", () => {
  test("holds the tile in its middle and no cell twice, and its first ring is the grid's halo", () => {
    for (const [f, tx, ty] of [[0, 1, 0], [4, 0, 1], [2, 1, 1], [5, 0, 0]] as const) {
      const p = patchOf(TIER, f, tx, ty, HALO), seen = new Set<number>();
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) expect(p.ids[(y + HALO) * p.side + x + HALO]).toBe((f * n + ty * 256 + y) * n + tx * 256 + x);
      for (let k = 0; k < p.ids.length; k++) if (!p.missing[k]) { expect(seen.has(p.ids[k])).toBe(false); seen.add(p.ids[k]); }
      // the cells one past a face's edge are the grid's halo cells
      for (let y = 0; y < p.side; y++)
        for (let x = 0; x < p.side; x++) {
          const X = tx * 256 - HALO + x, Y = ty * 256 - HALO + y;
          if (!((X === -1 || X === n) !== (Y === -1 || Y === n))) continue;
          if (X < -1 || X > n || Y < -1 || Y > n) continue;
          const s = haloSource(g, f, X, Y);
          if (s) expect(p.ids[y * p.side + x]).toBe((s.face * n + s.Y) * n + s.X);
        }
    }
  });

  test("keeps every pair of neighbours a cell width apart on the sphere, across edges and beside a cube's corner", () => {
    for (const [f, tx, ty] of [[0, 1, 0], [0, 0, 0], [4, 0, 1], [1, 1, 1], [5, 1, 0], [3, 0, 1]] as const) {
      const p = patchOf(TIER, f, tx, ty, HALO), X0 = tx * 256 - HALO, Y0 = ty * 256 - HALO;
      const at = (k: number) => { const id = p.ids[k], c = n * n, ff = Math.floor(id / c), r = id - ff * c, Y = Math.floor(r / n); return centre(g, ff, r - Y * n, Y) as unknown as number[]; };
      let worst = 0;
      for (let y = 0; y < p.side - 1; y++)
        for (let x = 0; x < p.side - 1; x++) {
          const k = y * p.side + x;
          if (p.missing[k] || p.missing[k + 1] || p.missing[k + p.side]) continue;
          const dx = angle(at(k), at(k + 1)) / g.width, dy = angle(at(k), at(k + p.side)) / g.width;
          worst = Math.max(worst, Math.abs(Math.log(dx)), Math.abs(Math.log(dy)));
          expect(dx).toBeGreaterThan(0.6);
          expect(dx).toBeLessThan(1.25);
          expect(dy).toBeGreaterThan(0.6);
          expect(dy).toBeLessThan(1.25);
        }
      expect(X0 + Y0).toBeDefined();
      expect(worst).toBeLessThan(0.5);
    }
  });

  test("gathers a field and scatters its interior back, and finds a cell's place in the patch", () => {
    const p = patchOf(TIER, 2, 1, 0, HALO), field = Int32Array.from({ length: 6 * n * n }, (_, i) => i * 3 + 1), mine = gather(p, field), back = new Int32Array(field.length);
    for (let k = 0; k < p.ids.length; k++) expect(mine[k]).toBe(field[p.ids[k]]);
    scatter(p, mine, back);
    let set = 0;
    for (let i = 0; i < back.length; i++) if (back[i] !== 0) { set++; expect(back[i]).toBe(field[i]); }
    expect(set).toBe(256 * 256);
    const find = localOf(p);
    for (let k = 0; k < p.ids.length; k += 7) if (!p.missing[k]) expect(find(p.ids[k])).toBe(k);
    expect(find(0)).toBe(-1);
    expect(tileCount(TIER)).toBe(24);
    expect(tileAt(TIER, 11)).toEqual({ face: 2, tx: 1, ty: 1 });
  });

  test("the wedge a flat window has past a cube's corner is continuous with the face across on each side", () => {
    const R = 24, centreOf = (id: number) => { const c = n * n, ff = Math.floor(id / c), r = id - ff * c, Y = Math.floor(r / n); return centre(g, ff, r - Y * n, Y) as unknown as number[]; };
    const width = (a: number, b: number) => angle(centreOf(a), centreOf(b)) / g.width;
    let wedge = 0;
    for (let f = 0; f < 6; f++)
      for (const [cx, cy] of [[0, 0], [n, 0], [0, n], [n, n]] as const) {
        // the corner's wedge is the quadrant past both edges: X < 0 or >= n and Y likewise
        const at = (i: number, j: number) => [cx === 0 ? -1 - i : n + i, cy === 0 ? -1 - j : n + j] as const;
        for (let j = 0; j < R; j++)
          for (let i = 0; i < R; i++) {
            const [X, Y] = at(i, j), w = cornerCells(g, f, X, Y);
            expect(w).not.toBeNull();
            wedge++;
            expect(w!.t).toBeGreaterThan(0);
            expect(w!.t).toBeLessThan(1);
            // next to the wedge's cell one step out along each axis: a lattice continued flat, a cell width from it
            if (i + 1 < R) { const o = cornerCells(g, f, ...at(i + 1, j))!; expect(width(w!.a, o.a)).toBeGreaterThan(0.6); expect(width(w!.a, o.a)).toBeLessThan(1.25); expect(width(w!.b, o.b)).toBeGreaterThan(0.6); expect(width(w!.b, o.b)).toBeLessThan(1.25); }
            if (j + 1 < R) { const o = cornerCells(g, f, ...at(i, j + 1))!; expect(width(w!.a, o.a)).toBeGreaterThan(0.6); expect(width(w!.a, o.a)).toBeLessThan(1.25); expect(width(w!.b, o.b)).toBeGreaterThan(0.6); expect(width(w!.b, o.b)).toBeLessThan(1.25); }
            // the cell beside the wedge across the first edge (the face across's, on the same side of the other edge) is a cell width from `a`, and across the second edge from `b`
            if (j === 0) { const [bx, by] = at(i, -1), nb = cellAcross(g, f, bx, by); expect(nb).toBeGreaterThanOrEqual(0); expect(width(w!.a, nb)).toBeLessThan(1.25); }
            if (i === 0) { const [bx, by] = at(-1, j), nb = cellAcross(g, f, bx, by); expect(nb).toBeGreaterThanOrEqual(0); expect(width(w!.b, nb)).toBeLessThan(1.25); }
          }
        // the share of `b` runs from 0 beside the first side to 1 beside the second, and half on the diagonal
        expect(cornerCells(g, f, ...at(R - 1, 0))!.t).toBeLessThan(0.05);
        expect(cornerCells(g, f, ...at(0, R - 1))!.t).toBeGreaterThan(0.95);
        expect(cornerCells(g, f, ...at(R - 1, R - 1))!.t).toBeCloseTo(0.5, 5);
        // a cell that is no wedge's has no wedge ground
        expect(cornerCells(g, f, cx === 0 ? 3 : n - 4, cy === 0 ? -3 : n + 3)).toBeNull();
        expect(cornerCells(g, f, cx === 0 ? 3 : n - 4, cy === 0 ? 3 : n - 4)).toBeNull();
      }
    expect(wedge).toBe(6 * 4 * R * R);
  });
});
