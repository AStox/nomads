// old vs new vs candidate, same window, hillshade and flat class map at 1 px a cell: bun render2.ts <place> [W=512] [zoom=1]
import { existsSync } from "node:fs";
import { at, readWin } from "./places";
import { flat, hill, mk, row, save, type Img } from "./render";
import { floodLakes } from "../scripts/gates/straight";
const H = process.env.HOME + "/.cache/", T = H + "nomads-scratch/t4/";
const REG: Record<string, [string, number, number, number]> = { spit: ["rA", 4, 24, 20], shelf: ["rA", 4, 24, 20], home: ["rH", 4, 26, 25], ridges: ["rH", 4, 26, 25], river: ["rR", 1, 14, 10], lake: ["rL", 1, 14, 18], K3: ["rK", 1, 6, 6], E2: ["rE", 0, 28, 22], B: ["rB", 1, 1, 6] };
const n = process.argv[2], W = Number(process.argv[3] ?? 512), cands = (process.argv[4] ?? "A").split(","), p = at(n), [rname, rface, rtx, rty] = REG[n];
const rx0 = rtx * 256, ry0 = rty * 256, RS = 1024, m = 64;
const x0 = Math.max(rx0 + m, Math.min(rx0 + RS - m - W, p.X - W / 2)), y0 = Math.max(ry0 + m, Math.min(ry0 + RS - m - W, p.Y - W / 2));
if (p.face !== rface) throw new Error("region face");
const covFiles = ["tree.u8", "shr.u8", "grs.u8", "mar.u8", "bare.u8"];
function planetPanels(label: string, h: Int32Array, fl: Int32Array | null, water: Int32Array | null, cov: Int32Array[] | null): Img[] {
  const lake = new Uint8Array(W * W);
  if (water) for (let i = 0; i < W * W; i++) lake[i] = h[i] > 0 && (water[i] > 0 || (fl && fl[i] > h[i])) ? 1 : 0;
  else { const l = floodLakes(h, W); for (let i = 0; i < W * W; i++) lake[i] = l[i]; }
  const hs = hill(h, W, W, 75, (i) => h[i] > 0 || lake[i] === 1, (i) => lake[i] === 1);
  const fm = flat(h, W, W, lake as unknown as ArrayLike<number>, cov ?? undefined);
  // inland sea pits: sea cells not connected to the window's edge, orange
  const seen = new Uint8Array(W * W), q: number[] = [];
  for (let i = 0; i < W * W; i++) { const x = i % W, y = (i / W) | 0; if ((x === 0 || y === 0 || x === W - 1 || y === W - 1) && h[i] <= 0) { seen[i] = 1; q.push(i); } }
  while (q.length) { const i = q.pop()!, x = i % W, y = (i / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= W) continue; const j = Y * W + X; if (!seen[j] && h[j] <= 0) { seen[j] = 1; q.push(j); } } }
  for (let i = 0; i < W * W; i++) if (h[i] <= 0 && !seen[i]) { fm.rgb.set([230, 140, 30], i * 3); hs.rgb.set([230, 140, 30], i * 3); }
  return [hs, fm];
}
const rows: Img[] = [];
// old
const O = T + "old/", OB = H + "nomads-bakes/1-1121d207f3b8/";
{ const h = readWin(O + "t5-height.i32", 8192, p.face, x0, y0, W), fl = readWin(O + "t5-flooded.i32", 8192, p.face, x0, y0, W), wa = readWin(OB + "t5-water.u16", 8192, p.face, x0, y0, W, W, 2);
  rows.push(row(planetPanels("old", h, fl, wa, covFiles.map((f) => readWin(OB + "t5-" + f, 8192, p.face, x0, y0, W, W, 1))))); }
// new
const N = H + "nomads-bakes-next/1-6f5e2898ad43/";
{ const h = readWin(N + "t5-height.i32", 8192, p.face, x0, y0, W), fl = readWin(N + "t5-flooded.i32", 8192, p.face, x0, y0, W), wa = readWin(N + "t5-water.u16", 8192, p.face, x0, y0, W, W, 2);
  rows.push(row(planetPanels("new", h, fl, wa, covFiles.map((f) => readWin(N + "t5-" + f, 8192, p.face, x0, y0, W, W, 1))))); }
// candidates
for (const c of cands) {
  const st = H + `nomads-scratch/t5/bake${c}/land/${rname}/state.i32`;
  if (!existsSync(st)) { console.log("missing", st); continue; }
  const full = readWin(st, RS, 0, 0, 0, RS), h = new Int32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) h[y * W + x] = full[(y0 - ry0 + y) * RS + x0 - rx0 + x];
  rows.push(row(planetPanels("cand" + c, h, null, null, null)));
}
const out = mk(rows[0].w, rows.reduce((s, r) => s + r.h + 4, -4)); out.rgb.fill(255);
let yy = 0; for (const r of rows) { out.rgb.set(r.rgb, yy * out.w * 3); yy += r.h + 4; }
save(`t5-${n}-${W}-${cands.join("")}.png`, out);
console.log(n, "window", p.face, x0, y0, "rows", rows.length);
