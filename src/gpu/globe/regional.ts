// A finer tier of the cube-sphere over the whole planet, solved globally: a quadtree tier (2^tier children to a side of each tier-0 cell) made from tier 0 by a
// remap that depends only on the ground point, then eroded with the flood and the receivers routed across tile and face edges, the stream power law and the
// threshold hillslopes, under the planet's rain and rock, the total height of every tier-0 cell held. It is the coarse-to-fine global solve the 75 m tier needs
// (tier 4 on the small planet): the per-tile kernels of grid.ts and erosion.ts cannot hold a tier of 25 to 100 million cells (their tables alone are 41 words a
// cell), so these kernels find a cell's eight neighbours from its place and read what varies slowly from a table of the tier-0 cell it lies in.
// What was built and measured: docs/research/globe/2026-10-20-small-planet-impl.md (R1760 and up).
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { CNT, FLAG, FLOW_NEIGHBOURS, HIST, RF, SOLVE_SWEEPS, SPLIT, XSTRIDE, regionalWgsl } from "../wgsl/globe-regional";
import { BAND_CNT, BAND_FLAG_CARRY, BAND_PARENT_WORDS } from "../wgsl/globe-band-hold";
import { EDGES, FACES, areaSr, haloSource, tierGrid, type Grid } from "./grid";
import { SKIN_M, defaultParams, kWord, neighbourTables, rainWord, REF_RAIN_MMYR, type ErosionParams } from "./erosion";
import { THRESHOLD_DEG } from "../../terrain/geology";
import { packRecord, unpackRecord, ROCK_OF, type Planet, type PlanetStore } from "./window";

// ---------- 1. the settings ----------
// The default tier is 3 (the stage runner takes any): 2,048 cells a face side, 25,165,824 cells in all, which the 4 GB buffer holds; tier 4 (100 million cells,
// 5.6 GB of fields in two buffers) is what the 75 m planet needs and fits in two [design, R1760: the cost table of the small planet's note].
export const REGIONAL = {
  tier: 3,
  dtYr: 1e6, // a step: the stream power step is implicit, so the step sets only how far the flow pattern may change inside one [design, as the erosion unit's SUBSTEP_YR]
  steps: 40, // the number of steps a tier is eroded for [design, R1763: the receivers' change between steps is measured in the note]
};
const CELLS0 = FACES * 256 * 256;
// The parent of a tier cell in tier 0: the cell id there.
export const parentOf = (tier: number, id: number): number => {
  const fn = 256 << tier, cells = fn * fn, f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / fn), X = r - Y * fn;
  return (f * 256 + (Y >> tier)) * 256 + (X >> tier);
};

// ---------- 2. the remap: tier 0 to the tier, a function of the ground point only ----------
// Each child's value is the bilinear interpolation, in the face's index space, of the four tier-0 cell centres round the child's centre
// (the neighbours across a face's edge as grid.ts haloSource gives them; at a cube's corner, where one is missing, the mean of the two
// beside it) [design, R1761]. The children of a tier-0 cell are then moved by one constant so that their total is the parent's exactly:
// by whole units of 1/256 m for a height (the sum of the 4^tier children is the parent's 4^tier times 256 rounded, to the unit) and in
// proportion for a quantity that cannot fall under zero. A child's value depends on its parent and the parents' round it, never on a window.
type Field = ArrayLike<number>;
// The 3 by 3 tier-0 cells round (f, X, Y) as ids: row dy = -1, 0, 1 (south to north), column dx = -1, 0, 1 (west to east); the corner's missing one is -1.
export function around3(g0: Grid, f: number, X: number, Y: number, out: Int32Array) {
  const n = g0.fn;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = X + dx, y = Y + dy;
      if (x >= 0 && x < n && y >= 0 && y < n) { out[(dy + 1) * 3 + dx + 1] = (f * n + y) * n + x; continue; }
      const s = haloSource(g0, f, x, y);
      out[(dy + 1) * 3 + dx + 1] = s ? (s.face * n + s.Y) * n + s.X : -1;
    }
}
export const CORNER_BESIDE = [[0, 1, 3], [2, 1, 5], [6, 3, 7], [8, 5, 7]] as const;
// The four children of a cell, by place (SW, SE, NW, NE) in `q`, from its centre value and its eight neighbours': a child lies at 1/4 or 3/4 of the way between the parent's centre and
// the neighbour's on each axis, so 3/4 on the parent's side (the one stencil of the in-memory and the streamed carry to the next tier).
export const child4 = (ce: number, w: number, e: number, s: number, n: number, sw: number, se: number, nw: number, ne: number, q: Float64Array) => {
  q[0] = (9 * ce + 3 * w + 3 * s + sw) / 16; q[1] = (9 * ce + 3 * e + 3 * s + se) / 16; q[2] = (9 * ce + 3 * w + 3 * n + nw) / 16; q[3] = (9 * ce + 3 * e + 3 * n + ne) / 16;
};
const quad = new Float64Array(4);
// Calls emit(parent, children) with the 4^(tier - from) interpolated values of each cell of tier `from` (tier 0 unless given), child (i, j) at index j * B + i (i east, j north).
function eachParent(field: Field, tier: number, emit: (parent: number, v: Float64Array) => void, from = 0) {
  const gp = tierGrid(from), fnp = gp.fn, up = tier - from, B = 1 << up, ids = new Int32Array(9), val = new Float64Array(9), out = new Float64Array(B * B);
  const wlo = new Float64Array(B), whi = new Float64Array(B), ilo = new Int32Array(B);
  for (let i = 0; i < B; i++) { const u = (i + 0.5) / B, lo = u < 0.5; ilo[i] = lo ? 0 : 1; whi[i] = lo ? u + 0.5 : u - 0.5; wlo[i] = 1 - whi[i]; }
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < fnp; Y++)
      for (let X = 0; X < fnp; X++) {
        around3(gp, f, X, Y, ids);
        for (let c = 0; c < 9; c++) if (ids[c] >= 0) val[c] = field[ids[c]];
        // a cube corner's missing cell: the mean of the two beside it
        for (const [c, a, b] of CORNER_BESIDE) if (ids[c] < 0) val[c] = (val[a] + val[b]) / 2;
        for (let j = 0; j < B; j++) {
          const r0 = ilo[j] * 3, wj0 = wlo[j], wj1 = whi[j];
          for (let i = 0; i < B; i++) {
            const c0 = r0 + ilo[i];
            out[j * B + i] = wj0 * (wlo[i] * val[c0] + whi[i] * val[c0 + 1]) + wj1 * (wlo[i] * val[c0 + 3] + whi[i] * val[c0 + 4]);
          }
        }
        emit((f * fnp + Y) * fnp + X, out);
      }
}
const cellIndex = (tier: number, parent: number, c: number, from = 0) => {
  const up = tier - from, B = 1 << up, fn = 256 << tier, fnp = 256 << from, f = Math.floor(parent / (fnp * fnp)), r = parent - f * fnp * fnp, Y0 = Math.floor(r / fnp), X0 = r - Y0 * fnp, j = Math.floor(c / B), i = c - j * B;
  return (f * fn + Y0 * B + j) * fn + X0 * B + i;
};
// A height in 1/256 m above the sea for every cell of the tier, the children of each tier-0 cell summing to 256 times its height times 4^tier to the unit.
export function remapHeights(tier: number, height: Field): Int32Array {
  const n = 1 << (2 * tier), out = new Int32Array(CELLS0 * n);
  eachParent(height, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.round(v[c] * 256); sum += v[c]; }
    const d = Math.round(height[p] * 256 * n) - sum, base = Math.floor(d / n), rem = d - base * n;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c)] = v[c] + base + (c < rem ? 1 : 0);
  });
  return out;
}
// The heights of tier `from` (1/256 m) carried to a finer tier: each child the bilinear value between the parent's and its neighbours' centres, moved by one
// whole-unit constant so that the children of a cell sum to 4^(tier - from) times its height exactly (the tier above's totals are kept) [design, R1761].
export function remapInts(from: number, tier: number, height: Int32Array): Int32Array {
  const n = 1 << (2 * (tier - from)), cells = CELLS0 << (2 * from), out = new Int32Array(cells * n);
  if (height.length !== cells) throw new Error(`remapInts: tier ${from} holds ${cells} cells, got ${height.length}`);
  eachParent(height, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.round(v[c]); sum += v[c]; }
    const d = height[p] * n - sum, base = Math.floor(d / n), rem = d - base * n;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c, from)] = v[c] + base + (c < rem ? 1 : 0);
  }, from);
  return out;
}
// The children, 2 by 2 to a parent, of a field at tier `from` (weights 3/4 and 1/4 of the two nearest centres on each axis, so a child is (9a + 3b + 3c + d) / 16), the cells round a
// face's edge or corner taken from eachParent's own path, written into `out` at the children's cell numbers. `add` adds to what `out` holds.
function children2(parent: ArrayLike<number>, from: number, out: Float64Array, add: boolean) {
  const fnp = 256 << from, fn = fnp * 2, cells = fnp * fnp, gp = tierGrid(from), ids = new Int32Array(9), val = new Float64Array(9);
  for (let f = 0; f < FACES; f++) {
    const base = f * cells;
    for (let Y = 0; Y < fnp; Y++) {
      for (let X = 0; X < fnp; X++) {
        const p = base + Y * fnp + X;
        let sw: number, se: number, nw: number, ne: number, w: number, e: number, s: number, n: number, ce = parent[p];
        if (X > 0 && X < fnp - 1 && Y > 0 && Y < fnp - 1) {
          w = parent[p - 1]; e = parent[p + 1]; s = parent[p - fnp]; n = parent[p + fnp];
          sw = parent[p - fnp - 1]; se = parent[p - fnp + 1]; nw = parent[p + fnp - 1]; ne = parent[p + fnp + 1];
        } else {
          around3(gp, f, X, Y, ids);
          for (let c = 0; c < 9; c++) if (ids[c] >= 0) val[c] = parent[ids[c]];
          for (const [c, a, b] of CORNER_BESIDE) if (ids[c] < 0) val[c] = (val[a] + val[b]) / 2;
          sw = val[0]; s = val[1]; se = val[2]; w = val[3]; ce = val[4]; e = val[5]; nw = val[6]; n = val[7]; ne = val[8];
        }
        // child (i, j) lies at 1/4 or 3/4 of the way between the parent's centre and the neighbour's on each axis: weights 3/4 on the parent's side
        const o = (f * fn + 2 * Y) * fn + 2 * X;
        child4(ce, w, e, s, n, sw, se, nw, ne, quad);
        const v00 = quad[0], v10 = quad[1], v01 = quad[2], v11 = quad[3];
        if (add) { out[o] += v00; out[o + 1] += v10; out[o + fn] += v01; out[o + fn + 1] += v11; } else { out[o] = v00; out[o + 1] = v10; out[o + fn] = v01; out[o + fn + 1] = v11; }
      }
    }
  }
}
// The carry's one limiter: the four children `w` (order SW, SE, NW, NE; whole 1/256 m units, the bilinear children carried and rounded) of a cell of height `own` with the parent's total `sum4` (4 times the
// parent), and the parents `west`, `east`, `south`, `north` that share an edge with it. A mean-preserving carry of a step rings (a trench of sea under land parents beside a cliff: the sea strips and ponds
// of the tier-3 pictures; beside a lone 14 m column on a 1 m plain it digs 2.5 m below the sea on both sides, a sea pit of 700 tier-5 cells inside the land), and nothing but the sea level says such a child is
// wrong. So a child of a land parent whose two edge-sharing parents (the one on its x side and the one on its y side) are land too is held one unit above the sea, and a child of a sea parent whose two are sea
// one unit below it: the children are scaled toward their mean, w' = mean + theta (w - mean), by the largest theta that keeps those children on their parents' side (Zhang and Shu 2010, J. Comput. Phys.
// 229: 3091, the scaling of a reconstruction toward the cell mean to keep it inside a bound; Zhang and Shu 2011, Proc. R. Soc. A 467: 2752, the same for positivity), and the mean is restored among the
// children that can still move. A parent that only touches the sea across a corner lets none of its children go to the sea: the sea of the next tier keeps the edge adjacency of the tier above (with all
// nine parents as the stencil, as first built, a sea parent at a corner of the 3 x 3 freed every child of the cell, and 9 to 15 sea pits of about 700 cells stood in each 640 by 640 window of the
// river, shelf and K3 places [measured, scratch pits5.ts]; with the edge stencil 0 to 1 of 2 to 8 cells). A coast still moves inside the cells that share an edge with the sea, a strict peak keeps a
// sub-cell crest. A box on the parents' range (Barth and Jespersen 1989) was tried first: at a strict extremum of the 3 x 3 the box is the parent's own value, so all four children are equal, and a
// constant block carried down is a constant 4 x 4, 8 x 8 (a flat square of the tier-0 cell's footprint at every peak and pit). Integers in, integers out.
const LIM_LO = new Float64Array(4), LIM_HI = new Float64Array(4);
export function limitSea(w: number[], sum4: number, own: number, west: number, east: number, south: number, north: number) {
  const land = own > 0 && sum4 >= 4, sea = !land && own <= 0 && sum4 <= -4, mean = sum4 / 4;
  let theta = 1;
  for (let k = 0; k < 4; k++) {
    const sx = k & 1 ? east : west, sy = k & 2 ? north : south;
    LIM_LO[k] = -Infinity; LIM_HI[k] = Infinity;
    if (land && sx > 0 && sy > 0) { LIM_LO[k] = 1; if (w[k] < 1) theta = Math.min(theta, (mean - 1) / (mean - w[k])); }
    else if (sea && sx <= 0 && sy <= 0) { LIM_HI[k] = -1; if (w[k] > -1) theta = Math.min(theta, (-1 - mean) / (w[k] - mean)); }
  }
  if (theta < 1) for (let k = 0; k < 4; k++) w[k] = Math.round(mean + theta * (w[k] - mean));
  let sum = 0;
  for (let k = 0; k < 4; k++) { w[k] = Math.min(LIM_HI[k], Math.max(LIM_LO[k], w[k])); sum += w[k]; }
  for (let d = sum4 - sum; d !== 0; ) {
    let nf = 0;
    for (let k = 0; k < 4; k++) if (d > 0 ? w[k] < LIM_HI[k] : w[k] > LIM_LO[k]) nf++;
    if (nf === 0) break;
    const q = Math.floor(d / nf), rem = d - q * nf;
    let at = 0, moved = 0;
    for (let k = 0; k < 4; k++) if (d > 0 ? w[k] < LIM_HI[k] : w[k] > LIM_LO[k]) { const nw = Math.min(LIM_HI[k], Math.max(LIM_LO[k], w[k] + q + (at++ < rem ? 1 : 0))); moved += nw - w[k]; w[k] = nw; }
    d -= moved;
  }
}
// A field at tier `from` (1/256 m) carried to the next tier: the bilinear children, then what is left of each parent's height (its height less the children's mean) is carried
// down the same way, `passes` times, so that the children's means come to the parents' without a constant to a block (a constant is a step of up to 100 m at the block's
// edge on a range: measured); the last whole-unit constant, which is then under a unit, makes the children of every cell sum to 4 times its height exactly [design, R1761]. With
// passes the children are limited (limitSea: where all nine parents of the 3 x 3 are land or all sea, the children stay on that side of the sea level, the mean kept); `passes` = 0 is the plain remap.
export function refineSmooth(parent: ArrayLike<number>, from: number, passes = 4): Int32Array {
  const n = CELLS0 << (2 * from), c = new Float64Array(4 * n), out = new Int32Array(4 * n), fnp = 256 << from, fn = fnp * 2, cells = fnp * fnp;
  if (parent.length !== n) throw new Error(`refineSmooth: tier ${from} holds ${n} cells, got ${parent.length}`);
  children2(parent, from, c, false);
  if (passes > 0) {
    const r = new Float64Array(n), corr = new Float64Array(4 * n);
    for (let pass = 0; pass < passes; pass++) {
      for (let f = 0; f < FACES; f++)
        for (let Y = 0; Y < fnp; Y++)
          for (let X = 0; X < fnp; X++) { const p = f * cells + Y * fnp + X, o = (f * fn + 2 * Y) * fn + 2 * X; r[p] = parent[p] - (c[o] + c[o + 1] + c[o + fn] + c[o + fn + 1]) / 4; }
      children2(r, from, corr, false);
      for (let i = 0; i < c.length; i++) c[i] += corr[i];
    }
  }
  const gp = tierGrid(from), ids = new Int32Array(9);
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < fnp; Y++)
      for (let X = 0; X < fnp; X++) {
        const p = f * cells + Y * fnp + X, o = (f * fn + 2 * Y) * fn + 2 * X, v = [Math.round(c[o]), Math.round(c[o + 1]), Math.round(c[o + fn]), Math.round(c[o + fn + 1])];
        if (passes > 0) {
          let west: number, east: number, south: number, north: number;
          if (X > 0 && X < fnp - 1 && Y > 0 && Y < fnp - 1) { west = parent[p - 1]; east = parent[p + 1]; south = parent[p - fnp]; north = parent[p + fnp]; }
          else { around3(gp, f, X, Y, ids); south = parent[ids[1]]; west = parent[ids[3]]; east = parent[ids[5]]; north = parent[ids[7]]; }
          limitSea(v, Math.round(parent[p] * 4), parent[p], west, east, south, north);
          out[o] = v[0]; out[o + 1] = v[1]; out[o + fn] = v[2]; out[o + fn + 1] = v[3];
          continue;
        }
        const d = Math.round(parent[p] * 4) - (v[0] + v[1] + v[2] + v[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
        out[o] = v[0] + base4 + (0 < rem ? 1 : 0); out[o + 1] = v[1] + base4 + (1 < rem ? 1 : 0); out[o + fn] = v[2] + base4 + (2 < rem ? 1 : 0); out[o + fn + 1] = v[3] + base4 + (3 < rem ? 1 : 0);
      }
  return out;
}
// remapInts for one tier up with no smoothing of the constants: the bilinear children and one constant to a block.
export const refineInts = (from: number, height: Int32Array): Int32Array => refineSmooth(height, from, 0);
// A quantity that is never negative (rain, runoff) on every cell of the tier, the children's mean the parent's value (to float32).
export function remapAmounts(tier: number, field: Field, scale = 1): Float32Array {
  const n = 1 << (2 * tier), out = new Float32Array(CELLS0 * n);
  eachParent(field, tier, (p, v) => {
    let sum = 0;
    for (let c = 0; c < n; c++) { v[c] = Math.max(0, v[c]); sum += v[c]; }
    const want = field[p] * n, k = sum > 0 ? want / sum : 0;
    for (let c = 0; c < n; c++) out[cellIndex(tier, p, c)] = (sum > 0 ? v[c] * k : field[p]) * scale;
  });
  return out;
}
// The year's rain of every cell of the tier, mm, from the planet's four seasons: the seasons' total remapped.
export const annualRain = (planet: Planet): Float32Array => {
  const total = new Float32Array(planet.n);
  for (const s of planet.seasons) for (let i = 0; i < planet.n; i++) total[i] += s.rain[i];
  return total;
};

// ---------- 3. the tier-0 table the kernels read ----------
// For every tier-0 cell: the erodibility of its rock (the thickness-weighted mean over the top SKIN_M of the column, stack order as the erosion
// unit removes it: sediment, volcanic, metasediment, granitoid, basalt; K a pool as erosion.ts defaultParams holds it, per step as kWord), the
// cell's area weight (Q15 of the mean cell) and the inverse of its centre's distance to each of the eight neighbours at the tier's spacing
// (tier 0's over 2^tier: the metric's change over one tier-0 cell is under 0.2% [derived: the cells' sides change by 41% over 128 cells]).
const STACK = [1, 4, 2, 3, 0];
// The threshold slope of each pool as the window's landslides take it (geology.ts THRESHOLD_DEG of the island's rock the pool stands for, window.ts ROCK_OF) [R1714].
const tanOfPools = () => ROCK_OF.map((r) => Math.tan((THRESHOLD_DEG[r] * Math.PI) / 180));
// One rain over every land cell: a quarter of the reference rain at four times K, so that K sqrt(A) is the reference's and a cell weighs 128 (not 512), which keeps the discharge area of a basin
// of 33 million cells under the 32 bits it is summed in (the planet's largest basin at 75 m is over 14 million: at the reference rain it overflowed, measured at tier 5) [derived].
export const UNIFORM_RAIN = { word: 64, kScale: 2 };
// the knight moves in the kernels' order (wgsl/globe-regional.ts KNIGHT)
const KNIGHT = [[2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2], [2, -1]] as const;
export function tierTable(planet: Planet, tier: number, p: ErosionParams, uniformRain = false): Uint32Array {
  const g0 = tierGrid(0, planet.radius), gt = tierGrid(tier, planet.radius), X = new Uint32Array(CELLS0 * XSTRIDE), kw = p.K.map((k) => Math.min(0xffffffff, kWord(gt, p, k) * (uniformRain ? UNIFORM_RAIN.kScale : 1))), tanOf = tanOfPools();
  // a planet with no climate (a staged one) rains the reference rain everywhere
  const { invd } = neighbourTables(g0), meanSr = (4 * Math.PI) / CELLS0, rain = planet.seasons && !uniformRain ? annualRain(planet) : new Float32Array(CELLS0).fill(REF_RAIN_MMYR);
  for (let c = 0; c < CELLS0; c++) {
    let rem = SKIN_M, wsum = 0, acc = 0, tanSum = 0;
    for (const pl of STACK) { const w = Math.min(Math.max(0, planet.pools[pl][c]), rem); rem -= w; wsum += w; acc += w * kw[pl]; tanSum += w * tanOf[pl]; }
    const tan = wsum > 0 ? tanSum / wsum : tanOf[3];
    const f = Math.floor(c / 65536), r = c - f * 65536, Y = Math.floor(r / 256), x = r - Y * 256;
    X[c * XSTRIDE] = wsum > 0 ? Math.floor(acc / wsum) : 0;
    X[c * XSTRIDE + 1] = Math.round((2 ** 15 * areaSr(g0, x, Y)) / meanSr);
    X[c * XSTRIDE + 18] = Math.round(tan * 2 ** 20);
    X[c * XSTRIDE + 19] = uniformRain ? UNIFORM_RAIN.word : rainWord(rain[c], REF_RAIN_MMYR);
    for (let d = 0; d < 8; d++) {
      // a tier-0 corner cell has no diagonal neighbour toward the cube's corner, but its children do: the distance there is the diagonal of the two edges beside it [derived]
      const iv = invd[c * 8 + d] > 0 || d < 4 ? invd[c * 8 + d] : Math.round((invd[c * 8 + d - 4] + invd[c * 8 + ((d - 3) & 3)]) / 2 / Math.SQRT2);
      X[c * XSTRIDE + 2 + d] = iv * 2 ** tier;
      X[c * XSTRIDE + 10 + d] = iv > 0 ? Math.round(2 ** 44 / (iv * 2 ** tier)) : 0;
      // creep: the isotropic 9-point Laplacian's weights, 2/3 along an edge and 1/3 across a corner (over the distance squared), times D dt [derived: Patra and Karttunen's stencil]
      const inv = (iv * 2 ** tier) / 2 ** 28;
      X[c * XSTRIDE + 20 + d] = Math.round(2 ** 24 * p.creepLand * p.dtYr * (d < 4 ? 2 / 3 : 1 / 3) * inv * inv);
    }
    // the eight knight moves' distances (Q16 m): two steps along one axis and one along the other, each at the table's distance on its side, taken as orthogonal
    for (let q = 0; q < 8; q++) {
      const [dx, dy] = KNIGHT[q], dE = X[c * XSTRIDE + 10 + (dx > 0 ? 0 : 2)], dN = X[c * XSTRIDE + 10 + (dy > 0 ? 1 : 3)];
      X[c * XSTRIDE + 28 + q] = Math.round(Math.hypot(Math.abs(dx) * dE, Math.abs(dy) * dN));
    }
  }
  return X;
}
// The creep's substeps: the fewest that keep the 9-point stencil's coefficients under one half in sum [derived: an explicit step with every weight positive is stable to one].
export function creepSubsOf(table: Uint32Array): number {
  let most = 0;
  for (let c = 0; c < table.length / XSTRIDE; c++) { let s = 0; for (let d = 0; d < 8; d++) s += table[c * XSTRIDE + 20 + d]; most = Math.max(most, s); }
  return Math.max(1, Math.ceil(most / 2 ** 24 / 0.5));
}

// ---------- 4. the kernels on a device ----------
// The routing of a tier's flow: the neighbours the flood and the receivers read, and whether a receiver is drawn among the lower ones (wgsl/globe-regional.ts recv) or is the steepest.
// `band` (1 or 2): the uplift is the band-limited hold on the tier-0 lattice (span 1) or every second tier-0 cell (span 2) in place of the box mean (wgsl/globe-band-hold.ts).
export interface RouteLaw { nflow: 4 | 8; stochastic: boolean; slide?: 8 | 16; band?: 1 | 2 }
export interface TierState { height: Int32Array; carry: Int32Array; steps: number }
export interface TierFlow { to: Uint32Array; acc: Uint32Array; rounds: number }
const readU32 = async (gpu: Gpu, b: GPUBuffer, words: number, at: number) => new Uint32Array(await readback(gpu, b, words * 4, at * 4));

export class Regional {
  readonly fn: number;
  readonly N: number;
  readonly g: Grid;
  readonly E: GPUBuffer;
  readonly E2: GPUBuffer;
  readonly AT: GPUBuffer;
  private readonly P: GPUBuffer;
  private X: GPUBuffer;
  private readonly wgsl: string;
  private readonly binds = new Map<string, GPUBindGroup>();
  private readonly atCnt: number;
  private readonly atCarry: number;
  lastRounds = 256;
  lastSlide = 32;
  // with `profile` set each phase is waited for and its seconds added to `seconds` (the flood's rounds, the tree and discharge, the incision, the landslides, the uplift)
  profile = false;
  readonly seconds: Record<string, number> = { flood: 0, tree: 0, incise: 0, slide: 0, creep: 0, lift: 0 };
  private async lap<T>(name: string, f: () => Promise<T> | T): Promise<T> {
    if (!this.profile) return f();
    await this.gpu.device.queue.onSubmittedWorkDone();
    const t = performance.now(), v = await f();
    await this.gpu.device.queue.onSubmittedWorkDone();
    this.seconds[name] += (performance.now() - t) / 1000;
    return v;
  }
  creepSubs: number;
  readonly band: 0 | 1 | 2;
  clamped = 0; // the band-limited hold: the land cells held at one unit, and the height (1/256 m) it would have taken off them, over the steps made
  dropped = 0;
  stepNo = 0; // the steps made: the routing's draws are made for it
  private route: 0 | 1;
  // `rho` (the rain of each cell) is no longer given: the rain, like the rock, is read at a cell from the table of tier-0 cells by interpolation (`smooth`).
  constructor(readonly gpu: Gpu, readonly tier: number, table: Uint32Array, height: Int32Array, readonly law: RouteLaw = { nflow: FLOW_NEIGHBOURS, stochastic: false }) {
    this.g = tierGrid(tier);
    this.fn = this.g.fn;
    this.N = FACES * this.fn * this.fn;
    if (height.length !== this.N) throw new Error(`regional: tier ${tier} holds ${this.N} cells, got ${height.length} heights`);
    this.atCnt = this.N + 3 * HIST;
    this.atCarry = this.atCnt + 16 + 2 * CELLS0;
    this.E = storage(gpu, SPLIT * this.N * 4);
    this.E2 = storage(gpu, (RF.COUNT - SPLIT) * this.N * 4);
    this.band = law.band ?? 0;
    this.AT = storage(gpu, (this.atCarry + (this.band ? BAND_PARENT_WORDS - 2 : 13) * CELLS0) * 4);
    this.creepSubs = creepSubsOf(table);
    this.route = law.stochastic ? 1 : 0;
    this.P = storage(gpu, new Uint32Array([1, this.creepSubs, 0, this.route]));
    this.X = storage(gpu, table);
    this.wgsl = regionalWgsl(EDGES, this.fn, law.nflow, undefined, law.slide ?? 8, this.band);
    this.write("H", height);
    this.submit((p) => { this.run(p, "cellmeans", this.N); if (this.band) this.run(p, "bgnbr", CELLS0); });
  }
  private write(f: keyof typeof RF, data: ArrayBufferView) {
    const [b, o] = this.at(f);
    this.gpu.device.queue.writeBuffer(b, o, data.buffer, data.byteOffset, data.byteLength);
  }
  private at(f: keyof typeof RF): [GPUBuffer, number] { return RF[f] < SPLIT ? [this.E, RF[f] * this.N * 4] : [this.E2, (RF[f] - SPLIT) * this.N * 4]; }
  private read(f: keyof typeof RF) { const [b, o] = this.at(f); return readback(this.gpu, b, this.N * 4, o); }
  // Heights and carries as a run left them (a stage resumed).
  load(s: TierState) {
    this.write("H", s.height);
    this.gpu.device.queue.writeBuffer(this.AT, this.atCarry * 4, s.carry);
  }
  // A new table (another step, another K dt): the creep's substeps and every cell's rock, slope and rain are made again from it.
  setTable(table: Uint32Array) {
    this.creepSubs = creepSubsOf(table);
    this.gpu.device.queue.writeBuffer(this.X, 0, table);
    this.gpu.device.queue.writeBuffer(this.P, 0, new Uint32Array([1, this.creepSubs, this.stepNo, this.route]));
    this.submit((p) => this.run(p, "cellmeans", this.N));
  }
  private bind(entry: string) {
    let b = this.binds.get(entry);
    const p = pipeline(this.gpu, this.wgsl, entry);
    if (!b) {
      b = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.P, this.E, this.AT, this.X, this.E2].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.binds.set(entry, b);
    }
    return { p, b };
  }
  // `times` dispatches of an entry point in one pass; `cells` threads each (0: one workgroup).
  private run(pass: GPUComputePassEncoder, entry: string, cells: number, times = 1) {
    const { p, b } = this.bind(entry), g = cells === 0 ? ([1, 1] as [number, number]) : cover(this.gpu, cells);
    pass.setPipeline(p); pass.setBindGroup(0, b);
    for (let i = 0; i < times; i++) pass.dispatchWorkgroups(g[0], g[1]);
  }
  private submit(f: (pass: GPUComputePassEncoder) => void) {
    const enc = this.gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
    f(pass);
    pass.end();
    this.gpu.device.queue.submit([enc.finish()]);
  }
  private clear(word: number, count: number) { this.gpu.device.queue.writeBuffer(this.AT, word * 4, new Uint32Array(count)); }
  // Whether the receivers are drawn among the lower neighbours (the law's) or are the steepest: the settled flow of a tier's final heights is the steepest, as the water stages route.
  setRoute(stochastic: boolean) {
    this.route = stochastic ? 1 : 0;
    this.gpu.device.queue.writeBuffer(this.P, 12, new Uint32Array([this.route]));
  }
  async flags(): Promise<number> { return (await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.flags))[0]; }
  // The flooded surface, the receivers, the depth sort and the discharge area of the heights in E (weights from the rain and the table).
  async flow(): Promise<number> {
    const N = this.N;
    this.clear(this.atCnt + CNT.changed, 1);
    this.submit((p) => { this.run(p, "weights", N); this.run(p, "flinit", N); });
    let rounds = 0, chunk = Math.max(64, this.lastRounds);
    await this.lap("flood", async () => {
      for (;;) {
        this.clear(this.atCnt + CNT.changed, 1);
        this.submit((p) => this.run(p, "flood", N, chunk));
        rounds += chunk;
        if ((await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.changed))[0] === 0) break;
        chunk = 128;
        if (rounds > 40000) throw new Error("regional: the flood did not settle in 40,000 rounds");
      }
    });
    this.lastRounds = rounds - chunk;
    await this.lap("tree", () => this.submit((p) => {
      this.run(p, "recv", N); this.run(p, "lvinit", N);
      for (let r = 0; r < 7; r++) { this.run(p, "jumpa", N); this.run(p, "jumpb", N); }
      this.run(p, "lvhist", N); this.run(p, "lvscan", 0); this.run(p, "lvscatter", N); this.run(p, "area", 0);
    }));
    const flags = await this.flags();
    if (flags & FLAG.area) throw new Error("regional: a basin's discharge area passed 32 bits");
    if (flags & (FLAG.chain | FLAG.depth)) throw new Error(`regional: the receivers' chains do not end at the sea (flags ${flags})`);
    return rounds;
  }
  // One erosion step on the heights in E: flow, the implicit stream power step, then every land cell of a tier-0 cell rises by the mean height its land cells lost.
  async step(): Promise<number> {
    this.gpu.device.queue.writeBuffer(this.P, 8, new Uint32Array([this.stepNo]));
    const rounds = await this.flow(), N = this.N;
    await this.lap("incise", () => this.submit((p) => this.run(p, "incise", 0)));
    // the landslides, rounds until a round moves nothing
    let slide = 0, chunk = Math.max(32, this.lastSlide);
    await this.lap("slide", async () => {
      for (;;) {
        this.clear(this.atCnt + CNT.changed, 1);
        this.submit((p) => this.run(p, "slide", N, chunk));
        slide += chunk;
        if ((await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.changed))[0] === 0) break;
        chunk = 32;
        if (slide > 40000) throw new Error("regional: the landslides did not settle in 40,000 rounds");
      }
    });
    this.lastSlide = slide - chunk;
    await this.lap("creep", () => this.submit((p) => { for (let s = 0; s < this.creepSubs; s++) { this.run(p, "creep", N); this.run(p, "creepapply", N); } }));
    if (this.band) {
      this.clear(this.atCnt + BAND_CNT.clamped, 2);
      await this.lap("lift", () => this.submit((p) => {
        this.run(p, "bpzero", CELLS0); this.run(p, "bpstzero", CELLS0); this.run(p, "btally", N); this.run(p, "bpmean", CELLS0);
        for (let s = 0; s < SOLVE_SWEEPS; s += 2) { this.run(p, "bpsolve", CELLS0); this.run(p, "bpsolve2", CELLS0); }
        this.run(p, "blift", N); this.run(p, "bpcarry", CELLS0);
      }));
      if ((await this.flags()) & BAND_FLAG_CARRY) throw new Error("regional: the band-limited uplift's moments or carry passed 32 bits");
      const [clamped, dropped] = await readU32(this.gpu, this.AT, 2, this.atCnt + BAND_CNT.clamped);
      this.clamped += clamped; this.dropped += new Int32Array([dropped])[0];
    } else {
      await this.lap("lift", () => this.submit((p) => {
        this.run(p, "pzero", CELLS0); this.run(p, "tally", N); this.run(p, "pstzero", CELLS0); this.run(p, "pstencil", N); this.run(p, "pmean", CELLS0);
        for (let s = 0; s < SOLVE_SWEEPS; s += 2) { this.run(p, "psolve", CELLS0); this.run(p, "psolve2", CELLS0); }
        this.run(p, "lift", N); this.run(p, "pcarry", CELLS0);
      }));
    }
    this.stepNo++;
    return rounds;
  }
  async readH(): Promise<Int32Array> { return this.readField("H"); }
  async readField(f: keyof typeof RF): Promise<Int32Array> { return new Int32Array(await this.read(f)); }
  async readCarry(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, (this.band ? 2 : 1) * CELLS0 * 4, this.atCarry * 4)); }
  // The depth of the deepest flow path of the last flow, in cells (the counting sort holds MAXD).
  async deepest(): Promise<number> { return (await readU32(this.gpu, this.AT, 1, this.atCnt + CNT.top))[0]; }
  async readFlooded(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, this.N * 4, 0)); }
  async state(steps: number): Promise<TierState> { return { height: await this.readH(), carry: await this.readCarry(), steps }; }
  async readFlow(): Promise<TierFlow> {
    const [to, acc] = await Promise.all([this.readField("TO"), this.readField("ACC")]);
    return { to: new Uint32Array(to.buffer), acc: new Uint32Array(acc.buffer), rounds: this.lastRounds };
  }
  release() { for (const b of [this.E, this.E2, this.AT, this.P, this.X]) b.destroy(); this.binds.clear(); }

  // Add the weights given (units in the caller's) down the forest of the last flow: what each cell and everything draining to it carries.
  async gather(weights: Uint32Array): Promise<Uint32Array> {
    this.write("W", weights);
    this.submit((p) => this.run(p, "area", 0));
    if ((await this.flags()) & FLAG.area) throw new Error("regional: a basin's sum passed 32 bits");
    return new Uint32Array(await this.read("ACC"));
  }
  // The forest of receivers given (a settled tier's `to`: a land cell's receiver, a sea cell itself), without the flood: the depth sort and its checks, ready for gather64.
  async forest(to: Uint32Array): Promise<void> {
    if (to.length !== this.N) throw new Error(`regional: tier ${this.tier} holds ${this.N} cells, got ${to.length} receivers`);
    this.write("TO", to);
    this.clear(this.atCnt + CNT.flags, 1);
    this.submit((p) => {
      this.run(p, "lvinit", this.N);
      for (let r = 0; r < 7; r++) { this.run(p, "jumpa", this.N); this.run(p, "jumpb", this.N); }
      this.run(p, "lvhist", this.N); this.run(p, "lvscan", 0); this.run(p, "lvscatter", this.N);
    });
    const flags = await this.flags();
    if (flags & (FLAG.chain | FLAG.depth)) throw new Error(`regional: the receivers' chains do not end at the sea (flags ${flags})`);
  }
  // The sum of the weights given (u32 a cell) down the forest of the last flow or forest, exact in 64 bits: each cell's own weight and every cell that drains to it, anywhere on
  // the planet, across tile and face edges. The words come back apart (low u32, high u32); ER (the high words) is free between steps, so call it before a step's flow.
  async gather64(weights: Uint32Array): Promise<{ lo: Uint32Array; hi: Uint32Array }> {
    this.write("W", weights);
    this.submit((p) => this.run(p, "area64", 0));
    const [lo, hi] = await Promise.all([this.read("ACC"), this.read("ER")]);
    return { lo: new Uint32Array(lo), hi: new Uint32Array(hi) };
  }
  // The same with signed weights (i32 a cell) and a mask word a cell (1: a negative sum passes down as 0, 2: the sum is not passed down); the sums as 64-bit two's complement words.
  async gatherSigned(weights: Int32Array, mask: Uint32Array): Promise<{ lo: Uint32Array; hi: Int32Array }> {
    this.write("W", weights); this.write("RD", mask);
    this.submit((p) => this.run(p, "areaS64", 0));
    const [lo, hi] = await Promise.all([this.read("ACC"), this.read("ER")]);
    return { lo: new Uint32Array(lo), hi: new Int32Array(hi) };
  }
  // For each cell the nearest cell down its receivers (itself included) whose flag is not 0, 0xffffffff where there is none.
  async reach(flags: Uint32Array): Promise<Uint32Array> {
    this.write("W", flags);
    this.submit((p) => this.run(p, "reach64", 0));
    return new Uint32Array(await this.read("ACC"));
  }
}

// The rain word of every cell of the tier: the year's rain over the reference rain, Q8, from the remapped rain in mm.
export const rainWords = (mm: Float32Array, ref = REF_RAIN_MMYR): Int32Array => Int32Array.from(mm, (v) => rainWord(v, ref));

// ---------- 5. the tier kept ----------
// What is kept of a made tier: the heights (1/256 m above the present sea) and the receivers and discharge area of the flow on them.
export interface Tier {
  seed: number; tier: number; steps: number; dtYr: number; key: string;
  height: Int32Array; to: Uint32Array; acc: Uint32Array; // acc: 1/512 of the mean cell at the reference rain (as erosion.ts)
}
export function packTier(t: Tier): Uint8Array {
  return packRecord({ seed: t.seed, tier: t.tier, steps: t.steps, dtYr: t.dtYr, key: t.key }, { height: t.height, to: t.to, acc: t.acc });
}
export function unpackTier(bytes: Uint8Array): Tier {
  const { meta, arrays: a } = unpackRecord(bytes);
  return { seed: meta.seed, tier: meta.tier, steps: meta.steps, dtYr: meta.dtYr, key: meta.key, height: a.height as Int32Array, to: a.to as Uint32Array, acc: a.acc as Uint32Array };
}
const packState = (key: string, s: TierState) => packRecord({ key, steps: s.steps }, { height: s.height, carry: s.carry });
const unpackState = (bytes: Uint8Array, key: string): TierState | null => {
  const { meta, arrays: a } = unpackRecord(bytes);
  return meta.key === key ? { height: a.height as Int32Array, carry: a.carry as Int32Array, steps: meta.steps } : null;
};

// The inputs of a tier from a planet: the tier-0 table, the remapped heights and the rain words.
export function regionalInputs(planet: Planet, o = REGIONAL) {
  const p = defaultParams({ dtYr: o.dtYr });
  return { p, table: tierTable(planet, o.tier, p), height: remapHeights(o.tier, planet.height), rho: rainWords(remapAmounts(o.tier, annualRain(planet))) };
}

// Make a tier: the steps of erosion from the remap, kept in the store as they go (a state is the heights and the carries, so a part resumes where the
// last stopped and the bytes do not depend on where the parts split), within a budget of seconds; null when the budget ends before the last step.
// `key` names the sources that make a tier (a tier made by other code is not read as this code's).
export async function regionalOf(gpu: Gpu, planet: Planet, store: PlanetStore, key: string, budgetS = Infinity, o = REGIONAL, log: (s: string) => void = () => {}): Promise<Tier | null> {
  const done = await store.get(planet.seed, `regional-${key}`);
  if (done) return unpackTier(done);
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
  const { table, height } = regionalInputs(planet, o);
  const r = new Regional(gpu, o.tier, table, height);
  try {
    const kept = await store.get(planet.seed, `regional-state-${key}`), prior = kept ? unpackState(kept, key) : null;
    let steps = 0;
    if (prior) { r.load(prior); steps = prior.steps; }
    log(`inputs ${spent().toFixed(1)} s, steps kept ${steps}`);
    let last = 0;
    while (steps < o.steps) {
      if (spent() + last * 1.3 + FINISH_S + SAVE_S > budgetS) break;
      const t = performance.now();
      await r.step();
      steps++;
      last = (performance.now() - t) / 1000;
      log(`step ${steps} ${last.toFixed(1)} s, flood ${r.lastRounds} rounds, slides ${r.lastSlide}`);
    }
    if (steps < o.steps) {
      await store.put(planet.seed, `regional-state-${key}`, packState(key, await r.state(steps)));
      return null;
    }
    await r.flow();
    const flow = await r.readFlow(), tier: Tier = { seed: planet.seed, tier: o.tier, steps, dtYr: o.dtYr, key, height: await r.readH(), to: flow.to, acc: flow.acc };
    await store.put(planet.seed, `regional-${key}`, packTier(tier));
    log(`finished ${spent().toFixed(1)} s`);
    return tier;
  } finally { r.release(); }
}
// What the end of a tier costs, s (the settled flow and the readbacks), and a state's save [design: the margins the stage leaves under its budget].
const FINISH_S = 60, SAVE_S = 10;
