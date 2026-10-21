// A tier's per-cell planes kept on disk tile-major, for solves that do not fit in memory (the 75 m tier is 402.7 million cells: one 4-byte plane is 1.6 GB). A plane is one file; a tile is
// one 256 by 256 block of it (tile = face * T * T + ty * T + tx with T = (256 << tier) / 256, cells in a tile row by row, x east and y north in the face's axes), so a tile is one
// contiguous positional read or write. A patch (patch.ts: a block of tiles and a halo of cells round it, laid flat across the face's edges) is gathered from the planes and its interior
// written back, which is how a tile-by-tile stage sees its neighbours across tile and face edges (the one rule of patch.ts cellAcross, not a second copy of it). Whole tiles are
// held by a least-recently-used cache of a fixed byte budget, so memory is bounded however big the tier is; writes go through to the file.
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { TILE } from "./grid";
import type { Patch } from "./patch";
import { KINDS, type Field, type FieldType } from "./stages";

const TILE_CELLS = TILE * TILE;
export interface TileAddress { face: number; tx: number; ty: number }

export class TileStore {
  readonly T: number; // tiles along a face's side
  readonly fn: number; // cells along a face's side
  readonly tiles: number;
  private readonly types = new Map<string, FieldType>();
  private readonly fds = new Map<string, number>();
  private readonly cache = new Map<string, Field>();
  private held = 0;
  get cachedBytes() { return this.held; }
  // bytes of tile data the cache may hold, and what it has read and written (for the cost model)
  readonly stats = { readBytes: 0, writeBytes: 0, hits: 0, misses: 0 };

  constructor(readonly dir: string, readonly tier: number, planes: Record<string, FieldType> = {}, readonly cacheBytes = 256 * 2 ** 20) {
    mkdirSync(dir, { recursive: true });
    this.T = 1 << tier;
    this.fn = TILE << tier;
    this.tiles = 6 * this.T * this.T;
    for (const [name, type] of Object.entries(planes)) this.add(name, type);
  }
  // Declare a plane (its file is made, sparse, at its full size when first written or read).
  add(name: string, type: FieldType) { this.types.set(name, type); }
  has(name: string) { return existsSync(this.path(name)); }
  typeOf(name: string): FieldType { const t = this.types.get(name); if (!t) throw new Error(`tilestore: no plane ${name}`); return t; }
  path(name: string) { return join(this.dir, `${name}.${this.typeOf(name)}.tiles`); }
  tileIndex(face: number, tx: number, ty: number) { return (face * this.T + ty) * this.T + tx; }
  tileAt(tile: number): TileAddress { const per = this.T * this.T, face = Math.floor(tile / per), r = tile - face * per, ty = Math.floor(r / this.T); return { face, tx: r - ty * this.T, ty }; }
  // The tile and the offset in it of a cell id of the tier (cell order k = (face * fn + Y) * fn + X).
  cellAt(id: number): { tile: number; at: number } {
    const n = this.fn, f = Math.floor(id / (n * n)), r = id - f * n * n, Y = Math.floor(r / n), X = r - Y * n;
    return { tile: (f * this.T + (Y >> 8)) * this.T + (X >> 8), at: (Y & 255) * TILE + (X & 255) };
  }

  private fd(name: string): number {
    let fd = this.fds.get(name);
    if (fd === undefined) {
      const p = this.path(name), width = KINDS[this.typeOf(name)].BYTES_PER_ELEMENT;
      fd = openSync(p, "a+");
      if (statSync(p).size !== this.tiles * TILE_CELLS * width) ftruncateSync(fd, this.tiles * TILE_CELLS * width);
      this.fds.set(name, fd);
    }
    return fd;
  }
  private closeFd(name: string) { const fd = this.fds.get(name); if (fd !== undefined) { closeSync(fd); this.fds.delete(name); } }
  private evict() {
    for (const [k, v] of this.cache) {
      if (this.held <= this.cacheBytes) break;
      this.cache.delete(k); this.held -= v.byteLength;
    }
  }
  private forgetPlane(name: string) {
    for (const [k, v] of this.cache) if (k.startsWith(`${name}\u0000`)) { this.cache.delete(k); this.held -= v.byteLength; }
  }

  // One tile of a plane, as the cached array itself: never written to by the caller (use `read` for a copy to change).
  view(name: string, tile: number): Field {
    const key = `${name}\u0000${tile}`, hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); this.stats.hits++; return hit; }
    this.stats.misses++;
    const K = KINDS[this.typeOf(name)], a = new K(TILE_CELLS), bytes = a.byteLength, u8 = new Uint8Array(a.buffer);
    let got = 0;
    const at = tile * bytes, fd = this.fd(name);
    while (got < bytes) { const r = readSync(fd, u8, got, bytes - got, at + got); if (r <= 0) break; got += r; }
    this.stats.readBytes += bytes;
    this.cache.set(key, a); this.held += bytes; this.evict();
    return a;
  }
  // A copy of one tile.
  read(name: string, tile: number): Field { return this.view(name, tile).slice() as Field; }
  write(name: string, tile: number, data: Field) {
    if (data.length !== TILE_CELLS) throw new Error(`tilestore: a tile is ${TILE_CELLS} cells, got ${data.length}`);
    const bytes = data.byteLength, fd = this.fd(name), u8 = new Uint8Array(data.buffer, data.byteOffset, bytes);
    let put = 0;
    while (put < bytes) put += writeSync(fd, u8, put, bytes - put, tile * bytes + put);
    this.stats.writeBytes += bytes;
    const key = `${name}\u0000${tile}`, hit = this.cache.get(key);
    if (hit) (hit as Uint8Array).set(data as Uint8Array); // same type and length: a typed array's set copies the values
  }
  // Exchange two planes of one type (a Jacobi pass reads one and writes the other, then they trade places): no copy.
  swap(a: string, b: string) {
    if (this.typeOf(a) !== this.typeOf(b)) throw new Error("tilestore: swap of planes of different types");
    this.closeFd(a); this.closeFd(b); this.forgetPlane(a); this.forgetPlane(b);
    const pa = this.path(a), pb = this.path(b), tmp = `${pa}.swap`;
    if (!existsSync(pa)) this.fd(a), this.closeFd(a);
    if (!existsSync(pb)) this.fd(b), this.closeFd(b);
    renameSync(pa, tmp); renameSync(pb, pa); renameSync(tmp, pb);
  }
  remove(name: string) { this.closeFd(name); this.forgetPlane(name); rmSync(this.path(name), { force: true }); }
  close() { for (const n of [...this.fds.keys()]) this.closeFd(n); this.cache.clear(); this.held = 0; }

  // The patch's copy of a plane: the value at each patch cell (a repeat at a cube's corner, `missing`, is the repeated cell's value). `out` is reused when given.
  // `ring` false leaves the halo cells as they were (zero in a fresh array): a stage that reads only its own cells does not read the neighbours' tiles.
  gather<A extends Field>(name: string, p: Patch, out?: A, ring = true): A {
    const K = KINDS[this.typeOf(name)], S = p.side, n = this.fn, T = this.T;
    if (p.tier !== this.tier) throw new Error(`tilestore: a tier ${p.tier} patch on a tier ${this.tier} store`);
    const o = (out ?? new K(S * S)) as A;
    const X0 = p.x0 - p.halo, Y0 = p.y0 - p.halo, face = p.face, lo = ring ? 0 : p.halo, hi = ring ? S : S - p.halo;
    const xa = Math.max(lo, -X0), xb = Math.min(hi, n - X0);
    for (let y = lo; y < hi; y++) {
      const Y = Y0 + y, row = y * S;
      if (Y >= 0 && Y < n && xb > xa) {
        // inside the face, a run of cells by tile column: one contiguous piece of a tile row each
        const ty = Y >> 8, iy = (Y & 255) * TILE;
        for (let x = xa; x < xb; ) {
          const X = X0 + x, tx = X >> 8, c0 = X & 255, len = Math.min(TILE - c0, xb - x), t = this.view(name, (face * T + ty) * T + tx);
          (o as Uint8Array).set((t as Uint8Array).subarray(iy + c0, iy + c0 + len), row + x);
          x += len;
        }
        for (let x = lo; x < xa; x++) o[row + x] = this.valueAt(name, p.ids[row + x]);
        for (let x = xb; x < hi; x++) o[row + x] = this.valueAt(name, p.ids[row + x]);
      } else for (let x = lo; x < hi; x++) o[row + x] = this.valueAt(name, p.ids[row + x]);
    }
    return o;
  }
  // One cell of a plane by its id.
  valueAt(name: string, id: number) { const { tile, at } = this.cellAt(id); return this.view(name, tile)[at]; }

  // The patch's interior written into the plane: the interior is a block of whole tiles (its corner a multiple of 256, its side a multiple of 256).
  scatter(name: string, p: Patch, field: Field) {
    if (p.x0 % TILE || p.y0 % TILE || p.interior % TILE) throw new Error("tilestore: a patch's interior must be whole tiles to be scattered");
    const K = KINDS[this.typeOf(name)], S = p.side, blocks = p.interior / TILE, tile = new K(TILE_CELLS);
    for (let by = 0; by < blocks; by++)
      for (let bx = 0; bx < blocks; bx++) {
        for (let y = 0; y < TILE; y++) {
          const from = (by * TILE + y + p.halo) * S + bx * TILE + p.halo;
          (tile as Uint8Array).set((field as Uint8Array).subarray(from, from + TILE), y * TILE);
        }
        this.write(name, this.tileIndex(p.face, p.x0 / TILE + bx, p.y0 / TILE + by), tile);
      }
  }

  // The plane from a file of the tier's cells in cell order (what the chain's `t<k>-height.i32` files are), and the plane into one: a band of tile rows at a time.
  fromCells(name: string, path: string) {
    const K = KINDS[this.typeOf(name)], w = K.BYTES_PER_ELEMENT, n = this.fn, T = this.T, fd = openSync(path, "r"), band = new K(TILE * n), tile = new K(TILE_CELLS);
    try {
      for (let f = 0; f < 6; f++)
        for (let ty = 0; ty < T; ty++) {
          const u8 = new Uint8Array(band.buffer), at = (f * n + ty * TILE) * n * w;
          for (let got = 0; got < u8.length; ) { const r = readSync(fd, u8, got, u8.length - got, at + got); if (r <= 0) throw new Error(`tilestore: ${path} is shorter than a tier ${this.tier} plane`); got += r; }
          for (let tx = 0; tx < T; tx++) {
            for (let y = 0; y < TILE; y++) (tile as Uint8Array).set((band as Uint8Array).subarray(y * n + tx * TILE, y * n + (tx + 1) * TILE), y * TILE);
            this.write(name, this.tileIndex(f, tx, ty), tile);
          }
        }
    } finally { closeSync(fd); }
  }
  // The plane from an array of the tier's cells in cell order.
  putCells(name: string, cells: Field) {
    const K = KINDS[this.typeOf(name)], n = this.fn, T = this.T, tile = new K(TILE_CELLS);
    if (cells.length !== 6 * n * n) throw new Error(`tilestore: ${cells.length} cells for a tier ${this.tier} plane of ${6 * n * n}`);
    for (let f = 0; f < 6; f++)
      for (let ty = 0; ty < T; ty++)
        for (let tx = 0; tx < T; tx++) {
          for (let y = 0; y < TILE; y++) { const at = (f * n + ty * TILE + y) * n + tx * TILE; (tile as Uint8Array).set((cells as Uint8Array).subarray(at, at + TILE), y * TILE); }
          this.write(name, this.tileIndex(f, tx, ty), tile);
        }
  }
  toCells(name: string, path: string) {
    const K = KINDS[this.typeOf(name)], w = K.BYTES_PER_ELEMENT, n = this.fn, T = this.T, band = new K(TILE * n);
    const total = 6 * n * n * w, fd = openSync(path, "w");
    try {
      ftruncateSync(fd, total);
      for (let f = 0; f < 6; f++)
        for (let ty = 0; ty < T; ty++) {
          for (let tx = 0; tx < T; tx++) {
            const t = this.view(name, this.tileIndex(f, tx, ty));
            for (let y = 0; y < TILE; y++) (band as Uint8Array).set((t as Uint8Array).subarray(y * TILE, (y + 1) * TILE), y * n + tx * TILE);
          }
          const u8 = new Uint8Array(band.buffer), at = (f * n + ty * TILE) * n * w;
          for (let put = 0; put < u8.length; ) put += writeSync(fd, u8, put, u8.length - put, at + put);
        }
    } finally { closeSync(fd); }
  }
}
