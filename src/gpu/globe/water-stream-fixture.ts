// What the streamed discharge's and lakes' tests stage and compare with (discharge-stream.test.ts, basin-stream.test.ts): a forest of receivers made by descent on a smooth potential, so that
// basins are large and cross tile edges, face edges and cube corners; random weights; hollows as smooth blobs; and the hash and the word-for-word sample of a file against another.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { BakeDir } from "./bakedir";
import { gatherTwin } from "./discharge";
import { FACES, centre, tierGrid } from "./grid";
import { cellAcross } from "./patch";

export const hashOf32 = (k: number, seed = 0) => { let x = Math.imul(k ^ seed, 2654435761); x ^= x >>> 15; x = Math.imul(x, 2246822519); return (x ^ (x >>> 13)) >>> 0; };
const NEAR8: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

// The smooth fields over the sphere at every cell of the tier.
export function smoothFields(tier: number, of: (x: number, y: number, z: number) => number): Float64Array {
  const g = tierGrid(tier), n = g.fn, out = new Float64Array(FACES * n * n);
  for (let f = 0, i = 0; f < FACES; f++) for (let Y = 0; Y < n; Y++) for (let X = 0; X < n; X++, i++) { const [x, y, z] = centre(g, f, X, Y); out[i] = of(x, y, z); }
  return out;
}
export const potential = (tier: number) => smoothFields(tier, (x, y, z) => Math.sin(3 * x + 0.7) + 0.8 * Math.sin(5 * y - 0.3) + 0.6 * Math.cos(4 * z + 1.1) + 0.5 * Math.sin(7 * (x + y + z)));

// A forest: every cell drains to its lowest neighbour (the eight, across the faces' edges, ties by id) where that is lower than itself, else to itself (a root, as the sea).
export function descentForest(tier: number, pot: Float64Array = potential(tier)): Uint32Array {
  const g = tierGrid(tier), n = g.fn, cells = n * n, to = new Uint32Array(pot.length);
  for (let i = 0; i < to.length; i++) {
    const f = Math.floor(i / cells), r = i - f * cells, Y = Math.floor(r / n), X = r - Y * n;
    let best = i;
    for (const [dx, dy] of NEAR8) {
      const j = cellAcross(g, f, X + dx, Y + dy);
      if (j >= 0 && (pot[j] < pot[best] || (pot[j] === pot[best] && j < best))) best = j;
    }
    to[i] = best;
  }
  return to;
}
// The receivers' crossings of faces and of the cells next to a face's corner, to see that a test has them.
export function crossings(tier: number, to: Uint32Array): { faces: number; corners: number } {
  const n = tierGrid(tier).fn, cells = n * n, corner = (id: number) => { const r = id % cells, X = r % n, Y = Math.floor(r / n); return (X < 2 || X >= n - 2) && (Y < 2 || Y >= n - 2); };
  let faces = 0, corners = 0;
  for (let i = 0; i < to.length; i++) if (to[i] !== i && Math.floor(to[i] / cells) !== Math.floor(i / cells)) { faces++; if (corner(i) || corner(to[i])) corners++; }
  return { faces, corners };
}
// Weights of a field: a u32 from `lo` up to `lo + span` a cell.
export const randomWeights = (n: number, lo: number, span: number, seed: number) => Uint32Array.from({ length: n }, (_, k) => lo + (hashOf32(k, seed) % span));

// The 64-bit sums as the two files hold them, from the doubles of the in-memory twin.
export function wordsOf(sum: Float64Array): { lo: Uint32Array; hi: Uint16Array } {
  const lo = new Uint32Array(sum.length), hi = new Uint16Array(sum.length);
  for (let k = 0; k < sum.length; k++) { lo[k] = sum[k] >>> 0; hi[k] = Math.floor(sum[k] / 4294967296); }
  return { lo, hi };
}

// The files of a hollow field for the lakes' test at a tier: heights, flooded surface, lake net, receivers and the four seasons' discharges (what basinOf reads).
export function basinFixture(dir: BakeDir, tier: number, to: Uint32Array) {
  const n = to.length, h = smoothFields(tier, (x, y, z) => 3000 * Math.sin(2 * x + 1) * Math.cos(3 * y) + 1500 * Math.sin(4 * z) + 800), d = smoothFields(tier, (x, y, z) => 3000 * Math.sin(37 * x + 0.4) * Math.sin(29 * y + 0.8) * Math.cos(31 * z + 0.2) - 600);
  const height = new Int32Array(n), flooded = new Int32Array(n), net = new Int32Array(n);
  for (let i = 0; i < n; i++) { height[i] = Math.round(h[i]) - 300; flooded[i] = height[i] + Math.max(0, Math.round(d[i])); net[i] = ((hashOf32(i, 7) % 4001) - 3500) * 5000; }
  dir.write(`t${tier}-height.i32`, height); dir.write(`t${tier}-flooded.i32`, flooded); dir.write(`t${tier}-lakenet.i32`, net); dir.write(`t${tier}-to.u32`, to);
  for (let s = 0; s < 4; s++) {
    const { lo, hi } = wordsOf(gatherTwin(to, randomWeights(n, 0, 1 << 21, 100 + s)));
    dir.write(`t${tier}-q${s}-lo.u32`, lo); dir.write(`t${tier}-q${s}-hi.u16`, hi);
  }
}
// `names` of the files in `from` linked into `into`, a read-only copy for another run on the same inputs.
export function linkInto(from: BakeDir, into: BakeDir, names: readonly string[]) {
  for (const f of names) { mkdirSync(dirname(into.path(f)), { recursive: true }); rmSync(into.path(f), { force: true }); symlinkSync(from.path(f), into.path(f)); }
}

// A whole (small enough) file as a typed array.
export const wordsOfFile = <A extends Uint8Array | Uint16Array | Uint32Array>(path: string, kind: { new (b: ArrayBuffer): A }): A => new kind(new BakeDir(dirname(path)).raw(basename(path)));

// sha256 of a file, 16 hex, read in chunks.
export function sha(path: string): string {
  const h = createHash("sha256"), fd = openSync(path, "r"), buf = Buffer.alloc(32 << 20);
  try { for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex").slice(0, 16);
}
// A few thousand cells' indices spread over the tier, the same on every call.
export const sampleOf = (n: number, count = 4000): number[] => Array.from({ length: count }, (_, k) => hashOf32(k, 31) % n);

// ---------- the real tier 4 of planet 883a8d9387df (the in-memory results are the oracle) ----------
export const REAL = "/tmp/planet-75m/1-883a8d9387df", SCRATCH = "/tmp/planet-75m/stream-water-scratch";
export const haveReal = () => ["t4-to.u32", "t4-q0-hi.u16", "t4-cells.u32", "t4-basin.u8", "t4-lakenet.i32"].every((f) => existsSync(`${REAL}/${f}`));
// The weights the in-memory discharge was made of, found by taking from every cell's sum the sums of the cells that drain into it (the forest's inverse, exact in doubles): the weight files were
// spent. Throws where a result is not a u32 (it would not be a discharge of weights).
export function weightsOf(to: Uint32Array, lo: Uint32Array, hi: Uint16Array | null): Uint32Array {
  const n = to.length, w = new Float64Array(n), out = new Uint32Array(n), q = (i: number) => lo[i] + (hi ? hi[i] * 4294967296 : 0);
  for (let i = 0; i < n; i++) w[i] = q(i);
  for (let i = 0; i < n; i++) if (to[i] !== i) w[to[i]] -= q(i);
  for (let i = 0; i < n; i++) { if (!(w[i] >= 0 && w[i] < 4294967296)) throw new Error(`weightsOf: cell ${i} gets ${w[i]}`); out[i] = w[i]; }
  return out;
}
