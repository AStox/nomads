// Crops of region states side by side at scale: bun shorecrop.ts <out name> <x0> <y0> <w> <scale> <state.i32>[,<state.i32>...]
// sea blue, land tan, land under 3 m green-ish tint by height (0.. 3 m), land over 3 m dark: shows what the shore stage may move
import { readFileSync } from "node:fs";
import { mk, row, save } from "./render";
const [out, X0, Y0, W, SC, files] = process.argv.slice(2), x0 = +X0, y0 = +Y0, w = +W, sc = +SC;
const panels = files.split(",").map((f) => {
  const b = readFileSync(f), h = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), im = mk(w * sc, w * sc);
  for (let y = 0; y < w * sc; y++) for (let x = 0; x < w * sc; x++) {
    const v = h[(y0 + ((y / sc) | 0)) * 1024 + x0 + ((x / sc) | 0)] / 256; let c: number[];
    if (v <= 0) c = v < -3 ? [10, 25, 90] : [30, 60, 140];
    else if (v <= 3) c = [200 - 20 * v, 180, 120];
    else c = [90, 120, 70];
    im.rgb.set(c, (y * w * sc + x) * 3);
  }
  return im;
});
save(`${out}.png`, row(panels));
