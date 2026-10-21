// The planet's discharge out of core: the same bytes as discharge.ts `dischargeOf` (the exact sum, down the whole forest of receivers, of every weight field: `<stem>-lo.u32`, `<stem>-hi.u16`,
// or `<stem>.u32` for a count of cells), made a block of tiles at a time with a memory that does not depend on the tier. The scheme is tiers-stream.ts' discharge area (docs/research/globe/
// 2026-10-22-planet-stream-tiers.md), on the CPU and in doubles:
//   area1  every block sums, over its own cells, what drains into each cell from inside the block (a receiver outside the block makes its cell an EXIT; the cells of the ring round the block
//          are the other blocks' and drain in over the edge: they are INFLOW edges). It records each exit's sum, and for each inflow edge the exit on whose in-block downstream path the cell it
//          lands on lies (-1: the path ends in a sea cell of the block);
//   skel   the exits form a forest across blocks (an exit's parent is that exit); it is summed on the host from the leaves;
//   area2  every block sums again with each inflow edge's exit total added at the cell it lands on. The result at a cell is the global discharge.
// A sum is an integer under 2^48 held in a double (exact to 2^53), so the order of the additions cannot matter: that is why this equals the in-memory gather word for word. A basin's sum
// passing 2^48 throws (the lo/hi words' format), and so does any partial sum, since a partial sum is a basin's sum of a part of it and cannot be smaller than what it adds up to.
// Receivers are the eight neighbours of a cell (patch.ts cellAcross: the ring of a block is laid flat across the face's edges, and a cube's corner has no diagonal cell); a receiver that is not
// found in the ring of the block it drains into leaves the exits and the inflow edges uncounted and the skeleton throws.
// Resume: the work directory holds what each block made as a small file (area1) or a marker (area2), the skeleton, and the outputs as `.part` files that are renamed when every block is done, so a
// call may stop between blocks at any time and the next goes on; the bytes do not depend on where calls were split or on the order of the blocks.
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BakeDir } from "./bakedir";
import { ONES, countFile, hiFile, loFile, type DischargeProgress, type WeightField } from "./discharge";
import { FACES, TILE, tierGrid, type Grid } from "./grid";
import { cellAcross } from "./patch";

// ---------- the files, read ----------
type View = Uint8Array | Uint16Array | Uint32Array | Int32Array;
// A field file of the tier read by position. A block's window of it is read as the whole band of rows it lies in (one large sequential read, kept while the blocks along the band are made), and a
// single cell is read from the band when it lies in it, else by position. Nothing else is in memory, so a process's size does not grow with the tier (a mapped file's pages stay resident until
// the process ends), and a file is read front to back once, not by 4 KB rows at the stride of a face.
export class Plane<A extends View> {
  readonly cells: number; private readonly fd: number; private readonly bpe: number; private readonly one: A; private readonly oneBytes: Uint8Array;
  private band: A | null = null; private bandStart = 0; private bandCells = 0;
  constructor(path: string, private readonly kind: { new (n: number): A; BYTES_PER_ELEMENT: number }) {
    this.fd = openSync(path, "r"); this.bpe = kind.BYTES_PER_ELEMENT; this.cells = fstatSync(this.fd).size / this.bpe;
    this.one = new kind(1); this.oneBytes = new Uint8Array(this.one.buffer);
  }
  private fill(id: number, bytes: Uint8Array, length: number) {
    for (let got = 0; got < length; ) {
      const n = readSync(this.fd, bytes, got, length - got, id * this.bpe + got);
      if (n <= 0) throw new Error(`discharge-stream: a file ends before cell ${id}`);
      got += n;
    }
  }
  // The `side` by `side` window at face position (X0, Y0) of a face `fn` cells across (cell ids (face * fn + Y) * fn + X), into `into` row by row.
  window(face: number, X0: number, Y0: number, side: number, fn: number, into: A) {
    const start = (face * fn + Y0) * fn, cells = side * fn;
    if (!this.band || this.bandStart !== start || this.bandCells !== cells) {
      if (!this.band || this.band.length !== cells) this.band = new this.kind(cells);
      this.fill(start, new Uint8Array(this.band.buffer, this.band.byteOffset, this.band.byteLength), cells * this.bpe);
      this.bandStart = start; this.bandCells = cells;
    }
    for (let y = 0; y < side; y++) into.set(this.band.subarray(y * fn + X0, y * fn + X0 + side) as A, y * side);
  }
  at(id: number): number {
    if (this.band && id >= this.bandStart && id < this.bandStart + this.bandCells) return this.band[id - this.bandStart];
    this.fill(id, this.oneBytes, this.bpe);
    return this.one[0];
  }
  close() { closeSync(this.fd); this.band = null; }
}
// The planes a call opened, closed together.
export class Planes {
  private readonly all: { close(): void }[] = [];
  open<A extends View>(path: string, kind: { new (n: number): A; BYTES_PER_ELEMENT: number }): Plane<A> { const p = new Plane(path, kind); this.all.push(p); return p; }
  close() { for (const p of this.all) p.close(); this.all.length = 0; }
}

// ---------- the blocks of a tier ----------
// A block is `block` by `block` tiles of one face (side S = 256 * block cells), numbered face, then by, then bx. It must divide the face's tiles.
export class BlockGrid {
  readonly grid: Grid;
  readonly fn: number; readonly lg: number; readonly cells: number; readonly S: number; readonly side: number; readonly count: number;
  constructor(readonly tier: number, readonly block: number) {
    this.grid = tierGrid(tier);
    this.fn = this.grid.fn; this.lg = Math.log2(this.fn); this.cells = this.fn * this.fn;
    const tiles = this.fn / TILE;
    if (!Number.isInteger(this.lg) || !Number.isInteger(block) || block < 1 || tiles % block) throw new Error(`stream: a block of ${block} tiles does not divide a face of ${tiles}`);
    this.S = block * TILE; this.side = tiles / block; this.count = FACES * this.side * this.side;
  }
  at(b: number): { face: number; X0: number; Y0: number } {
    const per = this.side * this.side, face = Math.floor(b / per), r = b - face * per, by = Math.floor(r / this.side);
    return { face, X0: (r - by * this.side) * this.S, Y0: by * this.S };
  }
  // The cell id at a face position, which may lie one cell past the face's edge (across it, laid flat); -1 at a cube's corner.
  id(face: number, X: number, Y: number): number { const n = this.fn; return X >= 0 && X < n && Y >= 0 && Y < n ? (face * n + Y) * n + X : cellAcross(this.grid, face, X, Y); }
  // The block and the place in it of a cell id.
  locate(id: number): { b: number; lx: number; ly: number } {
    const face = Math.floor(id / this.cells), r = id - face * this.cells, Y = Math.floor(r / this.fn), X = r - Y * this.fn, bx = Math.floor(X / this.S), by = Math.floor(Y / this.S);
    return { b: (face * this.side + by) * this.side + bx, lx: X - bx * this.S, ly: Y - by * this.S };
  }
  // The cells of the ring round block b (the eight neighbours of its edge cells), each once.
  ring(b: number): number[] {
    const { face, X0, Y0 } = this.at(b), S = this.S, seen = new Set<number>(), out: number[] = [];
    const add = (X: number, Y: number) => { const id = this.id(face, X, Y); if (id >= 0 && !seen.has(id)) { seen.add(id); out.push(id); } };
    for (let i = -1; i <= S; i++) { add(X0 + i, Y0 - 1); add(X0 + i, Y0 + S); }
    for (let j = 0; j < S; j++) { add(X0 - 1, Y0 + j); add(X0 + S, Y0 + j); }
    return out;
  }
}

// ---------- the call's accounting ----------
export interface StreamProgress extends DischargeProgress { stage: "area1" | "skel" | "area2" | "done"; blocks: number; blocksDone: number; blockS: Record<"area1" | "area2", number[]>; skelS: number; exits: number }
export interface StreamOptions { block?: number; reverse?: boolean; work?: string }
const MOST = 2 ** 48;

interface Meta { tier: number; block: number; from: string[]; stems: string[] }
const writeAtomic = (path: string, data: Float64Array) => { writeFileSync(`${path}.tmp`, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); renameSync(`${path}.tmp`, path); };
const readF64 = (path: string): Float64Array => { const b = readFileSync(path); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

class Blocks {
  readonly bg: BlockGrid; readonly W: number;
  readonly recv: Int32Array; readonly order: Int32Array; readonly into: Uint8Array; readonly end: Int32Array; readonly sums: Float64Array[];
  readonly toBlock: Uint32Array; readonly window: Uint32Array; readonly weights: (Plane<Uint32Array> | null)[];
  constructor(dir: BakeDir, tier: number, fields: readonly WeightField[], block: number, readonly to: Plane<Uint32Array>, open: Planes) {
    this.bg = new BlockGrid(tier, block);
    const nn = this.bg.S * this.bg.S;
    this.W = fields.length;
    this.recv = new Int32Array(nn); this.order = new Int32Array(nn); this.into = new Uint8Array(nn); this.end = new Int32Array(nn); this.toBlock = new Uint32Array(nn); this.window = new Uint32Array(nn);
    this.sums = fields.map(() => new Float64Array(nn));
    this.weights = fields.map((f) => (f.from === ONES ? null : open.open(dir.path(f.from), Uint32Array)));
    for (const w of this.weights) if (w && w.cells !== FACES * this.bg.cells) throw new Error(`discharge-stream: a weight file holds ${w.cells} cells, wanted ${FACES * this.bg.cells}`);
  }

  // The block's receivers as local cells (recv: the receiver's place in the block; the cell itself where it drains to itself, the sea; -1 for an exit) and the leaves-first order of Kahn's algorithm.
  topology(b: number) {
    const { S, fn, lg } = this.bg, { face, X0, Y0 } = this.bg.at(b), recv = this.recv, into = this.into, toBlock = this.toBlock, mask = fn - 1, lg2 = 2 * lg;
    into.fill(0);
    this.to.window(face, X0, Y0, S, fn, toBlock);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = y * S + x, g = toBlock[k];
        const lx = (g & mask) - X0, ly = ((g >>> lg) & mask) - Y0;
        if (g >>> lg2 === face && lx >= 0 && lx < S && ly >= 0 && ly < S) {
          const r = ly * S + lx;
          recv[k] = r;
          if (r !== k) into[r]++;
        } else recv[k] = -1;
      }
    }
    const order = this.order, nn = S * S;
    let tail = 0, head = 0;
    for (let k = 0; k < nn; k++) if (into[k] === 0) order[tail++] = k;
    while (head < tail) {
      const k = order[head++], r = recv[k];
      if (r < 0 || r === k) continue;
      if (--into[r] === 0) order[tail++] = r;
    }
    if (tail !== nn) throw new Error(`discharge-stream: the receivers of block ${b} hold a cycle`);
  }

  // The block's weights into the sums.
  load(b: number) {
    const { S, fn } = this.bg, { face, X0, Y0 } = this.bg.at(b);
    for (let j = 0; j < this.W; j++) {
      const w = this.weights[j], s = this.sums[j];
      if (!w) { s.fill(1); continue; }
      w.window(face, X0, Y0, S, fn, this.window);
      for (let k = 0; k < S * S; k++) s[k] = this.window[k];
    }
  }
  // Add each cell's sum to its receiver's, leaves first.
  accumulate() {
    const nn = this.order.length, order = this.order, recv = this.recv;
    for (const s of this.sums) for (let i = 0; i < nn; i++) { const k = order[i], r = recv[k]; if (r >= 0 && r !== k) s[r] += s[k]; }
  }
  // The inflow edges of block b: the ring's cells whose receiver is a cell of the block, as [the ring cell's id, the cell of the block it lands on].
  inflows(b: number): [number, number][] {
    const { S, fn, lg } = this.bg, { face, X0, Y0 } = this.bg.at(b), out: [number, number][] = [], mask = fn - 1, lg2 = 2 * lg;
    for (const o of this.bg.ring(b)) {
      const t = this.to.at(o);
      if (t === o) continue;
      const lx = (t & mask) - X0, ly = ((t >>> lg) & mask) - Y0;
      if (t >>> lg2 === face && lx >= 0 && lx < S && ly >= 0 && ly < S) out.push([o, ly * S + lx]);
    }
    return out;
  }
  idOf(b: number, k: number): number { const { S, fn } = this.bg, { face, X0, Y0 } = this.bg.at(b), y = Math.floor(k / S); return (face * fn + Y0 + y) * fn + X0 + (k - y * S); }
}

// Make the discharge of the weight fields not yet made, within `budgetS` seconds (a block is the unit: a call that finds one block would pass the budget stops before it, but always makes one).
export async function dischargeStream(dir: BakeDir, tier: number, fields: readonly WeightField[], budgetS = Infinity, log: (s: string) => void = () => {}, opts: StreamOptions = {}): Promise<StreamProgress> {
  const open = new Planes();
  try { return await streamed(open, dir, tier, fields, budgetS, log, opts); } finally { open.close(); }
}
async function streamed(open: Planes, dir: BakeDir, tier: number, fields: readonly WeightField[], budgetS: number, log: (s: string) => void, opts: StreamOptions): Promise<StreamProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
  const todo = fields.filter((f) => !(f.from === ONES ? dir.has(countFile(f.stem)) : dir.has(hiFile(f.stem)) && dir.has(loFile(f.stem))));
  const bg0 = new BlockGrid(tier, opts.block ?? 4), N = FACES * bg0.cells;
  const prog: StreamProgress = { done: true, made: [], seconds: 0, stage: "done", blocks: bg0.count, blocksDone: bg0.count, blockS: { area1: [], area2: [] }, skelS: 0, exits: 0 };
  if (!todo.length) return { ...prog, seconds: spent() };
  const work = opts.work ?? dir.path(`discharge-stream-t${tier}.work`);
  mkdirSync(work, { recursive: true });
  const meta: Meta = { tier, block: bg0.block, from: todo.map((f) => f.from), stems: todo.map((f) => f.stem) };
  const metaPath = join(work, "meta.json");
  if (existsSync(metaPath)) { if (readFileSync(metaPath, "utf8") !== JSON.stringify(meta)) throw new Error(`discharge-stream: ${work} holds a run of other fields or another block size: remove it`); } else writeFileSync(metaPath, JSON.stringify(meta));

  const to = open.open(dir.path(`t${tier}-to.u32`), Uint32Array);
  if (to.cells !== N) throw new Error(`discharge-stream: tier ${tier} holds ${N} cells, its receivers ${to.cells}`);
  const B = new Blocks(dir, tier, todo, bg0.block, to, open), bg = B.bg, W = B.W;
  const order = Array.from({ length: bg.count }, (_, b) => (opts.reverse ? bg.count - 1 - b : b));
  const a1 = (b: number) => join(work, `a1-${b}.f64`), a2 = (b: number) => join(work, `a2-${b}.done`), skelPath = join(work, "skeleton.f64");
  let worst = 0;
  const room = () => spent() + worst * 1.3 <= budgetS;

  // ---- area1 ----
  const left1 = order.filter((b) => !existsSync(a1(b)));
  for (const b of left1) {
    if (prog.blockS.area1.length && !room()) break;
    const s0 = performance.now();
    B.topology(b); B.load(b); B.accumulate();
    const { S } = bg, nn = S * S, recv = B.recv, end = B.end, ord = B.order;
    for (let i = nn - 1; i >= 0; i--) { const k = ord[i], r = recv[k]; end[k] = r === k ? -1 : r < 0 ? k : end[r]; }
    const exits: number[] = [];
    for (let k = 0; k < nn; k++) if (recv[k] === -1) exits.push(k);
    const inflow = B.inflows(b), rec = new Float64Array(2 + exits.length * (1 + W) + inflow.length * 2);
    rec[0] = exits.length; rec[1] = inflow.length;
    let p = 2;
    for (const k of exits) {
      rec[p++] = B.idOf(b, k);
      for (let j = 0; j < W; j++) { const v = B.sums[j][k]; if (v >= MOST) throw new Error(`discharge-stream: ${todo[j].stem}'s sum at cell ${B.idOf(b, k)} passed 48 bits`); rec[p++] = v; }
    }
    for (const [o, c] of inflow) { rec[p++] = o; const e = end[c]; rec[p++] = e < 0 ? -1 : B.idOf(b, e); }
    writeAtomic(a1(b), rec);
    const dt = (performance.now() - s0) / 1000; worst = Math.max(worst, dt); prog.blockS.area1.push(dt);
  }
  const done1 = order.filter((b) => existsSync(a1(b))).length;
  if (done1 < bg.count) return finish(prog, "area1", done1, spent());

  // ---- skel ----
  if (!existsSync(skelPath)) {
    const s0 = performance.now();
    writeAtomic(skelPath, solveSkeleton(order.map((b) => readF64(a1(b))), W, todo.map((f) => f.from === ONES)));
    prog.skelS = (performance.now() - s0) / 1000;
    log(`discharge-stream: the exits' forest summed in ${prog.skelS.toFixed(1)} s`);
  }

  // ---- area2 ----
  const skel = readF64(skelPath), at = new Map<number, number>(), stride = 1 + W;
  prog.exits = skel.length / stride;
  for (let i = 0; i < skel.length; i += stride) at.set(skel[i], i + 1);
  const outs = todo.map((f) => (f.from === ONES ? [countFile(f.stem)] : [loFile(f.stem), hiFile(f.stem)]));
  const part = (name: string) => `${dir.path(name)}.part`;
  const fds = new Map<string, number>();
  const left2 = order.filter((b) => !existsSync(a2(b)));
  try {
    for (const b of left2) {
      if (prog.blockS.area2.length && !room()) break;
      const s0 = performance.now();
      B.topology(b); B.load(b);
      for (const [o, c] of B.inflows(b)) {
        const i = at.get(o);
        if (i === undefined) throw new Error(`discharge-stream: no discharge for cell ${o}, which flows into block ${b}`);
        for (let j = 0; j < W; j++) B.sums[j][c] += skel[i + j];
      }
      B.accumulate();
      const { S, fn } = bg, { face, X0, Y0 } = bg.at(b);
      for (let j = 0; j < W; j++) {
        const s = B.sums[j], count = todo[j].from === ONES, lo = new Uint32Array(S * S), hi = count ? null : new Uint16Array(S * S);
        for (let k = 0; k < S * S; k++) {
          const v = s[k];
          if (count ? v >= 2 ** 32 : v >= MOST) throw new Error(`discharge-stream: ${todo[j].stem}'s sum at cell ${B.idOf(b, k)} passed ${count ? 32 : 48} bits`);
          lo[k] = v >>> 0;
          if (hi) hi[k] = Math.floor(v / 4294967296);
        }
        const planes: [string, View][] = count ? [[outs[j][0], lo]] : [[outs[j][0], lo], [outs[j][1], hi as Uint16Array]];
        for (const [name, plane] of planes) {
          let fd = fds.get(name);
          if (fd === undefined) {
            const path = part(name), fresh = !existsSync(path);
            fd = openSync(path, fresh ? "w" : "r+");
            if (fresh) ftruncateSync(fd, N * plane.BYTES_PER_ELEMENT);
            fds.set(name, fd);
          }
          const bytes = plane.BYTES_PER_ELEMENT;
          for (let y = 0; y < S; y++) writeSync(fd, new Uint8Array(plane.buffer, plane.byteOffset + y * S * bytes, S * bytes), 0, S * bytes, ((face * fn + Y0 + y) * fn + X0) * bytes);
        }
      }
      writeFileSync(a2(b), "");
      const dt = (performance.now() - s0) / 1000; worst = Math.max(worst, dt); prog.blockS.area2.push(dt);
    }
  } finally { for (const fd of fds.values()) closeSync(fd); }
  const done2 = order.filter((b) => existsSync(a2(b))).length;
  if (done2 < bg.count) return finish(prog, "area2", done2, spent());
  for (const names of outs) for (const name of names) renameSync(part(name), dir.path(name));
  rmSync(work, { recursive: true, force: true });
  prog.made = todo.map((f) => f.stem);
  return finish(prog, "done", bg.count, spent());

  function finish(p: StreamProgress, stage: StreamProgress["stage"], blocksDone: number, seconds: number): StreamProgress {
    return { ...p, done: stage === "done", stage, blocksDone, seconds };
  }
}

// The exits' totals. `blocks` are area1's records: [exits, inflows, then per exit its id and its sums, then per inflow edge the id of its exit cell and the parent exit]. The result is, per exit, its id
// and the total of each weight: its block's sum over the cells upstream of it in the block plus the totals of the exits that flow into those cells (its children in the forest).
export function solveSkeleton(blocks: Float64Array[], W: number, count: boolean[]): Float64Array {
  const ids = new Map<number, number>(), own: number[] = [];
  for (const r of blocks) {
    const ne = r[0];
    for (let i = 0, p = 2; i < ne; i++, p += 1 + W) { ids.set(r[p], ids.size); for (let j = 0; j < W; j++) own.push(r[p + 1 + j]); }
  }
  const m = ids.size, sum = Float64Array.from(own), parent = new Int32Array(m).fill(-2), left = new Int32Array(m);
  let edges = 0;
  for (const r of blocks) {
    const ne = r[0], ni = r[1];
    for (let i = 0, p = 2 + ne * (1 + W); i < ni; i++, p += 2) {
      const o = ids.get(r[p]);
      if (o === undefined) throw new Error(`discharge-stream: cell ${r[p]} drains into a block but is no block's exit (a receiver that is not a neighbour?)`);
      if (parent[o] !== -2) throw new Error(`discharge-stream: exit ${r[p]} flows into two blocks`);
      const e = r[p + 1];
      let q = -1;
      if (e >= 0) { const k = ids.get(e); if (k === undefined) throw new Error(`discharge-stream: no exit ${e}`); q = k; left[k]++; }
      parent[o] = q; edges++;
    }
  }
  if (edges !== m) throw new Error(`discharge-stream: ${m} cells drain out of a block but ${edges} drain into one`);
  const ready: number[] = [];
  for (let k = 0; k < m; k++) if (left[k] === 0) ready.push(k);
  let done = 0;
  const out = new Float64Array(m * (1 + W)), key = [...ids.keys()];
  while (ready.length) {
    const k = ready.pop() as number;
    done++;
    out[k * (1 + W)] = key[k];
    for (let j = 0; j < W; j++) {
      const v = sum[k * W + j];
      if (count[j] ? v >= 2 ** 32 : v >= MOST) throw new Error(`discharge-stream: the discharge of cell ${key[k]} passed ${count[j] ? 32 : 48} bits`);
      out[k * (1 + W) + 1 + j] = v;
    }
    const q = parent[k];
    if (q < 0) continue;
    for (let j = 0; j < W; j++) sum[q * W + j] += sum[k * W + j];
    if (--left[q] === 0) ready.push(q);
  }
  if (done !== m) throw new Error("discharge-stream: the exits' forest has a cycle");
  return out;
}
