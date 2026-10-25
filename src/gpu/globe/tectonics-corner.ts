// The tectonic move at the cube's corners: where each parcel lands as the share of its area that falls in each cell it overlaps (a conservative remap).
//
// Away from a cube's corner the three lattices of two neighbouring faces are within a few degrees of parallel, and sharing a parcel among the four cells nearest its landing (cloud in cell, wgsl/globe-tectonics.ts
// `stencil`) is the overlap of a square with the lattice, so every cell is covered exactly once by a rigid move. Round a corner the faces' lattices are turned against each other (their lines meet at 60 degrees, so a face's
// lattice is skewed by up to 30 degrees to the next one's) and the parcels of one face land on the cells of another as a rotated lattice of points on a square one, which cloud in cell covers unevenly (moire): the coverage of the
// cells beside the corner came out 0.89 to 1.25 for a rigid move, where it is 1.000 inside a face. The cells under 0.9375 count as a gap (new basalt, in a continent too) and those over 1.0625 as an overlap (crust stacked and
// kept), and the two are not symmetric: a gap makes crust and an overlap keeps its extra, so each step grew the crust of the cells at the corner by some 1.5 % and the three faces' corner cells stood 1 to 3 km thick over their
// neighbours after the run, a ridge along the edges that the land at 35.26 S 135 W showed as a straight step.
//
// The parcels within CORNER.OUT cells of a corner are moved partly by the overlap, and wholly by it from CORNER.IN cells in (the blend is linear in the distance, since a hard seam between the two shares leaves the
// coverage 12 % off along it: each is exact alone, and the cloud in cell's smear across a seam is not the complement of the overlap's sharp edge). The overlap: for every plate and every parcel of those squares, the cells the rotated parcel overlaps and the share
// of its area in each (the parcel's four vertices turned by the plate's step, projected on each face's plane where the cell edges and the parcel's edges, all great circles, are straight lines, the polygon clipped to each
// cell and its solid angle taken exactly). The shares sum to 2^16 exactly, so the volumes still go to the unit.
import { FRAMES, FACES, cellId, vertex, type Grid, type V3 } from "./grid";
import { CORNER } from "../wgsl/globe-tectonics";

export const CORNER_D = CORNER.D; // the corner squares' side, cells
export const CORNER_K = CORNER.K; // cells a parcel's shares are kept for (the most it overlaps in the skewed squares is 7)

// A corner square of a face: x below CORNER_D or at least n - CORNER_D, and the same of y. The index of the cell in the table (per plate), or -1.
export function cornerIndex(n: number, f: number, x: number, y: number, d = CORNER_D): number {
  const xh = x >= n - d, yh = y >= n - d;
  if ((x >= d && !xh) || (y >= d && !yh)) return -1;
  return ((f * 4 + (xh ? 1 : 0) + (yh ? 2 : 0)) * d + (yh ? y - (n - d) : y)) * d + (xh ? x - (n - d) : x);
}
export const cornerCells = (d = CORNER_D) => FACES * 4 * d * d;

type P2 = [number, number];
// Sutherland-Hodgman: the polygon clipped to the half plane keep(p) >= 0, edges cut at the line.
function clip(poly: P2[], axis: 0 | 1, value: number, keepAbove: boolean): P2[] {
  const out: P2[] = [], s = keepAbove ? 1 : -1, g = (p: P2) => s * (p[axis] - value);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ga = g(a), gb = g(b);
    if (ga >= 0) out.push(a);
    if ((ga >= 0) !== (gb >= 0)) { const t = ga / (ga - gb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
  }
  return out;
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// The solid angle of a convex spherical polygon given by unit vectors (a fan of triangles, Van Oosterom and Strackee).
function solidAngle(v: V3[]): number {
  let s = 0;
  for (let i = 1; i + 1 < v.length; i++) s += 2 * Math.atan2(Math.abs(dot3(v[0], cross3(v[i], v[i + 1]))), 1 + dot3(v[0], v[i]) + dot3(v[i], v[i + 1]) + dot3(v[i + 1], v[0]));
  return s;
}
const unitAt = (f: number, u: number, v: number): V3 => {
  const { n, ex, ey } = FRAMES[f], r = Math.sqrt(1 + u * u + v * v);
  return [(n[0] + u * ex[0] + v * ey[0]) / r, (n[1] + u * ex[1] + v * ey[1]) / r, (n[2] + u * ex[2] + v * ey[2]) / r];
};

// The cells the cell (f, X, Y) overlaps after the rotation R (row-major 3 by 3) and the solid angle of each overlap.
export function overlaps(g: Grid, f: number, X: number, Y: number, R: readonly number[]): { id: number; sr: number }[] {
  const corners = [[X, Y], [X + 1, Y], [X + 1, Y + 1], [X, Y + 1]].map(([i, j]) => {
    const v = vertex(g, f, i, j);
    return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]] as V3;
  });
  const out: { id: number; sr: number }[] = [], n = g.fn;
  for (let F = 0; F < FACES; F++) {
    const { n: nn, ex, ey } = FRAMES[F], w = corners.map((c) => dot3(c, nn));
    if (Math.min(...w) <= 0.2) continue;
    const poly: P2[] = corners.map((c, k) => [dot3(c, ex) / w[k], dot3(c, ey) / w[k]]);
    const us = poly.map((p) => p[0]), vs = poly.map((p) => p[1]), u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    if (u1 <= -1 || u0 >= 1 || v1 <= -1 || v0 >= 1) continue;
    // the first cell whose upper edge lies above the polygon's lower extent
    const first = (lo: number) => { let a = 0; while (a < n - 1 && g.node[a + 1] <= lo) a++; return a; };
    for (let j = first(v0); j < n && g.node[j] < v1; j++) {
      for (let i = first(u0); i < n && g.node[i] < u1; i++) {
        let p = clip(poly, 0, g.node[i], true);
        if (p.length) p = clip(p, 0, g.node[i + 1], false);
        if (p.length) p = clip(p, 1, g.node[j], true);
        if (p.length) p = clip(p, 1, g.node[j + 1], false);
        if (p.length < 3) continue;
        const sr = solidAngle(p.map(([u, v]) => unitAt(F, u, v)));
        if (sr > 0) out.push({ id: cellId(g, F, i, j), sr });
      }
    }
  }
  return out;
}

// The table kernel and twin read: per plate, per corner-square cell, CORNER_K entries of two words (the destination cell id, the share in 2^16ths), the largest share first, a zero share for an unused entry.
export function cornerTable(g: Grid, rotations: readonly (readonly number[])[], d = CORNER_D, k = CORNER_K): Int32Array {
  const n = g.fn, out = new Int32Array(rotations.length * cornerCells(d) * k * 2);
  rotations.forEach((R, p) => {
    for (let f = 0; f < FACES; f++)
      for (let c = 0; c < 4; c++)
        for (let ly = 0; ly < d; ly++)
          for (let lx = 0; lx < d; lx++) {
            const x = (c & 1 ? n - d : 0) + lx, y = (c & 2 ? n - d : 0) + ly;
            const list = overlaps(g, f, x, y, R).sort((a, b) => b.sr - a.sr).slice(0, k), total = list.reduce((s, e) => s + e.sr, 0);
            const w = list.map((e) => Math.floor((e.sr / total) * 65536));
            let rest = 65536 - w.reduce((s, x2) => s + x2, 0);
            for (let e = 0; rest > 0; e = (e + 1) % list.length, rest--) w[e]++;
            const at = ((p * FACES * 4 + f * 4 + c) * d * d + ly * d + lx) * k * 2;
            list.forEach((e, q) => { out[at + 2 * q] = e.id; out[at + 2 * q + 1] = w[q]; });
          }
  });
  return out;
}
