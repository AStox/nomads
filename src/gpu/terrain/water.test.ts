// The hydrology on the GPU against src/terrain/water.ts hydrology(), the float stage that has no groundwater
// evapotranspiration, on the inputs islands 1 to 3 give it (taken from the generator's own call, so they are exactly what
// the CPU saw). The GPU stage differs from the CPU's in one law, the groundwater's evapotranspiration in the aquifer and in
// the seasons' draw (wgsl/terrain-water.ts), which acts only where the soil's bucket leaves demand unmet. So the test asks:
// 1. with no unmet demand anywhere (the rain raised to the potential evaporation where it falls short, on the same
//    island), every output field is within a stated tolerance of the CPU's, because the law then does nothing;
// 2. on the island itself, the one field the law cannot reach (the ground's fall to the receiver) is within tolerance, and
//    the changed ones obey the law: the head is its fixed point (the cell's balance with the sink closes, to the 2 mm the
//    sweeps stop at), the sink is between 0 and the unmet demand and nothing where there is none, the budget the kernel
//    keeps for each cell is the law's, the table is no shallower and the flow to the sea no larger than the CPU's, by
//    about the water the sink takes;
// 3. the same words on a second run, and one island's time.
// One case a seed (the island takes some 10 s to make).
import { afterAll, expect, mock, test } from "bun:test";
import { CELL, LEN, N } from "../../terrain/grid";
import { DRIFTS, ROCKS } from "../../terrain/geology";
import { ROOTS } from "../../terrain/growth";
import { NICHE } from "../../terrain/niche";
import { YEAR_S, type Hydro } from "../../terrain/water";
import { releaseGpu, theGpu } from "../device";
import { KC_WET, SHAH_GRASS, SUMMER, textureClass } from "../wgsl/terrain-water";
import type { HydroInput } from "./water";

afterAll(releaseGpu);

// The generator calls hydrology once; this keeps what it was given (the drift is changed after the call, so copies) and
// the CPU's answer and time.
type Call = { input: HydroInput; order: Int32Array; cpu: Hydro; cpuMs: number };
const calls = new Map<number, Call>();
let seed = 0;
// the mock has to stand before the generator is loaded, so these are imported here, not at the top
const real = await import("../../terrain/water");
// the namespace follows the mock, so what the mock calls is taken before it stands
const cpuHydrology = real.hydrology, exports = { ...real };
mock.module("../../terrain/water", () => ({
  ...exports,
  hydrology: (...args: Parameters<typeof cpuHydrology>) => {
    const [h, filled, order, to, basin, air, rock, drift, driftDepth] = args;
    const t0 = performance.now();
    const cpu = cpuHydrology(...args);
    const cpuMs = performance.now() - t0;
    const seasons = air.seasons.map((s) => ({ precip: s.precip.slice(), pet: s.pet.slice() })) as unknown as typeof air.seasons;
    calls.set(seed, { input: { h: h.slice(), filled: filled.slice(), to: to.slice(), basin: basin.slice(), rock: rock.slice(), drift: drift.slice(), driftDepth: driftDepth.slice(), air: { seasons } }, order: order.slice(), cpu, cpuMs });
    return cpu;
  },
}));
const { generateIsland } = await import("../../terrain/island");
const { rng } = await import("../../sim/world");
const { hydrologyGpu, hydrologyRaw } = await import("./water");

// Each field's tolerance (max abs error against the CPU's float32 stage) and why it is enough. The reasons, in order:
// - water is Q12.20 (half a step 4.8e-7), spring Q6.26 (half a step 7e-9);
// - the flows follow the water table: a table off by 1e-4 m moves the groundwater a cell gives by 1e-4 m times its
//   transmissivity, and the sum of what comes out upstream of a cell by some 1e-6 m3/s of a flow of up to 1;
// - the water table, season tables and the deepest table (m) follow the aquifer's heads. The aquifer takes the CPU's own
//   number of sweeps and stops at its 2 mm change, and the heads agree to 1e-4 m after 150 to 500 sweeps (a rounding
//   in Q12.20 every update, which the over-relaxation amplifies). The CPU stage itself is float32: it stands 5.7e-5 m
//   from its own float64 version. The ground stage reads these tables against 0.2 m, 0.3 m and the roots' 1 m, so cells
//   within 3e-4 m of a threshold may fall on the other side, a few in 10,000;
// - base is a share of a flow and moves with it, most where the flow is tiny; qbf is 15 times the flow;
// - the slope's float32 steps near 0.6 are 6e-8; the power is up to 3,000 W/m2 and its error is where a flow is tiny.
// - valley and channel are decided by comparisons of integers made from the same inputs, and match cell for cell.
const TOL: Record<string, number> = {
  water: 1e-6, flow: 4e-6, seasonFlow: 1.2e-5, table: 3e-4, seasonTable: 3e-4, winterTable: 3e-4, dryTable: 4e-4, spring: 1e-7, base: 2e-3,
  valley: 0, channel: 0, qbf: 5e-5, slope: 1.2e-7, power: 0.02,
};
const QUICK_TOL = 1e-5, RIVER_XY_TOL = 2e-4, RIVER_UNDER_TOL = 1e-7;

const stats = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let max = 0, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { max, mean: sum / a.length };
};

const FLOATS = ["water", "flow", "table", "winterTable", "dryTable", "spring", "base", "valley", "qbf", "slope", "power"] as const;

function words(h: Hydro) {
  const out: [string, ArrayBufferView][] = FLOATS.map((k) => [k, h[k]]);
  out.push(["channel", h.channel]);
  h.seasonFlow.forEach((f, s) => out.push([`seasonFlow${s}`, f]));
  h.seasonTable.forEach((f, s) => out.push([`seasonTable${s}`, f]));
  return out;
}

// Every output against the CPU's, within TOL; the lines for the log.
function agree(label: string, a: Hydro, cpu: Hydro, springFloor = 0) {
  const lines: string[] = [];
  const tol = (name: string) => TOL[name.replace(/\d$/, "")];
  const ref = new Map(words(cpu));
  for (const [name, f] of words(a)) {
    const { max, mean } = stats(f as unknown as ArrayLike<number>, ref.get(name) as unknown as ArrayLike<number>);
    lines.push(`${name} max ${max.toExponential(2)} mean ${mean.toExponential(2)} (tolerance ${tol(name)})`);
    expect(max, `${label} ${name}`).toBeLessThanOrEqual(tol(name));
  }
  const q = a.quick.map((v, k) => Math.abs(v - cpu.quick[k]));
  lines.push(`quick max ${Math.max(...q).toExponential(2)} (tolerance ${QUICK_TOL})`);
  expect(Math.max(...q), `${label} quick`).toBeLessThanOrEqual(QUICK_TOL);
  expect(a.lakes, `${label} lakes`).toBe(cpu.lakes);
  expect(a.winterTable).toBe(a.seasonTable[3]);

  // the springs are where groundwater leaves a cell faster than a pool of it evaporates, a comparison that one cell in a
  // hundred or two can fall either side of; where the rain is raised and summer's evaporation is nothing the pool's
  // shortage is nothing, so any flow above nothing is a spring and the near-zero ones decide: those under 0.2 l/s are left
  // out of that comparison
  const has = new Map(cpu.springs.filter((p) => p[2] >= springFloor).map((p) => [p[1] * N + p[0], p[2]]));
  const gpu = new Map(a.springs.filter((p) => p[2] >= springFloor).map((p) => [p[1] * N + p[0], p[2]]));
  const extra = [...gpu.keys()].filter((k) => !has.has(k)).length, missing = [...has.keys()].filter((k) => !gpu.has(k)).length;
  const sv = Math.max(0, ...[...gpu].filter(([k]) => has.has(k)).map(([k, v]) => Math.abs(v - has.get(k)!)));
  lines.push(`springs of ${springFloor} m3/s or more ${gpu.size} against ${has.size}: ${extra} extra, ${missing} missing, value max ${sv.toExponential(2)}`);
  const slack = Math.max(1, Math.ceil(has.size / 150));
  expect(extra, `${label} springs extra`).toBeLessThanOrEqual(slack);
  expect(missing, `${label} springs missing`).toBeLessThanOrEqual(slack);
  expect(sv, `${label} spring values`).toBeLessThanOrEqual(1e-4 + 1e-9);

  // the rivers: the same lines through the same cells, each point where the CPU puts it
  expect(a.rivers.length, `${label} river lines`).toBe(cpu.rivers.length);
  const rm = [0, 0, 0, 0, 0, 0, 0];
  let points = 0;
  a.rivers.forEach((line, r) => {
    expect(line.length, `${label} river ${r} points`).toBe(cpu.rivers[r].length);
    line.forEach((p, k) => {
      points++;
      for (let c = 0; c < 7; c++) rm[c] = Math.max(rm[c], Math.abs(p[c] - cpu.rivers[r][k][c]));
    });
  });
  lines.push(`rivers ${a.rivers.length} lines, ${points} points; max over points of x ${rm[0].toExponential(2)} y ${rm[1].toExponential(2)} flow ${rm[2].toExponential(2)} base ${rm[3].toExponential(2)} qbf ${rm[4].toExponential(2)} slope ${rm[5].toExponential(2)} under ${rm[6].toExponential(2)}`);
  expect(Math.max(rm[0], rm[1]), `${label} river place`).toBeLessThanOrEqual(RIVER_XY_TOL);
  expect(rm[2], `${label} river flow`).toBeLessThanOrEqual(TOL.flow);
  expect(rm[3], `${label} river base`).toBeLessThanOrEqual(TOL.base);
  expect(rm[4], `${label} river qbf`).toBeLessThanOrEqual(TOL.qbf);
  expect(rm[5], `${label} river slope`).toBeLessThanOrEqual(TOL.slope);
  expect(rm[6], `${label} river fill`).toBeLessThanOrEqual(RIVER_UNDER_TOL);
  return lines;
}

// The soil's bucket as the stages keep it (water.ts 211 to 218): the year's unmet demand U and potential evaporation PET
// over each season, mm.
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

test.each([1, 2, 3])("water seed %i", async (s) => {
  seed = s;
  generateIsland(rng(s));
  const { input, order, cpu, cpuMs } = calls.get(s)!;
  const g = await theGpu();
  await hydrologyGpu(g, input); // the pipelines compile on first use
  const t0 = performance.now();
  const a = await hydrologyGpu(g, input);
  const ms = performance.now() - t0;
  const b = await hydrologyGpu(g, input);

  // the same words on a second run
  const bw = new Map(words(b));
  for (const [name, f] of words(a)) {
    const o = bw.get(name)!;
    expect(Buffer.from(f.buffer, f.byteOffset, f.byteLength).equals(Buffer.from(o.buffer, o.byteOffset, o.byteLength)), `seed ${s} ${name} run to run`).toBe(true);
  }
  expect(JSON.stringify([a.quick, a.lakes, a.springs, a.rivers]), `seed ${s} lists run to run`).toBe(JSON.stringify([b.quick, b.lakes, b.springs, b.rivers]));

  // 1. no unmet demand and no wet ground's extra evaporation: the same island with the rain raised to the potential
  // evaporation where it falls short and summer's potential evaporation nothing. The law does nothing, so the GPU is the
  // CPU's stage.
  const wetter: HydroInput = { ...input, air: { seasons: input.air.seasons.map((x, k) => ({ ...x, precip: Float32Array.from(x.precip, (p, i) => Math.max(p, x.pet[i])), pet: k === SUMMER ? new Float32Array(LEN) : x.pet })) as unknown as HydroInput["air"]["seasons"] } };
  expect(demand(wetter.air).unmet.every((u) => u.every((v) => v === 0)), `seed ${s} the raised rain leaves no demand unmet`).toBe(true);
  const cpuWet = cpuHydrology(input.h, input.filled, order, input.to, input.basin, wetter.air as never, input.rock, input.drift, input.driftDepth);
  const lines = agree(`seed ${s} (no unmet demand)`, await hydrologyGpu(g, wetter), cpuWet, 2e-4).map((l) => `no demand: ${l}`);

  // 2. the island itself. The fall to the receiver does not follow the head.
  const slope = stats(a.slope, cpu.slope);
  lines.push(`slope max ${slope.max.toExponential(2)} (tolerance ${TOL.slope})`);
  expect(slope.max, `seed ${s} slope`).toBeLessThanOrEqual(TOL.slope);

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

  // the response against the CPU's stage on the same island: the table is deeper (the sink takes water the CPU keeps), the
  // share of the land with the table at the ground is smaller, and the flow to the sea is smaller by about the water taken
  const land: number[] = [];
  for (let i = 0; i < LEN; i++) if (input.h[i] > 0 && !(cpu.water[i] > 0) && !(a.water[i] > 0)) land.push(i);
  const median = (v: Float32Array) => Float32Array.from(land, (i) => v[i]).sort()[land.length >> 1];
  const atGround = (v: Float32Array) => land.filter((i) => v[i] < 0.01).length / land.length;
  const sea = (h: Hydro) => { let q = 0; for (let i = 0; i < LEN; i++) if (input.h[i] > 0 && input.filled[i] >= 0 && input.filled[input.to[i]] < 0) q += h.flow[i]; return q; };
  const dq = sea(cpu) - sea(a), taken = eTotal / YEAR_S;
  lines.push(`response: median table ${median(cpu.table).toFixed(2)} to ${median(a.table).toFixed(2)} m; table under 1 cm ${(100 * atGround(cpu.table)).toFixed(1)} to ${(100 * atGround(a.table)).toFixed(1)}% of land; flow to the sea ${sea(cpu).toFixed(4)} to ${sea(a).toFixed(4)} m3/s, less ${dq.toFixed(4)} against ${taken.toFixed(4)} m3/s the sink takes`);
  expect(median(a.table), `seed ${s} median table`).toBeGreaterThan(median(cpu.table));
  expect(atGround(a.table), `seed ${s} table at the ground`).toBeLessThan(atGround(cpu.table));
  expect(dq, `seed ${s} flow to the sea`).toBeGreaterThan(0);
  expect(Math.abs(dq - taken) / taken, `seed ${s} the sea's loss is the sink's take`).toBeLessThan(0.25);
  for (let k = 0; k < 4; k++) expect(a.seasonTable[k].every((v, i) => v >= 0 && v <= Math.max(a.table[i], ROOTS) + 1e-6), `seed ${s} season ${k} table within its bounds`).toBe(true);
  expect(a.dryTable.every((v, i) => v >= a.seasonTable.reduce((m, t) => Math.max(m, t[i]), 0) - 1e-6), `seed ${s} dry table is the deepest`).toBe(true);

  // 3. sweeps taken by the two solves, and the time without the CPU's rivers
  const raw0 = await hydrologyRaw(g, input, []);
  const t1 = performance.now();
  await hydrologyRaw(g, input, []);
  const kernelMs = performance.now() - t1;
  expect(raw0.flags).toBe(0);
  console.log(`seed ${s}: ${ms.toFixed(1)} ms for hydrologyGpu (kernels and read-back ${kernelMs.toFixed(1)}), the CPU's hydrology ${cpuMs.toFixed(1)} ms; ${raw0.lakes} lakes, sweeps ${raw0.misc[2]} and ${raw0.misc[3]}, ${LEN} cells\n  ${lines.join("\n  ")}`);
}, 300_000);
