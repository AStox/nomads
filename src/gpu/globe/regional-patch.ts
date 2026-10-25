// The regional tier's kernels (src/gpu/wgsl/globe-regional.ts, the same laws) run on one patch of a tier at a time: a block of tiles and a halo of one cell, held flat as side * side
// cells with the global id of each in IDS. The buffers are the size of a patch whatever the tier is, so a tier of 400 million cells is solved in a few hundred megabytes of GPU
// memory (tiers-stream.ts keeps the tier's planes on disk and visits the patches). The tier-0 tables (the loss, the land count, the carry, the means) live in the same AT buffer as
// the regional solve keeps them and stay on the device from one patch to the next.
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { CNT, FLAG, FLOW_NEIGHBOURS, HIST, RF, XSTRIDE, regionalWgsl } from "../wgsl/globe-regional";
import { EDGES, tierGrid } from "./grid";
import type { Patch } from "./patch";

const NP = 6 * 256 * 256;
export const PATCH_HALO = 1;
// entry points that run as one workgroup (the walks over the depths) and those over the tier-0 cells
const SINGLE: Record<string, true> = { lvscan: true, area: true, area64: true, areaS64: true, reach64: true, incise: true, incisep: true };
const PARENT: Record<string, true> = { pzero: true, pstzero: true, pmean: true, psolve: true, psolve2: true, pcarry: true };
// the tier-0 tables in AT after the flooded surface's block: loss, land count, carry, coefficients, rises (one word a tier-0 cell each), the stencil (nine words), the second coefficients
export const PARENT_WORDS = 15;
export type Step = string | readonly [string, number];

export class RegionalPatch {
  readonly side: number;
  readonly N: number;
  readonly fn: number;
  private readonly E: GPUBuffer;
  private readonly E2: GPUBuffer;
  private readonly AT: GPUBuffer;
  private readonly P: GPUBuffer;
  private readonly X: GPUBuffer;
  private readonly IDS: GPUBuffer;
  private readonly wgsl: string;
  private readonly binds = new Map<string, GPUBindGroup>();
  private readonly atCnt: number;
  private readonly atParents: number;
  creepSubs: number;
  private stepNo = 0;
  readonly flags = FLAG;

  constructor(readonly gpu: Gpu, readonly tier: number, interior: number, table: Uint32Array, creepSubs: number, nflow: 4 | 8 = FLOW_NEIGHBOURS, public route: 0 | 1 | 2 = 0, slideN: 8 | 16 = 8, readonly halo = PATCH_HALO) {
    this.fn = tierGrid(tier).fn;
    this.side = interior + 2 * halo;
    this.N = this.side * this.side;
    this.atCnt = this.N + 3 * HIST;
    this.atParents = this.atCnt + 16;
    this.E = storage(gpu, RF.COUNT * this.N * 4);
    this.E2 = storage(gpu, 16);
    this.AT = storage(gpu, (this.atParents + PARENT_WORDS * NP) * 4);
    this.creepSubs = creepSubs;
    this.P = storage(gpu, new Uint32Array([1, creepSubs, 0, route]));
    this.X = storage(gpu, table);
    this.IDS = storage(gpu, this.N * 4);
    this.wgsl = regionalWgsl(EDGES, this.fn, nflow, { side: this.side, halo }, slideN);
  }
  // Another step's table (its K dt and creep coefficients) and the creep's substeps it needs.
  setTable(table: Uint32Array, creepSubs: number) {
    this.creepSubs = creepSubs;
    this.gpu.device.queue.writeBuffer(this.X, 0, table);
    this.gpu.device.queue.writeBuffer(this.P, 0, new Uint32Array([1, creepSubs, this.stepNo, this.route]));
  }
  // Whether a receiver is the steepest (0), is drawn among the lower neighbours (1) or is Rho8's steepest by random diagonal lengths (2).
  setRoute(route: 0 | 1 | 2) {
    this.route = route;
    this.gpu.device.queue.writeBuffer(this.P, 12, new Uint32Array([route]));
  }
  // The step the routing's draws are made for.
  setStep(n: number) {
    this.stepNo = n;
    this.gpu.device.queue.writeBuffer(this.P, 8, new Uint32Array([n]));
  }
  get bytes() { return (RF.COUNT * this.N + this.atParents + PARENT_WORDS * NP + this.N) * 4 + XSTRIDE * NP * 4; }

  // The patch the buffers hold: the cell ids (a cube corner's missing cell as 0xffffffff, which the kernels read as no cell).
  setPatch(p: Patch) {
    if (p.side !== this.side) throw new Error(`regional-patch: a patch of side ${p.side} in buffers for ${this.side}`);
    const ids = new Uint32Array(this.N);
    for (let k = 0; k < this.N; k++) ids[k] = p.missing[k] ? 0xffffffff : p.ids[k];
    this.gpu.device.queue.writeBuffer(this.IDS, 0, ids);
  }
  write(f: keyof typeof RF, data: ArrayBufferView) { this.gpu.device.queue.writeBuffer(this.E, RF[f] * this.N * 4, data.buffer, data.byteOffset, data.byteLength); }
  // The flooded surface (the first N words of AT).
  writeFlood(data: ArrayBufferView) { this.gpu.device.queue.writeBuffer(this.AT, 0, data.buffer, data.byteOffset, data.byteLength); }
  async read(f: keyof typeof RF): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.E, this.N * 4, RF[f] * this.N * 4)); }
  async readFlood(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, this.N * 4, 0)); }
  clearCounter(c: keyof typeof CNT) { this.gpu.device.queue.writeBuffer(this.AT, (this.atCnt + CNT[c]) * 4, new Uint32Array(1)); }
  async counter(c: keyof typeof CNT): Promise<number> { return new Int32Array(await readback(this.gpu, this.AT, 4, (this.atCnt + CNT[c]) * 4))[0]; }
  // The tier-0 tables, five of them (loss, land count, carry, mean, rises), in and out; and the carry alone (what a state keeps).
  writeParents(words: Int32Array) { this.gpu.device.queue.writeBuffer(this.AT, this.atParents * 4, words.buffer, words.byteOffset, words.byteLength); }
  async readParents(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, PARENT_WORDS * NP * 4, this.atParents * 4)); }
  async readCarry(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, NP * 4, (this.atParents + 2 * NP) * 4)); }

  private bind(entry: string) {
    const p = pipeline(this.gpu, this.wgsl, entry);
    let b = this.binds.get(entry);
    if (!b) {
      b = this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.P, this.E, this.AT, this.X, this.E2, this.IDS].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      this.binds.set(entry, b);
    }
    return { p, b };
  }
  // The entry points in order in one pass; a pair repeats the entry point so many times (each dispatch a barrier from the last).
  go(steps: readonly Step[]) {
    const enc = this.gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
    for (const s of steps) {
      const [entry, times] = typeof s === "string" ? [s, 1] : s, { p, b } = this.bind(entry);
      const g = SINGLE[entry] ? ([1, 1] as [number, number]) : cover(this.gpu, PARENT[entry] ? NP : this.N);
      pass.setPipeline(p); pass.setBindGroup(0, b);
      for (let i = 0; i < times; i++) pass.dispatchWorkgroups(g[0], g[1]);
    }
    pass.end();
    this.gpu.device.queue.submit([enc.finish()]);
  }
  release() { for (const b of [this.E, this.E2, this.AT, this.P, this.X, this.IDS]) b.destroy(); this.binds.clear(); }
}

// The steps that make the depth sort of the receivers in E_TO (the tree of a patch: the pointer jumps, the counting sort), then the discharge area.
export const TREE: readonly Step[] = ["lvinit", ...Array.from({ length: 7 }, () => ["jumpa", "jumpb"]).flat(), "lvhist", "lvscan", "lvscatter"];
