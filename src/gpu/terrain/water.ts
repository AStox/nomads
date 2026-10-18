// The island's water on the GPU: the hydrology as the kernels of wgsl/terrain-water.ts, integer arithmetic throughout (the
// model's constants and the Hydro type are src/terrain/water.ts). It takes the flood and the receivers from the upstream
// stages (upstream.ts) and returns a Hydro. Every field is one i32 word a cell, in the unit and scale the kernel's
// header gives (INPUTS and OUTPUTS there); converted here at the edges only:
// - inputs: heights, depths and drift thickness are Q12.20 metres (|z| under 1024 m); rain and PET are Q16 millimetres;
//   the receivers, the rock and drift classes and the basin flags are integers.
// - outputs: water, table, season tables and the deepest table are Q12.20 metres; flows (mean, seasonal, bankfull,
//   spring) are Q6.26 cubic metres a second; the groundwater share and the power are Q16; the slope is Q2.30; the
//   stream's flow under its bed is Q24.40 in two words.
// What stays on the CPU: the rivers' polylines (the walk down each channel from its source, then chaikin and shape), which
// are lists of different lengths where a line's shape depends on the lines placed before it, so they do not parallelise;
// they take the GPU's fields as inputs. The springs' list is made from the GPU's flags in cell order.
import type { Climate } from "../../terrain/climate";
import { LEN, N } from "../../terrain/grid";
import { DRIFTS, ROCKS } from "../../terrain/geology";
import { BANKFULL, shape, YEAR_S, type Hydro, type River } from "../../terrain/water";
import type { Gpu } from "../device";
import { dispatch, pipeline, readback, storage } from "../kernel";
import { AT_OF, AT_REGIONS, ENTRIES, FIELD, FIELDS, MISC, OUTPUTS, TS, WATER_WGSL, ZS } from "../wgsl/terrain-water";

export type HydroInput = {
  h: Float32Array; filled: Float32Array; to: Int32Array; basin: Uint8Array; rock: Uint8Array; drift: Uint8Array; driftDepth: Float32Array;
  air: Pick<Climate, "seasons">;
};

const S = 4;
// The first solve's sweeps at most, and the second's.
const FIRST_SWEEPS = 150, SECOND_SWEEPS = 1500;
// Heads and heights are held Q12.20 and offset by 2^30 inside a sweep, so none may reach 1024 m.
const MOST_Z = 1024;
// A sweep sums the four faces of a cell, each at most its own transmissivity, in a u32.
const MOST_T = 2 ** 32 / (4 * TS);

const toZ = (x: number) => Math.round(x * ZS);
const toQ16 = (x: number) => Math.round(x * 65536);
// What a height keeps below toZ's last place, in units of 2^-31 of it (a float32 holds all of it): the kernel takes the fall
// between two cells from both words.
const lowZ = (x: number) => Math.round((x * ZS - toZ(x)) * 2 ** 31);

function pack(input: HydroInput): Int32Array {
  const { h, filled, to, basin, rock, drift, driftDepth, air } = input;
  if (air.seasons.length !== S) throw new Error(`hydrologyGpu: ${air.seasons.length} seasons, wanted ${S}`);
  const words = new Int32Array(FIELDS.length * LEN);
  const put = (name: string, f: (i: number) => number) => {
    const at = FIELD[name] * LEN;
    for (let i = 0; i < LEN; i++) words[at + i] = f(i);
  };
  for (let i = 0; i < LEN; i++) {
    if (Math.abs(h[i]) >= MOST_Z || Math.abs(filled[i]) >= MOST_Z) throw new Error("hydrologyGpu: a height reaches 1024 m");
    const t = ROCKS[rock[i]].ksat * ROCKS[rock[i]].thick * YEAR_S + DRIFTS[drift[i]].ksat * YEAR_S * driftDepth[i];
    if (t >= MOST_T) throw new Error("hydrologyGpu: a cell's transmissivity passes what a sweep's sum of four faces holds");
  }
  put("sea", (i) => (filled[i] < 0 ? 1 : 0));
  put("h", (i) => toZ(h[i]));
  put("hlo", (i) => lowZ(h[i]));
  put("filled", (i) => toZ(filled[i]));
  put("flo", (i) => lowZ(filled[i]));
  put("to", (i) => to[i]);
  put("basin", (i) => basin[i]);
  put("rock", (i) => rock[i]);
  put("drift", (i) => drift[i]);
  put("dd", (i) => toZ(driftDepth[i]));
  air.seasons.forEach((s, k) => {
    put(`pr${k}`, (i) => toQ16(s.precip[i]));
    put(`pe${k}`, (i) => toQ16(s.pet[i]));
  });
  return words;
}

type Run = { g: Gpu; F: GPUBuffer; AT: GPUBuffer; owned: GPUBuffer[] };

function step(run: Run, entry: (typeof ENTRIES)[number], params: number[] = [], groups = LEN / 256) {
  const P = storage(run.g, Uint32Array.from([...params, 0, 0, 0, 0]));
  run.owned.push(P);
  dispatch(run.g, pipeline(run.g, WATER_WGSL, entry), [run.F, run.AT, P], [groups]);
}

// weights 0: one a cell, so the gather is the drainage area in cells; 1: the year's surplus over each cell
const areas = (run: Run) => {
  step(run, "weights", [0]);
  step(run, "gather", [1, FIELD.wt0 * LEN, FIELD.ga0l * LEN], 1);
};
const routes = (run: Run) => {
  step(run, "routeprep");
  step(run, "gather", [5, FIELD.wt0 * LEN, FIELD.ga0l * LEN], 1);
  step(run, "routefin");
};
const solve = (run: Run, most: number, sweepsAt: number) => {
  step(run, "aqprep");
  step(run, "aqw");
  step(run, "aquifer", [most, sweepsAt], 1);
  step(run, "outflux");
};

function sequence(run: Run) {
  step(run, "prep");
  step(run, "hollows", [], 1);
  step(run, "levels", [], 1);
  areas(run);
  step(run, "channels", [], 1);
  step(run, "weights", [1]);
  step(run, "gather", [1, FIELD.wt0 * LEN, FIELD.ga0l * LEN], 1);
  step(run, "flow0");
  step(run, "fixedset", [0]);
  solve(run, FIRST_SWEEPS, MISC.sweeps1);
  routes(run);
  // the lakes: a candidate level for each basin cell, 65,536 threads cover any count of them
  step(run, "lakeprep");
  step(run, "lakecand");
  step(run, "lakelevel");
  step(run, "lakewater");
  step(run, "afterlake");
  areas(run);
  step(run, "channels", [], 1);
  step(run, "fixedset", [1]);
  solve(run, SECOND_SWEEPS, MISC.sweeps2);
  routes(run);
  step(run, "quicksum", [], 1);
  step(run, "tables");
  step(run, "seasons");
  step(run, "banks");
  step(run, "reach", [], 1);
  step(run, "valley");
  step(run, "under");
  step(run, "springs");
}

// What a run leaves: the named fields' words (the outputs when none are named), the misc words and the atomic counters.
export type Raw = { fields: Record<string, Int32Array>; misc: Int32Array; lakes: number; basins: number; flags: number };

export async function hydrologyRaw(g: Gpu, input: HydroInput, names: readonly string[] = OUTPUTS): Promise<Raw> {
  const F = storage(g, pack(input)), AT = storage(g, AT_REGIONS.length * LEN * 4);
  const run: Run = { g, F, AT, owned: [] };
  sequence(run);
  const fields: Record<string, Int32Array> = {};
  for (const name of names) fields[name] = new Int32Array(await readback(g, F, LEN * 4, FIELD[name] * LEN * 4));
  const misc = new Int32Array(await readback(g, F, 64 * 4, FIELD.misc * LEN * 4));
  const counters = new Uint32Array(await readback(g, AT, 12, AT_OF.cnt * LEN * 4));
  for (const b of [F, AT, ...run.owned]) b.destroy();
  return { fields, misc, basins: counters[0], flags: counters[1], lakes: counters[2] };
}

const asFloat = (w: Int32Array, scale: number) => Float32Array.from(w, (v) => v / scale);
const FQ = 2 ** 26, S30 = 2 ** 30;

export async function hydrologyGpu(g: Gpu, input: HydroInput): Promise<Hydro> {
  const raw = await hydrologyRaw(g, input);
  if (raw.flags & 1) throw new Error("hydrologyGpu: a receiver chain does not end at a root");
  if (raw.flags & 2) throw new Error("hydrologyGpu: a flow path is longer than the counting sort holds");
  const f = raw.fields;
  for (let i = 0; i < LEN; i++) if ((f.flow[i] >>> 0) * BANKFULL >= 2 ** 32) throw new Error("hydrologyGpu: a flow passes 4 m3 a second, which the bankfull flow's word cannot hold");
  const fq = (name: string) => asFloat(f[name], FQ);
  const season = (stem: string, scale: number) => Array.from({ length: S }, (_, s) => asFloat(f[`${stem}${s}`], scale));
  const channel = Uint8Array.from(f.chn), open = f.open;
  const flow = fq("flow"), base = asFloat(f.base, 65536), qbf = fq("qbf"), slope = asFloat(f.slope, S30);
  const under = (i: number) => ((f.rtl[i] >>> 0) + (f.rth[i] >>> 0) * 2 ** 32) / 2 ** 40;
  const { to } = input;

  // the channels' lines: from each source, the cells down to where the stream meets the sea or a lake
  const fed = new Uint8Array(LEN), traced = new Uint8Array(LEN), lines: number[][] = [];
  for (let i = 0; i < LEN; i++) if (channel[i] && to[i] !== i) fed[to[i]] = 1;
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
  const rivers = lines.map((line) => line.map((i): River => [i % N, Math.floor(i / N), flow[i], base[i], qbf[i], slope[i], channel[i] ? under(i) : 0]));

  const spring = fq("spring"), springs: Hydro["springs"] = [];
  for (let i = 0; i < LEN; i++) if (f.spf[i]) springs.push([i % N, Math.floor(i / N), Math.round(spring[i] * 1e4) / 1e4]);

  // each season's quick runoff over every cell, 64 bits a season in the misc words, against their mean
  const quick = Array.from({ length: S }, (_, s) => ((raw.misc[MISC.quick + 2 * s] >>> 0) + (raw.misc[MISC.quick + 2 * s + 1] >>> 0) * 2 ** 32));
  const mean = quick.reduce((a, b) => a + b, 0) / S;
  const seasonTable = season("stb", ZS);
  return {
    water: asFloat(f.water, ZS), flow, seasonFlow: season("sf", FQ), table: asFloat(f.tab, ZS), seasonTable, winterTable: seasonTable[S - 1], dryTable: asFloat(f.dry, ZS),
    spring, base, valley: Float32Array.from(f.valley), channel, qbf, slope, power: asFloat(f.pwr, 65536), quick: quick.map((q) => q / Math.max(1e-9, mean)),
    rivers: shape(rivers), springs, lakes: raw.lakes,
  };
}
