// The hydrology on the GPU against src/terrain/water.ts hydrology(): each output field within a stated tolerance of the
// float stage on the inputs islands 1 to 3 give it (taken from the generator's own call, so they are exactly what the
// CPU saw), the same words on a second run, and one island's time. One case a seed (the island takes some 10 s to make).
import { afterAll, expect, mock, test } from "bun:test";
import { LEN, N } from "../../terrain/grid";
import type { Hydro } from "../../terrain/water";
import { releaseGpu, theGpu } from "../device";
import type { HydroInput } from "./water";

afterAll(releaseGpu);

// The generator calls hydrology once; this keeps what it was given (the drift is changed after the call, so copies) and
// the CPU's answer and time.
type Call = { input: HydroInput; cpu: Hydro; cpuMs: number };
const calls = new Map<number, Call>();
let seed = 0;
// the mock has to stand before the generator is loaded, so these are imported here, not at the top
const real = await import("../../terrain/water");
// the namespace follows the mock, so what the mock calls is taken before it stands
const cpuHydrology = real.hydrology, exports = { ...real };
mock.module("../../terrain/water", () => ({
  ...exports,
  hydrology: (...args: Parameters<typeof cpuHydrology>) => {
    const [h, filled, , to, basin, air, rock, drift, driftDepth] = args;
    const t0 = performance.now();
    const cpu = cpuHydrology(...args);
    const cpuMs = performance.now() - t0;
    const seasons = air.seasons.map((s) => ({ precip: s.precip.slice(), pet: s.pet.slice() })) as unknown as typeof air.seasons;
    calls.set(seed, { input: { h: h.slice(), filled: filled.slice(), to: to.slice(), basin: basin.slice(), rock: rock.slice(), drift: drift.slice(), driftDepth: driftDepth.slice(), air: { seasons } }, cpu, cpuMs });
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

test.each([1, 2, 3])("water seed %i", async (s) => {
  seed = s;
  generateIsland(rng(s));
  const { input, cpu, cpuMs } = calls.get(s)!;
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

  // the fields
  const lines: string[] = [];
  const tol = (name: string) => TOL[name.replace(/\d$/, "")];
  const ref = new Map(words(cpu));
  for (const [name, f] of words(a)) {
    const { max, mean } = stats(f as unknown as ArrayLike<number>, ref.get(name) as unknown as ArrayLike<number>);
    lines.push(`${name} max ${max.toExponential(2)} mean ${mean.toExponential(2)} (tolerance ${tol(name)})`);
    expect(max, `seed ${s} ${name}`).toBeLessThanOrEqual(tol(name));
  }
  const q = a.quick.map((v, k) => Math.abs(v - cpu.quick[k]));
  lines.push(`quick max ${Math.max(...q).toExponential(2)} (tolerance ${QUICK_TOL})`);
  expect(Math.max(...q), `seed ${s} quick`).toBeLessThanOrEqual(QUICK_TOL);
  expect(a.lakes, `seed ${s} lakes`).toBe(cpu.lakes);
  expect(a.winterTable).toBe(a.seasonTable[3]);

  // the springs are where groundwater leaves a cell faster than a pool of it evaporates, a comparison that one cell in a few
  // hundred can fall either side of
  const has = new Map(cpu.springs.map((p) => [p[1] * N + p[0], p[2]]));
  const gpu = new Map(a.springs.map((p) => [p[1] * N + p[0], p[2]]));
  const extra = [...gpu.keys()].filter((k) => !has.has(k)).length, missing = [...has.keys()].filter((k) => !gpu.has(k)).length;
  const sv = Math.max(0, ...[...gpu].filter(([k]) => has.has(k)).map(([k, v]) => Math.abs(v - has.get(k)!)));
  lines.push(`springs ${a.springs.length} against ${cpu.springs.length}: ${extra} extra, ${missing} missing, value max ${sv.toExponential(2)}`);
  expect(extra, `seed ${s} springs extra`).toBeLessThanOrEqual(1);
  expect(missing, `seed ${s} springs missing`).toBeLessThanOrEqual(1);
  expect(sv, `seed ${s} spring values`).toBeLessThanOrEqual(1e-4 + 1e-9);

  // the rivers: the same lines through the same cells, each point where the CPU puts it
  expect(a.rivers.length, `seed ${s} river lines`).toBe(cpu.rivers.length);
  const rm = [0, 0, 0, 0, 0, 0, 0];
  let points = 0;
  a.rivers.forEach((line, r) => {
    expect(line.length, `seed ${s} river ${r} points`).toBe(cpu.rivers[r].length);
    line.forEach((p, k) => {
      points++;
      for (let c = 0; c < 7; c++) rm[c] = Math.max(rm[c], Math.abs(p[c] - cpu.rivers[r][k][c]));
    });
  });
  lines.push(`rivers ${a.rivers.length} lines, ${points} points; max over points of x ${rm[0].toExponential(2)} y ${rm[1].toExponential(2)} flow ${rm[2].toExponential(2)} base ${rm[3].toExponential(2)} qbf ${rm[4].toExponential(2)} slope ${rm[5].toExponential(2)} under ${rm[6].toExponential(2)}`);
  expect(Math.max(rm[0], rm[1]), `seed ${s} river place`).toBeLessThanOrEqual(RIVER_XY_TOL);
  expect(rm[2], `seed ${s} river flow`).toBeLessThanOrEqual(TOL.flow);
  expect(rm[3], `seed ${s} river base`).toBeLessThanOrEqual(TOL.base);
  expect(rm[4], `seed ${s} river qbf`).toBeLessThanOrEqual(TOL.qbf);
  expect(rm[5], `seed ${s} river slope`).toBeLessThanOrEqual(TOL.slope);
  expect(rm[6], `seed ${s} river fill`).toBeLessThanOrEqual(RIVER_UNDER_TOL);

  // sweeps taken by the two solves, and the time without the CPU's rivers
  const raw = await hydrologyRaw(g, input, []);
  const t1 = performance.now();
  await hydrologyRaw(g, input, []);
  const kernelMs = performance.now() - t1;
  expect(raw.flags).toBe(0);
  console.log(`seed ${s}: ${ms.toFixed(1)} ms for hydrologyGpu (kernels and read-back ${kernelMs.toFixed(1)}), the CPU's hydrology ${cpuMs.toFixed(1)} ms; ${raw.lakes} lakes, sweeps ${raw.misc[2]} and ${raw.misc[3]}, ${LEN} cells\n  ${lines.join("\n  ")}`);
}, 300_000);
