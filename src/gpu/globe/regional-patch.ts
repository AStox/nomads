// The regional tier's kernels (src/gpu/wgsl/globe-regional.ts, the same laws) run on one patch of a tier at a time: a block of tiles and a halo of one cell, held flat as side * side
// cells with the global id of each in IDS. The buffers are the size of a patch whatever the tier is, so a tier of 400 million cells is solved in a few hundred megabytes of GPU
// memory (tiers-stream.ts keeps the tier's planes on disk and visits the patches). The tier-0 tables (the loss, the land count, the carry, the means) live in the same AT buffer as
// the regional solve keeps them and stay on the device from one patch to the next.
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { CNT, FLAG, HIST, RF, XSTRIDE, regionalWgsl } from "../wgsl/globe-regional";
import { EDGES, tierGrid } from "./grid";
import type { Patch } from "./patch";

const NP = 6 * 256 * 256;
export const PATCH_HALO = 1;
// entry points that run as one workgroup (the walks over the depths) and those over the tier-0 cells
const SINGLE: Record<string, true> = { lvscan: true, area: true, area64: true, areaS64: true, reach64: true, incise: true, incisep: true };
const PARENT: Record<string, true> = { pzero: true, pmean: true, pres: true, pfin: true, pcarry: true };
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
  readonly creepSubs: number;
  readonly flags = FLAG;

  constructor(readonly gpu: Gpu, readonly tier: number, interior: number, table: Uint32Array, creepSubs: number) {
    this.fn = tierGrid(tier).fn;
    this.side = interior + 2 * PATCH_HALO;
    this.N = this.side * this.side;
    this.atCnt = this.N + 3 * HIST;
    this.atParents = this.atCnt + 16;
    this.E = storage(gpu, RF.COUNT * this.N * 4);
    this.E2 = storage(gpu, 16);
    this.AT = storage(gpu, (this.atParents + 5 * NP) * 4);
    this.creepSubs = creepSubs;
    this.P = storage(gpu, new Uint32Array([1, creepSubs, 0, 0]));
    this.X = storage(gpu, table);
    this.IDS = storage(gpu, this.N * 4);
    this.wgsl = regionalWgsl(EDGES, this.fn, undefined, { side: this.side, halo: PATCH_HALO });
  }
  get bytes() { return (RF.COUNT * this.N + this.atParents + 5 * NP + this.N) * 4 + XSTRIDE * NP * 4; }

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
  async readParents(): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.AT, 5 * NP * 4, this.atParents * 4)); }
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
