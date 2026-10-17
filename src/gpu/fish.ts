// The island's fish, resident on the GPU: every trout, stickleback, perch, roach, pike and eel in the island's water
// one object of store kind "fish", stepped once an island day (DAY ticks, src/sim/ticks.ts) [design: growth, deaths and
// moving are the fish's slow laws] by the law in wgsl/fish.ts, its constants and the
// water it lives in from src/sim/waters.ts (docs/research/animal-constants.md sec. 13). Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 11.
//
// Fields, each a u32: x and y in millimetres (PLACE); sp, its kind (FS) plus 16 for a female; born, the tick it was
// laid (mod 2^32); len, its total length in micrometres.
//
// The birds eat the fish through the animals' law (src/gpu/animals.ts): before each of its steps the fish lay out each
// tile's fish by mass for it (feed), and after it they take what the birds ate into the day's catch (ate), which the
// next law takes as whole fish. What the CPU reads back each landing: the census of the last law.
import type { Store, Kind, KindSpec, Field, Rider } from "./store";
import { reload, savedArray, savedNumbers } from "./store";
import { cover, storage } from "./kernel";
import { BIRTH_INIT, CEN_WORDS, FIELDS, KP_WORDS, PO, START_INIT, S_, S_WORDS, T, birthHead, fishAte, fishFate, fishFeed, fishFront } from "./wgsl/fish";
import { CELLS } from "./wgsl/index";
import { DAY } from "../sim/ticks";

export const FISH = "fish";
// Room for this many fish at once [design]: about 300 MB of the GPU's memory with its index and the young's counts;
// young past the room are not born (wgsl/fish.ts births).
export const FISH_CAP = 1 << 23;
const UNITS: Record<(typeof FIELDS)[number], [string, number]> = { sp: ["kind", 1], born: ["tick", 1], len: ["m", 1e6] };
const FIELD_LIST: Field[] = FIELDS.map((name) => ({ name, type: "u32", unit: UNITS[name][0], scale: UNITS[name][1] }));

// What the law reads from the sim (src/sim/waters.ts fishDriver), so this module needs none of it.
export type FishDriver = {
  seed: number;
  // the cells' tables, CT_RUNS runs of CELLS words (wgsl/fish.ts CT_)
  cells(): Uint32Array;
  // the constants buffer up to the step's parameters (PO words)
  consts(): Uint32Array;
  // the fish as the island starts: how many of each kind in each cell, CELLS x NFS rows (row = cell x NFS + kind),
  // which the start's initialization lays (wgsl/fish.ts START_INIT)
  start(): Uint32Array;
  // a step ending at tick t: its events (FLAG) and each cell's food for the step, cg (0 where it is dry)
  step(t: number): { flags: number; food: Uint32Array };
  // the island days before anyone wakes, stepped as every day after is, ending at tick t0
  days: number;
  t0: number;
};
// The animals' side of the birds' fishing (src/gpu/animals.ts): the fish lay out each tile's fish into the animals'
// tile buffer at a word, and take what the birds ate from the animals' atomic buffer at a word.
export type FishLink = { feed(s: Store, W: GPUBuffer, at: number): void; ate(s: Store, A: GPUBuffer, at: number): void };

type Bufs = { CT: GPUBuffer; FOOD: GPUBuffer; KP: GPUBuffer; S: GPUBuffer; FT: GPUBuffer; EAT: GPUBuffer; Q: GPUBuffer };

export class Fish implements Rider, FishLink {
  readonly name = "fish";
  store: Store | null = null;
  kind: Kind | null = null;
  private driver: FishDriver | null = null;
  private bufs: Bufs | null = null;
  private src: Record<string, string> | null = null;
  // how many of each kind were alive, and their mass, as the last law counted them (wgsl/fish.ts CEN)
  readonly census = new Uint32Array(CEN_WORDS);

  // ---------- on the GPU ----------
  // The fish take up residence on a store: kind fish declared, and, in a store that hasn't got it, the island's fish
  // laid down and run through the days before anyone wakes. A store loaded from a save has them.
  async attach(store: Store, driver: FishDriver) {
    if (this.store) throw new Error("the fish already live on a store");
    const fresh = !store.kinds.some((k) => k.name === FISH);
    // still between laws: the law moves them only once a day and marks the kind touched then (store.ts KindSpec)
    const kind = store.adopt({ name: FISH, capacity: FISH_CAP, placed: true, still: true, fields: FIELD_LIST } satisfies KindSpec);
    this.store = store; this.kind = kind; this.driver = driver;
    const g = store.g, cap = kind.capacity, KP = new Uint32Array(KP_WORDS);
    KP.set(driver.consts());
    this.bufs = {
      CT: storage(g, driver.cells()), FOOD: storage(g, CELLS * 4), KP: storage(g, KP), S: storage(g, S_WORDS * 4),
      FT: storage(g, T * 4), EAT: storage(g, T * 4), Q: storage(g, cap * 4),
    };
    this.src = { front: fishFront(cap), fate: fishFate(cap) };
    if (fresh) {
      const counts = driver.start(), t = driver.t0 - driver.days * DAY;
      if (counts.some((n) => n > 0)) {
        const rows = storage(g, counts);
        g.device.queue.writeBuffer(this.bufs.KP, PO * 4, Uint32Array.of(t >>> 0, driver.seed >>> 0, 0));
        store.bear(FISH, rows, counts.length, START_INIT, { bufs: [{ name: "KP", buf: this.bufs.KP }, { name: "CT", buf: this.bufs.CT }], wgsl: birthHead(cap) }, true);
        store.retire(rows);
        store.flush();
      }
      for (let k = driver.days; k >= 1; k--) {
        this.law(store, driver.t0 - k * DAY);
        store.index(kind, true);
        store.flush();
      }
      store.index(kind);
      store.flush();
      await store.refresh();
    }
    store.law({ name: "fish", due: (t) => t % DAY === 0, run: (s, t) => this.law(s, t) });
    store.ride(this);
  }
  // A day of the law ending at tick t.
  private law(s: Store, t: number) {
    const b = this.bufs!, k = this.kind!, src = this.src!, g = s.g, cap = k.capacity, d = this.driver!;
    const { flags, food } = d.step(t);
    g.device.queue.writeBuffer(b.KP, PO * 4, Uint32Array.of(t >>> 0, d.seed >>> 0, flags));
    g.device.queue.writeBuffer(b.FOOD, 0, food);
    s.encode((e) => e.clearBuffer(b.S));
    s.run(src.front, [k.body, b.CT, b.KP, b.S, b.FT, b.EAT], cover(g, cap));
    s.run(src.fate, [k.body, b.CT, b.FOOD, b.KP, b.S, b.FT, b.EAT, b.Q], cover(g, cap));
    if (flags & 1) s.births(FISH, FISH, b.Q, BIRTH_INIT, { bufs: [{ name: "KP", buf: b.KP }, { name: "CT", buf: b.CT }], wgsl: birthHead(cap) }, true);
    // the day's fish by tile for the birds, and the catch begun again
    s.encode((e) => {
      e.copyBufferToBuffer(b.S, S_.ftn * 4, b.FT, 0, T * 4);
      e.clearBuffer(b.EAT);
    });
    k.touched = k.stale = true;
  }
  kernelSources(): string[] {
    const b = this.bufs!, s = this.store!;
    return [this.src!.front, this.src!.fate, s.birthKernel(FISH, FISH, BIRTH_INIT, { bufs: [{ name: "KP", buf: b.KP }, { name: "CT", buf: b.CT }], wgsl: birthHead(this.kind!.capacity) })];
  }

  // ---------- the birds' side (FishLink) ----------
  feed(s: Store, W: GPUBuffer, at: number) {
    const b = this.bufs!;
    s.run(fishFeed(at), [b.FT, b.EAT, W], cover(s.g, T));
  }
  ate(s: Store, A: GPUBuffer, at: number) {
    s.run(fishAte(at), [A, this.bufs!.EAT], cover(s.g, T));
  }

  // ---------- riding the store: the census; saved, each tile's fish and the day's catch ----------
  words() { return this.store ? CEN_WORDS : 0; }
  record(out: GPUBuffer, at: number) {
    const b = this.bufs!;
    this.store!.encode((e) => e.copyBufferToBuffer(b.S, S_.cen * 4, out, at * 4, CEN_WORDS * 4));
  }
  land(o: Uint32Array, at: number) {
    if (o.length) this.census.set(o.subarray(at, at + CEN_WORDS));
  }
  buffers(): [string, GPUBuffer][] { return this.bufs ? [["FT", this.bufs.FT], ["EAT", this.bufs.EAT], ["S", this.bufs.S]] : []; }
  save() { return { census: [...this.census] }; }
  restore(state: unknown, data: Record<string, Uint8Array> = {}) {
    const b = this.bufs!, g = this.store!.g;
    reload(g, b.FT, data.FT, "fish by tile");
    reload(g, b.EAT, data.EAT, "fish eaten");
    reload(g, b.S, data.S, "fish sums");
    this.census.set(savedNumbers(savedArray(state, "census", "fish"), "fish census"));
  }
  // Lets go of the buffers the fish made (the kind's own go with the store).
  destroy() {
    if (!this.bufs) return;
    for (const x of Object.values(this.bufs)) x.destroy();
    this.bufs = null;
  }
  // The GPU buffers, for tests.
  get buffersForTest() { return this.bufs; }
}
