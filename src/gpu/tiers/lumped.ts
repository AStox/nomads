// Lumped kinds: individuals sharing a cell and an integer state held as a count. Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 4, Capacity and Representation and Key Technical
// Decisions.
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
// uniform word, outcome j's state s[j], DEATH for a death; reading the input buffer inp) and its TypeScript twin. A
// step draws each bin's multinomial split over those intervals (rand.ts multinom, exact) on the stream of (seed, e,
// key, tick): an outcome to the bin's own state stays, the others depart in outcome order through the next ranks.
// Departures into one key from every bin, and births into it, merge into one new bin entered at this step, in key
// order and within a key in bin order and then births (that order gives each its ranks there); bins emptied are
// dropped and the rest kept in their order, so the table is the same every run on any GPU. A member's fate (the step
// and outcome of its leaving) is recoverable on demand by replaying its bin's splits (fate), and its continuation is
// the member it became in the bin it reached. Splitting bins that share a key and differ in e independently is the
// same process as splitting their union: the sum of independent multinomials with the same chances is multinomial.
//
// Bins under `dense` members are held as individuals too: objects of the store kind named for the kind, one for each
// rank left, with key, e, T, rank and their bin's number, placed in their cell by their identity; a bin held so is
// stepped like any other (its draws keyed by the bin), and its individuals die when their ranks go. Once a bin held
// so has `lump` members or more again it is lumped back. Neither changes a count or an identity.
//
// A world event that singles members out (promote) takes the next ranks of a bin into full individuals of an active
// kind with their identity (lkey, le, lsig) and state; observation (read, identity, fate) changes nothing.
//
// Fates replay a log of the steps (their promotions and inputs), kept on the CPU and saved with the store. It is
// bounded two ways: a step at or before the entry of the oldest bin still in the table can't matter to any bin left
// (the table runs in order of entry, so that is bin 0's), and is dropped at each landing; and at most `history` steps
// (400) are kept whatever the table holds. So fate answers for members of bins still in the table, and of departed
// bins only while their steps are kept; asked of a bin older than the oldest step kept, it throws.
import { type Rider, type Store, reload, savedArray, savedNumber, savedNumbers } from "../store";
import { cover, readback, storage } from "../kernel";
import { feistel, fkeys, multinom, philox, rinit } from "../rand";
import { RADIX_HIST, RADIX_SCATTER } from "../wgsl/index";
import { CELL_MM } from "../wgsl/index";
import { N } from "../../terrain/grid";
import { DENSE, LUMP_COUNT, LUMP_HEADS, LUMP_HPOS, LUMP_IOTA, LUMP_KEEP, LUMP_NEW, LUMP_PROMOTE, LUMP_SWEEP, lumpEmit, lumpSplit, lumpedCore } from "../wgsl/lumped";

export { DEATH, DENSE } from "../wgsl/lumped";

export type Split = { t: number[]; s: number[] };
export type Bin = { key: number; e: number; T: number; out: number; dense: boolean };
export type LumpedSpec = {
  name: string; // the store kind members held as individuals are kept in
  capacity: number; // bins
  contribs?: number; // departures and births a step can hold (twice the bins)
  members: number; // individuals the kind can hold
  seed: number;
  stream: number;
  law: string; // WGSL: fn law(cell: u32, state: u32, tick: u32) -> Split
  ts: (cell: number, state: number, tick: number, inp: Uint32Array) => Split; // its twin
  dense?: number; // bins under this many members are held as individuals (80)
  lump?: number; // and lumped again from this many (80)
  history?: number; // the most steps the fate log keeps (400)
  active: string; // the store kind promoted members become: u32 fields lkey, le, lsig and its own
  promote: string; // WGSL setting the active kind's own fields: slot, cell, state and tick in scope
};
// What happened to a member: the step it left at, and the state it went to (DEATH, or PROMOTED for a world event).
export type Fate = { t: number; state: number } | null;
export const PROMOTED = 0xfffffffe;

export const keyOf = (cell: number, state: number) => ((cell << 16) | state) >>> 0;

export class Lumped implements Rider {
  readonly name: string;
  readonly seed: number;
  readonly cap: number;
  readonly ccap: number;
  dense: number;
  lump: number;
  // From the last landing: the bins.
  bins = 0;
  private readonly tables: [GPUBuffer, GPUBuffer];
  private cur = 0;
  private readonly ctl: GPUBuffer;
  private inp: GPUBuffer;
  private inpWords = new Uint32Array(1);
  private births: number[] = [];
  private promos: number[] = [];
  // Every step made, with the promotions it took and the inputs it read, for replaying fates.
  private log: { t: number; promos: number[]; inp: Uint32Array }[] = [];
  // The newest step dropped from the log (-1 for none): fates of bins entered before it can't be replayed.
  private dropped = -1;
  readonly history: number;

  constructor(readonly store: Store, readonly spec: LumpedSpec) {
    const u = (name: string, unit: string) => ({ name, type: "u32" as const, unit, scale: 1 });
    store.adopt({ name: spec.name, capacity: spec.members, placed: true, fields: [u("key", "cell << 16 | state"), u("e", "step"), u("tt", "members entered"), u("rank", "rank"), u("bin", "bin")] });
    this.name = `lumped:${spec.name}`;
    const a = store.kind(spec.active);
    for (const f of ["lkey", "le", "lsig"]) if (a.fields[a.field[f]]?.type !== "u32") throw new Error(`lumped ${spec.name}: active kind ${spec.active} needs a u32 field ${f}`);
    this.seed = (spec.seed ^ Math.imul(spec.stream + 1, 0x9e3779b9)) >>> 0;
    this.cap = spec.capacity;
    this.ccap = spec.contribs ?? 2 * spec.capacity;
    this.dense = spec.dense ?? 80;
    this.lump = spec.lump ?? 80;
    this.history = spec.history ?? 400;
    if (!(Number.isInteger(this.history) && this.history >= 1)) throw new Error(`lumped ${spec.name}: a fate log of ${this.history} steps`);
    this.tables = [storage(store.g, 16 * this.cap), storage(store.g, 16 * this.cap)];
    this.ctl = storage(store.g, 32);
    this.inp = storage(store.g, 4);
    store.ride(this);
  }
  destroy() { for (const b of [...this.tables, this.ctl, this.inp]) b.destroy(); }
  // ---------- saving: both bin tables (and which is current), the control words, the inputs, the births and
  // promotions queued for the next step and the log of steps that fates replay (the members held as individuals are
  // objects of the store's own kinds) ----------
  buffers(): [string, GPUBuffer][] { return [["a", this.tables[0]], ["b", this.tables[1]], ["ctl", this.ctl], ["inp", this.inp]]; }
  save() {
    return {
      cur: this.cur, dense: this.dense, lump: this.lump, bins: this.bins, inp: [...this.inpWords], births: this.births, promos: this.promos,
      dropped: this.dropped, log: this.log.map((l) => ({ t: l.t, promos: l.promos, inp: [...l.inp] })),
    };
  }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    const g = this.store.g, n = (key: string) => savedNumber(state, key, this.name);
    reload(g, this.tables[0], data.a, `${this.name} table a`);
    reload(g, this.tables[1], data.b, `${this.name} table b`);
    reload(g, this.ctl, data.ctl, `${this.name} ctl`);
    this.inp.destroy();
    this.inp = storage(g, data.inp ?? new Uint8Array(4));
    [this.cur, this.dense, this.lump, this.bins] = [n("cur"), n("dense"), n("lump"), n("bins")];
    this.inpWords = Uint32Array.from(savedNumbers(savedArray(state, "inp", this.name), `${this.name} inputs`));
    this.births = savedNumbers(savedArray(state, "births", this.name), `${this.name} births`);
    this.promos = savedNumbers(savedArray(state, "promos", this.name), `${this.name} promotions`);
    this.dropped = n("dropped");
    this.log = savedArray(state, "log", this.name).map((l) => ({
      t: savedNumber(l, "t", `${this.name} log`),
      promos: savedNumbers(savedArray(l, "promos", `${this.name} log`), `${this.name} log promotions`),
      inp: Uint32Array.from(savedNumbers(savedArray(l, "inp", `${this.name} log`), `${this.name} log inputs`)),
    }));
  }
  bytes(): number {
    return this.tables[0].size + this.tables[1].size + this.ctl.size;
  }
  // The input buffer the law reads (inp), from the next step on.
  inputs(words: Uint32Array) {
    if (this.inp.size < words.byteLength) { this.inp.destroy(); this.inp = storage(this.store.g, words.byteLength); }
    this.store.g.device.queue.writeBuffer(this.inp, 0, words);
    this.inpWords = words.slice();
  }
  // Members born into (cell, state) at the next step.
  add(cell: number, state: number, count: number) {
    this.births.push(keyOf(cell, state), count);
  }
  // A world event: the next `count` ranks of the bin (key, e) become full individuals of the active kind at the next
  // step (fewer if it holds fewer).
  promote(key: number, e: number, count: number) {
    this.promos.push(key, e, count);
  }

  // ---------- the step ----------
  private sc(name: string, words: number) {
    return this.store.scratch(`${this.spec.name}:${name}`, words);
  }
  step(t: number) {
    const s = this.store, g = s.g, cap = this.cap, ccap = this.ccap, A = this.tables[this.cur], B = this.tables[1 - this.cur];
    const L = { seed: this.seed, law: this.spec.law }, core = lumpedCore(L), BC = `const BCAP = ${cap}u;\nconst DENSE = ${DENSE}u;`;
    // promotions first: they take the next ranks before the split
    const R = this.promos.length / 3;
    if (R) {
      const req = this.sc("req", 1 + 3 * R), took = this.sc("took", R), info = this.sc("info", 2 * R);
      g.device.queue.writeBuffer(req, 0, Uint32Array.from([R, ...this.promos]));
      s.encode((e) => e.clearBuffer(took, 0, R * 4));
      s.run(LUMP_PROMOTE, [A, this.ctl, req, took, info], cover(g, cap), [cap, 0, 0, 0]);
      s.bear(this.spec.active, took, R, `
let row = linfo[2u * parent + 1u];
let key = lbins[row]; let e = lbins[BCAP + row]; let T = lbins[2u * BCAP + row] & ~DENSE;
let sig = lsigma(key, e, T, linfo[2u * parent] + k);
let p = lplace(key, e, sig);
child_set_x(slot, p.x); child_set_y(slot, p.y);
child_set_lkey(slot, key); child_set_le(slot, e); child_set_lsig(slot, sig);
let cell = key >> 16u; let state = key & 0xffffu;
${this.spec.promote}`, { bufs: [{ name: "lbins", buf: A }, { name: "linfo", buf: info }, { name: "inp", buf: this.inp }], wgsl: `${core}\n${BC}` });
    }
    // the split, and each bin's departures and the births into contributions
    const cnt = this.sc("cnt", 16 * cap), nc = this.sc("nc", cap), keep = this.sc("keep", cap);
    s.run(lumpSplit(L), [A, this.ctl, cnt, nc, keep, this.inp], cover(g, cap), [cap, t, 0, 0]);
    const nb = this.births.length / 2, ck = this.sc("ck", 2 * ccap + Math.max(2 * nb, 1)), len = this.sc("len", 1);
    if (nb) g.device.queue.writeBuffer(ck, 2 * ccap * 4, Uint32Array.from(this.births));
    const tot = s.scan(nc, cap);
    s.run(lumpEmit(L), [A, this.ctl, nc, tot, cnt, ck, len, this.inp], cover(g, Math.max(cap, nb)), [cap, t, nb, ccap]);
    // contributions sorted by key, stable, in four 8-bit passes
    const tiles = Math.ceil(ccap / 1024), ids0 = this.sc("ids0", ccap), ids1 = this.sc("ids1", ccap), keys1 = this.sc("keys1", ccap), hist = this.sc("hist", 256 * tiles);
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
    // one new bin for each key: where its run starts and the running totals of the counts
    const head = this.sc("head", ccap + 1), pc = this.sc("pc", ccap + 1), hpos = this.sc("hpos", ccap + 2);
    s.run(LUMP_HEADS, [ck, ids0, ck, len, head, pc], cover(g, ccap + 1), [ccap + 1, ccap, 0, 0]);
    const heads = s.scan(head, ccap + 1);
    s.run(LUMP_HPOS, [ck, len, head, heads, hpos, this.ctl], cover(g, ccap));
    s.scan(pc, ccap + 1);
    // the new table: bins left in their order, then the new ones; densify and lump
    const remap = this.sc("remap", cap), dn = this.sc("dn", cap);
    s.encode((e) => e.clearBuffer(dn));
    const kept = s.scan(keep, cap);
    s.run(LUMP_KEEP, [A, B, this.ctl, keep, kept, remap, dn], cover(g, cap), [cap, this.dense, this.lump, 0]);
    s.run(LUMP_NEW, [ck, hpos, pc, this.ctl, B, dn], cover(g, ccap), [cap, t, this.dense, 0]);
    s.run(LUMP_COUNT, [this.ctl], [1], [cap, 0, 0, 0]);
    // the individuals: those whose ranks went die, the rest follow their bins; newly dense bins' members are born
    const k = s.kind(this.spec.name), K = k.capacity;
    s.run(LUMP_SWEEP, [k.body, k.alloc, remap, B], cover(g, K), [K, cap, (k.field.bin + 1) * K, (k.field.rank + 1) * K]);
    s.bear(this.spec.name, dn, cap, `
let key = lbins[parent]; let e = lbins[BCAP + parent]; let T = lbins[2u * BCAP + parent] & ~DENSE;
let rank = lbins[3u * BCAP + parent] + k;
let p = lplace(key, e, lsigma(key, e, T, rank));
child_set_x(slot, p.x); child_set_y(slot, p.y);
child_set_key(slot, key); child_set_e(slot, e); child_set_tt(slot, T); child_set_rank(slot, rank); child_set_bin(slot, parent);`,
    { bufs: [{ name: "lbins", buf: B }, { name: "inp", buf: this.inp }], wgsl: `${core}\n${BC}` });
    this.cur = 1 - this.cur;
    this.log.push({ t, promos: this.promos, inp: this.inpWords });
    if (this.log.length > this.history) this.dropped = this.log.shift()!.t;
    this.births = [];
    this.promos = [];
  }

  // ---------- observing ----------
  async read(): Promise<Bin[]> {
    this.store.flush();
    const ctl = new Uint32Array(await readback(this.store.g, this.ctl)), w = new Uint32Array(await readback(this.store.g, this.tables[this.cur])), cap = this.cap;
    return Array.from({ length: ctl[0] }, (_, i) => ({ key: w[i], e: w[cap + i], T: (w[2 * cap + i] & ~DENSE) >>> 0, out: w[3 * cap + i], dense: (w[2 * cap + i] & DENSE) !== 0 }));
  }
  // Member rank's identity in a bin (sigma).
  identity(b: { key: number; e: number; T: number }, rank: number): number {
    return feistel(rank, b.T, fkeys(this.seed, b.e, b.key, 0));
  }
  // Where a member stands in its cell, by its identity.
  place(key: number, e: number, sigma: number): { x: number; y: number } {
    const h = philox([key, sigma, e, 0xfffffffe], [this.seed, 0x80000000]), cell = key >>> 16;
    return { x: (cell % N) * CELL_MM + (h[0] % CELL_MM), y: Math.floor(cell / N) * CELL_MM + (h[1] % CELL_MM) };
  }
  // A member's fate, replaying its bin's promotions and splits from the step after it entered: the step it left at
  // and where it went, or null while it is still there. Throws for a bin entered before the oldest step the log keeps.
  fate(b: { key: number; e: number; T: number }, rank: number): Fate {
    if (b.e < this.dropped) throw new Error(`lumped ${this.spec.name}: the steps after a bin entered at ${b.e} are gone from the fate log (kept from after ${this.dropped})`);
    let out = 0;
    const state = b.key & 0xffff;
    for (const st of this.log) {
      if (st.t <= b.e) continue;
      for (let r = 0; r < st.promos.length; r += 3) {
        if (st.promos[r] !== b.key || st.promos[r + 1] !== b.e) continue;
        const take = Math.min(st.promos[r + 2], b.T - out);
        if (rank < out + take) return { t: st.t, state: PROMOTED };
        out += take;
      }
      if (out === b.T) return null;
      const sp = this.spec.ts(b.key >>> 16, state, st.t, st.inp);
      rinit(this.seed, b.e, b.key, st.t);
      const c = multinom(b.T - out, sp.t);
      for (let j = 0; j < c.length; j++) {
        if (sp.s[j] === state) continue;
        if (rank < out + c[j]) return { t: st.t, state: sp.s[j] };
        out += c[j];
      }
    }
    return null;
  }

  // ---------- riding the landing: the control words and the entry of the oldest bin ----------
  words() { return 9; }
  record(out: GPUBuffer, at: number) {
    this.store.encode((e) => {
      e.copyBufferToBuffer(this.ctl, 0, out, at * 4, 32);
      e.copyBufferToBuffer(this.tables[this.cur], this.cap * 4, out, (at + 8) * 4, 4);
    });
  }
  land(o: Uint32Array, at: number) {
    this.bins = o[at];
    if (o[at + 4] || o[at + 5]) throw new Error(`lumped ${this.spec.name}: ${o[at + 4]} bins and ${o[at + 5]} departures found no room (capacity ${this.cap} bins, ${this.ccap} contributions)`);
    if (this.bins) while (this.log.length && this.log[0].t <= o[at + 8]) this.dropped = this.log.shift()!.t;
  }
  // Steps the fate log holds.
  get logged(): number {
    return this.log.length;
  }
}
