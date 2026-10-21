// The planet's water as one solve (Unit 5b): every stored file a function of global fields only, so the same under any tiling or order of the tiles. The island's hydrology is run in
// pieces on halo-2 patches (each piece a function of one cell's neighbours and of global files: the receivers, flooded surface, lakes, the exact discharge), and what is not local is a global
// pass between them: the channel flag (an OR down the forest), the water table (one relaxation of the whole tier in aquifer.ts's colours), and the flows with the ground water (exact
// signed gathers with the island's clamp at a lake). In order (g = `t<tier>-g-`):
//   1 begins   tile pass: where a channel begins (needs the cells gathered and the fall)            -> g-begins.u32;  global gather -> g-chn.i32 (a land cell with a channel's head at or above it)
//   2 coef 1   tile pass: the first solve's coefficients (the fixed heads of the sea, lakes and channels, the weights of each cell's balance, the plants' draw)  -> g-a-<field>.i32
//   3 solve 1  the relaxation of the tier                                                           -> g-head1.i32
//   4 route 1  tile pass: each cell's ground water and the five weights of the seasons' routes      -> g-w1<c>.i32;  global signed gather (lakes clamp at 0) -> g-r1-ga<c>-lo/hi.i32
//   5 coef 2   tile pass: the second solve's coefficients (the lakes' water, the channels' stage from the new flow, the transmissivity from solve 1's head)  -> g-c-<field>.i32
//   6 solve 2                                                                                        -> g-head2.i32
//   7 route 2  as 4 from solve 2's head                                                              -> g-w2<c>.i32;  gather -> g-r2-ga<c>-lo/hi.i32
//   8 final    tile pass: the flows, the tables, the banks, the valley and the stream under its bed (water.ts's stored files) from solve 2 and route 2.
// A tile pass reads the global files at its patch (halo 2: the reach of a cell's balance is its four neighbours' transmissivity, and the outer ring of a patch is only ever read, never kept).
import type { Gpu } from "../device";
import type { PassApi } from "../terrain/water";
import { hydrologyPass } from "../terrain/water";
import { planetWater, sweepTol } from "../wgsl/terrain-water";
import { GFIELDS } from "../wgsl/globe-aquifer";
import { GlobalAquifer } from "./aquifer";
import { dischargeOf, forestOf, readDischarge, signedGatherOf, valueAt } from "./discharge";
import { FACES, tierGrid } from "./grid";
import type { Patch } from "./patch";
import { runTiles, type Ctx, type Field, type TileStage } from "./stages";
import { at, mapped, patchInput, waterFiles, waterOutputs, lastRun, unmap, type WaterConfig } from "./water";

export const GHALO = 2;
export const COEF = GFIELDS.filter((n) => n !== "col");
const g = (tier: number, s: string) => `t${tier}-g-${s}`;
const gaNames = (tag: number) => [0, 1, 2, 3, 4].flatMap((c) => [`ga${c}l@${tag}`, `ga${c}h@${tag}`]);
const gaFile = (tier: number, tag: number, name: string) => { const c = name[2], half = name[3] === "l" ? "lo" : "hi"; return `${g(tier, `r${tag}-ga${c}`)}-${half}.i32`; };

// ---------- the pieces, as scripts over a patch ----------
const base = (a: PassApi) => { a.step("prep"); a.step("hollowset"); a.step("levels", [], 1); };
const coef1 = (a: PassApi) => { base(a); a.areas(); a.load(["chn"]); a.yearGather(); a.step("flow0"); a.step("fixedset", [0]); a.step("aqprep"); a.step("aqw"); };
const coef2 = (a: PassApi) => { base(a); a.load(["chn", "head@1", ...gaNames(1)]); a.step("routefin"); a.step("lakefill"); a.step("afterlake"); a.step("fixedset", [1]); a.step("aqprep"); a.step("aqw"); };
const route = (coef: (a: PassApi) => void, head: string) => (a: PassApi) => { coef(a); a.load([head]); a.step("outflux"); a.routePrep(); };
const FINAL_NAMES = ["water", "flow", "sf0", "sf1", "sf2", "sf3", "base", "chn", "valley", "pwr", "stb0", "stb1", "stb2", "stb3", "dry", "tab", "rtl", "rth", "qk0", "qk1", "qk2", "qk3"];
// the flows, tables and banks of the final state (the valley and the stream under its bed need the planet's targets and counts, so they come after)
const banks = (a: PassApi) => {
  route(coef2, "head@2")(a);
  a.load(gaNames(2));
  a.step("routefin");
  for (const e of ["tables", "seasons", "banks"] as const) a.step(e);
};
const final = (a: PassApi) => { banks(a); a.load(["valley@g", "plcf"]); a.step("under"); };

// The global files a pass loads, as the patch's words. A cell's target (the nearest channel or open water down its receivers) and the target's words come from the files of the pass before.
function setOf(ctx: Ctx, patch: Patch, names: readonly string[]): Record<string, Int32Array> {
  const t = ctx.tier, out: Record<string, Int32Array> = {}, n = patch.ids.length;
  for (const name of names) {
    const [field, tag] = name.split("@");
    if (["tgt", "tch", "tpw", "tdb", "tht"].includes(field)) {
      const tgt = at<Uint32Array>(mapped(ctx, `${g(t, "tgt")}.u32`), patch.ids), chn = mapped(ctx, `${g(t, "fa-chn")}.i32`) as Int32Array, pwr = mapped(ctx, `${g(t, "fa-pwr")}.i32`) as Int32Array;
      const dbf = mapped(ctx, `${g(t, "fa-dbf")}.i32`) as Int32Array, h = mapped(ctx, `t${t}-height.i32`) as Int32Array, v = new Int32Array(n);
      // the planet's heights are 1/256 m and the kernel's are Z = 2^-17 m: a factor of 512
      for (let k = 0; k < n; k++) { const j = tgt[k]; v[k] = j === 0xffffffff ? (field === "tgt" ? -1 : 0) : field === "tgt" ? 0 : field === "tch" ? chn[j] : field === "tpw" ? pwr[j] : field === "tdb" ? dbf[j] : h[j] * 512; }
      out[name] = v;
      continue;
    }
    const file = field === "chn" ? `${g(t, "chn")}.i32` : field === "head" ? `${g(t, `head${tag}`)}.i32` : field === "open" ? `${g(t, "fa-open")}.i32` : field === "valley" ? `${g(t, "valley")}.i32` : field === "plcf" ? `${g(t, "plc")}-lo.i32` : gaFile(t, Number(tag), field);
    out[name] = at<Int32Array>(mapped(ctx, file), patch.ids);
  }
  return out;
}

function passStage(tier: number, cfg: WaterConfig, name: string, outputs: string[], loads: string[], names: readonly string[], script: (a: PassApi) => void, convert: (ctx: Ctx, patch: Patch, f: Record<string, Int32Array>) => Record<string, Field>): TileStage {
  return {
    name: `g-${name}`, halo: GHALO, inputs: [], outputs,
    async run(ctx, patch) {
      const { input } = patchInput(ctx, patch, { ...cfg, tier });
      input.set = setOf(ctx, patch, loads);
      return convert(ctx, patch, await hydrologyPass(ctx.gpu, input, planetWater(patch.side), names, script));
    },
  };
}
const asI32 = (files: string[], names: readonly string[]) => (_c: Ctx, _p: Patch, f: Record<string, Int32Array>) => Object.fromEntries(files.map((file, k) => [file, f[names[k]]]));
const coefFiles = (tier: number, tag: "a" | "c") => COEF.map((n) => g(tier, `${tag}-${n}.i32`));
const routeFiles = (tier: number, r: number) => [0, 1, 2, 3, 4].map((c) => g(tier, `w${r}${c}.i32`));
const WT = ["wt0", "wt1", "wt2", "wt3", "wt4"];
const CHN_LOADS = ["chn"], HEAD1 = ["head@1"];

export const beginsStage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "begins", [g(tier, "begins.u32")], [], ["wt0"], (a) => { base(a); a.areas(); a.step("beginsw"); }, (_c, _p, f) => ({ [g(tier, "begins.u32")]: new Uint32Array(f.wt0.buffer, f.wt0.byteOffset, f.wt0.length) }));
export const coef1Stage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "coef1", coefFiles(tier, "a"), CHN_LOADS, COEF, coef1, asI32(coefFiles(tier, "a"), COEF));
export const route1Stage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "route1", routeFiles(tier, 1), [...CHN_LOADS, ...HEAD1], WT, route(coef1, "head@1"), asI32(routeFiles(tier, 1), WT));
export const coef2Stage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "coef2", coefFiles(tier, "c"), [...CHN_LOADS, ...HEAD1, ...gaNames(1)], COEF, coef2, asI32(coefFiles(tier, "c"), COEF));
export const route2Stage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "route2", routeFiles(tier, 2), [...CHN_LOADS, ...HEAD1, "head@2", ...gaNames(1)], WT, route(coef2, "head@2"), asI32(routeFiles(tier, 2), WT));
const FA = ["chn", "open", "pwr", "dbf"], faFiles = (tier: number) => FA.map((n) => g(tier, `fa-${n}.i32`));
export const banksStage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "banks", faFiles(tier), [...CHN_LOADS, ...HEAD1, "head@2", ...gaNames(1), ...gaNames(2)], FA, banks, asI32(faFiles(tier), FA));
const TGT_LOADS = ["tgt", "tch", "tpw", "tdb", "tht"];
export const valleyStage = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "valley", [g(tier, "valley.i32")], ["open@fa", ...TGT_LOADS], ["valley"], (a) => { a.load(["open@fa", ...TGT_LOADS]); a.step("valleyg"); }, asI32([g(tier, "valley.i32")], ["valley"]));
export const finalPass = (tier: number, cfg: WaterConfig) => passStage(tier, cfg, "final", waterFiles(tier), [...CHN_LOADS, ...HEAD1, "head@2", ...gaNames(1), ...gaNames(2), "valley@g", "plcf"], FINAL_NAMES, final, (ctx, patch, f) => waterOutputs(ctx, patch, f, patch.ids.length));
export function finalStage(tier: number, cfg: WaterConfig): TileStage {
  const s = finalPass(tier, cfg);
  return {
    ...s,
    async run(ctx, patch) {
      const out = await s.run(ctx, patch, {}), file = `t${ctx.tier}-quick`, T = 1 << ctx.tier, quick = ctx.dir.json<Record<string, number[]>>(file) ?? {};
      quick[String(patch.face * T * T + patch.ty * T + patch.tx)] = lastRun.quick;
      ctx.dir.putJson(file, quick);
      return out;
    },
  };
}

// ---------- the global passes ----------
export async function chnOf(ctx: Ctx, log: (s: string) => void): Promise<void> {
  const t = ctx.tier, file = `${g(t, "chn")}.i32`;
  if (ctx.dir.has(file)) return;
  const stem = g(t, "cb"), p = await dischargeOf(ctx.gpu, ctx.dir, t, [{ from: g(t, "begins.u32"), stem }], Infinity, log);
  if (!p.done) throw new Error("water-global: the channel gather did not finish");
  const acc = readDischarge(ctx.dir, stem), h = mapped(ctx, `t${t}-height.i32`) as Int32Array, chn = new Int32Array(h.length);
  for (let i = 0; i < h.length; i++) chn[i] = h[i] > 0 && valueAt(acc, i) > 0 ? 1 : 0;
  ctx.dir.write(file, chn);
  for (const n of ["lo.u32", "hi.u16"]) ctx.dir.remove(`${stem}-${n}`);
}
export async function solveOf(ctx: Ctx, phase: 1 | 2, most: number, log: (s: string) => void, o: { reverse?: boolean; out?: string } = {}): Promise<{ sweeps: number; change: number; seconds: number }> {
  const t = ctx.tier, out = o.out ?? `${g(t, `head${phase}`)}.i32`, t0 = performance.now();
  const fields: Record<string, Int32Array> = {};
  for (const n of COEF) fields[n] = new Int32Array(ctx.dir.raw(g(t, `${phase === 1 ? "a" : "c"}-${n}.i32`)));
  const a = new GlobalAquifer(ctx.gpu, t, fields, o.reverse);
  try {
    const r = await a.relax(most, sweepTol(planetWater(256)));
    ctx.dir.write(out, await a.field("head"));
    const seconds = (performance.now() - t0) / 1000;
    log(`solve ${phase}: ${r.sweeps} sweeps, last change ${r.change} (of ${sweepTol(planetWater(256))}), ${seconds.toFixed(1)} s`);
    return { ...r, seconds };
  } finally { a.release(); }
}
export async function routeGatherOf(ctx: Ctx, r: 1 | 2, log: (s: string) => void): Promise<void> {
  const t = ctx.tier, N = FACES * tierGrid(t).fn ** 2, basin = mapped(ctx, `t${t}-basin.u8`) as Uint8Array, mask = new Uint32Array(N);
  for (let i = 0; i < N; i++) mask[i] = basin[i] ? 1 : 0;
  const forest = await forestOf(ctx.gpu, ctx.dir, t);
  try { await signedGatherOf(forest, ctx.dir, routeFiles(t, r), [0, 1, 2, 3, 4].map((c) => g(t, `r${r}-ga${c}`)), mask, log); } finally { forest.release(); }
}

// ---------- the whole chain, in calls ----------
export interface GlobalProgress { done: boolean; at: string; seconds: number }
// Make what is not yet made, in the order above, until `budgetS` seconds are used (a tile pass stops at its budget and the next call resumes; a global pass runs whole).
export async function globalWater(ctx: Ctx, cfg: WaterConfig, budgetS: number, log: (s: string) => void = () => {}, most = 400000): Promise<GlobalProgress> {
  const t = ctx.tier, t0 = performance.now(), left = () => budgetS - (performance.now() - t0) / 1000, has = (f: string) => ctx.dir.has(f);
  const tiles = async (stage: TileStage) => { const p = await runTiles(ctx, stage, left(), log); unmap(); return p.done; };
  const stop = (at: string): GlobalProgress => ({ done: false, at, seconds: (performance.now() - t0) / 1000 });
  if (!has(`${g(t, "chn")}.i32`)) { if (!(await tiles(beginsStage(t, cfg)))) return stop("begins"); await chnOf(ctx, log); unmap(); }
  if (!has(`${g(t, "head1")}.i32`)) { if (!(await tiles(coef1Stage(t, cfg)))) return stop("coef1"); await solveOf(ctx, 1, most, log); unmap(); }
  if (!has(`${g(t, "r1-ga4")}-hi.i32`)) { if (!(await tiles(route1Stage(t, cfg)))) return stop("route1"); await routeGatherOf(ctx, 1, log); unmap(); }
  if (!has(`${g(t, "head2")}.i32`)) { if (!(await tiles(coef2Stage(t, cfg)))) return stop("coef2"); await solveOf(ctx, 2, most, log); unmap(); }
  if (!has(`${g(t, "r2-ga4")}-hi.i32`)) { if (!(await tiles(route2Stage(t, cfg)))) return stop("route2"); await routeGatherOf(ctx, 2, log); unmap(); }
  if (!has(`${g(t, "tgt")}.u32`)) { if (!(await tiles(banksStage(t, cfg)))) return stop("banks"); await tgtOf(ctx, log); unmap(); }
  if (!has(`${g(t, "plc")}-lo.i32`)) { if (!(await tiles(valleyStage(t, cfg)))) return stop("valley"); await plcOf(ctx, log); unmap(); }
  if (!(await tiles(finalStage(t, cfg)))) return stop("final");
  return { done: true, at: "final", seconds: (performance.now() - t0) / 1000 };
}

// ---------- the target of each cell and the count of valley cells at each channel ----------
export async function tgtOf(ctx: Ctx, log: (s: string) => void): Promise<void> {
  const t = ctx.tier, file = `${g(t, "tgt")}.u32`;
  if (ctx.dir.has(file)) return;
  const chn = mapped(ctx, `${g(t, "fa-chn")}.i32`) as Int32Array, open = mapped(ctx, `${g(t, "fa-open")}.i32`) as Int32Array, flags = new Uint32Array(chn.length);
  for (let i = 0; i < flags.length; i++) flags[i] = chn[i] || open[i] ? 1 : 0;
  const forest = await forestOf(ctx.gpu, ctx.dir, t), t0 = performance.now();
  try { ctx.dir.write(file, await forest.reach(flags)); log(`reach: the target of every cell ${((performance.now() - t0) / 1000).toFixed(1)} s`); } finally { forest.release(); }
}
export async function plcOf(ctx: Ctx, log: (s: string) => void): Promise<void> {
  const t = ctx.tier, stem = g(t, "plc");
  if (ctx.dir.has(`${stem}-lo.i32`)) return;
  const chn = mapped(ctx, `${g(t, "fa-chn")}.i32`) as Int32Array, open = mapped(ctx, `${g(t, "fa-open")}.i32`) as Int32Array, mask = new Uint32Array(chn.length);
  for (let i = 0; i < mask.length; i++) mask[i] = chn[i] || open[i] ? 2 : 0;
  const forest = await forestOf(ctx.gpu, ctx.dir, t);
  try { await signedGatherOf(forest, ctx.dir, [g(t, "valley.i32")], [stem], mask, log); } finally { forest.release(); }
}
