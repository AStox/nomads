// Where each plant can live, as a curve over each thing it answers to: how warm the summer, how hard the winter, how
// much water the soil holds through the growing season, how waterlogged, how sour, how rich, how much light reaches it,
// how hard the wind and the salt, how deep the soil. A curve rises from nothing to the plant's best and falls away again
// (low, best from, best to, high); a plant's fit at a place is the product of its curves there. Nothing says where a
// plant grows. It grows wherever it fits, and loses to those that fit better and stand taller.
import { CELL } from "./grid";
import { clamp } from "math";
import type { Island } from "./island";

export type Env = {
  warm: number; // summer's mean air, °C
  cold: number; // winter's mean air, °C
  water: number; // 0..1 water the soil gives roots through the growing season
  wet: number; // 0..1 how waterlogged: the water table at the surface, or peat
  ph: number;
  fert: number; // 0..1 fertility
  light: number; // 0..1 of the open sky's light reaching the plant
  wind: number; // 0..1 exposure to gales
  salt: number; // 0..1 salt spray
  soil: number; // m of soil
};
type Axis = keyof Env;
type Curve = [number, number, number, number];

const curve = (v: number, [a, b, c, d]: Curve) => {
  const up = (x: number, lo: number, hi: number) => { const t = clamp((x - lo) / (hi - lo || 1e-9), 0, 1); return t * t * (3 - 2 * t); };
  return v <= b ? up(v, a, b) : v <= c ? 1 : 1 - up(v, c, d);
};

// The plants the ground grows, by their names in flora.ts SPECIES, and the reeds and tall grass by their kinds. Trees and
// shrubs carry their height, which is how they win light from what grows under them; evergreen ones shade all year.
// vigor: how hard it competes where others fit as well, the shade-casting broadleaves most, the light-hungry pioneers
// least, so pine and aspen hold what the others can't.
export type Niche = Partial<Record<Axis, Curve>> & { tall?: number; evergreen?: boolean; vigor?: number };
export const NICHE: Record<string, Niche> = {
  pine: { warm: [8, 12, 22, 28], cold: [-25, -15, 6, 10], water: [0.15, 0.35, 1, 1.1], wet: [-1, 0, 0.3, 0.7], ph: [3.4, 4, 6.5, 8], fert: [-1, 0, 0.5, 1.2], light: [0.3, 0.7, 1, 1.1], wind: [-1, 0, 0.6, 0.95], salt: [-1, 0, 0.4, 0.7], soil: [0.1, 0.3, 9, 10], tall: 17, evergreen: true, vigor: 0.45 },
  oak: { warm: [11, 15, 25, 31], cold: [-15, -8, 8, 12], water: [0.45, 0.7, 1, 1.1], wet: [-1, 0, 0.4, 0.8], ph: [4, 4.8, 7.5, 8.5], fert: [0.03, 0.2, 1, 1.5], light: [0.2, 0.5, 1, 1.1], wind: [-1, 0, 0.4, 0.7], salt: [-1, 0, 0.3, 0.6], soil: [0.3, 0.8, 9, 10], tall: 15, vigor: 1 },
  ash: { warm: [11, 14, 25, 31], cold: [-18, -10, 8, 12], water: [0.6, 0.8, 1, 1.1], wet: [-1, 0, 0.5, 0.85], ph: [5, 6, 8, 8.6], fert: [0.12, 0.35, 1, 1.5], light: [0.1, 0.4, 1, 1.1], wind: [-1, 0, 0.35, 0.65], salt: [-1, 0, 0.3, 0.6], soil: [0.3, 0.6, 9, 10], tall: 16, vigor: 1 },
  aspen: { warm: [8, 11, 22, 28], cold: [-30, -15, 6, 10], water: [0.5, 0.75, 1, 1.1], wet: [-1, 0, 0.8, 1.05], ph: [3.8, 4.5, 7.5, 8.5], fert: [-1, 0.05, 1, 1.5], light: [0.4, 0.8, 1, 1.1], wind: [-1, 0, 0.5, 0.8], salt: [-1, 0, 0.3, 0.6], soil: [0.1, 0.3, 9, 10], tall: 13, vigor: 0.5 },
  berry: { warm: [9, 12, 25, 31], cold: [-20, -10, 8, 12], water: [0.4, 0.6, 1, 1.1], wet: [-1, 0, 0.4, 0.8], ph: [4, 4.5, 7.5, 8.5], fert: [-1, 0.1, 1, 1.5], light: [0.15, 0.5, 1, 1.1], wind: [-1, 0, 0.45, 0.75], salt: [-1, 0, 0.3, 0.6], soil: [0.05, 0.2, 9, 10], tall: 1.5, vigor: 0.8 },
  hazel: { warm: [10, 13, 25, 31], cold: [-18, -10, 8, 12], water: [0.5, 0.7, 1, 1.1], wet: [-1, 0, 0.35, 0.7], ph: [5, 6, 8, 8.6], fert: [0.1, 0.3, 1, 1.5], light: [0.1, 0.35, 1, 1.1], wind: [-1, 0, 0.4, 0.7], salt: [-1, 0, 0.3, 0.6], soil: [0.15, 0.4, 9, 10], tall: 3.5, vigor: 1 },
  heather: { warm: [5, 8, 20, 27], cold: [-25, -15, 8, 12], water: [0.15, 0.35, 1, 1.1], wet: [-1, 0, 0.8, 1.05], ph: [3.2, 3.8, 5.5, 6.6], fert: [-1, 0, 0.2, 0.5], light: [0.5, 0.8, 1, 1.1], wind: [-1, 0, 1, 1.1], salt: [-1, 0, 0.5, 0.8], soil: [0, 0.03, 9, 10], tall: 0.5, vigor: 0.6 },
  gorse: { warm: [9, 12, 25, 31], cold: [-10, -3, 10, 14], water: [0.15, 0.3, 0.9, 1.05], wet: [-1, 0, 0.3, 0.6], ph: [4, 4.5, 6.5, 7.5], fert: [-1, 0, 0.3, 0.6], light: [0.6, 0.9, 1, 1.1], wind: [-1, 0, 0.9, 1.05], salt: [-1, 0, 0.6, 0.9], soil: [0.05, 0.15, 9, 10], tall: 1.6, vigor: 0.7 },
  bolete: { water: [0.5, 0.7, 1, 1.1], wet: [-1, 0, 0.5, 0.85], ph: [3.8, 4.5, 7, 8], light: [-1, 0, 0.45, 0.8], warm: [9, 12, 25, 31] },
  chanterelle: { water: [0.65, 0.85, 1, 1.1], wet: [-1, 0, 0.5, 0.85], ph: [3.4, 4, 5.8, 7], light: [-1, 0, 0.4, 0.7], warm: [9, 12, 25, 31] },
  puffball: { water: [0.3, 0.5, 1, 1.1], fert: [0.1, 0.3, 1, 1.5], light: [0.3, 0.6, 1, 1.1], ph: [4.5, 5.5, 8, 8.6] },
  yarrow: { light: [0.5, 0.8, 1, 1.1], water: [0.15, 0.3, 0.85, 1], wet: [-1, 0, 0.3, 0.6], ph: [4.5, 5.5, 8, 8.6] },
  sorrel: { light: [0.4, 0.7, 1, 1.1], water: [0.4, 0.6, 1, 1.1], ph: [3.8, 4.5, 6.5, 7.5] },
  mint: { light: [0.4, 0.7, 1, 1.1], water: [0.75, 0.9, 1, 1.1], wet: [0.15, 0.45, 1, 1.05], fert: [0.05, 0.2, 1, 1.5] },
  bracken: { light: [0.25, 0.6, 1, 1.1], water: [0.4, 0.6, 1, 1.1], wet: [-1, 0, 0.3, 0.6], ph: [3.6, 4.2, 6.5, 7.5], soil: [0.15, 0.3, 9, 10], cold: [-20, -10, 8, 12] },
  lady_fern: { light: [-1, 0, 0.6, 0.85], water: [0.7, 0.85, 1, 1.1], wet: [-1, 0.1, 0.8, 1.05], ph: [4, 4.8, 7.5, 8.5] },
  buttercup: { light: [0.5, 0.8, 1, 1.1], water: [0.5, 0.7, 1, 1.1], wet: [-1, 0, 0.8, 1.05], fert: [0.12, 0.35, 1, 1.5] },
  daisy: { light: [0.6, 0.9, 1, 1.1], water: [0.3, 0.5, 1, 1.1], wet: [-1, 0, 0.4, 0.7], fert: [0.08, 0.25, 1, 1.5] },
  clover: { light: [0.6, 0.9, 1, 1.1], water: [0.3, 0.5, 1, 1.1], ph: [5, 6, 8, 8.6], fert: [0.05, 0.2, 1, 1.5] },
  harebell: { light: [0.6, 0.9, 1, 1.1], water: [0.15, 0.3, 0.8, 1], ph: [4.5, 5.5, 8.5, 9], fert: [-1, 0, 0.3, 0.6] },
  poppy: { light: [0.7, 0.9, 1, 1.1], water: [0.15, 0.3, 0.75, 0.95], ph: [6, 7, 8.5, 9], fert: [0.2, 0.4, 1, 1.5] },
  reeds: { water: [0.8, 0.95, 1, 1.1], wet: [0.3, 0.6, 1, 1.05], light: [0.5, 0.8, 1, 1.1], tall: 2.5 },
  grass: { light: [0.3, 0.7, 1, 1.1], water: [0.15, 0.4, 1, 1.1], wet: [-1, 0, 0.6, 0.95], soil: [0.01, 0.08, 9, 10] },
};

// How well a plant fits a place, 0 to 1. An axis the place leaves out (NaN) is not counted.
export function fit(name: string, env: Env) {
  const n = NICHE[name];
  if (!n) return 1;
  let f = 1;
  for (const axis in env) {
    const c = n[axis as Axis], v = env[axis as Axis];
    if (c && !Number.isNaN(v)) f *= curve(v, c);
  }
  return f;
}
// How well a plant takes the light it gets.
export const lightFit = (name: string, light: number) => { const c = NICHE[name]?.light; return c ? curve(light, c) : 1; };
// Of the names, one drawn with odds by how well each fits (fits[k] for names[k]), squared, and by how hard it competes
// (r: 0..1).
export function draw<T extends string>(names: readonly T[], fits: ArrayLike<number>, r: number): T {
  let sum = 0;
  for (let k = 0; k < names.length; k++) sum += fits[k] * fits[k] * (NICHE[names[k]]?.vigor ?? 1);
  if (sum <= 0) return names[0];
  let x = r * sum;
  for (let k = 0; k < names.length; k++) { x -= fits[k] * fits[k] * (NICHE[names[k]]?.vigor ?? 1); if (x <= 0) return names[k]; }
  return names[names.length - 1];
}
export function lottery<T extends string>(names: readonly T[], env: Env, r: number): T {
  return draw(names, names.map((n) => fit(n, env)), r);
}

// The place's lasting conditions at world meters x, z, read off the island (light comes from the caller: the generator's
// canopy, or the light the sim works out now).
export function envAt(isle: Island, bilinear: (f: Float32Array, cx: number, cy: number) => number, x: number, z: number, light: number, start: number): Env {
  const cx = (x - start) / CELL, cy = (z - start) / CELL, b = (f: Float32Array) => bilinear(f, cx, cy);
  return {
    warm: b(isle.seasons[1].temp), cold: b(isle.seasons[3].temp), water: b(isle.moist), wet: Math.max(Math.exp(-b(isle.table) / 0.5), b(isle.peat)),
    ph: b(isle.ph), fert: b(isle.fertility), light, wind: b(isle.exposure), salt: b(isle.salt), soil: b(isle.soil),
  };
}
