// Preview the island generator as PNG maps, one per layer, without running the game.
//   bun scripts/island.ts --seed 7 --out /tmp/island
import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { rng } from "../src/sim/world";
import { CELL, LEN, N } from "../src/terrain/grid";
import { generateIsland } from "../src/terrain/island";

type RGB = [number, number, number];
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "7")), out = arg("out", "/tmp/island"), scale = Number(arg("scale", "4"));
mkdirSync(out, { recursive: true });

function png(w: number, h: number, rgb: Uint8Array) {
  const row = w * 3 + 1, raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * row + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    dv.setUint32(8 + data.length, Bun.hash.crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const head = new Uint8Array(13), dv = new DataView(head.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}
const mix = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k] - v) * Math.max(0, Math.min(1, t))) as RGB;

const t0 = performance.now();
const isle = generateIsland(rng(seed));
const ms = Math.round(performance.now() - t0);
const { height: h, water } = isle;
const river = new Float32Array(LEN);
for (const line of isle.rivers) for (const [x, y, q] of line) river[y * N + x] = Math.max(river[y * N + x], q);
const at = (x: number, y: number) => Math.max(0, h[Math.max(0, Math.min(N - 1, y)) * N + Math.max(0, Math.min(N - 1, x))]);
const shade = (i: number) => {
  const x = i % N, y = (i - x) / N;
  const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * CELL), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * CELL);
  return Math.max(0, (0.6 * gx + 0.6 * gy + 0.53) / Math.hypot(gx, gy, 1)) / 0.53;
};
function save(name: string, color: (i: number) => RGB, shaded = true) {
  const W = N * scale, rgb = new Uint8Array(W * W * 3);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = Math.floor(y / scale) * N + Math.floor(x / scale);
      let c = water[i] > 0 ? mix([110, 160, 175], [35, 60, 100], water[i] / 40) : color(i);
      if (water[i] <= 0 && shaded) c = c.map((v) => Math.min(255, v * (0.45 + 0.55 * shade(i)))) as RGB;
      if (river[i] > 0 && water[i] <= 0) c = mix(c, [40, 90, 170], 0.45 + Math.min(0.5, river[i] * 2));
      const o = (y * W + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  Bun.write(`${out}/${name}.png`, png(W, W, rgb));
}

let land = 0, top = 0, pLo = Infinity, pHi = 0;
const share = { tree: 0, shrub: 0, grass: 0, marsh: 0, bare: 0, sand: 0 };
for (let i = 0; i < LEN; i++) {
  if (water[i] > 0) continue;
  land++; top = Math.max(top, h[i]); pLo = Math.min(pLo, isle.precip[i]); pHi = Math.max(pHi, isle.precip[i]);
  for (const k of ["tree", "shrub", "grass", "marsh", "bare", "sand"] as const) share[k] += isle[k][i];
}
console.log(`seed ${seed}: ${ms}ms, land ${((land / LEN) * 100).toFixed(1)}%, peak ${Math.round(top)}m, ${isle.lakes} lakes, ${isle.rivers.length} streams, rain ${Math.round(pLo)}-${Math.round(pHi)}mm, wind toward ${isle.wind.map((v) => v.toFixed(2))}`);
console.log("cover on land:", Object.entries(share).map(([k, v]) => `${k} ${((v / land) * 100).toFixed(0)}%`).join(", "));

save("relief", (i) => { const t = h[i] / top; return t < 0.5 ? mix([110, 150, 80], [190, 170, 120], t * 2) : mix([190, 170, 120], [245, 245, 240], (t - 0.5) * 2); });
save("precip", (i) => mix([214, 190, 130], [40, 120, 110], (isle.precip[i] - 500) / 2000));
save("table", (i) => mix([60, 110, 200], [150, 110, 70], isle.table[i] / 15), false);
save("wind", (i) => [Math.min(255, isle.exposure[i] * 255), Math.min(255, isle.salt[i] * 400), 90], false);
save("soil", (i) => mix([120, 120, 120], [110, 80, 40], isle.soil[i] / 2), false);
save("cover", (i) => {
  const parts: [number, RGB][] = [[isle.tree[i], [52, 92, 48]], [isle.shrub[i], [128, 96, 110]], [isle.grass[i], [170, 190, 100]], [isle.marsh[i], [110, 130, 90]], [isle.bare[i], [150, 145, 135]]];
  const c: RGB = [0, 0, 0];
  for (const [w, rgb] of parts) for (let k = 0; k < 3; k++) c[k] += w * rgb[k];
  return mix(c, [226, 208, 160], isle.sand[i]);
});
save("dominant", (i) => {
  if (isle.sand[i] > 0.5) return [226, 208, 160];
  const kinds: [number, RGB][] = [[isle.tree[i], [40, 85, 40]], [isle.shrub[i], [140, 90, 130]], [isle.grass[i], [190, 205, 110]], [isle.marsh[i], [80, 150, 140]], [isle.bare[i], [160, 155, 150]]];
  return kinds.reduce((a, b) => (b[0] > a[0] ? b : a))[1];
}, false);
save("moist", (i) => mix([200, 120, 60], [60, 140, 90], isle.moist[i]), false);
