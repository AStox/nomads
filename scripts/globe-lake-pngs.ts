// Before and after of a lake region: the page's lake mask at tiers 5 to 2 over one region of a face, 4 px a 75 m cell. Top row: the old pyramid (wet where the bilinear water is 0.25 m).
// Bottom row: a pyramid with the lake plane (wet where the bilinear lake share is a half).
//   bun scripts/globe-lake-pngs.ts <old bake dir> <new bake dir> <face> <X0> <Y0> <size> <out.png>
import { readFileSync, writeFileSync } from "fs";
import { readTile } from "../src/gpu/globe/pyramid";
import { png } from "./globe-maps";
const [oldRoot, newRoot, fs, xs, ys, ss, out] = process.argv.slice(2), face = Number(fs), X0 = Number(xs), Y0 = Number(ys), S = Number(ss), P = 4, TOP = 5, TIERS = [5, 4, 3, 2];
const cache = new Map<string, any>();
const tileAt = (root: string, t: number, tx: number, ty: number) => { const k = `${root}/${t}/${tx}/${ty}`; if (!cache.has(k)) { try { cache.set(k, readTile(new Uint8Array(readFileSync(`${root}/pyramid/t${t}/f${face}/${ty}-${tx}.tile.gz`))).planes); } catch { cache.set(k, null); } } return cache.get(k); };
const val = (root: string, field: string, t: number, x: number, y: number) => { const n = 2 ** t * 256; x = Math.min(n - 1, Math.max(0, x)); y = Math.min(n - 1, Math.max(0, y)); const p = tileAt(root, t, x >> 8, y >> 8); return p ? p[field][(y & 255) * 256 + (x & 255)] * (field === "water" ? 0.5 : 1 / 255) : 0; };
const W = S * P, GAP = 4, IW = 4 * W + 3 * GAP, IH = 2 * W + GAP, img = new Uint8Array(IW * IH * 3).fill(20);
const stat: string[] = [];
[[oldRoot, "water", 0.25], [newRoot, "lake", 0.5]].forEach(([root, field, thr], row) => {
  TIERS.forEach((t, k) => {
    const sc = 2 ** (TOP - t); let area = 0;
    for (let py = 0; py < W; py++) for (let px = 0; px < W; px++) {
      const u = (X0 + (px + 0.5) / P) / sc - 0.5, v = (Y0 + (py + 0.5) / P) / sc - 0.5, ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
      const g = (x: number, y: number) => val(root as string, field as string, t, x, y);
      const w = (g(ix, iy) * (1 - fx) + g(ix + 1, iy) * fx) * (1 - fy) + (g(ix, iy + 1) * (1 - fx) + g(ix + 1, iy + 1) * fx) * fy, wet = w >= (thr as number);
      if (wet) area++;
      const o = ((row * (W + GAP) + py) * IW + k * (W + GAP) + px) * 3, c = wet ? [20, 70, 160] : [190, 190, 120];
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
    }
    stat.push(`${row ? "after " : "before"} tier ${t}: wet area ${(area / P / P).toFixed(0)} tier-5 cells`);
  });
});
writeFileSync(out, png(IW, IH, img)); console.log(stat.join("\n"));
