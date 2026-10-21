// The planet's lakes out of core: the same bytes as water.ts `basinOf` (`t<T>-basin.u8`, 1 in every cell of a lake), made a block of tiles at a time (discharge-stream.ts' BlockGrid) with a
// memory bounded by the block and by the number of hollow components that cross a block's edge, not by the tier. What `basinOf` decides, over the whole tier: a HOLLOW is a 4-neighbour component
// (across tile and face edges) of cells with height above 0 whose flooded surface is at least HOLLOW_MIN_UNITS over the height; it is a lake candidate where its deepest cell (flooded less height)
// passes WATER_TABLE_UNITS; it is a lake (every cell 1) where the sum of its cells' lake net plus the four seasons' discharge of every cell outside it that drains into one of its cells (the eight
// neighbours of its cells) is not negative. Three passes, each over every block, with the merge on the host between them:
//   label   the block's own components (flood fill); a component that has a cell on the block's edge next to a hollow cell across it is TOUCHING (it may continue in another block), the rest is
//           whole. For each touching component the block keeps its deepest and its lake net, and the labels along its four edges. The host joins the touching components across every block edge
//           and face edge (exactly the 4-neighbour rule) in a union-find whose size is the blocks times the edge cells, and adds up the deepest, and the lake net, of each joined component.
//   inflow  for every component whose lake is undecided (touching, or whole and deeper than WATER_TABLE_UNITS), the discharge of the cells outside it that drain in, found cell by cell as the
//           original does: a neighbour o of a member c with to[o] = c is counted unless o is a member too, which is decided by the joined component's id (a cell of the ring is in another block:
//           it is a member only if both are touching and joined). A whole component is decided here and its lake written; a touching one adds its inflow to the host's total.
//   write   the joined components that hold a lake write their cells in every block they cover.
// Every sum is an integer far under 2^53, so the order cannot change a bit. Resume as discharge-stream.ts: each block's result is a small file in the work directory, the output is a `.part` file
// renamed at the end, and the bytes do not depend on where calls were split or on the order of the blocks.
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { BakeDir } from "./bakedir";
import { BlockGrid, Plane, Planes } from "./discharge-stream";
import { FACES } from "./grid";

// The deepest hollow, in 1/256 m, that is not a lake (WATER_TABLE, 3 m), and the least a hollow's cell is raised by, 1 cm (HOLLOW_MIN) rounded up to the tier's unit: water.ts' constants.
export const WATER_TABLE_UNITS = 3 * 256, HOLLOW_MIN_UNITS = Math.ceil(0.01 * 256);
const SEASONS = 4, AROUND: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

export interface BasinProgress {
  done: boolean; stage: "label" | "inflow" | "write" | "done"; blocks: number; blocksDone: number; seconds: number;
  blockS: Record<"label" | "inflow" | "write", number[]>; mergeS: number; lakes: number; dry: number; components: number; touching: number;
}
export interface BasinOptions { block?: number; reverse?: boolean; work?: string; stems?: readonly string[] }

const writeAtomic = (path: string, data: Float64Array) => { writeFileSync(`${path}.tmp`, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); renameSync(`${path}.tmp`, path); };
const readF64 = (path: string): Float64Array => { const b = readFileSync(path); return new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

// The joined components of the touching ones: ids are `block * 4S + k` for the k-th touching component of the block.
class Joined {
  readonly parent: Int32Array; readonly exists: Uint8Array; readonly deepest: Float64Array; readonly net: Float64Array; readonly inflow: Float64Array;
  constructor(readonly bg: BlockGrid) {
    const n = bg.count * 4 * bg.S;
    this.parent = Int32Array.from({ length: n }, (_, i) => i); this.exists = new Uint8Array(n); this.deepest = new Float64Array(n); this.net = new Float64Array(n); this.inflow = new Float64Array(n);
  }
  find(a: number): number { let r = a; while (this.parent[r] !== r) r = this.parent[r]; while (this.parent[a] !== r) { const n = this.parent[a]; this.parent[a] = r; a = n; } return r; }
  union(a: number, b: number) { const x = this.find(a), y = this.find(b); if (x !== y) this.parent[Math.max(x, y)] = Math.min(x, y); }
}

class Basin {
  readonly bg: BlockGrid; readonly S: number;
  readonly h: Plane<Int32Array>; readonly f: Plane<Int32Array>; readonly net: Plane<Int32Array>; readonly to: Plane<Uint32Array>; readonly qlo: Plane<Uint32Array>[]; readonly qhi: Plane<Uint16Array>[];
  // one block's analysis
  readonly hb: Int32Array; readonly fb: Int32Array; readonly depth: Int32Array; readonly lake: Int32Array; readonly labels: Int32Array; readonly stack: Int32Array; readonly hollow: Uint8Array;
  readonly deepest: Int32Array; readonly sum: Float64Array; readonly touching: Uint8Array; readonly tIndex: Int32Array; readonly edges: Int32Array;
  // and its flow, for the inflow pass
  readonly toBlock: Uint32Array; readonly qsum: Float64Array; readonly winLo: Uint32Array; readonly winHi: Uint16Array;
  K = 0; nT = 0;
  constructor(dir: BakeDir, readonly tier: number, block: number, stems: readonly string[], open: Planes) {
    this.bg = new BlockGrid(tier, block); this.S = this.bg.S;
    const nn = this.S * this.S, N = FACES * this.bg.cells, p = (name: string) => dir.path(name);
    this.h = open.open(p(`t${tier}-height.i32`), Int32Array); this.f = open.open(p(`t${tier}-flooded.i32`), Int32Array); this.net = open.open(p(`t${tier}-lakenet.i32`), Int32Array);
    this.to = open.open(p(`t${tier}-to.u32`), Uint32Array);
    this.qlo = stems.map((s) => open.open(p(`${s}-lo.u32`), Uint32Array)); this.qhi = stems.map((s) => open.open(p(`${s}-hi.u16`), Uint16Array));
    for (const a of [this.h, this.f, this.net, this.to, ...this.qlo, ...this.qhi]) if (a.cells !== N) throw new Error(`basin-stream: an input holds ${a.cells} cells, wanted ${N}`);
    this.hb = new Int32Array(nn); this.fb = new Int32Array(nn); this.depth = new Int32Array(nn); this.lake = new Int32Array(nn); this.labels = new Int32Array(nn); this.stack = new Int32Array(nn); this.hollow = new Uint8Array(nn);
    this.toBlock = new Uint32Array(nn); this.qsum = new Float64Array(nn); this.winLo = new Uint32Array(nn); this.winHi = new Uint16Array(nn);
    const cap = (nn >> 1) + 2;
    this.deepest = new Int32Array(cap); this.sum = new Float64Array(cap); this.touching = new Uint8Array(cap); this.tIndex = new Int32Array(cap); this.edges = new Int32Array(4 * this.S);
  }
  hollowAt(id: number): boolean { const h = this.h.at(id); return h > 0 && this.f.at(id) - h >= HOLLOW_MIN_UNITS; }

  // The block's components (labels 1 to K, 0 off the hollows) with each one's deepest cell and lake net, which touch another block, and the labels along the edges (gid = b * 4S + k).
  analyse(b: number) {
    const { S, bg } = this, { face, X0, Y0 } = bg.at(b), fn = bg.fn, nn = S * S, { hollow, depth, lake, labels, stack } = this;
    this.h.window(face, X0, Y0, S, fn, this.hb); this.f.window(face, X0, Y0, S, fn, this.fb); this.net.window(face, X0, Y0, S, fn, lake);
    for (let k = 0; k < nn; k++) { const h = this.hb[k], d = this.fb[k] - h; hollow[k] = h > 0 && d >= HOLLOW_MIN_UNITS ? 1 : 0; depth[k] = d; }
    labels.fill(0);
    let K = 0;
    for (let s = 0; s < nn; s++) {
      if (!hollow[s] || labels[s]) continue;
      K++;
      let top = 0, deep = 0, net = 0;
      stack[top++] = s; labels[s] = K;
      while (top) {
        const i = stack[--top], x = i % S;
        if (depth[i] > deep) deep = depth[i];
        net += lake[i];
        if (x + 1 < S && hollow[i + 1] && !labels[i + 1]) { labels[i + 1] = K; stack[top++] = i + 1; }
        if (x > 0 && hollow[i - 1] && !labels[i - 1]) { labels[i - 1] = K; stack[top++] = i - 1; }
        if (i + S < nn && hollow[i + S] && !labels[i + S]) { labels[i + S] = K; stack[top++] = i + S; }
        if (i >= S && hollow[i - S] && !labels[i - S]) { labels[i - S] = K; stack[top++] = i - S; }
      }
      this.deepest[K] = deep; this.sum[K] = net;
    }
    this.K = K;
    this.touching.fill(0, 0, K + 1); this.tIndex.fill(-1, 0, K + 1);
    // a cell on an edge touches the block across it where the cell across is hollow
    const across = (X: number, Y: number) => { const id = bg.id(face, X, Y); return id >= 0 && this.hollowAt(id); };
    for (let j = 0; j < S; j++) {
      const ws = labels[j * S], es = labels[j * S + S - 1], ss = labels[j], ns = labels[(S - 1) * S + j];
      if (ws && across(X0 - 1, Y0 + j)) this.touching[ws] = 1;
      if (es && across(X0 + S, Y0 + j)) this.touching[es] = 1;
      if (ss && across(X0 + j, Y0 - 1)) this.touching[ss] = 1;
      if (ns && across(X0 + j, Y0 + S)) this.touching[ns] = 1;
    }
    let nT = 0;
    const side = [(j: number) => j * S, (j: number) => j * S + S - 1, (j: number) => j, (j: number) => (S - 1) * S + j];
    for (let s = 0; s < 4; s++) {
      for (let j = 0; j < S; j++) {
        const l = labels[side[s](j)];
        if (l && this.touching[l] && this.tIndex[l] < 0) this.tIndex[l] = nT++;
        this.edges[s * S + j] = l && this.touching[l] ? b * 4 * S + this.tIndex[l] : -1;
      }
    }
    this.nT = nT;
  }
  // The discharge of the four seasons at a cell outside the block, one number (exact: under 2^53).
  qAt(o: number): number { let v = 0; for (let m = 0; m < SEASONS; m++) v += this.qlo[m].at(o) + this.qhi[m].at(o) * 4294967296; return v; }
  // The block's receivers and the four seasons' discharge at each of its cells, for the inflow pass.
  loadFlow(b: number) {
    const { S, bg } = this, { face, X0, Y0 } = bg.at(b), fn = bg.fn;
    this.to.window(face, X0, Y0, S, fn, this.toBlock);
    this.qsum.fill(0);
    for (let m = 0; m < SEASONS; m++) {
      this.qlo[m].window(face, X0, Y0, S, fn, this.winLo); this.qhi[m].window(face, X0, Y0, S, fn, this.winHi);
      for (let k = 0; k < S * S; k++) this.qsum[k] += this.winLo[k] + this.winHi[k] * 4294967296;
    }
  }
}

// The label (a joined component's id, -1 where none) the edge arrays hold for a cell on a block's edge: `edges` has the four sides of each block (west, east, south, north) of 4S entries.
function edgeOf(bg: BlockGrid, edges: Int32Array, id: number): number {
  const { b, lx, ly } = bg.locate(id), S = bg.S, o = b * 4 * S;
  return lx === 0 ? edges[o + ly] : lx === S - 1 ? edges[o + S + ly] : ly === 0 ? edges[o + 2 * S + lx] : edges[o + 3 * S + lx];
}

// The edges of every block (the labels of the touching components along them) and the table of each joined component, from the label pass's files.
function merge(B: Basin, a: (b: number) => string): { joined: Joined; edges: Int32Array; components: number; touching: number } {
  const bg = B.bg, S = bg.S, joined = new Joined(bg), edges = new Int32Array(bg.count * 4 * S);
  let components = 0, touching = 0;
  for (let b = 0; b < bg.count; b++) {
    const r = readF64(a(b)), nT = r[0];
    components += r[1]; touching += nT;
    for (let t = 0; t < nT; t++) { const g = b * 4 * S + t; joined.exists[g] = 1; joined.deepest[g] = r[2 + t]; joined.net[g] = r[2 + nT + t]; }
    for (let i = 0; i < 4 * S; i++) edges[b * 4 * S + i] = r[2 + 2 * nT + i];
  }
  for (let b = 0; b < bg.count; b++) {
    const { face, X0, Y0 } = bg.at(b), o = b * 4 * S;
    for (let j = 0; j < S; j++) {
      const outward: [number, number, number][] = [[0, X0 - 1, Y0 + j], [1, X0 + S, Y0 + j], [2, X0 + j, Y0 - 1], [3, X0 + j, Y0 + S]];
      for (const [s, X, Y] of outward) {
        const g = edges[o + s * S + j];
        if (g < 0) continue;
        const id = bg.id(face, X, Y);
        if (id < 0) continue;
        const g2 = edgeOf(bg, edges, id);
        if (g2 >= 0) joined.union(g, g2);
      }
    }
  }
  const root = new Float64Array(bg.count * 4 * S).fill(-Infinity), sum = new Float64Array(bg.count * 4 * S);
  for (let g = 0; g < joined.exists.length; g++) {
    if (!joined.exists[g]) continue;
    const r = joined.find(g);
    root[r] = Math.max(root[r], joined.deepest[g]); sum[r] += joined.net[g];
  }
  for (let g = 0; g < joined.exists.length; g++) if (joined.exists[g] && joined.find(g) === g) { joined.deepest[g] = root[g]; joined.net[g] = sum[g]; }
  return { joined, edges, components, touching };
}

// Make `t<tier>-basin.u8` within `budgetS` seconds (a block is the unit; a call always makes at least one). `stems` are the discharges of the four seasons (`<stem>-lo.u32`, `<stem>-hi.u16`).
export async function basinStream(dir: BakeDir, tier: number, budgetS = Infinity, log: (s: string) => void = () => {}, opts: BasinOptions = {}): Promise<BasinProgress> {
  const open = new Planes();
  try { return await streamed(open, dir, tier, budgetS, log, opts); } finally { open.close(); }
}
async function streamed(open: Planes, dir: BakeDir, tier: number, budgetS: number, log: (s: string) => void, opts: BasinOptions): Promise<BasinProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, file = `t${tier}-basin.u8`;
  const bg0 = new BlockGrid(tier, opts.block ?? 4), N = FACES * bg0.cells;
  const prog: BasinProgress = { done: true, stage: "done", blocks: bg0.count, blocksDone: bg0.count, seconds: 0, blockS: { label: [], inflow: [], write: [] }, mergeS: 0, lakes: 0, dry: 0, components: 0, touching: 0 };
  if (dir.has(file)) return { ...prog, seconds: spent() };
  const stems = opts.stems ?? [0, 1, 2, 3].map((s) => `t${tier}-q${s}`);
  const work = opts.work ?? dir.path(`basin-stream-t${tier}.work`);
  mkdirSync(work, { recursive: true });
  const metaPath = join(work, "meta.json"), meta = JSON.stringify({ tier, block: bg0.block, stems });
  // a run that begins leaves no earlier run's lakes in the output: the passes only ever write 1s
  if (existsSync(metaPath)) { if (readFileSync(metaPath, "utf8") !== meta) throw new Error(`basin-stream: ${work} holds a run of another block size: remove it`); } else { writeFileSync(metaPath, meta); rmSync(`${dir.path(file)}.part`, { force: true }); }
  const B = new Basin(dir, tier, bg0.block, stems, open), bg = B.bg, S = bg.S;
  const order = Array.from({ length: bg.count }, (_, b) => (opts.reverse ? bg.count - 1 - b : b));
  const la = (b: number) => join(work, `la-${b}.f64`), inf = (b: number) => join(work, `in-${b}.f64`), wr = (b: number) => join(work, `wr-${b}.done`), part = `${dir.path(file)}.part`;
  let worst = 0;
  const room = () => spent() + worst * 1.3 <= budgetS;
  const finish = (stage: BasinProgress["stage"], blocksDone: number): BasinProgress => ({ ...prog, done: stage === "done", stage, blocksDone, seconds: spent() });

  // ---- label ----
  for (const b of order.filter((x) => !existsSync(la(x)))) {
    if (prog.blockS.label.length && !room()) break;
    const s0 = performance.now();
    B.analyse(b);
    const nT = B.nT, rec = new Float64Array(2 + 2 * nT + 4 * S);
    rec[0] = nT; rec[1] = B.K;
    for (let l = 1; l <= B.K; l++) if (B.tIndex[l] >= 0) { rec[2 + B.tIndex[l]] = B.deepest[l]; rec[2 + nT + B.tIndex[l]] = B.sum[l]; }
    for (let i = 0; i < 4 * S; i++) rec[2 + 2 * nT + i] = B.edges[i];
    writeAtomic(la(b), rec);
    const dt = (performance.now() - s0) / 1000; worst = Math.max(worst, dt); prog.blockS.label.push(dt);
  }
  const done1 = order.filter((b) => existsSync(la(b))).length;
  if (done1 < bg.count) return finish("label", done1);

  const m0 = performance.now(), { joined, edges, components, touching } = merge(B, la);
  prog.components = components; prog.touching = touching;
  prog.mergeS = (performance.now() - m0) / 1000;
  const fresh = !existsSync(part);
  const fd = openSync(part, fresh ? "w+" : "r+");
  try {
    if (fresh) ftruncateSync(fd, N);
    const out = new Uint8Array(S * S);
    const writeRows = (b: number, buf: Uint8Array) => { const { face, X0, Y0 } = bg.at(b); for (let y = 0; y < S; y++) writeSync(fd, buf, y * S, S, ((face * bg.fn + Y0 + y) * bg.fn + X0)); };
    const readRows = (b: number, buf: Uint8Array) => { const { face, X0, Y0 } = bg.at(b); for (let y = 0; y < S; y++) readSync(fd, buf, y * S, S, ((face * bg.fn + Y0 + y) * bg.fn + X0)); };

    // ---- inflow ----
    for (const b of order.filter((x) => !existsSync(inf(x)))) {
      if (prog.blockS.inflow.length && !room()) break;
      const s0 = performance.now();
      B.analyse(b);
      const { face, X0, Y0 } = bg.at(b), fn = bg.fn, K = B.K, nT = B.nT, labels = B.labels, inflow = new Float64Array(K + 1), need = new Uint8Array(K + 1);
      for (let l = 1; l <= K; l++) need[l] = B.touching[l] || B.deepest[l] > WATER_TABLE_UNITS ? 1 : 0;
      const keyOf = (l: number) => (B.touching[l] ? joined.find(b * 4 * S + B.tIndex[l]) : -l);
      const keys = new Float64Array(K + 1);
      for (let l = 1; l <= K; l++) if (need[l]) keys[l] = keyOf(l);
      if (need.some((v) => v)) B.loadFlow(b);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const l = labels[y * S + x];
          if (!l || !need[l]) continue;
          const c = (face * fn + Y0 + y) * fn + X0 + x;
          for (const [dx, dy] of AROUND) {
            const nx = x + dx, ny = y + dy, inBlock = nx >= 0 && nx < S && ny >= 0 && ny < S, o = inBlock ? c + dy * fn + dx : bg.id(face, X0 + nx, Y0 + ny);
            if (o < 0 || (inBlock ? B.toBlock[ny * S + nx] : B.to.at(o)) !== c) continue;
            let member = false;
            if (inBlock) { const lo = labels[ny * S + nx]; member = lo > 0 && (lo === l || (B.touching[l] === 1 && B.touching[lo] === 1 && keys[lo] === keys[l])); } else if (B.touching[l] && B.hollowAt(o)) {
              const g = edgeOf(bg, edges, o);
              member = g >= 0 && joined.find(g) === keys[l];
            }
            if (!member) inflow[l] += inBlock ? B.qsum[ny * S + nx] : B.qAt(o);
          }
        }
      }
      // a whole component is decided here (every sum an integer under 2^53), a touching one's inflow goes to the host
      let lakes = 0, dry = 0, any = false;
      const rec = new Float64Array(3 + nT), lakeOf = new Uint8Array(K + 1);
      for (let l = 1; l <= K; l++) {
        if (B.touching[l]) { rec[3 + B.tIndex[l]] = inflow[l]; continue; }
        if (B.deepest[l] <= WATER_TABLE_UNITS) continue;
        if (B.sum[l] + inflow[l] >= 0) { lakeOf[l] = 1; lakes++; any = true; } else dry++;
      }
      rec[0] = lakes; rec[1] = dry; rec[2] = nT;
      if (any) { for (let k = 0; k < S * S; k++) out[k] = lakeOf[labels[k]]; writeRows(b, out); }
      writeAtomic(inf(b), rec);
      const dt = (performance.now() - s0) / 1000; worst = Math.max(worst, dt); prog.blockS.inflow.push(dt);
    }
    const done2 = order.filter((b) => existsSync(inf(b))).length;
    if (done2 < bg.count) return finish("inflow", done2);

    // ---- the decisions of the joined components, and the statistics ----
    for (let b = 0; b < bg.count; b++) {
      const r = readF64(inf(b)), nT = r[2];
      prog.lakes += r[0]; prog.dry += r[1];
      for (let t = 0; t < nT; t++) joined.inflow[joined.find(b * 4 * S + t)] += r[3 + t];
    }
    const isLake = new Uint8Array(joined.exists.length);
    for (let g = 0; g < joined.exists.length; g++) {
      if (!joined.exists[g] || joined.find(g) !== g || joined.deepest[g] <= WATER_TABLE_UNITS) continue;
      if (joined.net[g] + joined.inflow[g] >= 0) { isLake[g] = 1; prog.lakes++; } else prog.dry++;
    }

    // ---- write ----
    const wanted = order.filter((b) => {
      const nT = readF64(la(b))[0];
      for (let t = 0; t < nT; t++) if (isLake[joined.find(b * 4 * S + t)]) return true;
      return false;
    });
    for (const b of wanted.filter((x) => !existsSync(wr(x)))) {
      if (prog.blockS.write.length && !room()) break;
      const s0 = performance.now();
      B.analyse(b);
      readRows(b, out);
      for (let k = 0; k < S * S; k++) { const l = B.labels[k]; if (l && B.touching[l] && isLake[joined.find(b * 4 * S + B.tIndex[l])]) out[k] = 1; }
      writeRows(b, out);
      writeFileSync(wr(b), "");
      const dt = (performance.now() - s0) / 1000; worst = Math.max(worst, dt); prog.blockS.write.push(dt);
    }
    const done3 = wanted.filter((b) => existsSync(wr(b))).length;
    if (done3 < wanted.length) return finish("write", done3);
  } finally { closeSync(fd); }
  renameSync(part, dir.path(file));
  rmSync(work, { recursive: true, force: true });
  log(`basin-stream: ${prog.lakes} lakes, ${prog.dry} dry hollows`);
  return finish("done", bg.count);
}
