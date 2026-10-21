// Pictures of the 75 m tier (the planet made by scripts/globe-tiers.ts and the fine stages): a whole face downsampled, and patches of 19.2 km at full 75 m, one across a face's
// edge, each as height (hillshaded), rivers, rain and cover where those stages have been made. PNGs go to /tmp/planet-75m/maps/.
//   bun scripts/globe-maps75.ts --seed 1 --key 4c2a2cb36ba6 --face 1 --patches 320:0:0,1214:0:0,40:0:0
// A patch is `tile:dx:dy`: the tile's own cells moved by (dx, dy) cells (a negative dx on a tile on a face's west edge reaches across the edge).
import { mkdirSync, writeFileSync } from "node:fs";
import { cellAcross } from "../src/gpu/globe/patch";
import { SMALL_RADIUS_M, tierGrid } from "../src/gpu/globe/grid";
import { bakeDir } from "../src/gpu/globe/bakedir";
import { heightColor, mix, png, type RGB } from "./globe-maps";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const key = arg("key", process.env.NOMADS_PLANET_KEY ?? ""), seed = Number(arg("seed", "1"));
if (!key) throw new Error("name the planet's key: --key <hash> (the directory under /tmp/planet-75m is <seed>-<key>)");
const dir = bakeDir(seed, key), OUT = "/tmp/planet-75m/maps";
mkdirSync(OUT, { recursive: true });
const g = tierGrid(4), FN = g.fn;
// 1 unit of the discharge area (t4-acc) is 1/512 of a tier-4 cell's area at the reference rain
const CELL_M2 = (4 * Math.PI * SMALL_RADIUS_M ** 2) / (6 * FN * FN), RIVER_M2 = Number(arg("river-km2", "2")) * 1e6;
const areaM2 = (acc: number) => ((acc >>> 0) * CELL_M2) / 512;
const WATER: RGB = [50, 100, 200], RIVER: RGB = [30, 80, 210];

const height = dir.i32("t4-height"), acc = dir.u32("t4-acc"), flooded = dir.i32("t4-flooded");
const has = (f: string) => dir.has(f);
const optional = <T>(file: string, load: () => T): T | null => (has(file) ? load() : null);

// ---- a whole face, downsampled by DS ----
function faceMap(face: number, DS: number) {
  const n = FN / DS, rgb = new Uint8Array(n * n * 3), base = face * FN * FN;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let hs = 0, river = 0, lake = 0;
      for (let dy = 0; dy < DS; dy++) for (let dx = 0; dx < DS; dx++) {
        const i = base + (y * DS + dy) * FN + x * DS + dx;
        hs += height[i]; if (height[i] > 0 && areaM2(acc[i]) >= RIVER_M2) river++; if (height[i] > 0 && flooded[i] - height[i] >= 256 * 0.5) lake++;
      }
      hs /= 256 * DS * DS;
      let c = heightColor(hs);
      if (hs > 0) { const s = 0.75 + 0.25 * Math.min(1, hs / 3000); c = [c[0] * s, c[1] * s, c[2] * s]; }
      if (lake > 0) c = mix(c, WATER, 0.7);
      if (river > 0) c = mix(c, RIVER, Math.min(1, 0.45 + river / (DS * 2)));
      const o = ((n - 1 - y) * n + x) * 3; // north up
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  writeFileSync(`${OUT}/face${face}-height-rivers.png`, png(n, n, rgb));
}

// ---- a patch at full resolution ----
type Window = { ids: Int32Array; size: number; name: string };
function windowOf(tile: number, dx: number, dy: number): Window {
  const f = Math.floor(tile / 256), ty = Math.floor((tile % 256) / 16), tx = tile % 16, size = 256, ids = new Int32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let id = cellAcross(g, f, tx * 256 + x + dx, ty * 256 + y + dy);
    if (id < 0) id = cellAcross(g, f, Math.min(FN - 1, Math.max(0, tx * 256 + x + dx)), Math.min(FN - 1, Math.max(0, ty * 256 + y + dy)));
    ids[y * size + x] = id;
  }
  return { ids, size, name: `tile${tile}${dx || dy ? `-${dx}_${dy}` : ""}` };
}
const SCALE = 3;
function write(w: Window, layer: string, color: (k: number, x: number, y: number) => RGB) {
  const n = w.size * SCALE, rgb = new Uint8Array(n * n * 3);
  for (let y = 0; y < w.size; y++) for (let x = 0; x < w.size; x++) {
    const c = color(y * w.size + x, x, y);
    for (let sy = 0; sy < SCALE; sy++) for (let sx = 0; sx < SCALE; sx++) { const o = (((w.size - 1 - y) * SCALE + (SCALE - 1 - sy)) * n + x * SCALE + sx) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
  }
  writeFileSync(`${OUT}/${w.name}-${layer}.png`, png(n, n, rgb));
}
function patchMaps(w: Window) {
  const z = (k: number) => height[w.ids[k]] / 256, at = (x: number, y: number) => z(Math.min(w.size - 1, Math.max(0, y)) * w.size + Math.min(w.size - 1, Math.max(0, x)));
  const L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const shaded = (k: number, x: number, y: number): RGB => {
    const hz = z(k), c = heightColor(hz);
    if (hz <= 0) return c;
    const sx = (at(x + 1, y) - at(x - 1, y)) / 150, sy = (at(x, y + 1) - at(x, y - 1)) / 150, nz = 1 / Math.hypot(sx, sy, 1), s = Math.max(0.2, -sx * nz * L[0] - sy * nz * L[1] + nz * L[2]);
    return [Math.min(255, c[0] * s * 1.3), Math.min(255, c[1] * s * 1.3), Math.min(255, c[2] * s * 1.3)];
  };
  write(w, "height", shaded);
  // rivers: the water stage's mean flow where it has been made (log scale from 0.3 m3/s), else the drainage area; lakes at the flooded surface or the stage's standing water
  const flow = optional("t4-flow.u32", () => dir.u32("t4-flow")), water = optional("t4-water.u16", () => new Uint16Array(dir.raw("t4-water.u16")));
  write(w, "rivers", (k, x, y) => {
    const i = w.ids[k], c = shaded(k, x, y);
    if (height[i] > 0 && (water ? water[i] > 0 : flooded[i] - height[i] >= 128)) return WATER;
    if (height[i] <= 0) return c;
    const strength = flow ? Math.log10(flow[i] / 65536 / 0.3) / 2 : Math.log10(areaM2(acc[i]) / (RIVER_M2 / 8)) / 2;
    return strength > 0 ? mix(c, RIVER, Math.min(1, 0.4 + 0.6 * strength)) : c;
  });
  // rain, mm a year: cream under 300 to deep violet over 6 m, on a log scale
  if (["t4-pr0.u16", "t4-pr1.u16", "t4-pr2.u16", "t4-pr3.u16"].every((f) => has(f))) {
    const pr = [0, 1, 2, 3].map((s) => new Uint16Array(dir.raw(`t4-pr${s}.u16`)));
    write(w, "rain", (k) => {
      const i = w.ids[k];
      if (height[i] <= 0) return heightColor(height[i] / 256);
      const mm = pr.reduce((a, p) => a + (p[i] / 360) ** 2, 0), t = Math.max(0, Math.min(1, Math.log10(Math.max(mm, 1) / 100) / 2.3));
      return mix([250, 240, 200], [60, 20, 120], t);
    });
  }
  // cover: the island's colours for the shares of tree, shrub, grass, marsh and bare ground (mixed as the page's ground does), water and sea blue
  if (["t4-tree.u8", "t4-shr.u8", "t4-grs.u8", "t4-mar.u8", "t4-bare.u8"].every((f) => has(f))) {
    const [tree, shr, grs, mar, bare] = ["t4-tree", "t4-shr", "t4-grs", "t4-mar", "t4-bare"].map((f) => new Uint8Array(dir.raw(`${f}.u8`)));
    const parts: RGB[] = [[30, 90, 40], [110, 130, 60], [170, 200, 90], [80, 150, 140], [150, 145, 140]];
    write(w, "cover", (k, x, y) => {
      const i = w.ids[k];
      if (height[i] <= 0) return heightColor(height[i] / 256);
      if (water ? water[i] > 0 : flooded[i] - height[i] >= 128) return WATER;
      const s = [tree[i], shr[i], grs[i], mar[i], bare[i]], t = s.reduce((a, b) => a + b, 0) || 1, c = [0, 1, 2].map((m) => s.reduce((a, v, n) => a + (v / t) * parts[n][m], 0)) as RGB;
      const sh = shaded(k, x, y), lum = (sh[0] + sh[1] + sh[2]) / (3 * 150);
      return [Math.min(255, c[0] * lum), Math.min(255, c[1] * lum), Math.min(255, c[2] * lum)];
    });
  }
}

if (import.meta.main) {
  const face = Number(arg("face", "1")), patches = arg("patches", "320:0:0,1214:0:0,40:0:0").split(",").map((s) => s.split(":").map(Number));
  faceMap(face, 4);
  for (const [tile, dx, dy] of patches) patchMaps(windowOf(tile, dx ?? 0, dy ?? 0));
  console.log(`maps in ${OUT}`);
  void optional;
}
