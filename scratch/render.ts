import { writeFileSync } from "node:fs";
import { png } from "../scripts/globe-maps";
export type Img = { w: number; h: number; rgb: Uint8Array };
export const mk = (w: number, h: number): Img => ({ w, h, rgb: new Uint8Array(w * h * 3) });
export function hill(hm: ArrayLike<number>, w: number, h: number, cellM: number, land: (i: number) => boolean, lake?: (i: number) => boolean): Img {
  const o = mk(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, z = (dx: number, dy: number) => hm[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))] / 256;
    let c: number[];
    if (!land(i)) c = [20, 40, 110];
    else if (lake?.(i)) c = [60, 160, 210];
    else {
      const gx = (z(1, 0) - z(-1, 0)) / (2 * cellM), gy = (z(0, 1) - z(0, -1)) / (2 * cellM);
      const s = Math.max(0, Math.min(1, 0.55 + 6 * (-gx - gy) / Math.SQRT2 / 1)), e = Math.min(1, hm[i] / 256 / 1500);
      c = [(110 + 60 * e) * s * 1.3, (140 + 20 * e) * s * 1.3, (80 + 60 * e) * s * 1.3];
    }
    for (let k = 0; k < 3; k++) o.rgb[i * 3 + k] = Math.max(0, Math.min(255, c[k]));
  }
  return o;
}
export const SEA = [20, 40, 110], LAKE = [70, 170, 220], TREE = [30, 90, 30], SHR = [120, 130, 50], GRS = [150, 200, 90], MAR = [60, 150, 140], BARE = [190, 160, 110];
// flat classes: sea, lake, and the strongest cover class of a land cell
export function flat(h: ArrayLike<number>, w: number, ht: number, water?: ArrayLike<number>, cov?: ArrayLike<number>[]): Img {
  const o = mk(w, ht);
  for (let i = 0; i < w * ht; i++) {
    let c = SEA;
    if (h[i] > 0) {
      if (water && water[i] > 0) c = LAKE;
      else if (cov) { const v = cov.map((a) => a[i]), m = v.indexOf(Math.max(...v)); c = [TREE, SHR, GRS, MAR, BARE][m]; }
      else c = BARE;
    }
    o.rgb.set(c, i * 3);
  }
  return o;
}
export function up(a: ArrayLike<number>, w: number, h: number, f: number): Int32Array { const o = new Int32Array(w * f * h * f); for (let y = 0; y < h * f; y++) for (let x = 0; x < w * f; x++) o[y * w * f + x] = a[((y / f) | 0) * w + ((x / f) | 0)]; return o; }
export function row(imgs: Img[], gap = 4): Img {
  const h = Math.max(...imgs.map((i) => i.h)), w = imgs.reduce((s, i) => s + i.w + gap, -gap), o = mk(w, h);
  o.rgb.fill(255);
  let x0 = 0;
  for (const im of imgs) { for (let y = 0; y < im.h; y++) o.rgb.set(im.rgb.subarray(y * im.w * 3, (y + 1) * im.w * 3), (y * w + x0) * 3); x0 += im.w + gap; }
  return o;
}
export const OUT = "/Users/adamstockermans/.cache/nomads-scratch/t7/out/";
export const save = (path: string, im: Img) => writeFileSync(OUT + path, png(im.w, im.h, im.rgb));
