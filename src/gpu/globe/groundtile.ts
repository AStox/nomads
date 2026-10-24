// The ground tiles: beside the pyramid, one gzipped file a tile of the finest tier holding every field the scatter (scatter.ts) and the close levels' painter read, in the stage files' own words, in a field of
// the tile's cells and a halo of 8. The format is bake.ts GROUNDTILE_FIELDS. The page reads a tile from here and runs the scatter's fine kernel on it (`tileSource` gives scatter.ts the same fields
// the stage files do, so the objects are the same); nothing in it is made up: a field whose stage file does not exist is left out of the file and named in its header (`absent`), a gap, never
// a zero plane. Not stored, made from these: the fine ground (heights, wetness, moisture, covers, the stream mask: scatter.ts with `keepFine`), the peat's depth (bit 2 of `flags`, ground.ts PEAT_DEPTH).
//
// The river lines the painter draws are the cell chain: each channel cell to its receiver, 75 m steps, the segments scatter.ts riversOf makes for the stream mask. The island draws smoothed,
// meandering polylines (water.ts `shape`) that need a river's whole line; a tile has a part of it [gap: no meanders, no smoothing].
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DIRS, GROUNDTILE_FIELDS, GROUNDTILE_HALO, GROUNDTILE_VERSION, groundTilePath } from "./bake";
import { tierFile, type BakeDir } from "./bakedir";
import { mappedField } from "./ground";
import { localOf, patchOf, tileAt, tileCount } from "./patch";
import type { TileSource } from "./scatter";
import { KINDS, type Field } from "./stages";

export type Planes = Record<string, Field>;
export interface GroundTileMeta {
  version: number; seed: number; key: string; tile: number; face: number; tx: number; ty: number; halo: number; side: number;
  fields: { name: string; type: string; step: number; unit: string }[];
  absent: string[]; // the fields whose stage files did not exist
  lostReceivers: number; // receivers that are not one of the eight neighbours in the field (written as none)
  quick: number[] | null; // the water stage's quick runoff by season for the tile, where it made it
}

// The receiver as a code: 0 none, else 1 + the index in DIRS of the neighbour, from the patch's own index of the receiver.
function dirCode(recv: Int32Array, S: number): { code: Uint8Array; lost: number } {
  const code = new Uint8Array(recv.length);
  let lost = 0;
  for (let i = 0; i < recv.length; i++) {
    const j = recv[i];
    if (j < 0 || j === i) continue;
    const dx = (j % S) - (i % S), dy = Math.floor(j / S) - Math.floor(i / S), k = DIRS.findIndex(([a, b]) => a === dx && b === dy);
    if (k < 0) lost++; else code[i] = k + 1;
  }
  return { code, lost };
}

// Tile `tile` of tier `o.tier` from the stage files of `dir`.
export function makeGroundTile(dir: BakeDir, tile: number, o: { seed: number; key: string; tier: number }): { meta: GroundTileMeta; planes: Planes } {
  const { face, tx, ty } = tileAt(o.tier, tile), p = patchOf(o.tier, face, tx, ty, GROUNDTILE_HALO), S = p.side, planes: Planes = {}, fields: GroundTileMeta["fields"] = [], absent: string[] = [];
  let lostReceivers = 0;
  for (const f of GROUNDTILE_FIELDS) {
    const file = tierFile(o.tier, f.file);
    if (!dir.has(file)) { absent.push(f.name); continue; }
    const m = mappedField({ dir }, file), K = KINDS[f.type];
    let plane: Field;
    if (f.name === "dir") {
      const local = localOf(p), recv = new Int32Array(p.ids.length);
      for (let i = 0; i < recv.length; i++) recv[i] = local(m[p.ids[i]]);
      const d = dirCode(recv, S);
      plane = d.code; lostReceivers = d.lost;
    } else {
      plane = new K(p.ids.length);
      for (let i = 0; i < plane.length; i++) plane[i] = m[p.ids[i]];
      // a cube's corner leaves cells with none of their own: they repeat the nearest cell, which has no channel
      if (f.name === "chn") for (let i = 0; i < plane.length; i++) if (p.missing[i]) plane[i] = 0;
    }
    planes[f.name] = plane;
    fields.push({ name: f.name, type: f.type, step: f.step, unit: f.unit });
  }
  const quick = dir.json<number[][]>(tierFile(o.tier, "quick"));
  return { meta: { version: GROUNDTILE_VERSION, seed: o.seed, key: o.key, tile, face, tx, ty, halo: GROUNDTILE_HALO, side: S, fields, absent, lostReceivers, quick: quick?.[tile] ?? null }, planes };
}

export function groundTileBytes(meta: GroundTileMeta, planes: Planes): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(meta)), parts: Uint8Array[] = [new Uint8Array(new Uint32Array([head.length]).buffer), head];
  for (const f of meta.fields) { const p = planes[f.name]; parts.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); }
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return Bun.gzipSync(out as Uint8Array<ArrayBuffer>);
}
export function readGroundTile(gz: Uint8Array): { meta: GroundTileMeta; planes: Planes } {
  const raw = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>), hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))) as GroundTileMeta;
  const planes: Planes = {};
  let at = 4 + hl;
  for (const f of meta.fields) {
    const K = KINDS[f.type as keyof typeof KINDS], bytes = meta.side * meta.side * K.BYTES_PER_ELEMENT;
    planes[f.name] = new K(raw.slice(at, at + bytes).buffer);
    at += bytes;
  }
  return { meta, planes };
}

// scatter.ts's view of a ground tile: the planes cropped to the halo asked for, and the receivers decoded.
export function tileSource(gt: { meta: GroundTileMeta; planes: Planes }): TileSource {
  const S = gt.meta.side, H = gt.meta.halo;
  const crop = (src: Field, halo: number): Field => {
    const side = 256 + 2 * halo, off = H - halo, out = new (src.constructor as new (n: number) => Field)(side * side);
    for (let y = 0; y < side; y++) (out as Uint8Array).set((src as Uint8Array).subarray((y + off) * S + off, (y + off) * S + off + side), y * side);
    return out;
  };
  return {
    plane<A extends Field>(name: string, halo: number) {
      const p = gt.planes[name];
      if (!p) throw new Error(`the ground tile has no ${name} (absent: ${gt.meta.absent.join(", ")})`);
      return crop(p, halo) as A;
    },
    recv(halo: number) {
      const side = 256 + 2 * halo, code = crop(gt.planes.dir, halo) as Uint8Array, out = new Int32Array(side * side).fill(-1);
      for (let i = 0; i < out.length; i++) {
        if (!code[i]) continue;
        const [dx, dy] = DIRS[code[i] - 1], x = (i % side) + dx, y = Math.floor(i / side) + dy;
        if (x >= 0 && y >= 0 && x < side && y < side) out[i] = y * side + x;
      }
      return out;
    },
  };
}

export interface GroundTileProgress { done: boolean; made: number; kept: number; of: number; seconds: number; absent: string[] }
// Write the ground tiles of `tiles` (all of tier `o.tier` by default) not yet written, within `budgetS` seconds; a file is written whole and moved into place, so a stopped call has lost nothing.
export function buildGroundTiles(dir: BakeDir, o: { seed: number; key: string; tier: number; tiles?: number[]; budgetS?: number }, log: (s: string) => void = () => {}): GroundTileProgress {
  const t0 = performance.now(), of = tileCount(o.tier), list = o.tiles ?? Array.from({ length: of }, (_, k) => k);
  let made = 0, kept = 0, worst = 0, absent: string[] = [];
  for (const k of list) {
    const { face, tx, ty } = tileAt(o.tier, k), path = groundTilePath(dir.dir, face, tx, ty);
    if (existsSync(path)) { kept++; continue; }
    const spent = (performance.now() - t0) / 1000;
    if (o.budgetS !== undefined && spent + worst * 1.3 > o.budgetS) break;
    const s0 = performance.now(), { meta, planes } = makeGroundTile(dir, k, o);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.part`, groundTileBytes(meta, planes));
    renameSync(`${path}.part`, path);
    absent = meta.absent;
    const dt = (performance.now() - s0) / 1000;
    worst = Math.max(worst, dt); made++;
    log(`ground tile ${k} (face ${face}, ${tx}, ${ty}) ${dt.toFixed(2)} s`);
  }
  return { done: made + kept === list.length, made, kept, of: list.length, seconds: (performance.now() - t0) / 1000, absent };
}
