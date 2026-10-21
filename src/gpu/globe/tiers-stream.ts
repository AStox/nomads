// A tier of the regional chain (tiers.ts, regional.ts) solved out of core: the planes of the tier (the heights, the flooded surface, the discharge area, the receivers' directions) are
// kept on disk tile-major (tilestore.ts) and each stage of a step visits the tier a block of tiles at a time, on a patch (patch.ts) run through the very kernels of the in-memory
// solve (regional-patch.ts, wgsl/globe-regional.ts with a patch layout). The bytes are the in-memory solve's, word for word, whichever the block and whichever the order of the visits:
//
//   init      the flooded surface at its start (sea at its height, land at infinity), the land cells of each tier-0 cell counted;
//   flood     f = max(h, least neighbour f + eps) is a monotone map with one fixed point reached from above: each block is run to its own fixed point with the halo as it stands, and a block
//             whose edge cells changed puts its neighbours back on the list, until the list is empty (few visits instead of the ~1,000 rounds of the global solve);
//   recv      each cell's steepest-descent receiver on the settled surface (kept as a direction), and which cells the incision leaves alone whatever their receiver does;
//   area      the discharge area is a sum, so order does not matter: each block sums its own cells with the blocks' edges as roots (area1); the cells that drain out of a block into another
//             (a few hundred thousand on the whole planet) form a forest across blocks that is summed on the host in exact integers (skel); each block then sums again with what flows in
//             from beyond its edge added at the cell it flows into (area2);
//   incise    h'(k) = F_k(h'(receiver)) along each flow path: a cell is incised when its receiver's final height is known, which each block settles for every cell whose chain reaches a settled
//             cell, in the order of the depth in the block; a block with cells whose chain leaves by an unsettled cell waits for its neighbours and is visited again (blocks in the order of
//             the lowest flooded surface, so a river is mostly settled in one visit of each block it crosses);
//   slide     the greatest surface under the heights with no fall steeper than the threshold is a monotone fixed point too: the same visits as the flood;
//   creep     Jacobi substeps: one pass over the blocks from one plane to the other each, the planes then trade places;
//   lift      the loss of each tier-0 cell (kept on the device across the blocks) and the three passes of the uplift, between which the tier-0 tables are made.
//
// What is resident is a patch's buffers (side 1,026 for blocks of 4 by 4 tiles: 15 words a cell, 65 MB), the tier-0 tables (8 MB), the tile cache (a byte budget) and the skeleton of
// the area (about 100 bytes for each cell that drains out of a block).
import { constants, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Gpu } from "../device";
import { TILE, tierGrid, type Grid } from "./grid";
import { cellAcross, patchAt, type Patch } from "./patch";
import { CORNER_BESIDE, around3, child4, creepSubsOf } from "./regional";
import { RegionalPatch, TREE, PATCH_HALO } from "./regional-patch";
import { tierTable } from "./regional";
import { TileStore } from "./tilestore";
import type { BakeDir } from "./bakedir";
import { TIER_STEPS, tierParams, tierParent, type TierRun } from "./tiers";
import type { Planet } from "./window";

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;
const NP = 6 * 256 * 256;
const NONE_DIR = 255;
const INF = 0x7fffffff;

// ---------- the carry to the next tier, a block at a time ----------
// refineSmooth (regional.ts) for the children of the block of cells `p.interior` square at tier `from`, with p's halo wide enough (the passes reach `passes + 1` cells): the same stencil
// (child4) on the same neighbours (around3, the corner's missing cell the mean of the two beside it) and the same sums in the same order, so the values are the in-memory function's.
// Returns the children as an interior * 2 square, row by row.
export function refineBlock(parent: ArrayLike<number>, from: number, p: Patch, passes = 4): Int32Array {
  const S = p.side, gp = tierGrid(from), n = gp.fn, cells = n * n, nc = S * S, ids9 = new Int32Array(9), q = new Float64Array(4), v = new Float64Array(9);
  const across = new Map<number, number>();
  for (let k = 0; k < nc; k++) if (!p.missing[k] && Math.floor(p.ids[k] / cells) !== p.face) across.set(p.ids[k], k);
  const X0 = p.x0 - p.halo, Y0 = p.y0 - p.halo;
  const locate = (id: number) => {
    const f = Math.floor(id / cells);
    if (f !== p.face) return across.get(id) ?? -2;
    const r = id - f * cells, Y = Math.floor(r / n), x = r - Y * n - X0, y = Y - Y0;
    return x >= 0 && y >= 0 && x < S && y < S ? y * S + x : -2;
  };
  const nb = new Int32Array(nc * 9).fill(-2), val = new Float64Array(nc).fill(NaN);
  for (let k = 0; k < nc; k++) {
    if (p.missing[k]) continue;
    const id = p.ids[k], f = Math.floor(id / cells), r = id - f * cells, Y = Math.floor(r / n), X = r - Y * n;
    val[k] = parent[id];
    around3(gp, f, X, Y, ids9);
    for (let c = 0; c < 9; c++) nb[k * 9 + c] = ids9[c] < 0 ? -1 : locate(ids9[c]);
  }
  const children = (src: Float64Array, out: Float64Array) => {
    for (let k = 0; k < nc; k++) {
      let ok = !p.missing[k];
      for (let c = 0; c < 9 && ok; c++) if (nb[k * 9 + c] === -2) ok = false;
      if (!ok) { out[4 * k] = out[4 * k + 1] = out[4 * k + 2] = out[4 * k + 3] = NaN; continue; }
      for (let c = 0; c < 9; c++) if (nb[k * 9 + c] >= 0) v[c] = src[nb[k * 9 + c]];
      for (const [c, a, b] of CORNER_BESIDE) if (nb[k * 9 + c] < 0) v[c] = (v[a] + v[b]) / 2;
      child4(v[4], v[3], v[5], v[1], v[7], v[0], v[2], v[6], v[8], q);
      out[4 * k] = q[0]; out[4 * k + 1] = q[1]; out[4 * k + 2] = q[2]; out[4 * k + 3] = q[3];
    }
  };
  const c = new Float64Array(4 * nc);
  children(val, c);
  if (passes > 0) {
    const r = new Float64Array(nc), corr = new Float64Array(4 * nc);
    for (let pass = 0; pass < passes; pass++) {
      for (let k = 0; k < nc; k++) r[k] = val[k] - (c[4 * k] + c[4 * k + 1] + c[4 * k + 2] + c[4 * k + 3]) / 4;
      children(r, corr);
      for (let i = 0; i < c.length; i++) c[i] += corr[i];
    }
  }
  const ic = 2 * p.interior, out = new Int32Array(ic * ic);
  for (let y = 0; y < p.interior; y++)
    for (let x = 0; x < p.interior; x++) {
      const k = (y + p.halo) * S + x + p.halo, o = 2 * y * ic + 2 * x;
      const w = [Math.round(c[4 * k]), Math.round(c[4 * k + 1]), Math.round(c[4 * k + 2]), Math.round(c[4 * k + 3])];
      if (!(w[0] === w[0] && w[1] === w[1] && w[2] === w[2] && w[3] === w[3])) throw new Error("refineBlock: the halo is too narrow for the passes");
      const d = Math.round(val[k] * 4) - (w[0] + w[1] + w[2] + w[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
      out[o] = w[0] + base4 + (0 < rem ? 1 : 0); out[o + 1] = w[1] + base4 + (1 < rem ? 1 : 0); out[o + ic] = w[2] + base4 + (2 < rem ? 1 : 0); out[o + ic + 1] = w[3] + base4 + (3 < rem ? 1 : 0);
    }
  return out;
}
const REFINE_PASSES = 4;
const REFINE_HALO = REFINE_PASSES + 2;

// ---------- the solve ----------
type Stage = "start" | "idle" | "init" | "flood" | "recv" | "area1" | "skel" | "area2" | "incise" | "slide" | "creep" | "lift1" | "lift2" | "lift3";
export interface StreamOptions {
  block?: number; // tiles to a side of a block (a patch's interior is block * 256 cells)
  order?: "forward" | "reverse" | number; // the order the blocks are visited in (a number: a shuffle with that seed): the bytes do not depend on it
  cacheBytes?: number;
}
interface Progress {
  tier: number; block: number; steps: number; stage: Stage; job: "idle" | "step" | "flow"; sub: number; running: boolean;
  todo: number[]; sea: number[]; pending: number[]; minF: number[];
  visits: Record<string, number>; seconds: Record<string, number>; stepS: number[]; stepVisits: Record<string, number>[]; curS: number;
  calls: number; callS: number[]; exportTo: boolean;
}
interface Ring { halo: Int32Array; hid: Int32Array; hreg: Int32Array; adj: Int32Array; inner: Int32Array; across: Map<number, number> }

export class StreamedTier {
  readonly T: number;
  readonly R: number;
  readonly size: number;
  readonly nreg: number;
  readonly fn: number;
  readonly store: TileStore;
  readonly solver: RegionalPatch;
  readonly subs: number;
  prog: Progress;
  private readonly g: Grid;
  private readonly rings = new Map<number, Ring>();
  private perm: Int32Array;
  private la = new Map<number, number>();
  private par = new Map<number, number>();
  private total = new Map<number, number>();
  private parent: { field: ArrayLike<number>; from: number } | null = null;
  readonly log: (s: string) => void;
  worst: Record<string, number> = {};
  private ok = true;
  peakRss = 0; // the process's resident bytes, the most seen between visits

  constructor(readonly gpu: Gpu, readonly tier: number, readonly dir: string, table: Uint32Array, o: StreamOptions = {}, log: (s: string) => void = () => {}) {
    this.log = log;
    this.T = 1 << tier;
    const block = Math.min(o.block ?? 4, this.T);
    if (this.T % block) throw new Error(`tiers-stream: ${block} tiles do not divide a tier ${tier} face's ${this.T}`);
    this.R = this.T / block;
    this.size = block * TILE;
    this.nreg = 6 * this.R * this.R;
    this.g = tierGrid(tier);
    this.fn = this.g.fn;
    this.store = new TileStore(dir, tier, { H: "i32", F: "i32", ACC: "i32", TOD: "u8", RES: "u8", TO: "i32" }, o.cacheBytes);
    this.subs = creepSubsOf(table);
    this.solver = new RegionalPatch(gpu, tier, this.size, table, this.subs);
    const ord = Array.from({ length: this.nreg }, (_, i) => i);
    if (o.order === "reverse") ord.reverse();
    else if (typeof o.order === "number") {
      let s = (o.order >>> 0) || 1;
      for (let i = ord.length - 1; i > 0; i--) { s = Math.imul(s, 1664525) + 1013904223 >>> 0; const j = s % (i + 1); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    }
    this.perm = Int32Array.from(ord);
    const kept = this.path("progress.json");
    this.prog = existsSync(kept) ? (JSON.parse(readFileSync(kept, "utf8")) as Progress) : this.fresh();
    if (this.prog.block !== block) throw new Error(`tiers-stream: the work in ${dir} was begun with blocks of ${this.prog.block} tiles, not ${block}`);
  }
  private path(f: string) { return join(this.dir, f); }
  private fresh(): Progress {
    return { tier: this.tier, block: this.size / TILE, steps: 0, stage: "start", job: "idle", sub: 0, running: false, todo: new Array(this.nreg).fill(1), sea: new Array(this.nreg).fill(0), pending: new Array(this.nreg).fill(-1), minF: new Array(this.nreg).fill(INF),
      visits: {}, seconds: {}, stepS: [], stepVisits: [], curS: 0, calls: 0, callS: [], exportTo: false };
  }
  get started() { return existsSync(this.path("progress.json")); }
  get stepsMade() { return this.prog.steps; }

  // ---- state kept between calls ----
  // Resume: the tier-0 tables, the skeleton, and a step interrupted in the middle of a visit is begun again from the heights it started from.
  async open() {
    if (existsSync(this.path("parents.i32"))) this.solver.writeParents(new Int32Array(readFileSync(this.path("parents.i32")).buffer.slice(0)));
    if (existsSync(this.path("skeleton.f64"))) this.loadSkeleton();
    if (this.prog.running && this.prog.job === "step") {
      this.log(`the last call stopped inside a step: the step begins again from its saved heights`);
      this.store.close();
      copyFileSync(this.path("H.bak"), this.store.path("H"));
      this.solver.writeParents(this.carryOnly(new Int32Array(readFileSync(this.path("carry.bak.i32")).buffer.slice(0))));
      this.prog.job = "idle"; this.prog.stage = "idle";
    }
    if (this.prog.running && this.prog.job === "flow") { this.prog.job = "idle"; this.prog.stage = "idle"; this.prog.exportTo = false; }
    this.prog.running = false;
  }
  private carryOnly(carry: Int32Array) { const w = new Int32Array(5 * NP); w.set(carry, 2 * NP); return w; }
  async save() {
    this.prog.running = false;
    writeFileSync(this.path("parents.i32"), new Uint8Array((await this.solver.readParents()).buffer));
    this.saveSkeleton();
    writeFileSync(this.path("progress.json"), JSON.stringify(this.prog));
  }
  private saveSkeleton() {
    const ids = [...this.la.keys()], f = new Float64Array(ids.length * 4);
    ids.forEach((id, i) => { f[4 * i] = id; f[4 * i + 1] = this.la.get(id) ?? 0; f[4 * i + 2] = this.par.get(id) ?? -2; f[4 * i + 3] = this.total.get(id) ?? -1; });
    writeFileSync(this.path("skeleton.f64"), new Uint8Array(f.buffer));
  }
  private loadSkeleton() {
    const b = readFileSync(this.path("skeleton.f64")), f = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    this.la.clear(); this.par.clear(); this.total.clear();
    for (let i = 0; i < f.length; i += 4) { this.la.set(f[i], f[i + 1]); if (f[i + 2] !== -2) this.par.set(f[i], f[i + 2]); if (f[i + 3] >= 0) this.total.set(f[i], f[i + 3]); }
  }
  release() { this.solver.release(); this.store.close(); }

  // ---- the blocks ----
  private regionAt(r: number) { const per = this.R * this.R, face = Math.floor(r / per), q = r - face * per, ry = Math.floor(q / this.R); return { face, rx: q - ry * this.R, ry }; }
  private regionOfId(id: number) {
    const cells = this.fn * this.fn, f = Math.floor(id / cells), q = id - f * cells, Y = Math.floor(q / this.fn), X = q - Y * this.fn;
    return (f * this.R + Math.floor(Y / this.size)) * this.R + Math.floor(X / this.size);
  }
  private patch(r: number, halo = PATCH_HALO): Patch { const { face, rx, ry } = this.regionAt(r); return patchAt(this.tier, face, rx * this.size, ry * this.size, halo, this.size); }
  // The cells of a patch's outer ring and of the interior's outer ring, and which block each ring cell is in.
  private ring(r: number, p: Patch): Ring {
    let g = this.rings.get(r);
    if (g) return g;
    const S = p.side, halo: number[] = [], inner: number[] = [], across = new Map<number, number>();
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const k = y * S + x;
        if (x === 0 || y === 0 || x === S - 1 || y === S - 1) { if (!p.missing[k]) { halo.push(k); if (Math.floor(p.ids[k] / (this.fn * this.fn)) !== p.face) across.set(p.ids[k], k); } }
        else if (x === 1 || y === 1 || x === S - 2 || y === S - 2) inner.push(k);
      }
    const H = Int32Array.from(halo);
    g = {
      halo: H, hid: H.map((k) => p.ids[k]), hreg: H.map((k) => this.regionOfId(p.ids[k])),
      adj: H.map((k) => { const x = Math.min(S - 2, Math.max(1, k % S)), y = Math.min(S - 2, Math.max(1, Math.floor(k / S))); return y * S + x; }), inner: Int32Array.from(inner), across,
    };
    this.rings.set(r, g);
    return g;
  }
  private localOf(p: Patch, ring: Ring, id: number): number {
    const cells = this.fn * this.fn, f = Math.floor(id / cells);
    if (f !== p.face) return ring.across.get(id) ?? -1;
    const q = id - f * cells, Y = Math.floor(q / this.fn), x = q - Y * this.fn - (p.x0 - p.halo), y = Y - (p.y0 - p.halo);
    return x >= 0 && y >= 0 && x < p.side && y < p.side ? y * p.side + x : -1;
  }
  private isInterior(p: Patch, k: number) { const x = k % p.side, y = Math.floor(k / p.side); return x >= p.halo && x < p.side - p.halo && y >= p.halo && y < p.side - p.halo; }
  // Blocks whose halo cells lie next to an interior cell that `differs` go on the list.
  private mark(r: number, ring: Ring, differs: (interiorCell: number) => boolean) {
    const todo = this.prog.todo;
    for (let e = 0; e < ring.halo.length; e++) { const q = ring.hreg[e]; if (q !== r && !todo[q] && differs(ring.adj[e])) todo[q] = 1; }
  }
  // For each halo cell whose receiver is an interior cell of the patch: the halo cell's id, and the interior cell (the receiver's direction is in the halo cell's own face's axes).
  private inflows(p: Patch, ring: Ring, tod: ArrayLike<number>, each: (hid: number, into: number) => void) {
    const n = this.fn, cells = n * n;
    for (let e = 0; e < ring.halo.length; e++) {
      const d = tod[ring.halo[e]];
      if (d >= 4) continue;
      const id = ring.hid[e], f = Math.floor(id / cells), q = id - f * cells, Y = Math.floor(q / n), X = q - Y * n;
      const rid = cellAcross(this.g, f, X + DIRS[d][0], Y + DIRS[d][1]);
      if (rid < 0) continue;
      const into = this.localOf(p, ring, rid);
      if (into >= 0 && this.isInterior(p, into)) each(id, into);
    }
  }

  // ---- the visits ----
  private async visit(r: number) {
    const st = this.prog.stage, t0 = performance.now();
    switch (st) {
      case "start": this.visitStart(r); break;
      case "init": await this.visitInit(r); break;
      case "flood": await this.visitFixed(r, "flood"); break;
      case "slide": await this.visitFixed(r, "slide"); break;
      case "recv": await this.visitRecv(r); break;
      case "area1": await this.visitArea(r, false); break;
      case "area2": await this.visitArea(r, true); break;
      case "incise": await this.visitIncise(r); break;
      case "creep": await this.visitCreep(r); break;
      case "lift1": case "lift2": await this.visitLift(r, "lift"); break;
      case "lift3": await this.visitLift(r, "spread"); break;
      default: throw new Error(`tiers-stream: no visit for stage ${st}`);
    }
    const s = (performance.now() - t0) / 1000;
    this.prog.visits[st] = (this.prog.visits[st] ?? 0) + 1;
    this.prog.seconds[st] = (this.prog.seconds[st] ?? 0) + s;
    this.worst[st] = Math.max(this.worst[st] ?? 0, s);
    this.peakRss = Math.max(this.peakRss, process.memoryUsage.rss());
  }
  private visitStart(r: number) {
    const { face, rx, ry } = this.regionAt(r), ipar = this.size / 2;
    if (!this.parent) throw new Error("tiers-stream: no parent heights given for the start");
    const pp = patchAt(this.parent.from, face, rx * ipar, ry * ipar, REFINE_HALO, ipar), cp = patchAt(this.tier, face, rx * this.size, ry * this.size, 0, this.size);
    this.store.scatter("H", cp, refineBlock(this.parent.field, this.parent.from, pp, REFINE_PASSES));
  }
  private async visitInit(r: number) {
    const p = this.patch(r), H = this.store.gather("H", p, undefined, false) as Int32Array, s = this.solver;
    s.setPatch(p); s.write("H", H);
    s.go(["flinit", "tallyc"]);
    this.store.scatter("F", p, await s.readFlood());
    let sea = 0;
    for (let y = 1; y < p.side - 1 && !sea; y++) for (let x = 1; x < p.side - 1; x++) if (H[y * p.side + x] <= 0) { sea = 1; break; }
    this.prog.sea[r] = sea;
  }
  // The flood and the landslides: the block run to its own fixed point with the halo as it stands.
  private async visitFixed(r: number, law: "flood" | "slide") {
    const p = this.patch(r), ring = this.ring(r, p), s = this.solver, H = this.store.gather("H", p) as Int32Array;
    s.setPatch(p); s.write("H", H);
    let before: Int32Array;
    if (law === "flood") { before = this.store.gather("F", p) as Int32Array; s.writeFlood(before); } else { before = H; s.go(["cellmeans", "erzero"]); }
    let rounds = 0, chunk = 32;
    for (;;) {
      s.clearCounter("changed");
      s.go([[law, chunk]]);
      rounds += chunk;
      if ((await s.counter("changed")) === 0) break;
      chunk = 64;
      if (rounds > 40000) throw new Error(`tiers-stream: the ${law} did not settle in 40,000 rounds in block ${r}`);
    }
    if (law === "slide") s.go(["tallyl"]);
    const after = law === "flood" ? await s.readFlood() : await s.read("H");
    const S = p.side;
    let changed = false;
    for (let y = 1; y < S - 1 && !changed; y++) for (let x = 1; x < S - 1; x++) if (after[y * S + x] !== before[y * S + x]) { changed = true; break; }
    if (changed) { this.store.scatter(law === "flood" ? "F" : "H", p, after); this.mark(r, ring, (k) => after[k] !== before[k]); }
  }
  private async visitRecv(r: number) {
    const p = this.patch(r), s = this.solver, H = this.store.gather("H", p, undefined, false) as Int32Array, F = this.store.gather("F", p) as Int32Array;
    s.setPatch(p); s.write("H", H); s.writeFlood(F);
    s.go(["cellmeans", "recv", "todir", "resinit"]);
    const [db, w] = await Promise.all([s.read("DB"), s.read("W")]);
    this.store.scatter("TOD", p, Uint8Array.from(db));
    this.store.scatter("RES", p, Uint8Array.from(w));
    let low = INF;
    for (let y = 1; y < p.side - 1; y++) for (let x = 1; x < p.side - 1; x++) { const f = F[y * p.side + x]; if (f < low) low = f; }
    this.prog.minF[r] = low;
  }
  // The discharge area in the two passes (see the header): a block's patch tree with its halo as roots; area2 adds the discharge that flows in from the neighbours.
  private async visitArea(r: number, second: boolean) {
    const p = this.patch(r), ring = this.ring(r, p), s = this.solver, S = p.side;
    const H = this.store.gather("H", p, undefined, false) as Int32Array, tod = this.store.gather("TOD", p) as Uint8Array;
    s.setPatch(p); s.write("H", H); s.write("DB", Int32Array.from(tod));
    s.clearCounter("flags");
    const inject = new Int32Array(S * S);
    if (second) this.inflows(p, ring, tod, (id, into) => { const t = this.total.get(id); if (t === undefined) throw new Error(`tiers-stream: no discharge for cell ${id}, which flows into block ${r}`); inject[into] = (inject[into] + t) | 0; });
    if (second) s.write("DP", inject);
    s.go(["cellmeans", "weights", "todfrom", ...(second ? ["inject"] : []), ...TREE, "area"]);
    const flags = await s.counter("flags");
    if (flags & s.flags.area) throw new Error("tiers-stream: a basin's discharge area passed 32 bits");
    if (flags & (s.flags.chain | s.flags.depth)) throw new Error(`tiers-stream: the receivers' chains do not end at the sea in block ${r} (flags ${flags})`);
    const acc = await s.read("ACC");
    if (second) {
      this.store.scatter("ACC", p, acc);
      if (this.prog.exportTo) {
        const to = await s.read("TO"), ids = new Int32Array(S * S);
        for (let k = 0; k < ids.length; k++) ids[k] = p.ids[to[k]];
        this.store.scatter("TO", p, ids);
      }
      return;
    }
    // the cells that drain out of the block, with the sum of the cells that drain to them within it, and the cell of another block that drains in with the cell that carries its sum on
    const to = await s.read("TO"), ua = await s.read("UA"), exitOf = new Map<number, number>();
    for (const e of ring.inner) { const t = to[e]; if (t !== e && !this.isInterior(p, t)) { exitOf.set(t, e); this.la.set(p.ids[e], acc[e] >>> 0); } }
    this.inflows(p, ring, tod, (id, into) => {
      const root = ua[into];
      if (this.isInterior(p, root)) { this.par.set(id, -1); return; }
      const e = exitOf.get(root);
      if (e === undefined) throw new Error(`tiers-stream: a root outside block ${r} that no cell drains into`);
      this.par.set(id, p.ids[e]);
    });
  }
  // Each exit's total: its own block's sum of the cells upstream of it plus the totals of the exits that flow into those cells; the forest of exits solved from the leaves in exact integers.
  private solveSkeleton() {
    if (this.la.size !== this.par.size) throw new Error(`tiers-stream: ${this.la.size} cells drain out of a block but ${this.par.size} drain into one`);
    const left = new Map<number, number>(), sum = new Map<number, number>(this.la), ready: number[] = [];
    for (const id of this.la.keys()) left.set(id, 0);
    for (const [, p] of this.par) if (p >= 0) left.set(p, (left.get(p) ?? 0) + 1);
    for (const [id, n] of left) if (n === 0) ready.push(id);
    this.total = new Map();
    while (ready.length) {
      const id = ready.pop() as number, t = sum.get(id) as number;
      if (t > 0xffffffff) throw new Error("tiers-stream: a basin's discharge area passed 32 bits");
      this.total.set(id, t);
      const p = this.par.get(id) as number;
      if (p < 0) continue;
      sum.set(p, (sum.get(p) as number) + t);
      const n = (left.get(p) as number) - 1;
      left.set(p, n);
      if (n === 0) ready.push(p);
    }
    if (this.total.size !== this.la.size) throw new Error("tiers-stream: the exits' forest has a cycle");
  }
  private async visitIncise(r: number) {
    const p = this.patch(r), ring = this.ring(r, p), s = this.solver, S = p.side;
    const H = this.store.gather("H", p) as Int32Array, res = this.store.gather("RES", p) as Uint8Array;
    s.setPatch(p); s.write("H", H); s.write("W", Int32Array.from(res));
    s.write("DB", Int32Array.from(this.store.gather("TOD", p, undefined, false) as Uint8Array));
    s.write("ACC", this.store.gather("ACC", p, undefined, false) as Int32Array);
    s.writeFlood(this.store.gather("F", p, undefined, false) as Int32Array);
    s.clearCounter("flags"); s.clearCounter("pending");
    s.go(["cellmeans", "erzero", "todfrom", ...TREE, "incisep", "tallyl", "rescount"]);
    const flags = await s.counter("flags");
    if (flags & (s.flags.chain | s.flags.depth)) throw new Error(`tiers-stream: the receivers' chains do not end at the sea in block ${r} (flags ${flags})`);
    this.prog.pending[r] = await s.counter("pending");
    const [w, h] = await Promise.all([s.read("W"), s.read("H")]);
    let any = false;
    for (let y = 1; y < S - 1 && !any; y++) for (let x = 1; x < S - 1; x++) if ((w[y * S + x] !== 0 ? 1 : 0) !== res[y * S + x]) { any = true; break; }
    if (!any) return;
    this.store.scatter("H", p, h);
    this.store.scatter("RES", p, Uint8Array.from(w, (v) => (v !== 0 ? 1 : 0)));
    this.mark(r, ring, (k) => (w[k] !== 0 ? 1 : 0) !== res[k]);
  }
  private async visitCreep(r: number) {
    const p = this.patch(r), s = this.solver;
    s.setPatch(p); s.write("H", this.store.gather("H", p) as Int32Array);
    s.go(["cellmeans", "erzero", "creep", "creepapply", "tallyl"]);
    this.store.scatter("ACC", p, await s.read("H"));
  }
  private async visitLift(r: number, law: "lift" | "spread") {
    const p = this.patch(r), s = this.solver;
    s.setPatch(p); s.write("H", this.store.gather("H", p, undefined, false) as Int32Array);
    s.go([law]);
    this.store.scatter("H", p, await s.read("H"));
  }

  // ---- the order of a step ----
  private all() { this.prog.todo.fill(1); }
  private left() { return this.prog.todo.reduce((a, b) => a + b, 0); }
  // The next block on the list: in the order of the visits, or (the incision) the one with the lowest flooded surface, which settles a river's lower reaches first.
  private pick(): number {
    const todo = this.prog.todo;
    if (this.prog.stage === "incise") {
      let best = -1;
      for (let i = 0; i < this.nreg; i++) { const r = this.perm[i]; if (todo[r] && this.prog.pending[r] !== 0 && (best < 0 || this.prog.minF[r] < this.prog.minF[best])) best = r; }
      if (best < 0) for (let i = 0; i < this.nreg; i++) if (todo[i]) todo[i] = 0;
      return best;
    }
    for (let i = 0; i < this.nreg; i++) if (todo[this.perm[i]]) return this.perm[i];
    return -1;
  }
  private async advance(): Promise<boolean> {
    const pr = this.prog, s = this.solver, flow = pr.job === "flow";
    const go = (stage: Stage, todo?: number[]) => { pr.stage = stage; if (todo) pr.todo = todo.slice(); else this.all(); };
    switch (pr.stage) {
      case "start": pr.stage = "idle"; pr.job = "idle"; return true;
      case "init": go("flood", pr.sea); break;
      case "flood": go("recv"); break;
      case "recv": this.la.clear(); this.par.clear(); this.total.clear(); go("area1"); break;
      case "area1": pr.stage = "skel"; this.solveSkeleton(); go("area2"); break;
      case "area2":
        if (flow) { pr.stage = "idle"; pr.job = "idle"; return true; }
        pr.pending.fill(-1); go("incise"); break;
      case "incise": {
        const open = pr.pending.reduce((a, b) => a + Math.max(0, b), 0);
        if (open) throw new Error(`tiers-stream: ${open} cells' incision was never settled`);
        go("slide"); break;
      }
      case "slide": pr.sub = 0; go("creep"); break;
      case "creep":
        this.store.swap("H", "ACC");
        if (++pr.sub < this.subs) { this.all(); break; }
        s.go(["pmean"]); go("lift1"); break;
      case "lift1": s.go(["pres"]); go("lift2"); break;
      case "lift2": s.go(["pfin"]); go("lift3"); break;
      case "lift3": {
        s.go(["pcarry"]);
        pr.steps++; pr.stepS.push(pr.curS); pr.stepVisits.push(pr.visits); pr.curS = 0; pr.visits = {};
        pr.stage = "idle"; pr.job = "idle";
        return true;
      }
      default: throw new Error(`tiers-stream: cannot go on from stage ${pr.stage}`);
    }
    return false;
  }
  // A step (or the settled flow of the final heights) begun: the heights it starts from are kept, so that a call killed inside it can begin it again.
  private async begin(job: "step" | "flow") {
    const pr = this.prog;
    if (job === "step") {
      this.store.close();
      copyFileSync(this.store.path("H"), this.path("H.bak"), constants.COPYFILE_FICLONE);
      writeFileSync(this.path("carry.bak.i32"), new Uint8Array((await this.solver.readCarry()).buffer));
    }
    pr.job = job; pr.stage = "init"; pr.sub = 0; this.all();
    this.solver.go(["pzero"]);
  }
  // Work for up to `budgetS` seconds: the start (the heights carried from the tier above), `steps` steps in all, and with `finish` the settled flow of the final heights with its
  // planes kept (the receivers' global ids as TO, the area, the flooded surface). Returns when the work is done or the budget is spent: `done` says which.
  async work(budgetS: number, steps: number, finish: boolean, maxSteps = Infinity): Promise<{ done: boolean }> {
    const pr = this.prog, t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
    pr.running = true; pr.calls++;
    writeFileSync(this.path("progress.json"), JSON.stringify(pr)); // a call that dies leaves this mark, and the next begins the step again
    let madeNow = 0;
    this.ok = true;
    const worstOf = (st: Stage) => Math.max(this.worst[st] ?? 0, 0.05);
    try {
      for (;;) {
        if (pr.stage === "idle") {
          if (pr.steps < steps && madeNow < maxSteps) await this.begin("step");
          else if (pr.steps >= steps && finish && !pr.exportTo) { pr.exportTo = true; await this.begin("flow"); }
          else return { done: pr.steps >= steps && (!finish || pr.exportTo) };
        }
        const r = this.pick();
        if (r < 0) { const was = pr.stage; if (await this.advance() && was === "lift3") madeNow++; continue; }
        if (spent() + 1.5 * worstOf(pr.stage) > budgetS) return { done: false };
        const c0 = performance.now();
        await this.visit(r);
        if (pr.stage !== "start") pr.curS += (performance.now() - c0) / 1000;
        pr.todo[r] = 0;
      }
    } catch (e) {
      this.ok = false;
      throw e;
    } finally {
      if (this.ok) { pr.callS.push(spent()); await this.save(); }
    }
  }
  setParent(field: ArrayLike<number>, from: number) { this.parent = { field, from }; }
  // Heights given in cell order instead of carried from a tier above (a test's, or a tier made another way).
  setHeights(cells: Int32Array) { this.store.putCells("H", cells); this.prog.stage = "idle"; this.prog.job = "idle"; }
  // The heights of the tier (and of the settled flow when finished) as the tier's cells files.
  exportCells(plane: "H" | "F" | "ACC" | "TO", path: string) { this.store.toCells(plane, path); }
  removeWork() { this.release(); for (const f of ["H", "F", "ACC", "TOD", "RES", "TO"]) this.store.remove(f); for (const f of ["H.bak", "carry.bak.i32", "parents.i32", "skeleton.f64", "progress.json"]) rmSync(this.path(f), { force: true }); }
}

// ---------- the chain ----------

// One tier of the chain made out of core into the files the in-memory chain (tiers.ts) writes: `t<k>-height.i32` (and for the last tier `-to.u32`, `-acc.u32`, `-flooded.i32` and
// `-run.json`), from the tier above's `t<k-1>-height.i32` (tier 1 from the planet's heights) and the same table (tierTable). Resumable: a call stops at its budget with its work kept in
// `<dir>/stream-t<k>`; returns done when the tier's files are written.
export async function streamTier(gpu: Gpu, planet: Planet, dir: BakeDir, tier: number, last: number, budgetS: number, o: StreamOptions & { steps?: number[]; maxSteps?: number; work?: string } = {}, log: (s: string) => void = () => {}): Promise<{ done: boolean; steps: number; of: number; run?: TierRun }> {
  const steps = (o.steps ?? TIER_STEPS)[tier], t0 = performance.now(), spent = () => (performance.now() - t0) / 1000;
  const finished = dir.has(`t${tier}-height.i32`) && (tier < last || dir.has(`t${tier}-run.json`));
  if (finished) return { done: true, steps, of: steps, run: dir.json<TierRun>(`t${tier}-run`) ?? undefined };
  const table = tierTable(planet, tier, tierParams());
  const st = new StreamedTier(gpu, tier, o.work ?? dir.path(`stream-t${tier}`), table, o, log);
  try {
    if (st.prog.stage === "start") st.setParent(tierParent(planet, dir, tier), tier - 1);
    log(`tier ${tier}: blocks of ${st.size} cells, ${st.nreg} of them, table in ${spent().toFixed(1)} s, ${st.stepsMade} of ${steps} steps kept`);
    await st.open();
    const r = await st.work(Math.max(0, budgetS - spent() - 10), steps, tier === last, o.maxSteps);
    log(`tier ${tier}: ${st.stepsMade} of ${steps} steps, stage ${st.prog.stage}, ${spent().toFixed(0)} s this call, visits ${JSON.stringify(st.prog.visits)}, peak rss ${(st.peakRss / 2 ** 30).toFixed(2)} GB, GPU buffers ${(st.solver.bytes / 2 ** 20).toFixed(0)} MB, tile cache ${(st.store.cachedBytes / 2 ** 20).toFixed(0)} MB`);
    if (!r.done) return { done: false, steps: st.stepsMade, of: steps };
    st.exportCells("H", dir.path(`t${tier}-height.i32`));
    if (tier === last) { st.exportCells("TO", dir.path(`t${tier}-to.u32`)); st.exportCells("ACC", dir.path(`t${tier}-acc.u32`)); st.exportCells("F", dir.path(`t${tier}-flooded.i32`)); }
    const pr = st.prog, run: TierRun & { stream: unknown } = {
      tier, steps: pr.steps, calls: pr.calls, callS: pr.callS, rounds: pr.stepVisits.map((v) => v.flood ?? 0), slides: pr.stepVisits.map((v) => v.slide ?? 0), stepS: pr.stepS,
      stream: { block: pr.block, visits: pr.stepVisits, seconds: pr.seconds },
    };
    dir.putJson(`t${tier}-run`, run);
    st.removeWork();
    log(`tier ${tier} finished at ${spent().toFixed(1)} s`);
    return { done: true, steps: pr.steps, of: steps, run };
  } finally { st.release(); }
}
