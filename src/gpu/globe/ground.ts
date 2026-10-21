// The `ground` tile stage: the island's ground (src/gpu/terrain/ground.ts, wgsl/terrain-ground.ts: soil by creep and weathering, beach sand, alluvium, peat, texture, the root zone's
// seasonal bucket, the plants' compensation points and the cover they settle, fertility, RothC's carbon, pH) on a patch of the 75 m tier, the island's kernels widened by a format
// (`GroundFormat {n, patch, reach}`: any side, and a halo-limited sweep of the nearest channel's power), each cell by its own inputs and none a window's value.
//
// Inputs, per cell (global files of the tier, read by the cells of the patch and mapped, never held whole):
//   t4-height.i32 (1/256 m above the present sea), t4-water.u16 (cm over the ground: the sea's and a lake's; open water is water over 0 or a height at or under 0)   the water stage
//   t4-rock.u8, t4-drift.u8, t4-dd.u16 (1/1024 m)                                                                                                       the terrain stage
//   t4-chn.u8, t4-valley.u8, t4-pwr.u16 (1/16 W/m2), t4-stb0..3.u16 and t4-dry.u16 (1/256 m, held at 255.99 m)                                         the water stage
//   t4-pr0..3.u16 and t4-pe0..3.u16 (0.1 mm over the season), t4-sun0..3.u16 (1/1024 MJ/m2 a day), t4-tmp0..3.i16 (1/256 C), t4-hum0..3.u8 (1/255)     the air stage
// Their words are turned to the kernel's own (Q16, terrain-ground.ts INPUTS) by integer arithmetic alone, so the stage is a function of the files' words.
//
// Outputs (global files of the tier, cell order; `GROUND_OUT` is the table, 23 bytes a cell, 2.3 GB). A share or fraction is a u8 of 1/255 of its Q24 value, rounded:
//   t4-tree.u8 t4-shr.u8 t4-grs.u8 t4-mar.u8 t4-bare.u8   the covers (Ground.tree, shrub, grass, marsh, bare; a beach's sand is none of them: the five and the sand's share sum to 1)
//   t4-soil.u16     the soil's thickness, 1/1024 m (held at 63.99 m; a word past it is counted)
//   t4-sflag.u8     bit 0 silt (alluvium of a cohesive stream), bit 1 beach sand, bit 2 peat
//   t4-sandy.u8 t4-clayey.u8   the root zone's texture, shares of sand and of clay
//   t4-fert.u8      fertility, 0 to 1
//   t4-moist.u8     the water the roots find through the growing season, 0 to 1
//   t4-sw0..3.u8    how full the root zone is at the end of each season, 0 to 1
//   t4-ph.u8        pH, 1/30 (4.0 to 8.3 reads 120 to 249)
//   t4-org.u8       the topsoil's organic matter, % in 1/2.55 (0 to 100)
//   t4-carb.u16     the soil's carbon, t a ha in 1/16
//   t4-nit.u16      the year's plant nitrogen, kg a ha a year in 1/64
// What is not stored (made again from the same inputs for a play area in a second, as the air's snow is): the field layer's share and its light (Ground.field, fieldLight), the leaf display.
//
// What takes a halo. A cell reads its four neighbours (the creep's fluxes, the coast) and, in the island, the nearest channel's power over the whole grid by two raster sweeps. Here the
// sweep carries a channel's power at most GROUND_HALO cells (R1860: a valley cell lies within 24 cells of a channel on island 1, 32 on 2 and 48 on 3, measured), so a cell's answer
// depends on the cells within GROUND_HALO of it and the patch's halo is that: a cell 64 or more from the patch's edge is the same word whichever tile holds it. A valley cell more than
// GROUND_HALO from any channel has no alluvium [gap: measured on the real tiles in the notes].
import type { Gpu } from "../device";
import { INPUTS, OUTPUTS, type GroundFormat } from "../wgsl/terrain-ground";
import { groundWords } from "../terrain/ground";
import type { Patch } from "./patch";
import { KINDS, typeOf, type Ctx, type Field, type TileStage } from "./stages";

export const GROUND_HALO = 64;
// The water tables' words to the metre (the water stage's files; the ground reads them against 0.2 to 2 m).
export const TABLE_UNIT = 256;
export const groundFormat = (side: number, reach = GROUND_HALO): GroundFormat => ({ n: side, patch: true, reach });

// ---------- the files ----------
const seasonal = (stem: string, type: string) => [0, 1, 2, 3].map((k) => `t4-${stem}${k}.${type}`);
export const GROUND_IN = {
  height: "t4-height.i32", water: "t4-water.u16", rock: "t4-rock.u8", drift: "t4-drift.u8", dd: "t4-dd.u16",
  chn: "t4-chn.u8", valley: "t4-valley.u8", pwr: "t4-pwr.u16", stb: seasonal("stb", "u16"), dry: "t4-dry.u16",
  pr: seasonal("pr", "u16"), pe: seasonal("pe", "u16"), sun: seasonal("sun", "u16"), tmp: seasonal("tmp", "i16"), hum: seasonal("hum", "u8"),
};
export const GROUND_INPUTS = Object.values(GROUND_IN).flat();

// The stored words of a field of the tier, mapped: a tile touches the pages of its patch's cells only.
const maps = new Map<string, Field>();
export function mappedField(ctx: Ctx, file: string): Field {
  const key = `${ctx.dir.dir}/${file}`;
  let f = maps.get(key);
  if (!f) {
    const bytes = Bun.mmap(ctx.dir.path(file)), K = KINDS[typeOf(file)];
    f = new K(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / K.BYTES_PER_ELEMENT);
    maps.set(key, f);
  }
  return f;
}
export const unmapGround = () => maps.clear();
const gathered = <A extends Field>(f: Field, ids: Int32Array): A => {
  const out = new (f.constructor as new (n: number) => A)(ids.length);
  for (let k = 0; k < ids.length; k++) out[k] = f[ids[k]];
  return out;
};

// The inputs at a patch's cells, as stored.
export interface GroundFields {
  height: Int32Array; water: Uint16Array; rock: Uint8Array; drift: Uint8Array; dd: Uint16Array; chn: Uint8Array; valley: Uint8Array; pwr: Uint16Array; stb: Uint16Array[]; dry: Uint16Array;
  pr: Uint16Array[]; pe: Uint16Array[]; sun: Uint16Array[]; tmp: Int16Array[]; hum: Uint8Array[];
}
export function fieldsAt(ctx: Ctx, patch: Patch): GroundFields {
  const one = <A extends Field>(file: string) => gathered<A>(mappedField(ctx, file), patch.ids), many = <A extends Field>(files: string[]) => files.map((f) => one<A>(f));
  return {
    height: one(GROUND_IN.height), water: one(GROUND_IN.water), rock: one(GROUND_IN.rock), drift: one(GROUND_IN.drift), dd: one(GROUND_IN.dd), chn: one(GROUND_IN.chn), valley: one(GROUND_IN.valley),
    pwr: one(GROUND_IN.pwr), stb: many(GROUND_IN.stb), dry: one(GROUND_IN.dry), pr: many(GROUND_IN.pr), pe: many(GROUND_IN.pe), sun: many(GROUND_IN.sun), tmp: many(GROUND_IN.tmp), hum: many(GROUND_IN.hum),
  };
}

// ---------- stored words to the kernel's ----------
const O16 = 65536;
// 0.1 mm to Q16 mm, 1/255 to Q16: round half up in integers.
const mmQ16 = (v: number) => Math.floor((v * O16 + 5) / 10);
const HUM_Q16 = Int32Array.from({ length: 256 }, (_, v) => Math.floor((v * O16 + 127) / 255));
export function wordsOf(f: GroundFields, patch: Patch): Int32Array {
  const n = patch.ids.length, w = new Int32Array(INPUTS.length * n), at = (name: (typeof INPUTS)[number]) => INPUTS.indexOf(name) * n;
  const put = (name: (typeof INPUTS)[number], fill: (i: number) => number) => { const o = at(name); for (let i = 0; i < n; i++) w[o + i] = fill(i); };
  const real = (i: number) => (patch.missing[i] ? 0 : 1);
  put("height", (i) => f.height[i] * 256);
  put("open", (i) => (f.height[i] <= 0 || f.water[i] > 0 ? 1 : 0));
  put("drift", (i) => f.drift[i]); put("rock", (i) => f.rock[i]);
  put("driftDepth", (i) => f.dd[i] * 64);
  put("valley", (i) => (f.valley[i] ? O16 : 0));
  put("channel", (i) => (f.chn[i] && real(i) ? 1 : 0));
  put("power", (i) => f.pwr[i] * 4096);
  put("winterTable", (i) => f.stb[3][i] * (O16 / TABLE_UNIT)); put("dryTable", (i) => f.dry[i] * (O16 / TABLE_UNIT));
  for (let k = 0; k < 4; k++) {
    put(`seasonTable${k}` as (typeof INPUTS)[number], (i) => f.stb[k][i] * (O16 / TABLE_UNIT));
    put(`precip${k}` as (typeof INPUTS)[number], (i) => mmQ16(f.pr[k][i]));
    put(`pet${k}` as (typeof INPUTS)[number], (i) => mmQ16(f.pe[k][i]));
    put(`sun${k}` as (typeof INPUTS)[number], (i) => f.sun[k][i] * 64);
    put(`temp${k}` as (typeof INPUTS)[number], (i) => f.tmp[k][i] * 256);
    put(`humid${k}` as (typeof INPUTS)[number], (i) => HUM_Q16[f.hum[k][i]]);
  }
  return w;
}

// ---------- the kernel's outputs to the stored words ----------
export const GROUND_OUT = [
  ["t4-tree.u8", "tree", 255], ["t4-shr.u8", "shrub", 255], ["t4-grs.u8", "grass", 255], ["t4-mar.u8", "marsh", 255], ["t4-bare.u8", "bare", 255],
  ["t4-soil.u16", "soil", 1024], ["t4-sflag.u8", "flags", 1], ["t4-sandy.u8", "sandy", 255], ["t4-clayey.u8", "clayey", 255], ["t4-fert.u8", "fertility", 255], ["t4-moist.u8", "moist", 255],
  ["t4-sw0.u8", "soilWater0", 255], ["t4-sw1.u8", "soilWater1", 255], ["t4-sw2.u8", "soilWater2", 255], ["t4-sw3.u8", "soilWater3", 255],
  ["t4-ph.u8", "ph", 30], ["t4-org.u8", "organic", 2.55], ["t4-carb.u16", "carbon", 16], ["t4-nit.u16", "nitrogen", 64],
] as const;
export const GROUND_OUTPUTS: string[] = GROUND_OUT.map((o) => o[0]);

export interface GroundTile { fields: Record<string, Field>; saturated: number }
// The kernel's words of a patch as the stored fields (a patch's side by side words each).
export function compactGround(raw: Int32Array, n: number): GroundTile {
  const k = (name: string) => OUTPUTS.findIndex((o) => o[0] === name), fields: Record<string, Field> = {};
  let saturated = 0;
  for (const [file, name, unit] of GROUND_OUT) {
    const type = typeOf(file), K = KINDS[type], hi = type === "u8" ? 255 : 65535, out = new K(n);
    if (name === "flags") {
      const silt = k("silt") * n, sand = k("sand") * n, peat = k("peat") * n;
      for (let i = 0; i < n; i++) out[i] = (raw[silt + i] ? 1 : 0) | (raw[sand + i] ? 2 : 0) | (raw[peat + i] > 0 ? 4 : 0);
    } else {
      const o = OUTPUTS[k(name)], at = k(name) * n, div = o[1] as number;
      for (let i = 0; i < n; i++) {
        const v = Math.round((raw[at + i] / div) * unit);
        if (v > hi || v < 0) saturated++;
        out[i] = Math.max(0, Math.min(hi, v));
      }
    }
    fields[file] = out;
  }
  return { fields, saturated };
}

export async function groundTile(gpu: Gpu, patch: Patch, f: GroundFields, reach = GROUND_HALO): Promise<GroundTile> {
  const n = patch.ids.length, raw = await groundWords(gpu, wordsOf(f, patch), groundFormat(patch.side, reach));
  return compactGround(raw, n);
}

export let lastSaturated = 0;
export const groundStage: TileStage = {
  name: "ground",
  halo: GROUND_HALO,
  inputs: [],
  outputs: GROUND_OUTPUTS,
  async prepare(ctx) {
    for (const f of GROUND_INPUTS) if (!ctx.dir.has(f)) throw new Error(`ground: ${f} is not in ${ctx.dir.dir} (the water, terrain and air stages come first)`);
  },
  async run(ctx, patch) {
    const t = await groundTile(ctx.gpu, patch, fieldsAt(ctx, patch));
    lastSaturated += t.saturated;
    return t.fields;
  },
};
