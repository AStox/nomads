// Bakes the planet's 75 m tier into the tile pyramid the page streams (the format is bake.ts PYRAMID_FIELDS): the top tier's tiles are read from the global field files the stages
// wrote, each field converted to its integer by a `Source`, and every coarser tier is made from the tier below by 2 by 2 pooling, depth first so only one tile's ancestors are in memory.
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PYRAMID_FIELDS, PYRAMID_VERSION } from "./bake";
import type { BakeDir } from "./bakedir";
import { KINDS, typeOf, type Field, type FieldType } from "./stages";

const TILE = 256, CELLS = TILE * TILE;
// Where a field comes from: global field files of the top tier (one or several: a year's mean of four seasons) and the integer, of the field's own type and in its step, made of their words.
export interface Source { files: string[]; convert: (raw: number[]) => number }
export type Planes = Record<string, Field>;

const clampTo = (type: FieldType, v: number) => {
  const lim = { i8: [-128, 127], u8: [0, 255], i16: [-32768, 32767], u16: [0, 65535], i32: [-(2 ** 31), 2 ** 31 - 1], u32: [0, 2 ** 32 - 1], f32: [-Infinity, Infinity] }[type];
  return Math.min(lim[1], Math.max(lim[0], Math.round(v)));
};

// 2 by 2 pooling of four child planes (children[j * 2 + i] is the child at x offset i, y offset j) into the parent's plane.
export function pool(kind: "mean" | "mode" | "max", type: FieldType, children: Field[]): Field {
  const out = new KINDS[type](CELLS), v = [0, 0, 0, 0];
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const c = children[(y >> 7) * 2 + (x >> 7)], at = ((y & 127) * 2) * TILE + (x & 127) * 2;
      v[0] = c[at]; v[1] = c[at + 1]; v[2] = c[at + TILE]; v[3] = c[at + TILE + 1];
      let r: number;
      if (kind === "mean") r = clampTo(type, (v[0] + v[1] + v[2] + v[3]) / 4);
      else if (kind === "max") r = Math.max(v[0], v[1], v[2], v[3]);
      else {
        r = v[0];
        let best = 0;
        for (let a = 0; a < 4; a++) { let n = 0; for (let b = 0; b < 4; b++) if (v[b] === v[a]) n++; if (n > best) { best = n; r = v[a]; } }
      }
      out[y * TILE + x] = r;
    }
  return out;
}

export function tilePath(root: string, tier: number, face: number, tx: number, ty: number) { return join(root, "pyramid", `t${tier}`, `f${face}`, `${ty}-${tx}.tile.gz`); }

export function tileBytes(meta: { seed: number; key: string; tier: number; face: number; tx: number; ty: number }, planes: Planes): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify({ version: PYRAMID_VERSION, ...meta, size: TILE, fields: PYRAMID_FIELDS.map(({ name, type, step, unit }) => ({ name, type, step, unit })) }));
  const parts: Uint8Array[] = [new Uint8Array(new Uint32Array([head.length]).buffer), head];
  for (const f of PYRAMID_FIELDS) { const p = planes[f.name]; parts.push(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)); }
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return Bun.gzipSync(out);
}
// Reads a tile back: its header and planes.
export function readTile(gz: Uint8Array): { meta: Record<string, any>; planes: Planes } {
  const raw = Bun.gunzipSync(gz as Uint8Array<ArrayBuffer>), hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true), meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl)));
  const planes: Planes = {};
  let at = 4 + hl;
  for (const f of PYRAMID_FIELDS) {
    const K = KINDS[f.type], bytes = CELLS * K.BYTES_PER_ELEMENT;
    planes[f.name] = new K(raw.slice(at, at + bytes).buffer);
    at += bytes;
  }
  return { meta, planes };
}

export interface PyramidOptions { seed: number; key: string; topTier: number; sources: Partial<Record<(typeof PYRAMID_FIELDS)[number]["name"], Source>>; faces?: number[] }
// Bake the pyramid under `<dir>/pyramid`. Tiles whose files exist are kept, not made again. Returns the tile counts by tier.
export function buildPyramid(dir: BakeDir, o: PyramidOptions): number[] {
  const fn = TILE << o.topTier, counts = new Array(o.topTier + 1).fill(0), fds = new Map<string, number>();
  const fd = (file: string) => { let n = fds.get(file); if (n === undefined) { n = openSync(dir.path(file), "r"); fds.set(file, n); } return n; };
  const read = (f: (typeof PYRAMID_FIELDS)[number], face: number, tx: number, ty: number): Field => {
    const out = new KINDS[f.type](CELLS), s = o.sources[f.name];
    if (!s) return out;
    const Ks = s.files.map((file) => KINDS[typeOf(file)]), rows = Ks.map((K) => new K(TILE)), raw = new Array<number>(s.files.length);
    for (let y = 0; y < TILE; y++) {
      s.files.forEach((file, m) => readSync(fd(file), new Uint8Array(rows[m].buffer), 0, TILE * Ks[m].BYTES_PER_ELEMENT, ((face * fn + ty * TILE + y) * fn + tx * TILE) * Ks[m].BYTES_PER_ELEMENT));
      for (let x = 0; x < TILE; x++) { for (let m = 0; m < rows.length; m++) raw[m] = rows[m][x]; out[y * TILE + x] = clampTo(f.type, s.convert(raw)); }
    }
    return out;
  };
  const make = (tier: number, face: number, tx: number, ty: number): Planes => {
    let planes: Planes;
    if (tier === o.topTier) planes = Object.fromEntries(PYRAMID_FIELDS.map((f) => [f.name, read(f, face, tx, ty)]));
    else {
      const kids = [0, 1, 2, 3].map((n) => make(tier + 1, face, 2 * tx + (n & 1), 2 * ty + (n >> 1)));
      planes = Object.fromEntries(PYRAMID_FIELDS.map((f) => [f.name, pool(f.pool, f.type, kids.map((k) => k[f.name]))]));
    }
    const path = tilePath(dir.dir, tier, face, tx, ty);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tileBytes({ seed: o.seed, key: o.key, tier, face, tx, ty }, planes));
    counts[tier]++;
    return planes;
  };
  try {
    for (const face of o.faces ?? [0, 1, 2, 3, 4, 5]) make(0, face, 0, 0);
  } finally { for (const n of fds.values()) closeSync(n); }
  dir.putJson("pyramid", { version: PYRAMID_VERSION, seed: o.seed, key: o.key, tiers: o.topTier + 1, fields: PYRAMID_FIELDS.map((f) => f.name), missing: PYRAMID_FIELDS.filter((f) => !o.sources[f.name]).map((f) => f.name) });
  return counts;
}
export type { FieldType };
