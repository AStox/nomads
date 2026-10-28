// Straight-coast, straight-lake and thin-spit gates on a square block of one tier's heights (1/256 m, row-major, face axes = the tier lattice), the same code for a region state, a window of a
// whole-tier file (old or new planet) and a synthetic input. Cells are the tier's own (tier 5: 75 m); lengths are reported in cells and km. The `margin` cells at the block's edge are cut off
// (the harness's held ring reaches that far) before anything is measured; a chain meeting the cut ends there.
//
//  sea, land    sea = height at or under 0 (and not a lake); land = every other cell, a lake included in the coast's view. Lake cell = a cell whose flooded surface is above its height; the surface is
//               the Priority-Flood fill (Barnes, Lehman and Mulla 2014) of the block with every cell at or under 0 and every edge cell an outlet (the region harness's own flow, rivers.ts), or, for a
//               window of a whole-tier file, that file's flooded plane (`file` variant). A lake of under 16 cells is not a lake for the shore and the strips (its cells are plain land).
//  chain        the shore as the closed or edge-cut polylines of the cell corners between a land cell and a sea (or lake) cell, 4-neighbour, land on one side, walked with the square-tracing rule (land
//               4-connected); a chain's cells are the land cells along it in order (a cell with two shore edges once in a row, a 1-cell spit's cells twice).
//  run          a stretch of consecutive chain cells all of whose centres lie within 1 cell (perpendicular distance) of one straight line of a fixed direction: the cells' perpendicular offsets span at
//               most 2 cells. Its length is its extent along the direction + 1 cell. The share at L = the share of coast cells (lake-shore cells) lying in a run of at least L cells along the
//               direction; a closed chain is walked round twice so a run may cross its start. Directions come in perpendicular pairs and a cell counts once for a pair (it can lie in a run along either):
//               `axis` the lattice axes (0 and 90 degrees: along a row or a column), `diag` the two diagonals (45 and 135), `ctrl` the control: the mean of the pairs (20, 110) and (65, 155), directions
//               that are 20 degrees or more from every lattice axis and diagonal. A shore with no direction preferred has equal shares in all of them (a disc: axis = diag = ctrl); a lattice
//               effect shows as axis (or diag) far above ctrl. `ratio` = axis / ctrl (null when ctrl is 0). `longestKm` is the longest run of each class.
//  rot          the control that the lattice's own bias cannot touch: the block turned by 22.5 and 67.5 degrees (bilinear, rotateField) and its coast and lake shore measured along the lattice axes
//               again: `axisOverRotated` = the block's axis share over the turned blocks' mean. A run along a row costs no stair jitter and one at 20 degrees does, so a rasterised disc has axis shares
//               above ctrl shares (L64: .24 against 0 at radius 200); the turned block pays the same bias, so a ratio near 1 means no structure locked to the lattice and one far above 1 means some.
//  phase        `edgePhase`: the share of the coast's (and the lakes') vertical and horizontal edges lying on a multiple of 2, 4, 8, 16, 32 cells of the tier's grid (the next coarser tiers' cell edges)
//               against the 1/2 .. 1/32 of a shore with no tie to them.
//  exact        `exactRuns`: edges of the coast (and lakes) in stretches on ONE lattice line with no jitter at all, in 16 / 32 / 64 / 128 cells or more, and the five longest with their place.
//  inlets       the spit measure on the sea (h <= 0) with 12-cell squares: water narrower than 12 cells (channels, flooded troughs below sea level: inland strips of sea that no lake measure sees).
//  lakes        `n` lakes (4-connected, of 16 cells or more, not meeting the cut), `areaKm2`; a strip is a lake with an aspect ratio of 4 or more and a width under 12 cells and a length of 16 cells or
//               more: by `bbox` (axis-aligned bounding box: long side over short side, short side under 12), or by `moment` (the lake's principal axes, length = sqrt(12 l1 + 1), width = sqrt(12 l2 + 1)
//               of the cells' covariance eigenvalues); `axis`, `diag`, `other` = strips whose principal axis is within 8 degrees of a lattice axis, of a diagonal, or neither (the uniform expectation
//               is 0.178, 0.178, 0.644). A bbox strip is axis-aligned by its own definition, so its `axis` counts the principal axis too.
//  spits        thin land: a land cell that no 6 by 6 all-land square contains (under 6 cells wide). `axisRun64` the thin cells lying in a run of 64 or more along a row or a column (columns, resp.
//               rows, occupied without a gap by a band of 3 rows, resp. columns), `axisRunKm` the longest, `strips` the 8-connected components of thin cells that are strips (principal length 64 cells
//               or more, width under 12) with their direction classes as for the lakes.
import { Heap } from "./rivers";

const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // sides: 0 north, 1 east, 2 south, 3 west
export const RUN_LENGTHS = [16, 32, 64, 128];
const DIRS = [0, 90, 45, 135, 20, 110, 65, 155]; // axis pair, diag pair, control pairs
const TOL = 2; // perpendicular spread of a run, cells
const MIN_LAKE = 16;

export function crop(h: ArrayLike<number>, size: number, m: number): Int32Array {
  const n = size - 2 * m, out = new Int32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = h[(y + m) * size + x + m];
  return out;
}

// Lake mask of the Priority-Flood surface: sea (h <= 0) and edge cells are outlets.
export function floodLakes(h: Int32Array, side: number): Uint8Array {
  const n = side * side, lvl = new Int32Array(n), done = new Uint8Array(n), heap = new Heap(n), lake = new Uint8Array(n);
  const seed = (k: number) => h[k] <= 0 || k % side === 0 || k % side === side - 1 || k < side || k >= n - side;
  for (let k = 0; k < n; k++) if (seed(k)) { done[k] = 1; lvl[k] = h[k]; }
  for (let k = 0; k < n; k++) {
    if (!done[k]) continue;
    const x = k % side, y = (k / side) | 0;
    let edge = false;
    for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = x + dx, b = y + dy;
      if (a < 0 || b < 0 || a >= side || b >= side) continue;
      if (!done[b * side + a]) { edge = true; break; }
    }
    if (edge) heap.push(lvl[k], k);
  }
  while (heap.n) {
    const c = heap.pop(), cx = c % side, cy = (c / side) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = cx + dx, b = cy + dy;
      if ((dx === 0 && dy === 0) || a < 0 || b < 0 || a >= side || b >= side) continue;
      const k = b * side + a;
      if (done[k]) continue;
      done[k] = 1;
      const l = Math.max(h[k], lvl[c]);
      lvl[k] = l;
      if (l > h[k]) lake[k] = 1;
      heap.push(l, k);
    }
  }
  return lake;
}

export interface Chains { seq: Int32Array[]; closed: boolean[] }

// Shore chains between `inside` cells and `water` cells (disjoint masks); see the header.
export function shoreChains(inside: Uint8Array, water: Uint8Array, side: number): Chains {
  const n = side * side;
  const exists = (c: number, s: number) => {
    if (!inside[c]) return false;
    const x = (c % side) + DX[s], y = ((c / side) | 0) + DY[s];
    return x >= 0 && y >= 0 && x < side && y < side && water[y * side + x] === 1;
  };
  const next = (e: number): number => {
    const c = e >> 2, s = e & 3, x = c % side, y = (c / side) | 0, f = (s + 1) & 3, ax = x + DX[f], ay = y + DY[f];
    if (ax < 0 || ay < 0 || ax >= side || ay >= side) return -1;
    const ar = ay * side + ax;
    if (!inside[ar]) return exists(c, f) ? c * 4 + f : -1;
    const lx = ax + DX[s], ly = ay + DY[s];
    if (lx < 0 || ly < 0 || lx >= side || ly >= side) return -1;
    const al = ly * side + lx;
    if (inside[al]) return al * 4 + ((s + 3) & 3);
    return exists(ar, s) ? ar * 4 + s : -1;
  };
  const hasPred = new Uint8Array(4 * n), seen = new Uint8Array(4 * n);
  for (let c = 0; c < n; c++) if (inside[c]) for (let s = 0; s < 4; s++) if (exists(c, s)) { const q = next(c * 4 + s); if (q >= 0) hasPred[q] = 1; }
  const seq: Int32Array[] = [], closed: boolean[] = [];
  const walk = (e0: number, isClosed: boolean) => {
    const cells: number[] = [];
    let e = e0;
    while (e >= 0 && !seen[e]) {
      seen[e] = 1;
      const c = e >> 2;
      if (cells.length === 0 || cells[cells.length - 1] !== c) cells.push(c);
      e = next(e);
    }
    if (isClosed && cells.length > 1 && cells[cells.length - 1] === cells[0]) cells.pop();
    seq.push(Int32Array.from(cells)); closed.push(isClosed);
  };
  for (let c = 0; c < n; c++) if (inside[c]) for (let s = 0; s < 4; s++) { const e = c * 4 + s; if (exists(c, s) && !hasPred[e] && !seen[e]) walk(e, false); }
  for (let c = 0; c < n; c++) if (inside[c]) for (let s = 0; s < 4; s++) { const e = c * 4 + s; if (exists(c, s) && !seen[e]) walk(e, true); }
  return { seq, closed };
}

export interface ShareSet { L16: number; L32: number; L64: number; L128: number }
export interface ShoreRuns {
  cells: number; chains: number;
  axis: ShareSet; diag: ShareSet; ctrl: ShareSet; ctrl20: ShareSet; axisH: ShareSet; axisV: ShareSet;
  ratio: { L16: number | null; L32: number | null; L64: number | null; L128: number | null };
  longestKm: { axis: number; diag: number; ctrl: number };
}

const r4 = (v: number) => +v.toFixed(4);

// Runs of every chain along each of the 8 directions; marks[cell] bit (dir * 4 + length index); longest[dir] in cells.
function markRuns(ch: Chains, side: number, marks: Uint32Array, longest: Float64Array) {
  for (let q = 0; q < ch.seq.length; q++) {
    const cells = ch.seq[q], n = cells.length, closed = ch.closed[q] && n > 2, m = closed ? 2 * n : n;
    const px = new Float64Array(m), py = new Float64Array(m);
    for (let k = 0; k < m; k++) { const c = cells[k % n]; px[k] = c % side; py[k] = (c / side) | 0; }
    for (let di = 0; di < DIRS.length; di++) {
      const t = (DIRS[di] * Math.PI) / 180, ct = Math.cos(t), st = Math.sin(t);
      const d = new Float64Array(m), s = new Float64Array(m);
      for (let k = 0; k < m; k++) { d[k] = -px[k] * st + py[k] * ct; s[k] = px[k] * ct + py[k] * st; }
      const dmax = new Int32Array(m), dmin = new Int32Array(m), smax = new Int32Array(m), smin = new Int32Array(m);
      let a1 = 0, b1 = 0, a2 = 0, b2 = 0, a3 = 0, b3 = 0, a4 = 0, b4 = 0; // head and tail of the four deques
      const diff = RUN_LENGTHS.map(() => new Int32Array(m + 1));
      let j = -1;
      const lim = (i: number) => Math.min(m, closed ? i + n : n);
      for (let i = 0; i < (closed ? n : m); i++) {
        while (a1 < b1 && dmax[a1] < i) a1++; while (a2 < b2 && dmin[a2] < i) a2++; while (a3 < b3 && smax[a3] < i) a3++; while (a4 < b4 && smin[a4] < i) a4++;
        if (j < i - 1) j = i - 1;
        for (; j + 1 < lim(i); ) {
          const k = j + 1, hi = a1 < b1 ? Math.max(d[dmax[a1]], d[k]) : d[k], lo = a2 < b2 ? Math.min(d[dmin[a2]], d[k]) : d[k];
          if (hi - lo > TOL + 1e-9) break;
          while (b1 > a1 && d[dmax[b1 - 1]] <= d[k]) b1--; dmax[b1++] = k;
          while (b2 > a2 && d[dmin[b2 - 1]] >= d[k]) b2--; dmin[b2++] = k;
          while (b3 > a3 && s[smax[b3 - 1]] <= s[k]) b3--; smax[b3++] = k;
          while (b4 > a4 && s[smin[b4 - 1]] >= s[k]) b4--; smin[b4++] = k;
          j = k;
        }
        const ext = s[smax[a3]] - s[smin[a4]] + 1;
        if (ext > longest[di]) longest[di] = ext;
        for (let li = 0; li < RUN_LENGTHS.length; li++) if (ext >= RUN_LENGTHS[li] - 1e-9) { diff[li][i]++; diff[li][j + 1]--; }
      }
      for (let li = 0; li < RUN_LENGTHS.length; li++) {
        let cover = 0;
        const bit = (1 << (di * 4 + li)) >>> 0, mark = new Uint8Array(n);
        for (let p = 0; p < m; p++) { cover += diff[li][p]; if (cover > 0) mark[p % n] = 1; }
        for (let p = 0; p < n; p++) if (mark[p]) marks[cells[p]] = (marks[cells[p]] | bit) >>> 0;
      }
    }
  }
}

export function shoreRuns(ch: Chains, side: number, cellM: number): ShoreRuns {
  const marks = new Uint32Array(side * side), longest = new Float64Array(DIRS.length), seen = new Set<number>();
  markRuns(ch, side, marks, longest);
  for (const c of ch.seq) for (const k of c) seen.add(k);
  const cells = [...seen], N = Math.max(1, cells.length);
  const share = (dirs: number[], li: number) => {
    let c = 0;
    for (const k of cells) { let hit = false; for (const di of dirs) if (marks[k] & ((1 << (di * 4 + li)) >>> 0)) hit = true; if (hit) c++; }
    return c / N;
  };
  const set = (f: (li: number) => number): ShareSet => ({ L16: r4(f(0)), L32: r4(f(1)), L64: r4(f(2)), L128: r4(f(3)) });
  const axis = set((li) => share([0, 1], li)), diag = set((li) => share([2, 3], li)), ctrl = set((li) => (share([4, 5], li) + share([6, 7], li)) / 2);
  const ratio = (k: keyof ShareSet) => (ctrl[k] > 0 ? r4(axis[k] / ctrl[k]) : null);
  const km = (dirs: number[]) => r4((Math.max(...dirs.map((d) => longest[d])) * cellM) / 1000);
  return {
    cells: cells.length, chains: ch.seq.length, axis, diag, ctrl, ctrl20: set((li) => share([4], li)), axisH: set((li) => share([0], li)), axisV: set((li) => share([1], li)),
    ratio: { L16: ratio("L16"), L32: ratio("L32"), L64: ratio("L64"), L128: ratio("L128") }, longestKm: { axis: km([0, 1]), diag: km([2, 3]), ctrl: km([4, 5, 6, 7]) },
  };
}

interface Comp { cells: number; angleDeg: number; length: number; width: number; bw: number; bh: number; touches: boolean }

// 4- or 8-connected components of a mask: area, bounding box, principal axes, whether it meets the block's edge.
function components(mask: Uint8Array, side: number, eight: boolean): { comps: Comp[]; ids: Int32Array[] } {
  const n = side * side, seen = new Uint8Array(n), queue = new Int32Array(n), comps: Comp[] = [], ids: Int32Array[] = [];
  const nd = eight ? 8 : 4, ddx = [0, 1, 0, -1, 1, -1, -1, 1], ddy = [-1, 0, 1, 0, 1, 1, -1, -1];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || seen[s]) continue;
    let qh = 0, qt = 0;
    queue[qt++] = s; seen[s] = 1;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = side, x1 = -1, y0 = side, y1 = -1, touches = false;
    while (qh < qt) {
      const c = queue[qh++], x = c % side, y = (c / side) | 0;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === side - 1 || y === side - 1) touches = true;
      for (let d = 0; d < nd; d++) {
        const a = x + ddx[d], b = y + ddy[d];
        if (a < 0 || b < 0 || a >= side || b >= side) continue;
        const k = b * side + a;
        if (mask[k] && !seen[k]) { seen[k] = 1; queue[qt++] = k; }
      }
    }
    const N = qt, mx = sx / N, my = sy / N, cxx = sxx / N - mx * mx, cyy = syy / N - my * my, cxy = sxy / N - mx * my;
    const tr = (cxx + cyy) / 2, df = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy), l1 = tr + df, l2 = Math.max(0, tr - df);
    comps.push({ cells: N, angleDeg: (0.5 * Math.atan2(2 * cxy, cxx - cyy) * 180) / Math.PI, length: Math.sqrt(12 * l1 + 1), width: Math.sqrt(12 * l2 + 1), bw: x1 - x0 + 1, bh: y1 - y0 + 1, touches });
    ids.push(Int32Array.from(queue.subarray(0, N)));
  }
  return { comps, ids };
}

const ANGLE_TOL = 8;
function dirClass(angleDeg: number): "axis" | "diag" | "other" {
  const a = ((angleDeg % 90) + 90) % 90; // 0 = a lattice axis, 45 = a diagonal
  if (a <= ANGLE_TOL || a >= 90 - ANGLE_TOL) return "axis";
  if (Math.abs(a - 45) <= ANGLE_TOL) return "diag";
  return "other";
}
function classCounts(cs: Comp[]) {
  const o = { n: cs.length, axis: 0, diag: 0, other: 0 };
  for (const c of cs) o[dirClass(c.angleDeg)]++;
  return { n: o.n, axis: o.n ? r4(o.axis / o.n) : null, diag: o.n ? r4(o.diag / o.n) : null, other: o.n ? r4(o.other / o.n) : null };
}

export interface LakeMeasures {
  source: string; n: number; nAll: number; areaKm2: number;
  strips: { bbox: { n: number; areaKm2: number; axis: number | null }; moment: { n: number; areaKm2: number; axis: number | null; diag: number | null; other: number | null } };
  shore: ShoreRuns;
}

// `lake`: the lake mask (any size of lake); sea = h <= 0 outside lakes is not touched here.
export function lakeMeasures(h: Int32Array, lake: Uint8Array, side: number, cellM: number, source: string): LakeMeasures {
  const { comps, ids } = components(lake, side, false), big = new Uint8Array(side * side), area = (c: number) => (c * cellM * cellM) / 1e6;
  let n = 0, a = 0;
  const strips: Comp[] = [], bboxStrips: Comp[] = [];
  comps.forEach((c, i) => {
    if (c.cells < MIN_LAKE) return;
    for (const k of ids[i]) big[k] = 1;
    if (c.touches) return;
    n++; a += area(c.cells);
    if (c.length >= 16 && c.length / c.width >= 4 && c.width < 12) strips.push(c);
    const lo = Math.min(c.bw, c.bh), hi = Math.max(c.bw, c.bh);
    if (hi >= 16 && hi / lo >= 4 && lo < 12) bboxStrips.push(c);
  });
  const inside = new Uint8Array(side * side);
  for (let k = 0; k < inside.length; k++) inside[k] = h[k] > 0 && !big[k] ? 1 : 0;
  const mc = classCounts(strips), sum = (cs: Comp[]) => r4(cs.reduce((t, c) => t + area(c.cells), 0));
  return {
    source, n, nAll: comps.length, areaKm2: r4(a),
    strips: {
      bbox: { n: bboxStrips.length, areaKm2: sum(bboxStrips), axis: bboxStrips.length ? r4(bboxStrips.filter((c) => dirClass(c.angleDeg) === "axis").length / bboxStrips.length) : null },
      moment: { n: mc.n, areaKm2: sum(strips), axis: mc.axis, diag: mc.diag, other: mc.other },
    },
    shore: shoreRuns(shoreChains(inside, big, side), side, cellM),
  };
}

export interface SpitMeasures {
  thinCells: number; landCells: number; axisRun64: number; axisRunKm: number;
  strips: { n: number; axis: number | null; diag: number | null; other: number | null; longestKm: number; axisCells: number; allCells: number };
}

export function spitMeasures(h: Int32Array, side: number, cellM: number, wide = 6, runL = 64): SpitMeasures {
  const n = side * side, land = new Uint8Array(n);
  let landCells = 0;
  for (let k = 0; k < n; k++) if (h[k] > 0) { land[k] = 1; landCells++; }
  // cells covered by a full wide x wide land square: integral image, then a 2D difference array of the squares
  const S = side + 1, ii = new Int32Array(S * S);
  for (let y = 0; y < side; y++) { let row = 0; for (let x = 0; x < side; x++) { row += land[y * side + x]; ii[(y + 1) * S + x + 1] = ii[y * S + x + 1] + row; } }
  const dd = new Int32Array(S * S);
  for (let y = 0; y + wide <= side; y++) for (let x = 0; x + wide <= side; x++) {
    if (ii[(y + wide) * S + x + wide] - ii[y * S + x + wide] - ii[(y + wide) * S + x] + ii[y * S + x] !== wide * wide) continue;
    dd[y * S + x]++; dd[y * S + x + wide]--; dd[(y + wide) * S + x]--; dd[(y + wide) * S + x + wide]++;
  }
  const thin = new Uint8Array(n), cov = new Int32Array(S);
  let thinCells = 0;
  const colAcc = new Int32Array(S);
  for (let y = 0; y < side; y++) {
    let run = 0;
    for (let x = 0; x < side; x++) { colAcc[x] += dd[y * S + x]; run += colAcc[x]; cov[x] = run; if (land[y * side + x] && cov[x] <= 0) { thin[y * side + x] = 1; thinCells++; } }
  }
  // axis runs: a band of 3 rows (columns) with a thin cell in every column (row) over runL or more
  const flag = new Uint8Array(n);
  let longest = 0;
  for (const horiz of [true, false]) {
    for (let b = 0; b < side; b++) {
      let start = -1;
      const occ = (t: number) => {
        for (let o = -1; o <= 1; o++) {
          const r = b + o;
          if (r < 0 || r >= side) continue;
          if (horiz ? thin[r * side + t] : thin[t * side + r]) return true;
        }
        return false;
      };
      for (let t = 0; t <= side; t++) {
        const on = t < side && occ(t);
        if (on && start < 0) start = t;
        if (!on && start >= 0) {
          if (t - start >= runL) {
            if (t - start > longest) longest = t - start;
            for (let u = start; u < t; u++) for (let o = -1; o <= 1; o++) { const r = b + o; if (r < 0 || r >= side) continue; const k = horiz ? r * side + u : u * side + r; if (thin[k]) flag[k] = 1; }
          }
          start = -1;
        }
      }
    }
  }
  let axisRun = 0;
  for (let k = 0; k < n; k++) axisRun += flag[k];
  const { comps } = components(thin, side, true), sp: Comp[] = [];
  let allCells = 0, axisCells = 0, longestStrip = 0;
  comps.forEach((c) => {
    if (c.length < runL || c.width >= 12) return;
    sp.push(c); allCells += c.cells; if (dirClass(c.angleDeg) === "axis") axisCells += c.cells;
    if (c.length > longestStrip) longestStrip = c.length;
  });
  const cc = classCounts(sp);
  return {
    thinCells, landCells, axisRun64: axisRun, axisRunKm: r4((longest * cellM) / 1000),
    strips: { n: cc.n, axis: cc.axis, diag: cc.diag, other: cc.other, longestKm: r4((longestStrip * cellM) / 1000), axisCells, allCells },
  };
}

// The block rotated by `deg` about its centre (bilinear on heights, 1 cell per cell), the largest centred square that fits: the same field with the lattice turned off the features.
export function rotateField(h: Int32Array, side: number, deg: number): { h: Int32Array; side: number } {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), n = Math.floor(side / (Math.abs(c) + Math.abs(s))) - 2, out = new Int32Array(n * n), mid = (side - 1) / 2, mo = (n - 1) / 2;
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
    const dx = u - mo, dy = v - mo, x = mid + dx * c - dy * s, y = mid + dx * s + dy * c, ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, k = iy * side + ix;
    out[v * n + u] = Math.round((h[k] * (1 - fx) + h[k + 1] * fx) * (1 - fy) + (h[k + side] * (1 - fx) + h[k + side + 1] * fx) * fy);
  }
  return { h: out, side: n };
}

export interface RotatedControl { degrees: number[]; coast: RotatedShares; lakeShore: RotatedShares }
export interface RotatedShares { axis: ShareSet; diag: ShareSet; longestKm: { axis: number; diag: number }; axisOverRotated: { L16: number | null; L32: number | null; L64: number | null; L128: number | null } }

const meanSets = (a: ShareSet[]): ShareSet => ({ L16: r4(a.reduce((t, x) => t + x.L16, 0) / a.length), L32: r4(a.reduce((t, x) => t + x.L32, 0) / a.length), L64: r4(a.reduce((t, x) => t + x.L64, 0) / a.length), L128: r4(a.reduce((t, x) => t + x.L128, 0) / a.length) });

// Coast and lake shore of the same block turned by each angle, measured along the lattice axes again; the axis share of the turned field is the natural baseline, the lattice's own bias (a
// row or column costs no stair jitter, an oblique line does) included, so `axisOverRotated` = the block's axis share over the turned ones' isolates structure locked to the lattice.
function rotatedControl(h: Int32Array, side: number, cellM: number, degrees: number[], axis: { coast: ShoreRuns; shore: ShoreRuns }): RotatedControl {
  const parts = degrees.map((d) => { const r = rotateField(h, side, d), m = coastAndShore(r.h, r.side, cellM); return m; });
  const pick = (get: (m: { coast: ShoreRuns; shore: ShoreRuns }) => ShoreRuns, base: ShoreRuns): RotatedShares => {
    const a = meanSets(parts.map((m) => get(m).axis)), d = meanSets(parts.map((m) => get(m).diag)), ratio = (k: keyof ShareSet) => (a[k] > 0 ? r4(base.axis[k] / a[k]) : null);
    return { axis: a, diag: d, longestKm: { axis: r4(Math.max(...parts.map((m) => get(m).longestKm.axis))), diag: r4(Math.max(...parts.map((m) => get(m).longestKm.diag))) }, axisOverRotated: { L16: ratio("L16"), L32: ratio("L32"), L64: ratio("L64"), L128: ratio("L128") } };
  };
  return { degrees, coast: pick((m) => m.coast, axis.coast), lakeShore: pick((m) => m.shore, axis.shore) };
}

function lakeCells(lake: Uint8Array, side: number): number[] {
  const { comps, ids } = components(lake, side, false), out: number[] = [];
  comps.forEach((c, i) => { if (c.cells >= MIN_LAKE) for (const k of ids[i]) out.push(k); });
  return out;
}

// The coast and the lake shore (lakes of 16 cells or more, from the flood) of a block.
function coastAndShore(h: Int32Array, side: number, cellM: number): { coast: ShoreRuns; shore: ShoreRuns } {
  const lk = floodLakes(h, side), sea = new Uint8Array(side * side), inside = new Uint8Array(side * side);
  for (let k = 0; k < sea.length; k++) { const s = h[k] <= 0 && !lk[k]; sea[k] = s ? 1 : 0; inside[k] = s ? 0 : 1; }
  const { comps, ids } = components(lk, side, false), big = new Uint8Array(side * side);
  comps.forEach((c, i) => { if (c.cells >= MIN_LAKE) for (const k of ids[i]) big[k] = 1; });
  const dry = new Uint8Array(side * side);
  for (let k = 0; k < dry.length; k++) dry[k] = h[k] > 0 && !big[k] ? 1 : 0;
  return { coast: shoreRuns(shoreChains(inside, sea, side), side, cellM), shore: shoreRuns(shoreChains(dry, big, side), side, cellM) };
}

// Where the shore's straight edges lie against the coarser tiers' cell boundaries: the share of the vertical edges (between horizontal neighbours, one in `mask`, one not) whose boundary lies on a
// multiple of 2, 4, 8, 16, 32 cells of the tier's own grid (global coordinates: `ox`, `oy` = the block's origin plus margin), and of the horizontal edges likewise. A shore with no tie to the
// coarser lattices has 1/2, 1/4, ... 1/32; at tier 5 those multiples are tiers 4, 3, 2, 1 and 0's cell edges.
export interface Phase { edges: { x: number; y: number }; x: number[]; y: number[]; expected: number[] }
export function edgePhase(mask: Uint8Array, side: number, ox: number, oy: number): Phase {
  const cx = [0, 0, 0, 0, 0], cy = [0, 0, 0, 0, 0];
  let nx = 0, ny = 0;
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const k = y * side + x;
    if (x + 1 < side && mask[k] !== mask[k + 1]) { nx++; const g = ox + x + 1; for (let b = 0; b < 5; b++) if (g % (2 << b) === 0) cx[b]++; }
    if (y + 1 < side && mask[k] !== mask[k + side]) { ny++; const g = oy + y + 1; for (let b = 0; b < 5; b++) if (g % (2 << b) === 0) cy[b]++; }
  }
  return { edges: { x: nx, y: ny }, x: cx.map((c) => r4(c / Math.max(1, nx))), y: cy.map((c) => r4(c / Math.max(1, ny))), expected: [0.5, 0.25, 0.125, 0.0625, 0.03125] };
}

// Exactly straight shore: maximal stretches of edges between mask and non-mask cells lying on one lattice line (no jitter at all: the same column boundary, or row boundary, over consecutive
// cells), the sharpest sign of a lattice-locked shore. `share` = share of all the shore's edges (both directions) in stretches of 16, 32, 64, 128 or more; `top` the five longest, in the
// block's global cell coordinates (`line` = the boundary's coordinate across, `from` .. `to` along it).
export interface ExactRuns { edges: number; share: ShareSet; longestKm: number; top: { dir: "x" | "y"; line: number; from: number; to: number; len: number }[] }
export function exactRuns(mask: Uint8Array, side: number, ox: number, oy: number, cellM: number): ExactRuns {
  const lens: number[] = [], top: ExactRuns["top"] = [];
  let edges = 0;
  for (const dir of ["x", "y"] as const) {
    for (let g = 0; g + 1 < side; g++) {
      let start = -1;
      for (let t = 0; t <= side; t++) {
        const on = t < side && (dir === "x" ? mask[t * side + g] !== mask[t * side + g + 1] : mask[g * side + t] !== mask[(g + 1) * side + t]);
        if (on) { edges++; if (start < 0) start = t; }
        else if (start >= 0) {
          const len = t - start;
          lens.push(len);
          if (len >= 16) top.push({ dir, line: (dir === "x" ? ox : oy) + g + 1, from: (dir === "x" ? oy : ox) + start, to: (dir === "x" ? oy : ox) + t - 1, len });
          start = -1;
        }
      }
    }
  }
  const share = (L: number) => r4(lens.filter((l) => l >= L).reduce((t, l) => t + l, 0) / Math.max(1, edges));
  top.sort((a, b) => b.len - a.len);
  return { edges, share: { L16: share(16), L32: share(32), L64: share(64), L128: share(128) }, longestKm: r4(((top[0]?.len ?? Math.max(0, ...lens)) * cellM) / 1000), top: top.slice(0, 5) };
}

export interface StraightIn { h: Int32Array; size: number; cellM: number; margin: number; flooded?: Int32Array; rotate?: number[]; ox?: number; oy?: number }
export interface StraightResult { size: number; cellM: number; margin: number; landCells: number; phase: { coast: Phase; lakes: Phase }; exact: { coast: ExactRuns; lakes: ExactRuns }; inlets: SpitMeasures; coast: ShoreRuns; lakes: LakeMeasures; lakesFile: LakeMeasures | null; spits: SpitMeasures; rot: RotatedControl | null }

export function straightMeasures(r: StraightIn, log: (s: string) => void = () => {}): StraightResult {
  const side = r.size - 2 * r.margin, h = crop(r.h, r.size, r.margin), lk = floodLakes(h, side);
  log("flood");
  // coast: inside = every cell that is not sea (h <= 0 and not a lake), water = sea
  const sea = new Uint8Array(side * side), inside = new Uint8Array(side * side);
  let landCells = 0;
  for (let k = 0; k < sea.length; k++) { const s = h[k] <= 0 && !lk[k]; sea[k] = s ? 1 : 0; inside[k] = s ? 0 : 1; if (h[k] > 0) landCells++; }
  const coast = shoreRuns(shoreChains(inside, sea, side), side, r.cellM);
  log("coast");
  const lakes = lakeMeasures(h, lk, side, r.cellM, "flood");
  let lakesFile: LakeMeasures | null = null;
  if (r.flooded) {
    const f = crop(r.flooded, r.size, r.margin), lf = new Uint8Array(side * side);
    for (let k = 0; k < lf.length; k++) lf[k] = f[k] > h[k] ? 1 : 0;
    lakesFile = lakeMeasures(h, lf, side, r.cellM, "file");
  }
  log("lakes");
  const spits = spitMeasures(h, side, r.cellM);
  log("spits");
  const degrees = r.rotate ?? [22.5, 67.5], rot = degrees.length ? rotatedControl(h, side, r.cellM, degrees, { coast, shore: lakes.shore }) : null;
  log("rotated");
  const ox = (r.ox ?? 0) + r.margin, oy = (r.oy ?? 0) + r.margin, bigLake = new Uint8Array(side * side);
  for (const c of lakeCells(lk, side)) bigLake[c] = 1;
  const phase = { coast: edgePhase(sea, side, ox, oy), lakes: edgePhase(bigLake, side, ox, oy) };
  // inlets: the same measure on the sea (h <= 0, lakes of the flood included as land) with squares of 12 cells: water narrower than 12 cells, in strips of 64 cells or more
  const inlets = spitMeasures(Int32Array.from(h, (v) => (v <= 0 ? 1 : -1)), side, r.cellM, 12, 64);
  const exact = { coast: exactRuns(sea, side, ox, oy, r.cellM), lakes: exactRuns(bigLake, side, ox, oy, r.cellM) };
  return { size: side, cellM: r.cellM, margin: r.margin, landCells, phase, exact, inlets, coast, lakes, lakesFile, spits, rot };
}
