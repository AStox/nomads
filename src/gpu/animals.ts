// The island's animals, resident on the GPU: every deer, rabbit, wolf, fox, heron, eagle, gull and crow one object of
// store kind "animal", and the ground they eat from (the tiles' sward, browse, carrion, shore and invertebrates) in
// buffers beside it; the fish they take are the fish's own objects (fish.ts), laid out by tile for each step, and where
// the world has the lumped kinds (smalls.ts), the sward and the invertebrates are theirs, through the link below
// (Ground). Plan: docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Units 10 and 12b;
// the law is wgsl/animals.ts, its constants and drivers src/sim/animals.ts (docs/research/animal-constants.md).
//
// Fields, each a u32 but e: x and y in millimetres (PLACE); sp, the kind (SP) plus 16 for a female; held, 0 while the
// GPU moves it, 1 while people see it and the CPU moves it (animals.ts), 2 while it lies trapped in a pit; e, its fat
// reserve, J (i32); born, the tick it was born (mod 2^32); preg, a hind carrying a calf; grp, a wolf's pack (its
// founder's slot + 1); hx and hy, its home in mm (a rabbit's warren, a predator's or a bird's range); fed, the J people
// have given it so far, counting up, and fseen, how far of that the GPU has taken in (fed is the CPU's alone, fseen the
// GPU's alone, so neither ever overwrites the other's).
//
// The law runs every hour of island time (every 12 ticks), a day at a time in the twenty years before anyone wakes.
// What the CPU reads back each landing: how many of each kind are alive (a census, every tick). What the birds eat of
// the fish goes to the fish on the GPU (fish.ts FishLink), and what the crows, gulls and foxes eat of the
// invertebrates, and the members people see them single out, to the lumped kinds on the GPU (Ground), never through
// the CPU.
import type { Store, Kind, KindSpec, Field, Rider } from "./store";
import { reload, savedArray, savedNumbers } from "./store";
import { cover, storage } from "./kernel";
import type { FishLink } from "./fish";
import { CELLS } from "./wgsl/index";
import {
  A_, BIRTH_HEAD, BIRTH_INIT, FIELDS, FLAG, G, GK, KP_WORDS, LIVE_LAYERS, NL, NONE, NSP, PO, Q_RUNS, SATW, T, TW, W_, W_RUNS, aWords, larAt,
  animalsAct, animalsBrowse, animalsCensus, animalsClaim, animalsEat, animalsFate, animalsFront, animalsSatCols, animalsSatRows,
} from "./wgsl/animals";

export const ANIMAL = "animal";
// Room for this many animals at once [design]: seed 1's herds held some 40,000 rabbits at their median and 2,000 crows;
// young past the room are not born (wgsl/animals.ts room). The index costs in proportion to the room, every tick it is
// rebuilt.
export const ANIMAL_CAP = 1 << 17;
// Each field's unit and scale (store.ts Field).
const UNITS: Record<(typeof FIELDS)[number], [string, number]> = {
  sp: ["SP index + 16 for a female", 1], held: ["0 free, 1 seen by people, 2 trapped", 1], e: ["J", 1], born: ["tick mod 2^32", 1],
  preg: ["0 or 1", 1], grp: ["pack founder's slot + 1", 1], hx: ["m", 1000], hy: ["m", 1000], fed: ["J mod 2^32", 1], fseen: ["J mod 2^32", 1],
};
const FIELD_LIST: Field[] = FIELDS.map((name) => ({ name, type: name === "e" ? "i32" : "u32", unit: UNITS[name][0], scale: UNITS[name][1] }));

// What the law reads from the sim (src/sim/animals.ts animalDriver), so this module needs none of it.
export type AnimalDriver = {
  seed: number;
  // the ground: STATIC_RUNS runs of T words (wgsl/animals.ts W_), and the pools as they start (W_.fg to W_.wasbare)
  tiles(): Uint32Array;
  pools(): Uint32Array;
  // every day of the year's drivers, DRIVERS runs of T words a day
  drivers(): Uint32Array;
  // the constants buffer up to the step's parameters (PO words), for so many steps a day
  consts(per: number): Uint32Array;
  // the animals as the island starts, field columns of n each
  start(): { n: number; cols: Record<string, Uint32Array> };
  // a step ending at tick t: the drivers' day and the season's events (FLAG)
  step(t: number, per: number): { day: number; flags: number };
  // the island days before anyone wakes, stepped as every hour after is, ending at tick t0
  days: number;
  t0: number;
};
// The stems' crown raster as their law last filed it (src/gpu/flora.ts raster).
export type Raster = { body: GPUBuffer; cap: number; what: number; start: GPUBuffer; list: GPUBuffer; side: number };
export type Browse = { raster(s: Store): Raster; filed(t: number): boolean };
// The ground layer and the invertebrates from the lumped kinds (src/gpu/smalls.ts), when the world has them.
export type Ground = {
  // The link writes the day's pools into W (W_.fg, W_.fd: Q16 g/m2 of the tile's ground-layer area, as now;
  // W_.icrow, W_.igull, W_.ifox: mg of invertebrate prey a tile; W_.tcrow, W_.tgull, W_.tfox: the lumped bin key,
  // cell << 16 | state, a held predator of that class singles a member out of, NONE for none) now and at each day it
  // steps, and reads back how much of each pool was eaten since. RQ is one word an animal slot (NONE for none): a
  // held animal's request to single out a member, which the link takes and sets back to NONE at each day it steps.
  bind(s: Store, link: { W: GPUBuffer; RQ: GPUBuffer; cap: number }): void;
  // A day of the lumped kinds at tick t (t % DAY === 0), called by the animals' spin-up loop before its law at that
  // tick; after attach the lumped kinds' own midnight law (registered earlier on the store) runs before the animals'.
  spin(s: Store, t: number): void;
};

type Bufs = {
  W: GPUBuffer; D: GPUBuffer; KP: GPUBuffer; A: GPUBuffer; S: GPUBuffer; I: GPUBuffer; Q: GPUBuffer; TERR: GPUBuffer; N: GPUBuffer; cen: GPUBuffer; RQ: GPUBuffer;
};

export class Animals implements Rider {
  readonly name = "animals";
  store: Store | null = null;
  kind: Kind | null = null;
  private driver: AnimalDriver | null = null;
  private browse: Browse | null = null;
  private fish: FishLink | null = null;
  private ground: Ground | null = null;
  private bufs: Bufs | null = null;
  private src: Record<string, string> | null = null;
  private per = 0;
  // the land's summed-area table still to build (a law's first step builds it; it never changes)
  private landSat = true;
  private culls: number[] = [];
  // how many of each kind were alive as the last landing counted them
  readonly census = new Uint32Array(NSP);

  // ---------- on the GPU ----------
  // The animals take up residence on a store: kind animal declared, and, in a store that hasn't got it, the island's
  // animals laid down and run through the years before anyone wakes. A store loaded from a save has them, and its
  // saved ground. browse: the stems the deer browse, when the world has them; fish: the fish the birds take, when the
  // world has them (else each water tile's fish run of the ground stays as it is laid); ground: the lumped kinds'
  // ground layer and invertebrates, when the world has them (else the ground layer grows by the forage rule and the
  // crows' worms stand at their density, wgsl/animals.ts G.lumped).
  async attach(store: Store, driver: AnimalDriver, browse: Browse | null = null, fish: FishLink | null = null, ground: Ground | null = null) {
    if (this.store) throw new Error("the animals already live on a store");
    const fresh = !store.kinds.some((k) => k.name === ANIMAL);
    // still between laws: the law moves them only on its own ticks and marks the kind touched then (store.ts KindSpec)
    const kind = store.adopt({ name: ANIMAL, capacity: ANIMAL_CAP, placed: true, still: true, fields: FIELD_LIST } satisfies KindSpec);
    this.store = store; this.kind = kind; this.driver = driver; this.browse = browse; this.fish = fish; this.ground = ground;
    const g = store.g, cap = kind.capacity;
    const W = new Uint32Array(W_RUNS * T);
    W.set(driver.tiles());
    W.set(driver.pools(), W_.fg * T);
    // no bin to single a member out of until a link sets one
    W.fill(NONE, W_.tcrow * T, (W_.tfox + 1) * T);
    this.bufs = {
      W: storage(g, W), D: storage(g, driver.drivers()), KP: storage(g, KP_WORDS * 4), A: storage(g, aWords(cap) * 4), S: storage(g, NL * SATW * 4),
      I: storage(g, (CELLS + 1 + cap) * 4), Q: storage(g, Q_RUNS * cap * 4), TERR: storage(g, 3 * cap * 4), N: storage(g, 3 * 4, GPUBufferUsage.INDIRECT), cen: storage(g, NSP * 4),
      RQ: storage(g, new Uint32Array(cap).fill(NONE)),
    };
    this.src = {
      front: animalsFront(cap), rows: animalsSatRows(cap), cols: animalsSatCols(cap, LIVE_LAYERS), colsAll: animalsSatCols(cap, NL), count: animalsCensus(cap, 0),
      act: animalsAct(cap), claim: animalsClaim(cap), eat: animalsEat(cap), fate: animalsFate(cap),
    };
    this.mode(24);
    ground?.bind(store, { W: this.bufs.W, RQ: this.bufs.RQ, cap });
    if (fresh) {
      if (browse) this.browsed(browse.raster(store));
      const { n, cols } = driver.start();
      store.write(ANIMAL, n, cols);
      store.index(kind);
      // the days before anyone wakes, the birds' catch going to the fish as each hour's would, and each day of the
      // lumped kinds stepped at the midnight the hour crosses, before the hour (the start need not fall on an hour)
      for (let k = driver.days * 24; k >= 1; k--) {
        const t = driver.t0 - k * STEP_TICKS, midnight = Math.floor(t / DAY) * DAY;
        if (ground && midnight > t - STEP_TICKS) ground.spin(store, midnight);
        this.law(store, t);
        store.index(kind, true);
        store.flush();
      }
      this.cullNow();
      await store.refresh();
    }
    store.law({ name: "animals", due: (t) => t % STEP_TICKS === 0, run: (s, t) => this.law(s, t) });
    store.ride(this);
  }
  // The constants for so many steps a day, and whether the lumped kinds keep the ground (G.lumped).
  private mode(per: number) {
    if (this.per === per) return;
    this.per = per;
    const q = this.store!.g.device.queue, KP = this.bufs!.KP;
    q.writeBuffer(KP, 0, this.driver!.consts(per));
    q.writeBuffer(KP, (GK + G.lumped) * 4, Uint32Array.of(this.ground ? 1 : 0));
  }
  // Each tile's browse from the stems' crown raster.
  private browsed(r: Raster) {
    const s = this.store!, b = this.bufs!;
    s.run(animalsBrowse(r.cap, r.what, r.side), [r.body, r.start, r.list, b.W, b.KP], cover(s.g, T, 64) as [number, number]);
  }
  // A step of the law ending at tick t, per steps a day.
  private law(s: Store, t: number) {
    const b = this.bufs!, k = this.kind!, src = this.src!, g = s.g, cap = k.capacity, per = this.per;
    const { day, flags } = this.driver!.step(t, per);
    g.device.queue.writeBuffer(b.KP, PO * 4, Uint32Array.of(t >>> 0, per, day, flags, this.driver!.seed >>> 0, (STEP_TICKS * 24) / per));
    this.fish?.feed(s, b.W, W_.fish * T);
    if (this.browse && per === 24 && this.browse.filed(t)) this.browsed(this.browse.raster(s));
    s.encode((e) => {
      e.clearBuffer(b.A, 0, A_.carr * 4);
      // the census, the claims and the packs' runs, but not the packs' larders, which carry from step to step
      e.clearBuffer(b.A, A_.cen * 4, (larAt(cap) - A_.cen) * 4);
      e.copyBufferToBuffer(k.start!, 0, b.I, 0, (CELLS + 1) * 4);
      e.copyBufferToBuffer(k.order!, 0, b.I, (CELLS + 1) * 4, cap * 4);
    });
    // the passes over the animals go as far as satRows sets in N (wgsl/animals.ts)
    const animals = { buffer: b.N, offset: 0 }, layers = this.landSat ? NL : LIVE_LAYERS;
    s.run(src.front, [k.body, b.W, b.D, b.KP, b.A, b.I], cover(g, cap));
    s.run(src.rows, [b.W, b.S, k.alloc, b.N], [layers * TW]);
    s.run(this.landSat ? src.colsAll : src.cols, [b.S], cover(g, layers * (TW + 1)));
    this.landSat = false;
    s.run(src.act, [k.body, b.W, b.A, b.KP, b.S, b.I, b.Q, b.TERR], animals);
    if (flags & (FLAG.heron | FLAG.eagle | FLAG.crow)) s.scan(b.TERR, 3 * cap);
    s.run(src.claim, [k.body, b.W, b.A, b.KP, b.Q], animals);
    s.run(src.eat, [k.body, b.W, b.A, b.KP, b.Q, b.RQ], animals);
    s.run(src.fate, [k.body, b.W, b.A, b.KP, b.S, b.Q, b.TERR], animals);
    this.fish?.ate(s, b.A, A_.fish);
    // the young: the counts fate left in Q's first run, those past the room dropped
    if (flags & (FLAG.calve | FLAG.kits | FLAG.whelp | FLAG.cub | FLAG.heron | FLAG.eagle | FLAG.gull | FLAG.crow)) {
      s.births(ANIMAL, ANIMAL, b.Q, BIRTH_INIT, { bufs: [{ name: "KP", buf: b.KP }], wgsl: BIRTH_HEAD }, true);
    }
    k.touched = k.stale = true;
  }
  // Every animal of a kind (SP) dies, now or, before the animals live on a store, once they do.
  cull(sp: number) {
    this.culls.push(sp);
    if (this.store) this.cullNow();
  }
  private cullNow() {
    const s = this.store!, k = this.kind!;
    for (const sp of this.culls.splice(0)) s.run(CULL(k.capacity, sp), [k.body], cover(s.g, k.capacity));
    k.touched = k.stale = true;
  }

  // ---------- riding the store: the census every tick; saved, the ground and the requests ----------
  words() { return this.store ? NSP : 0; }
  record(out: GPUBuffer, at: number) {
    const s = this.store!, b = this.bufs!, k = this.kind!;
    s.encode((e) => e.clearBuffer(b.cen));
    s.run(this.src!.count, [k.body, b.cen], cover(s.g, k.capacity));
    s.encode((e) => e.copyBufferToBuffer(b.cen, 0, out, at * 4, NSP * 4));
  }
  land(o: Uint32Array, at: number) {
    if (o.length) this.census.set(o.subarray(at, at + NSP));
  }
  buffers(): [string, GPUBuffer][] { return this.bufs ? [["W", this.bufs.W], ["A", this.bufs.A], ["RQ", this.bufs.RQ]] : []; }
  save() { return { census: [...this.census] }; }
  restore(state: unknown, data: Record<string, Uint8Array> = {}) {
    const b = this.bufs!;
    reload(this.store!.g, b.W, data.W, "animals' ground");
    reload(this.store!.g, b.A, data.A, "animals' carrion and counts");
    reload(this.store!.g, b.RQ, data.RQ, "animals' requests to the lumped kinds");
    this.census.set(savedNumbers(savedArray(state, "census", "animals"), "animals' census"));
  }
  // Lets go of the buffers the animals made (the kind's own go with the store).
  destroy() {
    if (!this.bufs) return;
    for (const x of Object.values(this.bufs)) x.destroy();
    this.bufs = null;
  }
  // The GPU buffers, for tests reading the ground and the counts back.
  get buffersForTest() { return this.bufs; }
}

// Time: a step is an hour of island time [design: the herds stepped hourly], an island day 24 of them (sky.ts DAY).
export const STEP_TICKS = 12;
const DAY = 24 * STEP_TICKS;

// Every animal of one kind killed. Bindings: body.
const CULL = (cap: number, sp: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> b: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = g.x + g.y * n.x * 256u;
  if (i >= ${cap}u) { return; }
  if ((b[i] & 1u) == 1u && (b[3u * ${cap}u + i] & 15u) == ${sp}u) { b[i] = b[i] & ~1u; }
}`;
