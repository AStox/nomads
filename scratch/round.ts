// lake outline roundness P^2 / (4 pi A) (1 = disc; square 1.273) and bounding-box fill (disc .785, square 1), on the six place windows (1024 cells, margin 64)
// lake = floodLakes(h) for every source (same rule), plus the water stage's own flooded file for old and rejected planets; perimeter by marching squares at edge midpoints
import { readWin } from "./places";
import { floodLakes } from "../scripts/gates/straight";
const H = process.env.HOME + "/.cache/", T = H + "nomads-scratch/";
const R: [string, number, number, number][] = [["river", 1, 14, 10], ["spit", 4, 24, 20], ["K3", 1, 6, 6], ["B", 1, 1, 6], ["lake", 1, 14, 18], ["shelf", 4, 24, 20], ["home", 4, 26, 25]];
const NAMES: Record<string, string> = { river: "rR", spit: "rA", shelf: "rA", K3: "rK", B: "rB", lake: "rL", home: "rH" };
const RS = 1024, M = 64, W = RS - 2 * M;
export function perimeter(mask: Uint8Array, id: Int32Array | number[], side: number): number {
  const set = new Set<number>(id as number[]), at = (x: number, y: number) => (x >= 0 && y >= 0 && x < side && y < side && set.has(y * side + x) ? 1 : 0);
  let per = 0; const seen = new Set<number>();
  for (const k of id as number[]) { const x = k % side, y = (k / side) | 0;
    for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) { const bx = x + dx, by = y + dy, key = (by + 1) * (side + 2) + bx + 1; if (seen.has(key)) continue; seen.add(key);
      const a = at(bx, by), b = at(bx + 1, by), c = at(bx, by + 1), d = at(bx + 1, by + 1), s = a + b + c + d;
      if (s === 0 || s === 4) continue;
      if (s === 1 || s === 3) per += Math.SQRT1_2; else if (s === 2) per += (a === d) ? 2 * Math.SQRT1_2 : 1; } }
  return per;
}
function lakesOf(h: Int32Array, lake: Uint8Array, min: number) {
  const side = W, seen = new Uint8Array(side * side), out: { a: number; r: number; fb: number }[] = [];
  for (let s = 0; s < side * side; s++) { if (!lake[s] || seen[s]) continue;
    const ids: number[] = [s]; seen[s] = 1; let touches = false, x0 = side, x1 = 0, y0 = side, y1 = 0;
    for (let q = 0; q < ids.length; q++) { const c = ids[q], x = c % side, y = (c / side) | 0; if (x === 0 || y === 0 || x === side - 1 || y === side - 1) touches = true; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= side || Y >= side) continue; const j = Y * side + X; if (lake[j] && !seen[j]) { seen[j] = 1; ids.push(j); } } }
    if (touches || ids.length < min) continue;
    const P = perimeter(lake, ids, side), A = ids.length; out.push({ a: A, r: (P * P) / (4 * Math.PI * A), fb: A / ((x1 - x0 + 1) * (y1 - y0 + 1)) }); }
  return out;
}
const q = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const crop = (full: Int32Array) => { const o = new Int32Array(W * W); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) o[y * W + x] = full[(y + M) * RS + x + M]; return o; };
const MIN = Number(process.env.MINCELLS ?? 64);
export function stats(label: string, L: { a: number; r: number; fb: number }[]) {
  const tot = L.reduce((s, l) => s + l.a, 0), aw = (f: (l: any) => number) => L.reduce((s, l) => s + f(l) * l.a, 0) / Math.max(1, tot);
  return `${label.padEnd(16)} n ${String(L.length).padStart(3)} area ${String(tot).padStart(7)}  roundness median ${q(L.map((l) => l.r), 0.5).toFixed(3)} p90 ${q(L.map((l) => l.r), 0.9).toFixed(3)} area-weighted ${aw((l) => l.r).toFixed(3)}  boxfill median ${q(L.map((l) => l.fb), 0.5).toFixed(3)} area-w ${aw((l) => l.fb).toFixed(3)}`;
}
if (import.meta.main) {
  const all: Record<string, { a: number; r: number; fb: number }[]> = {};
  for (const [name, face, tx, ty] of R) {
    const src: [string, Int32Array, Int32Array | null][] = [];
    const x0 = tx * 256, y0 = ty * 256;
    src.push(["old", readWin(T + "t4/old/t5-height.i32", 8192, face, x0, y0, RS), readWin(T + "t4/old/t5-flooded.i32", 8192, face, x0, y0, RS)]);
    src.push(["rejected", readWin(H + "nomads-bakes-next/1-6f5e2898ad43/t5-height.i32", 8192, face, x0, y0, RS), readWin(H + "nomads-bakes-next/1-6f5e2898ad43/t5-flooded.i32", 8192, face, x0, y0, RS)]);
    for (const v of ["A", "A2", "B"]) src.push([v, readWin(T + `t5/bake${v}/land/${NAMES[name]}/state.i32`, RS, 0, 0, 0, RS), null]);
    console.log("---", name);
    for (const [lab, full, fl] of src) {
      const h = crop(full), lk = floodLakes(h, W), L = lakesOf(h, lk, MIN);
      (all[lab] ??= []).push(...L);
      console.log(stats(lab + " flood", L));
      if (fl) { const f = crop(fl), lf = new Uint8Array(W * W); for (let k = 0; k < lf.length; k++) lf[k] = h[k] > 0 && f[k] > h[k] ? 1 : 0; const L2 = lakesOf(h, lf, MIN); (all[lab + "F"] ??= []).push(...L2); console.log(stats(lab + " file", L2)); }
    }
  }
  console.log("=== pooled over the windows (min " + MIN + " cells)"); for (const [k, L] of Object.entries(all)) console.log(stats(k, L));
}
