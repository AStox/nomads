// An island built from physics rather than painted on: rock raised by uplift and carved by rivers and slope creep,
// then rained on by its own climate. Lakes, rivers, groundwater, soil and plants all follow from that.
import { clamp } from "math";
import { domainWarp2, fbm, ridged, simplex2d } from "math/noise";
import { CELL, LEN, N, accumulate, blur, distance, flood, ramp, receivers } from "./grid";
import { climate, type Climate } from "./climate";
import { ground, type Ground } from "./ground";
import { ROCKS, rockOf } from "./geology";
import { hydrology, type Hydro } from "./water";

// Where the island rises: a warped oval, lifted hardest along a few ridged ranges and least in its lowland basins.
// Its bedrock comes in bands of harder and softer rock, and of rock rich in bases and rock poor in them.
function uplift(rand: () => number) {
  const gen = () => simplex2d.create(Math.floor(rand() * 65536));
  const warp = gen(), coast = gen(), ranges = gen(), basins = gen();
  const tilt = rand() * Math.PI, stretch = 0.8 + rand() * 0.35;
  // the chemistry's noise is seeded from the hardness's, so the random stream (and every island shape) stays as it was
  const rockSeed = Math.floor(rand() * 65536), rock = simplex2d.create(rockSeed), bases = simplex2d.create((rockSeed * 7919 + 4099) & 0xffff);
  const p: [number, number] = [0, 0];
  const warped = (a: number, b: number) => simplex2d.sample(warp, a, b);
  const mask = new Float32Array(LEN), lift = new Float32Array(LEN), hard = new Float32Array(LEN), chem = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N;
    let u = ((x + 0.5) / N) * 2 - 1, v = ((y + 0.5) / N) * 2 - 1;
    [u, v] = domainWarp2(p, warped, u * 1.3, v * 1.3, 0.22);
    u /= 1.3; v /= 1.3;
    const ru = u * Math.cos(tilt) + v * Math.sin(tilt), rv = -u * Math.sin(tilt) + v * Math.cos(tilt);
    const d = Math.hypot(ru * stretch, rv / stretch) + fbm((f) => simplex2d.sample(coast, u * 3 * f, v * 3 * f), 4, 2, 0.5) * 0.12;
    const edge = clamp(Math.min(x, y, N - 1 - x, N - 1 - y) / 7, 0, 1);
    mask[i] = clamp((0.98 - d) / 0.3, 0, 1) * edge;
    const range = ridged((f) => simplex2d.sample(ranges, u * 1.8 * f, v * 1.8 * f), 3, 2, 0.45);
    const lowland = clamp(0.55 + simplex2d.sample(basins, u * 1.4, v * 1.4) * 0.9, 0.15, 1);
    lift[i] = mask[i] ** 2 * (0.3 + 0.7 * range * range) * lowland;
    hard[i] = clamp(0.5 + fbm((f) => simplex2d.sample(rock, u * 2.4 * f, v * 2.4 * f), 3, 2, 0.5) * 0.9, 0, 1);
    chem[i] = clamp(0.5 + fbm((f) => simplex2d.sample(bases, u * 1.8 * f, v * 1.8 * f), 3, 2, 0.5) * 0.9, 0, 1);
  }
  return { mask, lift, hard, chem };
}

// Uplift against the stream power law (Braun and Willett 2013, implicit, n = 1): each step the land rises, rivers cut
// down in proportion to the square root of the water they carry, and slopes creep smooth. The water is the rain that
// runs off rather than soaking in: more of it on the heights, which wring more rain from the air, and less off rock
// that lets it in, so limestone and sandstone keep broad, dry uplands while mudstone and granite gather it into streams.
// How fast a stream cuts, and how fast a slope creeps, is the rock's: slower through hard rock, which is left standing
// proud, and each kind of rock its own way (geology.ts ROCKS incise, creep), eased a little across the contacts so they
// show as scarps rather than steps. Depressions keep their floors, so the landscape can still hold lakes. Heights come
// out in arbitrary units for the caller to scale.
function erode(rand: () => number, steps: number, watch?: Watch) {
  const { mask, lift, hard, chem } = uplift(rand);
  const h = new Float32Array(LEN), next = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) h[i] = mask[i] > 0 ? mask[i] * 0.02 : -0.05;
  const cut = new Float32Array(LEN), slide = new Float32Array(LEN), shed = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const r = ROCKS[rockOf(hard[i], chem[i])];
    cut[i] = (1.3 - hard[i]) * r.incise;
    slide[i] = (1.3 - hard[i]) * r.creep;
    shed[i] = Math.max(0.1, 0.9 - 0.8 * r.perm);
  }
  const K0 = blur(cut, 1), C0 = blur(slide, 1), runoff = blur(shed, 1), water = new Float32Array(LEN);
  if (watch) watch({ stage: "rock", rock: Uint8Array.from(hard, (v, i) => rockOf(v, chem[i])), lift });
  // The implicit scheme stays stable at any step, and 50 long steps land where 120 short ones do.
  const dt = 120 / steps, K = 0.25 * dt, CREEP = 0.04 * dt, RISE = 0.01 * dt;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < LEN; i++) h[i] += lift[i] * RISE;
    const { filled, order } = flood(h, 1e-6);
    const { to, far } = receivers(filled, 0);
    // each cell's runoff, the heights' rain up to half again the lowlands', scaled so a cell sheds one on average
    let top = 1e-9, sum = 0, land = 0;
    for (let i = 0; i < LEN; i++) top = Math.max(top, h[i]);
    for (let i = 0; i < LEN; i++) { water[i] = runoff[i] * (1 + 0.5 * clamp(h[i] / top, 0, 1)); if (h[i] > 0) { sum += water[i]; land++; } }
    const mean = land ? sum / land : 1;
    for (let i = 0; i < LEN; i++) water[i] /= mean;
    const carried = accumulate(order, to, water);
    for (let k = 0; k < LEN; k++) {
      const i = order[k], j = to[i];
      if (j === i) continue;
      const f = (K * K0[i] * Math.sqrt(Math.max(0, carried[i]))) / far[i], lower = (h[i] + f * h[j]) / (1 + f);
      if (lower < h[i]) h[i] = lower;
    }
    next.set(h);
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (h[i] <= 0) continue;
        next[i] = h[i] + CREEP * C0[i] * (h[i - 1] + h[i + 1] + h[i - N] + h[i + N] - 4 * h[i]);
      }
    h.set(next);
    watch?.({ stage: "erode", step: s, steps, height: h, flow: carried });
  }
  return { h, hard, chem };
}

export type Island = Climate & Ground & Hydro & {
  height: Float32Array; // ground elevation, m; the sea floor is below zero
  rock: Uint8Array; // the bedrock, an index into geology.ts ROCKS
};

// What the generator has made so far, for anyone who wants to watch it work: each stage's fields as they stand. They are
// the generator's own arrays, valid during the call: copy what you keep. Erosion's heights are in its own units, rising.
export type Stage =
  | { stage: "rock"; rock: Uint8Array; lift: Float32Array }
  | { stage: "erode"; step: number; steps: number; height: Float32Array; flow: Float32Array }
  | { stage: "ice"; height: Float32Array; trough: Float32Array }
  | { stage: "climate"; height: Float32Array; precip: Float32Array; temp: Float32Array; snow: Float32Array; wind: [number, number] }
  | { stage: "water"; height: Float32Array; water: Float32Array; table: Float32Array; rivers: Hydro["rivers"]; springs: Hydro["springs"]; quick: number[] }
  | { stage: "soil"; height: Float32Array; water: Float32Array; rock: Uint8Array; ph: Float32Array; fertility: Float32Array }
  | { stage: "cover"; height: Float32Array; water: Float32Array; tree: Float32Array; shrub: Float32Array; grass: Float32Array; marsh: Float32Array; bare: Float32Array; sand: Float32Array };
export type Watch = (s: Stage) => void;

export function generateIsland(rand: () => number, watch?: Watch): Island {
  // Peaks rise with the island: 250 to 450 m on one 9.6 km across, higher on a bigger one, as its ranges are longer.
  const peak = (250 + rand() * 200) * Math.sqrt((N * CELL) / 9600);
  const { h: raw, hard, chem } = erode(rand, 50, watch);
  const rock = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) rock[i] = rockOf(hard[i], chem[i]);
  let top = 0;
  for (let i = 0; i < LEN; i++) top = Math.max(top, raw[i]);
  const height = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) height[i] = raw[i] > 0 ? (raw[i] / top) * peak : Math.max(-60, raw[i] * 1200);
  // The ice of the last cold age scoured the big valleys into troughs some 400 m wide, deepest where it ran thickest over
  // soft rock and hardly at all over hard, which it left standing as sills across the valley floors; melting back, it
  // dropped hummocks of moraine on them. Behind the sills and among the hummocks lie the island's lakes.
  const hummocks = simplex2d.create(Math.floor(rand() * 65536));
  const before = flood(height, 1e-4), drained = accumulate(before.order, receivers(before.filled, 0).to);
  const line = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) if (height[i] > 2) line[i] = 5 * 40 * ramp(Math.log10(drained[i]), 2.3, 3.6) * clamp(1.15 - 1.4 * hard[i], 0, 1);
  const trough = blur(line, 2);
  for (let i = 0; i < LEN; i++) {
    if (height[i] <= 2) continue;
    const x = i % N, y = (i - x) / N, floor = ramp(Math.log10(drained[i]), 1.8, 3);
    height[i] = Math.max(1, height[i] - trough[i] + 3 * floor * fbm((f) => simplex2d.sample(hummocks, (x / 6) * f, (y / 6) * f), 2, 2, 0.5));
  }
  watch?.({ stage: "ice", height, trough });
  const { filled, order } = flood(height, 1e-4);
  const { to } = receivers(filled, 0);
  const open = new Uint8Array(LEN), basin = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) {
    open[i] = filled[i] < 0 || filled[i] - height[i] > 1 ? 1 : 0;
    basin[i] = filled[i] >= 0 && filled[i] - height[i] > 0.3 ? 1 : 0;
  }
  const air = climate(height, open, rand);
  watch?.({ stage: "climate", height, precip: air.precip, temp: air.temp, snow: air.snowCover, wind: air.wind });
  const hy = hydrology(height, filled, order, to, basin, air, rock);
  watch?.({ stage: "water", height, water: hy.water, table: hy.table, rivers: hy.rivers, springs: hy.springs, quick: hy.quick });
  for (let i = 0; i < LEN; i++) open[i] = hy.water[i] > 0 ? 1 : 0;
  const shore = distance(open);
  const cover = ground({ ...air, height, open, area: accumulate(order, to), table: hy.table, valley: hy.valley, shore, hard, rock });
  if (watch) {
    watch({ stage: "soil", height, water: hy.water, rock, ph: cover.ph, fertility: cover.fertility });
    // the generator's sand is part of the bare share; the map's sand is drawn over it
    watch({ stage: "cover", height, water: hy.water, tree: cover.tree, shrub: cover.shrub, grass: cover.grass, marsh: cover.marsh, bare: cover.bare, sand: cover.sand });
  }
  return { ...air, ...cover, ...hy, height, rock };
}
