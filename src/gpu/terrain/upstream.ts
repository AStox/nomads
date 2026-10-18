// The island's crust, its erosion, the ice's scour and till and the hollows on the GPU: the kernels of
// wgsl/terrain-upstream.ts, integer arithmetic throughout (the model's constants and the Upstream type are
// src/terrain/island.ts). A run takes what the generator's stream gives first, a few numbers, and returns an Upstream
// of the shapes every reader of one expects. Every field is one i32 word a cell in the unit the kernel's header gives,
// converted here at the edges only:
// - heights, depths, the till and the flooded surface come back as Q12.20 metres, the classes and flags as integers;
// - the parameters in (the noise's permutation tables, the oval's tilt and stretch, the faults, the key of the stream
//   the dykes and valleys draw from) are integers made from the generator's first draws with the four operations of
//   IEEE arithmetic only, so every engine makes the same words.
// What the CPU did not need a name for is named here: the generator's draws come in a fixed order (the oval and its
// faults first, then one draw a dyke, then three a valley and one a line), and this host takes the first of them from the
// stream it is given, in the CPU's order, and the kernels read the rest as words of a Philox stream keyed by two more
// draws, in that same order (wgsl/terrain-upstream.ts joints, dykes). The islands therefore differ from the old CPU
// ones in where the dykes and the joint valleys fall; everything else is the same laws.
// The one number of the erosion the kernels do not make is the step: the response time (the longest of the sums of
// dx / (K sqrt(A)) up the flow paths) comes back as two words after the first flood, and the host makes the step, the
// creep's substeps and each rock's K dt from it in IEEE arithmetic (sqrt, ceil and the four operations).
import { simplex2d } from "math/noise";
import { CELL, LEN, N } from "../../terrain/grid";
import { CREEP, GRANITE, ROCKS } from "../../terrain/geology";
import { ADVERSE, ERODE, U0, type Upstream, type Watch } from "../../terrain/island";
import type { Gpu } from "../device";
import { readback, storage } from "../kernel";
import { AT_OF, AT_REGIONS, CNT, DRN, ENTRIES, FIELD, FIELDS, FLAG, MAXD, MISC, OUTPUTS, PAR, UPSTREAM_WGSL, VMAX, VT, ZS } from "../wgsl/terrain-upstream";

// What the generator draws first, in its order: the three permutation tables (the warp's, the coast's and the bend's), the
// oval's tilt and stretch, the three faults, and the key of the stream the rest read.
export type Plan = {
  perms: Uint8Array[];
  tilt: number; // the draw, 0 to 1: the tilt as a fraction of pi
  stretch: number;
  faults: { x: number; y: number; thr: number; side: 1 | -1; az: number }[]; // metres, metres, metres thrown, which side, azimuth over 180
  key: [number, number];
};

// Takes the draws from a stream in the order the CPU did, then two more for the Philox key.
export function planFrom(rand: () => number): Plan {
  const gen = () => simplex2d.create(Math.floor(rand() * 65536)).perm;
  const perms = [gen(), gen(), gen()];
  const tilt = rand(), stretch = 0.8 + rand() * 0.35;
  const faults = [135, 0, 135].map((az) => ({
    x: (0.3 + 0.4 * rand()) * N * CELL, y: (0.45 + 0.4 * rand()) * N * CELL,
    thr: 50 + 200 * rand(), side: (az ? 1 : rand() < 0.5 ? 1 : -1) as 1 | -1, az: az / 180,
  }));
  const key: [number, number] = [Math.floor(rand() * 2 ** 32), Math.floor(rand() * 2 ** 32)];
  return { perms, tilt, stretch, faults, key };
}

function parameters(p?: Plan): Uint32Array {
  const w = new Uint32Array(PAR.size);
  w[PAR.adverse] = Math.round(ADVERSE * 2 ** 30);
  if (!p) return w;
  p.perms.forEach((perm, k) => w.set(perm, PAR.perm + 512 * k));
  w[PAR.tilt] = Math.round(p.tilt * 2 ** 32) >>> 0;
  w[PAR.stretch] = Math.round(p.stretch * 2 ** 30);
  w[PAR.invStretch] = Math.round((1 / p.stretch) * 2 ** 30);
  p.faults.forEach((f, k) => {
    const o = PAR.fault + 8 * k;
    w[o] = Math.round(f.x * 2 ** 15); w[o + 1] = Math.round(f.y * 2 ** 15); w[o + 2] = Math.round(f.thr * ZS);
    w[o + 3] = f.side >>> 0; w[o + 4] = Math.round(f.az * 2 ** 32) >>> 0;
  });
  w[PAR.key0] = p.key[0]; w[PAR.key1] = p.key[1];
  return w;
}

type Entry = (typeof ENTRIES)[number];
type Kernels = { bgl: GPUBindGroupLayout; ps: Record<string, GPUComputePipeline> };
type Run = { g: Gpu; F: GPUBuffer; AT: GPUBuffer; P: GPUBuffer; ps: Record<string, GPUComputePipeline>; bind: GPUBindGroup; enc: GPUCommandEncoder; pass: GPUComputePassEncoder };
const CELLS = LEN / 256;

// Every entry point on one explicit layout (the fields, the atomics, the parameters) so that one bind group serves them all,
// compiled together on the GPU process's own threads, once for a device.
const kernels = new WeakMap<GPUDevice, Promise<Kernels>>();
function kernelsOf(g: Gpu): Promise<Kernels> {
  let k = kernels.get(g.device);
  if (!k) {
    const device = g.device, COMPUTE = 4;
    const bgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: "storage" } },
      { binding: 1, visibility: COMPUTE, buffer: { type: "storage" } },
      { binding: 2, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
    ] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] }), module = device.createShaderModule({ code: UPSTREAM_WGSL });
    k = Promise.all(ENTRIES.map((e) => device.createComputePipelineAsync({ layout, compute: { module, entryPoint: e } })))
      .then((list) => ({ bgl, ps: Object.fromEntries(ENTRIES.map((e, i) => [e, list[i]])) }));
    kernels.set(device, k);
  }
  return k;
}

async function makeRun(g: Gpu, params: Uint32Array): Promise<Run> {
  const F = storage(g, FIELDS.length * LEN * 4), AT = storage(g, AT_REGIONS.length * LEN * 4), P = storage(g, params);
  const { bgl, ps } = await kernelsOf(g);
  const bind = g.device.createBindGroup({ layout: bgl, entries: [F, AT, P].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  return { g, F, AT, P, ps, bind, enc: undefined as never, pass: undefined as never };
}
const finish = (run: Run) => { for (const b of [run.F, run.AT, run.P]) b.destroy(); };

function open(run: Run) {
  run.enc = run.g.device.createCommandEncoder();
  run.pass = run.enc.beginComputePass();
  run.pass.setBindGroup(0, run.bind);
}
function submit(run: Run) {
  run.pass.end();
  run.g.device.queue.submit([run.enc.finish()]);
}
function d(run: Run, entry: Entry, groups = CELLS) {
  run.pass.setPipeline(run.ps[entry]);
  run.pass.dispatchWorkgroups(groups);
}

// the priority flood of F.h into AT.fl: the edge as it stands, then rounds of relaxation, the last of which flags if it
// still changed anything
function flood(run: Run, final: boolean, rounds: number) {
  d(run, final ? "epsf" : "epse", 1);
  d(run, "flinit");
  for (let r = 1; r < rounds; r++) d(run, "flood");
  d(run, "floodlast");
}
// receivers, then the depth sort that the gathers and the implicit step walk
function tree(run: Run) {
  d(run, "recv");
  d(run, "lvinit");
  for (let r = 0; r < 14; r += 2) { d(run, "jumpa"); d(run, "jumpb"); }
  d(run, "lvhist");
  d(run, "lvscan", 1);
  d(run, "lvscatter");
}

// the structure, the first flood and the response time
function lay(run: Run, rounds: number) {
  d(run, "draws", DRN / 256);
  d(run, "shape");
  d(run, "hinge", 1);
  d(run, "rocks");
  d(run, "dykes", 4);
  d(run, "rockfin");
  d(run, "shore1", 1);
  d(run, "seafl");
  d(run, "shore2", 1);
  d(run, "hinit");
  flood(run, false, rounds);
  tree(run);
  d(run, "area", 1);
  d(run, "clock", 1);
}

// The steps' numbers from the response time tau, years: the creep's substeps, then the words written to P from udt on
// (the horst's uplift a step in Z, the creep's share a substep in Q32, each rock's K dt in Q16).
function erosionOf(tau: number) {
  const dt = (ERODE.times * tau) / ERODE.steps, subs = Math.ceil((CREEP * dt) / (ERODE.stable * CELL * CELL));
  const creep = (CREEP * dt) / subs / (CELL * CELL);
  const ka = ROCKS.map((r) => Math.fround(r.erode) * dt * 65536);
  if (ka.some((v) => v >= 2 ** 30)) throw new Error("upstreamGpu: a rock's K dt passes what Q16 holds");
  const words = Uint32Array.from([Math.round(U0 * dt * ZS), Math.round(creep * 2 ** 32), ...ka.map(Math.round)]);
  return { subs, words };
}

function erodeStep(run: Run, subs: number, rounds: number) {
  d(run, "uplift");
  flood(run, false, rounds);
  tree(run);
  d(run, "area", 1);
  d(run, "implicit", 1);
  d(run, "crpin");
  for (let s = 0; s < subs; s++) d(run, s % 2 === 0 ? "crpab" : "crpba");
  d(run, subs % 2 === 0 ? "crpouta" : "crpoutb");
}

// the ice's valleys and till, then the finished ground's flood, receivers and hollows
function ice(run: Run) {
  d(run, "joints", 1);
  d(run, "valleys", VMAX / 256);
  for (const k of [0, 1, 2, 3, 4, 5] as const) d(run, `blur${k}`);
  d(run, "till");
}
function hollows(run: Run, rounds: number) {
  flood(run, true, rounds);
  tree(run);
  d(run, "hollow", 1);
  d(run, "sortorder", 1);
}

const words = async (g: Gpu, buf: GPUBuffer, at: number, n: number) => new Int32Array(await readback(g, buf, n * 4, at * 4));
const field = (run: Run, name: string) => words(run.g, run.F, FIELD[name] * LEN, LEN);
const metres = (w: Int32Array) => Float32Array.from(w, (v) => v / ZS);

// What a run leaves: the Upstream, the flags it raised, the response time (years), the first misc words, the scour (Z), the
// named internal fields' words, and the rounds of relaxation each flood was given.
export type Raw = { up: Upstream; flags: number; tau: number; misc: Int32Array; scour: Int32Array; fields: Record<string, Int32Array>; rounds: number };

async function attempt(g: Gpu, p: Plan, rounds: number, watch: Watch | undefined, grab: readonly string[]): Promise<Raw> {
  const run = await makeRun(g, parameters(p)), { F, AT, P } = run;

  open(run);
  lay(run, rounds);
  submit(run);
  const early = await words(g, F, FIELD.misc * LEN, 16);
  const tau = ((early[MISC.tauHi] >>> 0) * 2 ** 32 + (early[MISC.tauLo] >>> 0)) / 64;
  if (watch) watch({ stage: "rock", rock: Uint8Array.from(await field(run, "rock")), lift: Float32Array.from(await field(run, "lift"), (v) => v / 2 ** 24) });
  const { subs, words: step } = erosionOf(tau);
  g.device.queue.writeBuffer(P, PAR.udt * 4, step);

  open(run);
  for (let s = 0; s < ERODE.steps; s++) {
    erodeStep(run, subs, rounds);
    if (!watch) continue;
    submit(run);
    watch({ stage: "erode", step: s, steps: ERODE.steps, height: metres(await field(run, "h")), flow: Float32Array.from(await field(run, "area")) });
    open(run);
  }
  ice(run);
  if (watch) {
    submit(run);
    watch({ stage: "ice", height: metres(await field(run, "h")), scour: metres(await words(g, AT, AT_OF.sc * LEN, LEN)) });
    open(run);
  }
  hollows(run, rounds);
  submit(run);

  const out = new Int32Array(await readback(g, F, OUTPUTS.length * LEN * 4, FIELD[OUTPUTS[0]] * LEN * 4));
  const of = (name: (typeof OUTPUTS)[number]) => out.subarray(OUTPUTS.indexOf(name) * LEN, (OUTPUTS.indexOf(name) + 1) * LEN);
  const flags = (await words(g, AT, AT_OF.cnt * LEN + CNT.flags, 1))[0];
  const scour = await words(g, AT, AT_OF.sc * LEN, LEN);
  const misc = await words(g, F, FIELD.misc * LEN, 16);
  const fields: Record<string, Int32Array> = {};
  for (const name of grab) fields[name] = await field(run, name);
  const up: Upstream = {
    land: Uint8Array.from(of("land")), rock: Uint8Array.from(of("rock")), height: metres(of("h")), drift: Uint8Array.from(of("drift")),
    driftDepth: metres(of("dd")), filled: metres(of("fl")), order: Int32Array.from(of("lvl")), to: Int32Array.from(of("to")),
    basin: Uint8Array.from(of("basin")), hollow: Int32Array.from(of("hol")), open: Uint8Array.from(of("open")),
  };
  finish(run);
  return { up, flags, tau, misc, scour, fields, rounds };
}

// The rounds of relaxation a flood is first given: the kernels flag a flood that has not settled, and the run is made again
// with twice the rounds.
const ROUNDS = 192, MOST_ROUNDS = 6144;
const FATAL: [number, string][] = [
  [FLAG.chain, "a receiver chain does not end at a root"], [FLAG.depth, `a flow path is longer than the counting sort's ${MAXD} cells`],
  [FLAG.valleys, `more than ${VMAX} valleys`], [FLAG.draws, `more than ${DRN} draws`], [FLAG.dykes, "more dykes than the kernel holds"],
  [FLAG.hollow, "the hollows' labels did not settle"], [FLAG.tall, "a height reaches 340 m, which the blur's sums cannot hold"],
];

// A run from a plan, with the named internal fields' words returned beside the Upstream.
export async function upstreamRaw(g: Gpu, p: Plan, watch?: Watch, grab: readonly string[] = [], first = ROUNDS): Promise<Raw> {
  for (let rounds = first; ; rounds *= 2) {
    const r = await attempt(g, p, rounds, watch, grab);
    // a flood that has not settled leaves wrong receivers behind it, so the other flags mean nothing until it has
    if (r.flags & (FLAG.floodErode | FLAG.floodFinal)) {
      if (rounds >= MOST_ROUNDS) throw new Error(`upstreamGpu: a priority flood has not settled in ${rounds} rounds`);
      continue;
    }
    for (const [flag, why] of FATAL) if (r.flags & flag) throw new Error(`upstreamGpu: ${why}`);
    return r;
  }
}

// The crust, its erosion, the ice's scour and till and the hollows, from the generator's stream.
export async function upstreamGpu(g: Gpu, rand: () => number, watch?: Watch): Promise<Upstream> {
  return (await upstreamRaw(g, planFrom(rand), watch)).up;
}

// ---------- the pieces by themselves, for the laws' tests ----------
const put = (run: Run, name: string, v: ArrayLike<number>, scale: number) =>
  run.g.device.queue.writeBuffer(run.F, FIELD[name] * LEN * 4, Int32Array.from({ length: LEN }, (_, i) => Math.round(v[i] * scale)));

// The priority flood, receivers, depth sort and drainage area of a height field in metres, as the finished ground's step
// (island) or the erosion's: the flooded surface in Z, the receivers, the area (cells), the depth along the receivers and
// the flags raised.
export async function treeGpu(g: Gpu, h: Float32Array, island = true, rounds = ROUNDS) {
  const run = await makeRun(g, parameters());
  put(run, "h", h, ZS);
  open(run);
  flood(run, island, rounds);
  tree(run);
  d(run, "area", 1);
  submit(run);
  const r = { filled: await field(run, "fl"), to: await field(run, "to"), area: await field(run, "area"), depth: await field(run, "dpth"), flags: (await words(g, run.AT, AT_OF.cnt * LEN + CNT.flags, 1))[0] };
  finish(run);
  return r;
}

// One joint valley: where it starts and the way it runs (direction cosines), how long and how deep the ice cleared it, m.
export type Valley = { x: number; y: number; dx: number; dy: number; len: number; deep: number };
// The scour (m) of the given valleys over a bed (m), cutting only where cuttable, with the floor allowed to rise toward each
// end by slope (m per m).
export async function scourGpu(g: Gpu, bed: Float32Array, cuttable: Uint8Array, valleys: Valley[], slope = ADVERSE): Promise<Float32Array> {
  const params = parameters();
  params[PAR.adverse] = Math.round(slope * 2 ** 30);
  const run = await makeRun(g, params);
  put(run, "h", bed, ZS); put(run, "land", cuttable, 1); put(run, "rock", cuttable, GRANITE);
  const table = new Int32Array(VT + 8 * Math.max(1, valleys.length));
  valleys.forEach((v, k) => {
    const o = VT + 8 * k;
    table[o] = Math.round(v.x * 2 ** 15); table[o + 1] = Math.round(v.y * 2 ** 15); table[o + 2] = Math.round(v.len * 2 ** 15); table[o + 3] = Math.round(v.deep * ZS);
    table[o + 4] = Math.round(v.dx * 2 ** 30); table[o + 5] = Math.round(v.dy * 2 ** 30);
  });
  table[MISC.nvalley] = valleys.length;
  run.g.device.queue.writeBuffer(run.F, FIELD.misc * LEN * 4, table);
  open(run);
  d(run, "valleys", VMAX / 256);
  submit(run);
  const scour = metres(await words(g, run.AT, AT_OF.sc * LEN, LEN));
  finish(run);
  return scour;
}

// The kernels' simplex noise (a permutation table of math/noise's) at points, and their sine and cosine of pi times a
// fraction in [0, 1): each the fixed-point words converted back.
export async function noiseGpu(g: Gpu, perm: Uint8Array, xs: ArrayLike<number>, ys: ArrayLike<number>): Promise<Float64Array> {
  const params = parameters();
  params.set(perm, PAR.perm);
  const run = await makeRun(g, params);
  put(run, "ua", xs, 2 ** 24); put(run, "ub", ys, 2 ** 24);
  open(run);
  d(run, "noise");
  submit(run);
  const out = Float64Array.from((await field(run, "da")).subarray(0, xs.length), (v) => v / 2 ** 30);
  finish(run);
  return out;
}
export async function trigGpu(g: Gpu, fractions: ArrayLike<number>): Promise<[number, number][]> {
  const run = await makeRun(g, parameters());
  g.device.queue.writeBuffer(run.F, FIELD.ua * LEN * 4, Uint32Array.from({ length: LEN }, (_, i) => Math.round((fractions[i] ?? 0) * 2 ** 32) >>> 0));
  open(run);
  d(run, "trig");
  submit(run);
  const sn = await field(run, "da"), cs = await field(run, "db");
  finish(run);
  return Array.from({ length: fractions.length }, (_, i): [number, number] => [sn[i] / 2 ** 30, cs[i] / 2 ** 30]);
}
