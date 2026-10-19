// The globe's sphere grid: a cube-sphere of six faces, each a square of tiles of 256 by 256 cells (the island generator's
// kernels run on 256 by 256), with the equiangular gnomonic face map (Ronchi, Iacono and Paolucci 1996, R1400). A face is
// the cube's face seen from the centre through angles a and b in [-pi/4, pi/4] along its two axes, the cells are equal
// steps of a and b, and so every cell edge is an arc of a great circle, a cell's area has a closed form and the cells of
// the next tier are exactly four to a cell (the quadtree). Why this map and not the conformal one: docs/research/globe/
// 2026-10-19-grid.md.
//
// What is here:
// 1. the planet's size and the grid's cell sizes;
// 2. cell centres, areas, the east and north directions, from (face, X, Y) with X and Y counted along the whole face;
// 3. neighbours across tile edges, face edges and cube corners, and what happens to a field's axes across an edge;
// 4. the lookup from (lat, lon) to the cell and the fraction in it, and back;
// 5. the tables the kernels read (areas, link coefficients, gradient weights), rounded to integers with a margin check;
// 6. the kernels' host side (wgsl/globe-grid.ts): halo exchange, gradient and a conservative diffusion step, and the
//    TypeScript twin of each, checked bit for bit against the kernel in grid.test.ts.
//
// Axes. Face f has an outward axis n and two axes ex, ey with ex x ey = n (right-handed seen from outside). A cell is
// (face, X, Y) with X and Y in [0, fn): fn = 256 * 2^tier cells on a face's side. Its four neighbours are numbered 0 east
// (+X), 1 north (+Y), 2 west, 3 south in the face's own axes. Faces 0 to 3 go round the equator (centred on longitudes 0,
// 90, 180 and 270 degrees east, ex to the east and ey to the north), face 4 is the north pole's and face 5 the south's.
import type { Gpu } from "../device";
import { cover, dispatch, pipeline, readback, storage } from "../kernel";
import { HALO, PAD, PARAM, RING, SHIFT, TAB, TILE, globeWgsl } from "../wgsl/globe-grid";

export { HALO, PAD, TAB, TILE };
export const FACES = 6;
export const PAD_WORDS = PAD * PAD;
export const TILE_WORDS = TILE * TILE;

// ---------- 1. the planet ----------
// Planet radius, m: about 4,000 km across [design: the operator's decision of 2026-10-19, a planet smaller than Earth at
// the cost of compressed climate belts].
export const RADIUS_M = 2_000_000;

export interface Grid {
  readonly fn: number; // cells along a face's side
  readonly tiles: number; // tiles along a face's side (fn / 256; below 1 only for the float checks on small grids)
  readonly radius: number;
  readonly width: number; // a cell's angular width at the face's centre, radians: (pi / 2) / fn
  readonly node: Float64Array; // tan of the angle at each of the fn + 1 cell edges along an axis
  readonly mid: Float64Array; // tan of the angle at each of the fn cell centres along an axis
}

// tan of the angle (pi/4)(k/n) for k = -n .. n, computed on the lower half and mirrored so that the table is exactly
// antisymmetric and its ends are exactly -1 and 1: two faces that meet on an edge then compute the same vertices.
function tanTable(n: number, mid: boolean): Float64Array {
  const count = mid ? n : n + 1, t = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const k = mid ? 2 * i + 1 - n : 2 * i - n;
    if (k < 0) t[i] = Math.tan((Math.PI / 4) * (k / n));
  }
  for (let i = 0; i < count; i++) if ((mid ? 2 * i + 1 - n : 2 * i - n) > 0) t[i] = -t[mid ? n - 1 - i : n - i];
  if (!mid) { t[0] = -1; t[n] = 1; }
  return t;
}

const made = new Map<string, Grid>();
// A grid of fn cells along a face's side (even), on a planet of the radius given.
export function makeGrid(fn: number, radius = RADIUS_M): Grid {
  if (!Number.isInteger(fn) || fn < 2 || fn % 2) throw new Error(`makeGrid: ${fn} cells on a face's side, wanted an even count`);
  const key = `${fn}:${radius}`;
  let g = made.get(key);
  if (!g) {
    g = { fn, tiles: fn / TILE, radius, width: Math.PI / 2 / fn, node: tanTable(fn, false), mid: tanTable(fn, true) };
    made.set(key, g);
  }
  return g;
}
// Tier 0 is six faces of one tile; each tier below splits every tile into four.
export const tierGrid = (tier: number, radius = RADIUS_M) => makeGrid(TILE * 2 ** tier, radius);

export interface Planet { radius: number; area: number; circumference: number }
export const planet = (radius = RADIUS_M): Planet => ({ radius, area: 4 * Math.PI * radius * radius, circumference: 2 * Math.PI * radius });
// A cell's width along an axis at the face's centre (its widest), and the side of a square of the mean cell's area, in m.
export const cellWidthM = (g: Grid) => g.radius * g.width;
export const meanCellM = (g: Grid) => Math.sqrt(meanAreaM2(g));
export const meanAreaM2 = (g: Grid) => (4 * Math.PI * g.radius * g.radius) / (FACES * g.fn * g.fn);
// The diffusion number of a diffusivity d (m2 a second) over a step of dt seconds: d dt over the mean cell's area.
export const foOf = (g: Grid, d: number, dt: number) => (d * dt) / meanAreaM2(g);

// ---------- 2. geometry ----------
export type V3 = readonly [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3) => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => scale(a, 1 / norm(a));
// The angle between two unit vectors, stable for small angles.
const arc = (a: V3, b: V3) => 2 * Math.atan2(norm(sub(a, b)), norm(add(a, b)));

export const FRAMES: readonly { n: V3; ex: V3; ey: V3 }[] = [
  { n: [1, 0, 0], ex: [0, 1, 0], ey: [0, 0, 1] },
  { n: [0, 1, 0], ex: [-1, 0, 0], ey: [0, 0, 1] },
  { n: [-1, 0, 0], ex: [0, -1, 0], ey: [0, 0, 1] },
  { n: [0, -1, 0], ex: [1, 0, 0], ey: [0, 0, 1] },
  { n: [0, 0, 1], ex: [1, 0, 0], ey: [0, 1, 0] },
  { n: [0, 0, -1], ex: [1, 0, 0], ey: [0, -1, 0] },
];

// The unit vector of the point of face f at tangents (u, v) = (tan a, tan b).
export function pointOf(f: number, u: number, v: number): V3 {
  const { n, ex, ey } = FRAMES[f], r = Math.sqrt(1 + u * u + v * v);
  return [(n[0] + u * ex[0] + v * ey[0]) / r, (n[1] + u * ex[1] + v * ey[1]) / r, (n[2] + u * ex[2] + v * ey[2]) / r];
}
export const centre = (g: Grid, f: number, X: number, Y: number) => pointOf(f, g.mid[X], g.mid[Y]);
// The cell corner (i, j), i and j in [0, fn], of face f.
export const vertex = (g: Grid, f: number, i: number, j: number) => pointOf(f, g.node[i], g.node[j]);

export const latLon = (p: V3) => ({ lat: Math.atan2(p[2], Math.hypot(p[0], p[1])), lon: Math.atan2(p[1], p[0]) });
export const fromLatLon = (lat: number, lon: number): V3 => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

// The area of the face's part below tangents (u, v) from the centre, in steradians: atan(uv / sqrt(1 + u2 + v2)), odd in
// each. A cell's is the four corners' alternating sum (the area element is du dv / (1 + u2 + v2)^(3/2)).
const below = (u: number, v: number) => Math.atan2(u * v, Math.sqrt(1 + u * u + v * v));
// A cell's solid angle, steradians (multiply by radius squared for m2).
export function areaSr(g: Grid, X: number, Y: number): number {
  const u0 = g.node[X], u1 = g.node[X + 1], v0 = g.node[Y], v1 = g.node[Y + 1];
  return below(u1, v1) - below(u0, v1) - below(u1, v0) + below(u0, v0);
}

// East and north at a point (not a pole): the unit vectors toward increasing longitude and latitude.
export function eastNorth(p: V3): [V3, V3] {
  const h = Math.hypot(p[0], p[1]);
  return [[-p[1] / h, p[0] / h, 0], [(-p[2] * p[0]) / h, (-p[2] * p[1]) / h, h]];
}

// ---------- 3. neighbours ----------
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const side = (f: number, s: number): V3 => {
  const { ex, ey } = FRAMES[f];
  return s === 0 ? ex : s === 1 ? ey : s === 2 ? scale(ex, -1) : scale(ey, -1);
};
// For each face and side s (0 east, 1 north, 2 west, 3 south): the face across, which of its sides faces back, and whether
// the index along the edge runs the other way there. Found from the frames: the face across is the one whose outward axis
// is this side's direction, and the index along the edge (Y on an east or west side, X on a north or south one) runs the
// other way where the face across has its own along axis pointing against ours.
const along = (f: number, s: number) => (s & 1 ? FRAMES[f].ex : FRAMES[f].ey);
export const EDGES: readonly (readonly { face: number; side: number; flip: boolean }[])[] = FRAMES.map((F, f) =>
  [0, 1, 2, 3].map((s) => {
    const face = FRAMES.findIndex((G) => dot(G.n, side(f, s)) === 1);
    const back = [0, 1, 2, 3].find((t) => dot(side(face, t), F.n) === 1)!;
    return { face, side: back, flip: dot(along(f, s), along(face, back)) < 0 };
  }),
);

export interface Step { face: number; X: number; Y: number; back: number; turn: number }
// The cell next to (face, X, Y) in direction d. back is the direction from it to the first cell, in its own axes; turn is
// how many quarter turns (counterclockwise seen from outside) the axes of the first cell take to those of the second: a
// step d of the first, in the second's axes, is (d + turn) mod 4. Across an edge the along-edge index is kept or reversed
// (reversed when the edge's table says so) and the cell is the edge cell on its side.
export function step(g: Grid, face: number, X: number, Y: number, d: number): Step {
  const n = g.fn, x = X + DX[d], y = Y + DY[d];
  if (x >= 0 && x < n && y >= 0 && y < n) return { face, X: x, Y: y, back: (d + 2) & 3, turn: 0 };
  const e = EDGES[face][d], run = d & 1 ? X : Y, a = e.flip ? n - 1 - run : run;
  const [nx, ny] = e.side === 0 ? [n - 1, a] : e.side === 1 ? [a, n - 1] : e.side === 2 ? [0, a] : [a, 0];
  return { face: e.face, X: nx, Y: ny, back: e.side, turn: (e.side + 6 - d) & 3 };
}
export const cellId = (g: Grid, f: number, X: number, Y: number) => (f * g.fn + Y) * g.fn + X;

// The cell that stands in a tile's halo at face position (X, Y), one past the face's edge at most: the cell itself inside
// the face, the cell across the edge outside it, and null at a cube's corner (both past the edge), where no cell stands.
export function haloSource(g: Grid, f: number, X: number, Y: number): { face: number; X: number; Y: number; turn: number } | null {
  const n = g.fn, xo = X < 0 || X >= n, yo = Y < 0 || Y >= n;
  if (xo && yo) return null;
  if (!xo && !yo) return { face: f, X, Y, turn: 0 };
  return xo ? step(g, f, X < 0 ? 0 : n - 1, Y, X < 0 ? 2 : 0) : step(g, f, X, Y < 0 ? 0 : n - 1, Y < 0 ? 3 : 1);
}

// A tile slot is (face * T + ty) * T + tx; a cell's index in its tile's 256 by 256 table and in its padded tile.
export const slotOf = (g: Grid, f: number, X: number, Y: number) => (f * g.tiles + (Y >> 8)) * g.tiles + (X >> 8);
export const inTile = (X: number, Y: number) => (Y & 255) * TILE + (X & 255);
export const inPadded = (X: number, Y: number) => ((Y & 255) + 1) * PAD + (X & 255) + 1;
export const tileCount = (g: Grid) => FACES * g.tiles * g.tiles;

// ---------- 4. lookup ----------
export interface Place { face: number; X: number; Y: number; tx: number; ty: number; i: number; j: number; fx: number; fy: number }
// The cell holding a unit vector, with the fraction of the way across it in a and b (0 to 1; 1 only on a face's edge, where
// the lower face number takes the point).
export function locateVec(g: Grid, p: V3): Place {
  let face = 0, best = dot(p, FRAMES[0].n);
  for (let f = 1; f < FACES; f++) {
    const d = dot(p, FRAMES[f].n);
    if (d > best) { best = d; face = f; }
  }
  const { n, ex, ey } = FRAMES[face], w = dot(p, n);
  const sx = (Math.atan(dot(p, ex) / w) / (Math.PI / 2) + 0.5) * g.fn, sy = (Math.atan(dot(p, ey) / w) / (Math.PI / 2) + 0.5) * g.fn;
  const X = Math.min(g.fn - 1, Math.max(0, Math.floor(sx))), Y = Math.min(g.fn - 1, Math.max(0, Math.floor(sy)));
  return { face, X, Y, tx: X >> 8, ty: Y >> 8, i: X & 255, j: Y & 255, fx: sx - X, fy: sy - Y };
}
export const locate = (g: Grid, lat: number, lon: number) => locateVec(g, fromLatLon(lat, lon));
// The point at fractions (fx, fy) of the cell (face, X, Y); the centre at 0.5, 0.5.
export function pointAt(g: Grid, face: number, X: number, Y: number, fx = 0.5, fy = 0.5): V3 {
  const a = ((X + fx) / g.fn - 0.5) * (Math.PI / 2), b = ((Y + fy) / g.fn - 0.5) * (Math.PI / 2);
  return pointOf(face, Math.tan(a), Math.tan(b));
}

// ---------- 5. the link and gradient geometry, and the tables ----------
// The tangent vector at p that points to q with the length of the arc between them.
function logmap(p: V3, q: V3): V3 {
  const c = dot(p, q), w = sub(q, scale(p, c)), wn = norm(w);
  return wn === 0 ? [0, 0, 0] : scale(w, Math.atan2(wn, c) / wn);
}

export interface Link {
  kappa: number; // L / (|d| cos(a)): the two-point flux's coefficient
  cross: number; // (t . e) / cos(a): the coefficient of the edge's own derivative
}
// The link between cell (face, X, Y) and its neighbour in direction d, from the first cell's side. Let n be the unit normal
// of the shared edge toward the neighbour, t the unit vector between the two centres (both in the tangent plane at the
// edge's midpoint, the centres put there by the log map), a the angle between them, |d| the distance between the centres
// there, e the unit vector along the edge from its right end to its left end (seen from the first cell looking at the
// neighbour) and L the edge's length (an arc). The edge's normal derivative, written on t and e, is
//   n . grad q = (t . grad q - (t . e) e . grad q) / cos(a),
// so the flux through the edge, L n . grad q, is
//   kappa (q_j - q_i) - cross (q_left - q_right),   kappa = L / (|d| cos a),   cross = (t . e) / cos a,
// where q_left and q_right are the field at the edge's two ends, each the mean of the four cells that meet there (the
// diagonal cell at a cube's corner being the halo's mean of the other three, see wgsl/globe-grid.ts). On a grid whose lines
// meet at right angles, t . e = 0 and this is the two-point flux. The equiangular grid's lines meet at 60 to 90 degrees,
// and the two-point flux alone is not consistent there (it is wrong by about L / h at the cells beside a face's edge).
// Seen from the neighbour the same link has the same kappa and cross and the left and right ends swapped, so the flux
// it computes is exactly the opposite.
export function linkFloat(g: Grid, f: number, X: number, Y: number, d: number): Link {
  const nb = step(g, f, X, Y, d);
  // right end then left end, seen looking from the cell along d
  const [right, left] = d === 0 ? [vertex(g, f, X + 1, Y), vertex(g, f, X + 1, Y + 1)]
    : d === 1 ? [vertex(g, f, X + 1, Y + 1), vertex(g, f, X, Y + 1)]
    : d === 2 ? [vertex(g, f, X, Y + 1), vertex(g, f, X, Y)]
    : [vertex(g, f, X, Y), vertex(g, f, X + 1, Y)];
  const ci = centre(g, f, X, Y), cj = centre(g, nb.face, nb.X, nb.Y), m = unit(add(right, left)), L = arc(right, left);
  const delta = sub(logmap(m, cj), logmap(m, ci)), dl = norm(delta), t = scale(delta, 1 / dl);
  const chord = sub(left, right), e = unit(sub(chord, scale(m, dot(chord, m))));
  const nrm = cross(e, m); // e x m points to the left of e's direction seen from outside, which is toward the neighbour
  const cosA = dot(nrm, t);
  return { kappa: L / (dl * cosA), cross: dot(t, e) / cosA };
}

// The cells round vertex (vx, vy) of face f, in the order SW, SE, NW, NE (null where none stands: at a cube's corner the
// fourth), and the weights that give a linear function's value at the vertex from theirs: the weights nearest the plain mean
// (least sum of squares of the difference from a quarter) that sum to one and put the weighted centre of the cells on the
// vertex, with the cells' places taken in the tangent plane at the vertex by the log map. A plain mean is wrong by about a
// quarter of a cell along the edge at a vertex on a face's edge, where the lines of both faces lean the same way; this is
// exact for linear fields everywhere. At a cube's corner three cells give the weights outright (a third each).
export function vertexWeights(g: Grid, f: number, vx: number, vy: number) {
  const cells = [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]].map(([x, y]) => haloSource(g, f, x, y));
  const v = vertex(g, f, vx, vy), a: V3 = Math.abs(v[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0], e1 = unit(cross(v, a)), e2 = cross(v, e1);
  const have = cells.flatMap((c, i) => (c ? [i] : []));
  const pts = have.map((i) => { const t = logmap(v, centre(g, cells[i]!.face, cells[i]!.X, cells[i]!.Y)); return [dot(t, e1), dot(t, e2)]; });
  const A = [pts.map(() => 1), pts.map((p) => p[0]), pts.map((p) => p[1])];
  const solve3 = (M: number[][], b: number[]) => {
    const m = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r][c] / m[c][c]; for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j]; }
    }
    return m.map((r, i) => r[3] / r[i]);
  };
  let w: number[];
  if (have.length === 3) w = solve3(A, [1, 0, 0]);
  else {
    const gram = A.map((ri) => A.map((rj) => ri.reduce((s, x, k) => s + x * rj[k], 0))), lam = solve3(gram, [0, -A[1].reduce((s, x) => s + x / 4, 0), -A[2].reduce((s, x) => s + x / 4, 0)]);
    w = have.map((_, k) => 0.25 + lam[0] * A[0][k] + lam[1] * A[1][k] + lam[2] * A[2][k]);
  }
  const out = [0, 0, 0, 0];
  have.forEach((i, k) => { out[i] = w[k]; });
  return { cells, w: out };
}

// The eight neighbours of a cell in the order east, north, west, south, NE, NW, SW, SE, as offsets (dx, dy).
export const NEIGHBOURS8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const;

// The gradient's weights at a cell: sixteen numbers, the east component's weight of each of the eight neighbours then the
// north component's, such that (grad east, grad north) in the field's unit a cell's width is the sum of
// weight * (q_neighbour - q_cell). The weights are the first two rows of the least-squares fit of
//   q_neighbour - q_cell = g . d + (d^T H d) / 2    (g two unknowns, H three)
// to the neighbours, d being the neighbour's offset in the tangent plane at the cell by the log map, in cell widths. A
// quadratic fit is exact for any quadratic, so the gradient is second order everywhere, across a face's edge (where the
// grid's lines bend and the stencil is not symmetric) included. At a cube's corner no cell stands diagonal to the corner
// cell: its weight is zero and the fit has seven neighbours.
export function gradientWeights(g: Grid, f: number, X: number, Y: number): Float64Array {
  const ci = centre(g, f, X, Y), [e, nn] = eastNorth(ci), rows: number[][] = [], have: boolean[] = [];
  NEIGHBOURS8.forEach(([dx, dy]) => {
    const s = haloSource(g, f, X + dx, Y + dy);
    have.push(!!s);
    if (!s) return;
    const t = logmap(ci, centre(g, s.face, s.X, s.Y)), x = dot(t, e) / g.width, y = dot(t, nn) / g.width;
    rows.push([x, y, 0.5 * x * x, x * y, 0.5 * y * y]);
  });
  // normal equations B^T B (5 by 5), inverted by Gauss-Jordan
  const M = Array.from({ length: 5 }, (_, i) => Array.from({ length: 10 }, (_, j) => (j < 5 ? rows.reduce((s, r) => s + r[i] * r[j], 0) : j - 5 === i ? 1 : 0)));
  for (let c = 0; c < 5; c++) {
    let p = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 10; j++) M[c][j] /= d;
    for (let r = 0; r < 5; r++) if (r !== c) { const k = M[r][c]; for (let j = 0; j < 10; j++) M[r][j] -= k * M[c][j]; }
  }
  const w = new Float64Array(16);
  let used = 0;
  for (let d = 0; d < 8; d++) {
    if (!have[d]) continue;
    const r = rows[used++];
    for (let comp = 0; comp < 2; comp++) { let sum = 0; for (let j = 0; j < 5; j++) sum += M[comp][5 + j] * r[j]; w[comp * 8 + d] = sum; }
  }
  return w;
}

// round half away from zero
const roundAway = (x: number) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5));

export interface Tables {
  g: Grid;
  words: Int32Array; // TAB.COUNT fields of tileCount * 65536 words (see wgsl/globe-grid.ts)
  tw: number; // words in one field
  // Rounding margin, in units of the last place of each table's word: the least distance of any scaled value from a tie.
  margin: number;
  // Words whose margin is under a hundred times the double's own error at that word's size (a platform whose Math.atan or
  // Math.tan differs in the last places could round such a word the other way): the count, out of all rounded words.
  fragile: number;
  rounded: number;
  maxFo: number; // the largest diffusion number the two-point part is stable for in every cell
  maxArea: number; // the largest area weight (the flux step divides by it in 16-bit limbs, so it must stay under 2^16)
}

// Corner c of cell (f, X, Y) is the vertex between its neighbours in directions c and c + 1: NE, NW, SW, SE.
const CORNER = [[1, 1], [0, 1], [0, 0], [1, 0]] as const;
// The four cells' places round a corner, in the order the table keeps them: the cell, its neighbour in direction c, in
// direction c + 1, and the diagonal one (null at a cube's corner).
function round4(g: Grid, f: number, X: number, Y: number, c: number) {
  const n0 = step(g, f, X, Y, c), n1 = step(g, f, X, Y, (c + 1) & 3), dg = haloSource(g, f, X + NEIGHBOURS8[4 + c][0], Y + NEIGHBOURS8[4 + c][1]);
  return [{ face: f, X, Y }, n0, n1, dg];
}
// Fill the vertex weights of corner c of cell (f, X, Y) into the tables of all the cells round it, once, from the cell with
// the lowest id round the vertex: Q20 weights, rounded and then made to sum to exactly 2^20 by the weight of largest size.
function tabulateVertex(g: Grid, words: Int32Array, tw: number, f: number, X: number, Y: number, c: number) {
  const vx = X + CORNER[c][0], vy = Y + CORNER[c][1], { cells, w } = vertexWeights(g, f, vx, vy);
  const ids = cells.map((k) => (k ? cellId(g, k.face, k.X, k.Y) : Infinity));
  if (cellId(g, f, X, Y) !== Math.min(...ids)) return;
  const q = w.map((x) => roundAway(x * 2 ** SHIFT.vertex));
  let big = 0;
  for (let k = 1; k < 4; k++) if (Math.abs(q[k]) > Math.abs(q[big])) big = k;
  q[big] += 2 ** SHIFT.vertex - q.reduce((s, x) => s + x, 0);
  const weightOf = new Map(ids.map((id, k) => [id, q[k]] as const));
  const at = vertex(g, f, vx, vy);
  for (const k of cells) {
    if (!k) continue;
    // which corner of cell k is this vertex
    let ck = 0, best = Infinity;
    for (let c2 = 0; c2 < 4; c2++) {
      const p = vertex(g, k.face, k.X + CORNER[c2][0], k.Y + CORNER[c2][1]), d = Math.hypot(p[0] - at[0], p[1] - at[1], p[2] - at[2]);
      if (d < best) { best = d; ck = c2; }
    }
    const cell = slotOf(g, k.face, k.X, k.Y) * TILE_WORDS + inTile(k.X, k.Y);
    round4(g, k.face, k.X, k.Y, ck).forEach((m, slot) => {
      words[(TAB.V + 4 * ck + slot) * tw + cell] = m ? (weightOf.get(cellId(g, m.face, m.X, m.Y)) ?? 0) : 0;
    });
  }
}

// The tables of a whole tier: every cell's area weight, its four links' coefficients and its gradient's weights, rounded to
// integers. A link is computed once, from the side of the cell with the lower id, and the other cell takes the same
// numbers, so both cells of a link round the same way and the flux is exactly opposite.
export function buildTables(g: Grid): Tables {
  if (g.fn % TILE) throw new Error(`buildTables: ${g.fn} cells on a side is not a whole number of tiles`);
  const tw = tileCount(g) * TILE_WORDS, words = new Int32Array(TAB.COUNT * tw);
  const unitSr = (2 * Math.PI) / 3 / (g.fn * g.fn) / 2 ** SHIFT.area;
  let margin = 0.5, fragile = 0, rounded = 0, maxArea = 0;
  const put = (at: number, x: number, bits: number) => {
    const v = x * 2 ** bits, fr = v - Math.floor(v), m = Math.abs(fr - 0.5);
    if (m < margin) margin = m;
    if (m < 100 * Math.abs(v) * 2 ** -52) fragile++; // 100 units in the last place of a double at the word's size [design: the table's computation is a chain of some dozen operations]
    rounded++;
    words[at] = roundAway(v);
  };
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) {
        const at = slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y);
        put(TAB.A * tw + at, areaSr(g, X, Y) / unitSr, 0);
        maxArea = Math.max(maxArea, words[TAB.A * tw + at]);
        const w = gradientWeights(g, f, X, Y);
        for (let k = 0; k < 16; k++) put((TAB.W + k) * tw + at, w[k], SHIFT.weight);
        const id = cellId(g, f, X, Y);
        for (let c = 0; c < 4; c++) tabulateVertex(g, words, tw, f, X, Y, c);
        for (let d = 0; d < 4; d++) {
          const nb = step(g, f, X, Y, d);
          if (id > cellId(g, nb.face, nb.X, nb.Y)) continue;
          const l = linkFloat(g, f, X, Y, d), bt = slotOf(g, nb.face, nb.X, nb.Y) * TILE_WORDS + inTile(nb.X, nb.Y);
          // the kernel adds the cross term as c * (value at the left end less the right end's), so c is -cross
          put((TAB.K + d) * tw + at, l.kappa, SHIFT.kappa);
          put((TAB.C + d) * tw + at, -l.cross, SHIFT.cross);
          words[(TAB.K + nb.back) * tw + bt] = words[(TAB.K + d) * tw + at];
          words[(TAB.C + nb.back) * tw + bt] = words[(TAB.C + d) * tw + at];
        }
      }
  if (maxArea >= 65536) throw new Error("buildTables: an area weight reaches 2^16");
  let maxFo = Infinity;
  for (let c = 0; c < tw; c++) {
    let sum = 0;
    for (let d = 0; d < 4; d++) sum += words[(TAB.K + d) * tw + c];
    maxFo = Math.min(maxFo, (words[c] * 2 ** SHIFT.kappa) / (2 ** 16 * sum));
  }
  return { g, words, tw, margin, fragile, rounded, maxFo, maxArea };
}

// ---------- 6. fields, kernels and their twins ----------
export const fieldWords = (g: Grid) => tileCount(g) * PAD_WORDS;
// The range |q| stays under for the gradient and the flux to be exact in their 64-bit words [derived: the largest product, a
// Q24 coefficient under 2^25 times a difference under 2^21, then times a Q24 diffusion number under 2^22 after the first
// rounding, stays under 2^63].
export const MAX_Q = 2 ** 20;

// A field in the padded tile layout from a function of (face, X, Y), halo cells zero.
export function padded(g: Grid, f: (face: number, X: number, Y: number) => number): Int32Array {
  const out = new Int32Array(fieldWords(g));
  for (let face = 0; face < FACES; face++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) out[slotOf(g, face, X, Y) * PAD_WORDS + inPadded(X, Y)] = f(face, X, Y);
  return out;
}
// The cell's word in a padded field.
export const wordAt = (g: Grid, face: number, X: number, Y: number) => slotOf(g, face, X, Y) * PAD_WORDS + inPadded(X, Y);

const WGSL = globeWgsl(EDGES);

// Where a halo ring cell of tile slot s sits: its padded (x, y), in the kernel's order.
function ringCell(h: number): [number, number] {
  if (h < TILE) return [PAD - 1, h + 1];
  if (h < 2 * TILE) return [0, h - TILE + 1];
  if (h < 2 * TILE + PAD) return [h - 2 * TILE, PAD - 1];
  return [h - 2 * TILE - PAD, 0];
}
const turnCode = (v: number, turn: number) => (v < 0 || v > 3 ? v : (v + 4 - turn) & 3);
const turnPair = (u: number, v: number, turn: number): [number, number] => {
  const k = (4 - turn) & 3;
  return k === 0 ? [u, v] : k === 1 ? [-v, u] : k === 2 ? [-u, -v] : [v, -u];
};
const floorThird = (s: number) => Math.floor(s / 3);

// The halo exchange's twin: fills the ring of every tile of fields in `words` (nFields fields of fieldWords). Mode copy: the
// cell across; code: a direction code turned by the axes' rotation (4 at a cube's corner); pair: fields fa and fb as a
// vector along the face's own axes, turned the same way. At a cube's corner, where no cell stands diagonal to the corner
// cell, copy and pair take the (rounded down) mean of the three cells that meet at the vertex.
export function haloTwin(g: Grid, words: Int32Array, fa: number, mode: number = HALO.copy, fb = 0) {
  const fw = fieldWords(g), T = g.tiles, hi = g.fn - 1, clamp = (v: number) => Math.min(hi, Math.max(0, v));
  type At = { face: number; X: number; Y: number; turn: number };
  const read = (s: At, f: number) => words[f * fw + wordAt(g, s.face, s.X, s.Y)];
  const pair = (c: At) => turnPair(read(c, fa), read(c, fb), c.turn);
  for (let slot = 0; slot < tileCount(g); slot++) {
    const face = Math.floor(slot / (T * T)), ty = Math.floor((slot % (T * T)) / T), tx = slot % T;
    for (let h = 0; h < RING; h++) {
      const [pi, pj] = ringCell(h), gx = tx * TILE + pi - 1, gy = ty * TILE + pj - 1, at = slot * PAD_WORDS + pj * PAD + pi;
      const s = haloSource(g, face, gx, gy);
      // the corner's three cells: the corner cell itself and the two halo cells beside the missing one
      const corner = s ? [] : [{ face, X: clamp(gx), Y: clamp(gy), turn: 0 }, haloSource(g, face, gx, clamp(gy))!, haloSource(g, face, clamp(gx), gy)!];
      if (mode === HALO.pair) {
        const uv = s ? pair(s) : ([0, 1].map((k) => floorThird(corner.reduce((sum, c) => sum + pair(c)[k], 0))) as [number, number]);
        words[fa * fw + at] = uv[0]; words[fb * fw + at] = uv[1];
      } else if (mode === HALO.code) {
        words[fa * fw + at] = s ? turnCode(read(s, fa), s.turn) : 4;
      } else {
        words[fa * fw + at] = s ? read(s, fa) : floorThird(corner.reduce((sum, c) => sum + read(c, fa), 0));
      }
    }
  }
}

const OFF = [1, PAD, -1, -PAD, PAD + 1, PAD - 1, -PAD - 1, -PAD + 1];
// Round half away from zero of x / 2^n for a Number holding an integer under 2^52.
const shr = (x: number, n: number) => (x < 0 ? -Math.floor((-x + 2 ** (n - 1)) / 2 ** n) : Math.floor((x + 2 ** (n - 1)) / 2 ** n));
const shrBig = (x: bigint, n: bigint) => (x < 0n ? -((-x + (1n << (n - 1n))) >> n) : (x + (1n << (n - 1n))) >> n);

// The gradient kernel's twin: the gradient of field q at every interior cell into fields ge and gn (halo of q filled).
export function gradientTwin(tab: Tables, S: Int32Array, q: number, ge: number, gn: number) {
  const g = tab.g, fw = fieldWords(g), tw = tab.tw;
  for (let slot = 0; slot < tileCount(g); slot++)
    for (let c = 0; c < TILE_WORDS; c++) {
      const at = slot * PAD_WORDS + ((c >> 8) + 1) * PAD + (c & 255) + 1, q0 = S[q * fw + at], i = slot * TILE_WORDS + c;
      let e = 0, n = 0;
      for (let d = 0; d < 8; d++) {
        const dq = S[q * fw + at + OFF[d]] - q0;
        e += tab.words[(TAB.W + d) * tw + i] * dq;
        n += tab.words[(TAB.W + 8 + d) * tw + i] * dq;
      }
      S[ge * fw + at] = shr(e, SHIFT.weight - SHIFT.grad);
      S[gn * fw + at] = shr(n, SHIFT.weight - SHIFT.grad);
    }
}

// The flux kernel's twin: one diffusion step of the mass q * a + r from fields (qIn, rIn) to (qOut, rOut) (halo of qIn
// filled), the diffusion number as foQ = round(fo * 2^24).
export function fluxTwin(tab: Tables, S: Int32Array, foQ: number, qIn: number, rIn: number, qOut: number, rOut: number) {
  const g = tab.g, fw = fieldWords(g), tw = tab.tw, big = BigInt(foQ);
  for (let slot = 0; slot < tileCount(g); slot++)
    for (let c = 0; c < TILE_WORDS; c++) {
      const at = slot * PAD_WORDS + ((c >> 8) + 1) * PAD + (c & 255) + 1, i = slot * TILE_WORDS + c, q0 = S[qIn * fw + at], a = tab.words[i];
      // sum of weight * (q_k - q_i) over the four cells round corner k, Q20
      const corner = (k: number) => {
        let sum = 0;
        for (let m = 0; m < 4; m++) sum += tab.words[(TAB.V + 4 * k + m) * tw + i] * (S[qIn * fw + at + (m === 0 ? 0 : m === 1 ? OFF[k] : m === 2 ? OFF[(k + 1) & 3] : OFF[4 + k])] - q0);
        return sum;
      };
      let total = BigInt(S[rIn * fw + at]);
      for (let d = 0; d < 4; d++) {
        const ends = shr(corner(d) - corner((d + 3) & 3), SHIFT.vertex - SHIFT.ends);
        const s = tab.words[(TAB.K + d) * tw + i] * (S[qIn * fw + at + OFF[d]] - q0) + shr(tab.words[(TAB.C + d) * tw + i] * ends, SHIFT.ends);
        total += shrBig(BigInt(shr(s, SHIFT.kappa - 16)) * big, BigInt(SHIFT.fo + 1));
      }
      const t = Number(total);
      let qd = Math.floor(t / a), r = t - qd * a;
      if (r < 0) { qd--; r += a; } else if (r >= a) { qd++; r -= a; }
      S[qOut * fw + at] = q0 + qd; S[rOut * fw + at] = r;
    }
}

// The conserved total of a tracer: the sum over all cells of q * a + r.
export function totalMass(tab: Tables, S: Int32Array, q: number, r: number): bigint {
  const g = tab.g, fw = fieldWords(g);
  let sum = 0n;
  for (let slot = 0; slot < tileCount(g); slot++)
    for (let c = 0; c < TILE_WORDS; c++) {
      const at = slot * PAD_WORDS + ((c >> 8) + 1) * PAD + (c & 255) + 1;
      sum += BigInt(S[q * fw + at]) * BigInt(tab.words[slot * TILE_WORDS + c]) + BigInt(S[r * fw + at]);
    }
  return sum;
}

// The fields of a state buffer: q and r (a tracer), ge and gn (a gradient), then q and r again for a diffusion step's output.
export const STATE = { q: 0, r: 1, ge: 2, gn: 3, q2: 4, r2: 5, COUNT: 6 } as const;

// The kernels on a device for one tier's tiles. S holds fields in the padded layout (fieldWords words each); the tables
// are uploaded once. Parameter buffers are made once for each distinct set and freed by release().
export class GlobeGpu {
  readonly S: GPUBuffer;
  private readonly T: GPUBuffer;
  private readonly pars = new Map<string, GPUBuffer>();
  readonly g: Grid;
  // tab: the tier's tables, which gradient and flux read; a grid alone does the halo exchange only (the tables of a deep tier
  // are large).
  constructor(readonly gpu: Gpu, readonly tab: Tables | Grid, readonly fields: number = STATE.COUNT) {
    this.g = "words" in tab ? tab.g : tab;
    this.S = storage(gpu, fieldWords(this.g) * fields * 4);
    this.T = storage(gpu, "words" in tab ? tab.words : 4);
  }
  private tables(): Tables {
    if (!("words" in this.tab)) throw new Error("GlobeGpu: this kernel needs the tier's tables");
    return this.tab;
  }
  write(field: number, words: Int32Array) { this.gpu.device.queue.writeBuffer(this.S, field * fieldWords(this.g) * 4, words.buffer, words.byteOffset, words.byteLength); }
  async read(field: number): Promise<Int32Array> {
    const bytes = fieldWords(this.g) * 4;
    return new Int32Array(await readback(this.gpu, this.S, bytes, field * bytes));
  }
  // Put a tracer in the state: q, each |q| under 2^20 (the range the gradient and the flux are exact in), and its remainders r,
  // each in [0, the cell's area weight) (none given: zero).
  writeTracer(q: Int32Array, r?: Int32Array) {
    const tab = this.tables(), g = tab.g;
    for (let f = 0; f < FACES; f++)
      for (let Y = 0; Y < g.fn; Y++)
        for (let X = 0; X < g.fn; X++) {
          const at = wordAt(g, f, X, Y), a = tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
          if (Math.abs(q[at]) >= MAX_Q) throw new Error(`writeTracer: |q| reaches 2^20 at face ${f} cell ${X},${Y}`);
          if (r && (r[at] < 0 || r[at] >= a)) throw new Error(`writeTracer: remainder ${r[at]} outside [0, ${a}) at face ${f} cell ${X},${Y}`);
        }
    this.write(STATE.q, q);
    this.write(STATE.r, r ?? new Int32Array(q.length));
  }
  private run(entry: string, par: Record<string, number>, threads: number) {
    const g = this.g, key = entry + JSON.stringify(par);
    let P = this.pars.get(key);
    if (!P) {
      const w = new Uint32Array(PARAM.WORDS);
      w[PARAM.tiles] = g.tiles; w[PARAM.face] = g.fn; w[PARAM.count] = tileCount(g);
      for (const [k, v] of Object.entries(par)) w[PARAM[k as keyof typeof PARAM]] = v;
      P = storage(this.gpu, w);
      this.pars.set(key, P);
    }
    dispatch(this.gpu, pipeline(this.gpu, WGSL, entry), [this.S, this.T, P], cover(this.gpu, threads));
  }
  // Fill every tile's halo of field fa (and fb in pair mode) from the tiles and faces around it.
  halo(fa: number, mode: number = HALO.copy, fb = 0) { this.run("halo", { mode, fa, fb }, tileCount(this.g) * RING); }
  // The gradient of field q into ge and gn.
  gradient(q: number, ge: number, gn: number) {
    this.tables();
    this.run("grad", { qIn: q, ge, gn }, tileCount(this.g) * TILE_WORDS);
  }
  // One diffusion step, from (qIn, rIn) to (qOut, rOut), the halo of qIn filled.
  flux(fo: number, qIn: number, rIn: number, qOut: number, rOut: number) {
    const foQ = Math.round(fo * 2 ** SHIFT.fo);
    // 0.25 [derived]: the two-point flux is stable to fo <= a / (2^16 sum kappa), about 0.098 here, and the largest word the 64-bit products hold is foQ 2^22
    if (!(fo > 0) || foQ > 2 ** 22) throw new Error(`flux: diffusion number ${fo}, wanted over 0 and at most 0.25`);
    const tab = this.tables();
    if (fo > tab.maxFo) throw new Error(`flux: diffusion number ${fo} passes the stable ${tab.maxFo}`);
    this.run("flux", { qIn, rIn, qOut, rOut, fo: foQ }, tileCount(this.g) * TILE_WORDS);
  }
  // `steps` diffusion steps of the tracer in STATE.q and STATE.r (halo of q filled or not, it is filled here): returns the
  // pair of fields that holds the result.
  diffuse(fo: number, steps: number): { q: number; r: number } {
    let q: number = STATE.q, r: number = STATE.r, q2: number = STATE.q2, r2: number = STATE.r2;
    this.halo(q);
    for (let s = 0; s < steps; s++) {
      this.flux(fo, q, r, q2, r2);
      this.halo(q2);
      [q, q2] = [q2, q]; [r, r2] = [r2, r];
    }
    return { q, r };
  }
  release() {
    this.S.destroy(); this.T.destroy();
    for (const p of this.pars.values()) p.destroy();
    this.pars.clear();
  }
}

// ---------- measures ----------
export interface AreaStats { sum: number; relError: number; min: number; max: number; ratio: number; weightRelError: number }
// Every cell's solid angle summed against 4 pi, the smallest and largest, and the integer weights' sum against 4 pi.
export function areaStats(g: Grid): AreaStats {
  let sum = 0, min = Infinity, max = 0, weights = 0;
  const unitSr = (2 * Math.PI) / 3 / (g.fn * g.fn) / 2 ** SHIFT.area;
  for (let Y = 0; Y < g.fn; Y++)
    for (let X = 0; X < g.fn; X++) {
      const a = areaSr(g, X, Y);
      sum += a; min = Math.min(min, a); max = Math.max(max, a);
      weights += roundAway(a / unitSr);
    }
  // all six faces are the same up to the symmetry of the cube, so one face's sum times six is the sphere's
  return { sum: sum * FACES, relError: Math.abs(sum * FACES - 4 * Math.PI) / (4 * Math.PI), min, max, ratio: max / min, weightRelError: Math.abs(weights * FACES * unitSr - 4 * Math.PI) / (4 * Math.PI) };
}
