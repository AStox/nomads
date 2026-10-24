// edge crossing per column: where the ground's crown-pixel density and the sprites' foot density each fall to half their forest value (going up the screen from the forest), and the difference
import { sharp, OUT } from "./lib.ts";
import { readFileSync } from "node:fs";
const [tag, place, z, k] = process.argv.slice(2), B = 4, FOOT = Number(process.env.FOOT ?? 0);
const raw = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { d: data, w: info.width, h: info.height }; };
const g1 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn1-ground.png`), g0 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn0-ground.png`);
const W = g1.w, H = g1.h, bw = Math.floor(W / B), bh = Math.floor(H / B);
const mask = new Float32Array(bw * bh), spr = new Float32Array(bw * bh);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (g1.d[i] !== g0.d[i] || g1.d[i + 1] !== g0.d[i + 1] || g1.d[i + 2] !== g0.d[i + 2]) { const bx = (x / B) | 0, by = (y / B) | 0; if (bx < bw && by < bh) mask[by * bw + bx] += 1 / (B * B); } }
const j = JSON.parse(readFileSync(`${OUT}/${tag}-${place}-${z}${k}-cn1.json`, "utf8"));
for (const [x, y] of j.d) { const sx = j.cam.dx + x * j.cam.s, sy = j.cam.dy + (y + FOOT) * j.cam.s, bx = (sx / B) | 0, by = (sy / B) | 0; if (bx >= 0 && by >= 0 && bx < bw && by < bh) spr[by * bw + bx] += 1; }
const R = Number(process.env.R ?? 3);
const boxy = (a: Float32Array) => { const o = new Float32Array(a.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let s = 0, n = 0; for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < bw && yy < bh) { s += a[yy * bw + xx]; n++; } } o[y * bw + x] = s / n; } return o; };
const M = boxy(mask), S = boxy(spr);
const top = (a: Float32Array) => { const v = [...a].sort((p, q) => p - q); return v[Math.floor(v.length * 0.9)]; };
const mt = top(M) * 0.5, st = top(S) * 0.5;
const out: string[] = [], diffs: number[] = [];
for (let x = 6; x < bw - 6; x += 10) {
  // scan from the bottom of the column up: the first block where the density has been above half for 3 blocks and then falls below it
  const cross = (A: Float32Array, t: number) => { let run = 0; for (let y = bh - 1; y >= 0; y--) { if (A[y * bw + x] > t) run++; else { if (run >= 8) return y + 1; run = 0; } } return -1; };
  const ym = cross(M, mt), ys = cross(S, st);
  if (ym > 0 && ys > 0) { out.push(`x${x * B}: mask y${ym * B} sprites y${ys * B} (${(ys - ym) * B})`); diffs.push((ys - ym) * B); }
}
console.log(out.join("\n"));
diffs.sort((a, b) => a - b);
console.log(`${tag} ${place} z${z}${k}: crossings ${diffs.length}, median sprites-minus-mask edge offset ${diffs[diffs.length >> 1]} screen px (negative: sprites' feet reach further up-screen than the ground's crowns) = ${(diffs[diffs.length >> 1] / j.ppm).toFixed(1)} plane m; thresholds m${mt.toFixed(3)} s${st.toFixed(3)}`);
