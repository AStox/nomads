// Water on and under the island. What the rain leaves after the plants have drunk soaks into the rock as far as the rock
// lets it, and the rest runs off at once. The soaked part moves slowly through the rock as groundwater, faster through
// limestone and sandstone than through mudstone or granite, and comes out again where the water table meets the ground:
// in springs, in seeps along the valley sides, and through the beds of the streams, which keeps them running through a dry
// summer. Streams that only the rain feeds run in the wet seasons and leave a dry bed in the dry one. Hollows hold lakes
// where their inflow outlasts their evaporation, and the bigger streams spread over a floodplain, wander in meanders across
// it, and split into a fan of channels where they meet the sea over flat ground.
import { clamp } from "math";
import { CELL, DX, DY, LEN, N, accumulate, ramp } from "./grid";
import { ROCKS } from "./geology";
import type { Climate } from "./climate";

const YEAR_S = 31_557_600, SEASON_S = YEAR_S / 4;
export const QMIN = 0.02; // m³/s in the wettest season: enough water to keep a channel cut
export const TRICKLE = 0.004; // m³/s: less than this and a channel's bed is dry, but for puddles
const BUCKET = 100; // mm of rain the soil holds for plants to drink between rains

// A stream's width and depth at a discharge, m, by the hydraulic geometry of small rivers (width with the square root of
// the flow, depth nearer its cube root).
export const widthOf = (q: number) => clamp(2.5 + 2.8 * Math.sqrt(q), 2.5, 16);
export const depthOf = (q: number) => 0.1 + 0.27 * Math.max(0, q) ** 0.4;

// A stream's flow now, from its mean (q), the share of it that comes out of the ground (base), which runs all year, and
// how its runoff stands against its mean now (quick: the season's, raised by recent rain).
export const flowNow = (q: number, base: number, quick: number) => q * (base + (1 - base) * quick);

export type Hydro = {
  water: Float32Array; // depth of standing water over the ground, m: the sea and lakes
  flow: Float32Array; // mean discharge through each cell, m³ a second
  seasonFlow: Float32Array[]; // the same in each of the game's seasons
  table: Float32Array; // depth to the water table, m
  spring: Float32Array; // groundwater coming out at the surface in each cell, m³ a second: seeps, springs, stream beds
  base: Float32Array; // share of the flow through each cell that came out of the ground rather than off it
  valley: Float32Array; // 0..1 floodplain: low, flat ground a stream spreads over when it floods
  quick: number[]; // the island's runoff in each season against its mean, which a stream's quick share follows
  // channels as [x, y, mean m³/s, share from groundwater, wettest season's m³/s] in cells (fractional where they
  // meander), source to mouth
  rivers: [number, number, number, number, number][][];
  springs: [number, number, number][]; // [x, y, m³/s] where groundwater comes out in a spring
  lakes: number; // how many lakes hold water
};

// Steady groundwater under recharge R (m a year) through rock of transmissivity T (m² a year), held at `fixed` heads
// where it drains to the sea, a lake or a stream, and never above the ground, where it seeps out (Dupuit, solved by
// over-relaxation, at most `most` sweeps, from `head` as it stands). out: what comes out of the ground in each cell, m³ a year; negative where the ground takes water in.
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
// lake.
export function hydrology(h: Float32Array, filled: Float32Array, order: Int32Array, to: Int32Array, basin: Uint8Array, air: Climate, rock: Uint8Array): Hydro {
  const A = CELL * CELL, S = air.seasons.length, sea = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) sea[i] = filled[i] < 0 ? 1 : 0;
  const at = (x: number, y: number) => Math.max(0, h[clamp(y, 0, N - 1) * N + clamp(x, 0, N - 1)]);
  // ---------- the rain the year leaves ----------
  // A bucket of soil through the seasons, twice round: what overflows it is the surplus that soaks in or runs off.
  // Open water gives back what it gains over what evaporates from it.
  const surplus = air.seasons.map(() => new Float32Array(LEN));
  const inf = new Float32Array(LEN), R = new Float32Array(LEN), T = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    const x = i % N, y = (i - x) / N, perm = ROCKS[rock[i]].perm;
    T[i] = 2000 + 60000 * perm * perm;
    if (basin[i] || sea[i]) { for (let s = 0; s < S; s++) surplus[s][i] = Math.max(0, air.seasons[s].precip[i] - 1.1 * air.seasons[s].pet[i]); continue; }
    let store = BUCKET;
    for (let year = 0; year < 2; year++)
      for (let s = 0; s < S; s++) {
        const have = store + air.seasons[s].precip[i], left = have - Math.min(air.seasons[s].pet[i], have), over = Math.max(0, left - BUCKET);
        store = left - over;
        if (year) surplus[s][i] = over;
      }
    // Rock that lets water in takes most of the surplus; steep ground sheds it before it can.
    const slope = Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)) / (2 * CELL);
    inf[i] = clamp(0.1 + 0.8 * perm - 2 * slope, 0.05, 0.9);
    for (let s = 0; s < S; s++) R[i] += (surplus[s][i] * inf[i]) / 1000;
  }
  // runoff in each season, m³ a cell
  const quickBy = air.seasons.map((_, s) => Float32Array.from(surplus[s], (v, i) => ((v * (1 - inf[i])) / 1000) * A));
  const quickMean = quickBy.map((q) => q.reduce((a, b) => a + b, 0)), qm = quickMean.reduce((a, b) => a + b, 0) / S;
  const quick = quickMean.map((v) => v / Math.max(1e-9, qm));

  // ---------- groundwater and flow ----------
  // Flow in each season: the season's runoff and a quarter of the year's groundwater, gathered downhill.
  const seasonFlow = air.seasons.map(() => new Float32Array(LEN)), flow = new Float32Array(LEN), base = new Float32Array(LEN), gw = new Float32Array(LEN);
  const route = (out: Float32Array) => {
    for (let i = 0; i < LEN; i++) gw[i] = sea[i] ? 0 : Math.max(0, out[i]);
    flow.fill(0);
    for (let s = 0; s < S; s++) {
      const weight = Float32Array.from(quickBy[s], (q, i) => q + gw[i] / S), f = accumulate(order, to, weight);
      for (let i = 0; i < LEN; i++) { seasonFlow[s][i] = f[i] / SEASON_S; flow[i] += f[i] / SEASON_S / S; }
    }
    const fromGround = accumulate(order, to, gw);
    for (let i = 0; i < LEN; i++) base[i] = flow[i] > 0 ? Math.min(1, fromGround[i] / YEAR_S / flow[i]) : 0;
  };
  const wettest = (i: number) => { let m = 0; for (let s = 0; s < S; s++) m = Math.max(m, seasonFlow[s][i]); return m; };
  // First guess: the sea and every hollow full to its brim, and a stream wherever the runoff alone would cut one.
  const head = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) head[i] = h[i] - 3;
  const fixed = new Float32Array(LEN).fill(NaN), first = accumulate(order, to, Float32Array.from(quickBy[0], (_, i) => quickBy.reduce((t, q) => t + q[i], 0)));
  for (let i = 0; i < LEN; i++) {
    if (sea[i]) fixed[i] = 0;
    else if (basin[i]) fixed[i] = filled[i];
    else if (first[i] / YEAR_S >= QMIN) fixed[i] = h[i] - 0.3;
  }
  // a rough first solve: it only has to place the lakes, and the second starts from it
  route(aquifer(h, fixed, R, T, head, 150));

  // ---------- lakes ----------
  // Each hollow holds water up to its spill point if what flows in brings more than the lake surface evaporates.
  const water = new Float32Array(LEN), seen = new Int32Array(LEN).fill(-1);
  let lakes = 0;
  for (let s0 = 0; s0 < LEN; s0++) {
    if (seen[s0] >= 0 || !basin[s0] || sea[s0]) continue;
    const cells = [s0];
    seen[s0] = s0;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], x = i % N, y = (i - x) / N;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d], ny = y + DY[d], j = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[j] >= 0 || !basin[j] || sea[j]) continue;
        seen[j] = s0; cells.push(j);
      }
    }
    let inflow = 0, spill = 0, pet = 0;
    for (const i of cells) { inflow = Math.max(inflow, flow[i] * YEAR_S); spill = Math.max(spill, filled[i]); pet += air.pet[i] / cells.length; }
    const byDepth = cells.map((i) => h[i]).sort((a, b) => a - b);
    let level = spill;
    for (let n = byDepth.length; n > 0; n--) {
      const evaporation = ((1.1 * pet) / 1000) * n * A;
      if (inflow >= evaporation) { level = n === byDepth.length ? spill : byDepth[n]; break; }
      level = byDepth[0];
    }
    let wet = 0, deepest = 0;
    for (const i of cells) if (level - h[i] > 0) { wet++; deepest = Math.max(deepest, level - h[i]); }
    if (wet < 3 || deepest < 0.8) continue;
    for (const i of cells) if (level - h[i] > 0) water[i] = level - h[i];
    lakes++;
  }
  const open = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) {
    if (sea[i]) water[i] = -h[i];
    open[i] = water[i] > 0 ? 1 : 0;
  }
  // Again with the lakes as they are and the streams where they run.
  fixed.fill(NaN);
  for (let i = 0; i < LEN; i++) {
    if (open[i]) fixed[i] = sea[i] ? 0 : h[i] + water[i];
    else if (wettest(i) >= QMIN) fixed[i] = h[i] - 0.3;
  }
  const out = aquifer(h, fixed, R, T, head, 1500);
  route(out);
  const table = new Float32Array(LEN), spring = new Float32Array(LEN);
  for (let i = 0; i < LEN; i++) {
    table[i] = open[i] ? 0 : Math.max(0, h[i] - head[i]);
    spring[i] = open[i] ? 0 : gw[i] / YEAR_S;
  }

  // ---------- channels ----------
  // A channel wherever the wettest season brings enough water to keep one cut, traced from each source to where it meets
  // the sea or a lake.
  const channel = new Uint8Array(LEN), fed = new Uint8Array(LEN);
  for (let i = 0; i < LEN; i++) if (!open[i] && wettest(i) >= QMIN) channel[i] = 1;
  for (let i = 0; i < LEN; i++) if (channel[i] && to[i] !== i) fed[to[i]] = 1;
  const lines: number[][] = [], traced = new Uint8Array(LEN);
  for (let s0 = 0; s0 < LEN; s0++) {
    if (!channel[s0] || fed[s0]) continue;
    const line: number[] = [];
    for (let i = s0; ; i = to[i]) {
      line.push(i);
      if (traced[i] || open[i] || to[i] === i) break;
      traced[i] = 1;
    }
    if (line.length > 1) lines.push(line);
  }
  // Where groundwater comes out strongly enough to name: two litres a second or more, the most of the ground around it.
  const springs: Hydro["springs"] = [];
  for (let i = 0; i < LEN; i++) {
    if (spring[i] < 0.002 || open[i]) continue;
    const x = i % N, y = (i - x) / N;
    let top = true;
    for (let d = 0; d < 8 && top; d++) { const nx = x + DX[d], ny = y + DY[d]; if (nx >= 0 && ny >= 0 && nx < N && ny < N && spring[ny * N + nx] > spring[i]) top = false; }
    if (top) springs.push([x, y, Math.round(spring[i] * 1e4) / 1e4]);
  }

  // ---------- floodplains ----------
  // Ground a stream floods: how high it stands above the channel it drains to (Rennó's height above the nearest drainage),
  // against how deep that stream runs in flood. The more water a stream carries the wider its plain.
  const target = new Int32Array(LEN).fill(-1), valley = new Float32Array(LEN);
  for (let k = 0; k < LEN; k++) {
    const i = order[k];
    if (channel[i] || open[i]) { target[i] = i; continue; }
    if (to[i] !== i) target[i] = target[to[i]];
  }
  for (let i = 0; i < LEN; i++) {
    const t = target[i];
    if (t < 0 || !channel[t] || open[i]) continue;
    const q = wettest(t), d = depthOf(q);
    valley[i] = (1 - ramp(h[i] - h[t], 0.3 + d, 1.5 + 5 * d)) * ramp(q, 0.05, 0.6);
  }

  // ---------- the lines streams take ----------
  const rivers = lines.map((line) => line.map((i): [number, number, number, number, number] => [i % N, Math.floor(i / N), flow[i], base[i], wettest(i)]));
  return { water, flow, seasonFlow, table, spring, base, valley, quick, rivers: shape(rivers, filled, open), springs, lakes };
}

type Pt = [number, number, number, number, number];
const chaikin = (p: Pt[]): Pt[] => [p[0], ...p.slice(0, -1).flatMap((a, i) => [a.map((v, k) => v * 0.75 + p[i + 1][k] * 0.25) as Pt, a.map((v, k) => v * 0.25 + p[i + 1][k] * 0.75) as Pt]), p.at(-1)!];
// The streams as they lie on the ground: rounded off the cell grid, wandering a few meters either way everywhere, and in meanders where they cross flat floodplain
// (a bend every eleven or twelve widths across, swinging up to four widths aside, more the flatter and bigger the stream),
// and splitting into a fan of channels where a big one reaches the sea over flat ground. A line joins the one it flows
// into exactly where that one now lies.
function shape(lines: Pt[][], filled: Float32Array, open: Uint8Array): Pt[][] {
  const STEP = 0.08, placed = new Map<number, [number, number]>(), out: Pt[][] = [];
  const fz = (x: number, y: number) => filled[clamp(Math.round(y), 0, N - 1) * N + clamp(Math.round(x), 0, N - 1)];
  for (const [n, raw] of lines.entries()) {
    const end = raw.at(-1)!, endKey = Math.round(end[1]) * N + Math.round(end[0]), joins = placed.get(endKey);
    const smooth = chaikin(chaikin(raw));
    // every STEP cells along the smoothed line
    const pts: Pt[] = [smooth[0]];
    let carry = 0;
    for (let k = 1; k < smooth.length; k++) {
      const a = smooth[k - 1], b = smooth[k], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = STEP - carry; s <= len; s += STEP) { const t = s / len; pts.push(a.map((v, c) => v + (b[c] - v) * t) as Pt); }
      carry = (carry + len) % STEP;
    }
    if (pts.length < 2 || Math.hypot(pts.at(-1)![0] - end[0], pts.at(-1)![1] - end[1]) > 1e-3) pts.push(end);
    const total = (pts.length - 1) * STEP, phase = ((n * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
    const moved = pts.map((p, k): Pt => {
      const a = pts[Math.max(0, k - 4)], b = pts[Math.min(pts.length - 1, k + 4)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const grad = Math.max(0, fz(a[0], a[1]) - fz(b[0], b[1])) / (l * CELL), w = widthOf(p[4]) / CELL, s = k * STEP;
      // and every stream wanders a little off the straight line a steepest descent gives it, a few meters either way
      const amp = (Math.min(0.8, 4 * w) * (1 - ramp(grad, 0.001, 0.004)) * ramp(p[4], 0.05, 0.3) + 0.06) * ramp(s, 0, 1) * ramp(total - s, 0, 1);
      const off = amp * Math.sin((2 * Math.PI * s) / Math.max(0.6, 11.5 * w) + phase) + 0.06 * Math.sin((2 * Math.PI * s) / 1.7 + 2 * phase) * ramp(s, 0, 1) * ramp(total - s, 0, 1);
      return [p[0] - (dy / l) * off, p[1] + (dx / l) * off, p[2], p[3], p[4]];
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
    // A delta: a big stream that crosses its last stretch to the sea nearly level splits there into a fan.
    const m = raw.length, mouth = raw[m - 1];
    if (m < 8 || !open[endKey] || mouth[4] < 0.5 || filled[endKey] > 0) continue;
    const from = raw[m - 6], drop = fz(from[0], from[1]) - fz(mouth[0], mouth[1]);
    if (drop / (5 * CELL) > 0.002) continue;
    const k0 = moved.length - 1 - Math.round(5 / STEP), o = moved[Math.max(0, k0)], dx = mouth[0] - o[0], dy = mouth[1] - o[1], l = Math.hypot(dx, dy) || 1;
    for (const turn of [-0.6, 0.6]) {
      const c = Math.cos(turn), sn = Math.sin(turn), ux = (dx * c - dy * sn) / l, uy = (dx * sn + dy * c) / l, arm: Pt[] = [];
      for (let s = 0; s <= l * 1.15; s += STEP) arm.push([o[0] + ux * s, o[1] + uy * s, o[2] * 0.3, o[3], o[4] * 0.3]);
      const tip = arm.at(-1)!;
      if (arm.length > 2 && open[clamp(Math.round(tip[1]), 0, N - 1) * N + clamp(Math.round(tip[0]), 0, N - 1)]) out.push(arm);
    }
  }
  return out;
}
