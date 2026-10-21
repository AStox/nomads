// A patch lays a tile and its halo flat across a face's edges: no cell twice, the tile in the middle, the first ring the grid's own halo, and every pair of neighbours in the
// patch is a cell width apart on the sphere however deep past an edge (the unfolding is continuous). Each case alone: bun test ./src/gpu/globe/patch.test.ts -t "<name>"
import { describe, expect, test } from "bun:test";
import { centre, haloSource, tierGrid } from "./grid";
import { gather, localOf, patchOf, scatter, tileAt, tileCount } from "./patch";

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
});
