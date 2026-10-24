// the shift of the sprites' foot density that best fits the ground's crown-colour cover (cn=1 against cn=0 stills): SSD of the two maps normalised to their own 5th..95th percentiles
import { sharp, OUT } from "./lib.ts";
import { readFileSync } from "node:fs";
const [tag, place, z, k] = process.argv.slice(2), B = 4, FOOT = Number(process.env.FOOT ?? 0), R = Number(process.env.R ?? 4);
const raw = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { d: data, w: info.width, h: info.height }; };
const g1 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn1-ground.png`), g0 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn0-ground.png`);
const W = g1.w, H = g1.h, bw = Math.floor(W / B), bh = Math.floor(H / B);
const mask = new Float32Array(bw * bh), spr = new Float32Array(bw * bh);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (g1.d[i] !== g0.d[i] || g1.d[i + 1] !== g0.d[i + 1] || g1.d[i + 2] !== g0.d[i + 2]) { const bx = (x / B) | 0, by = (y / B) | 0; if (bx < bw && by < bh) mask[by * bw + bx] += 1 / (B * B); } }
const j = JSON.parse(readFileSync(`${OUT}/${tag}-${place}-${z}${k}-cn1.json`, "utf8"));
for (const [x, y] of j.d) { const sx = j.cam.dx + x * j.cam.s, sy = j.cam.dy + (y + FOOT) * j.cam.s, bx = (sx / B) | 0, by = (sy / B) | 0; if (bx >= 0 && by >= 0 && bx < bw && by < bh) spr[by * bw + bx] += 1; }
const box = (a: Float32Array, r: number) => { const t = new Float32Array(a.length), o = new Float32Array(a.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < bw) { s += a[y * bw + xx]; n++; } } t[y * bw + x] = s / n; } for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < bh) { s += t[yy * bw + x]; n++; } } o[y * bw + x] = s / n; } return o; };
const pr = (a: Float32Array, p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];
const nm = (a: Float32Array) => { const lo = pr(a, 0.05), hi = pr(a, 0.95) || 1; return a.map((v) => Math.min(1, Math.max(0, (v - lo) / Math.max(hi - lo, 1e-9)))); };
const M = nm(box(box(mask, R), R)), S = nm(box(box(spr, R), R));
const RNG = 40, res: [number, number, number][] = [];
for (let dy = -RNG; dy <= RNG; dy += 1) for (let dx = -RNG; dx <= RNG; dx += 1) { let c = 0, n = 0; for (let y = RNG; y < bh - RNG; y += 2) for (let x = RNG; x < bw - RNG; x += 2) { const d = M[y * bw + x] - S[(y + dy) * bw + x + dx]; c += d * d; n++; } res.push([c / n, dx * B, dy * B]); }
res.sort((a, b) => a[0] - b[0]);
const zero = res.find((r) => r[1] === 0 && r[2] === 0)!;
console.log(`${tag} z${z}: sprites' foot density best fits the crown cover when shifted by (${res[0][1]},${res[0][2]}) screen px = (${(res[0][1] / j.ppm).toFixed(0)},${(res[0][2] / j.ppm).toFixed(0)}) plane m, ssd ${res[0][0].toFixed(4)} vs ${zero[0].toFixed(4)} at zero; mask cover ${(100 * mask.reduce((a, b) => a + b, 0) / (bw * bh)).toFixed(1)}% sprites ${j.n}`);
