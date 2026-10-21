// The window lattice: the cube-sphere cut into the squares a window is made at, so that every point of the planet has a window,
// a window's neighbours are known across face edges and cube corners, and windows made in any order meet (plan
// docs/plans/2026-10-20-001-feat-seamless-globe-plan.md, Unit 2; docs/research/globe/2026-10-20-lattice-impl.md).
//
// A face is cut into LATTICE_N by LATTICE_N cells of equal steps of the equiangular coordinates (the grid.ts map, so a cell's
// edges are great circles, the neighbours across an edge are an integer map and the cells nest in no tier: LATTICE_N is not a
// power of two). A window is the 19.2 km square of 75 m cells whose centre is a cell's and whose axes are the cell's: x along
// the face's X, y perpendicular to it (so y is not north: `turn` says how far it is from it, and the sun and the wind are turned
// by it, window.ts and sky.ts). The window is larger than the cell's pitch so that windows overlap, by a margin each shares with
// its neighbours across which their heights are blended (R1750).
import { CELL, N } from "../../terrain/grid";
import { FRAMES, NEIGHBOURS8, RADIUS_M, cellId, centre, eastNorth, haloSource, latLon, locateVec, makeGrid, pointAt, step, type Grid, type V3 } from "./grid";
import { WINDOW_M, onPlane, type Frame } from "./window";

// The blend's ramp, m: a window's weight rises from nothing at its edge to full this far in [design: 16 of its 75 m cells, about
// one ridge spacing of the window's own valleys, R1750]. A wider ramp shows the two windows' unlike ridges over a longer strip, a
// narrower one a steeper change; each also sets the lattice's pitch below.
export const BLEND_M = 16 * CELL;
// Cells along a face's side [measured, R1751]: the least even count for which every one of 430,000 points (random, along and either
// side of the 12 cube edges, and within 30 km of each of the 8 corners) stands on the plateau of some window, the window less a
// ramp each side. The pitch alone does not decide it: at a face's centre the pitch is R pi / 2 over the count (14.2 km here, the
// plateau's side is 16.8), but the cells shear to 60 and 120 degrees at a cube's corner, where a cell's far corner is 0.8 of a pitch
// from its centre across the diagonal, so that the three windows round a corner leave a hole there until the count is 222 (188,
// where the pitch alone fits, leaves a hole at each corner; 220 leaves 29 sampled points 1% short of the plateau).
export const LATTICE_N = 222;
const lattice = (): Grid => makeGrid(LATTICE_N);

export interface Cell { face: number; X: number; Y: number }
export const CELLS = 6 * LATTICE_N * LATTICE_N;
export const idOf = (c: Cell) => cellId(lattice(), c.face, c.X, c.Y);
export function cellOfId(id: number): Cell {
  const n = LATTICE_N;
  return { face: Math.floor(id / (n * n)), Y: Math.floor(id / n) % n, X: id % n };
}

// The cell holding a point (a unit vector) or a place (degrees). A point on the edge between cells goes to one of them, the lower
// face's and then the lower index (grid.ts locateVec).
export function cellAt(p: V3): Cell {
  const q = locateVec(lattice(), p);
  return { face: q.face, X: q.X, Y: q.Y };
}
export const cellAtPlace = (latDeg: number, lonDeg: number): Cell => {
  const d = Math.PI / 180, lat = latDeg * d, lon = lonDeg * d;
  return cellAt([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]);
};
export const cellCentre = (c: Cell): V3 => centre(lattice(), c.face, c.X, c.Y);
// The cell's four corners, SW, SE, NE, NW in its own axes.
export function cellCorners(c: Cell): [V3, V3, V3, V3] {
  const g = lattice();
  return [pointAt(g, c.face, c.X, c.Y, 0, 0), pointAt(g, c.face, c.X, c.Y, 1, 0), pointAt(g, c.face, c.X, c.Y, 1, 1), pointAt(g, c.face, c.X, c.Y, 0, 1)];
}

// The cell next to c in direction d (0 east, 1 north, 2 west, 3 south in its own axes), across face edges too.
export function cellStep(c: Cell, d: number): Cell {
  const s = step(lattice(), c.face, c.X, c.Y, d);
  return { face: s.face, X: s.X, Y: s.Y };
}
// The eight neighbours in the order east, north, west, south, NE, NW, SW, SE; null for the diagonal that does not exist at a cube's
// corner (the three cells of a corner are neighbours of one another and no fourth stands there).
export function cellNeighbours(c: Cell): (Cell | null)[] {
  const g = lattice();
  return NEIGHBOURS8.map(([dx, dy]) => {
    const s = haloSource(g, c.face, c.X + dx, c.Y + dy);
    return s ? { face: s.face, X: s.X, Y: s.Y } : null;
  });
}

// ---------- the window's frame ----------
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const frames = new Map<number, Frame>();
// The frame of the window at a cell: centred on the cell's centre, x along the face's X axis (the tangent of the great circle of
// constant b through the centre), y the outward axis crossed with it (so that x, y, outward are right-handed as east, north, up
// are). turn is y's bearing from true north toward the east.
export function cellFrame(c: Cell): Frame {
  const id = idOf(c);
  let f = frames.get(id);
  if (!f) {
    const p = cellCentre(c), { ex } = FRAMES[c.face];
    // d P / d u = (ex - P (P . ex)) / r, then normalised
    const t: V3 = [ex[0] - p[0] * dot(p, ex), ex[1] - p[1] * dot(p, ex), ex[2] - p[2] * dot(p, ex)], tn = Math.hypot(t[0], t[1], t[2]);
    const e: V3 = [t[0] / tn, t[1] / tn, t[2] / tn];
    const n: V3 = [p[1] * e[2] - p[2] * e[1], p[2] * e[0] - p[0] * e[2], p[0] * e[1] - p[1] * e[0]];
    const [east, north] = eastNorth(p), { lat, lon } = latLon(p);
    f = { c: p, e, n, latDeg: (lat * 180) / Math.PI, lonDeg: (lon * 180) / Math.PI, turn: Math.atan2(dot(n, east), dot(n, north)) };
    frames.set(id, f);
  }
  return f;
}

// ---------- ground size ----------
export interface LatticeStats {
  pitchMax: number; pitchMin: number; // m between the centres of neighbours along an axis (the largest is at a face's centre)
  skewMin: number; skewMax: number; // degrees between the cell's two axes at its centre (90 at a face's centre, 60 at its corners)
  areaMax: number; areaMin: number; // km2 of a cell
}
export function latticeStats(): LatticeStats {
  const g = lattice(), n = LATTICE_N, out = { pitchMax: 0, pitchMin: Infinity, skewMin: 180, skewMax: 0, areaMax: 0, areaMin: Infinity };
  const arc = (a: V3, b: V3) => 2 * Math.atan2(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2])) * RADIUS_M;
  // one face is enough: the six are the same by symmetry
  for (let Y = 0; Y < n; Y++)
    for (let X = 0; X < n; X++) {
      const w = pointAt(g, 0, X, Y, 0, 0.5), e = pointAt(g, 0, X, Y, 1, 0.5), s = pointAt(g, 0, X, Y, 0.5, 0), nn = pointAt(g, 0, X, Y, 0.5, 1), p = centre(g, 0, X, Y);
      const pa = arc(w, e), pb = arc(s, nn);
      out.pitchMax = Math.max(out.pitchMax, pa, pb); out.pitchMin = Math.min(out.pitchMin, pa, pb);
      const ta: V3 = [e[0] - w[0], e[1] - w[1], e[2] - w[2]], tb: V3 = [nn[0] - s[0], nn[1] - s[1], nn[2] - s[2]];
      const rm = (t: V3): V3 => [t[0] - p[0] * dot(p, t), t[1] - p[1] * dot(p, t), t[2] - p[2] * dot(p, t)], a2 = rm(ta), b2 = rm(tb);
      const ang = (Math.acos(dot(a2, b2) / Math.hypot(...a2) / Math.hypot(...b2)) * 180) / Math.PI;
      out.skewMin = Math.min(out.skewMin, ang); out.skewMax = Math.max(out.skewMax, ang);
      const area = cellAreaKm2(X, Y);
      out.areaMax = Math.max(out.areaMax, area); out.areaMin = Math.min(out.areaMin, area);
    }
  return out;
}
// A cell's area in km2 from the closed form (grid.ts areaSr), the same on every face.
function cellAreaKm2(X: number, Y: number): number {
  const g = lattice(), below = (u: number, v: number) => Math.atan2(u * v, Math.sqrt(1 + u * u + v * v));
  const u0 = g.node[X], u1 = g.node[X + 1], v0 = g.node[Y], v1 = g.node[Y + 1];
  return ((below(u1, v1) - below(u0, v1) - below(u1, v0) + below(u0, v0)) * RADIUS_M * RADIUS_M) / 1e6;
}

// ---------- the blend ----------
const half = WINDOW_M / 2;
const ramp = (d: number) => { const t = Math.min(1, Math.max(0, d / BLEND_M)); return t * t * (3 - 2 * t); };
// A window's weight at plane position (x, y), m from its centre along its axes: the product of a smoothstep rise over BLEND_M in from
// each edge, 1 on the plateau and 0 on and beyond the edge.
export const blendWeight = (x: number, y: number) => ramp(half - Math.abs(x)) * ramp(half - Math.abs(y));

export interface Cover { cell: Cell; x: number; y: number; w: number } // the window's plane position of the point and the point's share of the blend (the shares sum to 1)
// The windows that hold a point and each one's share. Only the home cell and its eight neighbours can: a window reaches 9.6 km from
// its centre and the next but one cell's centre is a whole pitch beyond the neighbour's.
export function cover(p: V3): Cover[] {
  const home = cellAt(p), cells = [home, ...cellNeighbours(home).filter((c): c is Cell => !!c)], out: Cover[] = [];
  let sum = 0;
  for (const c of cells) {
    const [x, y] = onPlane(cellFrame(c), p), w = blendWeight(x, y);
    if (w <= 0) continue;
    out.push({ cell: c, x, y, w });
    sum += w;
  }
  for (const o of out) o.w /= sum;
  return out;
}

// The window's pixel (continuous: a cell's centre is at +0.5) of a plane position, in the island grid's order (x east, y south
// there, so here along the window's x and against its y).
export const pixelOf = (x: number, y: number): [number, number] => [x / CELL + N / 2, -y / CELL + N / 2];
// Bilinear sampling of a window's field (N by N, row major) at a continuous pixel, clamped at the edge.
export function sample(field: ArrayLike<number>, px: number, py: number): number {
  const fx = Math.min(N - 1, Math.max(0, px - 0.5)), fy = Math.min(N - 1, Math.max(0, py - 0.5)), x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(N - 1, x0 + 1), y1 = Math.min(N - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  return (field[y0 * N + x0] * (1 - tx) + field[y0 * N + x1] * tx) * (1 - ty) + (field[y1 * N + x0] * (1 - tx) + field[y1 * N + x1] * tx) * ty;
}
