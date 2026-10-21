// A patch: one 256 by 256 tile of a tier and a halo of H cells all round it, laid flat as a square grid of side 256 + 2H, the way a face's lattice continues across its edges
// (the cell H deep past an edge is the neighbouring face's cell as many deep, the index along the edge kept or reversed as grid.ts EDGES says). The island's stages are
// kernels over a square grid; a patch is what they are run on, and the cells of a tile's interior are the stage's answers for it. A cell's answer depends only on the
// fields within the stage's reach, which the halo covers, so it is the same whichever tile holds it. Where a cube's corner leaves no cell (both coordinates past an edge) the
// patch repeats the nearest cell of the face; `missing` marks them.
import { EDGES, TILE, tierGrid, type Grid } from "./grid";

export interface Patch {
  readonly tier: number; readonly face: number; readonly tx: number; readonly ty: number; readonly halo: number;
  readonly side: number; // 256 + 2 * halo
  readonly ids: Int32Array; // the tier's cell id of patch cell (x, y) at y * side + x, x east and y north in the face's axes
  readonly missing: Uint8Array; // 1 where the cell is a repeat at a cube's corner
}

// The cell of the tier at face position (X, Y), which may lie up to `reach` cells past the face's edges; -1 at a cube's corner (both past an edge).
export function cellAcross(g: Grid, f: number, X: number, Y: number): number {
  const n = g.fn, xo = X < 0 || X >= n, yo = Y < 0 || Y >= n;
  if (!xo && !yo) return (f * n + Y) * n + X;
  if (xo && yo) return -1;
  const d = xo ? (X < 0 ? 2 : 0) : Y < 0 ? 3 : 1, e = EDGES[f][d], run = xo ? Y : X, a = e.flip ? n - 1 - run : run;
  const depth = xo ? (X < 0 ? -X - 1 : X - n) : Y < 0 ? -Y - 1 : Y - n;
  const [nx, ny] = e.side === 0 ? [n - 1 - depth, a] : e.side === 1 ? [a, n - 1 - depth] : e.side === 2 ? [depth, a] : [a, depth];
  if (nx < 0 || ny < 0 || nx >= n || ny >= n) return -1;
  return (e.face * n + ny) * n + nx;
}

export function patchOf(tier: number, face: number, tx: number, ty: number, halo: number): Patch {
  const g = tierGrid(tier), side = TILE + 2 * halo, ids = new Int32Array(side * side), missing = new Uint8Array(side * side), X0 = tx * TILE - halo, Y0 = ty * TILE - halo;
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      let id = cellAcross(g, face, X0 + x, Y0 + y), miss = 0;
      if (id < 0) { id = cellAcross(g, face, Math.min(g.fn - 1, Math.max(0, X0 + x)), Math.min(g.fn - 1, Math.max(0, Y0 + y))); miss = 1; }
      ids[y * side + x] = id; missing[y * side + x] = miss;
    }
  return { tier, face, tx, ty, halo, side, ids, missing };
}

// The patch's copy of a global field: the field at each patch cell.
export function gather<A extends Float32Array | Int32Array | Uint32Array | Uint8Array | Int16Array | Uint16Array | Int8Array>(p: Patch, field: A): A {
  const out = new (field.constructor as new (n: number) => A)(p.ids.length);
  for (let k = 0; k < p.ids.length; k++) out[k] = field[p.ids[k]];
  return out;
}
// The patch's interior (the tile's own 256 by 256 cells) of a patch field written into the global field at the tile's cells.
export function scatter<A extends Float32Array | Int32Array | Uint32Array | Uint8Array | Int16Array | Uint16Array | Int8Array>(p: Patch, patchField: A, global: A): void {
  for (let y = 0; y < TILE; y++) {
    const row = (y + p.halo) * p.side + p.halo;
    for (let x = 0; x < TILE; x++) global[p.ids[row + x]] = patchField[row + x];
  }
}
// The patch cell of a global cell id, or -1 when it lies outside the patch. A cell of the face is found by its place; a cell of another face by a lookup of the halo's
// cells across the edges (made once for the patch).
export function localOf(p: Patch): (id: number) => number {
  const g = tierGrid(p.tier), n = g.fn, cells = n * n, X0 = p.tx * TILE - p.halo, Y0 = p.ty * TILE - p.halo, across = new Map<number, number>();
  for (let k = 0; k < p.ids.length; k++) if (!p.missing[k] && Math.floor(p.ids[k] / cells) !== p.face) across.set(p.ids[k], k);
  return (id: number) => {
    const f = Math.floor(id / cells);
    if (f !== p.face) return across.get(id) ?? -1;
    const r = id - f * cells, Y = Math.floor(r / n), X = r - Y * n, x = X - X0, y = Y - Y0;
    return x >= 0 && y >= 0 && x < p.side && y < p.side && !p.missing[y * p.side + x] ? y * p.side + x : -1;
  };
}
// The tiles of a tier in a fixed order: face, then ty, then tx.
export const tileCount = (tier: number) => 6 * (1 << (2 * tier)) ;
export function tileAt(tier: number, k: number): { face: number; tx: number; ty: number } {
  const T = 1 << tier, per = T * T, face = Math.floor(k / per), r = k - face * per, ty = Math.floor(r / T);
  return { face, tx: r - ty * T, ty };
}
