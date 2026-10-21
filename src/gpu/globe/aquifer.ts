// The order of a global relaxation of the water table (Unit 5b): a Gauss-Seidel sweep over the whole tier gives one answer whatever the tiling or the order the tiles are visited in only if
// the order is defined by a cell's identity, as colours: all the cells of one colour are updated at once from the cells of the other colours, so no update reads a cell that moves in the same
// dispatch. The grid of a face is two-coloured by the parity of X + Y; across a face's edge the neighbour's parity is not consistent (the 4-neighbour graph of a cube's faces is not
// bipartite: the three cells at a cube's corner are pairwise neighbours, and along four of the twelve edges the parity of both sides agree). So a cell whose neighbour across an edge has its
// own parity and a larger id is `late`: it is moved after the rest, in the colour 2 + its parity (two late cells that are neighbours then differ in parity, and a late cell's larger
// neighbour of its own parity is not late unless it has a still larger one, which only happens in a corner's triangle, where the parities differ again) [design: checked as a proper colouring
// of the whole graph by aquifer.test.ts at tiers 0 and 1; the late cells are 4 fn pairs, 16,384 at tier 4, 0.016% of the cells, a list a kernel visits apart from the grid].
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { A_PLANES, B_PLANES, aquiferWgsl } from "../wgsl/globe-aquifer";
import { FACES, tierGrid } from "./grid";
import { cellAcross } from "./patch";

export const COLOURS = 4;
export const neighbours4 = (tier: number, id: number): number[] => {
  const g = tierGrid(tier), n = g.fn, f = Math.floor(id / (n * n)), r = id - f * n * n, Y = Math.floor(r / n), X = r - Y * n, out: number[] = [];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const c = cellAcross(g, f, X + dx, Y + dy); if (c >= 0) out.push(c); }
  return out;
};
const parity = (n: number, id: number) => { const r = id % (n * n), Y = Math.floor(r / n); return (Y + r - Y * n) & 1; };
// The colour of a cell of the tier (0 to 3), a function of the cell's identity only.
export function colourOf(tier: number, id: number): number {
  const n = tierGrid(tier).fn, b = parity(n, id);
  for (const j of neighbours4(tier, id)) if (j > id && parity(n, j) === b) return 2 + b;
  return b;
}
export const colouring = (tier: number): Uint8Array => {
  const N = FACES * tierGrid(tier).fn ** 2, out = new Uint8Array(N);
  for (let id = 0; id < N; id++) out[id] = colourOf(tier, id);
  return out;
};

// The colour of every cell of the tier as a field: the parity of X + Y, and colourOf for the cells on a face's edge (the only ones that can be late).
export function colourField(tier: number): Int32Array {
  const n = tierGrid(tier).fn, out = new Int32Array(FACES * n * n);
  for (let f = 0, k = 0; f < FACES; f++) for (let Y = 0; Y < n; Y++) for (let X = 0; X < n; X++, k++) out[k] = (X + Y) & 1;
  for (let f = 0; f < FACES; f++)
    for (let a = 0; a < n; a++)
      for (const [X, Y] of [[0, a], [n - 1, a], [a, 0], [a, n - 1]]) { const id = (f * n + Y) * n + X; out[id] = colourOf(tier, id); }
  return out;
}

// The relaxation on the device over the packed planes of wgsl/globe-aquifer.ts (A_PLANES and B_PLANES: `load` gives each as a field of the tier's N words, one at a time, so that the host never
// holds more than one; the colour is put in `meta`, and the ground (`ht`) is the tier's heights).
const CHUNK = 64;
// change: the greatest change of a head in the last sweep over every cell; shallow: over the cells whose table is within 8 m of the ground (what the ground and the flows read; the deep
// table's slow modes are no part of it) [design: the stop is on the shallow change; a stored word of the deep table is a function of the sweeps made, the same under any tiling]
export interface Settled { sweeps: number; change: number; shallow: number }
export class GlobalAquifer {
  readonly N: number;
  private readonly A: GPUBuffer; private readonly B: GPUBuffer; private readonly C: GPUBuffer; private readonly P: GPUBuffer[] = [];
  constructor(readonly gpu: Gpu, readonly tier: number, load: (plane: string) => Int32Array | Uint32Array, reverse = false, public omega?: number) {
    this.N = FACES * tierGrid(tier).fn ** 2;
    const a = A_PLANES.length * this.N * 4, b = B_PLANES.length * this.N * 4, lim = gpu.device.limits;
    if (Math.max(a, b) > Math.min(lim.maxBufferSize, lim.maxStorageBufferBindingSize)) throw new Error(`aquifer: the state of tier ${tier} is ${(a / 1e9).toFixed(2)} and ${(b / 1e9).toFixed(2)} GB, over a buffer's ${(lim.maxStorageBufferBindingSize / 1e9).toFixed(2)}`);
    this.A = storage(gpu, a); this.B = storage(gpu, b); this.C = storage(gpu, 16);
    const put = (buffer: GPUBuffer, k: number, w: Int32Array | Uint32Array) => {
      if (w.length !== this.N) throw new Error(`aquifer: a plane holds ${w.length} cells, wanted ${this.N}`);
      gpu.device.queue.writeBuffer(buffer, k * this.N * 4, w.buffer, w.byteOffset, w.byteLength);
    };
    A_PLANES.forEach((name, k) => {
      if (name === "res") return;
      const w = load(name);
      if (name === "meta") { const col = colourField(tier), m = new Uint32Array(w.buffer, w.byteOffset, w.length); for (let i = 0; i < m.length; i++) m[i] |= col[i] << 8; }
      put(this.A, k, w);
    });
    B_PLANES.forEach((name, k) => put(this.B, k, load(name)));
    for (let colour = 0; colour < COLOURS; colour++) for (let slot = 0; slot < 2; slot++) this.P.push(storage(gpu, Uint32Array.of(colour, slot, reverse ? 1 : 0, 0)));
  }
  // Sweeps (the four colours in turn, in chunks of 64) until the greatest change of a head in the last sweep is under `tol` (units of the head's word) or `most` are made.
  async relax(most: number, tol: number, budgetS = Infinity): Promise<Settled> {
    const t0 = performance.now();
    const { gpu } = this, p = pipeline(gpu, aquiferWgsl(this.tier, this.omega), "aqg"), groups = cover(gpu, this.N);
    const binds = this.P.map((P) => gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.A, this.B, this.C, P].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    let sweeps = 0, change = 0, all = 0;
    do {
      gpu.device.queue.writeBuffer(this.C, 0, new Uint32Array(4));
      const enc = gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(p);
      for (let s = 0; s < CHUNK; s++) for (let colour = 0; colour < COLOURS; colour++) { pass.setBindGroup(0, binds[colour * 2 + (s === CHUNK - 1 ? 1 : 0)]); pass.dispatchWorkgroups(groups[0], groups[1]); }
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
      sweeps += CHUNK;
      const words = new Uint32Array(await readback(gpu, this.C, 16, 0));
      all = words[1]; change = words[3];
    } while (change >= tol && sweeps < most && (performance.now() - t0) / 1000 < budgetS);
    return { sweeps, change: all, shallow: change };
  }
  // The heads, as the cells hold them (the first plane of A).
  async head(): Promise<Int32Array> { return this.plane("head"); }
  async plane(name: (typeof A_PLANES)[number]): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.A, this.N * 4, A_PLANES.indexOf(name) * this.N * 4)); }
  setPlane(name: (typeof A_PLANES)[number], w: Int32Array | Uint32Array) {
    if (w.length !== this.N) throw new Error(`aquifer: a plane holds ${w.length} cells, wanted ${this.N}`);
    this.gpu.device.queue.writeBuffer(this.A, A_PLANES.indexOf(name) * this.N * 4, w.buffer, w.byteOffset, w.byteLength);
  }
  private bound(entry: string) {
    const p = pipeline(this.gpu, aquiferWgsl(this.tier, this.omega), entry);
    return { p, bind: this.gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.A, this.B, this.C, this.P[0]].map((buffer, binding) => ({ binding, resource: { buffer } })) }) };
  }
  // A fixed number of sweeps of the four colours (no read back, no stop): the smoother of a multigrid cycle.
  sweeps(n: number) {
    const { gpu } = this, p = pipeline(gpu, aquiferWgsl(this.tier, this.omega), "aqg"), groups = cover(gpu, this.N);
    const binds = this.P.map((P) => gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.A, this.B, this.C, P].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    for (let done = 0; done < n; done += CHUNK) {
      const enc = gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(p);
      for (let s = 0; s < Math.min(CHUNK, n - done); s++) for (let colour = 0; colour < COLOURS; colour++) { pass.setBindGroup(0, binds[colour * 2]); pass.dispatchWorkgroups(groups[0], groups[1]); }
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
    }
  }
  // The residual of every cell into the plane res (the head's unit: where one Gauss-Seidel step would move it, 0 at a fixed cell or a cell held at its cap), and the greatest of the cells
  // within 8 m of the ground and of all.
  async residual(): Promise<{ shallow: number; all: number }> {
    const { p, bind } = this.bound("aqres"), groups = cover(this.gpu, this.N);
    this.gpu.device.queue.writeBuffer(this.C, 0, new Uint32Array(4));
    const enc = this.gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(groups[0], groups[1]); pass.end();
    this.gpu.device.queue.submit([enc.finish()]);
    const w = new Uint32Array(await readback(this.gpu, this.C, 16, 0));
    return { shallow: w[0], all: w[1] };
  }
  // The plane res (a correction) added to the heads, capped.
  correct() {
    const { p, bind } = this.bound("aqcorr"), groups = cover(this.gpu, this.N), enc = this.gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(p); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(groups[0], groups[1]); pass.end();
    this.gpu.device.queue.submit([enc.finish()]);
  }
  release() { for (const b of [this.A, this.B, this.C, ...this.P]) b.destroy(); }
}
