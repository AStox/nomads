// An island built from physics rather than painted on: rock raised by uplift and carved by rivers and slope creep,
// then rained on by its own climate. Lakes, rivers, groundwater, soil and plants all follow from that.
import { clamp } from "math";
import { domainWarp2, fbm, ridged, simplex2d } from "math/noise";
import { CELL, DX, DY, LEN, N, accumulate, distance, flood, ramp, receivers } from "./grid";
import { climate, type Climate } from "./climate";
import { ground, type Ground } from "./ground";

// Where the island rises: a warped oval, lifted hardest along a few ridged ranges and least in its lowland basins.
// Its bedrock comes in bands of harder and softer rock.
function uplift(rand: () => number) {
  const gen = () => simplex2d.create(Math.floor(rand() * 65536));
  const warp = gen(), coast = gen(), ranges = gen(), basins = gen();
  const tilt = rand() * Math.PI, stretch = 0.8 + rand() * 0.35;
  const rock = gen();
  const p: [number, number] = [0, 0];
  const warped = (a: number, b: number) => simplex2d.sample(warp, a, b);
  const mask = new Float32Array(LEN), lift = new Float32Array(LEN), hard = new Float32Array(LEN);
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
  }
  return { mask, lift, hard };
}

// Uplift against the stream power law (Braun and Willett 2013, implicit, n = 1): each step the land rises, rivers cut
// down in proportion to the square root of the area they drain, and slopes creep smooth, both slower through hard
// rock, which is left standing proud. Depressions keep their floors, so the landscape can still hold lakes. Heights
// come out in arbitrary units for the caller to scale.
function erode(rand: () => number, steps: number) {
  const { mask, lift, hard } = uplift(rand);
  const h = new Float32Array(LEN), next = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) h[i] = mask[i] > 0 ? mask[i] * 0.02 : -0.05;
  // The implicit scheme stays stable at any step, and 50 long steps land where 120 short ones do.
  const dt = 120 / steps, K = 0.25 * dt, CREEP = 0.04 * dt, RISE = 0.01 * dt;
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < LEN; i++) h[i] += lift[i] * RISE;
    const { filled, order } = flood(h, 1e-6);
    const { to, far } = receivers(filled, 0);
    const area = accumulate(order, to);
    for (let k = 0; k < LEN; k++) {
      const i = order[k], j = to[i];
      if (j === i) continue;
      const f = (K * (1.3 - hard[i]) * Math.sqrt(area[i])) / far[i], lower = (h[i] + f * h[j]) / (1 + f);
      if (lower < h[i]) h[i] = lower;
    }
    next.set(h);
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (h[i] <= 0) continue;
        next[i] = h[i] + CREEP * (1.3 - hard[i]) * (h[i - 1] + h[i + 1] + h[i - N] + h[i + N] - 4 * h[i]);
      }
    h.set(next);
  }
  return { h, hard };
}

// Steady groundwater under recharge (Dupuit): the water table bulges under hills between the rivers, lakes and sea that
// drain it, and can't rise above the ground, where it seeps out as springs and bog. Solved by over-relaxation.
function waterTable(h: Float32Array, fixed: Float32Array, recharge: Float32Array) {
  const TRANSMISSIVITY = 800; // m² a year
  const wt = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) wt[i] = Number.isNaN(fixed[i]) ? h[i] - 3 : fixed[i];
  for (let it = 0; it < 600; it++) {
    let change = 0;
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (!Number.isNaN(fixed[i])) continue;
        const want = (wt[i - 1] + wt[i + 1] + wt[i - N] + wt[i + N]) / 4 + (recharge[i] * CELL * CELL) / (4 * TRANSMISSIVITY);
        const v = Math.min(h[i], wt[i] + 1.85 * (want - wt[i]));
        change = Math.max(change, Math.abs(v - wt[i]));
        wt[i] = v;
      }
    if (change < 0.005) break;
  }
  const depth = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) depth[i] = Math.max(0, h[i] - wt[i]);
  return depth;
}

export type Island = Climate & Ground & {
  height: Float32Array; // ground elevation, m; the sea floor is below zero
  water: Float32Array; // depth of standing water over the ground, m: the sea and lakes
  flow: Float32Array; // mean discharge through each cell, m³ a second
  table: Float32Array; // depth to the water table, m
  rivers: [number, number, number][][]; // channels as [x, y, discharge] in cells, source to mouth
  lakes: number; // how many lakes hold water
};

const QMIN = 0.02; // m³/s: enough water to cut a lasting channel

export function generateIsland(rand: () => number): Island {
  // Peaks rise with the island: 250 to 450 m on one 9.6 km across, higher on a bigger one, as its ranges are longer.
  const peak = (250 + rand() * 200) * Math.sqrt((N * CELL) / 9600);
  const { h: raw, hard } = erode(rand, 50);
  let top = 0;
  for (let i = 0; i < LEN; i++) top = Math.max(top, raw[i]);
  const height = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) height[i] = raw[i] > 0 ? (raw[i] / top) * peak : Math.max(-60, raw[i] * 1200);
  // Late reworking of the land (ice scouring the big valleys, landslips, moraines) leaves hollows that fill as lakes,
  // deepest along the valleys that carried the most ice.
  const hollows = simplex2d.create(Math.floor(rand() * 65536));
  const before = flood(height, 1e-4), drained = accumulate(before.order, receivers(before.filled, 0).to);
  for (let i = 0; i < LEN; i++) {
    if (height[i] <= 2) continue;
    const x = i % N, y = (i - x) / N, scour = 14 + 30 * ramp(Math.log10(drained[i]), 2.2, 3.5);
    height[i] = Math.max(1, height[i] + fbm((f) => simplex2d.sample(hollows, (x / 18) * f, (y / 18) * f), 2, 2, 0.5) * scour);
  }
  const { filled, order } = flood(height, 1e-4);
  const { to } = receivers(filled, 0);
  const open = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) open[i] = filled[i] < 0 || filled[i] - height[i] > 1 ? 1 : 0;
  const air = climate(height, open, rand);
  // Rain the land keeps for a season, by Fu's form of the Budyko curve; the rest runs off.
  const aet = new Float32Array(LEN), runoff = new Float32Array(LEN), recharge = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const p = air.precip[i], dry = air.pet[i] / Math.max(1, p);
    aet[i] = p * (1 + dry - (1 + dry ** 2.6) ** (1 / 2.6));
    runoff[i] = ((p - aet[i]) / 1000) * CELL * CELL; // m³ a year
    recharge[i] = (0.35 * (p - aet[i])) / 1000; // m a year
  }
  const flow = accumulate(order, to, runoff);
  for (let i = 0; i < LEN; i++) flow[i] /= 31_557_600;
  // Each hollow holds water up to its spill point if its catchment brings more than the lake surface evaporates.
  const water = new Float32Array(LEN), basin = new Int32Array(LEN).fill(-1);
  let lakes = 0;
  for (let s = 0; s < LEN; s++) {
    if (basin[s] >= 0 || filled[s] < 0 || filled[s] - height[s] <= 0.3) continue;
    const cells = [s];
    basin[s] = s;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % N, y = (i - x) / N;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d], j = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || basin[j] >= 0 || filled[j] < 0 || filled[j] - height[j] <= 0.3) continue;
        basin[j] = s; cells.push(j);
      }
    }
    let inflow = 0, spill = 0;
    for (const i of cells) { inflow = Math.max(inflow, flow[i] * 31_557_600); spill = Math.max(spill, filled[i]); }
    const byDepth = cells.map((i) => height[i]).sort((a, b) => a - b);
    let level = spill;
    for (let n = byDepth.length; n > 0; n--) {
      const evaporation = (air.pet[cells[0]] / 1000) * n * CELL * CELL;
      if (inflow >= evaporation) { level = n === byDepth.length ? spill : byDepth[n]; break; }
      level = byDepth[0];
    }
    let wet = 0, deepest = 0;
    for (const i of cells) if (level - height[i] > 0) { wet++; deepest = Math.max(deepest, level - height[i]); }
    if (wet < 3 || deepest < 0.8) continue;
    for (const i of cells) if (level - height[i] > 0) water[i] = level - height[i];
    lakes++;
  }
  for (let i = 0; i < LEN; i++) {
    if (filled[i] < 0) water[i] = -height[i];
    open[i] = water[i] > 0 ? 1 : 0;
  }
  // Channels: water enough to keep a stream flowing, traced from each source to where it meets the sea or a lake.
  const channel = new Uint8Array(LEN), fed = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) if (!open[i] && flow[i] >= QMIN) channel[i] = 1;
  for (let i = 0; i < LEN; i++) if (channel[i] && to[i] !== i) fed[to[i]] = 1;
  const rivers: [number, number, number][][] = [], traced = new Uint8Array(LEN);
  for (let s = 0; s < LEN; s++) {
    if (!channel[s] || fed[s]) continue;
    const line: [number, number, number][] = [];
    for (let i = s; ; i = to[i]) {
      line.push([i % N, Math.floor(i / N), flow[i]]);
      if (traced[i] || open[i] || to[i] === i) break;
      traced[i] = 1;
    }
    if (line.length > 1) rivers.push(line);
  }
  // Groundwater drains to the sea, lakes and streams, which pin it at their surface.
  const fixed = new Float32Array(LEN).fill(NaN);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) fixed[i] = height[i] + water[i];
    else if (channel[i]) fixed[i] = height[i] - 0.3;
  }
  const table = waterTable(height, fixed, recharge);
  const shore = distance(open);
  const cover = ground({ ...air, height, open, area: accumulate(order, to), table, shore, hard });
  return { ...air, ...cover, height, water, flow, table, rivers, lakes };
}
