// The crowns over the island, resident on the GPU and read back for the CPU (law and words: wgsl/crowns.ts). Plan:
// docs/plans/2026-10-14-001-refactor-gpu-object-world-plan.md, Unit 12. The one crown source of truth: each day, right
// after the stems' law files its crown raster (flora.ts raster), the crown pass sums every texel's trees into the
// crown words, which the GPU's laws read where they lie (wgsl/moisture.ts, wgsl/fire.ts), the renderer binds on the
// same device, and the CPU's light, rain and wind read as a copy (src/sim/light.ts).
//
// What the CPU holds: the words of the last pass whose copy has come back whole. A pass's 4.25 MB come back a slice a
// tick with the tick's landing (SLICES ticks, under three game hours) rather than at once, so no day's landing waits
// on them [design: R9, no tick stalls the page]; until the last slice lands the CPU keeps the pass before, which the
// GPU keeps too (prev) so a save holds exactly what the CPU reads. The first pass, when the crowns take up residence,
// is read back whole before the first tick goes on.
import { cover, readback, storage } from "./kernel";
import { type Rider, type Store, reload, savedNumber } from "./store";
import type { Raster } from "./flora";
import { CELLS, CELL_AT, QSHIFT, WORDS, cellAt, crownPass, texelAt } from "./wgsl/crowns";

// Ticks a pass's copy is spread over [design].
export const SLICES = 32;
const SLICE = Math.ceil(WORDS / SLICES);

// The stems' crown raster as their law last filed it, filed now if no law has this tick or if asked for as the stems
// stand now (flora.ts raster): the pass reads its texel sums.
export type CrownSource = { raster(now?: boolean): Raster };

export class Crowns implements Rider {
  readonly name = "crowns";
  store: Store | null = null;
  // The newest pass's words, which the GPU's laws and the renderer read, and the pass before it.
  buf: GPUBuffer | null = null;
  private prev: GPUBuffer | null = null;
  private source: CrownSource | null = null;
  private src = "";
  // The words the CPU reads, the pass coming back and how far, the slice the tick's landing carries, and passes come
  // back whole so far (anything kept of the crowns holds until this moves).
  private now: Uint32Array | null = null;
  private next: Uint32Array | null = null;
  private sent = 0;
  private slice = 0;
  passes = 0;
  // The tick of the last pass on the GPU.
  passed = -1;
  private restored = false;

  // The crowns take up residence: their law runs when due (registered after the stems' law, so after it), and the
  // first pass is made and read back before this resolves. A store loaded from a save hands back what it had.
  async attach(store: Store, source: CrownSource, due: (t: number) => boolean) {
    if (this.store) throw new Error("the crowns already live on a store");
    this.store = store;
    this.source = source;
    this.src = crownPass();
    this.buf = storage(store.g, WORDS * 4);
    this.prev = storage(store.g, WORDS * 4);
    store.law({ name: "crowns", due, run: (_, t) => this.law(t) });
    store.ride(this);
    if (this.restored) {
      const pending = this.next !== null;
      this.now = new Uint32Array(await readback(store.g, pending ? this.prev : this.buf));
      if (pending) this.next = new Uint32Array(await readback(store.g, this.buf));
    } else {
      this.pass(store.t);
      store.flush();
      this.now = new Uint32Array(await readback(store.g, this.buf));
    }
    this.passes++;
  }
  // The pass: the texel and cell words from the raster's sums as the stems' law filed it this tick (or filed now).
  private pass(t: number, now = false) {
    const s = this.store!;
    s.run(this.src, [this.source!.raster(now).crowns, this.buf!], cover(s.g, CELLS, 16));
    this.passed = t;
  }
  // A day's pass, the words before it kept, its copy to come back a slice a tick.
  private law(t: number) {
    this.store!.encode((e) => e.copyBufferToBuffer(this.buf!, 0, this.prev!, 0, WORDS * 4));
    this.pass(t);
    this.next = new Uint32Array(WORDS);
    this.sent = 0;
  }

  // ---------- reading ----------
  // A pass made now, between ticks, and read back whole: the CPU reads it from the next lookup on (a world's first
  // crowns, and tests that fell or plant a stem and look again).
  async refresh() {
    const s = this.store!;
    if (s.arriving) await s.arriving;
    this.pass(s.t, true);
    s.flush();
    this.now = new Uint32Array(await readback(s.g, this.buf!));
    this.next = null;
    this.passes++;
  }
  // The cover over a place in mm, Q16 layers: the pines' and the broadleaves'; none before the first pass.
  coverAt(x: number, y: number) {
    const w = this.now ? this.now[texelAt(x, y)] : 0;
    return { pine: (w & 0xffff) << QSHIFT, broad: (w >>> 16) << QSHIFT };
  }
  // The trees' crowns' height over the cell of a place in mm, m.
  heightAt(x: number, y: number) {
    return this.now ? this.now[CELL_AT + cellAt(x, y)] / 10 : 0;
  }
  // The words as the CPU holds them.
  held(): Uint32Array | null { return this.now; }

  // ---------- riding the store ----------
  words(): number {
    this.slice = this.next ? Math.min(SLICE, WORDS - this.sent) : 0;
    return this.slice;
  }
  record(out: GPUBuffer, at: number) {
    if (!this.slice) return;
    const from = this.sent * 4, n = this.slice * 4;
    this.store!.encode((e) => e.copyBufferToBuffer(this.buf!, from, out, at * 4, n));
  }
  land(o: Uint32Array, at: number) {
    if (!this.slice || !this.next) return;
    this.next.set(o.subarray(at, at + this.slice), this.sent);
    this.sent += this.slice;
    this.slice = 0;
    if (this.sent < WORDS) return;
    this.now = this.next;
    this.next = null;
    this.passes++;
  }
  buffers(): [string, GPUBuffer][] { return this.buf ? [["words", this.buf], ["prev", this.prev!]] : []; }
  save() { return { passed: this.passed, sent: this.next ? this.sent : -1 }; }
  restore(state: unknown, data: Record<string, Uint8Array>) {
    this.passed = savedNumber(state, "passed", "crowns");
    const sent = savedNumber(state, "sent", "crowns");
    reload(this.store!.g, this.buf!, data.words, "crown words");
    reload(this.store!.g, this.prev!, data.prev, "crown words before");
    this.next = sent >= 0 ? new Uint32Array(WORDS) : null;
    this.sent = Math.max(0, sent);
    this.restored = true;
  }
  destroy() {
    this.buf?.destroy();
    this.prev?.destroy();
    this.buf = this.prev = null;
  }
}
