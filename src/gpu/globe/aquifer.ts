// The order of a global relaxation of the water table (Unit 5b): a Gauss-Seidel sweep over the whole tier gives one answer whatever the tiling or the order the tiles are visited in only if
// the order is defined by a cell's identity, as colours: all the cells of one colour are updated at once from the cells of the other colours, so no update reads a cell that moves in the same
// dispatch. The grid of a face is two-coloured by the parity of X + Y; across a face's edge the neighbour's parity is not consistent (the 4-neighbour graph of a cube's faces is not
// bipartite: the three cells at a cube's corner are pairwise neighbours, and along four of the twelve edges the parity of both sides agree). So a cell whose neighbour across an edge has its
// own parity and a larger id is `late`: it is moved after the rest, in the colour 2 + its parity (two late cells that are neighbours then differ in parity, and a late cell's larger
// neighbour of its own parity is not late unless it has a still larger one, which only happens in a corner's triangle, where the parities differ again) [design: checked as a proper colouring
// of the whole graph by aquifer.test.ts at tiers 0 and 1; the late cells are 4 fn pairs, 16,384 at tier 4, 0.016% of the cells, a list a kernel visits apart from the grid].
import type { Gpu } from "../device";
import { cover, pipeline, readback, storage } from "../kernel";
import { GFIELDS, aquiferWgsl } from "../wgsl/globe-aquifer";
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

// The relaxation on the device: the fields of GFIELDS but the colour (one i32 word a cell each) as the kernels of wgsl/globe-aquifer.ts hold them.
const CHUNK = 64;
export interface Settled { sweeps: number; change: number }
export class GlobalAquifer {
  readonly N: number;
  private readonly F: GPUBuffer; private readonly C: GPUBuffer; private readonly P: GPUBuffer[] = [];
  constructor(readonly gpu: Gpu, readonly tier: number, fields: Record<string, Int32Array | Uint32Array>, reverse = false) {
    this.N = FACES * tierGrid(tier).fn ** 2;
    const bytes = GFIELDS.length * this.N * 4;
    if (bytes > gpu.device.limits.maxBufferSize || bytes > gpu.device.limits.maxStorageBufferBindingSize) throw new Error(`aquifer: the state of tier ${tier} is ${(bytes / 1e9).toFixed(2)} GB, over a buffer's ${(gpu.device.limits.maxStorageBufferBindingSize / 1e9).toFixed(2)}`);
    this.F = storage(gpu, bytes); this.C = storage(gpu, 16);
    GFIELDS.forEach((name, k) => {
      const a = name === "col" ? colourField(tier) : fields[name];
      if (!a || a.length !== this.N) throw new Error(`aquifer: field ${name} holds ${a?.length} cells, wanted ${this.N}`);
      gpu.device.queue.writeBuffer(this.F, k * this.N * 4, a.buffer, a.byteOffset, a.byteLength);
    });
    for (let colour = 0; colour < COLOURS; colour++) for (let slot = 0; slot < 2; slot++) this.P.push(storage(gpu, Uint32Array.of(colour, slot, reverse ? 1 : 0, 0)));
  }
  // Sweeps (the four colours in turn, in chunks of 64) until the greatest change of a head in the last sweep is under `tol` (units of the head's word) or `most` are made.
  async relax(most: number, tol: number): Promise<Settled> {
    const { gpu } = this, p = pipeline(gpu, aquiferWgsl(this.tier), "aqg"), groups = cover(gpu, this.N);
    const binds = this.P.map((P) => gpu.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [this.F, this.C, P].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
    let sweeps = 0, change = 0;
    do {
      gpu.device.queue.writeBuffer(this.C, 0, new Uint32Array(4));
      const enc = gpu.device.createCommandEncoder(), pass = enc.beginComputePass();
      pass.setPipeline(p);
      for (let s = 0; s < CHUNK; s++) for (let colour = 0; colour < COLOURS; colour++) { pass.setBindGroup(0, binds[colour * 2 + (s === CHUNK - 1 ? 1 : 0)]); pass.dispatchWorkgroups(groups[0], groups[1]); }
      pass.end();
      gpu.device.queue.submit([enc.finish()]);
      sweeps += CHUNK;
      change = new Uint32Array(await readback(gpu, this.C, 8, 0))[1];
    } while (change >= tol && sweeps < most);
    return { sweeps, change };
  }
  async field(name: (typeof GFIELDS)[number]): Promise<Int32Array> { return new Int32Array(await readback(this.gpu, this.F, this.N * 4, GFIELDS.indexOf(name) * this.N * 4)); }
  release() { for (const b of [this.F, this.C, ...this.P]) b.destroy(); }
}
