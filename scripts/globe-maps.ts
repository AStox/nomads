// Look at the globe: PNG maps of named per-cell fields of the tier-0 grid, an equirectangular map (longitude across,
// latitude up, sampled through the grid's own lookup) and a cube net (the six faces in their own axes, east to the right
// and north up for the four round the equator, the north and south faces' own x to the right and y up, so the seams of
// the polar faces to the equatorial ones are turned a quarter). Built for the plate tectonics unit and meant for the
// units after it: a unit hands `writeLayers` its fields as `Layer`s (a name and a colour for each flat cell number).
//   bun scripts/globe-maps.ts --seed 1 --out /tmp/globe-1 [--span 200] [--plates 10] [--layers height,lithology,...] [--sea 0] [--width 1440]
// The layers it knows for tectonics: height, relief (height with the sea shown flat), lithology, plates, boundaries,
// thickness, crust, age, orogeny, start (the planet at time zero's height).
import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { FACES, cellId, locate, type Grid } from "../src/gpu/globe/grid";
import { BOUNDARY, DEFAULTS, LITH_NAMES, classifyBoundaries, derive, extTables, makeSetup, startingState, Tectonics, type Derived, type Setup } from "../src/gpu/globe/tectonics";
import { theGpu, releaseGpu } from "../src/gpu/device";

export type RGB = [number, number, number];
export interface Layer { name: string; color: (i: number) => RGB }

export function png(w: number, h: number, rgb: Uint8Array): Buffer {
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

export const mix = (a: readonly number[], b: readonly number[], t: number): RGB => {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
};
// A colour ramp through stops (position, rgb), positions rising.
export function ramp(stops: readonly (readonly [number, RGB])[], x: number): RGB {
  if (x <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) if (x <= stops[k][0]) return mix(stops[k - 1][1], stops[k][1], (x - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]));
  return stops[stops.length - 1][1];
}
// A colour for each integer class, spread round the hue wheel by the golden angle.
export const classColor = (k: number): RGB => {
  const h = ((k * 137.508) % 360) / 60, c = 0.75 * 0.85, x = c * (1 - Math.abs((h % 2) - 1)), m = 0.85 - c, rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
};

// Equirectangular map of one layer, width x width/2 pixels.
export function equirect(g: Grid, layer: Layer, width: number): Buffer {
  const w = width, h = width / 2, rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const lat = (0.5 - (y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w - 0.5) * 2 * Math.PI, p = locate(g, lat, lon), c = layer.color(cellId(g, p.face, p.X, p.Y)), o = (y * w + x) * 3;
      rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
    }
  }
  return png(w, h, rgb);
}
// The cube net: a cross of 4 by 3 faces; empty corners grey.
export function cubeNet(g: Grid, layer: Layer, scale = 2): Buffer {
  const n = g.fn, s = scale, w = 4 * n * s, h = 3 * n * s, rgb = new Uint8Array(w * h * 3).fill(40);
  const place: [number, number][] = [[1, 1], [2, 1], [3, 1], [0, 1], [1, 0], [1, 2]]; // faces 0 to 5: column, row
  for (let f = 0; f < FACES; f++) {
    const [cx, cy] = place[f];
    for (let Y = 0; Y < n; Y++)
      for (let X = 0; X < n; X++) {
        const c = layer.color(cellId(g, f, X, Y));
        for (let dy = 0; dy < s; dy++)
          for (let dx = 0; dx < s; dx++) {
            const px = cx * n * s + X * s + dx, py = cy * n * s + (n - 1 - Y) * s + dy, o = (py * w + px) * 3;
            rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
          }
      }
  }
  return png(w, h, rgb);
}
// Write every layer as <out>/<name>.png (equirectangular) and <out>/<name>-net.png.
export function writeLayers(g: Grid, out: string, layers: Layer[], width = 1440, net = true): string[] {
  mkdirSync(out, { recursive: true });
  const paths: string[] = [];
  for (const l of layers) {
    Bun.write(`${out}/${l.name}.png`, equirect(g, l, width)); paths.push(`${out}/${l.name}.png`);
    if (net) { Bun.write(`${out}/${l.name}-net.png`, cubeNet(g, l)); paths.push(`${out}/${l.name}-net.png`); }
  }
  return paths;
}

// ---- the tectonics layers ----
const SEA: RGB[] = [[8, 20, 70], [20, 60, 130], [60, 130, 190], [150, 200, 220]];
// Height in m above sea level: deep blue to pale shallows, then green lowlands, tan, brown, and white over 5 km.
export function heightColor(z: number): RGB {
  if (z <= 0) return ramp([[-7000, SEA[0]], [-4000, SEA[1]], [-1000, SEA[2]], [0, SEA[3]]], z);
  return ramp([[0, [70, 140, 70]], [500, [140, 170, 80]], [1500, [190, 170, 100]], [3000, [140, 100, 70]], [4500, [200, 190, 180]], [6500, [255, 255, 255]]], z);
}
export const LITH_COLORS: RGB[] = [[70, 80, 100], [225, 205, 120], [130, 90, 150], [215, 120, 120], [230, 130, 40]];

export function tectonicLayers(set: Setup, d: Derived, start?: Derived): Layer[] {
  const bd = classifyBoundaries(set.grid, d.plate, set.plates);
  const layers: Layer[] = [
    { name: "height", color: (i) => heightColor(d.height[i]) },
    { name: "relief", color: (i) => (d.height[i] <= 0 ? [30, 70, 130] : heightColor(d.height[i])) },
    { name: "lithology", color: (i) => LITH_COLORS[d.lith[i]] },
    { name: "plates", color: (i) => classColor(d.plate[i]) },
    { name: "boundaries", color: (i) => (bd.cls[i] === BOUNDARY.convergent ? [230, 30, 30] : bd.cls[i] === BOUNDARY.divergent ? [60, 120, 255] : bd.cls[i] === BOUNDARY.transform ? [40, 200, 80] : mix([60, 60, 60], [200, 200, 200], d.land[i])) },
    { name: "thickness", color: (i) => ramp([[0, [20, 10, 60]], [6000, [40, 80, 150]], [20000, [60, 170, 140]], [35000, [220, 220, 80]], [55000, [240, 130, 40]], [80000, [255, 255, 255]]], d.thickness[i]) },
    { name: "crust", color: (i) => (d.continental[i] ? [200, 150, 90] : [50, 90, 150]) },
    { name: "age", color: (i) => (d.continental[i] ? [150, 150, 150] : ramp([[0, [255, 60, 30]], [40, [250, 200, 60]], [100, [60, 190, 120]], [200, [40, 70, 190]], [400, [40, 20, 90]]], d.ageMy[i])) },
    { name: "orogeny", color: (i) => ramp([[0, [255, 255, 255]], [20, [255, 120, 30]], [80, [140, 40, 120]], [200, [40, 40, 60]]], d.orogenyMy[i]) },
  ];
  if (start) layers.push({ name: "start", color: (i) => heightColor(start.height[i]) });
  return layers;
}

if (import.meta.main) {
  const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
  const seed = Number(arg("seed", "1")), out = arg("out", `/tmp/globe-${seed}`), width = Number(arg("width", "1440"));
  const want = arg("layers", "").split(",").filter(Boolean);
  const set = makeSetup({ seed, spanMy: Number(arg("span", String(DEFAULTS.spanMy))), plates: Number(arg("plates", String(DEFAULTS.plates))), seaLevel: Number(arg("sea", "0")) });
  const ext = extTables(set.grid), start = startingState(set, ext.tab), gpu = await theGpu(), tec = new Tectonics(gpu, set, ext, start.S);
  tec.elevate();
  const d0 = derive(set, ext.tab, await tec.read());
  for (let s = 0; s < set.steps; s++) tec.step();
  tec.elevate();
  const d = derive(set, ext.tab, await tec.read());
  const layers = tectonicLayers(set, d, d0).filter((l) => want.length === 0 || want.includes(l.name));
  for (const p of writeLayers(set.grid, out, layers, width)) console.log(p);
  console.log(`seed ${seed}: lithology classes ${LITH_NAMES.join(", ")}`);
  await releaseGpu();
  process.exit(0);
}
