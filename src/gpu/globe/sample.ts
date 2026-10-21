// Tier-0 fields of the planet at the cells of a finer tier: the bilinear value, in the face's index space, between the centres of the four tier-0 cells round each cell
// (the cells across a face's edge as grid.ts haloSource gives them; where a cube's corner leaves one out, the mean of the two beside it). It is the value regional.ts's remap
// gives a child before the parent's total is made exact, for any cell and never for a window: a cell's value depends on its parent and the parents round it.
import { haloSource, tierGrid } from "./grid";

const CORNER_BESIDE = [[0, 1, 3], [2, 1, 5], [6, 3, 7], [8, 5, 7]] as const;

// For each cell id of `tier`, the interpolated value of each field (tier-0 cell order) at the cell.
export function sampleCoarse(tier: number, ids: ArrayLike<number>, fields: ArrayLike<number>[]): Float32Array[] {
  const g0 = tierGrid(0), g = tierGrid(tier), n0 = g0.fn, fn = g.fn, cells = fn * fn, B = 1 << tier, out = fields.map(() => new Float32Array(ids.length));
  const nb = new Int32Array(9), val = new Float64Array(9 * fields.length), cache = new Map<number, Int32Array>();
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn, px = X >> tier, py = Y >> tier, pid = (f * n0 + py) * n0 + px;
    let around = cache.get(pid);
    if (!around) {
      around = new Int32Array(9);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx, y = py + dy;
          const s = haloSource(g0, f, x, y);
          around[(dy + 1) * 3 + dx + 1] = s ? (s.face * n0 + s.Y) * n0 + s.X : -1;
        }
      if (cache.size > 4096) cache.clear();
      cache.set(pid, around);
    }
    nb.set(around);
    const u = ((X & (B - 1)) + 0.5) / B, v = ((Y & (B - 1)) + 0.5) / B, ux = u < 0.5, vy = v < 0.5;
    const cx = ux ? 0 : 1, cy = vy ? 0 : 1, whx = ux ? u + 0.5 : u - 0.5, why = vy ? v + 0.5 : v - 0.5, wlx = 1 - whx, wly = 1 - why;
    for (let m = 0; m < fields.length; m++) {
      const o = m * 9, fm = fields[m];
      for (let c = 0; c < 9; c++) if (nb[c] >= 0) val[o + c] = fm[nb[c]];
      for (const [c, a, b] of CORNER_BESIDE) if (nb[c] < 0) val[o + c] = (val[o + a] + val[o + b]) / 2;
      const c0 = o + cy * 3 + cx;
      out[m][k] = wly * (wlx * val[c0] + whx * val[c0 + 1]) + why * (wlx * val[c0 + 3] + whx * val[c0 + 4]);
    }
  }
  return out;
}
