// The objects of a ground tile made as 64-cell blocks (src/gpu/globe/windowobjects.ts tileBlocks, each in its own frame) against the window's (windowObjects) from the same tile at the
// same share: every object of the window is in a block, at the same place within 1 mm, with the same kind, size and seed, and the blocks hold nothing the window does not.
//   bun scripts/play/blockobjects.ts [lat lon] [--key 7f6ff6c82cdd] [--k 2]
import { readFileSync } from "node:fs";
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { fromLatLon, locateVec, tierGrid } from "../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../src/gpu/globe/groundtile";
import { tileBlocks, windowObjects, type BlockSpec } from "../../src/gpu/globe/windowobjects";

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a) && !args[args.indexOf(a) - 1]?.startsWith("--")).map(Number), lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, N = 256, CELL_MM = 75000, UNITS = 5000, K = Number(at("--k", "2"));
await holdGpu();
const gpu = await theGpu(), g = tierGrid(TIER), loc = locateVec(g, fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), nT = 2 ** TIER;
const tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256), tile = loc.face * nT * nT + ty * nT + tx;
const gt = readGroundTile(readFileSync(`/tmp/planet-75m/1-${key}/groundtiles/f${loc.face}/${ty}-${tx}.gt.gz`));
// a window whose west edge is 60 cells into the tile and north edge 100 cells down it (the tile's corner of the objects)
const x0 = tx * 256 + 60, y0 = ty * 256 + 100, caps = [1 << 20, 1 << 21, 1 << 22, 1 << 23, 1 << 24];
const clip = (lo: number, hi: number) => { const a = Math.max(0, Math.floor(lo) - 1), b = Math.min(256, Math.ceil(hi) + 1); return [a, Math.max(0, b - a)]; };
const [rx, rw] = clip(x0 - tx * 256, x0 + N - tx * 256), [ry, rh] = clip(y0 - ty * 256, y0 + N - ty * 256);
const win = await windowObjects(gpu, TIER, [{ tile, source: tileSource(gt), rect: { x0: rx, y0: ry, w: rw, h: rh }, a0: tx * 256 * UNITS, a1: ty * 256 * UNITS, s0x: x0 * UNITS, s0y: y0 * UNITS, w0x: 0, w0y: 0, d0: 1, d1: 0 }], 1, { caps, share: 2 ** -K });
console.log(`window: ${win.n} objects at share ${win.share}`);
const blocks: BlockSpec[] = [];
for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) blocks.push({ bx0: bx * 64, by0: by * 64, n: 64, k: K });
const t0 = performance.now();
const got = await tileBlocks(gpu, TIER, { tile, source: tileSource(gt), rect: { x0: 0, y0: 0, w: 256, h: 256 }, a0: tx * 256 * UNITS, a1: ty * 256 * UNITS, s0x: 0, s0y: 0, w0x: 0, w0y: 0, d0: 1, d1: 0 }, blocks, 1, { caps });
console.log(`${got.length} blocks made in ${(performance.now() - t0).toFixed(0)} ms, ${got.reduce((a, b) => a + b.n, 0)} objects in all`);

type Obj = string;
const tuple = (x: number, z: number, what: number, size: number, seed: number) => `${what}:${seed}:${size}:${x}:${z}`;
const winSet: Obj[] = [], blockSet: Obj[] = [];
{
  const C = win.cap, b = new Uint32Array(await readback(gpu, win.body));
  for (let i = 0; i < win.n; i++) winSet.push(tuple(b[C + i], b[2 * C + i], b[3 * C + i], b[4 * C + i], b[5 * C + i]));
}
let bad = 0;
for (const blk of got) {
  const C = blk.cap, b = new Uint32Array(await readback(gpu, blk.body)), ox = (tx * 256 + blk.bx0 - x0) * CELL_MM, oz = (y0 + N - (ty * 256 + blk.by0 + blk.n_)) * CELL_MM;
  const start = new Uint32Array(await readback(gpu, blk.start));
  // the start array holds the right runs: every object of cell c has its place in cell c
  for (let c = 0; c < blk.n_ * blk.n_ && bad < 5; c++) for (let i = start[c]; i < start[c + 1]; i++) {
    const cx = Math.floor(b[C + i] / CELL_MM), cz = Math.floor(b[2 * C + i] / CELL_MM);
    if (cz * blk.n_ + cx !== c) { console.log(`FAIL block ${blk.bx0},${blk.by0}: slot ${i} stands in cell ${cz * blk.n_ + cx}, filed under ${c}`); bad++; }
  }
  for (let i = 0; i < blk.n; i++) {
    const x = b[C + i] + ox, z = b[2 * C + i] + oz;
    if (x < 0 || z < 0 || x >= N * CELL_MM || z >= N * CELL_MM) continue;
    blockSet.push(tuple(x, z, b[3 * C + i], b[4 * C + i], b[5 * C + i]));
  }
}
winSet.sort(); blockSet.sort();
let diff = 0;
for (let i = 0; i < Math.max(winSet.length, blockSet.length) && diff < 5; i++) if (winSet[i] !== blockSet[i]) { console.log(`FAIL at ${i}: window ${winSet[i]} blocks ${blockSet[i]}`); diff++; }
console.log(`${winSet.length === blockSet.length && !diff && !bad ? "ok  " : "FAIL"} window ${winSet.length} objects, blocks ${blockSet.length} inside the window`);
// the sources' draw-time thinning (wgsl/objects.js, spec.thin: the objects whose mixed seed has its top kd bits clear) takes a block made at share 2^-k0 to exactly the one made at 2^-(k0+kd)
const mix = (seed: number) => { let h = seed >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16; return h >>> 0; };
const dense = await tileBlocks(gpu, TIER, { tile, source: tileSource(gt), rect: { x0: 0, y0: 0, w: 256, h: 256 }, a0: tx * 256 * UNITS, a1: ty * 256 * UNITS, s0x: 0, s0y: 0, w0x: 0, w0y: 0, d0: 1, d1: 0 }, [{ bx0: 128, by0: 128, n: 64, k: 0 }, { bx0: 128, by0: 128, n: 64, k: 2 }], 1, { caps });
const read = async (o: (typeof dense)[number]) => { const b = new Uint32Array(await readback(gpu, o.body)); return Array.from({ length: o.n }, (_, i) => `${b[3 * o.cap + i]}:${b[5 * o.cap + i]}:${b[o.cap + i]}:${b[2 * o.cap + i]}`); };
const whole = (await read(dense[0])).filter((t) => (mix(Number(t.split(":")[1])) >>> 30) === 0).sort(), quarter = (await read(dense[1])).sort();
const thin = whole.length === quarter.length && whole.every((v, i) => v === quarter[i]) ? 0 : 1;
console.log(`${thin ? "FAIL" : "ok  "} a block made whole and thinned by the hash to a quarter: ${whole.length} objects, the block made at a quarter: ${quarter.length}`);
await exit(diff || bad || thin || winSet.length !== blockSet.length ? 1 : 0);
