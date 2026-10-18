// The hydrology kernels (wgsl/terrain-water.ts) on the inputs islands 1 to 3 give them: the island's own upstream stages
// and its climate, run as the generator runs them. The kernels are the one implementation of the stage, so the test asks
// what any correct run must show, and pins what this one does:
// 1. the head is the law's fixed point: each cell's balance (the four faces, its recharge, less the groundwater's sink)
//    closes to the 2 mm the sweeps stop at, the sink is between 0 and the unmet demand and the wet ground's extra, and
//    the budget the kernel keeps for each cell is the law's;
// 2. the outputs agree with one another and with the laws that define them: the slope is the fall to the receiver, the
//    flow is the seasons' mean, the bankfull flow and the stream power follow from it, nothing under open water has a
//    table, a spring or a channel, the seasons' tables stay inside their bounds, and the spring list is the spring field's
//    local maxima;
// 3. the same words on a second run, and one island's time;
// 4. a golden hash of every output (see GOLDEN).
// One case a seed (the island takes some 10 s to make).
import { afterAll, expect, test } from "bun:test";
import { rng } from "../../sim/world";
import { CELL, LEN, N } from "../../terrain/grid";
import { DRIFTS, ROCKS } from "../../terrain/geology";
import { ROOTS } from "../../terrain/growth";
import { upstream } from "../../terrain/island";
import { NICHE } from "../../terrain/niche";
import { BANKFULL, FALL, RHO, G, YEAR_S, bankWidth, type Hydro } from "../../terrain/water";
import { releaseGpu, theGpu } from "../device";
import { KC_WET, SHAH_GRASS, SUMMER, textureClass } from "../wgsl/terrain-water";
import { climateGpu } from "./island";
import { hydrologyGpu, hydrologyRaw, type HydroInput } from "./water";

afterAll(releaseGpu);

// The hash (Bun.hash, hex) of every output's bytes in the order words() gives them, then the lists as JSON, per island.
// It pins the kernels' integer arithmetic and the CPU polylines made from it bit for bit, so any change to the water
// model or its constants moves it. When the model changes on purpose, re-record these from the failure message, and say
// in the commit message why they moved.
const GOLDEN: Record<number, string> = { 1: "82ef6d33794cb751", 2: "8f11b1a86018c761", 3: "51c56265234b3bf6" };

// What the generator hands the hydrology: the upstream stages and the climate, the same draws in the same order.
async function inputOf(seed: number): Promise<HydroInput> {
  const rand = rng(seed);
  const { height, filled, to, basin, rock, drift, driftDepth, open } = upstream(rand);
  const air = await climateGpu(await theGpu(), height, open, rand);
  return { h: height, filled, to, basin, rock, drift, driftDepth, air };
}

const FLOATS = ["water", "flow", "table", "winterTable", "dryTable", "spring", "base", "valley", "qbf", "slope", "power"] as const;

function words(h: Hydro) {
  const out: [string, ArrayBufferView][] = FLOATS.map((k) => [k, h[k]]);
  out.push(["channel", h.channel]);
  h.seasonFlow.forEach((f, s) => out.push([`seasonFlow${s}`, f]));
  h.seasonTable.forEach((f, s) => out.push([`seasonTable${s}`, f]));
  return out;
}

function digest(h: Hydro): string {
  const parts = words(h).map(([, f]) => Buffer.from(f.buffer, f.byteOffset, f.byteLength));
  parts.push(Buffer.from(JSON.stringify([h.quick, h.lakes, h.springs, h.rivers])));
  return Bun.hash(Buffer.concat(parts)).toString(16);
}

// The soil's bucket as the stages keep it: the year's unmet demand U and potential evaporation PET over each season, mm.
function demand(air: HydroInput["air"]) {
  const unmet = air.seasons.map(() => new Float64Array(LEN)), pet = air.seasons.map((s) => Float64Array.from(s.pet));
  for (let i = 0; i < LEN; i++) {
    let store = 100;
    for (let year = 0; year < 2; year++)
      air.seasons.forEach((s, k) => {
        const have = store + s.precip[i], used = Math.min(s.pet[i], have), left = have - used, over = Math.max(0, left - 100);
        store = left - over;
        if (year) unmet[k][i] = s.pet[i] - used;
      });
  }
  return { unmet, pet };
}

// The law's fall f(d), from the cell's texture as the kernel blends it: the drift's over as much of the roots as it fills
// and the rock's below; d'' (m), b (per m), and the rescaling to reach 0 at the extinction depth.
function fall(drift: number, rock: number, depth: number) {
  const gw = (m: { sand: number; clay: number }) => {
    const [d, b, ext] = SHAH_GRASS[textureClass(m.sand, m.clay)], e0 = Math.exp(-b * (ext - d));
    return [d / 100, b * 100, e0, 1 / (1 - e0)];
  };
  const w = Math.min(1, depth / ROOTS), a = gw(DRIFTS[drift]), b = gw(ROCKS[rock]), p = a.map((v, k) => v * w + b[k] * (1 - w));
  return (d: number) => (d <= p[0] ? 1 : Math.max(0, (Math.exp(-p[1] * (d - p[0])) - p[2]) * p[3]));
}

const maxOf = (n: number, f: (i: number) => number) => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, f(i)); return m; };

test.each([1, 2, 3])("water seed %i", async (s) => {
  const input = await inputOf(s);
  const g = await theGpu();
  await hydrologyGpu(g, input); // the pipelines compile on first use
  const t0 = performance.now();
  const a = await hydrologyGpu(g, input);
  const ms = performance.now() - t0;
  const b = await hydrologyGpu(g, input);
  const lines: string[] = [];

  // the same words on a second run
  const bw = new Map(words(b));
  for (const [name, f] of words(a)) {
    const o = bw.get(name)!;
    expect(Buffer.from(f.buffer, f.byteOffset, f.byteLength).equals(Buffer.from(o.buffer, o.byteOffset, o.byteLength)), `seed ${s} ${name} run to run`).toBe(true);
  }
  expect(JSON.stringify([a.quick, a.lakes, a.springs, a.rivers]), `seed ${s} lists run to run`).toBe(JSON.stringify([b.quick, b.lakes, b.springs, b.rivers]));

  // the head is the law's fixed point: each cell's balance (the four faces, its recharge, less the sink) closes where the
  // head is below the ground, and leaves water to seep out where it stands at the ground
  const raw = await hydrologyRaw(g, input, ["head", "out", "isf", "rr", "ce", "cs", "open", "tab"]);
  const f = raw.fields, Z = 2 ** 20, A = CELL * CELL, T = 2 ** 13;
  const { unmet, pet } = demand(input.air);
  let wxTotal = 0, worst = 0, worstCell = 0, checked = 0, eTotal = 0, uTotal = 0, bad = 0, seep = 0, capped = 0, sinkCells = 0, outOff = 0;
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      if (f.isf[i] || f.open[i]) continue;
      const head = f.head[i] / Z, z = input.h[i], d = Math.max(0, z - head);
      const u = unmet.reduce((t, k) => t + k[i], 0) / 1000;
      const fr = u > 0 ? fall(input.drift[i], input.rock[i], input.driftDepth[i])(d) : 0;
      const [full, none] = [NICHE.reeds.table![2], NICHE.reeds.table![3]];
      const wetExtra = ((KC_WET - 1) * pet[SUMMER][i] * (d <= full ? 1 : d >= none ? 0 : (none - d) / (none - full))) / 1000;
      const e = (u > 0 ? unmet.reduce((t, k, q) => t + Math.min(k[i], pet[q][i] * fr), 0) / 1000 : 0) + wetExtra;
      expect(e, `seed ${s} cell ${i} sink at least 0`).toBeGreaterThanOrEqual(0);
      expect(e, `seed ${s} cell ${i} sink at most the unmet demand and the wet ground's extra`).toBeLessThanOrEqual(u + ((KC_WET - 1) * pet[SUMMER][i]) / 1000 + 1e-12);
      const c = [f.ce[i - 1], f.ce[i], f.cs[i - N], f.cs[i]].map((v) => (v >>> 0) / T), h4 = [f.head[i - 1], f.head[i + 1], f.head[i - N], f.head[i + N]].map((v) => v / Z);
      const net = c.reduce((t, ck, k) => t + ck * (h4[k] - head), 0) + (f.rr[i] / 65536 / 1000) * A - e * A; // m3 a year
      const cSum = c.reduce((t, v) => t + v, 0);
      // the kernel's own budget for the cell is the law's
      outOff = Math.max(outOff, Math.abs(f.out[i] / 64 - net) / (cSum * 1e-3));
      eTotal += e * A; uTotal += u * A; wxTotal += wetExtra * A;
      if (e > 0) sinkCells++;
      if (head < z - 1e-4) {
        checked++;
        const r = Math.abs(net) / cSum; // metres of head the balance is out by
        if (r > worst) { worst = r; worstCell = i; }
        if (r > 0.1) bad++;
      } else {
        capped++;
        if (net < -cSum * 0.1) bad++; // the head stands at the ground only where water is left over to seep out
        if (net > 0) seep++;
      }
    }
  lines.push(`the law: ${checked} cells below the ground close their balance to within ${worst.toExponential(2)} m of head at worst (cell ${worstCell}); ${capped} at the ground, ${seep} of them seeping; ${sinkCells} cells draw, ${((eTotal / YEAR_S) * 1000).toFixed(1)} l/s drawn, ${((wxTotal / YEAR_S) * 1000).toFixed(1)} of it the wet ground's own and the rest for the ${((uTotal / YEAR_S) * 1000).toFixed(1)} l/s the bucket left unmet; the kernel's cell budget is the law's to ${outOff.toExponential(2)} mm of head`);
  expect(bad, `seed ${s} cells whose balance does not close`).toBe(0);
  expect(outOff, `seed ${s} kernel budget against the law`).toBeLessThanOrEqual(1);
  expect(sinkCells, `seed ${s} the sink acts`).toBeGreaterThan(1000);

  // the fall to the receiver, on the filled ground and to the sea's level at a mouth, in float64
  const slopeErr = maxOf(LEN, (i) => {
    const j = input.to[i];
    if (input.filled[i] < 0 || j === i) return Math.abs(a.slope[i]);
    const reach = Math.hypot((j % N) - (i % N), Math.floor(j / N) - Math.floor(i / N)) * CELL;
    return Math.abs(a.slope[i] - Math.max(FALL, input.filled[i] - Math.max(0, input.filled[j])) / reach);
  });
  lines.push(`slope against the fall to the receiver, max error ${slopeErr.toExponential(2)}`);
  expect(slopeErr, `seed ${s} slope`).toBeLessThanOrEqual(1.2e-7);

  // the flow is the seasons' mean, the bankfull flow is its fixed multiple, and a channel's power is the bankfull flow's
  // specific power on wooded banks
  const meanErr = maxOf(LEN, (i) => Math.abs(a.flow[i] - a.seasonFlow.reduce((t, q) => t + q[i], 0) / 4));
  const qbfErr = maxOf(LEN, (i) => (input.filled[i] < 0 ? Math.abs(a.qbf[i]) : Math.abs(a.qbf[i] - BANKFULL * a.flow[i])));
  const powerErr = maxOf(LEN, (i) => {
    if (!a.channel[i]) return Math.abs(a.power[i]);
    const want = a.qbf[i] > 0 ? (RHO * G * a.qbf[i] * a.slope[i]) / bankWidth(a.qbf[i], true) : 0;
    return Math.abs(a.power[i] - want) / Math.max(1, want);
  });
  lines.push(`flow against the seasons' mean ${meanErr.toExponential(2)}, qbf against ${BANKFULL.toFixed(2)} times the flow ${qbfErr.toExponential(2)}, power against the law (relative) ${powerErr.toExponential(2)}`);
  expect(meanErr, `seed ${s} flow is the seasons' mean`).toBeLessThanOrEqual(1e-6);
  expect(qbfErr, `seed ${s} bankfull flow`).toBeLessThanOrEqual(5e-5);
  expect(powerErr, `seed ${s} stream power`).toBeLessThanOrEqual(1e-3);

  // the sea is its depth, and nothing under open water has a table, a spring or a channel
  let channels = 0, lakeCells = 0;
  for (let i = 0; i < LEN; i++) {
    if (input.filled[i] < 0) expect(a.water[i], `seed ${s} sea at cell ${i}`).toBeCloseTo(-input.h[i], 5);
    if (a.channel[i]) channels++;
    if (!(a.water[i] > 0)) continue;
    if (input.filled[i] >= 0) lakeCells++;
    expect(a.table[i] + a.spring[i] + a.dryTable[i] + a.channel[i] + a.seasonTable.reduce((t, q) => t + q[i], 0), `seed ${s} cell ${i} under open water`).toBe(0);
  }
  expect(channels, `seed ${s} channels`).toBeGreaterThan(100);
  expect(a.lakes > 0 && lakeCells > 0, `seed ${s} lakes`).toBe(true);
  expect(a.base.every((v) => v >= 0 && v <= 1), `seed ${s} groundwater share in 0 to 1`).toBe(true);
  expect(a.valley.every((v) => v === 0 || v === 1), `seed ${s} valley is 0 or 1`).toBe(true);
  expect(Math.abs(a.quick.reduce((t, v) => t + v, 0) / 4 - 1), `seed ${s} the seasons' runoff averages its mean`).toBeLessThan(1e-6);

  // the seasons' tables and the winter's
  expect(a.winterTable).toBe(a.seasonTable[3]);
  for (let k = 0; k < 4; k++) expect(a.seasonTable[k].every((v, i) => v >= 0 && v <= Math.max(a.table[i], ROOTS) + 1e-6), `seed ${s} season ${k} table within its bounds`).toBe(true);
  expect(a.dryTable.every((v, i) => v >= a.seasonTable.reduce((m, t) => Math.max(m, t[i]), 0) - 1e-6), `seed ${s} dry table is the deepest`).toBe(true);

  // a spring is a local maximum of the spring field, listed at the field's value to the list's 0.1 ml/s
  let springErr = 0, springsAt = 0;
  for (const [x, y, v] of a.springs) {
    const i = y * N + x;
    springErr = Math.max(springErr, Math.abs(v - a.spring[i]));
    expect(a.spring[i], `seed ${s} spring at ${x},${y} has flow`).toBeGreaterThan(0);
    for (let d = 0; d < 8; d++) {
      const nx = x + [1, 1, 0, -1, -1, -1, 0, 1][d], ny = y + [0, 1, 1, 1, 0, -1, -1, -1][d];
      if (nx >= 0 && ny >= 0 && nx < N && ny < N) expect(a.spring[ny * N + nx], `seed ${s} spring at ${x},${y} is the local maximum`).toBeLessThanOrEqual(a.spring[i]);
    }
    springsAt++;
  }
  lines.push(`springs ${springsAt}, listed value against the field ${springErr.toExponential(2)}; ${a.rivers.length} river lines, ${a.lakes} lakes`);
  expect(springsAt, `seed ${s} springs`).toBeGreaterThan(0);
  expect(springErr, `seed ${s} spring values`).toBeLessThanOrEqual(5e-5 + 1e-9);
  expect(a.rivers.length, `seed ${s} river lines`).toBeGreaterThan(0);
  expect(a.rivers.every((line) => line.length > 1 && line.every((p) => p.every(Number.isFinite) && p[0] >= 0 && p[0] < N && p[1] >= 0 && p[1] < N)), `seed ${s} rivers`).toBe(true);

  // the golden
  const hash = digest(a);
  expect(hash, `seed ${s} golden, re-record deliberately`).toBe(GOLDEN[s]);

  // the kernels' time and the sweeps taken by the two solves
  const raw0 = await hydrologyRaw(g, input, []);
  const t1 = performance.now();
  await hydrologyRaw(g, input, []);
  const kernelMs = performance.now() - t1;
  expect(raw0.flags).toBe(0);
  console.log(`seed ${s}: ${ms.toFixed(1)} ms for hydrologyGpu (kernels and read-back ${kernelMs.toFixed(1)}); ${raw0.lakes} lakes, sweeps ${raw0.misc[2]} and ${raw0.misc[3]}, ${LEN} cells; golden ${hash}\n  ${lines.join("\n  ")}`);
}, 300_000);
