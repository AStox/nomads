import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
const base = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid";
const FR = [{ n: [1,0,0], ex: [0,1,0], ey: [0,0,1] }, { n: [0,1,0], ex: [-1,0,0], ey: [0,0,1] }, { n: [-1,0,0], ex: [0,-1,0], ey: [0,0,1] }, { n: [0,-1,0], ex: [1,0,0], ey: [0,0,1] }, { n: [0,0,1], ex: [1,0,0], ey: [0,1,0] }, { n: [0,0,-1], ex: [1,0,0], ey: [0,-1,0] }];
const T = { i8: [Int8Array,1], u8: [Uint8Array,1], i16: [Int16Array,2], u16: [Uint16Array,2] } as any;
function decode(path: string) { const raw = new Uint8Array(gunzipSync(readFileSync(path))); const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true); const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))); let at = 4 + hl; const planes: any = {}; for (const f of meta.fields) { const [C, b] = T[f.type]; const n = 256 * 256 * b; planes[f.name] = new C(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + n)); planes[f.name].step = f.step; at += n; } return planes; }
const tier = Number(process.argv[2] ?? 2), N = 2 ** tier, FN = 256 * N;
const latlon = (f: number, X: number, Y: number) => { const u = Math.tan(((X + 0.5) / FN - 0.5) * Math.PI / 2), v = Math.tan(((Y + 0.5) / FN - 0.5) * Math.PI / 2); const F = FR[f]; const p = [0,1,2].map((i) => F.n[i] + u * F.ex[i] + v * F.ey[i]); const r = Math.hypot(...p); return [Math.asin(p[2] / r) * 180 / Math.PI, Math.atan2(p[1], p[0]) * 180 / Math.PI]; };
const H = new Float32Array(6 * FN * FN), RV = new Uint8Array(6 * FN * FN), TR = new Float32Array(6 * FN * FN);
for (let f = 0; f < 6; f++) for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) {
  const p = decode(`${base}/t${tier}/f${f}/${ty}-${tx}.tile.gz`);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const i = y * 256 + x, g = f * FN * FN + (ty * 256 + y) * FN + tx * 256 + x; H[g] = p.height[i] * 0.25; RV[g] = p.river[i]; TR[g] = p.tree[i] / 255; }
}
const out: any = {};
// top summits (distinct by 20 cells)
const idx = Array.from({ length: H.length }, (_, i) => i).sort((a, b) => H[b] - H[a]);
const pick = (list: number[], k: number, sep: number) => { const got: number[] = []; for (const i of list) { const f = Math.floor(i / (FN * FN)), r = i % (FN * FN), Y = Math.floor(r / FN), X = r % FN; if (got.every((j) => { const f2 = Math.floor(j / (FN * FN)), r2 = j % (FN * FN); return f2 !== f || Math.hypot((r2 % FN) - X, Math.floor(r2 / FN) - Y) > sep; })) got.push(i); if (got.length >= k) break; } return got; };
const show = (i: number) => { const f = Math.floor(i / (FN * FN)), r = i % (FN * FN), Y = Math.floor(r / FN), X = r % FN; const [la, lo] = latlon(f, X, Y); return { face: f, X, Y, lat: +la.toFixed(2), lon: +lo.toFixed(2), h: H[i], river: RV[i] }; };
console.log("summits", pick(idx, 6, 40).map(show));
const rv = Array.from({ length: H.length }, (_, i) => i).filter((i) => H[i] > 5).sort((a, b) => RV[b] - RV[a]);
console.log("rivers (land)", pick(rv, 8, 30).map(show));
// land fraction
let land = 0; for (let i = 0; i < H.length; i++) if (H[i] > 0) land++; console.log("land share", land / H.length);
// coast candidates: 24x24 window ~half land, and tree-rich land; per face count
const best: any[] = []; const W = 24;
for (let f = 0; f < 6; f++) for (let Y = 0; Y + W < FN; Y += 12) for (let X = 0; X + W < FN; X += 12) { let l = 0, t = 0; for (let y = 0; y < W; y += 2) for (let x = 0; x < W; x += 2) { const g = f * FN * FN + (Y + y) * FN + X + x; if (H[g] > 0) { l++; t += TR[g]; } } const n = (W / 2) ** 2; best.push({ f, X: X + W / 2, Y: Y + W / 2, land: l / n, tree: t / Math.max(1, l), score: 1 - Math.abs(l / n - 0.5) * 2 + (t / Math.max(1, l)) * 0.5 }); }
best.sort((a, b) => b.score - a.score); console.log("coasts", best.slice(0, 40).filter((_, i) => i % 4 == 0).map((b) => ({ ...b, ll: latlon(b.f, b.X, b.Y).map((v) => +v.toFixed(2)) })));
