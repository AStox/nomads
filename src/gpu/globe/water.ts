// The planet's water as tile stages: the island's hydrology (gpu/terrain/water.ts and wgsl/terrain-water.ts) run on each tile's patch in the planet's format (`planetWater`: a window's
// inflow, any side, lakes at the flooded surface, void cells at a cube's corner), over the whole 75 m tier, so that the water is one network and no river is matched at a tile's edge.
//
// What makes it one network (R1830 and up):
//  - the receivers are the planet's (`t4-to.u32`), mapped to the patch; a cell whose receiver lies outside the patch is an outlet, and the water that enters the patch over its border is
//    the global discharge (discharge.ts: the exact sum, down the whole forest, of each season's surplus and of the cells) of the cells outside whose receiver is inside, so a river that
//    crosses a tile's edge arrives as the same river;
//  - the flooded surface is the planet's (`t4-flooded.i32`) and the hollows are the planet's (`t4-basin.u8`: the components of the cells the flood raised by a centimetre whose deepest
//    point is over 3 m, WATER_TABLE, found once over the whole tier across tile and face edges): a lake stands at the flooded surface at every cell of its hollow and every lake spills
//    [design: R1830; the island's balance that lets a closed hollow stand part full needs the whole hollow's cells and their flows, so it cannot be a function of a patch's halo];
//  - the climate is the planet's per cell (`ClimateSource`), the rock, drift and drift thickness the `terrain` stage's, the heights the tier's.
//
// The aquifer is a relaxation over the patch (in two colours, over-relaxed at 1.9, to a head change under half a millimetre a sweep: the island's 1.6 and 2 mm do not settle a grid this size, see the
// note), and no water crosses the
// patch's outer ring of cells, so the answer in an interior cell depends on the halo; WATER_HALO is what the measure of the answer's fall with distance from the edge chose
// (docs/research/globe/2026-10-21-planet-75m-water.md).
//
// Outputs (global fields of the tier in cell order, written per tile by stages.ts runTiles), the words ground.ts and the scenery need of a Hydro (the rivers' polylines are not made: a tile
// derives its stream segments from `flow`, `base`, `chn` and the heights):
//   t4-water.u16   standing water over the cell, cm: a lake's depth at the flooded surface, the sea's (the depth under the present sea), 0 on dry land (Hydro.water; open is water > 0)
//   t4-flow.u32    the mean flow, Q16 m3 a second (Hydro.flow; its bankfull flow is 14.98 times it)
//   t4-qwet.u32    the wettest season's flow, Q16 m3 a second (the bed's width the scenery cuts the stream mask to)
//   t4-base.u16    the groundwater's share of the flow, Q16 (0 to 65535, 65536 held at 65535)
//   t4-chn.u8      1 where a channel runs (Hydro.channel)
//   t4-valley.u8   1 where the floodplain of a channel lies (Hydro.valley)
//   t4-pwr.u16     the stream's power a metre of its width, 1/16 W/m2, held at 65535 (Hydro.power; ground.ts reads it against CONFINED, 300)
//   t4-stb0.u16 .. t4-stb3.u16   the water table's depth below the ground in the middle of each season, 1/64 m, held at 65535 (Hydro.seasonTable; winterTable is stb3)
//   t4-dry.u16     the deepest the table falls in any season, 1/64 m (Hydro.dryTable)
// Not kept: the year's table (the seasons' mean), the springs, the stream's flow under its bed and the slope (the slope is the fall to the receiver over the reach, from the heights).
//
// Also here: `surplusStage` (the weights of the global discharge: each season's surplus over the cell as 1/64 m3, the bucket of the hydrology's `prep` over the planet's rain and potential
// evaporation, t4-vs0..3.u32) and `basinOf` (t4-basin.u8).
import { DRIFTS, ROCKS } from "../../terrain/geology";
import { YEAR_S } from "../../terrain/water";
import { hydrologyRaw, surplusRaw, type HydroInput, type Inflow } from "../terrain/water";
import { MISC, TS, planetWater } from "../wgsl/terrain-water";
import { ONES, readDischarge, valueAt, type Discharge, type WeightField } from "./discharge";
import { FACES, tierGrid } from "./grid";
import { cellAcross, localOf, type Patch } from "./patch";
import { KINDS, typeOf, type Ctx, type Field, type TileStage } from "./stages";
import { sampleCoarse } from "./sample";
import type { Planet } from "./window";


// The patch's reach: what the measure chose (see the header).
export const WATER_HALO = 96;
// The sweeps the two aquifer solves may take at most (a tile that needs more throws: its answer would depend on where it started).
export const WATER_SWEEPS: readonly [number, number] = [80000, 80000];
// The deepest hollow, in 1/256 m, that is not a lake (WATER_TABLE, 3 m), and the least a hollow's cell is raised by, 1 cm (HOLLOW_MIN) rounded up to the tier's unit.
const WATER_TABLE_UNITS = 3 * 256, HOLLOW_MIN_UNITS = Math.ceil(0.01 * 256);
// A cell's transmissivity must stay under what a sweep's four faces hold in a u32 (terrain/water.ts MOST_T); the drift's thickness is held under it, which the planet's thickest
// (TILL_MOST_M, 30 m) does not reach over the rocks it lies on [design: a format's bound].
const MOST_T = 2 ** 32 / (4 * TS);

// ---------- the global fields, mapped ----------
// A tier-4 field is 403 MB: a tile reads the few thousand cells of its patch, so the files are mapped and the pages a tile touches are all that is resident.
const maps = new Map<string, Field>();
export function mapped(ctx: Ctx, file: string): Field {
  const key = `${ctx.dir.dir}/${file}`;
  let f = maps.get(key);
  if (!f) {
    const bytes = Bun.mmap(ctx.dir.path(file)), K = KINDS[typeOf(file)];
    f = new K(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / K.BYTES_PER_ELEMENT);
    maps.set(key, f);
  }
  return f;
}
export const unmap = () => maps.clear();
const at = <A extends Field>(f: Field, ids: Int32Array): A => {
  const out = new (f.constructor as new (n: number) => A)(ids.length);
  for (let k = 0; k < ids.length; k++) out[k] = f[ids[k]];
  return out;
};

// ---------- the climate ----------
// Each season's rain and potential evaporation over the patch's cells, mm over the season. Nothing in it is a constant of a place.
export type ClimateSource = (ctx: Ctx, patch: Patch) => { precip: Float32Array[]; pet: Float32Array[] };
// Four files of rain and four of potential evaporation as u16, `perMm` units to the millimetre.
export const climateFiles = (pr: readonly string[], pet: readonly string[], perMm: number): ClimateSource => (ctx, patch) => {
  const conv = (file: string) => { const raw = at<Uint16Array>(mapped(ctx, file), patch.ids), out = new Float32Array(raw.length); for (let k = 0; k < raw.length; k++) out[k] = raw[k] / perMm; return out; };
  return { precip: pr.map(conv), pet: pet.map(conv) };
};
// A climate that is a function of a cell's height alone (height in m), for stagings and tests.
export const climateFor = (of: (heightM: number) => { precip: number[]; pet: number[] }): ClimateSource => (ctx, patch) => {
  const h = at<Int32Array>(mapped(ctx, `t${ctx.tier}-height.i32`), patch.ids), precip = [0, 1, 2, 3].map(() => new Float32Array(h.length)), pet = [0, 1, 2, 3].map(() => new Float32Array(h.length));
  for (let k = 0; k < h.length; k++) { const c = of(h[k] / 256); for (let s = 0; s < 4; s++) { precip[s][k] = c.precip[s]; pet[s][k] = c.pet[s]; } }
  return { precip, pet };
};
// The stand-in until the `air` stage's global files exist: the planet's own tier-0 rain of each season (mm over the season), sampled to the cell, and as the potential evaporation the part
// of it the planet's own water balance does not run off (rain less runoff), so the bucket's surplus is about the planet's runoff [design; gap: not a potential evaporation, so the
// dry ground's groundwater draw has no demand beyond the rain].
export const planetRain = (planet: Planet): ClimateSource => (_ctx, patch) => {
  const fields = planet.seasons.flatMap((s) => [s.rain, s.runoff]), got = sampleCoarse(patch.tier, patch.ids, fields);
  const precip = [0, 1, 2, 3].map((s) => got[2 * s]), pet = [0, 1, 2, 3].map((s) => got[2 * s].map((r, k) => Math.max(0, r - got[2 * s + 1][k])));
  return { precip, pet };
};

// ---------- the hollows: t4-basin.u8 ----------
// The cells of every hollow whose deepest point is over WATER_TABLE, over the whole tier: the cells the flood raised by at least a centimetre, in components of four neighbours (as
// terrain-upstream.ts labels them), across tile and face edges. A cell of such a component is 1.
export function basinOf(ctx: Ctx): void {
  if (ctx.dir.has(`t${ctx.tier}-basin.u8`)) return;
  const g = tierGrid(ctx.tier), n = g.fn, cells = n * n, N = FACES * cells, h = mapped(ctx, `t${ctx.tier}-height.i32`) as Int32Array, f = mapped(ctx, `t${ctx.tier}-flooded.i32`) as Int32Array;
  const hollow = (i: number) => h[i] > 0 && f[i] - h[i] >= HOLLOW_MIN_UNITS;
  let count = 0;
  for (let i = 0; i < N; i++) if (hollow(i)) count++;
  const state = new Uint8Array(N), members = new Int32Array(count), stack = new Int32Array(count), near = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let s = 0; s < N; s++) {
    if (state[s] || !hollow(s)) continue;
    let top = 0, size = 0, deepest = 0;
    stack[top++] = s; state[s] = 1;
    while (top) {
      const i = stack[--top];
      members[size++] = i;
      deepest = Math.max(deepest, f[i] - h[i]);
      const face = Math.floor(i / cells), r = i - face * cells, Y = Math.floor(r / n), X = r - Y * n;
      for (const [dx, dy] of near) {
        const j = cellAcross(g, face, X + dx, Y + dy);
        if (j >= 0 && !state[j] && hollow(j)) { state[j] = 1; stack[top++] = j; }
      }
    }
    if (deepest > WATER_TABLE_UNITS) for (let k = 0; k < size; k++) state[members[k]] = 3;
  }
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = state[i] === 3 ? 1 : 0;
  ctx.dir.write(`t${ctx.tier}-basin.u8`, out);
}

// ---------- the surplus: the weights of the global discharge ----------
const CLIMATE_SEASONS = 4;
export const surplusFiles = (tier: number) => [0, 1, 2, 3].map((s) => `t${tier}-vs${s}.u32`);
// The patch's climate as the hydrology takes it.
const airOf = (c: { precip: Float32Array[]; pet: Float32Array[] }) => ({ seasons: c.precip.map((precip, s) => ({ precip, pet: c.pet[s] })) });
const noRiver = (n: number) => ({ to: Int32Array.from({ length: n }, (_, i) => i), zero: new Float32Array(n), none: new Uint8Array(n) });

export function surplusStage(climate: ClimateSource, tier = 4): TileStage {
  return {
    name: "surplus", halo: 0, inputs: [], outputs: surplusFiles(tier),
    async run(ctx, patch) {
      const n = patch.ids.length, c = climate(ctx, patch), { to, zero, none } = noRiver(n), h = at<Int32Array>(mapped(ctx, `t${ctx.tier}-height.i32`), patch.ids), sea = new Float32Array(n);
      for (let i = 0; i < n; i++) sea[i] = h[i] > 0 ? 1 : -1;
      const input: HydroInput = { h: zero, filled: sea, to, basin: none, rock: none, drift: none, driftDepth: zero, air: airOf(c) };
      const w = await surplusRaw(ctx.gpu, input, planetWater(patch.side));
      return Object.fromEntries(surplusFiles(ctx.tier).map((f, s) => [f, new Uint32Array(w[s].buffer, w[s].byteOffset, w[s].length)]));
    },
  };
}

// ---------- the water ----------
export const WATER_KINDS = ["water.u16", "flow.u32", "qwet.u32", "base.u16", "chn.u8", "valley.u8", "pwr.u16", "stb0.u16", "stb1.u16", "stb2.u16", "stb3.u16", "dry.u16"];
export const waterFiles = (tier: number) => WATER_KINDS.map((k) => `t${tier}-${k}`);
export const dischargeStems = (tier: number) => [0, 1, 2, 3].map((s) => `t${tier}-q${s}`);
export const cellsStem = (tier: number) => `t${tier}-cells`;
// The sums dischargeOf makes for the water: each season's surplus (the weights `surplusStage` writes) and the count of cells.
export const dischargeFields = (tier: number): WeightField[] => [...dischargeStems(tier).map((stem, s) => ({ from: surplusFiles(tier)[s], stem })), { from: ONES, stem: cellsStem(tier) }];

// What a tile's run measured, for the notes and the tests.
export interface WaterRun { sweeps: [number, number]; flags: number; inflows: number; seconds: { inputs: number; gpu: number }; fields: Record<string, Int32Array> }
export const lastRun: WaterRun = { sweeps: [0, 0], flags: 0, inflows: 0, seconds: { inputs: 0, gpu: 0 }, fields: {} };

// The water that enters the patch over its border: for each cell outside it whose receiver is a cell of it, that cell's global discharge (the area in cells and each season's water in
// 1/64 m3), added up at the receiver.
export function inflowOf(ctx: Ctx, patch: Patch, local: (id: number) => number, to: Uint32Array, q: Discharge[], cells: Discharge): Inflow[] {
  const g = tierGrid(patch.tier), n = g.fn, per = n * n, side = patch.side, seen = new Set<number>(), by = new Map<number, { cells: number; q6: number[] }>();
  const around = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < patch.ids.length; k++) {
    const x = k % side, y = (k - x) / side;
    if (patch.missing[k] || (x > 0 && y > 0 && x < side - 1 && y < side - 1)) continue;
    const id = patch.ids[k], face = Math.floor(id / per), r = id - face * per, Y = Math.floor(r / n), X = r - Y * n;
    for (const [dx, dy] of around) {
      const o = cellAcross(g, face, X + dx, Y + dy);
      if (o < 0 || seen.has(o) || local(o) >= 0) continue;
      seen.add(o);
      const to_ = to[o];
      if (to_ === o) continue;
      const cell = local(to_);
      if (cell < 0) continue;
      const e = by.get(cell) ?? { cells: 0, q6: [0, 0, 0, 0] };
      e.cells += valueAt(cells, o);
      for (let s = 0; s < CLIMATE_SEASONS; s++) e.q6[s] += valueAt(q[s], o);
      by.set(cell, e);
    }
  }
  return [...by].sort((a, b) => a[0] - b[0]).map(([cell, e]) => ({ at: cell, cells: e.cells, m3s: [], q6: e.q6 }));
}

// `extra` names more of the hydrology's fields to keep in lastRun.fields (for measuring).
export interface WaterConfig { climate: ClimateSource; tier?: number; halo?: number; sweeps?: readonly [number, number]; extra?: readonly string[] }

// The patch's water: every output as a patch field (side * side), by file name.
export async function waterOf(ctx: Ctx, patch: Patch, cfg: WaterConfig): Promise<Record<string, Field>> {
  const t0 = performance.now(), nn = patch.ids.length, ids = patch.ids, local = localOf(patch), G = (f: string) => mapped(ctx, f);
  const h0 = at<Int32Array>(G(`t${ctx.tier}-height.i32`), ids), f0 = at<Int32Array>(G(`t${ctx.tier}-flooded.i32`), ids), gto = G(`t${ctx.tier}-to.u32`) as Uint32Array;
  const p = `t${ctx.tier}-`, basin0 = at<Uint8Array>(G(`${p}basin.u8`), ids), rock = at<Uint8Array>(G(`${p}rock.u8`), ids), drift = at<Uint8Array>(G(`${p}drift.u8`), ids), dd0 = at<Uint16Array>(G(`${p}dd.u16`), ids);
  const h = new Float32Array(nn), filled = new Float32Array(nn), to = new Int32Array(nn), basin = new Uint8Array(nn), driftDepth = new Float32Array(nn), voidc = new Uint8Array(nn);
  for (let k = 0; k < nn; k++) {
    if (patch.missing[k]) { voidc[k] = 1; filled[k] = -1; to[k] = k; continue; }
    h[k] = h0[k] / 256;
    // a sea cell is the one whose filled surface is under 0; the planet's sea cells stand at 0 or under
    filled[k] = h0[k] > 0 ? f0[k] / 256 : Math.min(h0[k], -1) / 256;
    const r = h0[k] > 0 ? local(gto[ids[k]]) : -1;
    to[k] = r < 0 ? k : r;
    basin[k] = h0[k] > 0 ? basin0[k] : 0;
    // the drift's thickness (1/1024 m) held where its transmissivity over the rock under it would pass a sweep's word
    const rk = ROCKS[rock[k]], dr = DRIFTS[drift[k]], room = (MOST_T * 0.999 - rk.ksat * rk.thick * YEAR_S) / Math.max(1e-12, dr.ksat * YEAR_S);
    driftDepth[k] = Math.min(dd0[k] / 1024, drift[k] === 0 ? 0 : Math.max(0, room));
  }
  const q = dischargeStems(ctx.tier).map((s) => readDischarge(ctx.dir, s)), cells = readDischarge(ctx.dir, cellsStem(ctx.tier));
  const inflow = inflowOf(ctx, patch, local, gto, q, cells), c = cfg.climate(ctx, patch);
  const input: HydroInput = { h, filled, to, basin, rock, drift, driftDepth, air: airOf(c), inflow, voidc };
  const t1 = performance.now();
  const raw = await hydrologyRaw(ctx.gpu, input, ["water", "flow", "sf0", "sf1", "sf2", "sf3", "base", "chn", "valley", "pwr", "stb0", "stb1", "stb2", "stb3", "dry", ...(cfg.extra ?? [])], planetWater(patch.side), cfg.sweeps ?? WATER_SWEEPS);
  if (raw.flags & 1) throw new Error("water: a receiver chain of the patch does not end at a root");
  if (raw.flags & 2) throw new Error("water: a flow path of the patch is longer than the counting sort holds");
  const f = raw.fields, u16 = (v: number) => Math.min(65535, Math.max(0, v));
  const water = new Uint16Array(nn), flow = new Uint32Array(nn), qwet = new Uint32Array(nn), base = new Uint16Array(nn), chn = new Uint8Array(nn), valley = new Uint8Array(nn), pwr = new Uint16Array(nn), dry = new Uint16Array(nn);
  const stb = [0, 1, 2, 3].map(() => new Uint16Array(nn));
  const Zcm = 100 / 2 ** 17, Z64 = 64 / 2 ** 17;
  for (let k = 0; k < nn; k++) {
    water[k] = u16(Math.round(f.water[k] * Zcm));
    flow[k] = f.flow[k] >>> 0;
    if (flow[k] * 14.98 >= 2 ** 32) throw new Error("water: a flow passes what the bankfull flow's word holds");
    qwet[k] = Math.max(f.sf0[k] >>> 0, f.sf1[k] >>> 0, f.sf2[k] >>> 0, f.sf3[k] >>> 0);
    base[k] = u16(f.base[k]);
    chn[k] = f.chn[k]; valley[k] = f.valley[k];
    pwr[k] = u16(Math.round(f.pwr[k] / 4096));
    for (let s = 0; s < 4; s++) stb[s][k] = u16(Math.round(f[`stb${s}`][k] * Z64));
    dry[k] = u16(Math.round(f.dry[k] * Z64));
  }
  lastRun.sweeps = [raw.misc[MISC.sweeps1], raw.misc[MISC.sweeps2]]; lastRun.flags = raw.flags; lastRun.inflows = inflow.length; lastRun.fields = raw.fields;
  const caps = cfg.sweeps ?? WATER_SWEEPS;
  if (lastRun.sweeps[0] >= caps[0] || lastRun.sweeps[1] >= caps[1]) throw new Error(`water: the aquifer did not settle in ${caps.join(" and ")} sweeps (${lastRun.sweeps.join(" and ")})`);
  lastRun.seconds = { inputs: (t1 - t0) / 1000, gpu: (performance.now() - t1) / 1000 };
  return Object.fromEntries(waterFiles(ctx.tier).map((f, k) => [f, [water, flow, qwet, base, chn, valley, pwr, stb[0], stb[1], stb[2], stb[3], dry][k]]));
}

export function waterStage(cfg: WaterConfig): TileStage {
  return {
    name: "water", halo: cfg.halo ?? WATER_HALO, inputs: [], outputs: waterFiles(cfg.tier ?? 4),
    async prepare(ctx) { basinOf(ctx); },
    run: (ctx, patch) => waterOf(ctx, patch, cfg),
  };
}
