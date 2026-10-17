// The smallest things, resident on the GPU: grass tillers and reed shoots, fine litter, invertebrates and soil fauna, and
// moved sand, four lumped kinds on tiers/lumped.ts. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md,
// Unit 12b; research note docs/research/generator/2026-10-16-lumped.md; laws src/gpu/wgsl/smalls.ts, constants, tables,
// drivers and the laws' twins src/sim/smalls.ts (plant-constants sec. 14, animal-constants sec. 14).
//
// Each kind merges its bins after every step (one bin a key; tiers/lumped.ts), its law reading the inputs the GPU
// writes each day, so nothing of the day's crosses to the CPU but a summary for the CPU's fire and a few control words.
// Members singled out become individuals of the kind's active kind: a tuft, a leaf, a bug or a grain, keeping the
// identity and state they had as members and stepping under the same law.
//
// The animals graze the tillers and eat the invertebrates through the Ground link (gpu/animals.ts): each day the link
// writes the animals' pools from the census, less what is still owed; what they ate since it last wrote is shared over
// the cells it came from and taken by the next day's split as bites, grazed blades and eaten prey, chances set so the
// expected loss is the amount; the binomial's difference is carried as each cell's credit, so over days what the
// animals ate is what the bins lost. A held predator's request to single out a member is the fauna's take at the next
// step.
import type { Store, Rider } from "./store";
import { reload, savedArray, savedNumber, savedNumbers } from "./store";
import { cover, readback, storage } from "./kernel";
import { Lumped, PROMOTED, SPLIT_BINS, type Split } from "./tiers/lumped";
import type { Ground } from "./animals";
import { T as TILES } from "./wgsl/animals";
import { FIXED } from "./wgsl/fixed";
import {
  BASE, CELLS, CEN, CENW, CW, DAYW, EW, LB, STATIC_WORDS, STW, TB, WROTE, SMALLS_NONE, SMALLS_POOLS, SMALLS_SETTLE,
  faunaLaw, litterLaw, sandLaw, smallsCensus, smallsEaten, smallsInputs, smallsLitterBirths, smallsSplit, tillerLaw, X,
  type SmallsConsts, type Win,
} from "./wgsl/smalls";

type Twin = (cell: number, state: number, tick: number, inp: Uint32Array) => Split;
// What the laws read from the sim (src/sim/smalls.ts smallsDriver), so this module needs none of it.
export type SmallsDriver = {
  seed: number;
  law: SmallsConsts; tables: Uint32Array;
  // the static words of every cell (STATIC_WORDS a cell), each taxon's K (members, 16 a cell) by the crowns' pine and
  // broadleaf shares of each cell, and the leaves a cell's full canopy sheds a year (by attached class, on its day)
  statics(): Uint32Array; K(pine: Float32Array, broad: Float32Array): Uint32Array;
  leaf: readonly { cls: number; start: number; input: number }[];
  // the day's words of every cell (DAYW a cell) on island day d
  day(d: number): Uint32Array;
  // the members the island starts with: (cell, state, count) triples for each kind
  start(d: number, pine: Float32Array, broad: Float32Array): { tiller: number[]; litter: number[]; fauna: number[] };
  twins: { tiller: Twin; litter: Twin; fauna: Twin; sand: Twin };
  pieceUg: readonly number[]; bladeUnits: number; reedLeaves: number; reedEmerge: number; reedUnder: number; foxSummer: Win;
};
// The crowns a world has (gpu/crowns.ts): their words on the GPU and as the CPU holds them.
export type Crowned = { buf: GPUBuffer | null; held(): Uint32Array | null };

export const SMALL_KINDS = ["tiller", "litter", "fauna", "sand"] as const;
export type SmallKind = (typeof SMALL_KINDS)[number];
const ACTIVE: Record<SmallKind, string> = { tiller: "tuft", litter: "leaf", fauna: "bug", sand: "grain" };
// Room for bins, a kind [design: seed 1's most bins in its first island year, 695,278 tillers, 1,581,621 litter and
// 1,340,045 fauna, none of sand, with a third more, so a landing finds no kind over the three quarters that grows its
// room (tiers/lumped.ts room); the plan's Unit 12b outcome].
export const CAPS: Record<SmallKind, number> = { tiller: 15 << 16, litter: 33 << 16, fauna: 28 << 16, sand: 1 << 14 };
// Contributions a step can hold, a bin: its stayers, departures and births [design: a litter bin's piece passes up to
// three mass classes and falls in a day, a tiller moves a class, dies or bears; seed 1 found two and a half a bin too few for the litter on a day of leaf fall and three too few for the tillers].
const CONTRIBS: Record<SmallKind, number> = { tiller: 6, litter: 5, fauna: 4, sand: 3 };
// Outcome counts a bin holds, a kind: its law's most outcomes and the births' word [derived from the laws in
// wgsl/smalls.ts: a grass tiller's ten and its daughters; litter's grazing and at most nine transient classes
// (smallsTables); a fauna stage's three predators, window, advance, death and stay, and its brood; sand's two].
const OUTS: Record<SmallKind, number> = { tiller: 11, litter: 10, fauna: 8, sand: 3 };
// Individuals singled out, a kind [design].
const ACTIVE_CAP = 4096;
// The summary the CPU reads back each day, SUMW words a cell: green lamina, standing dead blades and lying litter, each
// g/m2 of the cell in Q16 [design: what the CPU's fire reads].
export const SUMW = 3;
export type Litter = { green: number; dead: number; lying: number };

export class Smalls implements Rider, Ground {
  readonly name = "smalls";
  store: Store | null = null;
  driver: SmallsDriver | null = null;
  kinds: Record<SmallKind, Lumped> | null = null;
  private b: Record<"inp" | "dayw" | "cen" | "st" | "eat" | "tb" | "lb" | "wrote" | "sum" | "zero", GPUBuffer> | null = null;
  private src: Record<string, string> = {};
  // each lumped kind's split (sand has none)
  private splits: string[] = [];
  private crowns: Crowned | null = null;
  private link: { W: GPUBuffer; RQ: GPUBuffer; cap: number } | null = null;
  // ticks an island day (the driver's, sky.ts DAY)
  private get dayTicks() { return this.driver!.law.dayTicks; }
  // each kind's room for bins
  caps: Record<SmallKind, number> = { ...CAPS };
  last = -1;
  private summary = false;
  // whether the kinds came from a save (the store had them before attach)
  private loaded = false;
  private copied = false;
  // the summary as the CPU last landed it
  held: Uint32Array | null = null;

  // ---------- on the GPU ----------
  // The smallest things take up residence on a store: their kinds and buffers; in a store that hasn't got them, the
  // island's first members laid a year before now (tick t0) [design: before the animals' days before anyone wakes, so
  // their first days have tillers to graze]. crowns: the crown raster, when the world has one.
  attach(store: Store, driver: SmallsDriver, crowns: Crowned | null = null, t0 = store.t, caps: Partial<Record<SmallKind, number>> = {}) {
    if (this.store) throw new Error("the smallest things already live on a store");
    const fresh = !store.kinds.some((k) => k.name === "tuft");
    this.loaded = !fresh;
    const u = (name: string) => ({ name, type: "u32" as const, unit: "", scale: 1 });
    for (const k of SMALL_KINDS) store.adopt({ name: ACTIVE[k], capacity: ACTIVE_CAP, placed: true, fields: ["lkey", "le", "lsig", "lstate"].map(u) });
    this.store = store; this.driver = driver; this.crowns = crowns; this.caps = { ...CAPS, ...caps };
    const g = store.g, c = driver.law, cap = this.caps;
    this.b = {
      inp: storage(g, (BASE + CELLS * CW) * 4), dayw: storage(g, CELLS * DAYW * 4), cen: storage(g, CELLS * CENW * 4), st: storage(g, CELLS * STW * 4),
      eat: storage(g, CELLS * EW * 4), tb: storage(g, CELLS * 2 * TB * 4), lb: storage(g, CELLS * 2 * LB * 4),
      wrote: storage(g, TILES * WROTE * 4), sum: storage(g, CELLS * SUMW * 4), zero: storage(g, 16),
    };
    // the tables and every cell's static words, the taxa's K among them
    g.device.queue.writeBuffer(this.b.inp, 0, driver.tables);
    const { pine, broad } = this.shares();
    const statics = driver.statics(), K = driver.K(pine, broad), words = new Uint32Array(CELLS * CW);
    for (let i = 0; i < CELLS; i++) {
      words.set(statics.subarray(i * STATIC_WORDS, (i + 1) * STATIC_WORDS), i * CW);
      words.set(K.subarray(i * 16, (i + 1) * 16), i * CW + X.k);
    }
    g.device.queue.writeBuffer(this.b.inp, BASE * 4, words);
    const laws: Record<SmallKind, string> = { tiller: tillerLaw(c), litter: litterLaw(c), fauna: faunaLaw(c), sand: sandLaw(c) };
    const inputs = { base: BASE, cellWords: CW, tables: driver.tables };
    const make = (k: SmallKind, i: number) => {
      const split = k === "sand" ? "" : smallsSplit(laws[k], i, { pieceUg: driver.pieceUg.slice(8 * 4, 8 * 4 + 16), outs: OUTS[k] });
      if (split) this.splits.push(split);
      const L: Lumped = new Lumped(store, {
        name: k, capacity: cap[k], contribs: Math.ceil(cap[k] * CONTRIBS[k]), members: 1, seed: driver.seed, stream: 0x5a11 + i, law: laws[k], ts: driver.twins[k], outcomes: OUTS[k],
        active: ACTIVE[k], promote: "", merge: true, wide: k === "sand", inputs,
        onSplit: split ? (s, bins, cnt, t) => s.run(split, [bins, L.control, cnt, this.b!.inp, this.b!.cen], cover(s.g, L.cap), [L.cap, t, 0, 0]) : undefined,
      });
      L.input(this.b!.inp);
      return L;
    };
    this.kinds = { tiller: make("tiller", 0), litter: make("litter", 1), fauna: make("fauna", 2), sand: make("sand", 3) };
    this.src = {
      eaten: smallsEaten(),
      inputs: smallsInputs(c, { reedEmerge: driver.reedEmerge, reedUnder: driver.reedUnder, leaf: driver.leaf }),
      litterBirths: smallsLitterBirths({ bladeUnits: driver.bladeUnits, reedLeaves: driver.reedLeaves }),
      c0: smallsCensus(0, { pieceUg: driver.pieceUg, foxFrom: driver.foxSummer[0], foxTo: driver.foxSummer[1], dayTicks: this.dayTicks }),
      c1: smallsCensus(1, { pieceUg: driver.pieceUg, foxFrom: driver.foxSummer[0], foxTo: driver.foxSummer[1], dayTicks: this.dayTicks }),
      c2: smallsCensus(2, { pieceUg: driver.pieceUg, foxFrom: driver.foxSummer[0], foxTo: driver.foxSummer[1], dayTicks: this.dayTicks }),
      summary: SUMMARY,
    };
    store.ride(this);
    store.law({ name: "smalls", due: (t) => t % this.dayTicks === 0 && t !== this.last, run: (_, t) => this.slices(t) });
    if (fresh) {
      const t = Math.floor((t0 - this.dayTicks * 40) / this.dayTicks) * this.dayTicks;
      const st = driver.start(Math.floor(t / this.dayTicks) % 40, pine, broad);
      for (const k of ["tiller", "litter", "fauna"] as const) {
        const xs = st[k];
        for (let i = 0; i < xs.length; i += 3) this.kinds[k].add(xs[i], xs[i + 1], xs[i + 2]);
      }
      this.day(t);
      store.flush();
    }
  }
  kernelSources(): string[] {
    return [...Object.values(this.src), ...this.splits, SMALLS_NONE, SMALLS_SETTLE, SMALLS_POOLS];
  }
  // Each cell's share of closed pine and broadleaf canopy, from the crowns as the CPU holds them (none without).
  private shares() {
    const pine = new Float32Array(CELLS), broad = new Float32Array(CELLS), w = this.crowns?.held();
    if (w) {
      const side = 256 * 4;
      for (let c = 0; c < CELLS; c++) {
        const cx = c % 256, cy = Math.floor(c / 256);
        let p = 0, b = 0;
        for (let q = 0; q < 16; q++) { const x = w[(cy * 4 + (q >> 2)) * side + cx * 4 + (q & 3)]; p += Math.min(x & 0xffff, 4096); b += Math.min(x >>> 16, 4096); }
        pine[c] = p / 65536; broad[c] = b / 65536;
      }
    }
    return { pine, broad };
  }

  // A day at tick t (midnight): see wgsl/smalls.ts for the passes.
  day(t: number) {
    for (const _ of this.slices(t, Infinity));
  }
  // The day in slices: each lumped kind's split goes a slice at a time (tiers/lumped.ts steps), yielding between them,
  // so the store's law sends each to the GPU on its own and the play page's frames go between (store.ts beginPaced);
  // the same kernels in the same order however it is sent. day, and the animals' spin-up before anyone wakes, send each
  // split whole (bins Infinity): with no frames to let between, the slices' dispatches cost the play page's first
  // tick 10 s.
  *slices(t: number, bins = SPLIT_BINS): Generator<void> {
    const s = this.store!, g = s.g, b = this.b!, k = this.kinds!, src = this.src, d = Math.floor(t / this.dayTicks) % 40;
    if (this.link) s.run(src.eaten, [this.link.W, b.wrote, b.cen, b.eat], cover(g, TILES));
    g.device.queue.writeBuffer(b.dayw, 0, this.driver!.day(d));
    s.run(src.inputs, [b.inp, b.dayw, b.cen, b.eat, b.st, this.crowns?.buf ?? b.zero, b.tb, b.lb], cover(g, CELLS), [t >>> 0, this.crowns?.buf ? 1 : 0, 0, 0]);
    s.encode((e) => e.clearBuffer(b.cen));
    k.tiller.bornFrom(b.tb, CELLS * TB);
    yield* k.tiller.steps(t, bins);
    s.run(src.c0, [k.tiller.table, k.tiller.control, b.inp, b.cen], cover(g, k.tiller.cap), [k.tiller.cap, t >>> 0, 0, 0]);
    s.run(src.litterBirths, [b.cen, b.st, b.lb], cover(g, CELLS));
    k.litter.bornFrom(b.lb, CELLS * LB);
    yield* k.litter.steps(t, bins);
    s.run(src.c1, [k.litter.table, k.litter.control, b.inp, b.cen], cover(g, k.litter.cap), [k.litter.cap, t >>> 0, 0, 0]);
    if (this.link) k.fauna.requests(this.link.RQ, this.link.cap, PROMOTED);
    yield* k.fauna.steps(t, bins);
    if (this.link) s.run(SMALLS_NONE, [this.link.RQ], cover(g, this.link.cap), [this.link.cap, 0, 0, 0]);
    s.run(src.c2, [k.fauna.table, k.fauna.control, b.inp, b.cen], cover(g, k.fauna.cap), [k.fauna.cap, t >>> 0, 0, 0]);
    if (k.sand.bins > 0) yield* k.sand.steps(t, bins);
    s.run(SMALLS_SETTLE, [b.cen, b.st], cover(g, CELLS));
    if (this.link) s.run(SMALLS_POOLS, [this.link.W, b.wrote, b.cen, b.st], cover(g, TILES));
    s.run(src.summary, [b.cen, b.inp, b.sum], cover(g, CELLS));
    this.summary = true;
    this.last = t;
  }

  // ---------- the animals' Ground ----------
  bind(s: Store, link: { W: GPUBuffer; RQ: GPUBuffer; cap: number }, saved: boolean) {
    this.link = link;
    if (!(saved && this.loaded)) s.run(SMALLS_POOLS, [link.W, this.b!.wrote, this.b!.cen, this.b!.st], cover(s.g, TILES));
  }
  spin(_s: Store, t: number): Iterable<void> {
    return t > this.last ? this.slices(t, Infinity) : [];
  }

  // ---------- people ----------
  // The cells people stand in, watched by every kind: their bins and inputs each step kept for fates.
  watch(people: readonly { px: number; py: number }[], tileMm: number) {
    if (!this.kinds) return;
    const cells = people.map((p) => Math.min(255, Math.floor((p.py * tileMm) / 75000)) * 256 + Math.min(255, Math.floor((p.px * tileMm) / 75000))).slice(0, 64);
    for (const k of SMALL_KINDS) this.kinds[k].watch(cells);
  }
  // Someone singles out members of a kind's bin: the next count ranks of (key, e) taken at the next step, `code` as
  // their fate (PROMOTED become individuals of the kind's active kind).
  single(kind: SmallKind, key: number, e: number, count: number, code = PROMOTED) {
    this.kinds![kind].take(key, e, count, code);
  }
  // The litter and green of a cell, g/m2, as the last summary landed (null before one).
  litterAt(cell: number): Litter | null {
    const h = this.held;
    if (!h) return null;
    return { green: h[cell * SUMW] / 65536, dead: h[cell * SUMW + 1] / 65536, lying: h[cell * SUMW + 2] / 65536 };
  }
  // GPU memory the smallest things hold: the kinds' tables and the buffers here (the store's shared scratch apart).
  bytes(): number {
    let n = 0;
    for (const k of SMALL_KINDS) n += this.kinds![k].bytes();
    for (const x of Object.values(this.b!)) n += x.size;
    return n;
  }
  // The census buffer and inputs, for tests.
  get buffersForTest() { return this.b; }

  // ---------- riding the store: the day's summary; saved, every buffer but the day's ----------
  words() { return this.summary ? CELLS * SUMW : 0; }
  record(out: GPUBuffer, at: number) {
    this.copied = this.summary;
    if (!this.summary) return;
    this.store!.encode((e) => e.copyBufferToBuffer(this.b!.sum, 0, out, at * 4, CELLS * SUMW * 4));
    this.summary = false;
  }
  land(o: Uint32Array, at: number) {
    if (!this.copied || !o.length) return;
    this.held = o.slice(at, at + CELLS * SUMW);
    this.copied = false;
  }
  buffers(): [string, GPUBuffer][] {
    const b = this.b;
    return b ? [["inp", b.inp], ["cen", b.cen], ["st", b.st], ["eat", b.eat], ["wrote", b.wrote], ["sum", b.sum]] : [];
  }
  save() { return { last: this.last, held: this.held ? [...this.held] : null }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    const b = this.b!, g = this.store!.g;
    for (const [n, buf] of this.buffers()) reload(g, buf, data[n], `smalls ${n}`);
    void b;
    this.last = savedNumber(state, "last", "smalls");
    const h = (state as Record<string, unknown>).held;
    this.held = h === null ? null : Uint32Array.from(savedNumbers(savedArray(state, "held", "smalls"), "smalls summary"));
  }
  destroy() {
    if (!this.b) return;
    for (const x of Object.values(this.b)) x.destroy();
    for (const k of SMALL_KINDS) this.kinds![k].destroy();
    this.b = null;
  }
}

// The summary, per cell: green lamina, standing dead blades and lying litter, g/m2 of the cell, Q16. Bindings: cen
// (atomic), inp, sum.
const SUMMARY = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> cen: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read> inp: array<u32>;
@group(0) @binding(2) var<storage, read_write> sum: array<u32>;
fn flat(g: vec3u, n: vec3u) -> u32 { return g.x + g.y * n.x * 256u; }
${FIXED}
// a 64-bit amount over the cell's area as g/m2 Q16, the amount in units of 1 / per mg: floor(amount / per) mg, times
// 65536 over the cell's 5,625,000 mg-m2 a g/m2
fn gm2(lo: u32, hi: u32, per: u32) -> u32 {
  let mg = vec2u(divw(hi % per, lo, per).x, hi / per);
  let a = vec2u(mg.x << 16u, (mg.y << 16u) | (mg.x >> 16u));
  let d = ${75 * 75 * 1000}u;
  if (a.y / d > 0u) { return 0xffffffffu; }
  return divw(a.y, a.x, d).x;
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) n: vec3u) {
  let c = flat(gid, n);
  if (c >= ${CELLS}u) { return; }
  let ce = c * ${CENW}u;
  _ = &inp;
  let l0 = atomicLoad(&cen[ce + ${CEN.lam}u]); let h0 = atomicLoad(&cen[ce + ${CEN.lam + 1}u]);
  let l1 = atomicLoad(&cen[ce + ${CEN.lam + 2}u]); let h1 = atomicLoad(&cen[ce + ${CEN.lam + 3}u]);
  sum[c * ${SUMW}u] = gm2(l0, h0, 8u) + gm2(l1, h1, 8u);
  sum[c * ${SUMW}u + 1u] = gm2(atomicLoad(&cen[ce + ${CEN.lit + 8}u]), atomicLoad(&cen[ce + ${CEN.lit + 9}u]), 1000u);
  var lying = 0u;
  for (var k = 0u; k < 10u; k++) { if (k != 4u) { lying = lying + gm2(atomicLoad(&cen[ce + ${CEN.lit}u + 2u * k]), atomicLoad(&cen[ce + ${CEN.lit}u + 2u * k + 1u]), 1000u); } }
  sum[c * ${SUMW}u + 2u] = lying;
}`;
export { X };
