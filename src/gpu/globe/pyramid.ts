// Bakes the planet's 75 m tier into the tile pyramid the page streams (the format is bake.ts PYRAMID_FIELDS): the top tier's tiles are read from the global field files the stages
// wrote, each field converted to its integer by a `Source`, and every coarser tier is made from the tier below by 2 by 2 pooling, depth first so only one unit's ancestors are in memory.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PYRAMID_FIELDS, PYRAMID_VERSION } from "./bake";
import type { BakeDir } from "./bakedir";
import { KINDS, typeOf, type Field, type FieldType } from "./stages";

const TILE = 256, CELLS = TILE * TILE;
// Where a field comes from: global field files of the top tier (one or several: a year's mean of four seasons) and the integer, of the field's own type and in its step, made of their words.
// With `across` the integer is made of the cell and its eight neighbours: `raw` holds the files' words of the cell at (dx, dy) = (n % 3 - 1, floor(n / 3) - 1) at raw[n * files + m] (a cell past the
// face's edge is the edge cell), for a field that is read between the cells' centres (a lake's share of the cell: the part of it the flooded surface stands above the ground).
export interface Source { files: string[]; convert: (raw: number[]) => number; across?: boolean }
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

// The share, 0 to 255, of a cell's area that lies under a lake, from the cell and its eight neighbours (an `across` source of the files water.u16 (cm), height.i32 and flooded.i32, both 1/256 m).
// A lake cell (water over land) holds its flooded surface less its ground; another land cell holds the level of a lake beside it less its ground (below zero: it stands above the water); a cell with
// no lake beside it, or under the sea, is dry. Read between the cells' centres as the page reads a tier's cells, the water stands where that sum is above zero, so the shore lies where the flooded
// surface meets the ground between two cells and not on a cell's edge; the share is the part of 4 by 4 places in the cell where it does [design: 16 places, a share to 1/16].
const DRY = -1e9, SAMPLES = [-0.375, -0.125, 0.125, 0.375];
export function lakeShare(raw: number[]): number {
  const lake = (n: number) => raw[3 * n] > 0 && raw[3 * n + 1] > 0;
  let any = false, all = true;
  for (let n = 0; n < 9; n++) { if (lake(n)) any = true; else all = false; }
  if (!any) return 0;
  if (all) return 255;
  const s = new Array<number>(9);
  for (let n = 0; n < 9; n++) {
    if (lake(n)) { s[n] = raw[3 * n + 2] - raw[3 * n + 1]; continue; }
    if (raw[3 * n + 1] <= 0) { s[n] = DRY; continue; }
    let level = -Infinity;
    for (let k = 0; k < 9; k++) if (lake(k) && Math.abs((k % 3) - (n % 3)) <= 1 && Math.abs((k / 3 | 0) - (n / 3 | 0)) <= 1) level = Math.max(level, raw[3 * k + 2]);
    s[n] = level === -Infinity ? DRY : level - raw[3 * n + 1];
  }
  let wet = 0;
  for (const oy of SAMPLES)
    for (const ox of SAMPLES) {
      const u = 1 + ox, v = 1 + oy, ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy, at = (x: number, y: number) => s[y * 3 + x];
      if ((at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy > 0) wet++;
    }
  return (255 * wet) / (SAMPLES.length * SAMPLES.length);
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

export interface PyramidOptions {
  seed: number; key: string; topTier: number; sources: Partial<Record<(typeof PYRAMID_FIELDS)[number]["name"], Source>>; faces?: number[];
  unitTier?: number; // the tier whose tiles root the work units (default 3 tiers above the top: 85 tiles a unit)
  out?: string; // the directory the tiles (`pyramid/`) and `pyramid.json` are written under, default the bake directory the fields are read from
  budgetS?: number; // stop before a unit that would pass this many seconds; every call that has a unit left makes at least one
}
export interface PyramidProgress { done: boolean; unitsMade: number; unitsKept: number; units: number; counts: number[]; seconds: number }
// The write of one tile: whole into `.part`, then moved into place, so a file that exists is a whole one.
function putTile(path: string, bytes: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
}
// Bake the pyramid under `<dir>/pyramid` in calls of at most `budgetS` seconds; run again until `done`. The work unit is the subtree below one tile of tier `unitTier`, made depth first so its
// root is written last: a unit whose root exists is whole and is kept, one that does not is made again from its top tier (a killed call leaves at most `.part` files and unfinished units).
// The tiers above the units' roots are pooled from the roots' files once a face's units all exist; the face's tier 0 tile, written last, marks the face done. Memory is one unit's ancestors.
export function buildPyramid(dir: BakeDir, o: PyramidOptions): PyramidProgress {
  const root = o.out ?? dir.dir, t0 = performance.now(), fn = TILE << o.topTier, counts = new Array<number>(o.topTier + 1).fill(0), fds = new Map<string, number>();
  const u = o.unitTier ?? Math.max(0, o.topTier - 3), faces = o.faces ?? [0, 1, 2, 3, 4, 5], side = 1 << u;
  const fd = (file: string) => { let n = fds.get(file); if (n === undefined) { n = openSync(dir.path(file), "r"); fds.set(file, n); } return n; };
  const read = (f: (typeof PYRAMID_FIELDS)[number], face: number, tx: number, ty: number): Field => {
    const out = new KINDS[f.type](CELLS), s = o.sources[f.name];
    if (!s) return out;
    const Ks = s.files.map((file) => KINDS[typeOf(file)]), nf = s.files.length;
    if (s.across) {
      const SIDE = TILE + 2, planes = Ks.map((K) => new K(SIDE * SIDE)), raw = new Array<number>(9 * nf), at = (v: number) => Math.min(fn - 1, Math.max(0, v));
      for (let j = 0; j < SIDE; j++) {
        const yy = at(ty * TILE + j - 1);
        s.files.forEach((file, m) => {
          const K = Ks[m], one = new K(1), row = (xx: number) => ((face * fn + yy) * fn + xx) * K.BYTES_PER_ELEMENT;
          readSync(fd(file), new Uint8Array(planes[m].buffer, j * SIDE * K.BYTES_PER_ELEMENT + K.BYTES_PER_ELEMENT, TILE * K.BYTES_PER_ELEMENT), 0, TILE * K.BYTES_PER_ELEMENT, row(tx * TILE));
          readSync(fd(file), new Uint8Array(one.buffer), 0, K.BYTES_PER_ELEMENT, row(at(tx * TILE - 1))); planes[m][j * SIDE] = one[0];
          readSync(fd(file), new Uint8Array(one.buffer), 0, K.BYTES_PER_ELEMENT, row(at(tx * TILE + TILE))); planes[m][j * SIDE + SIDE - 1] = one[0];
        });
      }
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          for (let n = 0; n < 9; n++) for (let m = 0; m < nf; m++) raw[n * nf + m] = planes[m][(y + (n / 3 | 0)) * SIDE + x + (n % 3)];
          out[y * TILE + x] = clampTo(f.type, s.convert(raw));
        }
      return out;
    }
    const rows = Ks.map((K) => new K(TILE)), raw = new Array<number>(nf);
    for (let y = 0; y < TILE; y++) {
      s.files.forEach((file, m) => readSync(fd(file), new Uint8Array(rows[m].buffer), 0, TILE * Ks[m].BYTES_PER_ELEMENT, ((face * fn + ty * TILE + y) * fn + tx * TILE) * Ks[m].BYTES_PER_ELEMENT));
      for (let x = 0; x < TILE; x++) { for (let m = 0; m < rows.length; m++) raw[m] = rows[m][x]; out[y * TILE + x] = clampTo(f.type, s.convert(raw)); }
    }
    return out;
  };
  const poolOf = (kids: Planes[]): Planes => Object.fromEntries(PYRAMID_FIELDS.map((f) => [f.name, pool(f.pool, f.type, kids.map((k) => k[f.name]))]));
  const put = (tier: number, face: number, tx: number, ty: number, planes: Planes) => {
    putTile(tilePath(root, tier, face, tx, ty), tileBytes({ seed: o.seed, key: o.key, tier, face, tx, ty }, planes));
    counts[tier]++;
  };
  const make = (tier: number, face: number, tx: number, ty: number): Planes => {
    const planes = tier === o.topTier ? Object.fromEntries(PYRAMID_FIELDS.map((f) => [f.name, read(f, face, tx, ty)])) : poolOf([0, 1, 2, 3].map((n) => make(tier + 1, face, 2 * tx + (n & 1), 2 * ty + (n >> 1))));
    put(tier, face, tx, ty, planes);
    return planes;
  };
  const above = (tier: number, face: number, tx: number, ty: number): Planes => {
    if (tier === u) return readTile(readFileSync(tilePath(root, tier, face, tx, ty))).planes;
    const planes = poolOf([0, 1, 2, 3].map((n) => above(tier + 1, face, 2 * tx + (n & 1), 2 * ty + (n >> 1))));
    put(tier, face, tx, ty, planes);
    return planes;
  };
  let made = 0, kept = 0, worst = 0, stopped = false, doneFaces = 0;
  try {
    for (const face of faces) {
      for (let ty = 0; ty < side && !stopped; ty++)
        for (let tx = 0; tx < side; tx++) {
          if (existsSync(tilePath(root, u, face, tx, ty))) { kept++; continue; }
          if (o.budgetS !== undefined && made > 0 && (performance.now() - t0) / 1000 + worst * 1.3 > o.budgetS) { stopped = true; break; }
          const s0 = performance.now();
          make(u, face, tx, ty);
          worst = Math.max(worst, (performance.now() - s0) / 1000); made++;
        }
      if (stopped) break;
      if (u > 0 && !existsSync(tilePath(root, 0, face, 0, 0))) above(0, face, 0, 0);
      doneFaces++;
    }
  } finally { for (const n of fds.values()) closeSync(n); }
  const done = doneFaces === faces.length;
  if (done) writeFileSync(join(root, "pyramid.json"), JSON.stringify({ version: PYRAMID_VERSION, seed: o.seed, key: o.key, tiers: o.topTier + 1, fields: PYRAMID_FIELDS.map((f) => f.name), missing: PYRAMID_FIELDS.filter((f) => !o.sources[f.name]).map((f) => f.name) }));
  return { done, unitsMade: made, unitsKept: kept, units: faces.length * side * side, counts, seconds: (performance.now() - t0) / 1000 };
}
export type { FieldType };
