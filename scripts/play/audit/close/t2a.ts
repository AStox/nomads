// the ground's crown-colour cover (cn=1 against cn=0, sprites hidden: the pixels that differ) against the drawn sprites' foot density: the shift that best aligns them
import { sharp, OUT } from "./lib.ts";
import { readFileSync } from "node:fs";
const [tag, place, z, k] = process.argv.slice(2), B = 4;
const raw = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { d: data, w: info.width, h: info.height }; };
const g1 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn1-ground.png`), g0 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn0-ground.png`);
const W = g1.w, H = g1.h, bw = Math.floor(W / B), bh = Math.floor(H / B);
const mask = new Float32Array(bw * bh), spr = new Float32Array(bw * bh);
let nz = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (g1.d[i] !== g0.d[i] || g1.d[i + 1] !== g0.d[i + 1] || g1.d[i + 2] !== g0.d[i + 2]) { nz++; const bx = (x / B) | 0, by = (y / B) | 0; if (bx < bw && by < bh) mask[by * bw + bx] += 1 / (B * B); } }
const j = JSON.parse(readFileSync(`${OUT}/${tag}-${place}-${z}${k}-cn1.json`, "utf8"));
let ns = 0; const FOOT = Number(process.env.FOOT ?? 0);
for (const [x, y] of j.d) { const sx = j.cam.dx + x * j.cam.s, sy = j.cam.dy + (y + FOOT) * j.cam.s, bx = (sx / B) | 0, by = (sy / B) | 0; if (bx >= 0 && by >= 0 && bx < bw && by < bh) { spr[by * bw + bx] += 1; ns++; } }
const blur = (a: Float32Array, r: number) => { const o = new Float32Array(a.length), t = new Float32Array(a.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < bw) { s += a[y * bw + xx]; n++; } } t[y * bw + x] = s / n; } for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < bh) { s += t[yy * bw + x]; n++; } } o[y * bw + x] = s / n; } return o; };
const R = Number(process.env.R ?? 4);
let M = blur(mask, R), S = blur(spr, R); M = blur(M, R); S = blur(S, R);
const norm = (a: Float32Array) => { let m = 0; for (const v of a) m += v; m /= a.length; let s = 0; for (const v of a) s += (v - m) ** 2; s = Math.sqrt(s / a.length) || 1; return a.map((v) => (v - m) / s); };
const Mn = norm(M), Sn = norm(S), RNG = 14;
const res: [number, number, number][] = [];
for (let dy = -RNG; dy <= RNG; dy++) for (let dx = -RNG; dx <= RNG; dx++) { let c = 0, n = 0; for (let y = RNG; y < bh - RNG; y++) for (let x = RNG; x < bw - RNG; x++) { c += Mn[y * bw + x] * Sn[(y + dy) * bw + x + dx]; n++; } res.push([c / n, dx * B, dy * B]); }
res.sort((a, b) => b[0] - a[0]);
const zero = res.find((r) => r[1] === 0 && r[2] === 0)!;
console.log(`${tag} ${place} z${z}${k}: mask pixels ${nz} (${(100 * nz / (W * H)).toFixed(1)}%), sprites on screen ${ns}; best shift of sprite density onto crown mask (px) ${res[0][1]},${res[0][2]} corr ${res[0][0].toFixed(3)}, at zero corr ${zero[0].toFixed(3)}; ppm ${j.ppm.toFixed(3)}`);
