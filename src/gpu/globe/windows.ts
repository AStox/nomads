// Windows on demand: the window of a lattice cell made once, kept by (seed, sources key, cell), and made again identically (R5 of the
// generator plan) in any order. This is the worker-side entry the page calls: `Windows.fetch(cell)` makes or finds a window,
// `Windows.want(cells)` says which the camera will need next, nearest first, and the queue makes them one at a time on the one
// GPU (docs/research/globe/2026-10-20-lattice-impl.md).
import type { Gpu } from "../device";
import { N } from "../../terrain/grid";
import { skyAt } from "../../sim/sky";
import type { V3 } from "./grid";
import { BLEND_M, cellFrame, cover, idOf, pixelOf, sample, type Cell } from "./lattice";
import { onSphere, windowOf, type Planet, type Window } from "./window";

// The window of a lattice cell: windowOf on the cell's frame, so that the window's axes are the cell's and its centre the cell's.
export function windowAtCell(gpu: Gpu, planet: Planet, cell: Cell): Promise<Window> {
  const f = cellFrame(cell);
  return windowOf(gpu, planet, f.latDeg, f.lonDeg, f);
}

// ---------- keeping ----------
// A store of windows' bytes by key. The page's will be the browser's cache, a script's a directory.
export interface WindowStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}
export const memoryWindowStore = (): WindowStore => {
  const m = new Map<string, Uint8Array>();
  return { get: async (k) => m.get(k) ?? null, put: async (k, b) => { m.set(k, b); } };
};
// The key of a window: the planet's seed, a key of the sources that make a window (the planet's stages' and the window's own: a
// window made by other code is not read as this code's), and the cell.
export const windowKey = (seed: number, sources: string, cell: Cell) => `${seed}-${sources}-${idOf(cell)}`;

// A window as bytes: [head length u32][head JSON][the typed arrays one after another]. Every typed array in the window, at any depth,
// goes to the blob and leaves {$t, $o, $n} in the JSON; so do lists of polylines of equal-width points (the rivers: some 780,000
// points of 7 numbers, which as JSON were 72 of a window's 94 MB), as the lines' lengths and every number in one Float64Array;
// everything else (numbers, strings, other lists and objects) is the JSON, and the sky, which holds functions, is made again from
// the place and the turn.
const KINDS = { Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int16Array, Uint16Array, Int8Array } as const;
type Kind = keyof typeof KINDS;
interface Ref { $t: Kind; $o: number; $n: number }
interface Lines { $lines: Ref; $width: number; $data: Ref }
// Lines of points of numbers, every point the same width: the one shape stored flat.
function pointWidth(v: unknown): number {
  if (!Array.isArray(v) || v.length === 0) return 0;
  let width = 0;
  for (const line of v) {
    if (!Array.isArray(line)) return 0;
    for (const p of line) {
      if (!Array.isArray(p) || p.length === 0 || (width !== 0 && p.length !== width) || p.some((x) => typeof x !== "number")) return 0;
      width = p.length;
    }
  }
  return width;
}
export function packWindow(w: Window): Uint8Array {
  const chunks: Uint8Array[] = [];
  let at = 0;
  const walk = (v: unknown): unknown => {
    if (ArrayBuffer.isView(v)) {
      const name = v.constructor.name as Kind, bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (!(name in KINDS)) throw new Error(`packWindow: a ${name} is not kept`);
      const ref: Ref = { $t: name, $o: at, $n: (v as Uint8Array).length };
      chunks.push(bytes);
      at += bytes.byteLength;
      return ref;
    }
    const width = pointWidth(v);
    if (width) {
      const lines = v as number[][][];
      return { $lines: walk(Int32Array.from(lines, (l) => l.length)), $width: width, $data: walk(Float64Array.from(lines.flat(2))) } satisfies Record<keyof Lines, unknown>;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== "function").map(([k, x]) => [k, walk(x)]));
    if (typeof v === "number" && !Number.isFinite(v)) return { $nan: String(v) };
    return v;
  };
  const head = new TextEncoder().encode(JSON.stringify(walk({ ...w, sky: undefined })));
  const start = 4 + head.length, out = new Uint8Array(start + at);
  new DataView(out.buffer).setUint32(0, head.length, true);
  out.set(head, 4);
  let o = start;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
export function unpackWindow(bytes: Uint8Array): Window {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true), base = 4 + len;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const r = v as Partial<Ref> & Partial<Lines> & { $nan?: string };
      if (r.$nan !== undefined) return Number(r.$nan);
      if (r.$lines !== undefined) {
        const counts = walk(r.$lines) as Int32Array, data = walk(r.$data) as Float64Array, width = r.$width!, lines: number[][][] = [];
        let at = 0;
        for (const n of counts) {
          const line: number[][] = [];
          for (let k = 0; k < n; k++, at += width) line.push(Array.from(data.subarray(at, at + width)));
          lines.push(line);
        }
        return lines;
      }
      if (r.$t !== undefined) {
        const K = KINDS[r.$t], size = K.BYTES_PER_ELEMENT, from = bytes.byteOffset + base + r.$o!;
        return new K(bytes.buffer.slice(from, from + r.$n! * size) as ArrayBuffer);
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const w = walk(JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)))) as Omit<Window, "sky">;
  return { ...w, sky: skyAt(w.latDeg, w.turn) };
}

// ---------- making ----------
interface Job { cell: Cell; waiters: PromiseWithResolvers<Window>[] }
// A cache of the windows of one planet, keyed by (seed, sources key, cell), with a queue that makes one window at a time (the GPU
// has one) in the order the camera wants them. A window found in the store is read back, not made again; either way it is the same
// bytes. `keep` windows stay in memory, the least recently used going first.
export class Windows {
  private readonly memory = new Map<number, Window>();
  private readonly jobs = new Map<number, Job>();
  // cells whose window could not be made (a river the window's words cannot hold, say), kept so that a camera over one does not make it again every time
  readonly failed = new Map<number, unknown>();
  private queue: number[] = [];
  private active: number | null = null;
  // what each window took to make here, seconds, and whether it was read from the store instead
  readonly log: { cell: number; seconds: number; fromStore: boolean }[] = [];

  constructor(
    // keep: windows held in memory [design: a window held is 23 to 66 MB on seed 1's samples, so six are at most about 400 MB; a view needs 4 to 5 at once]
    private readonly gpu: Gpu, private readonly planet: Planet, private readonly store: WindowStore, private readonly sources: string, private readonly keep = 6,
    private readonly make: (gpu: Gpu, planet: Planet, cell: Cell) => Promise<Window> = windowAtCell,
  ) {}

  peek(cell: Cell): Window | undefined {
    const id = idOf(cell), w = this.memory.get(id);
    if (w) { this.memory.delete(id); this.memory.set(id, w); }
    return w;
  }

  // The window of a cell, now: from memory, from the store, or made, at the head of the queue (the window being made is not stopped).
  fetch(cell: Cell): Promise<Window> {
    const have = this.peek(cell), gone = this.failed.get(idOf(cell));
    if (gone !== undefined) return Promise.reject(gone);
    if (have) return Promise.resolve(have);
    const id = idOf(cell), waiter = Promise.withResolvers<Window>();
    let job = this.jobs.get(id);
    if (!job) this.jobs.set(id, (job = { cell, waiters: [] }));
    job.waiters.push(waiter);
    if (this.active !== id) this.queue = [id, ...this.queue.filter((q) => q !== id)];
    void this.pump();
    return waiter.promise;
  }

  // The cells the camera will need next, nearest first. They replace the queue's earlier prefetches; windows someone is waiting for
  // keep their place at its head.
  want(cells: Cell[]) {
    const next = this.queue.filter((id) => this.jobs.get(id)!.waiters.length > 0);
    for (const c of cells) {
      const id = idOf(c);
      if (this.memory.has(id) || this.failed.has(id) || id === this.active || next.includes(id)) continue;
      if (!this.jobs.has(id)) this.jobs.set(id, { cell: c, waiters: [] });
      next.push(id);
    }
    for (const id of this.queue) if (!next.includes(id)) this.jobs.delete(id);
    this.queue = next;
    void this.pump();
  }

  private async pump() {
    if (this.active !== null) return;
    while (this.queue.length) {
      const id = this.queue.shift()!, job = this.jobs.get(id)!, key = windowKey(this.planet.seed, this.sources, job.cell), t0 = performance.now();
      this.active = id;
      try {
        const kept = await this.store.get(key), w = kept ? unpackWindow(kept) : await this.make(this.gpu, this.planet, job.cell);
        if (!kept) await this.store.put(key, packWindow(w));
        this.log.push({ cell: id, seconds: (performance.now() - t0) / 1000, fromStore: !!kept });
        this.memory.set(id, w);
        while (this.memory.size > this.keep) this.memory.delete(this.memory.keys().next().value!);
        for (const k of job.waiters) k.resolve(w);
      } catch (e) {
        this.failed.set(id, e);
        for (const k of job.waiters) k.reject(e);
      } finally {
        this.jobs.delete(id);
        this.active = null;
      }
    }
  }
}

// ---------- what a camera needs ----------
// The windows a camera needs and the order to make them in: those that blend into any point of the ground within `viewM` of
// `focus` (sampled on a polar grid of the plane at the focus), then those ahead of it along `heading` up to `aheadM`,
// each list nearest first (a window's distance is its centre's from the focus, and from the point `aheadM / 2` along the heading for
// the ones ahead). The home cell of the focus is first. The grid's step is half a blend ramp (600 m) for a view of a few km, so that
// a window whose blend reaches into the view is sampled, and a 25th of the view's radius for a larger one, to at most 4 km [design:
// a window whose blend only grazes a large view is asked for when the camera moves on].
export function wanted(focus: V3, heading: V3 | null, viewM: number, aheadM: number): Cell[] {
  const STEP_M = Math.min(4000, Math.max(BLEND_M / 2, viewM / 25));
  const east: V3 = Math.abs(focus[2]) < 0.9 ? [-focus[1], focus[0], 0] : [0, -focus[2], focus[1]], en = Math.hypot(...east);
  const e: V3 = [east[0] / en, east[1] / en, east[2] / en], n: V3 = [focus[1] * e[2] - focus[2] * e[1], focus[2] * e[0] - focus[0] * e[2], focus[0] * e[1] - focus[1] * e[0]];
  const at = (x: number, y: number): V3 => {
    const p: V3 = [focus[0] + (x * e[0] + y * n[0]) / 2_000_000, focus[1] + (x * e[1] + y * n[1]) / 2_000_000, focus[2] + (x * e[2] + y * n[2]) / 2_000_000], r = Math.hypot(...p);
    return [p[0] / r, p[1] / r, p[2] / r];
  };
  const seen = new Map<number, { cell: Cell; d: number }>();
  const add = (p: V3, from: V3) => {
    for (const o of cover(p)) {
      const id = idOf(o.cell), c = cellFrame(o.cell).c, d = Math.hypot(c[0] - from[0], c[1] - from[1], c[2] - from[2]);
      if (!seen.has(id) || seen.get(id)!.d > d) seen.set(id, { cell: o.cell, d });
    }
  };
  for (let y = -viewM; y <= viewM; y += STEP_M) for (let x = -viewM; x <= viewM; x += STEP_M) if (Math.hypot(x, y) <= viewM + STEP_M / 2) add(at(x, y), focus);
  const first = [...seen.values()].sort((a, b) => a.d - b.d || idOf(a.cell) - idOf(b.cell)).map((s) => s.cell), have = new Set(first.map(idOf));
  if (!heading || aheadM <= 0) return first;
  // heading is a unit vector on the sphere's tangent at the focus (any direction is projected)
  const hd = heading[0] * focus[0] + heading[1] * focus[1] + heading[2] * focus[2];
  const t: V3 = [heading[0] - hd * focus[0], heading[1] - hd * focus[1], heading[2] - hd * focus[2]], tn = Math.hypot(...t);
  if (tn === 0) return first;
  const tx = (t[0] * e[0] + t[1] * e[1] + t[2] * e[2]) / tn, ty = (t[0] * n[0] + t[1] * n[1] + t[2] * n[2]) / tn;
  seen.clear();
  const mid = at(tx * aheadM / 2, ty * aheadM / 2);
  for (let s = STEP_M; s <= aheadM + viewM; s += STEP_M)
    for (let k = -viewM; k <= viewM; k += STEP_M) add(at(tx * s - ty * k, ty * s + tx * k), mid);
  return [...first, ...[...seen.values()].filter((s) => !have.has(idOf(s.cell))).sort((a, b) => a.d - b.d || idOf(a.cell) - idOf(b.cell)).map((s) => s.cell)];
}

// ---------- blended fields ----------
// A window field at a point of the ground: each window in `got` that holds the point contributes its field at the point's pixel
// by bilinear sampling, weighted by the blend's share (lattice.ts cover); windows not yet made are left out and the others' shares
// renormalised. Returns the value and the share of the blend that was there (1 when every window the point needs is made, 0 and NaN
// when none is).
export function blended(p: V3, got: (cell: Cell) => Window | undefined, field: (w: Window) => ArrayLike<number>): { value: number; share: number } {
  let sum = 0, share = 0;
  for (const o of cover(p)) {
    const w = got(o.cell);
    if (!w) continue;
    const [px, py] = pixelOf(o.x, o.y);
    sum += o.w * sample(field(w), px, py);
    share += o.w;
  }
  return share > 0 ? { value: sum / share, share } : { value: NaN, share: 0 };
}

// The ground point at pixel (ix, iy) (continuous) of a cell's window.
export function groundAt(cell: Cell, ix: number, iy: number): V3 {
  const f = cellFrame(cell);
  return onSphere(f, (ix - N / 2) * 75, -(iy - N / 2) * 75);
}
