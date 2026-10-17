// Lumped kinds: individuals sharing a cell and an integer state held as a count. Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Units 4 and 12b, Capacity and Representation and Key
// Technical Decisions.
//
// A bin is (key, e, T, out): key packs the cell and a 16-bit state (cell << 16 | state); e is the step its members
// entered it (born, or come from another state); T how many entered; out how many have gone. The members are ranks 0
// to T - 1, and whatever takes members from a bin (the law's departures, a world event) takes its next ranks, so the
// bin holds ranks out to T - 1. Member r's identity is (kind, key, e, sigma), sigma = feistel(r, T) under round keys
// of (seed, e, key): a seeded permutation with cycle-walking, so which members leave first is uniformly random while
// every member keeps its identity, and member r answers with the same identity before and after others leave. A bin
// is 16 bytes (32 with the table the step writes) for any number of members.
//
// A law is a function from (state, inputs, uniform u32) to an outcome state, given for each (cell, state, tick) as
// its dyadic outcome intervals: WGSL fn law(cell, state, tick) -> Split (m boundaries t[0] < ... < t[m - 1] of the
// uniform word, outcome j's state s[j], or a fate: DEATH, EATEN(p) by predator class p; reading the input buffer inp)
// and its TypeScript twin. A step draws each bin's multinomial split over those intervals (rand.ts multinom, exact) on
// the stream of (seed, e, key, tick): an outcome to the bin's own state stays, the others depart in outcome order
// through the next ranks. A law may bear: the members of the outcomes in bo are split again over bearing 0, bk, 2 bk
// or 3 bk members into state bs (Split.bm, bt, bo, bs, bk), on the same stream after the split's draws, so a daughter
// tiller or an egg batch comes of its parent's own outcome. Departures into one key from every bin, and births into
// it (the law's, then the CPU's, then the GPU's), merge into one new bin entered at this step, in key order and within
// a key in bin order and then births (that order gives each its ranks there); bins emptied are dropped and the rest
// kept in their order, so the table is the same every run on any GPU. A member's fate (the step and outcome of its
// leaving) is recoverable on demand by replaying its bin's splits (fate), and its continuation is the member it became
// in the bin it reached. Splitting bins that share a key and differ in e independently is the same process as
// splitting their union: the sum of independent multinomials with the same chances is multinomial.
//
// A merging kind (Unit 12b) keeps one bin a key: after every step the key's bin is its stayers first, in their rank
// order, then the entrants in key and bin order, then the births, all entered at this step. A stayer's new rank is its
// old rank less the members that left its bin, from its own bin alone, and its identity (key, e, sigma) is renewed each
// step with that link. Without it a long-lived state with daily entrants held a bin for every step of its members'
// stay, some 10^8 bins and 3 GB for the island's tillers, litter and fauna (research note
// docs/research/generator/2026-10-16-lumped.md sec. 7.3). What it narrows: identity is answered for the present and
// linked step to step; a fate needs the merged bin's members each step (its entrants come from the cell's other
// states), so the CPU keeps the bins and inputs of watched cells (watch) from the watch log each step lands, and
// replays fates there; birth is not recoverable unless a kind carries it in its state. A wide kind (sand) holds a key's
// members past 2^31 as several bins, its parts, each under 2^31: a 64-bit count is the sum of its parts, and the split
// of the sum is the sum of the parts' splits (binomials add), each part drawing on its own stream (lstream).
//
// Bins under `dense` members are held as individuals too: objects of the store kind named for the kind, one for each
// rank left, with key, e, T, rank and their bin's number, placed in their cell by their identity; a bin held so is
// stepped like any other (its draws keyed by the bin), and its individuals die when their ranks go. Once a bin held
// so has `lump` members or more again it is lumped back. Neither changes a count or an identity. A merging kind holds
// none so (dense 0).
//
// A world event that singles members out takes the next ranks of a bin: take(key, e, count, code), PROMOTED into full
// individuals of an active kind with their identity (lkey, le, lsig) and state (lstate, when the active kind has it:
// such individuals then step each step under the same law, their draws keyed by their identity), TAKEN by people, or
// EATEN(p). The GPU may ask too (requests: a key a word, one member each, from the animals' kernels), at most REQ_MAX a
// step. Observation (read, identity, fate) changes nothing.
//
// Fates replay a log of the steps (their takes and inputs), kept on the CPU and saved with the store. It is bounded
// two ways: a step at or before the entry of the oldest bin still in the table can't matter to any bin left (the table
// runs in order of entry, so that is bin 0's; not so for a merging kind, whose bins all entered at the last step), and
// is dropped at each landing; and at most `history` steps (400, 40 for a merging kind) are kept whatever the table
// holds. So fate answers for members of bins still in the table, and of departed bins only while their steps are kept;
// asked of a bin older than the oldest step kept, it throws.
//
// Scratch is the store's, shared by every lumped kind (they step one after another), sized for the largest.
import { type Rider, type Store, reload, savedArray, savedNumber, savedNumbers } from "../store";
import { cover, readback, storage } from "../kernel";
import { feistel, fkeys, multinom, philox, rinit } from "../rand";
import { RADIX_HIST, RADIX_SCATTER } from "../wgsl/index";
import { CELL_MM } from "../wgsl/index";
import { N } from "../../terrain/grid";
import {
  C, CTL_WORDS, DENSE, LUMP_COUNT, LUMP_GBFLAG, LUMP_GBPUT, LUMP_HEADS, LUMP_HPOS, LUMP_IOTA, LUMP_KEEP, LUMP_NEW,
  LUMP_NOKEEP, LUMP_SWEEP, LUMP_WATCH, LUMP_WIDE, NONE, OUTCOMES, PART_MAX, PROMOTED, REQ_MAX, isFate, lstream, lumpActive,
  lumpEmit, lumpSplit, lumpTake, lumpedCore,
} from "../wgsl/lumped";

export { DEATH, DENSE, EATEN, FATE, OUTCOMES, PROMOTED, REQ_MAX, TAKEN, isFate, lstream } from "../wgsl/lumped";

// A law's split: boundaries t, outcome states s, and what the outcomes bear: the members of the outcomes whose bits
// are set in mask, split over bearing 0, k, 2k and 3k members (boundaries t, at most 3) into state `state`.
export type Split = { t: number[]; s: number[]; b?: { t: number[]; k: number; mask: number; state: number } };
export type Bin = { key: number; e: number; T: number; out: number; dense: boolean; part?: number };
export type LumpedSpec = {
  name: string; // the store kind members held as individuals are kept in
  capacity: number; // bins
  contribs?: number; // departures and births a step can hold (twice the bins)
  members: number; // individuals the kind can hold
  seed: number;
  stream: number;
  law: string; // WGSL: fn law(cell: u32, state: u32, tick: u32) -> Split
  ts: (cell: number, state: number, tick: number, inp: Uint32Array) => Split; // its twin
  dense?: number; // bins under this many members are held as individuals (80; 0 for a merging kind)
  lump?: number; // and lumped again from this many (80)
  history?: number; // the most steps the fate log keeps (400; 40 for a merging kind)
  active: string; // the store kind promoted members become: u32 fields lkey, le, lsig (and lstate to step) and its own
  promote: string; // WGSL setting the active kind's own fields: slot, cell, state and tick in scope
  merge?: boolean; // one bin a key after every step
  wide?: boolean; // 64-bit counts, as parts (a merging kind only)
  outcomes?: number; // words of outcome counts a bin (OUTCOMES): the law's most outcomes, and one more if it bears
  // The inputs the law reads when they are written on the GPU (input): tables up to base, then cellWords a cell.
  inputs?: { base: number; cellWords: number; tables: Uint32Array };
  // After the split, before the departures go: the bins' table and each bin's outcome counts (outcomes words a bin,
  // the births in the last), for a census of what the split did.
  onSplit?: (s: Store, bins: GPUBuffer, cnt: GPUBuffer, t: number) => void;
};
// What happened to a member: the step it left at, and the state it went to (a fate code, or another state).
export type Fate = { t: number; state: number } | null;
// A take the GPU asked for, as the watch log has it: the bin taken from, the first rank taken, the code and how many.
type GTake = { key: number; e: number; part: number; first: number; code: number; k: number };
type Watched = { bins: Bin[]; cells: Map<number, Uint32Array> };
type Step = { t: number; takes: number[]; inp: Uint32Array | null; g: GTake[]; watched: Watched | null };

export const keyOf = (cell: number, state: number) => ((cell << 16) | state) >>> 0;
// Cells whose bins a merging kind's CPU keeps at most [design], and the rows a step's record of them holds at most.
export const WATCH_CELLS = 64;
const WATCH_BINS = 8192;
// The watch log's words on the GPU [design: some ten steps of records before a landing].
const WLOG = 1 << 19;

export class Lumped implements Rider {
  readonly name: string;
  readonly seed: number;
  // Room for bins and for a step's contributions; both double when a landing finds the table over three quarters full
  // (room).
  cap: number;
  ccap: number;
  readonly merge: boolean;
  readonly wide: boolean;
  dense: number;
  lump: number;
  // From the last landing: the bins, and the contributions its step made.
  bins = 0;
  made = 0;
  private tables: [GPUBuffer, GPUBuffer];
  private cur = 0;
  private readonly ctl: GPUBuffer;
  private readonly wlog: GPUBuffer | null;
  private inp: GPUBuffer;
  private own = true;
  private inpWords: Uint32Array | null = new Uint32Array(1);
  private births: number[] = [];
  private takes: number[] = [];
  private gbirths: { buf: GPUBuffer; n: number } | null = null;
  private greqs: { buf: GPUBuffer; n: number; code: number } | null = null;
  private cells: number[] = [];
  private cellBuf: GPUBuffer | null = null;
  // Every step made, with the takes it made and the inputs it read, for replaying fates.
  private log: Step[] = [];
  // Steps made since the last landing whose watch records are still on the GPU.
  private pending = 0;
  // The watch log's words the last record copied (0 for none).
  private copied = 0;
  // The newest step dropped from the log (-1 for none): fates of bins entered before it can't be replayed.
  private dropped = -1;
  readonly history: number;

  constructor(readonly store: Store, readonly spec: LumpedSpec) {
    const u = (name: string, unit: string) => ({ name, type: "u32" as const, unit, scale: 1 });
    this.merge = !!spec.merge;
    this.wide = !!spec.wide;
    if (this.wide && !this.merge) throw new Error(`lumped ${spec.name}: a wide kind merges`);
    store.adopt({ name: spec.name, capacity: spec.members, placed: true, fields: [u("key", "cell << 16 | state"), u("e", "step"), u("tt", "members entered"), u("rank", "rank"), u("bin", "bin")] });
    this.name = `lumped:${spec.name}`;
    const a = store.kind(spec.active);
    for (const f of ["lkey", "le", "lsig"]) if (a.fields[a.field[f]]?.type !== "u32") throw new Error(`lumped ${spec.name}: active kind ${spec.active} needs a u32 field ${f}`);
    this.seed = (spec.seed ^ Math.imul(spec.stream + 1, 0x9e3779b9)) >>> 0;
    this.cap = spec.capacity;
    this.ccap = spec.contribs ?? 2 * spec.capacity;
    this.dense = spec.dense ?? (this.merge ? 0 : 80);
    this.lump = spec.lump ?? (this.merge ? 0 : 80);
    if (this.merge && this.dense) throw new Error(`lumped ${spec.name}: a merging kind holds no bins as individuals`);
    this.history = spec.history ?? (this.merge ? 40 : 400);
    if (!(Number.isInteger(this.history) && this.history >= 1)) throw new Error(`lumped ${spec.name}: a fate log of ${this.history} steps`);
    const row = this.wide ? 20 : 16;
    this.tables = [storage(store.g, row * this.cap), storage(store.g, row * this.cap)];
    this.ctl = storage(store.g, CTL_WORDS * 4);
    this.wlog = this.merge ? storage(store.g, WLOG * 4) : null;
    this.inp = storage(store.g, 4);
    store.ride(this);
  }
  destroy() {
    for (const b of [...this.tables, this.ctl]) b.destroy();
    this.wlog?.destroy();
    this.cellBuf?.destroy();
    if (this.own) this.inp.destroy();
  }
  // ---------- saving: both bin tables (and which is current), the control words, the watch log, the inputs, the
  // births and takes queued for the next step and the log of steps that fates replay (the members held as individuals
  // are objects of the store's own kinds; inputs written on the GPU are their writer's to save) ----------
  buffers(): [string, GPUBuffer][] {
    const out: [string, GPUBuffer][] = [["a", this.tables[0]], ["b", this.tables[1]], ["ctl", this.ctl]];
    if (this.own) out.push(["inp", this.inp]);
    if (this.wlog) out.push(["wlog", this.wlog]);
    return out;
  }
  save() {
    return {
      cap: this.cap, ccap: this.ccap,
      cur: this.cur, dense: this.dense, lump: this.lump, bins: this.bins, inp: this.inpWords ? [...this.inpWords] : null, births: this.births, takes: this.takes,
      dropped: this.dropped, pending: this.pending, cells: this.cells,
      log: this.log.map((l) => ({
        t: l.t, takes: l.takes, inp: l.inp ? [...l.inp] : null, g: l.g.map((x) => [x.key, x.e, x.part, x.first, x.code, x.k]),
        watched: l.watched ? { bins: l.watched.bins.map((b) => [b.key, b.e, b.T, b.part ?? 0]), cells: [...l.watched.cells].map(([c, w]) => [c, ...w]) } : null,
      })),
    };
  }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    const g = this.store.g, n = (key: string) => savedNumber(state, key, this.name), what = this.name;
    if (n("cap") !== this.cap) {
      for (const b of this.tables) b.destroy();
      this.cap = n("cap");
      this.tables = [storage(g, (this.wide ? 20 : 16) * this.cap), storage(g, (this.wide ? 20 : 16) * this.cap)];
    }
    this.ccap = n("ccap");
    reload(g, this.tables[0], data.a, `${what} table a`);
    reload(g, this.tables[1], data.b, `${what} table b`);
    reload(g, this.ctl, data.ctl, `${what} ctl`);
    if (this.wlog) reload(g, this.wlog, data.wlog, `${what} watch log`);
    if (data.inp) { if (this.own) this.inp.destroy(); this.inp = storage(g, data.inp); this.own = true; }
    [this.cur, this.dense, this.lump, this.bins, this.dropped, this.pending] = [n("cur"), n("dense"), n("lump"), n("bins"), n("dropped"), n("pending")];
    const s = state as Record<string, unknown>;
    this.inpWords = s.inp === null ? null : Uint32Array.from(savedNumbers(savedArray(state, "inp", what), `${what} inputs`));
    this.births = savedNumbers(savedArray(state, "births", what), `${what} births`);
    this.takes = savedNumbers(savedArray(state, "takes", what), `${what} takes`);
    this.watch(savedNumbers(savedArray(state, "cells", what), `${what} watched cells`));
    this.log = savedArray(state, "log", what).map((l) => {
      const r = l as Record<string, unknown>, w = r.watched as { bins: number[][]; cells: number[][] } | null;
      return {
        t: savedNumber(l, "t", `${what} log`),
        takes: savedNumbers(savedArray(l, "takes", `${what} log`), `${what} log takes`),
        inp: r.inp === null ? null : Uint32Array.from(savedNumbers(savedArray(l, "inp", `${what} log`), `${what} log inputs`)),
        g: (savedArray(l, "g", `${what} log`) as number[][]).map(([key, e, part, first, code, k]) => ({ key, e, part, first, code, k })),
        watched: w ? { bins: w.bins.map(([key, e, T, part]) => ({ key, e, T, out: 0, dense: false, ...(this.wide ? { part } : {}) })), cells: new Map(w.cells.map(([c, ...ws]) => [c, Uint32Array.from(ws)])) } : null,
      };
    });
  }
  bytes(): number {
    return this.tables[0].size + this.tables[1].size + this.ctl.size + (this.wlog?.size ?? 0);
  }
  // The input buffer the law reads (inp), from the next step on: words written by the CPU (kept in the log for fates)...
  inputs(words: Uint32Array) {
    if (!this.own || this.inp.size < words.byteLength) { if (this.own) this.inp.destroy(); this.inp = storage(this.store.g, words.byteLength); this.own = true; }
    this.store.g.device.queue.writeBuffer(this.inp, 0, words);
    this.inpWords = words.slice();
  }
  // ...or a buffer the GPU writes before each step (laid out as spec.inputs; the watch log keeps watched cells' words).
  input(buf: GPUBuffer) {
    if (!this.spec.inputs) throw new Error(`lumped ${this.spec.name}: inputs on the GPU need spec.inputs`);
    if (this.own) this.inp.destroy();
    this.inp = buf; this.own = false; this.inpWords = null;
  }
  // The bins' table as the last step left it, and the control words (word 0 the bins).
  get table(): GPUBuffer { return this.tables[this.cur]; }
  get control(): GPUBuffer { return this.ctl; }
  // Members born into (cell, state) at the next step (a wide kind's count past a part goes as several).
  add(cell: number, state: number, count: number) {
    for (let left = count; left > 0; ) {
      const c = this.wide ? Math.min(left, PART_MAX) : left;
      if (!(Number.isInteger(c) && c <= 0xffffffff)) throw new Error(`lumped ${this.spec.name}: ${count} members born at once`);
      this.births.push(keyOf(cell, state), c);
      left -= c;
    }
  }
  // Members born at the next step from the GPU: n pairs (key, count) in buf, a count of 0 for none, after the CPU's.
  bornFrom(buf: GPUBuffer, n: number) {
    this.gbirths = { buf, n };
  }
  // A world event: the next `count` ranks of the bin (key, e) are taken at the next step (fewer if it holds fewer),
  // their fate `code`: PROMOTED become full individuals of the active kind.
  take(key: number, e: number, count: number, code: number) {
    if (!isFate(code) || code === 0xffffffff) throw new Error(`lumped ${this.spec.name}: a take's code is a fate other than death`);
    this.takes.push(key >>> 0, e >>> 0, count, code >>> 0);
  }
  promote(key: number, e: number, count: number) {
    this.take(key, e, count, PROMOTED);
  }
  // The GPU's requests for the next step: n words in buf, each a key (NONE for none) to take one member of, `code`.
  requests(buf: GPUBuffer, n: number, code = PROMOTED) {
    this.greqs = { buf, n, code };
  }
  // The cells whose bins the CPU keeps each step, for fates (a merging kind).
  watch(cells: number[]) {
    if (!this.merge && cells.length) throw new Error(`lumped ${this.spec.name}: only a merging kind watches cells`);
    const c = [...new Set(cells)].sort((a, b) => a - b);
    if (c.length > WATCH_CELLS) throw new Error(`lumped ${this.spec.name}: at most ${WATCH_CELLS} cells watched`);
    this.cells = c;
    if (c.length) {
      if (!this.cellBuf) this.cellBuf = storage(this.store.g, WATCH_CELLS * 4);
      this.store.g.device.queue.writeBuffer(this.cellBuf, 0, Uint32Array.from(c));
    }
  }

  // ---------- the step ----------
  private sc(name: string, words: number) {
    return this.store.scratch(`lumped:${name}`, words);
  }
  // Room for more bins and contributions: where the last landing found the table, or the step's contributions, over
  // three quarters of their room, that room grows by half before the step, the current table copied field by field
  // [design: a kind's bins rise by less than a quarter a step, so none outgrows its room]. A step's draws are keyed by
  // bin and tick, not by room, so the results are the same whatever the room.
  private room() {
    if (this.made * 4 > this.ccap * 3) this.ccap = Math.ceil((this.ccap * 3) / 2);
    if (this.bins * 4 <= this.cap * 3) return;
    const s = this.store, rows = this.wide ? 5 : 4, to = Math.ceil((this.cap * 3) / 2048) * 1024, cur = this.tables[this.cur];
    const next: [GPUBuffer, GPUBuffer] = [storage(s.g, rows * 4 * to), storage(s.g, rows * 4 * to)];
    s.encode((e) => { for (let f = 0; f < rows; f++) e.copyBufferToBuffer(cur, f * this.cap * 4, next[this.cur], f * to * 4, this.cap * 4); });
    for (const b of this.tables) s.retire(b);
    this.tables = next;
    this.ccap = Math.max(this.ccap, Math.ceil((this.ccap * to) / this.cap));
    this.cap = to;
  }
  step(t: number) {
    this.room();
    const s = this.store, g = s.g, cap = this.cap, ccap = this.ccap, A = this.tables[this.cur], B = this.tables[1 - this.cur], merge = this.merge;
    const L = { seed: this.seed, law: this.spec.law, wide: this.wide, outs: this.spec.outcomes }, core = lumpedCore(L), BC = `const BCAP = ${cap}u;\nconst DENSE = ${DENSE}u;`;
    // takes first: they take the next ranks before the split
    // the CPU's writes below go to scratch every lumped kind shares: what an earlier kind recorded goes first
    s.flush();
    const R = this.takes.length / 4, ng = this.greqs?.n ?? 0, nt = R + (ng ? REQ_MAX : 0);
    const info = this.sc("info", 4 * Math.max(nt, 1));
    if (nt) {
      const req = this.sc("req", 1 + 4 * R), took = this.sc("took", nt), gq = this.greqs?.buf ?? this.sc("gq", 1);
      g.device.queue.writeBuffer(req, 0, Uint32Array.from([R, ...this.takes]));
      s.encode((e) => e.clearBuffer(took, 0, nt * 4));
      s.run(lumpTake(this.wide), [A, this.ctl, req, gq, took, info], [1], [cap, merge ? 1 : 0, ng, this.greqs?.code ?? PROMOTED]);
      const a = s.kind(this.spec.active), lstate = a.field.lstate !== undefined ? "child_set_lstate(slot, state);" : "";
      s.bear(this.spec.active, took, nt, `
let row = linfo[4u * parent + 1u];
let key = lbins[row]; let e = lbins[BCAP + row]; let T = lbins[2u * BCAP + row] & ~DENSE;
let sig = lsigmap(key, e, ${this.wide ? "lbins[4u * BCAP + row]" : "0u"}, T, linfo[4u * parent] + k);
let p = lplace(key, e, sig);
child_set_x(slot, p.x); child_set_y(slot, p.y);
child_set_lkey(slot, key); child_set_le(slot, e); child_set_lsig(slot, sig);
let cell = key >> 16u; let state = key & 0xffffu;
${lstate}
${this.spec.promote}`, { bufs: [{ name: "lbins", buf: A }, { name: "linfo", buf: info }, { name: "inp", buf: this.inp }], wgsl: `${core}\n${BC}` });
    } else s.encode((e) => e.clearBuffer(this.ctl, C.gtakes * 4, 4));
    // promoted members step as individuals under the same law
    const act = s.kind(this.spec.active);
    if (act.field.lstate !== undefined) {
      const K = act.capacity, off = (f: string) => (act.field[f] + 1) * K;
      s.run(lumpActive(L), [act.body, act.alloc, this.inp], cover(g, K), [K, t, off("lkey"), off("le"), off("lsig"), off("lstate")]);
      act.touched = true;
    }
    // the split, and each bin's departures and the births into contributions
    // The step's large scratch goes under names other riders' calls use too (store.ts index: key, flag, ids, cells,
    // hist; deadwood: counts), none of whose contents outlasts the call that wrote it, so they share the memory; ck
    // and req take the CPU's writes and keep their own.
    const cnt = s.scratch("counts", (this.spec.outcomes ?? OUTCOMES) * cap), nc = this.sc("nc", cap + 1), keep = this.sc("keep", cap + 1);
    s.run(lumpSplit(L), [A, this.ctl, cnt, nc, keep, this.inp], cover(g, cap), [cap, t, 0, 0]);
    this.spec.onSplit?.(s, A, cnt, t);
    const nb = this.births.length / 2, gn = this.gbirths?.n ?? 0, ck = this.sc("ck", 2 * ccap + Math.max(2 * (nb + gn), 1)), len = this.sc("len", 1);
    if (nb) g.device.queue.writeBuffer(ck, 2 * ccap * 4, Uint32Array.from(this.births));
    const tot = s.scan(nc, cap);
    s.encode((e) => e.copyBufferToBuffer(tot, 0, this.ctl, C.dep * 4, 4));
    const kept = s.scan(keep, cap);
    s.encode((e) => e.copyBufferToBuffer(kept, 0, this.ctl, C.stays * 4, 4));
    if (gn) {
      const flags = this.sc("gflags", gn);
      s.run(LUMP_GBFLAG, [this.gbirths!.buf, flags], cover(g, gn), [gn, 0, 0, 0]);
      const gt = s.scan(flags, gn);
      s.run(LUMP_GBPUT, [this.gbirths!.buf, flags, gt, ck, this.ctl], cover(g, gn), [gn, ccap, nb, 0]);
    } else s.encode((e) => e.clearBuffer(this.ctl, C.gb * 4, 4));
    s.run(lumpEmit(L), [A, this.ctl, nc, keep, cnt, ck, len, this.inp], cover(g, Math.max(cap, nb + gn)), [cap, t, nb, ccap, merge ? 1 : 0, gn, 0, 0]);
    // contributions sorted by key, stable, in four 8-bit passes
    const tiles = Math.ceil(ccap / 1024), ids0 = s.scratch("ids", ccap), ids1 = s.scratch("cells", ccap + 1), keys1 = s.scratch("key", ccap + 1), hist = s.scratch("hist", 256 * tiles);
    s.run(LUMP_IOTA, [ids0, len], cover(g, ccap));
    const pass = (ki: GPUBuffer, ii: GPUBuffer, ko: GPUBuffer, io: GPUBuffer, shift: number) => {
      s.run(RADIX_HIST, [ki, len, hist], cover(g, tiles, 1), [shift, tiles, 0, 0]);
      s.scan(hist, 256 * tiles);
      s.run(RADIX_SCATTER, [ki, ii, len, hist, io, ko], cover(g, tiles, 1), [shift, tiles, 0, 0]);
    };
    pass(ck, ids0, keys1, ids1, 0);
    pass(keys1, ids1, ck, ids0, 8);
    pass(ck, ids0, keys1, ids1, 16);
    pass(keys1, ids1, ck, ids0, 24);
    // one new bin for each key (a wide kind's key, as many as its parts take): where its run starts and the running
    // totals of the counts, in the sort's spent keys1 and ids1
    const head = keys1, pc = ids1, hpos = s.scratch("flag", ccap + 2);
    s.run(LUMP_HEADS, [ck, ids0, ck, len, head, pc], cover(g, ccap + 1), [ccap + 1, ccap, 0, 0]);
    const heads = s.scan(head, ccap + 1);
    s.run(LUMP_HPOS, [ck, len, head, heads, hpos, this.ctl], cover(g, ccap));
    const dn = this.sc("dn", cap);
    s.encode((e) => e.clearBuffer(dn, 0, cap * 4));
    if (this.wide) {
      const wn = this.sc("wn", ccap + 2);
      s.encode((e) => e.clearBuffer(wn, 0, (ccap + 2) * 4));
      s.run(LUMP_NOKEEP, [this.ctl], [1]);
      s.run(LUMP_WIDE, [ck, hpos, pc, this.ctl, wn, B], cover(g, ccap), [cap, t, 0, 0]);
      s.scan(wn, ccap + 1);
      s.run(LUMP_WIDE, [ck, hpos, pc, this.ctl, wn, B], cover(g, ccap), [cap, t, 1, 0]);
    } else {
      s.scan(pc, ccap + 1);
      // the new table: bins left in their order (none for a merging kind), then the new ones; densify and lump
      if (merge) s.run(LUMP_NOKEEP, [this.ctl], [1]);
      else s.run(LUMP_KEEP, [A, B, this.ctl, keep, this.sc("remap", cap), dn], cover(g, cap), [cap, this.dense, this.lump, 0]);
      s.run(LUMP_NEW, [ck, hpos, pc, this.ctl, B, dn], cover(g, ccap), [cap, t, this.dense, 0]);
    }
    s.run(LUMP_COUNT, [this.ctl], [1], [cap, this.wide ? 1 : 0, 0, 0]);
    if (!merge) {
      // the individuals: those whose ranks went die, the rest follow their bins; newly dense bins' members are born
      const k = s.kind(this.spec.name), K = k.capacity;
      s.run(LUMP_SWEEP, [k.body, k.alloc, this.sc("remap", cap), B], cover(g, K), [K, cap, (k.field.bin + 1) * K, (k.field.rank + 1) * K]);
      s.bear(this.spec.name, dn, cap, `
let key = lbins[parent]; let e = lbins[BCAP + parent]; let T = lbins[2u * BCAP + parent] & ~DENSE;
let rank = lbins[3u * BCAP + parent] + k;
let p = lplace(key, e, lsigma(key, e, T, rank));
child_set_x(slot, p.x); child_set_y(slot, p.y);
child_set_key(slot, key); child_set_e(slot, e); child_set_tt(slot, T); child_set_rank(slot, rank); child_set_bin(slot, parent);`,
      { bufs: [{ name: "lbins", buf: B }, { name: "inp", buf: this.inp }], wgsl: `${core}\n${BC}` });
    } else {
      const ins = this.spec.inputs, cw = ins?.cellWords ?? 0;
      s.run(LUMP_WATCH, [B, A, this.ctl, info, this.cellBuf ?? this.sc("nocells", 1), this.inp, this.wlog!], [1], [cap, t, R, this.cells.length, ins ? cw : 0, ins?.base ?? 0, WLOG, this.wide ? 1 : 0]);
      this.pending++;
    }
    this.cur = 1 - this.cur;
    this.log.push({ t, takes: this.takes, inp: this.inpWords, g: [], watched: null });
    if (this.log.length > this.history) this.dropped = this.log.shift()!.t;
    this.births = [];
    this.takes = [];
    this.gbirths = null;
    this.greqs = null;
  }

  // ---------- observing ----------
  async read(): Promise<Bin[]> {
    this.store.flush();
    const ctl = new Uint32Array(await readback(this.store.g, this.ctl)), w = new Uint32Array(await readback(this.store.g, this.tables[this.cur])), cap = this.cap;
    return Array.from({ length: ctl[0] }, (_, i) => ({
      key: w[i], e: w[cap + i], T: (w[2 * cap + i] & ~DENSE) >>> 0, out: w[3 * cap + i], dense: (w[2 * cap + i] & DENSE) !== 0, ...(this.wide ? { part: w[4 * cap + i] } : {}),
    }));
  }
  // Member rank's identity in a bin (sigma).
  identity(b: { key: number; e: number; T: number; part?: number }, rank: number): number {
    return feistel(rank, b.T, fkeys(this.seed, lstream(b.e, b.part ?? 0), b.key, 0));
  }
  // Where a member stands in its cell, by its identity.
  place(key: number, e: number, sigma: number): { x: number; y: number } {
    const h = philox([key, sigma, e, 0xfffffffe], [this.seed, 0x80000000]), cell = key >>> 16;
    return { x: (cell % N) * CELL_MM + (h[0] % CELL_MM), y: Math.floor(cell / N) * CELL_MM + (h[1] % CELL_MM) };
  }
  // The inputs a step's law read, for the twin: the CPU's words, or the tables and the watched cell's words.
  private inputsAt(st: Step, cell: number): Uint32Array {
    if (st.inp) return st.inp;
    const ins = this.spec.inputs!, words = st.watched?.cells.get(cell);
    if (!words) throw new Error(`lumped ${this.spec.name}: cell ${cell} was not watched at step ${st.t}`);
    const out = new Uint32Array(ins.base + N * N * ins.cellWords);
    out.set(ins.tables);
    out.set(words, ins.base + cell * ins.cellWords);
    return out;
  }
  // A member's fate, replaying its bin's takes and splits from the step after it entered: the step it left at and
  // where it went, or null while it is still there. A merging kind's member is followed into its key's bin of each
  // step as its cell's watch records have them. Throws for a bin entered before the oldest step the log keeps, or a
  // cell not watched.
  fate(b: { key: number; e: number; T: number; part?: number }, rank: number): Fate {
    if (b.e < this.dropped) throw new Error(`lumped ${this.spec.name}: the steps after a bin entered at ${b.e} are gone from the fate log (kept from after ${this.dropped})`);
    if (this.wide) throw new Error(`lumped ${this.spec.name}: fates of a wide kind are not replayed`);
    let cur = b, r = rank, out = 0;
    const state = b.key & 0xffff;
    for (const st of this.log) {
      if (st.t <= cur.e) continue;
      for (let q = 0; q < st.takes.length; q += 4) {
        if (st.takes[q] !== cur.key || st.takes[q + 1] !== cur.e) continue;
        const take = Math.min(st.takes[q + 2], cur.T - out);
        if (r < out + take) return { t: st.t, state: st.takes[q + 3] };
        out += take;
      }
      for (const x of st.g) {
        if (x.key !== cur.key || x.e !== cur.e) continue;
        if (r < out + x.k) return { t: st.t, state: x.code };
        out += x.k;
      }
      if (out === cur.T) return null;
      const sp = this.spec.ts(cur.key >>> 16, state, st.t, this.inputsAt(st, cur.key >>> 16));
      rinit(this.seed, cur.e, cur.key, st.t);
      const c = multinom(cur.T - out, sp.t);
      for (let j = 0; j < c.length; j++) {
        if (sp.s[j] === state) continue;
        if (r < out + c[j]) return { t: st.t, state: sp.s[j] };
        out += c[j];
      }
      if (!this.merge) continue;
      // a stayer: first in its key's new bin, its rank less those that left
      const next = st.watched?.bins.find((x) => x.key === cur.key && x.e === st.t);
      if (!next) throw new Error(`lumped ${this.spec.name}: cell ${cur.key >>> 16} was not watched at step ${st.t}`);
      r -= out;
      cur = next;
      out = 0;
    }
    return null;
  }
  // The members of a split's bearing outcomes born, as the WGSL counts them (lborn), from the bin's stream after the
  // split's own draws.
  static born(sp: Split, c: number[]): number {
    if (!sp.b) return 0;
    let nb = 0;
    for (let j = 0; j < c.length; j++) if ((sp.b.mask >>> j) & 1) nb += c[j];
    const k = multinom(nb, sp.b.t);
    let born = 0;
    for (let i = 1; i < k.length; i++) born = Math.min(0xffffffff, born + Math.min(0xffffffff, k[i] * i * sp.b.k));
    return born;
  }

  // ---------- riding the landing: the control words, the entry of the oldest bin, and the watch log ----------
  private span() {
    const per = 3 + 6 * REQ_MAX + 4 * WATCH_BINS + this.cells.length * (1 + (this.spec.inputs?.cellWords ?? 0));
    return this.pending ? Math.min(WLOG, 1 + this.pending * per) : 0;
  }
  words() { return 9 + this.span(); }
  record(out: GPUBuffer, at: number) {
    const span = this.span();
    this.copied = span;
    this.store.encode((e) => {
      e.copyBufferToBuffer(this.ctl, 0, out, at * 4, 32);
      e.copyBufferToBuffer(this.tables[this.cur], this.cap * 4, out, (at + 8) * 4, 4);
      if (span) { e.copyBufferToBuffer(this.wlog!, 0, out, (at + 9) * 4, span * 4); e.clearBuffer(this.wlog!, 0, 4); }
    });
    this.pending = 0;
  }
  land(o: Uint32Array, at: number) {
    if (!o.length) return;
    this.bins = o[at];
    this.made = o[at + C.contribs];
    if (o[at + 4] || o[at + 5]) throw new Error(`lumped ${this.spec.name}: ${o[at + 4]} bins and ${o[at + 5]} departures found no room (capacity ${this.cap} bins, ${this.ccap} contributions)`);
    if (this.merge) {
      if (this.copied) this.records(o, at + 9);
    } else if (this.bins) while (this.log.length && this.log[0].t <= o[at + 8]) this.dropped = this.log.shift()!.t;
  }
  // The watch log's records landed: each step's GPU takes, watched bins and input words, onto its step in the log.
  private records(o: Uint32Array, at: number) {
    const used = o[at];
    let p = at + 1;
    const end = p + used;
    while (p < end) {
      const t = o[p], ng = o[p + 1];
      p += 2;
      const g: GTake[] = [];
      for (let i = 0; i < ng; i++, p += 6) g.push({ key: o[p], e: o[p + 1], part: o[p + 2], first: o[p + 3], code: o[p + 4], k: o[p + 5] });
      const nb = o[p++], bins: Bin[] = [];
      for (let i = 0; i < nb; i++, p += 4) bins.push({ key: o[p], e: o[p + 1], T: o[p + 2], out: 0, dense: false, ...(this.wide ? { part: o[p + 3] } : {}) });
      const nw = o[p++], cells = new Map<number, Uint32Array>(), cw = this.spec.inputs?.cellWords ?? 0;
      for (let i = 0; i < nw; i++) { cells.set(o[p], o.slice(p + 1, p + 1 + cw)); p += 1 + cw; }
      const st = this.log.find((l) => l.t === t);
      if (st) { st.g = g; st.watched = this.cells.length ? { bins, cells } : null; }
    }
  }
  // Steps the fate log holds.
  get logged(): number {
    return this.log.length;
  }
}
