// Deadwood and clasts, resident on the GPU, piece by piece. Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md,
// Unit 9; laws and constants: docs/research/plant-constants.md sec. 12; kernels: wgsl/deadwood.ts.
//
// Representations (Capacity and Representation in the plan):
// - Logs and snags are dormant: store kind "log", one object a dead tree, with its place, birth hour and the rot
//   running sum of its cell then (born, arot), its kind (what, a SPECIES index), length and diameter in mm, its own
//   decay and fall words (u, uf) and its fall rate (fr). Its state at any hour (gone, a snag, a log) is a function of
//   them and the rot recorded over its cell since its birth (wgsl/deadwood.ts), so querying it equals stepping it
//   hourly. Every tree the stems' law starves or crowds out (wgsl/stems.ts) is born a snag where it stood; the world
//   begins with the reserves' pool, each piece a copy of a tree of its stand. One touched becomes an active "logup"
//   with the state it had, and the dormant one goes.
// - Sticks are dormant bins (the plan's decision, as 2 x 10^8 stored members would take some 4 GB): store kind
//   "stickbin", one object a cell's litterfall of one birth, with its count n; member k of a bin is drawn from its
//   identity (cell, born, k) and lies until its word says it has rotted. A stick taken is listed (gone) and never
//   comes back; new sticks come only from litterfall, every BIN_DAYS days from the cover the crowns kept over the cell.
// - Boulders, stones and pebbles are static dormant (tiers/dormant.ts StaticDormant): a count a cell from the
//   generator (src/terrain/flora.ts clasts), nothing stored until one is moved.
//
// What the CPU reads. A piece's state needs the rot sum over its cell at the newest hour: every landing after a day's
// law brings back every cell's sum and the rot each hour adds until the next day's law (rotGather), so the sum at any
// later hour is exact arithmetic. Bins and logs come from the mirror's pages of the cells round people.
import { CELL, N } from "../terrain/grid";
import { SPECIES, TILES, crownShare, dbhOf, type Scatter } from "../terrain/flora";
import { cover, storage } from "./kernel";
import { PENDING, type Obj, type Pending } from "./mirror";
import { type Field, type Kind, type Rider, type Store, genOfId, reload, savedArray, slotOfId } from "./store";
import type { Raster } from "./flora";
import { binhalf, next32, rinit, unif, nlnu } from "./rand";
import { mul64, mulhi, qdiv, qexp, qmul, qpow, round16 } from "./fixed";
import { CELLS, CELL_MM } from "./wgsl/index";
import { TEXEL_MM } from "./wgsl/stems";
import { Drivers } from "./tiers/drivers";
import { DAY, HOUR, YEAR_DAYS } from "../sim/ticks";
import { StaticDormant, cellAt as cellOf } from "./tiers/dormant";
import { dormantAnchors } from "./wgsl/dormant";
import type { Extra } from "./wgsl/alloc";
import { drvAccess } from "./wgsl/drivers";
import { FIXED } from "./wgsl/fixed";
import { RAND } from "./wgsl/rand";
import {
  BIN_BIRTH, HSTEP, HT, LEVELS, LOG_STREAM, ROT_WRITE, SQUARES, STICK_STREAM, type ClastLaw, type DeadLaw, type PlantAt,
  binSweep, clastBody, common, deadCover, deadStems, initialLogs, litter, logBirth, logSweep, rotGather,
} from "./wgsl/deadwood";

// ---------- constants (plant-constants sec. 12) ----------
// A game year's hours (YEAR_DAYS days, src/sim/ticks.ts).
export const YEAR_HOURS = YEAR_DAYS * 24;
// The rot of an hour under a closed canopy, in units [design: the resolution of the canopy's effect], and how much
// faster wood rots in the open: about 10% more mass lost in canopy gaps than under the canopy, across leaf litter, stakes
// and logs over three to fourteen years (Forrester et al., R751) [derived: as a rate].
export const ROT = 128, GAP_GAIN = 0.1;
// Rates of mass loss a year: fine woody debris on the surface under oak 0.17 to 0.25 (R452), its middle; logs: Scots
// pine 0.032 (Herrmann, Kahl and Bauhus, R753), aspen 0.066 (Shorohova and Kapitsa, R754); oak and ash [gap: pine's
// and beech's 0.054 (R753) stand in, oak's ring-porous wood rotting slower and ash faster than beech's]. A piece goes
// whole at its class's rate, so the pool's mass is input / rate [derived].
export const STICK_K = 0.2;
export const LOG_K: Record<string, number> = { pine: 0.032, oak: 0.032, ash: 0.054, aspen: 0.066 };
// Snags: half of a pine's 40 cm snags are down 16 years after it died, of a broadleaf's 28 (Huggard and Kremsater's
// synthesis, lodgepole pine and deciduous, R755), the time to fall scaling as diameter^0.60 (their 33 studies) [derived:
// as a constant rate].
export const SNAG_T50: Record<string, number> = { pine: 16, oak: 28, ash: 28, aspen: 28 };
export const SNAG_DBH_EXP = 0.6;
// Fine woody debris (1 to 10 cm) in southern Swedish oak woods, 12.2 m3 a ha (Nordén et al., R750): as sticks a metre
// long, the 17,000 a ha the generator notes count, each 3.02 cm thick [derived; the spread of their sizes is a gap].
export const STICKS_HA = 17000, STICK_LEN = 1, STICK_DIA = Math.sqrt((4 * 12.2) / (Math.PI * STICKS_HA * STICK_LEN));
// Deadwood in unmanaged European reserves: 94 m3 a ha of logs and 39 of snags, the mean of Christensen et al.'s Table 1
// (R752; Danish reserves 48 to 154 of logs).
export const LOGS_HA = 94, SNAGS_HA = 39;
// Litterfall comes as bins of this many days [design: memory; sec. 12 has the measure].
export const BIN_DAYS = 10;
// Clasts: surface boulders of 2 dm and more in a 314 m2 plot, by SLU's count classes (R756), as a class's middle for each
// drift [design]: bare rock 31 to 50, sandy till 11 to 20, clay till 1 to 5, none in sorted meltwater sand or under peat.
// Sizes follow till's N(> d) ~ d^-2.9 (Hooke and Iverson, R757 [abs]) from 2 cm up to the widest boulder, 5.5 m [gap].
export const BOULDERS_HA = [40.5, 3, 15.5, 0, 0].map((n) => (n * 1e4) / 314.16);
export const CLAST_DIM = 2.9;
export const CLASTS = [
  { kind: "pebble", lo: 20, hi: 100, stream: 0xc1a0 },
  { kind: "stone", lo: 100, hi: 200, stream: 0xc1b0 },
  { kind: "boulder", lo: 200, hi: 5500, stream: 0xc1c0 },
] as const;
export type ClastKind = (typeof CLASTS)[number]["kind"];

const K40 = (perHour: number) => Math.round(perHour * 2 ** 40);
const TREE_KINDS = ["pine", "oak", "ash", "aspen"] as const;
const CELL_HA = (CELL * CELL) / 1e4;

// The law as the kernels and twins have it, for a world's seed.
export function deadLaw(seed: number): DeadLaw {
  const logK: number[] = [], fallK: number[] = [], rows: number[] = [];
  SPECIES.forEach((sp, i) => {
    const r = TREE_KINDS.indexOf(sp as (typeof TREE_KINDS)[number]);
    rows[i] = r < 0 ? 4 : r;
    logK[i] = r < 0 ? 0 : K40(LOG_K[sp] / YEAR_HOURS / ROT);
    fallK[i] = r < 0 ? 0 : K40(Math.LN2 / (SNAG_T50[sp] * YEAR_HOURS));
  });
  return {
    seed, rot: ROT, gain: Math.round(ROT * GAP_GAIN * 2 ** 16), stick: K40(STICK_K / YEAR_HOURS / ROT), logK, fallK, rows,
    snagQ: Math.round((SNAGS_HA / (LOGS_HA + SNAGS_HA)) * 65536),
    litter: Math.round(((STICK_K * STICKS_HA * CELL_HA) / YEAR_DAYS) * 65536), pool: Math.round(STICKS_HA * CELL_HA * ROT),
  };
}
export const ROT_MAX = ROT + Math.ceil(ROT * GAP_GAIN);

// ---------- twins of the kernels' law ----------
export function lam(i: number, k: number): number {
  const p = mul64(i >>> 0, k >>> 0);
  return p[1] >= 0x800000 ? 0x7fffffff : ((p[0] >>> 24) | (p[1] << 8)) >>> 0;
}
// Whether a piece of word u still lies under Lambda l.
export const lasts = (u: number, l: number) => u >>> 16 < qexp(-l) >>> 0;
// A log's state: 0 gone, 1 a snag, 2 a log.
export function logState(L: DeadLaw, v: Record<string, number>, rotNow: number, hour: number): 0 | 1 | 2 {
  if (!lasts(v.u, lam((rotNow - v.arot) >>> 0, L.logK[Math.min(v.what, 31)]))) return 0;
  return v.fr !== 0 && lasts(v.uf, lam((hour - v.born) >>> 0, v.fr)) ? 1 : 2;
}
// Member k of a stick bin of a cell born at an hour: its place in mm and its word.
export function stickOf(seed: number, cell: number, born: number, k: number) {
  rinit(seed, STICK_STREAM, (cell + k * 65536) >>> 0, born);
  const x = (cell % N) * CELL_MM + unif(CELL_MM), y = Math.floor(cell / N) * CELL_MM + unif(CELL_MM);
  return { x, y, u: next32() };
}
// A clast class's law for the kernels and the twin.
export function clastLaw(seed: number, c: (typeof CLASTS)[number]): ClastLaw {
  return { seed, stream: c.stream, lo: c.lo, hi: c.hi, r1q: Math.round((1 - (c.lo / c.hi) ** CLAST_DIM) * 2 ** 32) >>> 0, dimq: Math.round(65536 / CLAST_DIM) };
}
// The 2^LEVELS leaf counts of a cell's members of a class, in leaf order (x bit first), from its halvings.
export function leafCounts(c: ClastLaw, cell: number, n: number): Uint32Array {
  const out = new Uint32Array(1 << LEVELS);
  const split = (node: number, m: number, depth: number, leaf: number) => {
    if (depth === LEVELS) { out[leaf] = m; return; }
    rinit(c.seed, c.stream + 1, cell, node);
    const left = binhalf(m);
    split(node * 2, left, depth + 1, leaf * 2);
    split(node * 2 + 1, m - left, depth + 1, leaf * 2 + 1);
  };
  split(1, n, 0, 0);
  return out;
}
// The square (ix, iy) of a leaf in leaf order: its path's bits alternate x and y, first bit first.
export function squareOf(leaf: number): [number, number] {
  let ix = 0, iy = 0;
  for (let l = 0; l < LEVELS; l++) {
    const bit = (leaf >>> (LEVELS - 1 - l)) & 1;
    if ((l & 1) === 0) ix = ix * 2 + bit; else iy = iy * 2 + bit;
  }
  return [ix, iy];
}
// Member k of a cell's class lying in square (ix, iy): its place, diameter (mm) and word, the stream already past the
// halvings (as the body leaves it).
export function clastIn(c: ClastLaw, cell: number, k: number, ix: number, iy: number) {
  const [x, y] = clastPlace(c, cell, k, ix, iy);
  return { x, y, ...clastRest(c) };
}
// A clast's diameter (mm) and word, drawn next on its stream after its place.
function clastRest(c: ClastLaw) {
  const v = (0xffffffff - mulhi(next32(), c.r1q)) >>> 0;
  const e = qmul(round16(nlnu(v)), c.dimq);
  return { dia: Math.min((c.lo * (qexp(e) >>> 0)) >>> 16, c.hi - 1), seed: next32() };
}
// The place in mm of member k of a cell's class lying in square (ix, iy), its stream left at its diameter's draw.
export function clastPlace(c: ClastLaw, cell: number, k: number, ix: number, iy: number): [number, number] {
  rinit(c.seed, c.stream, k, cell);
  const x0 = (cell % N) * CELL_MM, y0 = Math.floor(cell / N) * CELL_MM;
  const sx0 = Math.floor((ix * CELL_MM) / SQUARES), sx1 = Math.floor(((ix + 1) * CELL_MM) / SQUARES);
  const sy0 = Math.floor((iy * CELL_MM) / SQUARES), sy1 = Math.floor(((iy + 1) * CELL_MM) / SQUARES);
  return [x0 + sx0 + unif(sx1 - sx0), y0 + sy0 + unif(sy1 - sy0)];
}
// The twin of the body (StaticSpec ts): member k by its halvings.
function clastTwin(c: ClastLaw, counts: Uint32Array) {
  return (cell: number, k: number) => {
    let n = counts[cell], lo = 0, node = 1, ix = 0, iy = 0;
    for (let l = 0; l < LEVELS; l++) {
      rinit(c.seed, c.stream + 1, cell, node);
      const left = binhalf(n), right = k - lo >= left;
      if (right) { lo += left; n -= left; } else n = left;
      node = node * 2 + (right ? 1 : 0);
      if ((l & 1) === 0) ix = ix * 2 + (right ? 1 : 0); else iy = iy * 2 + (right ? 1 : 0);
    }
    return clastIn(c, cell, k, ix, iy);
  };
}
// A snag's fall rate (times 2^40 an hour) by its kind and diameter (mm), as the birth kernel has it.
export function fallRate(L: DeadLaw, what: number, dia: number): number {
  const ratio = qdiv(400 << 16, Math.max(dia, 1) << 16), f = mul64(L.fallK[Math.min(what, 31)], qpow(ratio, Math.round(SNAG_DBH_EXP * 65536)) >>> 0);
  return Math.max(((f[0] >>> 16) | (f[1] << 16)) >>> 0, 1);
}

// ---------- tables ----------
// A tree's diameter at breast height in mm by its height, HT entries of HSTEP mm a tree row (fuel.ts's trunk: flora.ts
// dbhOf), and the pool's logs and snags a whole texel of a closed stand of trees of that height lays, Q16.16: the
// reserves' volume over the volume of one, a cylinder of its diameter as long as it is tall (fuel.ts LOG pieces) [derived].
export function tables() {
  const dbh = new Uint32Array(4 * HT), pool = new Uint32Array(4 * HT), texel = (TEXEL_MM / 1000) ** 2;
  TREE_KINDS.forEach((sp, r) => {
    for (let h = 0; h < HT; h++) {
      const m = (h * HSTEP) / 1000, d = h ? dbhOf(sp, m) / 100 : 0;
      dbh[r * HT + h] = Math.round(d * 1000);
      const v = (Math.PI / 4) * d * d * m;
      pool[r * HT + h] = v > 0 ? Math.min(0x7fffffff, Math.round((((LOGS_HA + SNAGS_HA) / 1e4) * texel * 65536) / v)) : 0;
    }
  });
  return { dbh, pool };
}

// ---------- capacities ----------
// Room for the island's pieces [design: the expected count with a margin]: logs, the pool the world begins with (each
// tree's expected share) and a tenth of its trees dying since; bins, the bins expected to stand at once at the stands'
// cover (each lasts until its last stick rots: about H(n) mean lives, n its sticks) and one a cell for the pool.
export function capacities(f: Scatter) {
  const covered = new Float64Array(CELLS);
  let logs = 0, trees = 0;
  const STEP_TILE = TILES / N;
  for (let k = 0; k < f.n; k++) {
    if (f.kind[k] !== 0) continue;
    const sp = SPECIES[f.species[k]], h = f.size[k], a = crownShare(sp, h), d = dbhOf(sp, h) / 100;
    logs += (((LOGS_HA + SNAGS_HA) / 1e4) * a) / ((Math.PI / 4) * d * d * h);
    trees++;
    const cx = Math.min(N - 1, Math.floor(f.px[k] / STEP_TILE)), cy = Math.min(N - 1, Math.floor(f.py[k] / STEP_TILE));
    covered[cy * N + cx] += a;
  }
  let bins = 0;
  const perBin = (STICK_K * STICKS_HA * CELL_HA * BIN_DAYS) / YEAR_DAYS;
  for (let c = 0; c < CELLS; c++) {
    const lam = Math.min(1, covered[c] / (CELL * CELL)) * perBin;
    if (lam > 0) bins += (YEAR_DAYS / BIN_DAYS / STICK_K) * (lam >= 1 ? Math.log(lam) + 0.5772 : lam);
  }
  return { logs: Math.ceil(1.3 * logs + 0.1 * trees) + 4096, bins: Math.ceil(1.25 * bins) + CELLS + 4096 };
}

// ---------- the kinds ----------
const U = (name: string, unit: string): Field => ({ name, type: "u32", unit, scale: 1 });
const LOG_FIELDS: Field[] = [
  U("born", "hour"), U("arot", "rot running sum at birth"), U("what", "SPECIES index"), { name: "len", type: "u32", unit: "m", scale: 1000 },
  { name: "dia", type: "u32", unit: "m", scale: 1000 }, U("u", "decay word"), U("uf", "fall word"), U("fr", "fall rate an hour, times 2^40"),
];
const BIN_FIELDS: Field[] = [U("born", "hour"), U("arot", "rot running sum at birth"), U("n", "sticks born")];
const STICKUP_FIELDS: Field[] = [U("born", "hour"), U("arot", "rot running sum at birth"), U("cellk", "cell x 2^16 + member"), U("u", "decay word")];

// A piece as the CPU sees it: what it is, its identity (a string the world names it by), place in mm, size and
// thickness in m, its tree's SPECIES index (0 for none) and a word of variation.
export type PieceKind = "stick" | "fallen_log" | ClastKind;
export type Piece = { kind: PieceKind; id: string; x: number; y: number; size: number; girth: number; species: number; seed: number };
// Where a piece came from, to find it again: a stick by (cell, born, k), a log by its dormant id, a clast by (cell, k).
type Origin = { t: "s"; cell: number; born: number; k: number } | { t: "l"; id: number } | { t: "c"; c: number; cell: number; k: number };

export class Deadwood implements Rider {
  readonly name = "deadwood";
  readonly law: DeadLaw;
  store: Store | null = null;
  drivers: Drivers | null = null;
  clasts: StaticDormant[] = [];
  private raster: (() => Raster) | null = null;
  private bufs: { cover: GPUBuffer; rot: GPUBuffer; acc: GPUBuffer; dbh: GPUBuffer; pool: GPUBuffer; gone: GPUBuffer; st: GPUBuffer } | null = null;
  private gone = new Set<string>(); // sticks taken, by `${cellk},${born}`
  private taken = new Map<string, Set<number>>(); // the same, the members of each bin by `${cell},${born}`
  private held = new Map<string, Obj | number | null>(); // pieces touched: what each became (null: taken), by piece id
  private sync = true; // the next landing brings the rot sums
  private sums: Uint32Array | null = null;
  private rotNow: Uint32Array | null = null;
  private sumsHour = 0;
  private recordedHour = 0;
  private members = new Map<string, Uint32Array>(); // stick bins' members as drawn, x, y, u by k, by `${cell},${born}`
  private leaves = new Map<string, Uint32Array>(); // clasts' leaf counts, by `${class},${cell}`

  // law: the constants as deadLaw has them (a test may speed them up).
  constructor(readonly seed: number, readonly counts: Record<ClastKind, Uint32Array>, readonly room: { logs: number; bins: number }, law = deadLaw(seed)) {
    this.law = law;
  }

  // ---------- on the GPU ----------
  // The deadwood takes up residence on a store holding the flora (attached first, so its stems' law runs ahead of
  // this one each day). A store that hasn't got the kinds yet gets the pool the world begins with, laid from the
  // stems as they stand now.
  attach(store: Store, raster: () => Raster) {
    if (this.store) throw new Error("the deadwood already lives on a store");
    const fresh = !store.kinds.some((k) => k.name === "log");
    this.store = store;
    this.raster = raster;
    store.adopt({ name: "log", capacity: this.room.logs, placed: true, still: true, fields: LOG_FIELDS });
    store.adopt({ name: "logup", capacity: 1 << 16, placed: true, still: true, fields: [...LOG_FIELDS, U("oslot", "log slot"), U("ogen", "log generation")] });
    store.adopt({ name: "stickbin", capacity: this.room.bins, placed: true, still: true, fields: BIN_FIELDS });
    store.adopt({ name: "stickup", capacity: 1 << 16, placed: true, still: true, fields: STICKUP_FIELDS });
    this.drivers = new Drivers(store, { name: "deadrot", channels: [{ name: "rot", unit: `1/${ROT} of an hour of rot under a closed canopy`, scale: ROT, bound: ROT_MAX }], hours: 24 });
    this.clasts = CLASTS.map((c) => {
      const law = clastLaw(this.seed, c);
      return new StaticDormant(store, {
        name: c.kind, capacity: 1 << 16, counts: this.counts[c.kind], seed: this.seed, stream: c.stream,
        attrs: [{ name: "dia", type: "u32", unit: "m", scale: 1000 }, U("seed", "variation")], wgsl: clastBody(law), ts: clastTwin(law, this.counts[c.kind]),
      });
    });
    const g = store.g, t = tables();
    this.bufs = {
      cover: storage(g, CELLS * 4), rot: storage(g, new Uint32Array(CELLS).fill(ROT)), acc: storage(g, CELLS * 4),
      dbh: storage(g, t.dbh), pool: storage(g, t.pool), gone: storage(g, 4), st: storage(g, 4),
    };
    store.ride(this);
    if (fresh) this.pool();
    store.law({ name: "deadwood", due: (tick) => tick % HOUR === 0, run: (_, tick) => this.hour(tick) });
  }
  private plantAt(): PlantAt {
    const k = this.store!.kind("plant"), at = (f: string) => (1 + k.field[f]) * k.capacity;
    return { cap: k.capacity, x: at("x"), y: at("y"), what: at("what"), size: at("size") };
  }
  // The pool the world begins with: the cover from today's raster, the logs and snags of every tree's share, and every
  // cell's standing sticks, all born now.
  private pool() {
    const s = this.store!, g = s.g, b = this.bufs!, r = this.raster!(), plant = s.kind("plant");
    s.run(this.src("cover", () => deadCover(this.law)), [r.crowns, b.cover, b.rot, b.acc], cover(g, CELLS), [0, 0, 0, 0]);
    const cnt = s.scratch("counts", plant.capacity);
    s.encode((e) => e.clearBuffer(cnt, 0, plant.capacity * 4));
    s.run(initialLogs(this.law), [r.start, r.list, b.pool, plant.body, cnt], cover(g, plant.capacity), [0, (1 + plant.field.what) * plant.capacity, 0, 0]);
    this.bearLogs(cnt, plant, true);
    this.litterfall(true);
  }
  private bearLogs(cnt: GPUBuffer, plant: Kind, initial: boolean) {
    this.store!.bear("log", cnt, plant.capacity, ...this.logBorn(initial));
  }
  // what bear runs for a log born (initial: of the pool the world begins with), and what it binds
  private logBorn(initial: boolean): [string, Extra] {
    const d = this.drivers!, b = this.bufs!, plant = this.store!.kind("plant");
    return [`${logBirth(this.law, this.plantAt(), initial)}\n${dormantAnchors(["rot"])}`, {
      bufs: [{ name: "pl", buf: plant.body }, { name: "dbh", buf: b.dbh }, { name: "drv", buf: d.ring }],
      wgsl: `${FIXED}\n${RAND}\n${common(this.law)}\n${drvAccess(d.layout)}`,
    }];
  }
  private litterfall(pool: boolean) {
    const s = this.store!, g = s.g, b = this.bufs!, d = this.drivers!;
    const nn = s.scratch("deadnn", CELLS), cnt = s.scratch("deadbins", CELLS);
    s.run(this.src("litter", () => litter(this.law)), [b.acc, b.cover, b.rot, nn, cnt], cover(g, CELLS), [pool ? 1 : 0, d.hour, 0, 0]);
    s.bear("stickbin", cnt, CELLS, ...this.binBorn(nn));
  }
  // what bear runs for a stick bin born, and what it binds
  private binBorn(nn: GPUBuffer): [string, Extra] {
    const d = this.drivers!;
    return [`${BIN_BIRTH}\n${dormantAnchors(["rot"])}`, { bufs: [{ name: "nn", buf: nn }, { name: "drv", buf: d.ring }], wgsl: drvAccess(d.layout) }];
  }
  kernelSources(): string[] {
    const s = this.store!, d = this.drivers!, law = this.law;
    return [
      d.writer(ROT_WRITE, 1), this.src("stems", () => deadStems(law)), s.birthKernel(null, "log", ...this.logBorn(false)),
      this.src("cover", () => deadCover(law)), this.src("litter", () => litter(law)), s.birthKernel(null, "stickbin", ...this.binBorn(s.scratch("deadnn", CELLS))),
      this.src("bins", () => binSweep(law, s.kind("stickbin"), d.layout)), this.src("logs", () => logSweep(law, s.kind("log"), d.layout)), this.src("gather", () => rotGather(d.layout)),
    ];
  }
  // An hour of the deadwood: the hour's rot recorded and committed; on a day, after the stems' law, a snag born of every
  // stem it killed, the cover and rot from its raster, a litterfall every BIN_DAYS days, and the pieces rotted away
  // let go.
  private hour(t: number) {
    const s = this.store!, g = s.g, b = this.bufs!, d = this.drivers!;
    d.write(ROT_WRITE, [b.rot]);
    d.advance();
    if (t % DAY !== 0) return;
    const plant = s.kind("plant"), cnt = s.scratch("counts", plant.capacity);
    s.run(this.src("stems", () => deadStems(this.law)), [plant.body, cnt], cover(g, plant.capacity), [plant.capacity, (1 + plant.field.crop) * plant.capacity, (1 + plant.field.what) * plant.capacity, 0]);
    this.bearLogs(cnt, plant, false);
    const r = this.raster!();
    s.run(this.src("cover", () => deadCover(this.law)), [r.crowns, b.cover, b.rot, b.acc], cover(g, CELLS), [1, 0, 0, 0]);
    if ((t / DAY) % BIN_DAYS === 0) this.litterfall(false);
    this.sweepBins(t / DAY);
    this.sweepLogs(true);
    this.sync = true;
  }
  // Every bin's sticks counted, the total and each bin's count (by slot) in scratch; or with kill set to a day, that
  // day's share of the bins (slots of its number modulo BIN_DAYS) swept and the empty let go, nothing counted.
  sweepBins(kill: number | null): { tot: GPUBuffer; each: GPUBuffer } {
    const s = this.store!, k = s.kind("stickbin"), d = this.drivers!;
    const tot = s.scratch("deadtot", 1), each = s.scratch("deadeach", k.capacity);
    s.encode((e) => e.clearBuffer(tot, 0, 4));
    const rows = kill === null ? k.capacity : Math.ceil(k.capacity / BIN_DAYS);
    s.run(this.src("bins", () => binSweep(this.law, k, d.layout)), [k.body, k.alloc, d.ring, this.bufs!.gone, tot, each], cover(s.g, rows, 64), [k.capacity, kill === null ? 0 : 1, (kill ?? 0) % BIN_DAYS, BIN_DAYS]);
    // the dead rows the index still holds are passed over (mirror.ts), and their slots reclaimed when births next touch
    // the kind, so a sweep doesn't rebuild the index
    if (kill !== null) k.stale = true;
    return { tot, each };
  }
  // Every log's state into a scratch buffer by slot (0 gone, 1 snag, 2 log, 3 no log), the gone let go when kill.
  sweepLogs(kill: boolean): GPUBuffer {
    const s = this.store!, k = s.kind("log"), d = this.drivers!, st = s.scratch("deadst", k.capacity);
    s.run(this.src("logs", () => logSweep(this.law, k, d.layout)), [k.body, k.alloc, d.ring, st], cover(s.g, k.capacity), [k.capacity, kill ? 1 : 0, 0, 0]);
    if (kill) k.stale = true;
    return st;
  }
  // A stick listed taken, by `${cell 2^16 + k},${born}`.
  private take(key: string) {
    this.gone.add(key);
    const [w, born] = key.split(",").map(Number), bin = `${w >>> 16},${born}`;
    let set = this.taken.get(bin);
    if (!set) this.taken.set(bin, (set = new Set()));
    set.add(w & 0xffff);
  }
  // A kernel's source, made once (the store finds its pipeline by source, and these are long).
  private readonly sources = new Map<string, string>();
  private src(name: string, make: () => string): string {
    let s = this.sources.get(name);
    if (s === undefined) this.sources.set(name, (s = make()));
    return s;
  }
  private uploadGone() {
    const keys = [...this.gone].map((k) => k.split(",").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const words = new Uint32Array(1 + 2 * keys.length);
    words[0] = keys.length;
    keys.forEach(([w, born], i) => { words[1 + 2 * i] = w; words[2 + 2 * i] = born; });
    this.store!.retire(this.bufs!.gone);
    this.bufs!.gone = storage(this.store!.g, words);
  }

  // ---------- riding the store ----------
  words() { return this.sync ? 2 * CELLS : 0; }
  record(out: GPUBuffer, at: number) {
    if (!this.sync) return;
    this.recordedHour = this.drivers!.hour;
    this.store!.run(this.src("gather", () => rotGather(this.drivers!.layout)), [this.drivers!.ring, this.bufs!.rot, out], cover(this.store!.g, CELLS), [at, 0, 0, 0]);
  }
  land(o: Uint32Array, at: number) {
    if (!this.sync) return;
    this.sync = false;
    this.sums = o.slice(at, at + CELLS);
    this.rotNow = o.slice(at + CELLS, at + 2 * CELLS);
    this.sumsHour = this.recordedHour;
  }
  buffers(): [string, GPUBuffer][] {
    const b = this.bufs!;
    return [["cover", b.cover], ["rot", b.rot], ["acc", b.acc]];
  }
  save() {
    return { gone: [...this.gone], held: [...this.held].map(([id, o]) => [id, o === null || typeof o === "number" ? o : o.id]) };
  }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    const b = this.bufs!, g = this.store!.g;
    reload(g, b.cover, data.cover, "deadwood cover");
    reload(g, b.rot, data.rot, "deadwood rot");
    reload(g, b.acc, data.acc, "deadwood litter");
    this.gone = new Set();
    this.taken.clear();
    for (const k of savedArray(state, "gone", this.name)) this.take(String(k));
    this.held = new Map(savedArray(state, "held", this.name).map((row) => {
      const [id, obj] = row as [string, number | null];
      return [id, obj === null || obj >= 0 ? obj : this.store!.mirror.spawned(obj) ?? obj];
    }));
    this.uploadGone();
    this.sync = true;
  }
  // What a renderer needs to draw the pieces from the GPU as the kernels have them (wgsl/deadwood.ts LOG_STATE,
  // STICK_MEMBER and clastBody): the law, the rot's ring and layout, the taken sticks' list and each clast class's
  // counts, gone list and store kind. The gone lists are new buffers after every take or lift, so ask again each frame.
  drawBuffers() {
    if (!this.bufs || !this.drivers) throw new Error("the deadwood isn't resident on a store");
    return {
      law: this.law, drv: { ring: this.drivers.ring, layout: this.drivers.layout }, gone: this.bufs.gone,
      clasts: CLASTS.map((c, i) => ({ kind: c.kind, law: clastLaw(this.seed, c), counts: this.clasts[i].counts, gone: this.clasts[i].goneList, kindName: c.kind })),
    };
  }
  bytes(): number {
    const s = this.store!, kinds = ["log", "logup", "stickbin", "stickup", ...CLASTS.map((c) => c.kind)].map((n) => s.kind(n));
    let n = this.drivers!.bytes() + this.clasts.reduce((t, c) => t + c.bytes(), 0);
    for (const b of Object.values(this.bufs!)) n += b.size;
    for (const k of kinds) n += k.body.size + k.alloc.size + (k.order?.size ?? 0) + (k.start?.size ?? 0);
    return n;
  }
  destroy() {
    if (!this.bufs) return;
    for (const b of Object.values(this.bufs)) b.destroy();
    this.bufs = null;
    this.drivers?.destroy();
    for (const c of this.clasts) c.destroy();
  }

  // ---------- reading on the CPU ----------
  // The hours committed so far.
  get hourNow() { return this.drivers?.hour ?? 0; }
  // A cell's rot running sum at the newest committed hour, or PENDING until the first landing has brought the sums.
  rotAt(cell: number): number | Pending {
    if (!this.sums || !this.rotNow) return PENDING;
    return (this.sums[cell] + Math.imul(this.hourNow - this.sumsHour, this.rotNow[cell])) >>> 0;
  }
  // The sticks lying in a cell at the newest hour within a box of mm (inclusive; the whole cell if none given), or PENDING
  // (its bins not landed, or the sums).
  sticksIn(cell: number, x0 = 0, y0 = 0, x1 = Infinity, y1 = Infinity): Piece[] | Pending {
    const rot = this.rotAt(cell);
    if (rot === PENDING) return PENDING;
    const page = this.store!.mirror.cell("stickbin", cell % N, Math.floor(cell / N));
    if (page === PENDING) return PENDING;
    const out: Piece[] = [];
    for (const bin of page) {
      const { born, arot, n } = bin.v, key = `${cell},${born}`;
      let m = this.members.get(key);
      if (!m) {
        m = new Uint32Array(3 * n);
        for (let k = 0; k < n; k++) { const s = stickOf(this.seed, cell, born, k); m[3 * k] = s.x; m[3 * k + 1] = s.y; m[3 * k + 2] = s.u; }
        if (this.members.size > 4096) this.members.delete(this.members.keys().next().value!);
        this.members.set(key, m);
      }
      const e = qexp(-lam((rot - arot) >>> 0, this.law.stick)) >>> 0, taken = this.taken.get(key);
      for (let k = 0; k < n; k++) {
        const x = m[3 * k], y = m[3 * k + 1];
        if (x < x0 || x > x1 || y < y0 || y > y1 || m[3 * k + 2] >>> 16 >= e || taken?.has(k)) continue;
        out.push({ kind: "stick", id: `s${cell}.${born}.${k}`, x: m[3 * k], y: m[3 * k + 1], size: STICK_LEN, girth: STICK_DIA, species: 0, seed: m[3 * k + 2] });
      }
    }
    return out;
  }
  // The fallen logs lying in a cell at the newest hour (snags stand apart: not yet things anyone sees [gap]).
  logsIn(cell: number): Piece[] | Pending {
    const rot = this.rotAt(cell);
    if (rot === PENDING) return PENDING;
    const page = this.store!.mirror.cell("log", cell % N, Math.floor(cell / N));
    if (page === PENDING) return PENDING;
    const out: Piece[] = [];
    for (const o of page) if (logState(this.law, o.v, rot, this.hourNow) === 2) out.push(this.logPiece(o));
    return out;
  }
  private logPiece(o: Obj): Piece {
    return { kind: "fallen_log", id: `l${o.id}`, x: o.v.x, y: o.v.y, size: o.v.len / 1000, girth: o.v.dia / 1000, species: o.v.what, seed: o.v.u };
  }
  // A class's clasts lying in a cell within a box of mm (inclusive), square by square.
  clastsIn(kind: ClastKind, cell: number, x0: number, y0: number, x1: number, y1: number): Piece[] {
    const ci = CLASTS.findIndex((c) => c.kind === kind), c = CLASTS[ci], law = clastLaw(this.seed, c), n = this.counts[kind][cell];
    if (!n) return [];
    const leaves = this.leavesOf(ci, law, cell, n);
    const cx0 = (cell % N) * CELL_MM, cy0 = Math.floor(cell / N) * CELL_MM, out: Piece[] = [], sd = this.clasts[ci];
    for (let leaf = 0, k = 0; leaf < leaves.length; k += leaves[leaf], leaf++) {
      if (!leaves[leaf]) continue;
      const [ix, iy] = squareOf(leaf);
      const sx0 = cx0 + Math.floor((ix * CELL_MM) / SQUARES), sx1 = cx0 + Math.floor(((ix + 1) * CELL_MM) / SQUARES);
      const sy0 = cy0 + Math.floor((iy * CELL_MM) / SQUARES), sy1 = cy0 + Math.floor(((iy + 1) * CELL_MM) / SQUARES);
      if (sx1 <= x0 || sx0 > x1 || sy1 <= y0 || sy0 > y1) continue;
      for (let j = k; j < k + leaves[leaf]; j++) {
        if (sd.lifted(cell, j)) continue;
        const [x, y] = clastPlace(law, cell, j, ix, iy);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const m = clastRest(law);
        out.push({ kind, id: `${kind[0]}${cell}.${j}`, x, y, size: m.dia / 1000, girth: m.dia / 1000, species: 0, seed: m.seed });
      }
    }
    return out;
  }
  // How many of a class's clasts lie in a cell within rm mm of a point, and how far off the nearest lies (mm, Infinity
  // for none): squares wholly within counted whole, the rest member by member, by place alone.
  clastsAround(kind: ClastKind, cell: number, x: number, y: number, rm: number): { count: number; nearest: number } {
    const ci = CLASTS.findIndex((c) => c.kind === kind), law = clastLaw(this.seed, CLASTS[ci]), n = this.counts[kind][cell], sd = this.clasts[ci];
    let count = 0, nearest = Infinity;
    if (!n) return { count, nearest };
    const leaves = this.leavesOf(ci, law, cell, n), cx0 = (cell % N) * CELL_MM, cy0 = Math.floor(cell / N) * CELL_MM;
    // the squares the circle reaches, nearest first, so whole ones past the nearest found are counted, not drawn
    const reach: [near: number, far: number, leaf: number, k: number][] = [];
    for (let leaf = 0, k = 0; leaf < leaves.length; k += leaves[leaf], leaf++) {
      if (!leaves[leaf]) continue;
      const [ix, iy] = squareOf(leaf);
      const sx0 = cx0 + Math.floor((ix * CELL_MM) / SQUARES), sx1 = cx0 + Math.floor(((ix + 1) * CELL_MM) / SQUARES);
      const sy0 = cy0 + Math.floor((iy * CELL_MM) / SQUARES), sy1 = cy0 + Math.floor(((iy + 1) * CELL_MM) / SQUARES);
      const near = Math.hypot(Math.max(sx0 - x, 0, x - sx1), Math.max(sy0 - y, 0, y - sy1));
      if (near <= rm) reach.push([near, Math.hypot(Math.max(x - sx0, sx1 - x), Math.max(y - sy0, sy1 - y)), leaf, k]);
    }
    reach.sort((a, b) => a[0] - b[0]);
    for (const [near, far, leaf, k] of reach) {
      const [ix, iy] = squareOf(leaf);
      if (far <= rm && near >= nearest) { for (let j = k; j < k + leaves[leaf]; j++) if (!sd.lifted(cell, j)) count++; continue; }
      for (let j = k; j < k + leaves[leaf]; j++) {
        if (sd.lifted(cell, j)) continue;
        const [px, py] = clastPlace(law, cell, j, ix, iy), d = Math.hypot(px - x, py - y);
        if (d <= rm) { count++; nearest = Math.min(nearest, d); }
      }
    }
    return { count, nearest };
  }
  private leavesOf(ci: number, law: ClastLaw, cell: number, n: number) {
    const key = `${ci},${cell}`;
    let leaves = this.leaves.get(key);
    if (!leaves) {
      leaves = leafCounts(law, cell, n);
      if (this.leaves.size > 8192) this.leaves.delete(this.leaves.keys().next().value!);
      this.leaves.set(key, leaves);
    }
    return leaves;
  }
  // A piece by its id as it lies now: null once it is gone (taken, rotted, moved into something else), PENDING when
  // the mirror or the sums haven't landed.
  piece(id: string): Piece | null | Pending {
    if (this.held.has(id)) return null;
    const o = this.origin(id);
    if (!o) return null;
    if (o.t === "c") {
      const c = CLASTS[o.c];
      if (o.k >= this.counts[c.kind][o.cell] || this.clasts[o.c].lifted(o.cell, o.k)) return null;
      const m = this.clasts[o.c].member(o.cell, o.k);
      return m && "v" in m ? { kind: c.kind, id, x: m.v.x, y: m.v.y, size: m.v.dia / 1000, girth: m.v.dia / 1000, species: 0, seed: m.v.seed } : null;
    }
    if (o.t === "s") {
      const at = this.members.get(`${o.cell},${o.born}`), x = at?.[3 * o.k], y = at?.[3 * o.k + 1];
      const list = x === undefined || y === undefined ? this.sticksIn(o.cell) : this.sticksIn(o.cell, x, y, x, y);
      return list === PENDING ? list : list.find((p) => p.id === id) ?? null;
    }
    const obj = this.store!.mirror.get(o.id), rot = obj && obj !== PENDING ? this.rotAt(cellOf(obj.v.x, obj.v.y)) : PENDING;
    if (obj === null) return null;
    if (obj === PENDING || rot === PENDING) return PENDING;
    return logState(this.law, obj.v, rot, this.hourNow) === 2 ? this.logPiece(obj) : null;
  }
  private origin(id: string): Origin | null {
    const t = id[0], parts = id.slice(1).split(".").map(Number);
    if (t === "s" && parts.length === 3) return { t, cell: parts[0], born: parts[1], k: parts[2] };
    if (t === "l" && parts.length === 1) return { t, id: parts[0] };
    const c = CLASTS.findIndex((x) => x.kind[0] === t);
    if (c >= 0 && parts.length === 2) return { t: "c", c, cell: parts[0], k: parts[1] };
    return null;
  }
  // The GPU id of the object a log piece is now (its dormant log, or the logup it became once touched), for what
  // reads a log's own state (gpu/moisture.ts); undefined for anything else, one taken, or one whose spawn waits.
  gpuId(id: string): number | undefined {
    const o = this.origin(id);
    if (o?.t !== "l") return undefined;
    const held = this.held.get(id);
    if (held === undefined) return o.id;
    const n = held === null ? -1 : typeof held === "number" ? held : held.id;
    return n >= 0 ? n : undefined;
  }

  // ---------- changing ----------
  // A piece touched: it is no longer dormant. A stick or a clast moved or changed goes active at its place (the
  // stickup or its class's kind), a log as the logup holding the state it had; taken (place null) it is stored nowhere
  // and gone for good. Either way the dormant member never comes back.
  touch(p: Piece, place: { x: number; y: number } | null) {
    const s = this.store!, o = this.origin(p.id), was = this.held.get(p.id);
    if (!o) throw new Error(`no piece ${p.id}`);
    if (was === null) return;
    if (was !== undefined) {
      const id = typeof was === "number" ? was : was.id;
      if (place) { s.set(id, "x", place.x); s.set(id, "y", place.y); } else s.kill(id);
      return;
    }
    if (o.t === "s") {
      this.take(`${(o.cell * 65536 + o.k) >>> 0},${o.born}`);
      this.uploadGone();
      const bins = s.mirror.cell("stickbin", o.cell % N, Math.floor(o.cell / N)), bin = bins === PENDING ? undefined : bins.find((b) => b.v.born === o.born);
      if (place) this.held.set(p.id, s.spawn("stickup", { ...place, born: o.born, arot: bin?.v.arot ?? 0, cellk: (o.cell * 65536 + o.k) >>> 0, u: p.seed }));
      else this.held.set(p.id, null);
      return;
    }
    if (o.t === "l") {
      const rec = s.mirror.get(o.id);
      if (rec === PENDING || rec === null) throw new Error(`log ${o.id} isn't in the mirror to be touched`);
      s.kill(o.id);
      if (place) this.held.set(p.id, s.spawn("logup", { ...rec.v, ...place, oslot: slotOfId(o.id), ogen: genOfId(o.id) }));
      else this.held.set(p.id, null);
      return;
    }
    const obj = this.clasts[o.c].lift(o.cell, o.k, place ?? undefined);
    if (!place) s.kill(obj.id);
    this.held.set(p.id, place ? obj : null);
  }
}
