// The island's seeds and seedlings, resident on the GPU. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md,
// Unit 8; the law is wgsl/seedlings.ts, its constants and drivers src/sim/seeds.ts (docs/research/plant-constants.md
// sec. 13).
//
// Representations (the plan's Capacity and Representation):
// - Seeds are streamed: each seed a parent sheds is evaluated on its own in the day's shed kernel, from its parent's
//   identity, the year and its number; those that live to come up are stored only as their texel's count of seed in
//   the soil (pend, one run of texels a layer), and nothing else of a seed is kept.
// - Seedlings are lumped, in store kind "seedling": a bin is a texel's members of one kind come up on one day, sharing
//   every input of their law and so one state; their fates each day are drawn exactly for the bin (the binomial) and
//   each member keeps its identity (the bin and its rank in the bin's Feistel permutation). The cited crops make some
//   10^9 ash seedlings after a mast on seed 1, past what 4 GB holds as active objects; lumped they take a few words a
//   texel and kind.
// Fields of a bin, each a u32: texel, the 18.75 m texel it stands in (wgsl/stems.ts); what, its row (the stems' row of its
// kind) and GRAD once it is to stand up; born, the island day it came up; n, its live members; n0, those it came up
// with; q and peak, as a stem's (a mass's fourth root, kg^(1/4) x 2^20).
//
// Once a day at midnight, after the stems' law has filed their crown raster, the law: yesterday's marked bins stand up
// as stems of kind plant (flora.ts holds them; they take the busy texels' room there), every bin grows, starves, is
// browsed and marked, the day's sheds and suckers land, the layers due come up as new bins, and every texel's bins are
// thinned to their room. What the CPU reads back each law day: the census (bins and members by kind, those to stand up,
// the seed in the soil by layer).
import type { Store, Kind, KindSpec, Field, Rider } from "./store";
import { reload, savedArray, savedNumber, savedNumbers } from "./store";
import { FLORA, SPECIES } from "../terrain/flora";
import { cover, storage } from "./kernel";
import type { Flora } from "./flora";
import { PLANT } from "./flora";
import { TEXELS } from "./wgsl/stems";
import { HOUR } from "../sim/ticks";
import { LANDING } from "../sim/lanes";
import {
  CENSUS, CENSUS_WORDS, LAYER, LAYERS, MODE, SD, SD_WORDS, SEED_ROWS, WORK, WORK_WORDS, emergeInit, gradExtra, GRAD_INIT,
  seedBlocks, seedCensus, seedCount, seedEmerge, seedFile, seedFlag, seedGradCount, seedGradKill, seedGrow, seedList, seedShed, seedSuckers, seedThin,
  type BinLayout, type PlantLayout, type SeedLawWords,
} from "./wgsl/seedlings";

export { BLOCK_CELLS, BLOCKS_SIDE, LAYER, ROW_OF, SEED_ROWS, YOUNG_WORDS } from "./wgsl/seedlings";

// The law's constants (src/sim/seeds.ts seedLaw): the WGSL's words, and each layer's row, mass on coming up (q), shed
// window [from, to) and day of coming up (days of the island year; -1 for the suckers, which come up the day they
// arrive), the years between shed and coming up, and for ash's two layers the parity of the year they fell in.
export type Layer = { row: number; q0: number; from: number; to: number; up: number; lag: number; parity: number };
export type SeedLaw = SeedLawWords & { yearDays: number; layers: readonly Layer[]; browse: Uint32Array };
// What the law reads from the sim each day (src/sim/seeds.ts seedDriver).
// young(t): the day's coefficients by cell; ahead(t), when given, works out a share of the next day's after tick t (the
// day, and young holding its words from 0 up to hi), so they go to the GPU before the day comes and its law has less
// to work out and send.
export type SeedAhead = { t: number; young: Int32Array; hi: number };
export type SeedDriver = { law: SeedLaw; dry(): Uint32Array; stand(): Uint32Array; young(t: number): Int32Array; ahead?(t: number): SeedAhead | null };
export type Census = { bins: number[]; members: number[]; grads: number; gradMembers: number; pend: number[] };

export const SEEDLING = "seedling";
// The bins' first room [design: seed 1 holds none in its first three island days]. Before each law day the room grows,
// by half or to what it needs, wherever the bins standing and a texel's worth for every layer coming up that day would
// pass it (roomFor: a layer's coming up bears at most a bin a texel, wgsl/seedlings.ts emergence, so the first day
// one comes up takes it to 2^20 or more, 37.7 MB of body and allocation a 2^20), so no bin is ever past it.
export const BIN_CAP = 1 << 12;
// Suckering stumps taken a day [design]; more wait for the next day.
const REQUESTS = 1024;
const U = (name: string, unit: string): Field => ({ name, type: "u32", unit, scale: 1 });
const BIN_FIELDS: Field[] = [
  U("texel", "texel index"), U("what", "stems' row, + 256 to stand up"), U("born", "island day"), U("n", "live members"), U("n0", "members come up"),
  { name: "q", type: "u32", unit: "kg^(1/4)", scale: 2 ** 20 }, { name: "peak", type: "u32", unit: "kg^(1/4)", scale: 2 ** 20 },
];
const SHED_MODE = [MODE.seeds, MODE.seeds, MODE.seeds, MODE.seeds, MODE.berry, MODE.daughter];
// A day's seed is shed over this many landings, the first ones of the day [design: the seed of a mast year, billions, a
// landing's share of it at a time], or over as many as the day has when it has fewer.
const SLICES = 32;
// A shed under way: its layer, kind, year, its day in the window and the window's length, and the list it reads.
type Shed = { layer: number; row: number; year: number; dd: number; S: number; list: number };
const at = (k: Kind, name: string) => (1 + k.field[name]) * k.capacity;
const read64 = (o: Uint32Array, w: number) => o[w] + o[w + 1] * 2 ** 32;

export class Seedlings implements Rider {
  readonly name = "seedlings";
  store: Store | null = null;
  private flora: Flora | null = null;
  private driver: SeedDriver | null = null;
  // the parent lists and their workgroup counts: two for the seed of the kinds shedding at once (oak and ash in
  // October), one for the brambles; room, the most parents each holds
  private bufs: { sd: GPUBuffer; pend: GPUBuffer; work: GPUBuffer; plists: GPUBuffer[]; args: GPUBuffer[]; req: GPUBuffer } | null = null;
  private room: number[] = [];
  private sheds: Shed[] = [];
  private slices = 1;
  private src: Record<string, string> = {};
  private ran = false;
  private requests: number[] = [];
  // Bins marked to stand up at the last law day's landing: their members stand up as stems at the next.
  private grads = 0;
  // Stems the young have stood up as, all told: texels the stems' law looks over beyond the generator's (flora busy).
  private born = 0;
  // The most bins' slots in use: the tail the last landing read back, with every emergence since at its most.
  private standing = 0;
  // cap: the bins' first room (BIN_CAP; tests take less).
  constructor(readonly cap = BIN_CAP) {}
  census: Census | null = null;

  // The seedlings take up residence on a store whose flora is resident: kind seedling declared, the drivers written,
  // and the daily law run after the stems'.
  attach(store: Store, flora: Flora, driver: SeedDriver) {
    if (this.store) throw new Error("the seedlings already live on a store");
    if (flora.store !== store) throw new Error("the seedlings need the flora resident on their store first");
    store.adopt({ name: SEEDLING, capacity: this.cap, still: true, fields: BIN_FIELDS } satisfies KindSpec);
    this.store = store;
    this.flora = flora;
    this.driver = driver;
    const g = store.g, sd = new Uint32Array(SD_WORDS);
    sd.set(driver.stand(), SD.stand);
    sd.set(driver.law.browse, SD.browse);
    sd.set(driver.dry(), SD.dry);
    // a list's room: the most stems of a shedding kind the generator laid, and all the stems' room beyond
    const plantK = store.kind(PLANT), f = flora.f, by = new Map<number, number>();
    let laid = 0;
    for (let k = 0; k < f.n; k++) if (FLORA[f.kind[k]] === "tree" || FLORA[f.kind[k]] === "bush") { laid++; by.set(f.species[k], (by.get(f.species[k]) ?? 0) + 1); }
    const most = (sps: readonly string[]) => Math.max(0, ...sps.map((sp) => by.get(SPECIES.indexOf(sp as (typeof SPECIES)[number])) ?? 0)) + plantK.capacity - laid;
    this.room = [most(["pine", "oak", "ash"]), most(["pine", "oak", "ash"]), most(["berry"])];
    this.slices = Math.min(SLICES, Math.max(1, Math.floor(driver.law.dayTicks / LANDING)));
    this.bufs = {
      sd: storage(g, sd), pend: storage(g, LAYERS * TEXELS * 4), work: storage(g, WORK_WORDS * 4),
      plists: this.room.map((r) => storage(g, (1 + r) * 4)), args: this.room.map(() => storage(g, 16, GPUBufferUsage.INDIRECT)), req: storage(g, (1 + 3 * REQUESTS) * 4),
    };
    const law = driver.law;
    store.law({ name: "seedlings", due: (t) => t % law.dayTicks === 0, run: (s, t) => this.day(s, t) });
    // the next day's words worked out a share at a time, on each hour of the day but midnight
    if (driver.ahead) store.law({ name: "seedlings ahead", due: (t) => t % law.dayTicks !== 0 && t % HOUR === 0, run: (_, t) => { const a = driver.ahead!(t); if (a) this.send(a.t, a.young, a.hi); } });
    store.law({ name: "seed shed", due: (t) => this.sheds.length > 0 && t % law.dayTicks !== 0 && t % LANDING === 0 && (t % law.dayTicks) / LANDING < this.slices, run: (s, t) => this.shed(s, (t % law.dayTicks) / LANDING) });
    store.ride(this);
  }
  // The young words of day t on the GPU from word 0 up to upto (only the day's law reads them, so the next day's go out
  // over the hours after it).
  private sent = { t: -1, upto: 0 };
  private send(t: number, young: Int32Array, hi: number) {
    if (this.sent.t !== t) this.sent = { t, upto: 0 };
    const lo = this.sent.upto;
    if (hi > lo) this.store!.g.device.queue.writeBuffer(this.bufs!.sd, (SD.young + lo) * 4, young.buffer, young.byteOffset + lo * 4, (hi - lo) * 4);
    this.sent.upto = Math.max(lo, hi);
  }
  // A felled or burned stump's suckers (mm, and an identity word): they come up at the next law day.
  sucker(x: number, y: number, id: number) {
    this.requests.push(x >>> 0, y >>> 0, id >>> 0);
  }

  private plantLayout(k: Kind): PlantLayout {
    return { cap: k.capacity, x: at(k, "x"), y: at(k, "y"), what: at(k, "what"), size: at(k, "size"), seed: at(k, "seed"), q: at(k, "q"), peak: at(k, "peak"), crop: at(k, "crop") };
  }
  private binLayout(k: Kind): BinLayout {
    return { cap: k.capacity, texel: at(k, "texel"), what: at(k, "what"), born: at(k, "born"), n: at(k, "n"), n0: at(k, "n0"), q: at(k, "q"), peak: at(k, "peak") };
  }
  private kernels(s: Store) {
    if (this.src.grow) return this.src;
    const L = this.driver!.law, plant = this.plantLayout(s.kind(PLANT)), bins = this.binLayout(s.kind(SEEDLING));
    this.src = {
      flag: seedFlag(plant), shed: seedShed(plant, L), suckers: seedSuckers(L), emerge: seedEmerge(L),
      ...Object.fromEntries(this.room.map((r, k) => [`list${k}`, seedList(plant.cap, r)])),
      grow: seedGrow(bins, L), count: seedCount(bins), file: seedFile(bins, L), thin: seedThin(bins, L), census: seedCensus(bins),
      gcount: seedGradCount(bins), gkill: seedGradKill(bins), gextra: gradExtra(L),
    };
    return this.src;
  }
  kernelSources(): string[] {
    const s = this.store!, L = this.driver!.law, { gextra, ...src } = this.kernels(s), animal = s.kinds.find((k) => k.name === "animal");
    const { tables } = this.flora!.stemBuffers(), pend = this.bufs!.pend;
    return [
      ...Object.values(src), s.birthKernel(SEEDLING, PLANT, GRAD_INIT, { bufs: [{ name: "tables", buf: tables }], wgsl: gextra }),
      ...(animal ? [seedBlocks({ cap: animal.capacity, x: at(animal, "x"), y: at(animal, "y"), sp: at(animal, "sp") })] : []),
      ...L.layers.map((ly, layer) => s.birthKernel(null, SEEDLING, emergeInit(layer, ly.row, ly.q0, L.dayTicks), { bufs: [{ name: "pend", buf: pend }], wgsl: "" })),
    ];
  }

  // ---------- a day ----------
  // The bins' room for the day's emergences: a texel's worth for each layer coming up today past the slots in use, the
  // room grown to that or by half (the lumped kinds' rule, tiers/lumped.ts), whichever is more; the kernels built on the
  // old room made again.
  private roomFor(s: Store, ups: number) {
    const bins = s.kind(SEEDLING);
    if (bins.peek.fresh) this.standing = bins.peek.tail;
    const need = this.standing + ups * TEXELS;
    if (need > bins.capacity) {
      s.grow(bins, Math.max(need, Math.ceil((bins.capacity * 3) / 2048) * 1024));
      this.src = {};
    }
    this.standing = need;
  }
  private day(s: Store, t: number) {
    const L = this.driver!.law, g = s.g, b = this.bufs!, flora = this.flora!;
    const day = Math.floor(t / L.dayTicks), doy = day % L.yearDays, year = Math.floor(day / L.yearDays);
    const suckers = this.requests.length > 0;
    const due = (ly: Layer) => (ly.up < 0 ? suckers : doy === ly.up && (ly.parity < 0 || ((year - ly.lag) & 1) === ly.parity));
    this.roomFor(s, L.layers.filter(due).length);
    const src = this.kernels(s), plant = s.kind(PLANT), bins = s.kind(SEEDLING), { start, list } = flora.raster(), { tables, rows } = flora.stemBuffers();
    const young = this.driver!.young(t);
    this.send(t, young, young.length);
    s.encode((e) => e.clearBuffer(b.work));
    // yesterday's marked bins stand up as stems
    if (this.grads > 0) {
      const cnt = s.borrow(bins.capacity);
      s.run(src.gcount, [bins.body, cnt], cover(g, bins.capacity));
      s.births(SEEDLING, PLANT, cnt, GRAD_INIT, { bufs: [{ name: "tables", buf: tables }], wgsl: src.gextra }, true);
      s.giveBack(cnt);
      s.run(src.gkill, [bins.body], cover(g, bins.capacity));
      this.grads = 0;
    }
    // the deer and rabbits by block, then a day of every bin
    const animal = s.kinds.find((k) => k.name === "animal");
    if (animal) {
      const blocks = seedBlocks({ cap: animal.capacity, x: at(animal, "x"), y: at(animal, "y"), sp: at(animal, "sp") });
      s.run(blocks, [animal.body, b.work], cover(g, animal.capacity));
    }
    s.run(src.grow, [bins.body, start, list, tables, rows, b.sd, b.work], cover(g, bins.capacity), [day, 0, 0, 0]);
    // the day's sheds: each kind's shedding parents listed, the brambles' shed at once, the trees' seed over the day's
    // first landings
    let lists = 0;
    L.layers.forEach((ly, layer) => {
      if (layer === LAYER.sucker || doy < ly.from || doy >= ly.to || (ly.parity >= 0 && (year & 1) !== ly.parity)) return;
      const mode = SHED_MODE[layer], k = mode === MODE.seeds ? lists++ : 2, m = s.borrow(plant.capacity), kept = s.borrow(plant.capacity);
      s.run(src.flag, [plant.body, rows, m, kept], cover(g, plant.capacity), [ly.row, mode, 0, 0]);
      const total = s.scan(m, plant.capacity);
      s.run(src[`list${k}`], [kept, m, total, b.plists[k], b.args[k]], cover(g, plant.capacity));
      s.giveBack(m, kept);
      if (mode === MODE.seeds) this.sheds.push({ layer, row: ly.row, year, dd: doy - ly.from, S: ly.to - ly.from, list: k });
      else s.run(src.shed, [plant.body, b.plists[k], b.sd, b.pend], { buffer: b.args[k], offset: 0 }, [ly.row, layer, year, 0, 1, mode, 0, 1]);
    });
    if (this.sheds.length) this.shed(s, 0);
    // the suckers asked for
    if (suckers) {
      const take = this.requests.splice(0, 3 * REQUESTS), n = take.length / 3;
      g.device.queue.writeBuffer(b.req, 0, Uint32Array.from([n, ...take]));
      s.run(src.suckers, [b.req, b.sd, b.pend], [n], [day, 0, 0, 0]);
    }
    // the layers coming up today, each a bin a texel holding any
    L.layers.forEach((ly, layer) => {
      if (!due(ly)) return;
      const cnt = s.borrow(TEXELS);
      s.run(src.emerge, [b.pend, start, list, cnt], cover(g, TEXELS), [layer, layer === LAYER.pine ? 1 : 0, 0, 0]);
      s.bear(SEEDLING, cnt, TEXELS, emergeInit(layer, ly.row, ly.q0, L.dayTicks), { bufs: [{ name: "pend", buf: b.pend }], wgsl: "" }, true);
      s.giveBack(cnt);
      s.encode((e) => e.clearBuffer(b.pend, layer * TEXELS * 4, TEXELS * 4));
    });
    // every texel's bins thinned to its room
    const count = s.scratch("seedtcount", TEXELS + 1), cursor = s.scratch("seedtcursor", TEXELS), tlist = s.borrow(3 * bins.capacity);
    s.encode((e) => { e.clearBuffer(count, 0, (TEXELS + 1) * 4); e.clearBuffer(cursor, 0, TEXELS * 4); });
    s.run(src.count, [bins.body, count], cover(g, bins.capacity));
    s.scan(count, TEXELS + 1);
    s.run(src.file, [bins.body, count, cursor, tlist, tables], cover(g, bins.capacity));
    s.run(src.thin, [bins.body, count, tlist, tables], cover(g, bins.capacity));
    s.giveBack(tlist);
    s.run(src.census, [bins.body, b.pend, b.work], cover(g, Math.max(bins.capacity, TEXELS)));
    bins.touched = bins.stale = true;
    this.ran = true;
  }
  // Slice j of the day's sheds under way (the last ends them).
  private shed(s: Store, j: number) {
    const b = this.bufs!, src = this.kernels(s), plant = s.kind(PLANT);
    for (const h of this.sheds) s.run(src.shed, [plant.body, b.plists[h.list], b.sd, b.pend], { buffer: b.args[h.list], offset: 0 }, [h.row, h.layer, h.year, h.dd, h.S, MODE.seeds, j, this.slices]);
    if (j === this.slices - 1) this.sheds = [];
  }
  // Whether today's seed is still being shed (over the day's first landings).
  get shedding() { return this.sheds.length > 0; }

  // The GPU memory the seedlings' own buffers take (the bins' kind and the store's scratch besides), bytes.
  bytes() {
    const b = this.bufs;
    return b ? [b.sd, b.pend, b.work, b.req, ...b.plists, ...b.args].reduce((n, v) => n + v.size, 0) : 0;
  }
  // ---------- riding the store: the census after a law day; saved, the seed in the soil and what waits ----------
  words() { return this.ran ? CENSUS_WORDS : 0; }
  record(out: GPUBuffer, at: number) {
    if (!this.ran) return;
    const w = this.bufs!.work;
    this.store!.encode((e) => e.copyBufferToBuffer(w, WORK.census * 4, out, at * 4, CENSUS_WORDS * 4));
  }
  land(o: Uint32Array, at: number) {
    if (!this.ran) return;
    this.ran = false;
    const c = o.subarray(at, at + CENSUS_WORDS), R = SEED_ROWS.length;
    this.census = {
      bins: Array.from({ length: R }, (_, r) => c[CENSUS.bins + r]), members: Array.from({ length: R }, (_, r) => read64(c, CENSUS.members + 2 * r)),
      grads: c[CENSUS.grads], gradMembers: read64(c, CENSUS.gradMembers), pend: Array.from({ length: LAYERS }, (_, l) => read64(c, CENSUS.pend + 2 * l)),
    };
    this.grads = this.census.grads;
    // the stems they become may take texels no stem held: the stems' law looks over that many more
    if (this.census.gradMembers) { this.born += this.census.gradMembers; this.flora!.busy(this.census.gradMembers); }
  }
  // the seed in the soil, and the trees' parent lists and workgroup counts a shed under way reads (a save between the
  // day's slices)
  buffers(): [string, GPUBuffer][] {
    const b = this.bufs;
    return b ? [["pend", b.pend], ["plist0", b.plists[0]], ["plist1", b.plists[1]], ["args0", b.args[0]], ["args1", b.args[1]]] : [];
  }
  save() { return { grads: this.grads, born: this.born, requests: this.requests, sheds: this.sheds.map((h) => [h.layer, h.row, h.year, h.dd, h.S, h.list]) }; }
  restore(state: unknown, data: Record<string, Uint8Array> = {}) {
    this.grads = savedNumber(state, "grads", this.name);
    this.born = savedNumber(state, "born", this.name);
    this.flora!.busy(this.born);
    this.requests = savedArray(state, "requests", this.name).map(Number);
    this.sheds = savedArray(state, "sheds", this.name).map((v) => {
      const [layer, row, year, dd, S, list] = savedNumbers(v, "seedlings shed");
      return { layer, row, year, dd, S, list };
    });
    const b = this.bufs!, g = this.store!.g;
    reload(g, b.pend, data.pend, "seedlings pend");
    for (const k of [0, 1]) { reload(g, b.plists[k], data[`plist${k}`], "seedlings parents"); reload(g, b.args[k], data[`args${k}`], "seedlings parents' workgroups"); }
  }
  // Lets go of the buffers the seedlings made (the store's own go with the store).
  destroy() {
    const b = this.bufs;
    if (!b) return;
    for (const v of [b.sd, b.pend, b.work, b.req, ...b.plists, ...b.args]) v.destroy();
    this.bufs = null;
  }
}

