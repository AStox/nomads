// The island's simulation grid, and how water finds its way downhill across it.
import { clamp } from "math";

export const N = 128; // cells per side, two per game tile
export const CELL = 75; // meters per cell
export const LEN = N * N;
// Eight neighbors, and how far each is in cells.
export const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = DX.map((x, k) => Math.hypot(x, DY[k]));

// Bilinear read of a grid at fractional cell coordinates.
export function sample(g: Float32Array, x: number, y: number) {
  x = clamp(x, 0, N - 1.001); y = clamp(y, 0, N - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * N + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + N] * (1 - fx) + g[i + N + 1] * fx) * fy;
}

// 0 below lo, 1 above hi, smooth between.
export const ramp = (v: number, lo: number, hi: number) => { const t = clamp((v - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

// A few box blurs of radius r make a cheap Gaussian; edges repeat.
export function blur(g: Float32Array, r: number, passes = 3) {
  let src = Float32Array.from(g), dst = new Float32Array(LEN);
  const at = (k: number) => clamp(k, 0, N - 1), w = 2 * r + 1;
  for (let p = 0; p < passes * 2; p++) {
    const across = p % 2 === 0, step = across ? 1 : N;
    for (let line = 0; line < N; line++) {
      const base = across ? line * N : line;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + at(k) * step];
      for (let k = 0; k < N; k++) {
        dst[base + k * step] = sum / w;
        sum += src[base + at(k + r + 1) * step] - src[base + at(k - r) * step];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// A binary min-heap of cell indices keyed by height, for flooding.
class Heap {
  items = new Int32Array(LEN);
  keys = new Float64Array(LEN);
  size = 0;
  push(item: number, key: number) {
    let j = this.size++;
    while (j > 0) {
      const p = (j - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.items[j] = this.items[p]; this.keys[j] = this.keys[p]; j = p;
    }
    this.items[j] = item; this.keys[j] = key;
  }
  pop() {
    const top = this.items[0], item = this.items[--this.size], key = this.keys[this.size];
    let j = 0;
    for (;;) {
      let c = 2 * j + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.items[j] = this.items[c]; this.keys[j] = this.keys[c]; j = c;
    }
    this.items[j] = item; this.keys[j] = key;
    return top;
  }
}

// Priority-flood from the map edge (Barnes et al. 2014): raise every pit to its spill height plus a hair, so all water
// finds the sea. `order` lists cells lowest-filled first, so a cell always comes after the cell it drains into.
export function flood(h: Float32Array, eps: number) {
  const filled = new Float32Array(LEN), order = new Int32Array(LEN), seen = new Uint8Array(LEN), heap = new Heap();
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) { seen[i] = 1; filled[i] = h[i]; heap.push(i, h[i]); }
  }
  let k = 0;
  while (heap.size) {
    const i = heap.pop(), x = i % N, y = (i - x) / N;
    order[k++] = i;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      filled[j] = Math.max(h[j], filled[i] + eps);
      heap.push(j, filled[j]);
    }
  }
  return { filled, order };
}

// Steepest descent on the filled surface. The sea (filled below the waterline) is where rivers end.
export function receivers(filled: Float32Array, sea: number) {
  const to = new Int32Array(LEN), far = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    to[i] = i; far[i] = 1;
    if (filled[i] < sea) continue;
    const x = i % N, y = (i - x) / N;
    let best = 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
      const j = ny * N + nx, s = (filled[i] - filled[j]) / DIST[d];
      if (s > best) { best = s; to[i] = j; far[i] = DIST[d]; }
    }
  }
  return { to, far };
}

// Water gathered from every cell upstream, highest first. weight is each cell's own contribution.
export function accumulate(order: Int32Array, to: Int32Array, weight?: Float32Array) {
  const a = new Float32Array(LEN);
  for (let k = LEN - 1; k >= 0; k--) {
    const i = order[k];
    a[i] += weight ? weight[i] : 1;
    if (to[i] !== i) a[to[i]] += a[i];
  }
  return a;
}

// Meters to the nearest marked cell (two-pass chamfer).
export function distance(mark: Uint8Array) {
  const d = new Float32Array(LEN).fill(1e9);
  for (let i = 0; i < LEN; i++) if (mark[i]) d[i] = 0;
  const pass = (from: number, to: number, step: number, dirs: number[]) => {
    for (let i = from; i !== to; i += step) {
      const x = i % N, y = (i - x) / N;
      for (const k of dirs) {
        const nx = x + DX[k], ny = y + DY[k];
        if (nx >= 0 && ny >= 0 && nx < N && ny < N) d[i] = Math.min(d[i], d[ny * N + nx] + DIST[k] * CELL);
      }
    }
  };
  pass(0, LEN, 1, [4, 5, 6, 7]);
  pass(LEN - 1, -1, -1, [0, 1, 2, 3]);
  return d;
}
