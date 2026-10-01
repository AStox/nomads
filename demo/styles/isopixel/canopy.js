// The trees' crowns on the ground, as the GPU's ambient occlusion reads them (gpu.js uCan). Cover is kept in cells of STEP
// meters over the island: every tree lays the disc its crown covers, full in the middle and fading out at the rim, and
// the cells add them up, so a point under one crown reads about 1 and one deep in a forest more. A felled, grown or
// planted tree takes its disc off and puts it back at its new size, so the cover follows the sim. Only the cells a change
// touched go up to the GPU.
import { SIZE, TILES } from "../island.js";

// Cells of STEP meters from the island's north-west corner, ORIGIN: 3 m, or coarser on an island too big for 3 m cells
// to stay under about 4800 a side.
export const STEP = Math.max(3, SIZE / 4800), ORIGIN = -SIZE / 2, N = Math.ceil(SIZE / STEP) + 1;

// A crown's radius as a share of its tree's height, by species: the width sprites.js draws it at (oak 0.8 of its height,
// ash 0.68, the rest 0.5, a pine's cone 0.42) over its height's 0.866 of a meter across, halved.
const CROWN = { oak: 0.35, ash: 0.29, pine: 0.18 }, CROWN_ELSE = 0.22;
const crownOf = (name) => CROWN[name] ?? CROWN_ELSE;
// weight by distance as a share of the crown's radius: all of it within CORE, none from EDGE out
const CORE = 0.55, EDGE = 1.2;
// one crown of cover as the cells hold it; the byte the GPU reads is twice the count, so it tops out at two crowns deep
const UNIT = 64;
const PROFILE = Uint8Array.from({ length: 256 }, (_, i) => {
  const r = Math.sqrt(i / 255) * EDGE, t = Math.min(1, Math.max(0, (r - CORE) / (EDGE - CORE)));
  return Math.round(UNIT * (r <= CORE ? 1 : 1 - t * t * (3 - 2 * t)));
});

export class Canopy {
  constructor(toM) {
    this.acc = new Uint16Array(N * N);
    this.toM = toM;
    this.box = null;
    this.tall = null;
  }
  // The cover of every tree the bins hold (ObjBins: the sim's objects) and, in `tall`, the trees' mean height over the
  // cells of the GPU's heights, grid { n, step }. The trees go in a few milliseconds at a time, so a frame never waits.
  static async build(bins, toM, grid, sliceMs = 8) {
    const c = new Canopy(toM), { n, step } = grid, tree = bins.kinds.indexOf("tree");
    const sumW = new Float32Array(n * n), sumH = new Float32Array(n * n);
    for (let ty = 0, t = performance.now(); ty < TILES; ty++) {
      bins.each(0, ty, TILES - 1, ty, (ki, si, px, py, size) => {
        if (ki !== tree) return;
        const x = toM(px), z = toM(py);
        c.splat(x, z, size, crownOf(bins.species[si]), 1);
        const gi = Math.min(n - 1, Math.max(0, Math.round((x - ORIGIN) / step))), gj = Math.min(n - 1, Math.max(0, Math.round((z - ORIGIN) / step)));
        sumW[gj * n + gi]++; sumH[gj * n + gi] += size;
      });
      if (performance.now() - t > sliceMs) { await new Promise((r) => setTimeout(r, 0)); t = performance.now(); }
    }
    // a cell holds a tree or two or none, so the mean height is taken over a few cells round it
    const w = boxSum(sumW, n, 3), h = boxSum(sumH, n, 3);
    c.tall = Float32Array.from(w, (v, k) => (v >= 0.5 ? h[k] / v : 0));
    return c;
  }
  // a crown of radius share `crown` of a tree `size` m tall at (x, z) on (sign 1) or off (-1) the cover; the block of cells
  // it touched is noted for flush()
  splat(x, z, size, crown, sign) {
    const cx = (x - ORIGIN) / STEP, cz = (z - ORIGIN) / STEP, r = (crown * size * EDGE) / STEP, r2 = r * r;
    const i0 = Math.max(0, Math.ceil(cx - r)), i1 = Math.min(N - 1, Math.floor(cx + r)), j0 = Math.max(0, Math.ceil(cz - r)), j1 = Math.min(N - 1, Math.floor(cz + r));
    if (i0 > i1 || j0 > j1) return;
    const k = 255 / r2, acc = this.acc;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const d2 = (i - cx) * (i - cx) + (j - cz) * (j - cz);
        if (d2 < r2) acc[j * N + i] += sign * PROFILE[(d2 * k) | 0];
      }
    const b = this.box;
    if (!b) return;
    b[0] = Math.min(b[0], i0); b[1] = Math.min(b[1], j0); b[2] = Math.max(b[2], i1); b[3] = Math.max(b[3], j1);
  }
  // An object record (ObjBins') changed from `old` to `now`, either null; kinds and species are the bins' name tables.
  // Only trees count.
  change(old, now, kinds, species) {
    if (old && kinds[old.kind] === "tree") this.mark(old, species, -1);
    if (now && kinds[now.kind] === "tree") this.mark(now, species, 1);
  }
  mark(r, species, sign) {
    this.box ??= [N, N, -1, -1];
    this.splat(this.toM(r.px), this.toM(r.py), r.size, crownOf(species[r.sp]), sign);
  }
  // all the cover as bytes, 0..255 for none to two crowns deep
  bytes() {
    const out = new Uint8Array(N * N), acc = this.acc;
    for (let k = 0; k < out.length; k++) out[k] = Math.min(255, acc[k] << 1);
    return out;
  }
  // the block { x, y, w, h, bytes } of cells changed since the last call, null if none
  flush() {
    const b = this.box;
    if (!b || b[2] < 0) return null;
    this.box = null;
    const x = b[0], y = b[1], w = b[2] - x + 1, h = b[3] - y + 1, out = new Uint8Array(w * h), acc = this.acc;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out[j * w + i] = Math.min(255, acc[(y + j) * N + x + i] << 1);
    return { x, y, w, h, bytes: out };
  }
}

// each cell of an n x n grid summed with the cells within r of it, in two passes
function boxSum(src, n, r) {
  const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < Math.min(n, r); i++) s += src[j * n + i];
    for (let i = 0; i < n; i++) {
      if (i + r < n) s += src[j * n + i + r];
      if (i - r - 1 >= 0) s -= src[j * n + i - r - 1];
      tmp[j * n + i] = s;
    }
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < Math.min(n, r); j++) s += tmp[j * n + i];
    for (let j = 0; j < n; j++) {
      if (j + r < n) s += tmp[(j + r) * n + i];
      if (j - r - 1 >= 0) s -= tmp[(j - r - 1) * n + i];
      out[j * n + i] = s;
    }
  }
  return out;
}
