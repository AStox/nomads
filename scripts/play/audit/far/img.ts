import { sharp } from "./lib.ts";
export interface Im { w: number; h: number; d: Float32Array }
export async function luma(png: Buffer | string): Promise<Im> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = new Float32Array(info.width * info.height);
  for (let i = 0; i < d.length; i++) d[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  return { w: info.width, h: info.height, d };
}
export function box(im: Im, r: number): Im {
  const { w, h, d } = im, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let s = 0, n = 0; const row = y * w; for (let x = -r; x < w; x++) { const a = x + r, b = x - r - 1; if (a < w) { s += d[row + a]; n++; } if (b >= 0) { s -= d[row + b]; n--; } if (x >= 0) tmp[row + x] = s / n; } }
  for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let y = -r; y < h; y++) { const a = y + r, b = y - r - 1; if (a < h) { s += tmp[a * w + x]; n++; } if (b >= 0) { s -= tmp[b * w + x]; n--; } if (y >= 0) out[y * w + x] = s / n; } }
  return { w, h, d: out };
}
export const sub = (a: Im, b: Im): Im => ({ w: a.w, h: a.h, d: a.d.map((v, i) => v - b.d[i]) });
// normalised cross-correlation of a (region) with b shifted by (dx,dy): b(x+dx, y+dy) against a(x,y)
export function ncc(a: Im, b: Im, reg: [number, number, number, number], dx: number, dy: number): number {
  const [x0, y0, x1, y1] = reg; let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
  for (let y = y0; y < y1; y++) { if (y + dy < 0 || y + dy >= b.h) continue; for (let x = x0; x < x1; x++) { const xx = x + dx; if (xx < 0 || xx >= b.w) continue; const p = a.d[y * a.w + x], q = b.d[(y + dy) * b.w + xx]; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; n++; } }
  if (n < 100) return NaN; const va = saa - sa * sa / n, vb = sbb - sb * sb / n; return (sab - sa * sb / n) / Math.sqrt(va * vb + 1e-9);
}
export function bestShift(a: Im, b: Im, reg: [number, number, number, number], R: number, step = 1) {
  let best = { dx: 0, dy: 0, c: -2 };
  for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) { const c = ncc(a, b, reg, dx, dy); if (c > best.c) best = { dx, dy, c }; }
  return best;
}
// the region of the screen with the most high-pass energy (a w x h box on a coarse grid), away from the hud
export function busiest(hp: Im, bw: number, bh: number, avoid: [number, number, number, number][] = []) {
  let best: any = null;
  for (let y = 80; y + bh < hp.h - 100; y += 40) for (let x = 40; x + bw < hp.w - 40; x += 40) {
    let s = 0; for (let j = y; j < y + bh; j += 4) for (let i = x; i < x + bw; i += 4) s += Math.abs(hp.d[j * hp.w + i]);
    if (!best || s > best.s) best = { s, reg: [x, y, x + bw, y + bh] };
  }
  return best.reg as [number, number, number, number];
}
