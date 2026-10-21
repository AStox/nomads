// The water table's start on a fine tier: a coarser tier's heads (the global cascade's, water-global.ts) carried to the fine cells by bilinear interpolation in the face's index space, across
// a face's edge by the cells across it (patch.ts cellAcross), at a cube's corner the missing diagonal cell the mean of the two beside it (the stencil of regional.ts `child4`, for any ratio
// of tiers). A cell's seed is a function of the coarse heads alone, not of the patch it is read in, so two patches seed a shared cell with the same word.
import { tierGrid } from "./grid";
import { cellAcross, type Patch } from "./patch";

export function seedOf(patch: Patch, tier: number, coarseTier: number, coarse: ArrayLike<number>): Int32Array {
  const gc = tierGrid(coarseTier), nc = gc.fn, B = 2 ** (tier - coarseTier), fn = nc * B, cells = fn * fn, ccells = nc * nc, out = new Int32Array(patch.ids.length);
  const val = (f: number, x: number, y: number): number => {
    if (x >= 0 && x < nc && y >= 0 && y < nc) return coarse[f * ccells + y * nc + x];
    const id = cellAcross(gc, f, x, y);
    return id < 0 ? NaN : coarse[id];
  };
  for (let k = 0; k < out.length; k++) {
    if (patch.missing[k]) continue;
    const id = patch.ids[k], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn;
    const cx = Math.floor(X / B), cy = Math.floor(Y / B), ux = (X - cx * B + 0.5) / B, uy = (Y - cy * B + 0.5) / B;
    const dx = ux < 0.5 ? -1 : 1, dy = uy < 0.5 ? -1 : 1, nx = Math.abs(ux - 0.5), ny = Math.abs(uy - 0.5), ox = 1 - nx, oy = 1 - ny;
    const v00 = val(f, cx, cy), v10 = val(f, cx + dx, cy), v01 = val(f, cx, cy + dy);
    let v11 = val(f, cx + dx, cy + dy);
    if (Number.isNaN(v11)) v11 = (v10 + v01) / 2;
    out[k] = Math.round(ox * oy * v00 + nx * oy * v10 + ox * ny * v01 + nx * ny * v11);
  }
  return out;
}
