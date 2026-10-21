// The island's fine stages run over a whole tier a tile at a time, each tile on its patch (patch.ts: the tile and a halo of the cells round it, across the face's edges), the
// answers for the tile's own 256 by 256 cells written into one global field file each. A stage is a function of the global fields within its halo, so a cell's answer is
// the same whichever tile makes it, and the tiles can be made in any order, in any number of calls (a call stops at its budget and the next resumes where it stopped).
import { closeSync, ftruncateSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import type { Gpu } from "../device";
import { TILE, tierGrid } from "./grid";
import { gather, patchOf, tileAt, tileCount, type Patch } from "./patch";
import type { BakeDir } from "./tiers";
import type { Planet } from "./window";

export type Field = Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;
export type FieldType = "f32" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";
export const KINDS = { f32: Float32Array, i32: Int32Array, u32: Uint32Array, i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array } as const;
export const typeOf = (file: string): FieldType => file.slice(file.lastIndexOf(".") + 1) as FieldType;

export interface Ctx { gpu: Gpu; planet: Planet; dir: BakeDir; tier: number }
// A stage: `inputs` are global field files of the BakeDir (`t<tier>-height.i32`, bakedir.ts tierFile), `outputs` the global field files it writes; `run` gets the patch and each input as the patch's
// copy (side * side words), and returns each output as a patch field (side * side), of which the tile's interior is kept.
export interface TileStage {
  name: string;
  halo: number;
  block?: number; // the side in tiles of the square of tiles a patch makes at once (runTiles)
  inputs: string[];
  outputs: string[];
  prepare?(ctx: Ctx): Promise<void>;
  run(ctx: Ctx, patch: Patch, input: Record<string, Field>): Promise<Record<string, Field>>;
}

const loaded = new Map<string, Field>();
// A global field file, mapped for the process: a tile touches the pages of its patch's cells only, so a 1.6 GB plane of the 75 m tier at planet size is never held whole.
export function globalField(ctx: Pick<Ctx, "dir">, file: string): Field {
  const key = `${ctx.dir.dir}/${file}`;
  let f = loaded.get(key);
  if (!f) {
    const bytes = Bun.mmap(ctx.dir.path(file)), K = KINDS[typeOf(file)];
    f = new K(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength / K.BYTES_PER_ELEMENT);
    loaded.set(key, f);
  }
  return f;
}
export const forget = () => loaded.clear();

// The tile's rows of an output file: positional writes, so nothing is held in memory and a stopped call has lost nothing.
export class FieldFile {
  private fd: number;
  readonly width: number;
  constructor(readonly path: string, readonly type: FieldType, cells: number) {
    this.width = KINDS[type].BYTES_PER_ELEMENT;
    this.fd = openSync(path, "a+");
    ftruncateSync(this.fd, cells * this.width);
  }
  writeRow(at: number, row: Field) { writeSync(this.fd, new Uint8Array(row.buffer, row.byteOffset, row.byteLength), 0, row.byteLength, at * this.width); }
  readRow(at: number, n: number): Field { const K = KINDS[this.type], out = new K(n); readSync(this.fd, new Uint8Array(out.buffer), 0, n * this.width, at * this.width); return out; }
  close() { closeSync(this.fd); }
}

// The marker of the tiles a stage has made at a tier: one byte a tile, 1 where made (tiers of one bake share its directory, so the tier is in the name).
export const doneFileOf = (tier: number, stage: string) => `t${tier}-${stage}-done.u8`;

export interface TileProgress { done: boolean; tiles: number; of: number; seconds: number; tileS: number[] }
// Make the tiles of a stage not yet made, within `budgetS` seconds (a unit's time is taken as the slowest so far); `only` limits the run to some tiles. A stage's `block` is the side, in
// tiles, of the square of tiles one patch makes at once (a power of 2 that divides the tier's tiles a face: 1 by default): the halo's cost is shared by block * block tiles, and the bytes
// do not change, which is what a stage's tile independence means. A block with a tile asked for makes every tile of it; `tileS` has one entry per tile made (a block's time shared).
export async function runTiles(ctx: Ctx, stage: TileStage, budgetS: number, log: (s: string) => void = () => {}, only?: number[]): Promise<TileProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, of = tileCount(ctx.tier), fn = tierGrid(ctx.tier).fn, cells = 6 * fn ** 2, T = fn / TILE, bl = stage.block ?? 1;
  if (T % bl) throw new Error(`${stage.name}: a block of ${bl} tiles does not divide the tier's ${T} tiles a face`);
  const doneFile = doneFileOf(ctx.tier, stage.name), legacy = `${stage.name}-done.u8`, done = new Uint8Array(of);
  // a marker of the first bakes had no tier in its name; one that holds this tier's tile count is this tier's (no two tiers have the same count)
  if (ctx.dir.has(doneFile)) done.set(new Uint8Array(ctx.dir.raw(doneFile)).subarray(0, of));
  else if (ctx.dir.has(legacy) && ctx.dir.bytes(legacy) === of) done.set(new Uint8Array(ctx.dir.raw(legacy)));
  const outs = stage.outputs.map((f) => new FieldFile(ctx.dir.path(f), typeOf(f), cells));
  const tileS: number[] = [];
  await stage.prepare?.(ctx);
  let worst = 0;
  const units: number[] = [], seen = new Set<number>();
  for (const k of only ?? Array.from({ length: of }, (_, i) => i)) {
    if (!Number.isInteger(k) || k < 0 || k >= of) throw new Error(`${stage.name}: tile ${k} is not one of the tier's ${of}`);
    const { face, tx, ty } = tileAt(ctx.tier, k), first = (face * T + ty - (ty % bl)) * T + tx - (tx % bl);
    if (!seen.has(first)) { seen.add(first); units.push(first); }
  }
  try {
    for (const first of units) {
      const { face, tx, ty } = tileAt(ctx.tier, first), members: number[] = [];
      for (let j = 0; j < bl; j++) for (let i = 0; i < bl; i++) members.push(first + j * T + i);
      if (members.every((k) => done[k])) continue;
      if (spent() + worst * 1.3 > budgetS) break;
      const s0 = performance.now(), patch = patchOf(ctx.tier, face, tx, ty, stage.halo, bl * TILE);
      const input: Record<string, Field> = {};
      for (const f of stage.inputs) input[f] = gather(patch, globalField(ctx, f) as Float32Array);
      const out = await stage.run(ctx, patch, input);
      stage.outputs.forEach((f, n) => {
        const o = out[f];
        if (!o || o.length !== patch.side * patch.side) throw new Error(`${stage.name}: output ${f} is not a patch field`);
        for (let j = 0; j < bl; j++)
          for (let i = 0; i < bl; i++)
            for (let y = 0; y < TILE; y++) {
              const row = (j * TILE + y + stage.halo) * patch.side + i * TILE + stage.halo;
              outs[n].writeRow((face * fn + (ty + j) * TILE + y) * fn + (tx + i) * TILE, o.subarray(row, row + TILE) as Field);
            }
      });
      for (const k of members) done[k] = 1;
      ctx.dir.write(`${doneFile}.part`, done);
      renameSync(ctx.dir.path(`${doneFile}.part`), ctx.dir.path(doneFile));
      const dt = (performance.now() - s0) / 1000;
      for (let m = 0; m < bl * bl; m++) tileS.push(dt / (bl * bl));
      worst = Math.max(worst, dt);
      log(`${stage.name} tile ${first} (face ${face}, ${tx}, ${ty})${bl > 1 ? ` and the block of ${bl} by ${bl} from it` : ""} ${dt.toFixed(1)} s`);
    }
  } finally { for (const o of outs) o.close(); }
  const total = done.reduce((a, b) => a + b, 0);
  return { done: only ? only.every((k) => done[k]) : total === of, tiles: total, of, seconds: spent(), tileS };
}

// ---------- the planet's coarse fields at a patch's cells ----------
// A tier-0 field of the planet (bilinear between the centres of the four tier-0 cells round each patch cell, the cells across a face's edge as grid.ts gives them, a cube's
// missing corner taken as the mean of the two beside it): what window.ts's remap does for a window, with no window's edge in it [design, R1761].
export { sampleCoarse } from "./sample";
