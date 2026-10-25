// A patch: one 256 by 256 tile of a tier and a halo of H cells all round it, laid flat as a square grid of side 256 + 2H, the way a face's lattice continues across its edges
// (the cell H deep past an edge is the neighbouring face's cell as many deep, the index along the edge kept or reversed as grid.ts EDGES says). The island's stages are
// kernels over a square grid; a patch is what they are run on, and the cells of a tile's interior are the stage's answers for it. A cell's answer depends only on the
// fields within the stage's reach, which the halo covers, so it is the same whichever tile holds it. Where a cube's corner leaves no cell (both coordinates past an edge) the
// patch repeats the nearest cell of the face; `missing` marks them.
import { EDGES, TILE, tierGrid, type Grid } from "./grid";

export interface Patch {
  readonly tier: number; readonly face: number; readonly tx: number; readonly ty: number; readonly halo: number;
  readonly x0: number; readonly y0: number; // the face position of the interior's first cell (a tile's own, unless made by patchAt)
  readonly interior: number; // the interior's side in cells: one tile's 256, or a block of tiles (the streamed solves run on 512 or 1024)
  readonly side: number; // interior + 2 * halo
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

// A window of cells laid flat on one face that holds a cube's corner has a quarter turn more than the sphere has round the corner (three faces cut open and laid in a plane): the wedge
// past both of the face's edges has no cell. It is no place on the sphere, but the window's shadows and folds run across it, so it takes the ground each side would continue with: the
// cell across the X edge and then the face across's own edge to the third face (`a`), the cell across the Y edge and then across (`b`), each a lattice continued flat, so `a` is beside
// the cells of the first face across along the wedge's one side and `b` beside the other's. `t` is the share of `b`, the cell's angle from the first side over the quarter turn: the ground is
// continuous with both sides. Null for a cell that is no wedge's (inside the face, or past one edge only) or lies beyond the third face.
export function cornerCells(g: Grid, f: number, X: number, Y: number): { a: number; b: number; t: number } | null {
  const n = g.fn;
  if (!((X < 0 || X >= n) && (Y < 0 || Y >= n))) return null;
  const via = (xFirst: boolean) => {
    const d = xFirst ? (X < 0 ? 2 : 0) : Y < 0 ? 3 : 1, e = EDGES[f][d], run = xFirst ? Y : X, a = e.flip ? n - 1 - run : run;
    const depth = xFirst ? (X < 0 ? -X - 1 : X - n) : Y < 0 ? -Y - 1 : Y - n;
    const [nx, ny] = e.side === 0 ? [n - 1 - depth, a] : e.side === 1 ? [a, n - 1 - depth] : e.side === 2 ? [depth, a] : [a, depth];
    return cellAcross(g, e.face, nx, ny);
  };
  const a = via(true), b = via(false);
  if (a < 0 || b < 0) return null;
  const dx = (X < 0 ? -X - 1 : X - n) + 0.5, dy = (Y < 0 ? -Y - 1 : Y - n) + 0.5;
  return { a, b, t: Math.atan2(dy, dx) / (Math.PI / 2) };
}

// A patch whose interior is the `interior` (a tile's 256) by `interior` cells from face position (x0, y0) (inside the face), for any halo: the tiles' own patches are the ones at multiples of
// 256, and a patch at another offset is how a test sees whether an answer depends on which tile holds the cell.
export function patchAt(tier: number, face: number, x0: number, y0: number, halo: number, interior = TILE): Patch {
  const g = tierGrid(tier), n = g.fn, side = interior + 2 * halo, ids = new Int32Array(side * side), missing = new Uint8Array(side * side), X0 = x0 - halo, Y0 = y0 - halo;
  // the cells inside the face by their place, the rest (the rings past an edge) by the edge's own mapping
  const xa = Math.max(0, -X0), xb = Math.min(side, n - X0);
  for (let y = 0; y < side; y++) {
    const Y = Y0 + y, row = y * side, inFace = Y >= 0 && Y < n;
    if (inFace) for (let x = xa; x < xb; x++) ids[row + x] = (face * n + Y) * n + X0 + x;
    for (let x = 0; x < side; x++) {
      if (inFace && x >= xa && x < xb) continue;
      let id = cellAcross(g, face, X0 + x, Y), miss = 0;
      if (id < 0) { id = cellAcross(g, face, Math.min(n - 1, Math.max(0, X0 + x)), Math.min(n - 1, Math.max(0, Y))); miss = 1; }
      ids[row + x] = id; missing[row + x] = miss;
    }
  }
  return { tier, face, tx: Math.floor(x0 / TILE), ty: Math.floor(y0 / TILE), halo, x0, y0, interior, side, ids, missing };
}
export const patchOf = (tier: number, face: number, tx: number, ty: number, halo: number, interior = TILE): Patch => patchAt(tier, face, tx * TILE, ty * TILE, halo, interior);

// The patch's copy of a global field: the field at each patch cell.
export function gather<A extends Float32Array | Int32Array | Uint32Array | Uint8Array | Int16Array | Uint16Array | Int8Array>(p: Patch, field: A): A {
  const out = new (field.constructor as new (n: number) => A)(p.ids.length);
  for (let k = 0; k < p.ids.length; k++) out[k] = field[p.ids[k]];
  return out;
}
// The patch's interior (the tile's own 256 by 256 cells) of a patch field written into the global field at the tile's cells.
export function scatter<A extends Float32Array | Int32Array | Uint32Array | Uint8Array | Int16Array | Uint16Array | Int8Array>(p: Patch, patchField: A, global: A): void {
  for (let y = 0; y < p.interior; y++) {
    const row = (y + p.halo) * p.side + p.halo;
    for (let x = 0; x < p.interior; x++) global[p.ids[row + x]] = patchField[row + x];
  }
}
// The patch cell of a global cell id, or -1 when it lies outside the patch. A cell of the face is found by its place; a cell of another face by a lookup of the halo's
// cells across the edges (made once for the patch).
export function localOf(p: Patch): (id: number) => number {
  const g = tierGrid(p.tier), n = g.fn, cells = n * n, X0 = p.x0 - p.halo, Y0 = p.y0 - p.halo, across = new Map<number, number>();
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
