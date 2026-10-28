// River gates on a region's heights, from a CPU flow of our own (so a synthetic river can be checked and a region measured without the GPU harness).
//
// Flow. Receivers by steepest descent of eight neighbours (D8, drop over distance, diagonals sqrt 2) on the surface with its depressions filled by Priority-Flood (Barnes, Lehman and Mulla
// 2014, Computers and Geosciences 62, 117-127); water leaves at sea level (cells at or below 0) and at the region's edge. A cell in a filled depression or on a flat drains to the neighbour
// that flooded it (the discovery parent), a cell with a lower unfilled neighbour to the steepest one; both never loop (see the proof sketch in `flow`). Drainage area is the count of cells
// upstream including the cell (a uniform rain); metres squared = count * cellM^2.
//
// River cell. Drainage area at least A_c = 3.3e4 m^2: the upper end of the measured first-order channel-head areas, 1e3 to 3.3e4 m^2 (Jefferson et al. 2013, Earth Surf. Process. Landforms,
// North Carolina Piedmont, mean 7.8e3; Roering, Kirchner and Dietrich 2001, Am. J. Sci. 301, 456-, an attractor of one to several thousand m^2; the channel head is where A S^a exceeds a
// threshold, Montgomery and Dietrich 1992, Science 255, 826-830). Every measured area is below one 75 m cell (5,625 m^2) to a few cells, so the top of the range is used: 6 cells at 75 m.
//
// Stems. The river cells split into stems: a stem starts at a head (a river cell no river cell drains into) and follows the larger-area upstream neighbour's chain downstream until its
// receiver belongs to a larger stem; each river cell is in exactly one stem, the largest river's stem runs to the coast or the edge. A straight run is a maximal piece of a stem, taken
// greedily from its upstream end, all of whose cell centres lie within tol = 1.5 cells of the chord between its ends (a D8 line at any angle stays within one cell of its chord, so a
// lattice-locked line counts as straight; a natural reach does not for 30 cells and cannot for 300). `straightShare(L)` = share of river cells (in the live area) in runs of at least L cells.
// A lattice-straight stretch is such a run of 300 cells or more whose chord lies within 8 degrees of a lattice direction (multiples of 45 degrees).
//
// Sinuosity (channel length over the straight distance between the ends of the reach, Leopold and Wolman 1957, USGS Prof. Paper 282-B: under 1.05 straight, 1.05 to 1.25 sinuous, over
// 1.25 meandering; classes as quoted by Washington DNR guides). The largest river: from the live land cell of largest drainage area, up the larger-area neighbour chain to the head. The
// centreline is the moving average (9 cells) of the cell centres so the D8 staircase does not add length (a straight line at 26.6 degrees would read 1.08 unsmoothed); `reach` classes use
// consecutive reaches of 200 cells.

export interface Flow { to: Int32Array; acc: Int32Array }

class Heap {
  key: Float64Array; val: Int32Array; n = 0;
  constructor(cap: number) { this.key = new Float64Array(cap); this.val = new Int32Array(cap); }
  push(k: number, v: number) {
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.key[p] <= k) break; this.key[i] = this.key[p]; this.val[i] = this.val[p]; i = p; }
    this.key[i] = k; this.val[i] = v;
  }
  pop(): number {
    const top = this.val[0], k = this.key[--this.n], v = this.val[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= k) break;
      this.key[i] = this.key[c]; this.val[i] = this.val[c]; i = c;
    }
    this.key[i] = k; this.val[i] = v;
    return top;
  }
}

const DX8 = [1, 0, -1, 0, 1, -1, -1, 1], DY8 = [0, 1, 0, -1, 1, 1, -1, -1];

// h: heights (any unit), row-major side x side; cells with h <= 0 are sea. The priority key is (level, discovery order) so equal levels pop in the order they were found (a stable queue).
export function flow(h: ArrayLike<number>, side: number): Flow {
  const n = side * side, lvl = new Float64Array(n), parent = new Int32Array(n).fill(-1), done = new Uint8Array(n), heap = new Heap(n);
  const push = (k: number, l: number) => { lvl[k] = l; heap.push(l, k); };
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const k = y * side + x;
    if (h[k] <= 0 || x === 0 || y === 0 || x === side - 1 || y === side - 1) { done[k] = 1; parent[k] = k; push(k, h[k]); }
  }
  const filled = new Uint8Array(n);
  while (heap.n) {
    const c = heap.pop(), cx = c % side, cy = (c / side) | 0;
    for (let d = 0; d < 8; d++) {
      const x = cx + DX8[d], y = cy + DY8[d];
      if (x < 0 || y < 0 || x >= side || y >= side) continue;
      const k = y * side + x;
      if (done[k]) continue;
      done[k] = 1; parent[k] = c;
      const l = Math.max(h[k], lvl[c]);
      if (l > h[k]) filled[k] = 1;
      push(k, l);
    }
  }
  // receivers: steepest unfilled lower neighbour (which is itself unfilled), else the discovery parent
  const to = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    if (parent[k] === k) { to[k] = k; continue; }
    const cx = k % side, cy = (k / side) | 0;
    let best = -1, bs = 0;
    if (!filled[k]) for (let d = 0; d < 8; d++) {
      const x = cx + DX8[d], y = cy + DY8[d];
      if (x < 0 || y < 0 || x >= side || y >= side) continue;
      const j = y * side + x;
      if (filled[j] || h[j] >= h[k]) continue;
      const s = (h[k] - h[j]) / (d < 4 ? 1 : Math.SQRT2);
      if (s > bs) { bs = s; best = j; }
    }
    to[k] = best >= 0 ? best : parent[k];
  }
  // area: cells up the receiver tree, leaves first
  const acc = new Int32Array(n).fill(1), indeg = new Int32Array(n), queue = new Int32Array(n);
  for (let k = 0; k < n; k++) if (to[k] !== k) indeg[to[k]]++;
  let qh = 0, qt = 0;
  for (let k = 0; k < n; k++) if (!indeg[k]) queue[qt++] = k;
  while (qh < qt) { const k = queue[qh++], j = to[k]; if (j === k) continue; acc[j] += acc[k]; if (--indeg[j] === 0) queue[qt++] = j; }
  return { to, acc };
}

export interface Pt { x: number; y: number }

// Greedy partition of a polyline into runs within `tol` of their chords: [start, end] index pairs (end inclusive; the next run starts at end + 1, so cells are counted once).
export function straightRuns(p: Pt[], tol = 1.5): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < p.length) {
    let j = i;
    for (let e = i + 1; e < p.length; e++) {
      const dx = p[e].x - p[i].x, dy = p[e].y - p[i].y, L = Math.hypot(dx, dy);
      let ok = true;
      for (let m = i + 1; m < e && ok; m++) ok = Math.abs((p[m].x - p[i].x) * dy - (p[m].y - p[i].y) * dx) / L <= tol;
      if (!ok) break;
      j = e;
    }
    out.push([i, j]);
    i = j + 1;
  }
  return out;
}

const smooth = (p: Pt[], w = 9) => p.map((_, i) => {
  const a = Math.max(0, i - (w >> 1)), b = Math.min(p.length - 1, i + (w >> 1)), m = Math.min(i - a, b - i), lo = i - m, hi = i + m;
  let sx = 0, sy = 0;
  for (let k = lo; k <= hi; k++) { sx += p[k].x; sy += p[k].y; }
  return { x: sx / (hi - lo + 1), y: sy / (hi - lo + 1) };
});
const length = (p: Pt[]) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return s; };
export const sinuosityClass = (s: number) => (s < 1.05 ? "straight" : s <= 1.25 ? "sinuous" : "meandering");

// Channel length over end-to-end distance of a centreline (smoothed by `w` cells; the end cells keep a shrinking window so the ends stay put).
export function sinuosity(path: Pt[], w = 9): number {
  const s = smooth(path, w);
  return length(s) / Math.hypot(s[s.length - 1].x - s[0].x, s[s.length - 1].y - s[0].y);
}

export interface RiverMeasures {
  riverCells: number; minCells: number;
  straight30: number; straight300: number; latticeStraight300: number; longestRunCells: number;
  stem: { lengthCells: number; lengthKm: number; sinuosity: number; class: string; reachMedian: number; reachClass: string; reaches: number; outlet: [number, number]; head: [number, number] } | null;
}

// The measures over the cells where `live` is set (a margin in from the region's edge); `cellM` the cell's width; minCells the river threshold in cells.
export function riverMeasures(h: ArrayLike<number>, side: number, live: Uint8Array, cellM: number, fl = flow(h, side), channelHeadM2 = 3.3e4): RiverMeasures {
  const { to, acc } = fl, n = side * side, minCells = Math.max(2, Math.ceil(channelHeadM2 / (cellM * cellM)));
  const river = (k: number) => h[k] > 0 && acc[k] >= minCells;
  const main = new Int32Array(n).fill(-1);
  for (let k = 0; k < n; k++) {
    if (!river(k) || to[k] === k) continue;
    const j = to[k];
    if (main[j] < 0 || acc[k] > acc[main[j]] || (acc[k] === acc[main[j]] && k < main[j])) main[j] = k;
  }
  let riverCells = 0, lattice = 0, longest = 0, in30 = 0, in300 = 0;
  for (let k = 0; k < n; k++) {
    if (!river(k) || main[k] >= 0) continue;
    // a head: walk down while the receiver's larger-area neighbour is this chain
    const path: number[] = [k];
    let cur = k;
    for (;;) { const nx = to[cur]; if (nx === cur || !river(nx) || main[nx] !== cur) break; path.push(nx); cur = nx; }
    const pts = path.map((c) => ({ x: c % side, y: (c / side) | 0 }));
    for (const [a, b] of straightRuns(pts)) {
      const len = b - a + 1;
      let inLive = 0;
      for (let m = a; m <= b; m++) if (live[path[m]]) inLive++;
      if (len >= 30) in30 += inLive;
      if (len >= 300 && inLive * 2 >= len) {
        in300 += inLive;
        const ang = (Math.atan2(pts[b].y - pts[a].y, pts[b].x - pts[a].x) * 180) / Math.PI, off = Math.abs(((ang % 45) + 45) % 45);
        if (Math.min(off, 45 - off) <= 8) lattice++;
      }
      longest = Math.max(longest, len);
    }
    for (const c of path) if (live[c]) riverCells++;
  }
  // the largest river's stem, outlet to head
  let top = -1;
  for (let k = 0; k < n; k++) if (live[k] && river(k) && (top < 0 || acc[k] > acc[top])) top = k;
  let stem: RiverMeasures["stem"] = null;
  if (top >= 0) {
    const path: Pt[] = [];
    for (let c = top; c >= 0; c = main[c]) path.push({ x: c % side, y: (c / side) | 0 });
    path.reverse();
    if (path.length >= 20) {
      const s = sinuosity(path), sm = smooth(path), reaches: number[] = [];
      for (let i = 0; i + 200 <= sm.length; i += 200) reaches.push(length(sm.slice(i, i + 200)) / Math.hypot(sm[i + 199].x - sm[i].x, sm[i + 199].y - sm[i].y));
      reaches.sort((a, b) => a - b);
      const med = reaches.length ? reaches[reaches.length >> 1] : NaN;
      stem = { lengthCells: path.length, lengthKm: +((length(sm) * cellM) / 1000).toFixed(1), sinuosity: +s.toFixed(3), class: sinuosityClass(s), reachMedian: +med.toFixed(3), reachClass: Number.isNaN(med) ? "n/a" : sinuosityClass(med), reaches: reaches.length, outlet: [top % side, (top / side) | 0], head: [path[0].x, path[0].y] };
    }
  }
  return { riverCells, minCells, straight30: +(in30 / Math.max(1, riverCells)).toFixed(4), straight300: +(in300 / Math.max(1, riverCells)).toFixed(4), latticeStraight300: lattice, longestRunCells: longest, stem };
}
