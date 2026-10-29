// hollows as the water stage defines them (water.ts basinOf): components (4-neighbour) of the cells the priority flood raised by at least 1 cm (HOLLOW_MIN, 3 units); a lake only where the deepest point is over
// WATER_TABLE (3 m = 768 units). Shares of land, shapes (roundness P^2/4piA, box fill), puddles by depth, for the old and rejected planets (their own files) and the region states
import { at, readWin } from "./places";
import { perimeter } from "./round";
const H = process.env.HOME + "/.cache/", T5 = H + "nomads-scratch/t5/", W = 640;
class Heap {
  k: number[] = []; v: number[] = [];
  push(a: number, b: number) { let i = this.k.length; this.k.push(a); this.v.push(b); while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= a) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; } this.k[i] = a; this.v[i] = b; }
  pop(): [number, number] { const rk = this.k[0], rv = this.v[0], lk = this.k.pop()!, lv = this.v.pop()!; const m = this.k.length; if (m) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= m) break; if (c + 1 < m && this.k[c + 1] < this.k[c]) c++; if (this.k[c] >= lk) break; this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c; } this.k[i] = lk; this.v[i] = lv; } return [rk, rv]; }
  get n() { return this.k.length; }
}
function flood(h: Int32Array): Int32Array {
  const lvl = new Int32Array(W * W), done = new Uint8Array(W * W), hp = new Heap();
  for (let i = 0; i < W * W; i++) { const x = i % W, y = (i / W) | 0; if (h[i] <= 0 || x === 0 || y === 0 || x === W - 1 || y === W - 1) { done[i] = 1; lvl[i] = h[i]; hp.push(h[i], i); } }
  while (hp.n) {
    const [l, c] = hp.pop(), cx = c % W, cy = (c / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const X = cx + dx, Y = cy + dy;
      if (X < 0 || Y < 0 || X >= W || Y >= W) continue;
      const j = Y * W + X;
      if (done[j]) continue;
      done[j] = 1; lvl[j] = Math.max(h[j], l); hp.push(lvl[j], j);
    }
  }
  return lvl;
}
export interface Stat { land: number; hollowCells: number; hollows: number; lakes: number; lakeCells: number; rs: number[]; fb: number[]; puddles: number; shallow: number }
export function hollowStats(h: Int32Array): Stat {
  const lvl = flood(h), hol = new Uint8Array(W * W), seen = new Uint8Array(W * W);
  let land = 0;
  for (let i = 0; i < W * W; i++) { if (h[i] > 0) land++; if (lvl[i] - h[i] >= 3) hol[i] = 1; }
  const st: Stat = { land, hollowCells: 0, hollows: 0, lakes: 0, lakeCells: 0, rs: [], fb: [], puddles: 0, shallow: 0 };
  for (let s = 0; s < W * W; s++) {
    if (!hol[s] || seen[s]) continue;
    const ids = [s];
    seen[s] = 1;
    let deep = 0, touch = false, x0 = W, x1 = 0, y0 = W, y1 = 0;
    for (let q = 0; q < ids.length; q++) {
      const c = ids[q], x = c % W, y = (c / W) | 0;
      deep = Math.max(deep, lvl[c] - h[c]);
      if (x === 0 || y === 0 || x === W - 1 || y === W - 1) touch = true;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= W) continue;
        const j = Y * W + X;
        if (hol[j] && !seen[j]) { seen[j] = 1; ids.push(j); }
      }
    }
    st.hollows++; st.hollowCells += ids.length;
    if (deep <= 768) { if (ids.length < 16) st.puddles++; else st.shallow += ids.length; continue; }
    if (touch) continue;
    st.lakes++; st.lakeCells += ids.length;
    const P = perimeter(hol, ids, W);
    st.rs.push((P * P) / (4 * Math.PI * ids.length)); st.fb.push(ids.length / ((x1 - x0 + 1) * (y1 - y0 + 1)));
  }
  return st;
}
const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
if (import.meta.main) {
  const R: [string, string, number, number, number][] = [["river", "rR", 1, 14, 10], ["spit", "rA", 4, 24, 20], ["K3", "rK", 1, 6, 6], ["B", "rB", 1, 1, 6], ["lake", "rL", 1, 14, 18]];
  const tot: Record<string, Stat & { rsAll: number[]; fbAll: number[] }> = {};
  for (const [name, rn, face, tx, ty] of R) {
    const p = at(name), rx0 = tx * 256, ry0 = ty * 256, RS = 1024, m = 64;
    const x0 = Math.max(rx0 + m, Math.min(rx0 + RS - m - W, p.X - W / 2)), y0 = Math.max(ry0 + m, Math.min(ry0 + RS - m - W, p.Y - W / 2));
    const srcs: [string, Int32Array][] = [["old", readWin(T5 + "../t4/old/t5-height.i32", 8192, face, x0, y0, W)], ["rejected", readWin(H + "nomads-bakes-next/1-6f5e2898ad43/t5-height.i32", 8192, face, x0, y0, W)]];
    for (const v of ["A", "A2", "B"]) { const full = readWin(T5 + "bake" + v + "/land/" + rn + "/state.i32", RS, 0, 0, 0, RS), h = new Int32Array(W * W); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) h[y * W + x] = full[(y0 - ry0 + y) * RS + x0 - rx0 + x]; srcs.push([v, h]); }
    for (const [lab, h] of srcs) {
      const s = hollowStats(h);
      console.log(name.padEnd(6), lab.padEnd(9), "hollow cells", (s.hollowCells / s.land * 100).toFixed(2) + "% of land in", s.hollows, "hollows;", "lakes (deepest over 3 m, inside the window)", s.lakes, "area", s.lakeCells, "(" + (s.lakeCells / s.land * 100).toFixed(2) + "%)", "median roundness", med(s.rs).toFixed(2), "box fill", med(s.fb).toFixed(2));
      const t = (tot[lab] ??= { land: 0, hollowCells: 0, hollows: 0, lakes: 0, lakeCells: 0, rs: [], fb: [], puddles: 0, shallow: 0, rsAll: [], fbAll: [] });
      t.land += s.land; t.hollowCells += s.hollowCells; t.hollows += s.hollows; t.lakes += s.lakes; t.lakeCells += s.lakeCells; t.rsAll.push(...s.rs); t.fbAll.push(...s.fb); t.puddles += s.puddles;
    }
  }
  for (const [lab, t] of Object.entries(tot)) console.log("TOTAL", lab.padEnd(9), "hollow cells", (t.hollowCells / t.land * 100).toFixed(2) + "% of land,", t.hollows, "hollows (" + t.puddles + " under 16 cells); lakes over 3 m deep", t.lakes, "cells", t.lakeCells, "(" + (t.lakeCells / t.land * 100).toFixed(2) + "% of land) roundness median", med(t.rsAll).toFixed(2), "p90", [...t.rsAll].sort((a, b) => a - b)[Math.floor(t.rsAll.length * 0.9)]?.toFixed(2), "box fill median", med(t.fbAll).toFixed(2));
}
