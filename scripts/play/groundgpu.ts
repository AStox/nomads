// The window's ground made on the GPU (demo/tile.ts windowGround) against the CPU's (windowFine, then the page's cropFlip and the light grid of packGround),
// on a real ground tile taken as a window:
//   bun scripts/play/groundgpu.ts [lat lon] [--key 7f6ff6c82cdd]
// Prints the largest difference of each layer and the time of each way; exits 1 when one is over its bound.
import { readFileSync } from "node:fs";
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { fromLatLon, locateVec, tierGrid } from "../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../src/gpu/globe/groundtile";
import { CELL } from "../../src/terrain/grid";
import { M, RM, SIZE, START, STEP } from "../../src/terrain/flora";
import { FINE_LAYER_WORDS, FINE_PITCH, GN, GRID_LAYER_WORDS, GRID_PITCH, GRID_STEP } from "../../src/gpu/wgsl/terrain-window";
import { windowFine, windowGround } from "../../demo/tile";

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a)).map(Number), lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, MT = 1025;
await holdGpu();
const gpu = await theGpu(), g = tierGrid(TIER), loc = locateVec(g, fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), nT = 2 ** TIER;
const tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256);
const gt = readGroundTile(readFileSync(`/tmp/planet-75m/1-${key}/groundtiles/f${loc.face}/${ty}-${tx}.gt.gz`));
const src = () => tileSource(gt);
await windowFine(gpu, src(), loc.face, tx * 256, ty * 256); // pipelines made
await windowGround(gpu, src(), loc.face, tx * 256, ty * 256).then((w) => { w.fine.destroy(); w.mask.destroy(); w.grid.destroy(); });

// ---------- the CPU's ----------
let t = performance.now();
const cpu = await windowFine(gpu, src(), loc.face, tx * 256, ty * 256);
const cropFlip = (F: Float32Array) => { const o = new Float32Array(M * M); for (let v = 0; v < M; v++) { const row = (MT - 3 - v) * MT + 2; for (let u = 0; u < M; u++) o[v * M + u] = F[row + u]; } return o; };
const mask = new Uint8Array(RM * RM);
for (let r = 0; r < RM; r++) mask.set(cpu.mask.subarray((RM - 1 - r) * RM, (RM - r) * RM), r * RM);
const river = new Float32Array(M * M);
for (let v = 0, i = 0; v < M; v++) for (let u = 0; u < M; u++, i++) river[i] = mask[(8 + 4 * v) * RM + 8 + 4 * u] / 255;
const L = cpu.layers, layers = [cropFlip(L.h), cropFlip(L.wet), cropFlip(L.moist), river, ...(["tree", "shrub", "grass", "marsh", "bare", "sand"] as const).map((n) => cropFlip(L[n]))];
const hh = layers[0], max = M - 1.001;
const heightAt = (x: number, z: number) => {
  const fu = Math.min(max, Math.max(0, (x - START) / STEP)), fv = Math.min(max, Math.max(0, (z - START) / STEP)), u = Math.floor(fu), v = Math.floor(fv), a = fu - u, b = fv - v, i = v * M + u;
  return (hh[i] * (1 - a) + hh[i + 1] * a) * (1 - b) + (hh[i + M] * (1 - a) + hh[i + M + 1] * a) * b;
};
const ORIGIN = -SIZE / 2, WS = GRID_STEP, W2 = GN * GN, h = new Float32Array(W2), ao = new Float32Array(W2), sl = new Float32Array(W2), tmp = new Float32Array(W2), m = new Float32Array(W2);
for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) h[j * GN + i] = Math.max(0, heightAt(ORIGIN + i * WS, ORIGIN + j * WS));
const r = 16;
for (let j = 0; j < GN; j++) { let a = 0, c = 0; for (let i = -r; i < GN + r; i++) { if (i + r < GN) { a += h[j * GN + i + r]; c++; } if (i - r - 1 >= 0) { a -= h[j * GN + i - r - 1]; c--; } if (i >= 0 && i < GN) tmp[j * GN + i] = a / c; } }
for (let i = 0; i < GN; i++) { let a = 0, c = 0; for (let j = -r; j < GN + r; j++) { if (j + r < GN) { a += tmp[(j + r) * GN + i]; c++; } if (j - r - 1 >= 0) { a -= tmp[(j - r - 1) * GN + i]; c--; } if (j >= 0 && j < GN) m[j * GN + i] = a / c; } }
for (let k = 0; k < W2; k++) ao[k] = Math.max(-1, Math.min(0.6, (h[k] - m[k]) / 45));
const d = 18.75;
for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) { const X = ORIGIN + i * WS, Z = ORIGIN + j * WS; sl[j * GN + i] = Math.hypot(heightAt(X + d, Z) - heightAt(X - d, Z), heightAt(X, Z + d) - heightAt(X, Z - d)) / (2 * d); }
const at2 = (i: number, j: number) => h[Math.min(GN - 1, Math.max(0, j)) * GN + Math.min(GN - 1, Math.max(0, i))];
const gx = new Float32Array(W2), gz = new Float32Array(W2);
for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) { gx[j * GN + i] = (at2(i + 2, j) + at2(i + 1, j) - at2(i - 1, j) - at2(i - 2, j)) / (6 * WS); gz[j * GN + i] = (at2(i, j + 2) + at2(i, j + 1) - at2(i, j - 1) - at2(i, j - 2)) / (6 * WS); }
const cpuMs = performance.now() - t;
let top = -Infinity;
for (const v of h) if (v > top) top = v;

// ---------- the GPU's ----------
t = performance.now();
const gw = await windowGround(gpu, src(), loc.face, tx * 256, ty * 256);
const gpuMs = performance.now() - t;
const unpad = (raw: ArrayBuffer, rows: number, cols: number, pitch: number, layer: number, layerWords: number) => { const a = new Float32Array(raw, layer * layerWords * 4, layerWords), o = new Float32Array(rows * cols); for (let y = 0; y < rows; y++) o.set(a.subarray(y * pitch, y * pitch + cols), y * cols); return o; };
const fineRaw = await readback(gpu, gw.fine), gridRaw = await readback(gpu, gw.grid), maskRaw = new Uint8Array(await readback(gpu, gw.mask));
const diff = (a: Float32Array, b: Float32Array) => { let worst = 0, bits = 0; for (let i = 0; i < a.length; i++) { const e = Math.abs(a[i] - b[i]); if (e > worst) worst = e; if (a[i] !== b[i]) bits++; } return { worst, differ: bits }; };
const names = ["h", "wet", "moist", "river", "tree", "shrub", "grass", "marsh", "bare", "sand"];
let bad = 0;
const report = (name: string, a: Float32Array, b: Float32Array, bound: number) => { const e = diff(a, b); const ok = e.worst <= bound; if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(8)} max diff ${e.worst.toExponential(2)}, ${e.differ} of ${a.length} differ (bound ${bound})`); };
names.forEach((n, k) => report(n, unpad(fineRaw, M, M, FINE_PITCH, k, FINE_LAYER_WORDS), layers[k], k === 3 ? 1e-6 : 0));
let maskDiffs = 0;
for (let i = 0; i < mask.length; i++) if (mask[i] !== maskRaw[i]) maskDiffs++;
console.log(`${maskDiffs === 0 ? "ok  " : "FAIL"} mask     ${maskDiffs} of ${mask.length} bytes differ`);
if (maskDiffs) bad++;
report("grid h", unpad(gridRaw, GN, GN, GRID_PITCH, 0, GRID_LAYER_WORDS), h, 2e-3);
report("grid ao", unpad(gridRaw, GN, GN, GRID_PITCH, 1, GRID_LAYER_WORDS), ao, 1e-4);
report("grid slope", unpad(gridRaw, GN, GN, GRID_PITCH, 2, GRID_LAYER_WORDS), sl, 1e-4);
report("grid gx", unpad(gridRaw, GN, GN, GRID_PITCH, 3, GRID_LAYER_WORDS), gx, 1e-4);
report("grid gz", unpad(gridRaw, GN, GN, GRID_PITCH, 4, GRID_LAYER_WORDS), gz, 1e-4);
report("readback h", gw.h, layers[0], 0);
console.log(`top ${gw.top} against ${top}; CPU way ${cpuMs.toFixed(0)} ms, GPU way ${gpuMs.toFixed(0)} ms (cell ${CELL} m)`);
if (Math.abs(gw.top - top) > 2e-3) bad++;
await exit(bad ? 1 : 0);
