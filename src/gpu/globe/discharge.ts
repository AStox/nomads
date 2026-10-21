// The planet's water as one network: the discharge of every cell of the 75 m tier is the sum of the weights of everything that drains to it, anywhere on the planet, across tile and
// face edges, found once over the whole forest of receivers (`t4-to.u32`) by the regional tier's kernels (regional.ts `Regional.forest` and `gather64`), so that a river leaving one
// tile arrives in the next as the same river (the water stage reads these sums as the water that enters its patch over the patch's border).
//
// What goes in: a global field file per weight, one u32 a cell (what that cell sheds into its receiver in the field's own unit, e.g. the year's surplus over the cell in 1/64 m3,
// the water stage's V unit, or `ONES` for a count of cells). What comes out, for each weight field `stem`: `<stem>-lo.u32` (the sum's low 32 bits) and `<stem>-hi.u16` (bits 32 to 47).
// The sum is exact where a basin's total passes 32 bits: the gather adds in two words (no limb can overflow, the kernel carries) and the planet's whole weight must stay under
// 2^48 (a cell's weight times 100.7 million cells: a weight under 2^21, 32,768 m3 a season over a cell, always holds; `dischargeOf` checks the roots' total). A count of cells never
// passes 2^27, so its file has no high part (`<stem>.u32`).
// A cell draining to itself (the sea) holds the sum of its basin. Where a weight is set on sea cells it is carried like any other.
import type { Gpu } from "../device";
import { Regional } from "./regional";
import { FACES, tierGrid } from "./grid";
import type { BakeDir } from "./tiers";

export const ONES = "ones";
export interface WeightField { from: string; stem: string }
export const loFile = (stem: string) => `${stem}-lo.u32`;
export const hiFile = (stem: string) => `${stem}-hi.u16`;
export const countFile = (stem: string) => `${stem}.u32`;

// A discharge as the sum's two words (the file's cells), and its value as one number (exact: under 2^48).
export interface Discharge { lo: Uint32Array; hi: Uint16Array | null }
export const readDischarge = (dir: BakeDir, stem: string): Discharge =>
  dir.has(hiFile(stem)) ? { lo: new Uint32Array(dir.raw(loFile(stem))), hi: new Uint16Array(dir.raw(hiFile(stem))) } : { lo: new Uint32Array(dir.raw(countFile(stem))), hi: null };
export const valueAt = (d: Discharge, id: number): number => d.lo[id] + (d.hi ? d.hi[id] * 2 ** 32 : 0);

export interface DischargeProgress { done: boolean; made: string[]; seconds: number }
// Make the sums of the weight fields not yet made, within `budgetS` seconds (a field's gather and its writing stop at the field; the next call goes on). `count` stems are weights of
// one a cell (ONES) whose sums are kept as u32.
export async function dischargeOf(gpu: Gpu, dir: BakeDir, tier: number, fields: readonly WeightField[], budgetS = Infinity, log: (s: string) => void = () => {}): Promise<DischargeProgress> {
  const t0 = performance.now(), spent = () => (performance.now() - t0) / 1000, g = tierGrid(tier), N = FACES * g.fn * g.fn;
  const todo = fields.filter((f) => !(f.from === ONES ? dir.has(countFile(f.stem)) : dir.has(hiFile(f.stem)) && dir.has(loFile(f.stem))));
  const made: string[] = [];
  if (!todo.length) return { done: true, made, seconds: spent() };
  const to = new Uint32Array(dir.raw(`t${tier}-to.u32`));
  if (to.length !== N) throw new Error(`discharge: tier ${tier} holds ${N} cells, its receivers ${to.length}`);
  const zero = new Int32Array(N), r = new Regional(gpu, tier, new Uint32Array(20 * 6 * 256 * 256), zero, zero);
  try {
    const f0 = performance.now();
    await r.forest(to);
    log(`discharge: the forest of tier ${tier} sorted by depth in ${((performance.now() - f0) / 1000).toFixed(1)} s, deepest ${await r.deepest()}`);
    let worst = 0;
    for (const f of todo) {
      if (spent() + worst * 1.3 > budgetS) break;
      const s0 = performance.now(), w = f.from === ONES ? new Uint32Array(N).fill(1) : new Uint32Array(dir.raw(f.from));
      if (w.length !== N) throw new Error(`discharge: ${f.from} holds ${w.length} cells, wanted ${N}`);
      const { lo, hi } = await r.gather64(w);
      if (f.from === ONES) {
        for (let k = 0; k < N; k++) if (hi[k] !== 0) throw new Error("discharge: a count of cells passed 32 bits");
        dir.write(countFile(f.stem), lo);
      } else {
        const top = new Uint16Array(N);
        for (let k = 0; k < N; k++) { if (hi[k] > 0xffff) throw new Error(`discharge: ${f.stem}'s sum at cell ${k} passed 48 bits`); top[k] = hi[k]; }
        dir.write(loFile(f.stem), lo); dir.write(hiFile(f.stem), top);
      }
      const dt = (performance.now() - s0) / 1000;
      worst = Math.max(worst, dt); made.push(f.stem);
      log(`discharge: ${f.stem} from ${f.from} ${dt.toFixed(1)} s`);
    }
  } finally { r.release(); }
  return { done: made.length === todo.length, made, seconds: spent() };
}

// The sum of weights down a forest on the CPU, in the order of Kahn's algorithm (the twin the kernel is checked against): exact in doubles while the totals stay under 2^53.
export function gatherTwin(to: ArrayLike<number>, weight: ArrayLike<number>): Float64Array {
  const n = to.length, sum = Float64Array.from({ length: n }, (_, i) => weight[i]), into = new Uint32Array(n), queue = new Int32Array(n);
  for (let i = 0; i < n; i++) if (to[i] !== i) into[to[i]]++;
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (into[i] === 0) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++], j = to[i];
    if (j === i) continue;
    sum[j] += sum[i];
    if (--into[j] === 0) queue[tail++] = j;
  }
  if (head !== n) throw new Error("gatherTwin: the receivers hold a cycle");
  return sum;
}

// The sum at one cell by walking up the forest from it: the cells among a cell's eight neighbours (as `near` lists them) that drain into it, and theirs in turn. For checking a
// few cells of a tier too large for gatherTwin.
export function sumUpstream(to: ArrayLike<number>, weight: (id: number) => number, near: (id: number) => number[], id: number): number {
  let total = 0;
  const stack = [id];
  while (stack.length) {
    const k = stack.pop()!;
    total += weight(k);
    for (const j of near(k)) if (j !== k && to[j] === k) stack.push(j);
  }
  return total;
}

// A forest sorted by depth for the passes that need one, made once from the tier's receivers.
export async function forestOf(gpu: Gpu, dir: BakeDir, tier: number): Promise<Regional> {
  const g = tierGrid(tier), N = FACES * g.fn * g.fn, to = new Uint32Array(dir.raw(`t${tier}-to.u32`)), zero = new Int32Array(N), r = new Regional(gpu, tier, new Uint32Array(20 * 6 * 256 * 256), zero, zero);
  await r.forest(to);
  return r;
}
// Signed weight files (i32 a cell) summed down the forest, each into `<stem>-lo.i32` and `<stem>-hi.i32` (the 64-bit two's complement sum's words); `mask` as Regional.gatherSigned takes it.
export async function signedGatherOf(r: Regional, dir: BakeDir, weights: readonly string[], stems: readonly string[], mask: Uint32Array, log: (s: string) => void = () => {}): Promise<void> {
  for (let c = 0; c < weights.length; c++) {
    const t0 = performance.now(), { lo, hi } = await r.gatherSigned(new Int32Array(dir.raw(weights[c])), mask);
    dir.write(`${stems[c]}-lo.i32`, lo); dir.write(`${stems[c]}-hi.i32`, hi);
    log(`gather: ${stems[c]} from ${weights[c]} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
}
