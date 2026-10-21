// What the ground stage's and the scatter's tests on the real planet stand on: a scratch bake (/tmp/planet-75m/ground-scratch/bake) whose heights and terrain files are links to the real
// bake's, and in which the air stage's files, a stand-in for the water stage's and the ground stage's own are made for the tiles a test asks for. The stand-in water is a function of each
// cell's height and discharge area, not the water stage's: channels where a cell drains 20,000 cells or more, a floodplain within 24 cells of one on ground under 800 m, a power that
// falls with the area, a water table deep where the area is small, a mean flow of 7.9 l/s a km2 of area (BANKFULL's own), and standing water where the tier's flood stands over the ground
// (a lake) or the cell is sea. A test that reads the water stage's own files uses the bake when they are in it.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { theGpu } from "../device";
import { airStage } from "./air";
import { BakeDir } from "./bakedir";
import { GROUND_HALO, TABLE_UNIT, groundStage, mappedField } from "./ground";
import { patchOf, tileAt } from "./patch";
import { runTiles, type Ctx, type Field, type TileStage } from "./stages";
import { readPlanet, type Planet } from "./window";
import { diskStore } from "../../../scripts/globe-window";

export const KEY = "883a8d9387df", BAKE = `/tmp/planet-75m/1-${KEY}`, STOREDIR = "/tmp/planet-small/store", SCRATCH = "/tmp/planet-75m/ground-scratch/bake", TIER = 4, FN = 4096;
export const REAL = existsSync(`${BAKE}/t4-height.i32`) && existsSync(`${BAKE}/t4-acc.u32`) && existsSync(`${STOREDIR}/1-${KEY}`);

// The tiles whose cells a patch of the given tiles covers.
export function tilesCovering(tiles: number[], halo: number): number[] {
  const want = new Set<number>();
  for (const k of tiles) {
    const { face, tx, ty } = tileAt(TIER, k), p = patchOf(TIER, face, tx, ty, halo);
    for (const id of p.ids) { const f = Math.floor(id / (FN * FN)), r = id - f * FN * FN; want.add(f * 256 + (Math.floor(r / FN) >> 8) * 16 + ((r % FN) >> 8)); }
  }
  return [...want].sort((a, b) => a - b);
}

export const standInWater: TileStage = {
  name: "synwater-4", halo: 32, inputs: [],
  outputs: ["t4-water.u16", "t4-chn.u8", "t4-valley.u8", "t4-pwr.u16", "t4-stb0.u16", "t4-stb1.u16", "t4-stb2.u16", "t4-stb3.u16", "t4-dry.u16", "t4-flow.u32", "t4-base.u16", "t4-tab.u16", "t4-under.u16"],
  async run(ctx, patch) {
    const n = patch.ids.length, S = patch.side, at = (f: string) => { const m = mappedField(ctx, f), o = new (m.constructor as new (n: number) => Field)(n); for (let i = 0; i < n; i++) o[i] = m[patch.ids[i]]; return o; };
    const h = at("t4-height.i32") as Int32Array, fl = at("t4-flooded.i32") as Int32Array, acc = at("t4-acc.u32") as Uint32Array;
    const chn = new Uint8Array(n), valley = new Uint8Array(n), water = new Uint16Array(n), pwr = new Uint16Array(n), flow = new Uint32Array(n), base = new Uint16Array(n), tab = new Uint16Array(n), under = new Uint16Array(n), d = new Int32Array(n).fill(1e6);
    for (let i = 0; i < n; i++) { chn[i] = h[i] > 0 && acc[i] >= 20000 && !patch.missing[i] ? 1 : 0; if (chn[i]) d[i] = 0; }
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; if (x) d[i] = Math.min(d[i], d[i - 1] + 1); if (y) d[i] = Math.min(d[i], d[i - S] + 1); }
    for (let y = S - 1; y >= 0; y--) for (let x = S - 1; x >= 0; x--) { const i = y * S + x; if (x < S - 1) d[i] = Math.min(d[i], d[i + 1] + 1); if (y < S - 1) d[i] = Math.min(d[i], d[i + S] + 1); }
    const stb = [0, 1, 2, 3].map(() => new Uint16Array(n)), dry = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      valley[i] = h[i] > 0 && d[i] <= 24 && h[i] < 800 * 256 ? 1 : 0;
      water[i] = h[i] <= 0 ? Math.min(65535, Math.round((-h[i] / 256) * 100) + 100) : fl[i] - h[i] >= 3 ? Math.min(65535, Math.round(((fl[i] - h[i]) / 256) * 100)) : 0;
      pwr[i] = chn[i] ? Math.min(65535, Math.round((acc[i] / 4000) * 16)) : 0;
      flow[i] = h[i] > 0 ? Math.min(0xffffffff / 16, Math.round(((acc[i] * 5625) / 1e6) * 0.0079 * 65536)) : 0;
      const depth = 0.2 + 3000 / (acc[i] + 100);
      for (let k = 0; k < 4; k++) stb[k][i] = Math.min(65535, Math.round(depth * (0.4 + 0.1 * k) * TABLE_UNIT));
      dry[i] = Math.min(65535, Math.round(depth * TABLE_UNIT));
      base[i] = chn[i] ? 32768 : 0; tab[i] = Math.min(65535, Math.round(depth * 0.55 * TABLE_UNIT)); under[i] = chn[i] ? 41 : 0;
    }
    return { "t4-water.u16": water, "t4-chn.u8": chn, "t4-valley.u8": valley, "t4-pwr.u16": pwr, "t4-stb0.u16": stb[0], "t4-stb1.u16": stb[1], "t4-stb2.u16": stb[2], "t4-stb3.u16": stb[3], "t4-dry.u16": dry, "t4-flow.u32": flow, "t4-base.u16": base, "t4-tab.u16": tab, "t4-under.u16": under };
  },
};

let planet: Planet | null = null;
// The scratch bake's context with everything a reader of `tiles` over `halo` cells needs in it: the ground stage's outputs for the tiles that cover the patches, and under them (the ground's own
// halo) the air stage's and the stand-in water's. `ground` false makes the air and the water only.
export async function scratchBake(tiles: number[], halo: number, ground = true): Promise<Ctx> {
  mkdirSync(SCRATCH, { recursive: true });
  for (const f of ["t4-height.i32", "t4-flooded.i32", "t4-rock.u8", "t4-drift.u8", "t4-dd.u16", "t4-to.u32", "t4-acc.u32"]) if (!existsSync(`${SCRATCH}/${f}`)) symlinkSync(`${BAKE}/${f}`, `${SCRATCH}/${f}`);
  // what was made in the scratch bake belongs to the heights it was made from: the real bake's change when the tiers are baked again, and then every stage's tiles are made again
  const stamp = String(statSync(`${BAKE}/t4-height.i32`).mtimeMs), stampFile = `${SCRATCH}/from.txt`;
  if (!existsSync(stampFile) || readFileSync(stampFile, "utf8") !== stamp) {
    for (const f of ["air", "synwater-4", "ground"]) rmSync(`${SCRATCH}/${f}-done.u8`, { force: true });
    writeFileSync(stampFile, stamp);
  }
  planet ??= await readPlanet(1, diskStore(STOREDIR, KEY));
  const ctx: Ctx = { gpu: await theGpu(), planet, dir: new BakeDir(SCRATCH), tier: TIER }, covered = tilesCovering(tiles, ground ? halo : 0);
  const need = ground ? tilesCovering(covered, GROUND_HALO) : tilesCovering(tiles, halo);
  for (const stage of [airStage, standInWater]) await runTiles(ctx, stage, 250, () => {}, need);
  if (ground) await runTiles(ctx, groundStage, 250, () => {}, covered);
  return ctx;
}
