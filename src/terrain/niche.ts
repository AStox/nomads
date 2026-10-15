// Where each plant can live, as a curve over each thing of the ground it answers to: how sour the soil is and how near
// the water table stands. A curve rises from nothing to the plant's best and falls away again (low, best from, best to,
// high); a plant's fit at a place is its lowest curve there, as the Forestry Commission's Ecological Site Classification
// takes the lowest of a tree's ratios (R606 p. 34). Light is no curve for a green plant: what it makes of the light that
// reaches it is its carbon (growth.ts), and so are its warmth and its soil water, which growth.ts counts once. Fungi keep
// a light curve. Nothing says where a plant grows. It grows wherever it fits, and loses to those that stand taller where
// they can keep themselves (ground.ts). The numbers are in docs/research/terrain-constants.md sec. 13.
import { CELL } from "./grid";
import { clamp } from "math";
import type { Island } from "./island";

export type Env = {
  ph: number; // soil pH (water)
  table: number; // depth to the winter water table, m (water.ts winterTable)
  light: number; // 0..1 of the open sky's light reaching the plant (only fungi's niches read it)
  // read by no curve, only by what the game's people make of a spot (sim.ts CONDITIONS):
  wind: number; // the year's wind there against the coast's, 0..1 (climate.ts windShare)
  salt: number; // 0..1 salt spray
  soil: number; // m of soil
};
type Axis = keyof Env;
type Curve = [number, number, number, number];

const curve = (v: number, [a, b, c, d]: Curve) => {
  const up = (x: number, lo: number, hi: number) => { const t = clamp((x - lo) / (hi - lo || 1e-9), 0, 1); return t * t * (3 - 2 * t); };
  return v <= b ? up(v, a, b) : v <= c ? 1 : 1 - up(v, c, d);
};

// pH. The ESC's soil nutrient regimes by the topsoil pH (water, 0 to 25 cm) of each (R606 Table 8): very poor and poor
// 3.0 to 4.0, medium to 5.0, rich to 5.5, very rich 4.5 to 7.5, carbonate 7.5 to 8.5. The classes overlap, as humus
// form separates them too; here each takes the band from the one below's top to its own top [derived].
const SNR = { poor: [3, 4], medium: [4, 5], rich: [5, 5.5], veryRich: [5.5, 7.5], carbonate: [7.5, 8.5] } as const;
type Snr = keyof typeof SNR;
const ORDER: Snr[] = ["poor", "medium", "rich", "veryRich", "carbonate"];
// A tree's pH curve from its ESC suitability (R606 Fig. 14): best over its very suitable classes, falling to nothing
// across its suitable ones to the first unsuitable [derived].
const tree = (best: [Snr, Snr], fit: [Snr, Snr]): Curve => [SNR[fit[0]][0], SNR[best[0]][0], SNR[best[1]][1], SNR[fit[1]][1]];
// A plant of the open ground's pH curve from its Hill-Ellenberg reaction (R) and nitrogen (N) values (R605): the ESC
// converts R + N into a nutrient regime (R606 Table 15: under 5.7 very poor, to 7.7 poor, to 9.7 medium, to 11.7 rich,
// above very rich; carbonate where R is over 6 and N under 4.5). It is best over that class's band, falling to nothing
// across the classes either side [design: one class either side, as a tree's suitable ring].
const herb = (R: number, N: number): Curve => {
  const s = R + N, k = ORDER.indexOf(R > 6 && N < 4.5 ? "carbonate" : s < 7.7 ? "poor" : s < 9.7 ? "medium" : s < 11.7 ? "rich" : "veryRich");
  return [SNR[ORDER[Math.max(0, k - 1)]][0], SNR[ORDER[k]][0], SNR[ORDER[k]][1], SNR[ORDER[Math.min(ORDER.length - 1, k + 1)]][1]];
};

// The water table. The ESC's soil moisture regimes by the mean winter water table (R606 Table 5): very wet under 0.2 m,
// wet 0.2 to 0.4, very moist 0.4 to 0.6, moist 0.6 to 0.8, fresh 0.8 to 1.0, the drier regimes freely drained. The
// curves read water.ts's winter table. A curve rises from the regime where a plant first fits to where it is best, and
// stays there on drier ground, where drought is its water's (growth.ts watered).
const DEEP = Infinity;
// The trees by ESC Fig. 13 (R606): pine suitable in very moist ground and very suitable in moist or drier; pedunculate
// oak, ash and aspen suitable in wet and very suitable from very moist [derived].
const PINE_TABLE: Curve = [0.4, 0.6, DEEP, DEEP], BROAD_TABLE: Curve = [0.2, 0.4, DEEP, DEEP];
// Plants of the open ground by their Hill-Ellenberg moisture value F (R605) on the same regimes, read from the scale's
// own words (F7 constantly moist but not wet, F8 between, F9 waterlogged, F10 shallow water: R605 Table 10) as a rough
// guide (the ESC finds F predicts the regime poorly, R606 p. 24) [derived, UNVERIFIED]: F6 and under as a broadleaf
// tree's wettest moist regime and drier; F7 from very moist; F8 best in wet ground, gone by moist and on the surface;
// F9 and over best in very wet ground, gone by very moist.
const moistF = (F: number): Curve => (F <= 6 ? [0.4, 0.6, DEEP, DEEP] : F === 7 ? [0.2, 0.4, DEEP, DEEP] : F === 8 ? [0, 0.2, 0.4, 0.6] : [-1, -1, 0.2, 0.4]);

// The plants the ground grows, by their names in flora.ts SPECIES, and the reeds and grass by their kinds. Trees and
// shrubs carry their height, m, the most their kind grows (PLANTATT, R605), which is how they win light from what grows
// under them. Wind, salt and frost bound none of them on this island: every species here but gorse spans 45 to 60 N
// and over in Europe, and Bornholm's climate lies inside every one's British envelope (R605); the ESC's wind limits are
// in its DAMS score, which has no conversion to the wind's speed [gap]; salt tolerance needs chloride in the soil water,
// mg/l, where the generator has only a 0..1 spray [gap]; the ESC's rooting depths limit only ash, on shallow soil over
// rock, by an amount not given (R608) [gap]. Gorse (Ulex europaeus) is gone: it was sown in Denmark in the early 1700s as
// game cover and whether it is native there is disputed (R610), it is frost-tender at the edge of its range (R609), and
// Bornholm holds 20 records of it against 2,257 of heather (R611).
export type Niche = Partial<Record<Axis, Curve>> & { tall?: number };
export const NICHE: Record<string, Niche> = {
  // ESC Fig. 14: pine S V V S S U; pedunculate oak U S V V V U; ash U U S V V S; aspen U S V V V U (very poor, poor,
  // medium, rich, very rich, carbonate); very poor and poor share a band, so pine's very suitable poor reaches down to 3.
  pine: { ph: tree(["poor", "medium"], ["poor", "veryRich"]), table: PINE_TABLE, tall: 30 },
  oak: { ph: tree(["medium", "veryRich"], ["poor", "veryRich"]), table: BROAD_TABLE, tall: 30 },
  ash: { ph: tree(["rich", "veryRich"], ["medium", "carbonate"]), table: BROAD_TABLE, tall: 25 },
  aspen: { ph: tree(["medium", "veryRich"], ["poor", "veryRich"]), table: BROAD_TABLE, tall: 20 },
  // Hill-Ellenberg F, R, N (R605): bramble 6 6 6, hazel 5 6 6, heather 6 2 2
  berry: { ph: herb(6, 6), table: moistF(6), tall: 2 },
  hazel: { ph: herb(6, 6), table: moistF(5), tall: 6 },
  heather: { ph: herb(2, 2), table: moistF(6), tall: 0.6 },
  // Fungi have no indicator values and want a host tree the generator doesn't track [gap]: the old light curves stand
  // in, the woodland fungi in the shade and the puffball in the open.
  bolete: { light: [-1, 0, 0.45, 0.8] },
  chanterelle: { light: [-1, 0, 0.4, 0.7] },
  puffball: { light: [0.3, 0.6, 1, 1.1] },
  // F, R, N (R605): yarrow 5 6 4, sorrel 5 5 4, water mint 8 7 5, bracken 5 3 3, lady fern 7 5 6, meadow buttercup 6 6 4,
  // daisy 5 6 4, white clover 5 6 6, harebell 4 5 2, poppy 5 7 6, common reed 10 7 6
  yarrow: { ph: herb(6, 4), table: moistF(5) },
  sorrel: { ph: herb(5, 4), table: moistF(5) },
  mint: { ph: herb(7, 5), table: moistF(8) },
  bracken: { ph: herb(3, 3), table: moistF(5) },
  lady_fern: { ph: herb(5, 6), table: moistF(7) },
  buttercup: { ph: herb(6, 4), table: moistF(6) },
  daisy: { ph: herb(6, 4), table: moistF(5) },
  clover: { ph: herb(6, 6), table: moistF(5) },
  harebell: { ph: herb(5, 2), table: moistF(4) },
  poppy: { ph: herb(7, 6), table: moistF(5) },
  reeds: { ph: herb(7, 6), table: moistF(10), tall: 2.7 },
  // the sward: red fescue, common bent, Yorkshire fog, cock's-foot and sweet vernal grass, their mean F 5.4, R 5.4 and N
  // 4.6 (R605) [derived]
  grass: { ph: herb(5.4, 4.6), table: moistF(5) },
};
// The tallest anything grows on the island, m.
export const TALLEST = Math.max(...Object.values(NICHE).map((n) => n.tall ?? 0));
// The woody plants that compete for each place, by form, as ground.ts and flora.ts read them.
export const TREES = ["pine", "oak", "ash", "aspen"] as const;
export const SHRUBS = ["berry", "hazel", "heather"] as const;

// How well a plant fits a place, 0 to 1: its lowest curve there (R606 p. 34). An axis the place leaves out (NaN) is not
// counted.
export function fit(name: string, env: Env) {
  const n = NICHE[name];
  if (!n) return 1;
  let f = 1;
  for (const axis in env) {
    const c = n[axis as Axis], v = env[axis as Axis];
    if (c && !Number.isNaN(v)) f = Math.min(f, curve(v, c));
  }
  return f;
}
// How well a fungus takes the light it gets (a green plant's light is its carbon, growth.ts).
export const lightFit = (name: string, light: number) => { const c = NICHE[name]?.light; return c ? curve(light, c) : 1; };
// Of the names, one drawn with odds by how well each does there (weights[k] for names[k]: its fit, and for a green plant
// how far its light clears what it needs, flora.ts), r: 0..1.
export function draw<T extends string>(names: readonly T[], weights: ArrayLike<number>, r: number): T {
  let sum = 0;
  for (let k = 0; k < names.length; k++) sum += weights[k];
  if (sum <= 0) return names[0];
  let x = r * sum;
  for (let k = 0; k < names.length; k++) { x -= weights[k]; if (x <= 0) return names[k]; }
  return names[names.length - 1];
}

// The place's lasting conditions at world meters x, z, read off the island (light comes from the caller: the generator's
// canopy, or the light the sim works out now).
export function envAt(isle: Island, bilinear: (f: Float32Array, cx: number, cy: number) => number, x: number, z: number, light: number, start: number): Env {
  const cx = (x - start) / CELL, cy = (z - start) / CELL, b = (f: Float32Array) => bilinear(f, cx, cy);
  return { ph: b(isle.ph), table: b(isle.winterTable), light, wind: b(isle.windShare), salt: b(isle.salt), soil: b(isle.soil) };
}
