// A hillshaded window of a tier's heights (and its rivers where the tier's flow was made), for judging landforms by eye while the erosion is tuned:
//   NOMADS_BAKE=$HOME/.cache/nomads-bakes/exp bun scripts/globe-exp-map.ts --key 883a8d9387df --tier 3 --face 1 --x 1280 --y 1536 --size 256 --out $HOME/.cache/nomads-bakes/maps/exp-a.png
import { writeFileSync } from "node:fs";
import { BAKE, bakeDir } from "../src/gpu/globe/bakedir";
import { join } from "node:path";
import { heightColor, mix, png, type RGB } from "./globe-maps";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const tier = Number(arg("tier", "3")), fn = 256 << tier, face = Number(arg("face", "1")), x0 = Number(arg("x", "0")), y0 = Number(arg("y", "0")), size = Number(arg("size", "256")), scale = Number(arg("scale", "3"));
const dir = bakeDir(Number(arg("seed", "1")), arg("key", process.env.NOMADS_PLANET_KEY ?? "")), h = dir.i32(`t${tier}-height`), to = dir.has(`t${tier}-to.u32`) ? dir.u32(`t${tier}-to`) : null, acc = dir.has(`t${tier}-acc.u32`) ? dir.u32(`t${tier}-acc`) : null;
const cellM = 75 * 2 ** (4 - tier), at = (x: number, y: number) => h[(face * fn + Math.min(fn - 1, Math.max(0, y))) * fn + Math.min(fn - 1, Math.max(0, x))] / 256;
const L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], W = size * scale, rgb = new Uint8Array(W * W * 3);
const riverArea = Number(arg("river", "300")); // cells of drainage area at the reference rain
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const X = x0 + x, Y = y0 + y, z = at(X, Y), i = (face * fn + Y) * fn + X;
    let c = heightColor(z);
    if (z > 0) {
      const sx = (at(X + 1, Y) - at(X - 1, Y)) / (2 * cellM), sy = (at(X, Y + 1) - at(X, Y - 1)) / (2 * cellM), nz = 1 / Math.hypot(sx, sy, 1), s = Math.max(0.15, -sx * nz * L[0] - sy * nz * L[1] + nz * L[2]);
      c = [Math.min(255, c[0] * s * 1.3), Math.min(255, c[1] * s * 1.3), Math.min(255, c[2] * s * 1.3)];
      if (acc && acc[i] / 512 >= riverArea) c = mix(c, [30, 80, 210], Math.min(1, 0.4 + 0.2 * Math.log10(acc[i] / 512 / riverArea)));
    }
    for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) { const o = (((size - 1 - y) * scale + sy) * W + x * scale + sx) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
  }
writeFileSync(arg("out", join(BAKE, "maps", "exp.png")), png(W, W, rgb));
void to; void (null as unknown as RGB);
