// An island built from physics rather than painted on, in metres and years: a block of the crust raised against the
// rivers and slope creep that wear it down until the two balance, then overridden by the last ice sheet, which scoured
// its joints and left its till, then rained on by its own climate. Lakes, rivers, groundwater, soil and plants all
// follow from that. The island stands for Bornholm; every number is in docs/research/terrain-constants.md.
import { clamp } from "math";
import { domainWarp2, fbm, simplex2d } from "math/noise";
import { CELL, LEN, N, accumulate, blur, distance, flood, receivers } from "./grid";
import { climate, type Climate } from "./climate";
import { ground, type Ground } from "./ground";
import { BARE, CREEP, DOLERITE, GRANITE, LIMESTONE, MELTWATER, MUDSTONE, PEAT, ROCKS, SANDSTONE, TILL_CLAY, TILL_MAX, TILL_SAND, crystalline } from "./geology";
import { hydrology, type Hydro } from "./water";

const DEG = Math.PI / 180;
// How fast the horst rises, m/yr, inverted from Bornholm's relief, which is inherited rather than a steady state, so the
// steady state is made to reproduce it: its highest summit stands (U / K) chi above the sea, with granite's K
// (geology.ts) and this generator's chi to its highest summit, 12.2 (seeds 1 to 3 give 12.7, 12.1 and 11.8, run at U / K
// = 35 m), so Rytterknægten's 162 to 165 m (R528) gives 0.95 m a million years, inside the 0.8 to 7.7 m that
// Fennoscandian granite surfaces are measured to lower by (R531) [derived, inverted from Bornholm's relief].
const U0 = (163.5 * ROCKS[GRANITE].erode) / 12.2;
// The share of the land on the crystalline horst: Bornholm's basement is about 400 of its 588 km2 (R528).
const CRYSTALLINE = 400 / 588;
// How steeply the basement dips south under the sediments (R528, R529 for the dip) [design].
const DIP = 0.05;
// The sediments from the basement up, m: their order is Bornholm's (R529); the Rabekke clay's and Robbedale sand's
// 40 m are cited there and the Arnager limestone's 20 m in R522; the rest are [design]. Above them all, greensand.
const STACK: [number, number][] = [
  [SANDSTONE, 100], // Nexø and Hardeberga sandstone
  [MUDSTONE, 50], // Alum Shale
  [LIMESTONE, 10], // Komstad limestone
  [MUDSTONE, 100], // the graptolite shales
  [MUDSTONE, 40], // the Jurassic and Rabekke clays
  [SANDSTONE, 40], // Robbedale sand
  [MUDSTONE, 20], // Jydegård clay
  [SANDSTONE, 20], // Arnager greensand
  [LIMESTONE, 20], // Arnager limestone
];
const STACK_TOP = STACK.reduce((t, [, m]) => t + m, 0);
// The sea floor's depth, m, at distances from the shore, m: Bornholm's, the median of 12 measured profiles off its
// granite coasts and of 12 off its sediments (R520).
const SHORE = [0, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000];
const OFF_GRANITE = [0, 13.8, 18.3, 25.0, 37.9, 46.2, 59.2, 63.5, 65.2];
const OFF_SEDIMENT = [0, 5.0, 9.8, 12.3, 15.8, 23.5, 34.8, 40.0, 42.2];
// The dolerite dykes: more than 250 in about 400 km2 of basement, mostly running NNE (R530). How long each is is a
// [gap] (1 km stands in); each is drawn one cell wide, the grid's floor, where the real ones are metres across.
const DYKES = 250 / 400e6, DYKE_LEN = 1000;
// Fracture zones, each one cell wide (the real ones are a few metres to Ekkodalen's 60 m, R528): one set along the
// dykes (NNE) and one across them [design], about 1.5 km apart and 2 to 5 km long [design]. The ice cleared out their
// crushed rock to as much as 50 m (areal scour's shallower class, R531; each valley's depth drawn in that range
// [design]), leaving a sill at the middle of each long valley, its watershed (R528), 15% of its length to either side
// [design].
const JOINTS = [20 * DEG, 110 * DEG], JOINT_GAP = 1500, SCOUR = 50, SILL = 0.15;
// The water table lies a few metres below the ground in the basement (R522, R530): 3 m.
const WATER_TABLE = 3;

// Where the island stands, and its structure: a warped oval [design] on a tilted horst, the basement high in the
// north and the middle and dipping south under the sediments, broken by faults into blocks dropped by 50 to 250 m
// [design] along the Sorgenfrei-Tornquist trend (NW) and north to south (R529). The rock at the surface is the layer of
// the sediments the basement's depth there reaches into; the horst rises at U0 and the blocks less the deeper they lie
// [design]. Offshore, the sea floor falls away as Bornholm's does off the same rock.
function structure(rand: () => number) {
  const gen = () => simplex2d.create(Math.floor(rand() * 65536));
  const warp = gen(), coast = gen(), bend = gen();
  const tilt = rand() * Math.PI, stretch = 0.8 + rand() * 0.35;
  const faults = [135, 0, 135].map((az) => ({
    x: (0.3 + 0.4 * rand()) * N * CELL, y: (0.45 + 0.4 * rand()) * N * CELL, nx: Math.cos(az * DEG), ny: Math.sin(az * DEG),
    throw: 50 + 200 * rand(), side: az ? 1 : rand() < 0.5 ? 1 : -1,
  }));
  const p: [number, number] = [0, 0];
  const warped = (a: number, b: number) => simplex2d.sample(warp, a, b);
  const land = new Uint8Array(LEN), depth = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N, mx = (x + 0.5) * CELL, my = (y + 0.5) * CELL;
    let u = ((x + 0.5) / N) * 2 - 1, v = ((y + 0.5) / N) * 2 - 1;
    [u, v] = domainWarp2(p, warped, u * 1.3, v * 1.3, 0.22);
    u /= 1.3; v /= 1.3;
    const ru = u * Math.cos(tilt) + v * Math.sin(tilt), rv = -u * Math.sin(tilt) + v * Math.cos(tilt);
    const d = Math.hypot(ru * stretch, rv / stretch) + fbm((f) => simplex2d.sample(coast, u * 3 * f, v * 3 * f), 4, 2, 0.5) * 0.12;
    // seven cells keep the island off the map's edge
    const edge = clamp(Math.min(x, y, N - 1 - x, N - 1 - y) / 7, 0, 1);
    land[i] = d < 0.98 - 0.3 * (1 - edge) ? 1 : 0;
    depth[i] = DIP * my + 20 * simplex2d.sample(bend, u * 2, v * 2);
    for (const f of faults) if (f.side * ((mx - f.x) * f.nx + (my - f.y) * f.ny) > 0) depth[i] += f.throw;
  }
  // the hinge where the basement goes under, placed so the horst holds Bornholm's share of the land
  const onLand = Array.from(depth.filter((_, i) => land[i])).sort((a, b) => a - b);
  const hinge = onLand[Math.floor(CRYSTALLINE * (onLand.length - 1))] ?? 0;
  const rock = new Uint8Array(LEN), U = new Float32Array(LEN), sea = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    depth[i] -= hinge;
    // the greensand above the stack wherever the basement lies deeper than all of it
    rock[i] = depth[i] > 0 ? SANDSTONE : GRANITE;
    for (let k = 0, top = 0; depth[i] > 0 && k < STACK.length; k++) if (depth[i] <= (top += STACK[k][1])) { rock[i] = STACK[k][0]; break; }
    U[i] = land[i] ? U0 * (1 - 0.5 * clamp(depth[i] / STACK_TOP, 0, 1)) : 0;
  }
  // a straight line of cells from (x, y) m along compass bearing az for len m, each with how far along it is, 0..1
  const along = (x: number, y: number, az: number, len: number, visit: (i: number, t: number) => void) => {
    const dx = Math.sin(az), dy = -Math.cos(az);
    for (let s = 0; s <= len; s += CELL / 2) {
      const cx = Math.floor((x + dx * s) / CELL), cy = Math.floor((y + dy * s) / CELL);
      if (cx >= 0 && cy >= 0 && cx < N && cy < N) visit(cy * N + cx, s / len);
    }
  };
  let basement = 0;
  for (let i = 0; i < LEN; i++) if (land[i] && rock[i] === GRANITE) basement++;
  for (let k = Math.round(DYKES * basement * CELL * CELL); k > 0; k--)
    along(rand() * N * CELL, rand() * N * CELL, (20 + 20 * (rand() - 0.5)) * DEG, DYKE_LEN, (i) => { if (rock[i] === GRANITE) rock[i] = DOLERITE; });
  const shore = distance(land);
  for (let i = 0; i < LEN; i++) {
    if (land[i]) continue;
    const prof = crystalline(rock[i]) ? OFF_GRANITE : OFF_SEDIMENT;
    let k = 1;
    while (k < SHORE.length - 1 && SHORE[k] < shore[i]) k++;
    sea[i] = -(prof[k - 1] + (prof[k] - prof[k - 1]) * clamp((shore[i] - SHORE[k - 1]) / (SHORE[k] - SHORE[k - 1]), 0, 1));
  }
  return { land, rock, U, sea, shore, along };
}

// Uplift against the stream power law (Braun and Willett 2013, implicit, n = 1, m = 0.5): rivers cut down at each
// rock's erodibility times the square root of the area they drain, in m2, times their slope, and slopes creep at one
// diffusivity everywhere (geology.ts CREEP), with the sea level holding every stream's mouth. One rain falls over the
// whole island, so every cell sheds the same runoff and discharge goes with drainage area, as the erodibilities were
// fitted; that the heights wring more rain from the air than the coast gets is a [gap] here, as the climate comes after
// the landform. It runs for three times the slowest knickpoint's time to cross the island (the response time, the sum
// of dx / (K A^0.5) up its longest path), long enough for the land to settle where uplift and erosion balance, so the
// heights are what the rock and its uplift make them. Depressions keep their floors, so the landscape can hold lakes.
function erode(land: Uint8Array, rock: Uint8Array, U: Float32Array, sea: Float32Array, watch?: Watch) {
  const STEPS = 60; // the implicit scheme is stable at any step, and its steady state does not depend on it [design]
  const shore = distance(Uint8Array.from(land, (v) => 1 - v)), K = Float32Array.from(rock, (r) => ROCKS[r].erode);
  // a gentle rise inland to start from, a metre a kilometre [design], so no ground starts flat
  const h = Float32Array.from(sea, (v, i) => (land[i] ? shore[i] * 1e-3 : v));
  let tau = 0;
  {
    const { filled, order } = flood(h, 1e-6), { to, far } = receivers(filled, 0), area = accumulate(order, to), t = new Float64Array(LEN);
    for (let k = 0; k < LEN; k++) {
      const i = order[k], j = to[i];
      if (!land[i] || j === i) continue;
      t[i] = t[j] + (far[i] * CELL) / (K[i] * Math.sqrt(area[i]) * CELL);
      tau = Math.max(tau, t[i]);
    }
  }
  const dt = (3 * tau) / STEPS, subs = Math.ceil((CREEP * dt) / (0.2 * CELL * CELL)), creep = (CREEP * dt) / subs / (CELL * CELL);
  // creep runs over the land cells off the map's rim, between two copies of the heights in which the sea stands at sea level
  const inland = Int32Array.from({ length: LEN }, (_, i) => i).filter((i) => land[i] && i % N > 0 && i % N < N - 1 && i >= N && i < LEN - N);
  let z = new Float32Array(LEN), w = new Float32Array(LEN);
  for (let s = 0; s < STEPS; s++) {
    for (let i = 0; i < LEN; i++) h[i] += U[i] * dt;
    const { filled, order } = flood(h, 1e-6);
    const { to, far } = receivers(filled, 0);
    const area = accumulate(order, to);
    for (let k = 0; k < LEN; k++) {
      const i = order[k], j = to[i];
      if (!land[i] || j === i) continue;
      const f = (K[i] * dt * Math.sqrt(area[i])) / far[i], lower = (h[i] + f * (land[j] ? h[j] : 0)) / (1 + f);
      if (lower < h[i]) h[i] = lower;
    }
    for (let k = 0; k < inland.length; k++) z[inland[k]] = h[inland[k]];
    for (let sub = 0; sub < subs; sub++) {
      for (let k = 0; k < inland.length; k++) {
        const i = inland[k];
        w[i] = z[i] + creep * (z[i - 1] + z[i + 1] + z[i - N] + z[i + N] - 4 * z[i]);
      }
      [z, w] = [w, z];
    }
    for (let k = 0; k < inland.length; k++) h[inland[k]] = z[inland[k]];
    watch?.({ stage: "erode", step: s, steps: STEPS, height: h, flow: area });
  }
  return h;
}

export type Island = Climate & Ground & Hydro & {
  height: Float32Array; // ground elevation, m; the sea floor is below zero
  rock: Uint8Array; // the bedrock, an index into geology.ts ROCKS
  drift: Uint8Array; // what lies on the bedrock, an index into geology.ts DRIFTS
  driftDepth: Float32Array; // how thick it lies, m
};

// What the generator has made so far, for anyone who wants to watch it work: each stage's fields as they stand. They are
// the generator's own arrays, valid during the call: copy what you keep.
export type Stage =
  | { stage: "rock"; rock: Uint8Array; lift: Float32Array } // lift: the uplift as a share of the horst's
  | { stage: "erode"; step: number; steps: number; height: Float32Array; flow: Float32Array } // flow: drainage area, cells
  | { stage: "ice"; height: Float32Array; scour: Float32Array } // scour: how deep the ice cleared the joints, m
  | { stage: "climate"; height: Float32Array; precip: Float32Array; temp: Float32Array; snow: Float32Array; wind: [number, number] }
  | { stage: "water"; height: Float32Array; water: Float32Array; table: Float32Array; rivers: Hydro["rivers"]; springs: Hydro["springs"]; quick: number[] }
  | { stage: "soil"; height: Float32Array; water: Float32Array; rock: Uint8Array; ph: Float32Array; fertility: Float32Array }
  | { stage: "cover"; height: Float32Array; water: Float32Array; tree: Float32Array; shrub: Float32Array; grass: Float32Array; marsh: Float32Array; bare: Float32Array; sand: Float32Array };
export type Watch = (s: Stage) => void;

export function generateIsland(rand: () => number, watch?: Watch): Island {
  const { land, rock, U, sea, along } = structure(rand);
  watch?.({ stage: "rock", rock, lift: Float32Array.from(U, (v) => v / U0) });
  const bed = erode(land, rock, U, sea, watch);
  // The last ice sheet overrode the horst (R532). It cleared the crushed rock out of the basement's fracture zones into
  // narrow joint valleys, and melting back it left its till: clayey over the soft sediments, a thin sandy skin over the
  // basement that thins to nothing on the knolls it scraped bare, and thickest, with its meltwater's sand, in the joint
  // valleys (R528, R529, R530). On the basement the till lies up to 6 m thick where the ground lies 5 m or more below
  // the ground within 300 m of it, thinning to none, bare rock, 5 m above it [design].
  const scour = new Float32Array(LEN);
  for (const az of JOINTS) {
    const dx = Math.sin(az), dy = -Math.cos(az), reach = N * CELL * 0.75, mid = (N * CELL) / 2;
    for (let o = -reach; o < reach; o += JOINT_GAP * (0.5 + rand())) {
      const bx = mid + Math.cos(az) * o, by = mid + Math.sin(az) * o;
      for (let s = -reach; s < reach; ) {
        const len = 2000 + 3000 * rand(), deep = SCOUR * rand();
        along(bx + dx * s, by + dy * s, az, len, (i, t) => {
          if (!land[i] || !crystalline(rock[i])) return;
          const cut = deep * Math.min(1, Math.abs(t - 0.5) / SILL);
          if (cut > scour[i]) scour[i] = cut;
        });
        s += len + 500 + 1500 * rand();
      }
    }
  }
  const around = blur(bed, Math.round(300 / CELL));
  const height = new Float32Array(LEN), drift = new Uint8Array(LEN), driftDepth = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    if (!land[i]) { height[i] = bed[i]; continue; }
    let kind = TILL_CLAY, thick = TILL_MAX;
    if (scour[i] > 0) kind = MELTWATER;
    else if (crystalline(rock[i])) {
      thick = TILL_MAX * clamp(0.5 - (bed[i] - around[i]) / 10, 0, 1);
      kind = thick > 0 ? TILL_SAND : BARE;
    }
    drift[i] = kind; driftDepth[i] = thick;
    height[i] = bed[i] - scour[i] + thick;
  }
  watch?.({ stage: "ice", height, scour });
  // Lakes stand in the closed hollows whose floors lie below the water table at their rims; whether one fills is the
  // water's balance (water.ts). The open water the climate draws its damp from is the sea and those hollows.
  const { filled, order } = flood(height, 1e-4);
  const { to } = receivers(filled, 0);
  const open = new Uint8Array(LEN), basin = new Uint8Array(LEN), hollow = new Int32Array(LEN).fill(-1);
  for (let s0 = 0; s0 < LEN; s0++) {
    if (hollow[s0] >= 0 || filled[s0] < 0 || filled[s0] - height[s0] <= 0.01) continue;
    const cells = [s0];
    let deepest = 0;
    hollow[s0] = s0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % N, y = (i - x) / N;
      deepest = Math.max(deepest, filled[i] - height[i]);
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1])
        if (j >= 0 && hollow[j] < 0 && filled[j] >= 0 && filled[j] - height[j] > 0.01) { hollow[j] = s0; cells.push(j); }
    }
    if (deepest > WATER_TABLE) for (const i of cells) basin[i] = 1;
  }
  for (let i = 0; i < LEN; i++) open[i] = filled[i] < 0 || basin[i] ? 1 : 0;
  const air = climate(height, open, rand);
  watch?.({ stage: "climate", height, precip: air.precip, temp: air.temp, snow: air.snowCover, wind: air.wind });
  const hy = hydrology(height, filled, order, to, basin, air, rock, drift, driftDepth);
  watch?.({ stage: "water", height, water: hy.water, table: hy.table, rivers: hy.rivers, springs: hy.springs, quick: hy.quick });
  for (let i = 0; i < LEN; i++) {
    open[i] = hy.water[i] > 0 ? 1 : 0;
    // a hollow that holds no lake is overgrown to bog (R528); ground.ts grows its peat where the water table stays high
    if (land[i] && !open[i] && hollow[i] >= 0) drift[i] = PEAT;
  }
  const cover = ground({ ...air, height, open, seasonTable: hy.seasonTable, winterTable: hy.winterTable, dryTable: hy.dryTable, valley: hy.valley, channel: hy.channel, power: hy.power, driftDepth, drift, rock });
  if (watch) {
    watch({ stage: "soil", height, water: hy.water, rock, ph: cover.ph, fertility: cover.fertility });
    // beach sand is its own share, beside the bare ground's
    watch({ stage: "cover", height, water: hy.water, tree: cover.tree, shrub: cover.shrub, grass: cover.grass, marsh: cover.marsh, bare: cover.bare, sand: cover.sand });
  }
  return { ...air, ...cover, ...hy, height, rock, drift, driftDepth };
}
