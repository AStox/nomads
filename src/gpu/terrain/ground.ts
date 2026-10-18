// The island's ground on the GPU: src/terrain/ground.ts ground() run as two kernels (wgsl/terrain-ground.ts), integer
// arithmetic throughout. It takes the Site the CPU builds in island.ts and returns the same Ground, so the wiring can
// drop it in; the fixed-point form of each field is the one the kernel holds (INPUTS and OUTPUTS there), converted at
// these edges only:
// - inputs: heights, depths, tables, precipitation and PET (mm), sun (MJ/m2 a day) and temperature (C) are Q16
//   (x * 2^16 rounded); open, channel, drift and rock are integers; valley is Q16 and read by its sign.
// - outputs: soil, peat (m), carbon (t a ha), organic (%), nitrogen (kg a ha a year) and pH are Q16; texture,
//   fertility, moisture, soil water and every cover share are Q24 fractions; silt and sand are 0 or 1.
import { LEN } from "../../terrain/grid";
import type { Ground, Site } from "../../terrain/ground";
import type { Gpu } from "../device";
import { cover, dispatch, pipeline, readback, storage } from "../kernel";
import { GROUND, INPUTS, OUTPUTS } from "../wgsl/terrain-ground";

const toQ16 = (x: number) => Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(x * 65536)));

function pack(s: Site): Int32Array {
  const inp = new Int32Array(INPUTS.length * LEN);
  const fields: Record<(typeof INPUTS)[number], ArrayLike<number>> = {
    height: s.height, open: s.open, drift: s.drift, rock: s.rock, driftDepth: s.driftDepth, valley: s.valley, channel: s.channel, power: s.power,
    winterTable: s.winterTable, dryTable: s.dryTable,
    seasonTable0: s.seasonTable[0], seasonTable1: s.seasonTable[1], seasonTable2: s.seasonTable[2], seasonTable3: s.seasonTable[3],
    precip0: s.seasons[0].precip, precip1: s.seasons[1].precip, precip2: s.seasons[2].precip, precip3: s.seasons[3].precip,
    pet0: s.seasons[0].pet, pet1: s.seasons[1].pet, pet2: s.seasons[2].pet, pet3: s.seasons[3].pet,
    sun0: s.seasons[0].sun, sun1: s.seasons[1].sun, sun2: s.seasons[2].sun, sun3: s.seasons[3].sun,
    temp0: s.seasons[0].temp, temp1: s.seasons[1].temp, temp2: s.seasons[2].temp, temp3: s.seasons[3].temp,
  };
  const whole = ["open", "drift", "rock", "channel"];
  INPUTS.forEach((name, f) => {
    const src = fields[name], dst = f * LEN;
    if (whole.includes(name)) for (let i = 0; i < LEN; i++) inp[dst + i] = src[i];
    else for (let i = 0; i < LEN; i++) inp[dst + i] = toQ16(src[i]);
  });
  return inp;
}

export async function groundGpu(g: Gpu, s: Site): Promise<Ground> {
  const input = storage(g, pack(s)), near = storage(g, 2 * LEN * 4), output = storage(g, OUTPUTS.length * LEN * 4);
  dispatch(g, pipeline(g, GROUND, "near"), [input, near], [1]);
  dispatch(g, pipeline(g, GROUND, "main"), [input, near, output], cover(g, LEN, 64));
  const raw = new Int32Array(await readback(g, output));
  input.destroy(); near.destroy(); output.destroy();
  const field = (name: (typeof OUTPUTS)[number][0]) => {
    const k = OUTPUTS.findIndex((o) => o[0] === name), div = OUTPUTS[k][1], f = new Float32Array(LEN);
    for (let i = 0; i < LEN; i++) f[i] = raw[k * LEN + i] / div;
    return f;
  };
  return {
    soil: field("soil"), silt: field("silt"), sand: field("sand"), peat: field("peat"), sandy: field("sandy"), clayey: field("clayey"),
    carbon: field("carbon"), organic: field("organic"), nitrogen: field("nitrogen"), ph: field("ph"), fertility: field("fertility"), moist: field("moist"),
    soilWater: [field("soilWater0"), field("soilWater1"), field("soilWater2"), field("soilWater3")],
    tree: field("tree"), shrub: field("shrub"), grass: field("grass"), marsh: field("marsh"), bare: field("bare"), field: field("field"), fieldLight: field("fieldLight"),
  };
}
