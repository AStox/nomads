import { heightColor, mix, png, type RGB } from "./globe-maps";

// What the pictures of a fine tier's landforms are judged by besides the eye: do rivers run straight along the grid's axes (the lattice), and does the height step across the edges of a coarse
// cell's block differ from the step inside it (a constant to a block). Both are functions of plain arrays, so the island's run and a region of the planet are measured the same way.

// Directions as the flow kernels number them: 0 east, 1 north, 2 west, 3 south, 4 NE, 5 NW, 6 SW, 7 SE (x east, y north; row y * side + x).
const DX = [1, 0, -1, 0, 1, -1, -1, 1], DY = [0, 1, 0, -1, 1, 1, -1, -1];

// Of the river cells (drainage area at least `minCells` cells), the share that lie in a straight run of at least `run` cells (the receiver's direction the same for all of them, found along
// the flow path through the cell) and, of those, the share along an axis; plus the share of river cells whose receiver is along an axis at all, and the share of runs' cells by direction.
// `to` holds each cell's receiver (itself at a root), `area` the drainage area in cells; `live` marks the cells to count (land in the region's interior).
export function lattice(to: ArrayLike<number>, area: ArrayLike<number>, side: number, live: Uint8Array, minCells: number, run: number) {
  const n = side * side, dir = new Int8Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    const j = to[k];
    if (j === k) continue;
    const dx = (j % side) - (k % side), dy = Math.floor(j / side) - Math.floor(k / side);
    for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) dir[k] = d;
  }
  // the run through a cell: cells up the path in the same direction (the one cell k - d that flows into k in direction d) and down it
  const up = new Int32Array(n), down = new Int32Array(n);
  const order = Array.from({ length: n }, (_, k) => k).filter((k) => dir[k] >= 0).sort((a, b) => area[a] - area[b]);
  // down: a cell's own run to the end of its direction (the largest areas, which lie downstream, first); up: the longest run of cells that flow in the same direction into it (smallest first)
  for (let q = order.length - 1; q >= 0; q--) { const k = order[q], j = to[k]; down[k] = dir[j] === dir[k] ? 1 + down[j] : 1; }
  for (const k of order) {
    const d = dir[k], j = to[k];
    if (dir[j] === d) up[j] = Math.max(up[j], 1 + up[k]);
  }
  let river = 0, axis = 0, straight = 0, straightAxis = 0, diag = 0;
  const runs = [8, 16, 32, 64], longer = runs.map(() => 0);
  for (const k of order) {
    if (!live[k] || area[k] < minCells) continue;
    river++;
    const axial = dir[k] < 4, len = down[k] + up[k];
    if (axial) axis++;
    if (len >= run) { straight++; if (axial) straightAxis++; else diag++; }
    runs.forEach((r, i) => { if (axial && len >= r) longer[i]++; });
  }
  return {
    river, axisShare: +(axis / Math.max(1, river)).toFixed(3), straightShare: +(straight / Math.max(1, river)).toFixed(3), straightAxisShare: +(straightAxis / Math.max(1, river)).toFixed(3), straightDiagShare: +(diag / Math.max(1, river)).toFixed(3),
    axisRunShare: Object.fromEntries(runs.map((r, i) => [r, +(longer[i] / Math.max(1, river)).toFixed(3)])),
  };
}

// The mean absolute height step between neighbouring land cells across the edges of the blocks of `block` cells (the pair straddling a block's edge) over the mean inside the blocks,
// along x and y together, over the cells where `live` holds. 1 means the edges are no different from the inside; a constant to a block shows as well over 1.
export function blockStep(h: ArrayLike<number>, side: number, live: Uint8Array, block: number, origin = 0) {
  let edge = 0, ne = 0, inner = 0, ni = 0;
  for (let y = 1; y < side - 1; y++)
    for (let x = 1; x < side - 2; x++) {
      const k = y * side + x;
      if (!live[k] || !live[k + 1] || h[k] <= 0 || h[k + 1] <= 0) continue;
      const d = Math.abs(h[k + 1] - h[k]) / 256, at = (x - 1 + origin) % block === block - 1;
      if (at) { edge += d; ne++; } else { inner += d; ni++; }
    }
  for (let y = 1; y < side - 2; y++)
    for (let x = 1; x < side - 1; x++) {
      const k = y * side + x;
      if (!live[k] || !live[k + side] || h[k] <= 0 || h[k + side] <= 0) continue;
      const d = Math.abs(h[k + side] - h[k]) / 256, at = (y - 1 + origin) % block === block - 1;
      if (at) { edge += d; ne++; } else { inner += d; ni++; }
    }
  return ne && ni && inner > 0 ? edge / ne / (inner / ni) : NaN;
}

// A hillshaded height picture of a square view (north up: row y of the arrays is drawn from the bottom) with the rivers (drainage area at least `river` cells) in blue, at `scale` pixels a cell.
// `z` gives the height in metres of the cell at (x, y) (clamped by the caller), `cells` its drainage area in cells (0 for none); 75 m cells, light from the north-west.
export function renderLand(z: (x: number, y: number) => number, cells: ((x: number, y: number) => number) | null, view: [number, number, number], scale: number, river: number, vex = 0, cellM = 75) {
  const [vx, vy, vs] = view, W = vs * scale, rgb = new Uint8Array(W * W * 3), L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  // the vertical exaggeration that makes the view's steepest tenth of slopes 0.5 (so a gentle island and a range of kilometres are shaded to the same contrast), or the one given
  if (vex <= 0) {
    const sl: number[] = [];
    for (let y = 1; y < vs; y += 3) for (let x = 1; x < vs; x += 3) if (z(vx + x, vy + y) > 0) sl.push(Math.hypot(z(vx + x + 1, vy + y) - z(vx + x - 1, vy + y), z(vx + x, vy + y + 1) - z(vx + x, vy + y - 1)) / (2 * cellM));
    sl.sort((a, b) => a - b);
    vex = sl.length ? Math.min(40, 0.5 / Math.max(1e-3, sl[Math.floor(sl.length * 0.9)])) : 1;
  }
  for (let y = 0; y < vs; y++)
    for (let x = 0; x < vs; x++) {
      const X = vx + x, Y = vy + y, h = z(X, Y);
      let c = heightColor(h);
      if (h > 0) {
        const sx = (vex * (z(X + 1, Y) - z(X - 1, Y))) / (2 * cellM), sy = (vex * (z(X, Y + 1) - z(X, Y - 1))) / (2 * cellM), nz = 1 / Math.hypot(sx, sy, 1), s = Math.max(0.15, -sx * nz * L[0] - sy * nz * L[1] + nz * L[2]);
        c = [Math.min(255, c[0] * s * 1.3), Math.min(255, c[1] * s * 1.3), Math.min(255, c[2] * s * 1.3)];
        const a = cells ? cells(X, Y) : 0;
        if (a >= river) c = mix(c, [30, 80, 210] as RGB, Math.min(1, 0.45 + 0.2 * Math.log10(a / river)));
      }
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const o = (((vs - 1 - y) * scale + sy) * W + x * scale + sx) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
    }
  return png(W, W, rgb);
}

// The response time of a flow network, years: the longest over the land cells of the sum, down the cell's flow path to a root, of the step's length over K sqrt(A) (A the drainage area in m2,
// K in 1/yr), the time a knickpoint takes to climb the path: the island's own definition (wgsl/terrain-upstream.ts `clock`), which sets the island's step.
export function responseYears(to: ArrayLike<number>, area: ArrayLike<number>, side: number, live: Uint8Array, k: number, cellM = 75) {
  const n = side * side, t = new Float64Array(n), order = Array.from({ length: n }, (_, i) => i).filter((i) => to[i] !== i).sort((a, b) => area[b] - area[a]);
  let best = 0;
  for (const i of order) {
    const j = to[i], dx = (j % side !== i % side && Math.floor(j / side) !== Math.floor(i / side) ? Math.SQRT2 : 1) * cellM;
    t[i] = area[i] > 0 ? t[j] + dx / (k * Math.sqrt(area[i] * cellM * cellM)) : t[j];
    if (live[i] && t[i] > best) best = t[i];
  }
  return best;
}

// Statistics of a land surface that stand for how dissected it is, to be compared between runs by their size and not cell by cell (two runs of one law pick different valleys): the median, 90th and 99th
// percentile slope (rise over run between axis neighbours, 75 m apart), the share of land cells that are river (drainage area at least `minCells` cells: the drainage density), and the mean
// height range inside blocks of `block` cells (the relief at that scale), metres.
export function dissection(h: ArrayLike<number>, area: ArrayLike<number>, side: number, live: Uint8Array, minCells: number, block = 32, cellM = 75) {
  const slopes: number[] = [];
  let land = 0, river = 0;
  for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
    const k = y * side + x;
    if (!live[k]) continue;
    land++;
    if (area[k] >= minCells) river++;
    slopes.push(Math.hypot(h[k + 1] - h[k - 1], h[k + side] - h[k - side]) / 256 / (2 * cellM));
  }
  slopes.sort((a, b) => a - b);
  const q = (p: number) => +slopes[Math.floor(slopes.length * p)].toFixed(3);
  let sum = 0, n = 0;
  for (let by = 1; by + block < side - 1; by += block) for (let bx = 1; bx + block < side - 1; bx += block) {
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let y = by; y < by + block && ok; y++) for (let x = bx; x < bx + block; x++) { const k = y * side + x; if (!live[k]) { ok = false; break; } lo = Math.min(lo, h[k]); hi = Math.max(hi, h[k]); }
    if (ok) { sum += (hi - lo) / 256; n++; }
  }
  return { slope50: q(0.5), slope90: q(0.9), slope99: q(0.99), riverShare: +(river / Math.max(1, land)).toFixed(4), reliefM: n ? +(sum / n).toFixed(0) : NaN };
}

// The heights, metres, of the land cells that touch the sea (4 neighbours) at the 50th, 90th and 99th percentile: a cliff where the land's edge is lifted from the sea (a uniform lift at the shore).
export function shoreHeights(h: ArrayLike<number>, side: number, live: Uint8Array) {
  const v: number[] = [];
  for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
    const k = y * side + x;
    if (!live[k] || h[k] <= 0) continue;
    if (h[k - 1] <= 0 || h[k + 1] <= 0 || h[k - side] <= 0 || h[k + side] <= 0) v.push(h[k] / 256);
  }
  v.sort((a, b) => a - b);
  const q = (p: number) => +(v[Math.floor(v.length * p)] ?? NaN).toFixed(1);
  return { cells: v.length, p50: q(0.5), p90: q(0.9), p99: q(0.99) };
}
