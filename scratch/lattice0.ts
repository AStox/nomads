// Lattice-alignment metric of a tier-0 height field (flat (face*256+Y)*256+X, metres).
//   edge shares   share of the contour's 4-neighbour edges lying in a straight run of >= 6, 10, 16 collinear edges on ONE lattice line (a run does not cross a face edge);
//                 contours: coast (land h>0 against sea h<=0), the -100 m and the -1000 m depth lines (shallower against deeper; land counts as shallower).
//   ridge share   share of land cells that are one-cell-wide ridge cells in runs of 4 or more: higher than both neighbours across one axis by over 10 m while the other axis' two
//                 neighbours are within 30 m, the run taken along the other axis.
// Usage: bun scratch/lattice0.ts [name=path ...]   (path: a .f32 height file, "chain:<dir>" for a bake store's chain.bin, "ctl:smooth" / "ctl:rough" for the great-circle controls)
import { readFileSync } from "node:fs";
import { FACES, cellId, tierGrid, type Grid } from "../src/gpu/globe/grid";
import { neighbours, cellVectors } from "../src/gpu/globe/tectonics";
import { unpackRecord } from "../src/gpu/globe/window";

const fn = 256, g: Grid = tierGrid(0);
const nb = neighbours(g), N = FACES * fn * fn;
// Sides in nb order: 0 +X, 1 +Y, 2 -X, 3 -Y.

export function f32(path: string): Float32Array { const b = readFileSync(path); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
export function chainHeight(dir: string): Float32Array { return unpackRecord(new Uint8Array(readFileSync(dir + "/chain.bin"))).arrays.height as Float32Array; }

// Edges of the contour "below(a) != below(b)" between 4-neighbours; each edge once (sides +X and +Y only).
// A vertical edge between (X,Y) and (X+1,Y) continues along Y; a horizontal one between (X,Y) and (X,Y+1) along X; within a face only.
export const edgeRuns = (h: Float32Array, sep: (v: number) => boolean, Ls = [6, 10, 16]) => edgeRunsBy(h, (a, b) => sep(a) !== sep(b), Ls);
// `differs(a, b)`: whether two 4-neighbouring cells' values are on different sides of the contour (a plate field works as well as a height).
export function edgeRunsBy(h: ArrayLike<number>, differs: (a: number, b: number) => boolean, Ls = [6, 10, 16]) {
  let total = 0; const inRun = Ls.map(() => 0);
  const ev = new Uint8Array(N), eh = new Uint8Array(N); // edge to +X, to +Y of the cell, same face only
  let cross = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const c = cellId(g, f, X, Y);
    for (const d of [0, 1]) {
      const o = nb[4 * c + d], same = d === 0 ? X < fn - 1 : Y < fn - 1;
      if (!differs(h[c], h[o])) continue;
      total++;
      if (!same) { cross++; continue; }
      (d === 0 ? ev : eh)[c] = 1;
    }
  }
  // Runs along Y for ev (stride fn in flat), along X for eh (stride 1).
  const walk = (e: Uint8Array, stride: number, len: number, lineStep: number, nLines: number, lineOf: (f: number, l: number) => number) => {
    for (let f = 0; f < FACES; f++) for (let l = 0; l < nLines; l++) {
      let run = 0; const base = lineOf(f, l);
      const flush = () => { if (run) for (let k = 0; k < Ls.length; k++) if (run >= Ls[k]) inRun[k] += run; run = 0; };
      for (let p = 0; p < len; p++) { if (e[base + p * stride]) run++; else flush(); }
      flush();
    }
  };
  walk(ev, fn, fn, 1, fn, (f, X) => f * fn * fn + X);
  walk(eh, 1, fn, fn, fn, (f, Y) => f * fn * fn + Y * fn);
  return { total, cross, shares: inRun.map((v) => v / total) };
}

export function ridgeShare(h: Float32Array, hi = 10, flat = 30, minRun = 4) {
  // ridge across X (higher than both X neighbours), line runs along Y; and across Y, runs along X.
  const rx = new Uint8Array(N), ry = new Uint8Array(N); let land = 0;
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
    const c = cellId(g, f, X, Y), v = h[c]; if (!(v > 0)) continue; land++;
    const e = h[nb[4 * c]], n = h[nb[4 * c + 1]], w = h[nb[4 * c + 2]], s = h[nb[4 * c + 3]];
    if (v - e > hi && v - w > hi && Math.abs(v - n) <= flat && Math.abs(v - s) <= flat) rx[c] = 1;
    if (v - n > hi && v - s > hi && Math.abs(v - e) <= flat && Math.abs(v - w) <= flat) ry[c] = 1;
  }
  let cells = 0;
  const walk = (e: Uint8Array, stride: number, lineOf: (f: number, l: number) => number, lstride: number) => {
    for (let f = 0; f < FACES; f++) for (let l = 0; l < fn; l++) {
      let run = 0; const base = lineOf(f, l);
      const flush = () => { if (run >= minRun) cells += run; run = 0; };
      for (let p = 0; p < fn; p++) { if (e[base + p * stride]) run++; else flush(); }
      flush();
    }
  };
  walk(rx, fn, (f, X) => f * fn * fn + X, 1); // ridge across X: cells vary along Y
  walk(ry, 1, (f, Y) => f * fn * fn + Y * fn, fn);
  let any = 0; for (let i = 0; i < N; i++) if (rx[i] || ry[i]) any++;
  return { land, ridgeCells: any, share: cells / land };
}

// Isotropic controls: a field on the sphere built from random plane waves in 3-space (no preferred direction); a coast and depth contours of a continent-sized blob field.
export function control(rough: boolean): Float32Array {
  const v = cellVectors(g), out = new Float32Array(N);
  let s = 12345; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const waves: { k: number[]; ph: number; a: number }[] = [];
  // wavelength in cells at the equator of a face ~ 2*pi/(256*... ) : a face spans pi/2 rad over 256 cells; a continent 30 to 60 cells is 0.2 to 0.4 rad
  const bands = rough ? [[3, 1], [6, 0.7], [12, 0.5], [24, 0.35], [48, 0.25]] : [[3, 1], [6, 0.7], [10, 0.4]];
  for (const [k0, a] of bands) for (let i = 0; i < 40; i++) {
    let x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd() * 2 - 1; const r = Math.hypot(x, y, z) || 1;
    const k = k0 * (0.8 + 0.4 * rnd());
    waves.push({ k: [x / r * k, y / r * k, z / r * k], ph: rnd() * 2 * Math.PI, a: a / Math.sqrt(40) });
  }
  const raw = new Float64Array(N);
  for (let i = 0; i < N; i++) { let t = 0; for (const w of waves) t += w.a * Math.cos(w.k[0] * v[3 * i] + w.k[1] * v[3 * i + 1] + w.k[2] * v[3 * i + 2] + w.ph); raw[i] = t; }
  // threshold at 70th percentile; map so that 1 sigma of raw = 2500 m (ocean depths reach 1000 m within a few cells of a shallow shelf like margin)
  const sorted = Float64Array.from(raw).sort(); const q = sorted[Math.floor(0.7 * N)], sd = Math.sqrt(raw.reduce((a, b) => a + (b - q) ** 2, 0) / N);
  for (let i = 0; i < N; i++) out[i] = ((raw[i] - q) / sd) * 2500;
  return out;
}

function row(name: string, h: Float32Array) {
  const coast = edgeRuns(h, (v) => v > 0), d100 = edgeRuns(h, (v) => v > -100), d1000 = edgeRuns(h, (v) => v > -1000), rg = ridgeShare(h);
  let land = 0; for (let i = 0; i < N; i++) if (h[i] > 0) land++;
  const p = (a: number[]) => a.map((x) => x.toFixed(3)).join("/");
  console.log(`${name.padEnd(14)} land ${(land / N).toFixed(3)} coastEdges ${String(coast.total).padStart(6)} | coast6/10/16 ${p(coast.shares)} | d100 ${p(d100.shares)} (${d100.total}) | d1000 ${p(d1000.shares)} (${d1000.total}) | ridge4+ ${rg.share.toFixed(4)} (${rg.ridgeCells} ridge cells)`);
}
export { row };

if (import.meta.main) {
  const H = process.env.HOME!;
  const specs = process.argv.slice(2).length ? process.argv.slice(2) : [`new=${H}/.cache/nomads-scratch/t7/raw/height.f32`, `old=chain:${H}/.cache/nomads-bakes/small/store/1-1121d207f3b8`, "ctl-smooth=ctl:smooth", "ctl-rough=ctl:rough"];
  for (const sp of specs) {
    const [name, p] = sp.split("=");
    const h = p === "ctl:smooth" ? control(false) : p === "ctl:rough" ? control(true) : p.startsWith("chain:") ? chainHeight(p.slice(6)) : f32(p);
    row(name, h);
  }
}
