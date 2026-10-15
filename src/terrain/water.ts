// Water on and under the island (docs/research/terrain-constants.md sec. 11). What the rain leaves after the plants
// have drunk all soaks into the ground, and the rock carries it off as groundwater, faster through limestone and
// sandstone than through mudstone or granite. Where the rock cannot carry what soaks in, the water table stands at the
// ground and the rest comes straight back out and runs off in the same season. The groundwater comes out again where the
// water table meets the ground: in springs, in seeps along the valley sides, and through the beds of the streams, which
// keeps them running through a dry summer. A stream keeps a channel where its catchment and slope together are enough to
// cut one, as wide and deep as its bankfull flood makes it; it floods the low ground beside it where it is not too
// powerful to keep one, and meanders across that ground where it is powerful enough to move its banks. Hollows hold
// lakes where their inflow and the rain on them outlast their evaporation.
import { clamp } from "math";
import { CELL, DX, DY, LEN, N, ramp } from "./grid";
import { BARE, DOLERITE, DRIFTS, GRANITE, LIMESTONE, MELTWATER, MUDSTONE, PEAT, ROCKS, SANDSTONE, TILL_CLAY, TILL_SAND } from "./geology";
import { ROOTS } from "./growth";
import type { Climate } from "./climate";

const YEAR_S = 31_557_600, SEASON_S = YEAR_S / 4;
// The share of its volume a deposit gives up as the water table falls through it (specific yield): Johnson's fine sand
// 0.21 for the meltwater sand, Morris and Johnson's sandy till 0.16 and silty till 0.06 for the two tills, and hemic peat
// 0.15 to 0.42 (Boelter), so 0.285, for a fen's decomposed peat [derived]; where the rock is bare, its own: siltstone
// 0.12 for mudstone, fine sandstone 0.21, limestone 0.14, and the 0 of hard rock for granite and dolerite (R629, R630,
// R631). GEUS's national model takes 0.15 to 0.25 for its open aquifers (R632).
const SY_DRIFT: Record<number, number> = { [TILL_CLAY]: 0.06, [TILL_SAND]: 0.16, [MELTWATER]: 0.21, [PEAT]: 0.285 };
const SY_ROCK: Record<number, number> = { [MUDSTONE]: 0.12, [SANDSTONE]: 0.21, [LIMESTONE]: 0.14, [GRANITE]: 0, [DOLERITE]: 0 };
// mm of rain the soil holds for plants to drink between rains [gap]: FAO-56's TAW from ground.ts's texture (R221) would
// replace it, but the soil is made after the water
const BUCKET = 100;
const RHO = 1000, G = 9.81; // water's density, kg/m3, and gravity, m/s2
// A channel begins where the drainage area per metre of contour a and the slope S reach a S^2 = C (Montgomery and
// Dietrich, R555), C 25 to 200 m in the field. Inverted from Bornholm's 0.71 km of designated stream to the km2 (R534)
// over seeds 1 to 3 it is 24 m (26.2, 20.9, 25.5), just under the field's range, so the range's floor (sec. 11)
// [derived, inverted from Bornholm's drainage density].
const HEAD_C = 25;
// Bankfull discharge against the mean: Bornholm's median annual maximum, 0.10 to 0.14 m3/s a km2 (R558), the bankfull
// flood's 1 to 2 years (R557), over its mean runoff, 7.9 l/s a km2 (R558), so 15.0 times the mean [derived].
const BANKFULL = Math.sqrt(0.1 * 0.14) / 0.0079;
// Bankfull width w = alpha Qbf^0.5, alpha 2.48 where trees or shrubs hold 5% or more of the banks, 3.75 under grass
// (Soar and Thorne, R556).
const WIDE_WOOD = 2.48, WIDE_GRASS = 3.75;
export const WOODED = 0.05;
// Bankfull depth d = 0.201 Qbf^0.336 D50^-0.025 S^-0.060 (Lee and Julien, R557), with the bed's grain the largest the
// bankfull flow moves, D50 = d S / (1.65 tau*), tau* 0.03 to 0.058 (Andrews, R557), its middle on a log scale [derived].
const SHIELDS = Math.sqrt(0.03 * 0.058), SUBMERGED = 1.65;
// How a stream's width and depth follow its flow at one place: w ~ Q^0.26, d ~ Q^0.40 (Leopold and Maddock, R557).
const AT_W = 0.26, AT_D = 0.4;
// Open water's crop coefficient: 1.05 under 2 m deep; over 5 m, 0.65 while the water stores heat (spring and summer)
// and 1.25 while it gives it back (autumn and winter) (FAO-56 Table 12, R559); linear between [design].
const KC_SHALLOW = 1.05, KC_DEEP = [0.65, 0.65, 1.25, 1.25];
// Transmissivity of a valley's fill, m2/s: Bornholm's fault-valley wells, 6e-5 to 2e-3, the middle on a log scale
// (R522) [derived]. A stream whose flow falls below what this carries under its bed runs dry.
const T_FILL = Math.sqrt(6e-5 * 2e-3);
// Bankfull specific stream power, W/m2: over 300 a stream is confined and keeps no floodplain; 10 to 300 it moves its
// banks and meanders; under 10 its banks stand still (Nanson and Croke, R562).
const CONFINED = 300, STABLE = 10;
// The flood that sets the floodplain against the bankfull one [gap]: Bornholm's T-year floods (R558's Bilag 8) were not
// read, and twice the bankfull flow stands in.
const FLOOD = 2;
// Meanders: wavelength 11.0 w^1.01 (Leopold and Wolman, R560) and belt 3.7 w^1.12 in feet (Williams, R561), so
// 4.27 w^1.12 in meters, w the bankfull width.
const WAVE = 11, BELT = 3.7 * 0.3048 ** -0.12;
// The priority flood's step, m (island.ts): the least fall from one cell to the next.
const FALL = 1e-4;

// A stream's bankfull width, m, at bankfull discharge qbf, m3/s, with trees or shrubs on its banks or not.
export const bankWidth = (qbf: number, wooded: boolean) => (wooded ? WIDE_WOOD : WIDE_GRASS) * Math.sqrt(qbf);
// Its bankfull depth, m, on slope s, m/m, solved with the grain its bed keeps: d^1.025 = 0.201 Q^0.336 S^-0.085 (1.65 tau*)^0.025.
export const bankDepth = (qbf: number, s: number) => (0.201 * qbf ** 0.336 * s ** -0.085 * (SUBMERGED * SHIELDS) ** 0.025) ** (1 / 1.025);
// The width and depth of its water, m, at discharge q, from its bankfull width or depth at qbf.
export const widthOf = (q: number, qbf: number, wbf: number) => (qbf > 0 ? wbf * Math.max(0, q / qbf) ** AT_W : 0);
export const depthOf = (q: number, qbf: number, dbf: number) => (qbf > 0 ? dbf * Math.max(0, q / qbf) ** AT_D : 0);
// A stream's flow now, from its mean (q), the share of it that comes out of the ground (base), which runs all year, and
// how its runoff stands against its mean now (quick: the season's, raised by recent rain).
export const flowNow = (q: number, base: number, quick: number) => q * (base + (1 - base) * quick);
// Open water's crop coefficient at a depth, m, in season s.
const openKc = (depth: number, s: number) => KC_SHALLOW + (KC_DEEP[s] - KC_SHALLOW) * clamp((depth - 2) / 3, 0, 1);

// A point on a stream: x, y in cells (fractional where it meanders), mean discharge m3/s, the share of it from
// groundwater, bankfull discharge m3/s, slope m/m, and the flow its valley's fill carries under its bed, m3/s.
export type River = [number, number, number, number, number, number, number];
export type Hydro = {
  water: Float32Array; // depth of standing water over the ground, m: the sea and lakes
  flow: Float32Array; // mean discharge through each cell, m³ a second
  seasonFlow: Float32Array[]; // the same in each of the game's seasons
  table: Float32Array; // depth of the year's mean water table below the ground, m; 0 under open water
  seasonTable: Float32Array[]; // its depth in the middle of each of the game's seasons, m; 0 under open water
  winterTable: Float32Array; // winter's (seasonTable's last), the one the forestry site classification reads
  dryTable: Float32Array; // the deepest it falls in the year, m: the acrotelm's floor; 0 under open water
  spring: Float32Array; // groundwater coming out at the surface in each cell, m³ a second: seeps, springs, stream beds
  base: Float32Array; // share of the flow through each cell that came out of the ground rather than off it
  valley: Float32Array; // 1 on floodplain: ground no higher above the stream it drains to than that stream's flood stands, 0 elsewhere
  channel: Uint8Array; // 1 where a stream keeps a channel
  qbf: Float32Array; // bankfull discharge, m³ a second
  slope: Float32Array; // the ground's fall to the cell it drains to, m/m
  power: Float32Array; // bankfull specific stream power on channel cells, W/m2 (wooded banks), 0 elsewhere
  quick: number[]; // the island's runoff in each season against its mean, which a stream's quick share follows
  rivers: River[][]; // channels, source to mouth
  springs: [number, number, number][]; // [x, y, m³/s] where groundwater comes out in a spring
  lakes: number; // how many lakes hold water
};

// Steady groundwater under recharge R (m a year) through rock of transmissivity T (m² a year), held at `fixed` heads
// where it drains to the sea, a lake or a stream, and never above the ground, where it seeps out (Dupuit, solved by
// over-relaxation at 1.6, at most `most` sweeps, to 2 mm, from `head` as it stands [design]). out: what comes out of the
// ground in each cell, m³ a year; negative where the ground takes water in.
function aquifer(h: Float32Array, fixed: Float32Array, R: Float32Array, T: Float32Array, head: Float32Array, most: number) {
  const A = CELL * CELL, ce = new Float32Array(LEN), cs = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const x = i % N;
    if (x < N - 1) ce[i] = (2 * T[i] * T[i + 1]) / (T[i] + T[i + 1]);
    if (i + N < LEN) cs[i] = (2 * T[i] * T[i + N]) / (T[i] + T[i + N]);
  }
  for (let i = 0; i < LEN; i++) if (!Number.isNaN(fixed[i])) head[i] = fixed[i];
  for (let it = 0; it < most; it++) {
    let change = 0;
    for (let y = 1; y < N - 1; y++)
      for (let x = 1; x < N - 1; x++) {
        const i = y * N + x;
        if (!Number.isNaN(fixed[i])) continue;
        const cw = ce[i - 1], cE = ce[i], cn = cs[i - N], cS = cs[i];
        const want = (cw * head[i - 1] + cE * head[i + 1] + cn * head[i - N] + cS * head[i + N] + R[i] * A) / (cw + cE + cn + cS);
        const v = Math.min(h[i], head[i] + 1.6 * (want - head[i]));
        change = Math.max(change, Math.abs(v - head[i]));
        head[i] = v;
      }
    if (change < 0.002) break;
  }
  const out = new Float32Array(LEN);
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      out[i] = ce[i - 1] * (head[i - 1] - head[i]) + ce[i] * (head[i + 1] - head[i]) + cs[i - N] * (head[i - N] - head[i]) + cs[i] * (head[i + N] - head[i]) + R[i] * A;
    }
  return out;
}

// h: the ground; filled, order, to: its priority flood and steepest descent; basin: 1 in hollows deep enough to hold a
// lake; rock, drift, driftDepth: the bedrock and what lies on it, and how thick.
export function hydrology(h: Float32Array, filled: Float32Array, order: Int32Array, to: Int32Array, basin: Uint8Array, air: Climate, rock: Uint8Array, drift: Uint8Array, driftDepth: Float32Array): Hydro {
  const A = CELL * CELL, S = air.seasons.length, sea = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) sea[i] = filled[i] < 0 ? 1 : 0;

  // ---------- the ground's fall ----------
  // reach: meters along the flow to the next cell. slope: the fall over it on the filled ground, to the sea's level at a
  // mouth, for the stream's hydraulics. fall: the same on the ground itself, for where a channel begins.
  const reach = new Float32Array(LEN), slope = new Float32Array(LEN), fall = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const j = to[i];
    if (sea[i] || j === i) continue;
    reach[i] = Math.hypot((j % N) - (i % N), Math.floor(j / N) - Math.floor(i / N)) * CELL;
    slope[i] = Math.max(FALL, filled[i] - Math.max(0, filled[j])) / reach[i];
    fall[i] = Math.max(0, h[i] - Math.max(0, h[j])) / reach[i];
  }

  // ---------- the hollows ----------
  const hollow = new Int32Array(LEN).fill(-1), hollows: number[][] = [];
  for (let s0 = 0; s0 < LEN; s0++) {
    if (hollow[s0] >= 0 || !basin[s0] || sea[s0]) continue;
    const cells = [s0], id = hollows.length;
    hollow[s0] = id;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % N, y = (i - x) / N;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d], j = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || hollow[j] >= 0 || !basin[j] || sea[j]) continue;
        hollow[j] = id; cells.push(j);
      }
    }
    hollows.push(cells);
  }
  // Gathered downhill: each cell's weight and all that drains into it. A reach that loses water to the ground loses it
  // from the flow below it, so what reaches the sea is all that was gathered [design: no reach is held to what it
  // carries itself]. Inside a hollow the lake's evaporation is held against all its inflow; what leaves the hollow
  // leaves only if its lake spills, and never less than nothing.
  const gather = (w: Float32Array, spills: Uint8Array) => {
    const a = Float32Array.from(w);
    for (let k = LEN - 1; k >= 0; k--) {
      const i = order[k], j = to[i], id = hollow[i];
      if (j === i) continue;
      if (id < 0 || hollow[j] === id) a[j] += a[i];
      else if (spills[id]) a[j] += Math.max(0, a[i]);
    }
    return a;
  };
  // Where a channel begins and every cell below one; none in a hollow whose lake does not spill.
  const channelOf = (spills: Uint8Array) => {
    const area = gather(new Float32Array(LEN).fill(A), spills), c = new Uint8Array(LEN);
    for (let k = LEN - 1; k >= 0; k--) {
      const i = order[k], j = to[i];
      if (sea[i] || (hollow[i] >= 0 && !spills[hollow[i]])) continue;
      if ((area[i] / CELL) * fall[i] * fall[i] >= HEAD_C) c[i] = 1;
      if (c[i] && j !== i && !sea[j] && !(hollow[j] >= 0 && !spills[hollow[j]])) c[j] = 1;
    }
    return c;
  };

  // ---------- the rain the year leaves ----------
  // A bucket of soil through the seasons, twice round: what overflows it is the surplus, and what the plants want that
  // it can't give them is its shortfall. Of the surplus the aquifer takes GSI's share for what lies over the rock and how
  // thick (R569, R570), to at most what the rock accepts as an aquifer; the rest runs off and through the soil to the
  // streams in the season it fell, and so does what the aquifer then rejects where the water table meets the ground.
  const surplus = air.seasons.map(() => new Float32Array(LEN)), shortfall = air.seasons.map(() => new Float32Array(LEN)), wet = new Float32Array(LEN);
  // The aquifer's transmissivity, m2 a year: the rock's conductivity times the thickness of it that carries water (R522),
  // and over it the drift's times as much of it as lies under the water table. The first solve takes all of the drift
  // as saturated; the second takes it as the first left it [design: one step toward the unconfined solution].
  const R = new Float32Array(LEN), T = new Float32Array(LEN), bedT = new Float32Array(LEN), driftK = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const bed = ROCKS[rock[i]];
    bedT[i] = bed.ksat * bed.thick * YEAR_S;
    driftK[i] = DRIFTS[drift[i]].ksat * YEAR_S;
    T[i] = bedT[i] + driftK[i] * driftDepth[i];
    if (sea[i]) continue;
    let store = BUCKET;
    for (let year = 0; year < 2; year++)
      for (let s = 0; s < S; s++) {
        const have = store + air.seasons[s].precip[i], used = Math.min(air.seasons[s].pet[i], have), left = have - used, over = Math.max(0, left - BUCKET);
        store = left - over;
        if (year) { surplus[s][i] = over; shortfall[s][i] = air.seasons[s].pet[i] - used; }
      }
    for (let s = 0; s < S; s++) wet[i] += surplus[s][i] / 1000;
    const d = driftDepth[i], share = DRIFTS[drift[i]].recharge[d <= 3 ? 0 : d <= 5 ? 1 : 2];
    R[i] = Math.min(share * wet[i], bed.cap / 1000);
  }

  // ---------- groundwater and flow ----------
  // From a solve of the groundwater: what the ground gives back in each cell (gw, m3 a year: through a stream's or a
  // lake's bed, where it may be less than nothing, or out of a seepage face), the recharge it rejected where the water
  // table stands at the ground (back, m3 a year), and the flows that make. Rejected water runs off in the season it
  // fell; the rest comes out evenly through the year, as the solve is steady; a lake carries its own rain and
  // evaporation evenly across the year too [design].
  const seasonFlow = air.seasons.map(() => new Float32Array(LEN)), flow = new Float32Array(LEN), base = new Float32Array(LEN);
  const gw = new Float32Array(LEN), back = new Float32Array(LEN), lakeNet = new Float32Array(LEN), quick = new Array<number>(S).fill(0);
  const route = (out: Float32Array, head: Float32Array, fixed: Float32Array, open: Uint8Array, depth: Float32Array, spills: Uint8Array, Rs: Float32Array) => {
    for (let i = 0; i < LEN; i++) {
      gw[i] = 0; back[i] = 0; lakeNet[i] = 0;
      if (sea[i]) continue;
      if (open[i]) for (let s = 0; s < S; s++) lakeNet[i] += ((air.seasons[s].precip[i] - openKc(depth[i], s) * air.seasons[s].pet[i]) / 1000) * A;
      if (!Number.isNaN(fixed[i])) { gw[i] = out[i]; continue; }
      if (head[i] < h[i] || out[i] <= 0) continue;
      back[i] = Math.min(Rs[i] * A, out[i]);
      gw[i] = out[i] - back[i];
    }
    quick.fill(0);
    flow.fill(0);
    for (let s = 0; s < S; s++) {
      const weight = new Float32Array(LEN);
      for (let i = 0; i < LEN; i++) {
        const share = wet[i] > 0 ? surplus[s][i] / 1000 / wet[i] : 0, run = open[i] ? 0 : (surplus[s][i] / 1000 - share * R[i]) * A;
        weight[i] = back[i] * share + run + (gw[i] + lakeNet[i]) / S;
        quick[s] += back[i] * share + run;
      }
      const f = gather(weight, spills);
      for (let i = 0; i < LEN; i++) { seasonFlow[s][i] = Math.max(0, f[i]) / SEASON_S; flow[i] += seasonFlow[s][i] / S; }
    }
    const qm = quick.reduce((a, b) => a + b, 0) / S;
    for (let s = 0; s < S; s++) quick[s] /= Math.max(1e-9, qm);
    const fromGround = gather(gw, spills);
    for (let i = 0; i < LEN; i++) base[i] = flow[i] > 0 ? clamp(fromGround[i] / YEAR_S / flow[i], 0, 1) : 0;
  };
  const qbf = new Float32Array(LEN), stageOf = (i: number) => {
    const Q = BANKFULL * flow[i], dbf = Q > 0 ? bankDepth(Q, slope[i]) : 0;
    return h[i] - dbf + depthOf(flow[i], Q, dbf);
  };
  // First guess: the water table a few metres down (R522), the sea and every hollow full to its brim, and every channel
  // at its stage: its bed a bankfull depth down and its mean flow's depth over that (as MODFLOW's rivers, R564), on
  // flows of the whole surplus gathered downhill.
  const head = new Float32Array(LEN), open = new Uint8Array(LEN), depth = new Float32Array(LEN), spills = new Uint8Array(hollows.length).fill(1);
  for (let i = 0; i < LEN; i++) {
    head[i] = h[i] - 3;
    open[i] = sea[i] || basin[i] ? 1 : 0;
    depth[i] = basin[i] ? filled[i] - h[i] : 0;
  }
  let channel = channelOf(spills);
  const fixed = new Float32Array(LEN).fill(NaN), Rs = Float32Array.from(R, (r, i) => (open[i] ? 0 : r));
  {
    const f = gather(Float32Array.from(wet, (r) => r * A), spills);
    for (let i = 0; i < LEN; i++) flow[i] = Math.max(0, f[i]) / YEAR_S;
  }
  for (let i = 0; i < LEN; i++) {
    if (sea[i]) fixed[i] = 0;
    else if (basin[i]) fixed[i] = filled[i];
    else if (channel[i]) fixed[i] = stageOf(i);
  }
  // a rough first solve: it only has to place the lakes, and the second starts from it
  route(aquifer(h, fixed, Rs, T, head, 150), head, fixed, open, depth, spills, Rs);

  // ---------- lakes ----------
  // Each hollow holds water as high as what flows into it, the groundwater its bed takes in, what falls on its dry
  // ground and the rain on the lake together outlast what the lake surface evaporates; it spills if they outlast it
  // full. One cell of water is a lake: the grid's floor.
  const water = new Float32Array(LEN);
  let lakes = 0;
  for (const [id, cells] of hollows.entries()) {
    let inflow = 0, seep = 0, spill = 0;
    for (const i of cells) {
      seep += gw[i]; spill = Math.max(spill, filled[i]);
      const x = i % N, y = (i - x) / N;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d], j = ny * N + nx;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && to[j] === i && hollow[j] !== id) inflow += flow[j] * YEAR_S;
      }
    }
    const byDepth = cells.slice().sort((a, b) => h[a] - h[b]), onDry = byDepth.map((i) => wet[i] * A);
    const balance = (n: number, level: number) => {
      let sum = inflow + seep;
      for (let k = 0; k < byDepth.length; k++) {
        const i = byDepth[k];
        if (k >= n) { sum += onDry[k]; continue; }
        for (let s = 0; s < S; s++) sum += ((air.seasons[s].precip[i] - openKc(level - h[i], s) * air.seasons[s].pet[i]) / 1000) * A;
      }
      return sum;
    };
    spills[id] = 0;
    let n = byDepth.length, level = spill;
    if (balance(n, spill) >= 0) spills[id] = 1;
    else for (n = byDepth.length - 1; n > 0; n--) { level = h[byDepth[n]]; if (balance(n, level) >= 0) break; }
    if (n === 0) continue;
    for (const i of cells) if (level > h[i]) water[i] = level - h[i];
    lakes++;
  }
  for (let i = 0; i < LEN; i++) {
    if (sea[i]) water[i] = -h[i];
    open[i] = water[i] > 0 ? 1 : 0;
    depth[i] = water[i];
  }
  // Again with the lakes as they are and the streams where they run.
  channel = channelOf(spills);
  fixed.fill(NaN);
  for (let i = 0; i < LEN; i++) {
    T[i] = bedT[i] + driftK[i] * clamp(head[i] - (h[i] - driftDepth[i]), 0, driftDepth[i]);
    Rs[i] = open[i] ? 0 : R[i];
    if (open[i]) fixed[i] = sea[i] ? 0 : h[i] + water[i];
    else if (channel[i]) fixed[i] = stageOf(i);
  }
  const out = aquifer(h, fixed, Rs, T, head, 1500);
  route(out, head, fixed, open, depth, spills, Rs);
  const table = new Float32Array(LEN), spring = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    table[i] = open[i] ? 0 : Math.max(0, h[i] - head[i]);
    spring[i] = open[i] ? 0 : Math.max(0, gw[i]) / YEAR_S;
    if (open[i]) channel[i] = 0;
  }
  // The water table through the seasons: the steady solve's table is the year's mean, and each season's middle stands
  // above or below it by the water the ground holds then over the year's mean, over its specific yield [derived]. The
  // ground takes in each season its share of the year's recharge, as that season's surplus is of the year's, and gives
  // the year's recharge back evenly, as the steady solve does; where the year's table lies within the roots, the plants
  // draw from it what the soil's bucket can't give them (FAO-56's root zone, R221), less what the groundwater brings up
  // there. It never stands above the ground, where the rest runs off, and nothing reads it deeper than the roots or the
  // year's mean, where it is held [design]. That the plants' drawing leaves the year's mean where the steady solve put it,
  // and the reference crop's evaporation (Kc), are [gaps].
  const seasonTable = air.seasons.map(() => new Float32Array(LEN)), dryTable = new Float32Array(LEN), net = new Float64Array(S), held = new Float64Array(S);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) continue;
    const sy = drift[i] === BARE ? SY_ROCK[rock[i]] : SY_DRIFT[drift[i]], floor = Math.max(table[i], ROOTS), up = (spring[i] * SEASON_S) / A;
    let mean = 0;
    for (let s = 0; s < S; s++) {
      const into = wet[i] > 0 ? (R[i] * surplus[s][i]) / 1000 / wet[i] : R[i] / S, drawn = table[i] <= ROOTS ? Math.max(0, shortfall[s][i] / 1000 - up) : 0;
      net[s] = into - drawn;
      mean += net[s] / S;
    }
    let sum = 0, heldMean = 0;
    for (let s = 0; s < S; s++) { const d = net[s] - mean; held[s] = sum + d / 2; sum += d; heldMean += held[s] / S; }
    for (let s = 0; s < S; s++) {
      const x = held[s] - heldMean, rise = sy > 0 ? x / sy : x > 0 ? Infinity : x < 0 ? -Infinity : 0;
      seasonTable[s][i] = clamp(table[i] - rise, 0, floor);
      dryTable[i] = Math.max(dryTable[i], seasonTable[s][i]);
    }
  }

  // ---------- channels ----------
  // Each channel's bankfull flood and its power, traced from each source to where it meets the sea or a lake.
  const power = new Float32Array(LEN), fed = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) {
    if (sea[i]) continue;
    qbf[i] = BANKFULL * flow[i];
    if (channel[i] && qbf[i] > 0) power[i] = (RHO * G * qbf[i] * slope[i]) / bankWidth(qbf[i], true);
    if (channel[i] && to[i] !== i) fed[to[i]] = 1;
  }
  const lines: number[][] = [], traced = new Uint8Array(LEN);
  for (let s0 = 0; s0 < LEN; s0++) {
    if (!channel[s0] || fed[s0]) continue;
    const line: number[] = [];
    for (let i = s0; ; i = to[i]) {
      line.push(i);
      if (traced[i] || open[i] || to[i] === i || !channel[i]) break;
      traced[i] = 1;
    }
    if (line.length > 1) lines.push(line);
  }
  // A spring: where groundwater comes out, the most of the ground around it, faster than a pool of it would evaporate
  // over the year where the evaporation outruns the rain (open water's coefficient under 2 m).
  const springs: Hydro["springs"] = [];
  for (let i = 0; i < LEN; i++) {
    if (spring[i] <= 0 || open[i]) continue;
    let short = 0;
    for (let s = 0; s < S; s++) short += Math.max(0, KC_SHALLOW * air.seasons[s].pet[i] - air.seasons[s].precip[i]);
    if (spring[i] < ((short / 1000) * A) / YEAR_S) continue;
    const x = i % N, y = (i - x) / N;
    let top = true;
    for (let d = 0; d < 8 && top; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < N && ny < N && spring[ny * N + nx] > spring[i]) top = false; }
    if (top) springs.push([x, y, Math.round(spring[i] * 1e4) / 1e4]);
  }

  // ---------- floodplains ----------
  // Ground a stream floods: its height above the channel it drains to (Rennó's height above the nearest drainage) no
  // more than the flood stands over the bank, the flood's depth over the bankfull one at one place (R557), where the
  // stream is not confined (R562). The valley's fill is the floodplain's width under the channel, at least its own.
  const target = new Int32Array(LEN).fill(-1), valley = new Float32Array(LEN), plain = new Float32Array(LEN);
  for (let k = 0; k < LEN; k++) {
    const i = order[k];
    if (channel[i] || open[i]) { target[i] = i; continue; }
    if (to[i] !== i) target[i] = target[to[i]];
  }
  for (let i = 0; i < LEN; i++) {
    const t = target[i];
    if (t < 0 || !channel[t] || open[i] || power[t] > CONFINED) continue;
    const rise = bankDepth(qbf[t], slope[t]) * (FLOOD ** AT_D - 1);
    if (h[i] - h[t] > rise) continue;
    valley[i] = 1;
    plain[t] += A;
  }

  // ---------- the lines streams take ----------
  // Each point carries the flow the valley's fill carries under its bed (T S W, the fill as wide as the floodplain and
  // at least the channel): a stream whose flow falls below it runs dry.
  const rivers = lines.map((line) => line.map((i): River => [i % N, Math.floor(i / N), flow[i], base[i], qbf[i], slope[i], channel[i] ? T_FILL * slope[i] * Math.max(bankWidth(qbf[i], true), plain[i] / reach[i]) : 0]));
  return { water, flow, seasonFlow, table, seasonTable, winterTable: seasonTable[S - 1], dryTable, spring, base, valley, channel, qbf, slope, power, quick, rivers: shape(rivers), springs, lakes };
}

const chaikin = (p: River[]): River[] => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25) as River, a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75) as River]), p.at(-1)!];
// The streams as they lie on the ground: rounded off the cell grid, wandering a few meters either way everywhere
// (4.5 m at a 127 m wavelength [design]), and in meanders where the bankfull flood moves the banks (R562), each with the
// wavelength and belt of its bankfull width (R560, R561), wooded banks taken as the island's commonest. A meander
// shorter than four steps of the line cannot be drawn, and its swing is evened out over a cell [design]. A line joins
// the one it flows into exactly where that one now lies.
function shape(lines: River[][]): River[][] {
  const STEP = 0.08, ROUND = Math.round(1 / STEP), placed = new Map<number, [number, number]>(), out: River[][] = [];
  for (const [n, raw] of lines.entries()) {
    const end = raw.at(-1)!, endKey = Math.round(end[1]) * N + Math.round(end[0]), joins = placed.get(endKey);
    const smooth = chaikin(chaikin(raw));
    // every STEP cells along the smoothed line
    const pts: River[] = [smooth[0]];
    let carry = 0;
    for (let k = 1; k < smooth.length; k++) {
      const a = smooth[k - 1], b = smooth[k], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = STEP - carry; s <= len; s += STEP) { const t = s / len; pts.push(a.map((v, c) => v + (b[c] - v) * t) as River); }
      carry = (carry + len) % STEP;
    }
    if (pts.length < 2 || Math.hypot(pts.at(-1)![0] - end[0], pts.at(-1)![1] - end[1]) > 1e-3) pts.push(end);
    const total = (pts.length - 1) * STEP, phase = ((n * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    // each point's meander: its swing either way and its wavelength, in cells
    const swing = new Float32Array(pts.length), wave = new Float32Array(pts.length);
    for (const [k, p] of pts.entries()) {
      const w = bankWidth(p[4], true), power = w > 0 ? (RHO * G * p[4] * p[5]) / w : 0;
      wave[k] = (WAVE * w ** 1.01) / CELL;
      if (power >= STABLE && power <= CONFINED && wave[k] >= 4 * STEP) swing[k] = (BELT * w ** 1.12 - w) / 2 / CELL;
    }
    const even = swing.map((_, k) => { let sum = 0, c = 0; for (let j = Math.max(0, k - ROUND); j <= Math.min(pts.length - 1, k + ROUND); j++) { sum += swing[j]; c++; } return sum / c; });
    let turn = phase;
    const moved = pts.map((p, k): River => {
      const a = pts[Math.max(0, k - 4)], b = pts[Math.min(pts.length - 1, k + 4)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, s = k * STEP;
      turn += (2 * Math.PI * STEP) / Math.max(STEP, wave[k]);
      const ends = ramp(s, 0, 1) * ramp(total - s, 0, 1);
      const off = (even[k] * Math.sin(turn) + 0.06 * Math.sin((2 * Math.PI * s) / 1.7 + 2 * phase)) * ends;
      return [p[0] - (dy / l) * off, p[1] + (dx / l) * off, p[2], p[3], p[4], p[5], p[6]];
    });
    // the end lies on the line it joins, where that line now runs, and the last cell bends over to meet it
    if (joins) {
      const last = moved.at(-1)!, sx = joins[0] - last[0], sy = joins[1] - last[1];
      for (let k = 0; k < moved.length; k++) { const t = ramp(k * STEP, total - 1, total); moved[k][0] += sx * t; moved[k][1] += sy * t; }
    }
    for (let k = 0; k < raw.length - 1; k++) {
      const key = Math.round(raw[k][1]) * N + Math.round(raw[k][0]);
      if (placed.has(key)) continue;
      // the moved point nearest the cell's center
      let best = moved[0], bd = Infinity;
      for (let j = Math.max(0, Math.floor((k * 0.9) / STEP) - 12); j < Math.min(moved.length, Math.ceil((k * 1.5) / STEP) + 12); j++) { const d = Math.hypot(pts[j][0] - raw[k][0], pts[j][1] - raw[k][1]); if (d < bd) { bd = d; best = moved[j]; } }
      placed.set(key, [best[0], best[1]]);
    }
    out.push(moved);
  }
  return out;
}
