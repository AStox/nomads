// carry lab: the production carry (limitSea) with unresolved-relief Haar detail; bun nlab.ts <place> <W> <floorM> <H> [tag]
import { child4, limitSea } from "../src/gpu/globe/regional";
import { window0, crop } from "./wcarry";
import { hill, flat, mk, row, save, type Img } from "./render";
import { floodLakes } from "../scripts/gates/straight";
const name = process.argv[2], W = Number(process.argv[3] ?? 384), floor0 = Number(process.argv[4] ?? 0), Hh = Number(process.argv[5] ?? 0.5), tag = process.argv[6] ?? "n";
const mix = (h: number) => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h >>> 0; };
const unit = (a: number, b: number, t: number, k: number) => mix(mix(a ^ Math.imul(t + 1, 0x9e3779b1)) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) / 4294967296;
const gauss = (a: number, b: number, t: number, k: number) => { let s = 0; for (let j = 0; j < 4; j++) s += unit(a, b, t, k * 4 + j); return (s - 2) * Math.sqrt(3); };
const cl = (v: number, S: number) => (v < 0 ? 0 : v >= S ? S - 1 : v);
function carryN(parent: Float64Array, S: number, tier: number, floor: number): Int32Array {
  const fn = 2 * S, c = new Float64Array(4 * S * S), q = new Float64Array(4);
  const g = (a: Float64Array, X: number, Y: number, dx: number, dy: number) => a[cl(Y + dy, S) * S + cl(X + dx, S)];
  const kids = (src: Float64Array, out: Float64Array) => { for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) { child4(g(src, X, Y, 0, 0), g(src, X, Y, -1, 0), g(src, X, Y, 1, 0), g(src, X, Y, 0, -1), g(src, X, Y, 0, 1), g(src, X, Y, -1, -1), g(src, X, Y, 1, -1), g(src, X, Y, -1, 1), g(src, X, Y, 1, 1), q); const o = 2 * Y * fn + 2 * X; out[o] = q[0]; out[o + 1] = q[1]; out[o + fn] = q[2]; out[o + fn + 1] = q[3]; } };
  kids(parent, c);
  const r = new Float64Array(S * S), corr = new Float64Array(4 * S * S);
  for (let pass = 0; pass < 4; pass++) { for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) { const o = 2 * Y * fn + 2 * X; r[Y * S + X] = parent[Y * S + X] - (c[o] + c[o + 1] + c[o + fn] + c[o + fn + 1]) / 4; } kids(r, corr); for (let i = 0; i < c.length; i++) c[i] += corr[i]; }
  const out = new Int32Array(4 * S * S);
  for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) {
    const o = 2 * Y * fn + 2 * X, p = parent[Y * S + X];
    // the resolved roughness: rms difference to the four edge neighbours, the next octave's share beyond the interpolation (H), a floor of the unresolved relief
    let s2 = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const d = p - g(parent, X, Y, dx, dy); s2 += d * d; }
    const s = Math.sqrt(s2 / 4), sig = floor < 0 ? 0 : Math.max(s * Math.sqrt(Math.max(0, 2 ** (-2 * Hh) - 0.25)), floor * 256 * 2 ** (-Hh * tier));
    const h1 = gauss(X, Y, tier, 0), h2 = gauss(X, Y, tier, 1), h3 = gauss(X, Y, tier, 2), a = sig / Math.sqrt(3);
    const dd = [(-h1 - h2 + h3) * a, (h1 - h2 - h3) * a, (-h1 + h2 - h3) * a, (h1 + h2 + h3) * a];
    const v = [0, 1, 2, 3].map((k) => Math.round((k < 2 ? c[o + k] : c[o + fn + k - 2]) + dd[k]));
    const d = Math.round(p * 4) - (v[0] + v[1] + v[2] + v[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
    for (let k = 0; k < 4; k++) v[k] += base4 + (k < rem ? 1 : 0);
    limitSea(v, Math.round(p * 4), p, g(parent, X, Y, -1, 0), g(parent, X, Y, 1, 0), g(parent, X, Y, 0, -1), g(parent, X, Y, 0, 1));
    out[o] = v[0]; out[o + 1] = v[1]; out[o + fn] = v[2]; out[o + fn + 1] = v[3];
  }
  return out;
}
const S0 = 56, w = window0(name, S0, "fine");
let h: Int32Array = w.h, S = S0;
const LASTN = Number(process.env.LASTN ?? 5); for (let t = 1; t <= 5; t++) { h = carryN(Float64Array.from(h), S, t, t <= LASTN ? floor0 : -1); S *= 2; }
const cc = crop(h, S, S0, 12), o = (cc.S - W) >> 1, hh = new Int32Array(W * W);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) hh[y * W + x] = cc.h[(y + o) * cc.S + x + o];
const lake = floodLakes(hh, W), hs = hill(hh, W, W, 75, (i) => hh[i] > 0 || lake[i] === 1, (i) => lake[i] === 1), fm = flat(hh, W, W, lake as any);
save(`n-${name}-${tag}.png`, row([hs, fm]));
console.log(name, tag, "land", hh.filter((x) => x > 0).length);
