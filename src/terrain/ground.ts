// What the ground is made of and what grows on it, from the physics of each spot: how steep, how wet, how warm, how
// exposed, and what rock it weathered from. There are no biomes here, only plants that cope or don't; forest, heath,
// meadow and bog are where they win.
import { clamp } from "math";
import { CELL, LEN, N, ramp } from "./grid";
import { ROCKS } from "./geology";
import type { Season } from "./climate";

export type Ground = {
  soil: Float32Array; // regolith depth, m
  silt: Float32Array; // 0..1 fine river and lake sediment
  sand: Float32Array; // 0..1 beach and dune sand
  peat: Float32Array; // 0..1 waterlogged organic soil
  sandy: Float32Array; // share of sand in the soil
  clayey: Float32Array; // share of clay in the soil
  humus: Float32Array; // 0..1 organic matter in the topsoil
  ph: Float32Array; // soil pH
  fertility: Float32Array; // 0..1 the nourishment roots can take from it
  moist: Float32Array; // 0..1 water available to roots through the growing season
  tree: Float32Array; shrub: Float32Array; grass: Float32Array; marsh: Float32Array; bare: Float32Array; // cover shares, sum to 1
};

export type Site = {
  height: Float32Array; open: Uint8Array; area: Float32Array; table: Float32Array; valley: Float32Array; shore: Float32Array; hard: Float32Array; rock: Uint8Array;
  precip: Float32Array; pet: Float32Array; temp: Float32Array; exposure: Float32Array; salt: Float32Array;
  seasons: Season[];
};

export function ground(s: Site): Ground {
  const { height: h } = s;
  const soil = new Float32Array(LEN), silt = new Float32Array(LEN), sand = new Float32Array(LEN), peat = new Float32Array(LEN), moist = new Float32Array(LEN);
  const sandy = new Float32Array(LEN), clayey = new Float32Array(LEN), humus = new Float32Array(LEN), ph = new Float32Array(LEN).fill(7), fertility = new Float32Array(LEN);
  const tree = new Float32Array(LEN), shrub = new Float32Array(LEN), grass = new Float32Array(LEN), marsh = new Float32Array(LEN), bare = new Float32Array(LEN);
  // Slope and curvature over a smoothed surface, so soil answers to hillsides and hollows rather than single cells.
  let hb = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) hb[i] = Math.max(0, h[i]);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(LEN);
    for (let i = 0; i < LEN; i++) {
      const x = i % N, y = (i - x) / N;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N) { sum += hb[ny * N + nx]; n++; } }
      next[i] = sum / n;
    }
    hb = next;
  }
  const at = (x: number, y: number) => hb[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)];
  const rough = (x: number, y: number) => Math.max(0, h[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)]);
  for (let i = 0; i < LEN; i++) {
    if (s.open[i]) { bare[i] = 1; continue; }
    const x = i % N, y = (i - x) / N, z = Math.max(0, h[i]);
    const slope = Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)) / (2 * CELL);
    const curve = (at(x + 2, y) + at(x - 2, y) + at(x, y + 2) + at(x, y - 2) - 4 * at(x, y)) / (4 * CELL * CELL);
    // Soil thins on steep ground and ridges and gathers in hollows; rivers spread silt over their flat floors.
    const valley = Math.max(ramp(Math.log10(s.area[i]), 1.6, 3) * (1 - ramp(slope, 0.03, 0.1)), s.valley[i]);
    silt[i] = valley;
    // Past the angle of repose (about 35°, measured on the unsmoothed ground) soil slides off and crags show. Hard
    // bedrock weathers so slowly that it holds only a skin of soil at best.
    const steep = Math.hypot(rough(x + 1, y) - rough(x - 1, y), rough(x, y + 1) - rough(x, y - 1)) / (2 * CELL);
    soil[i] = (1.4 * Math.exp(-slope / 0.5) * clamp(1 + curve * 1500, 0.5, 2) + 2.5 * valley) * (1 - ramp(steep, 0.7, 1.1)) * (1 - ramp(s.hard[i], 0.62, 0.9));
    // Waves pile sand on low, gentle shores, most where the gales come ashore.
    sand[i] = (1 - ramp(s.shore[i], 1.5 * CELL, 3.5 * CELL)) * (1 - ramp(z, 4, 12)) * (1 - ramp(slope, 0.08, 0.2)) * ramp(s.salt[i], 0.12, 0.45);
    // Ground that never drains, or so rainy that it never dries, grows peat.
    const logged = Math.exp(-s.table[i] / 0.5);
    const sodden = ramp(s.precip[i] - s.pet[i], 500, 1300) * (1 - ramp(slope, 0.05, 0.14));
    peat[i] = Math.max(logged * (1 - ramp(slope, 0.06, 0.2)), sodden) * (1 - sand[i]);
    // What the soil is: the rock's weathering, with river and lake silt over it on the valley floors and sand on the
    // shore. Rain that the year doesn't evaporate washes through it, carrying off the bases (unless the rock keeps
    // replacing them, as limestone does) and souring it; cool, wet ground keeps its fallen leaves as humus, and bog all
    // of them. What roots can take from it is the rock's nourishment, or the silt's, as far as its acidity, its depth and
    // waterlogging let them.
    const R = ROCKS[s.rock[i]], al = silt[i], leach = s.precip[i] - s.pet[i];
    sandy[i] = (R.sand * (1 - al) + 0.2 * al) * (1 - sand[i]) + sand[i];
    clayey[i] = (R.clay * (1 - al) + 0.3 * al) * (1 - sand[i]);
    humus[i] = Math.max(peat[i], clamp(0.12 + 0.3 * ramp(leach, -200, 800) + 0.2 * ramp(12 - s.temp[i], 0, 5) + 0.2 * clayey[i], 0, 1) * (1 - 0.7 * sand[i]) * ramp(soil[i], 0.02, 0.3));
    ph[i] = clamp(4.5 + 3.5 * R.base - 1.6 * ramp(leach, 0, 900) * (1 - 0.7 * R.base) + (6.5 - (4.5 + 3.5 * R.base)) * 0.5 * al - 2 * peat[i] + 1.2 * sand[i], 3.8, 8.3);
    const sour = 1 - 0.7 * ramp(Math.abs(ph[i] - 6.5), 0.5, 2.5);
    fertility[i] = (R.feed * (1 - al) + 0.85 * al) * sour * (0.6 + 0.4 * humus[i]) * (1 - 0.6 * peat[i]) * (0.3 + 0.7 * ramp(soil[i], 0.05, 0.5)) * (1 - 0.8 * sand[i]);
    // A soil bucket through the seasons: spring rain tops it up and summer drinks it down. What plants go short of
    // in the growing seasons is their drought. Roots that reach shallow groundwater never go short. A meter of loam
    // holds some 170 mm for roots, of sand under half of that, and humus holds more.
    const cap = 10 + soil[i] * (170 - 110 * sandy[i] - 80 * Math.max(0, clayey[i] - 0.4) + 60 * humus[i]);
    let store = cap, short = 0, want = 0;
    for (let year = 0; year < 2; year++)
      for (let k = 0; k < 4; k++) {
        const { precip, pet } = s.seasons[k], have = store + precip[i], used = Math.min(pet[i], have);
        store = Math.min(cap, have - used);
        if (year) { short += pet[i] - used; want += pet[i]; }
      }
    moist[i] = Math.max(want > 0 ? 1 - short / want : 1, Math.exp(-s.table[i] / 2.5));
    const summer = s.seasons[1].temp[i];
    const harsh = clamp(ramp(s.exposure[i], 0.45, 0.85) + ramp(s.salt[i], 0.3, 0.7), 0, 1);
    // Trees want deep, moist, sheltered ground, the better fed the better. Heath takes thin soil where it's always wet,
    // wind-scoured or sour, the way moorland does. Grass takes what's too dry or thin for either, and thrives where the
    // soil is rich.
    const pTree = ramp(summer, 11, 15) * ramp(soil[i], 0.3, 0.9) * ramp(moist[i], 0.72, 0.92) * (1 - peat[i]) ** 2 * (1 - harsh) ** 2 * (1 - sand[i]) * (0.8 + 0.2 * ramp(fertility[i], 0.05, 0.3));
    const moor = Math.max(ramp(s.precip[i] - s.pet[i], 300, 900), ramp(s.exposure[i], 0.35, 0.7), 0.6 * ramp(5.2 - ph[i], 0, 1));
    const pShrub = ramp(soil[i], 0.05, 0.25) * ramp(moist[i], 0.6, 0.85) * moor * (1 - 0.6 * ramp(soil[i], 0.8, 2)) * (1 - 0.3 * harsh) * (1 - 0.8 * sand[i]);
    const pMarsh = peat[i] * ramp(soil[i], 0.02, 0.15);
    const pGrass = ramp(soil[i], 0.02, 0.12) * ramp(moist[i], 0.15, 0.4) * (1 - 0.6 * sand[i]) * (1 - 0.5 * peat[i]) * (0.7 + 0.3 * ramp(fertility[i], 0.05, 0.4));
    // Taller plants shade out shorter ones where both could grow.
    tree[i] = pTree;
    shrub[i] = pShrub * (1 - tree[i]);
    marsh[i] = pMarsh * (1 - tree[i] - shrub[i]);
    grass[i] = pGrass * (1 - tree[i] - shrub[i] - marsh[i]);
    bare[i] = Math.max(0, 1 - tree[i] - shrub[i] - marsh[i] - grass[i]);
  }
  return { soil, silt, sand, peat, sandy, clayey, humus, ph, fertility, moist, tree, shrub, grass, marsh, bare };
}
