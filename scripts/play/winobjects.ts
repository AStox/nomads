// The window's objects made on the GPU (src/gpu/globe/windowobjects.ts) against the CPU's cut of the same scatter (demo/styles/isopixel/winobjects.js collector), on a real ground tile with the
// window laid over part of it, at share 1 and under a small cap: the same objects in the same cells (what, seed, size, place), the same share when the cap forces one.
//   bun scripts/play/winobjects.ts [lat lon] [--key 7f6ff6c82cdd]
import { readFileSync } from "node:fs";
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { fromLatLon, locateVec, tierGrid } from "../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../src/gpu/globe/groundtile";
import { scatterTile } from "../../src/gpu/globe/scatter";
import { windowObjects } from "../../src/gpu/globe/windowobjects";
// @ts-expect-error plain JavaScript, no declarations
import { collector } from "../../demo/styles/isopixel/winobjects.js";

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a)).map(Number), lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, N = 256, CELL = 75, UNITS = 5000;
await holdGpu();
const gpu = await theGpu(), g = tierGrid(TIER), loc = locateVec(g, fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), nT = 2 ** TIER;
const tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256), tile = loc.face * nT * nT + ty * nT + tx;
const gt = readGroundTile(readFileSync(`/tmp/planet-75m/1-${key}/groundtiles/f${loc.face}/${ty}-${tx}.gt.gz`));
// a window whose west edge is 60 cells into the tile and north edge 100 cells down it: the objects of a corner of the tile
const x0 = tx * 256 + 60, y0 = ty * 256 + 100;
const clip = (lo: number, hi: number) => { const a = Math.max(0, Math.floor(lo) - 1), b = Math.min(256, Math.ceil(hi) + 1); return [a, Math.max(0, b - a)]; };
const [rx, rw] = clip(x0 - tx * 256, x0 + N - tx * 256), [ry, rh] = clip(y0 - ty * 256, y0 + N - ty * 256), rect = { x0: rx, y0: ry, w: rw, h: rh };
const ctx = { gpu, dir: null as never, tier: TIER };

const cpuRun = async (cap: number) => {
  const sc = (await scatterTile(ctx, tile, 1, 2, false, tileSource(gt), rect)).flora, col = collector({ N, CELL, cap });
  col.add(sc, (q: number, out: number[]) => { out[0] = tx * 256 + sc.px[q] * 2 - x0; out[1] = N - (ty * 256 + sc.py[q] * 2 - y0); return true; });
  return col.lay((k: number) => Math.max(k, 1));
};
type Objs = { n: number; cap: number; share: number; body: Uint32Array; start: Uint32Array };
const gpuRun = async (caps: number[], share?: number): Promise<Objs & { estimate: number }> => {
  const t0 = performance.now();
  const w = await windowObjects(gpu, TIER, [{ tile, source: tileSource(gt), rect, a0: tx * 256 * UNITS, a1: ty * 256 * UNITS, s0x: x0 * UNITS, s0y: y0 * UNITS, w0x: 0, w0y: 0, d0: 1, d1: 0 }], 1, { caps, share, side: N });
  const body = new Uint32Array(await readback(gpu, w.body)), start = new Uint32Array(await readback(gpu, w.start));
  console.log(`  gpu made ${w.n} objects (estimate ${w.estimate}), share ${w.share}, cap ${w.cap}, in ${(performance.now() - t0).toFixed(0)} ms`);
  return { n: w.n, cap: w.cap, share: w.share, body, start, estimate: w.estimate };
};

const key6 = (o: Objs, s: number) => { const C = o.cap, f = new Float32Array(o.body.buffer); return [o.body[C + s], o.body[2 * C + s], o.body[3 * C + s], o.body[5 * C + s], f[4 * C + s]]; };
function compare(label: string, a: Objs, b: Objs): number {
  let bad = 0, mm = 0, ulp = 0;
  if (a.n !== b.n) { console.log(`FAIL ${label}: counts ${a.n} and ${b.n}`); return 1; }
  const cells = N * N;
  for (let c = 0; c < cells && bad < 5; c++) {
    if (a.start[c] !== b.start[c]) { console.log(`FAIL ${label}: cell ${c} starts ${a.start[c]} and ${b.start[c]}`); bad++; continue; }
    const lo = a.start[c], hi = a.start[c + 1], order = (o: Objs) => Array.from({ length: hi - lo }, (_, i) => lo + i).sort((p, q) => key6(o, p)[3] - key6(o, q)[3] || key6(o, p)[2] - key6(o, q)[2] || key6(o, p)[0] - key6(o, q)[0]);
    const pa = order(a), pb = order(b);
    for (let i = 0; i < pa.length; i++) {
      const [ax, az, aw, as, asz] = key6(a, pa[i]), [bx, bz, bw, bs, bsz] = key6(b, pb[i]);
      if (aw !== bw || as !== bs) { if (bad++ < 5) console.log(`FAIL ${label}: cell ${c} object differs: what ${aw} ${bw}, seed ${as} ${bs}`); continue; }
      mm = Math.max(mm, Math.abs(ax - bx), Math.abs(az - bz));
      ulp = Math.max(ulp, Math.abs(asz - bsz) / Math.max(1e-30, Math.abs(asz)));
    }
  }
  if (mm > 1) { console.log(`FAIL ${label}: places differ by ${mm} mm`); bad++; }
  console.log(`${bad ? "FAIL" : "ok  "} ${label}: ${a.n} objects, largest place difference ${mm} mm, largest relative size difference ${ulp.toExponential(2)}`);
  return bad ? 1 : 0;
}

let failed = 0;
{
  console.log("share 1:");
  const cpu = await cpuRun(1 << 30), gpuO = await gpuRun([1 << 20, 1 << 21, 1 << 22, 1 << 23, 1 << 24], 1);
  failed += compare("share 1", cpu as Objs, gpuO);
}
{
  console.log("a cap of 2^20 slots:");
  const cpu = await cpuRun(1 << 20), gpuO = await gpuRun([1 << 20]);
  console.log(`  cpu share ${cpu.share}, ${cpu.n} objects`);
  if (cpu.share !== gpuO.share) console.log(`note: the estimate chose share ${gpuO.share}, the CPU's exact count ${cpu.share}`);
  failed += cpu.share === gpuO.share ? compare("cap 2^20", cpu as Objs, gpuO) : 0;
}
await exit(failed ? 1 : 0);
