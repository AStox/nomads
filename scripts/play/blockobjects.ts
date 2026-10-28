// The objects of a ground tile made as 64-cell blocks (src/gpu/globe/windowobjects.ts tileBlocks, each in its own frame) against the window's (windowObjects) from the same tile at the
// same share: every object of the window is in a block, at the same place within 1 mm, with the same kind, size and seed, and the blocks hold nothing the window does not.
// Then a window across a cube's edge (groundwin.js makeBlocks, the tiles of the face across laid in the window's frame): the union of its blocks' objects inside the window is its whole-window
// objects' (same kind, size, seed and place to the mm), every object stands in its own cell of its block's start array, and a turned block is the same bytes whichever window made it.
//   bun scripts/play/blockobjects.ts [lat lon] [--key 7f6ff6c82cdd] [--k 2] [--edge "0:7296:8190;2:2688:1;13.27,45"] [--shift 30] [--no-edge]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BAKE } from "../../src/gpu/globe/bakedir";
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { fromLatLon, locateVec, tierGrid } from "../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../src/gpu/globe/groundtile";
import { tileBlocks, windowObjects, type BlockSpec, type PlaceTile } from "../../src/gpu/globe/windowobjects";
import { CELL } from "../../src/terrain/grid";
import * as G from "../../demo/globe";
import * as T from "../../demo/tile";

const root = `${import.meta.dir}/../..`;
// the page modules import the generator from the built site's island.js; here it is demo/island.ts itself
Bun.plugin({
  name: "demo-island",
  setup(b) {
    b.onResolve({ filter: /(^|\/)island\.js$/ }, (a) => (a.importer.includes("/demo/styles/") ? { path: `${root}/demo/island.ts` } : undefined));
  },
});
const G0 = globalThis as Record<string, unknown>;
G0.ISO_LIB = true;
G0.document ??= { createElement: () => ({}) };
// loaded after the plugin above is in place, which a static import would not wait for
const { createWindows } = await import(`${root}/demo/styles/isopixel/groundwin.js`);

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a) && !args[args.indexOf(a) - 1]?.startsWith("--")).map(Number), lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, N = 256, CELL_MM = 75000, UNITS = 5000, K = Number(at("--k", "2"));
await holdGpu();
const gpu = await theGpu(), g = tierGrid(TIER), loc = locateVec(g, fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), nT = 2 ** TIER;
const tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256), tile = loc.face * nT * nT + ty * nT + tx;
const gt = readGroundTile(readFileSync(join(BAKE, `1-${key}`, "groundtiles", `f${loc.face}`, `${ty}-${tx}.gt.gz`)));
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
let edgeBad = 0;
// Windows across the cube's edges, each "face:X:Y" (the window's centre cell of the tier's face) or "lat,lon", at forested cells of the edges (the turn of each is printed): face 0's north and
// south, face 2's south, face 3's south, face 4's east, the page's place E (face 1 across, a shift and no turn), and a window inside one face over four tiles (no tile turned: the same union
// holds, which the boundary objects below show is the blocks' rule and not the turn's)
const places = args.includes("--no-edge") ? [] : at("--edge", "0:7296:8190;0:8064:1;2:2688:1;3:2176:1;4:8190:7296;13.27,45;4.35,-39.38").split(";").map((p) => {
  if (!p.includes(":")) return p.split(",").map(Number);
  const [f, X, Y] = p.split(":").map(Number), fnc = N << TIER, ll = G.latLon(G.pointOf(f, Math.tan((X / fnc - 0.5) * (Math.PI / 2)), Math.tan((Y / fnc - 0.5) * (Math.PI / 2))));
  return [(ll.lat * 180) / Math.PI, (ll.lon * 180) / Math.PI];
});
for (const [elat, elon] of places) {
  const shift = Number(at("--shift", "30")), radiusM = ((256 << TIER) * CELL * 2) / Math.PI;
  const wins = createWindows({ G, T, gpu, base: pathToFileURL(join(BAKE, `1-${key}`)).href, tier: TIER, seed: 1, radiusM, quick: [0, 0, 0, 0], keep: 6, put: async () => {} });
  const before = edgeBad, fail = (msg: string) => { console.log(`FAIL ${msg}`); edgeBad++; };
  // an object's identity as two 32-bit lanes of a mix of its place (mm), kind, size and seed, sorted as 64-bit words to compare two sets
  const lanes = (x: number, z: number, what: number, size: number, seed: number) => {
    let a = 0x811c9dc5, c = 0x9e3779b9;
    for (const v of [x, z, what, size, seed]) { a = Math.imul(a ^ v, 0x01000193); c = Math.imul(c + v, 0x85ebca6b); c ^= c >>> 15; c = Math.imul(c, 0xc2b2ae35); }
    return [a >>> 0, c >>> 0];
  };
  const sameSet = (A: BigUint64Array, B: BigUint64Array) => { A.sort(); B.sort(); return A.length === B.length && A.every((v, i) => v === B[i]); };
  const bodyOf = async (o: { body: GPUBuffer; cap: number; n: number }) => new Uint32Array(await readback(gpu, o.body)).subarray(0, 7 * o.cap);

  const win = await wins.build(elat, elon);
  const plan = win.blockPlan;
  if (!plan) { fail(`the window ${win.id} at ${elat}, ${elon} has no block plan (a tile's turn is not known)`); }
  else {
    const turned = plan.tiles.filter((t: { at: unknown }) => t.at);
    console.log(`edge window ${win.id}: ${plan.tiles.length} tiles, ${turned.length} turned (${turned.map((t: { tile: number; at: { units: { d0: number; d1: number } } }) => `${t.tile} d=${t.at.units.d0},${t.at.units.d1}`).join("; ")})`);
    if (!turned.length) console.log("  no tile across an edge: a control, the window's own face over several tiles");
    const t0 = performance.now();
    const r = await wins.makeBlocks(win, new Map());
    console.log(`${r.recs.length} blocks (${r.recs.filter((b: { key: string }) => b.key.includes("@")).length} turned) made at share 2^-${r.k0} in ${(performance.now() - t0).toFixed(0)} ms, ${r.n} objects`);
    // the window's tiles as the whole-window path takes them: a tile of its own face by the plain shift, a turned one by its units
    const clip = (lo: number, hi: number) => { const a0 = Math.max(0, Math.floor(lo) - 1), b0 = Math.min(256, Math.ceil(hi) + 1); return [a0, Math.max(0, b0 - a0)]; };
    const placed: PlaceTile[] = plan.tiles.map((t: { tile: number; tx: number; ty: number; gt: Parameters<typeof tileSource>[0]; at: { rect: PlaceTile["rect"]; units: Record<string, number> } | null }) => {
      const [rx0, rw0] = clip(win.x0 - t.tx * 256, win.x0 + N - t.tx * 256), [ry0, rh0] = clip(win.y0 - t.ty * 256, win.y0 + N - t.ty * 256);
      return { tile: t.tile, source: tileSource(t.gt), rect: t.at ? t.at.rect : { x0: rx0, y0: ry0, w: rw0, h: rh0 }, a0: t.tx * 256 * UNITS, a1: t.ty * 256 * UNITS, ...(t.at ? t.at.units : { s0x: win.x0 * UNITS, s0y: win.y0 * UNITS, w0x: 0, w0y: 0, d0: 1, d1: 0 }) } as PlaceTile;
    });
    const whole = await windowObjects(gpu, TIER, placed, 1, { caps: [1 << 20, 1 << 21, 1 << 22, 1 << 23, 1 << 24], share: 2 ** -r.k0 });
    const wb = await bodyOf(whole), A = new BigUint64Array(whole.n), a32 = new Uint32Array(A.buffer);
    for (let i = 0; i < whole.n; i++) { const [lo, hi] = lanes(wb[whole.cap + i], wb[2 * whole.cap + i], wb[3 * whole.cap + i], wb[4 * whole.cap + i], wb[5 * whole.cap + i]); a32[2 * i] = lo; a32[2 * i + 1] = hi; }
    // the blocks: every object moved to the window's frame by the block's square (the record's X, Y in the window's face's cells), the cells of its start array checked on the way
    const inside: number[] = [];
    let filed = 0, objs = 0, turnedObjs = 0;
    for (const b of r.recs as { key: string; cap: number; n: number; body: GPUBuffer; start: GPUBuffer; X: number; Y: number }[]) {
      const C = b.cap, bb = await bodyOf(b), start = new Uint32Array(await readback(gpu, b.start)), ox = (b.X - win.x0) * CELL_MM, oz = (win.y0 + N - (b.Y + 64)) * CELL_MM;
      for (let c = 0; c < 64 * 64; c++) for (let i = start[c]; i < start[c + 1]; i++) if (Math.floor(bb[2 * C + i] / CELL_MM) * 64 + Math.floor(bb[C + i] / CELL_MM) !== c && filed++ < 5) console.log(`FAIL block ${b.key}: slot ${i} stands in cell ${Math.floor(bb[2 * C + i] / CELL_MM) * 64 + Math.floor(bb[C + i] / CELL_MM)}, filed under ${c}`);
      for (let i = 0; i < b.n; i++) {
        const x = bb[C + i] + ox, z = bb[2 * C + i] + oz;
        if (x < 0 || z < 0 || x >= N * CELL_MM || z >= N * CELL_MM) continue;
        inside.push(...lanes(x, z, bb[3 * C + i], bb[4 * C + i], bb[5 * C + i]));
        objs++;
        if (b.key.includes("@")) turnedObjs++;
      }
    }
    const B = new BigUint64Array(new Uint32Array(inside).buffer);
    if (filed) fail(`${filed} objects are filed under another cell than their own`);
    // A and B are sorted: walk both for the words only one holds. An object exactly on a tile's south edge (py 0) stands a row up in the window (its cells are open at the south, z runs from the
    // north) but past its block's last row, so only the window holds it: the same as for any block of a tile of the window's own face, counted apart and allowed only on a cell edge.
    A.sort(); B.sort();
    const lone = new Set<bigint>();
    let onlyBlocks = 0;
    for (let i = 0, j = 0; i < A.length || j < B.length;) {
      if (j >= B.length || (i < A.length && A[i] < B[j])) { if (lone.size < 1000) lone.add(A[i]); i++; }
      else if (i >= A.length || B[j] < A[i]) { onlyBlocks++; j++; }
      else { i++; j++; }
    }
    let edgeOnly = 0, strayed = 0;
    for (let i = 0; i < whole.n && lone.size; i++) {
      const [lo, hi] = lanes(wb[whole.cap + i], wb[2 * whole.cap + i], wb[3 * whole.cap + i], wb[4 * whole.cap + i], wb[5 * whole.cap + i]);
      if (!lone.has((BigInt(hi) << 32n) | BigInt(lo))) continue;
      if (wb[whole.cap + i] % CELL_MM === 0 || wb[2 * whole.cap + i] % CELL_MM === 0) edgeOnly++;
      else if (strayed++ < 5) console.log(`  only in the window: kind ${wb[3 * whole.cap + i]} seed ${wb[5 * whole.cap + i]} at x ${wb[whole.cap + i] / CELL_MM} z ${wb[2 * whole.cap + i] / CELL_MM} (window cells)`);
    }
    if (onlyBlocks || strayed) fail(`the window's ${whole.n} objects and the blocks' ${B.length} inside it differ: ${onlyBlocks} only in the blocks, ${strayed} only in the window off a tile edge`);
    if (turned.length && !turnedObjs) fail("no object stands in a turned block");
    console.log(`${edgeBad > before ? "FAIL" : "ok  "} edge window ${whole.n} objects, blocks ${B.length} inside the window (${turnedObjs} in turned blocks; ${edgeOnly} only the window's, on a tile's south edge), every object in its own cell`);
    // a cache entry another window's call sweeps while this call awaits (it shows when the tiles' runs are chosen, then is gone when the blocks are made): the block is made anyway
    {
      const seeded = new Map((r.recs as { key: string }[]).map((b) => [b.key, b])), seen = new Set<string>(), flaky = { get: (k: string) => (seen.has(k) ? undefined : (seen.add(k), seeded.get(k))), set: (k: string, v: unknown) => seeded.set(k, v) };
      const again = await wins.makeBlocks(win, flaky as unknown as Map<string, never>).catch((e: Error) => e);
      if (again instanceof Error) fail(`makeBlocks with a cache that loses entries: ${again.message}`);
      else if (again.recs.length !== r.recs.length || again.n !== r.n) fail(`makeBlocks with a cache that loses entries: ${again.recs.length} blocks, ${again.n} objects against ${r.recs.length}, ${r.n}`);
      else console.log(`ok   makeBlocks with a cache that loses entries made all ${again.recs.length} blocks again (${again.fresh.length} fresh, ${again.n} objects)`);
    }
    if (!turned.length) continue;
    // a turned block is the same bytes whichever window holds it: a window shifted along the edge makes its own, and every turned block both made is equal (record corner and objects)
    const fn = N << TIER, sx = win.x0 + N / 2 + shift >= fn ? -shift : shift, cp = G.pointOf(win.face, Math.tan(((win.x0 + N / 2 + sx) / fn - 0.5) * (Math.PI / 2)), Math.tan(((win.y0 + N / 2) / fn - 0.5) * (Math.PI / 2))), ll = G.latLon(cp);
    const win2 = await wins.build((ll.lat * 180) / Math.PI, (ll.lon * 180) / Math.PI);
    const r2 = await wins.makeBlocks(win2, new Map());
    const mine = new Map((r.recs as { key: string }[]).map((b) => [b.key, b]));
    let shared = 0, differ = 0;
    for (const b2 of r2.recs as { key: string; cap: number; n: number; body: GPUBuffer; X: number; Y: number; k: number }[]) {
      const b1 = mine.get(b2.key) as typeof b2 | undefined;
      if (!b1 || !b2.key.includes("@")) continue;
      shared++;
      // each window made the block at its own share: both are thinned by the hash to the thinner one
      const kTo = Math.max(b1.k, b2.k), setOf = async (b: typeof b2) => { const bb = await bodyOf(b), out: number[] = []; for (let i = 0; i < b.n; i++) if (kTo === 0 || mix(bb[5 * b.cap + i]) >>> (32 - kTo) === 0) out.push(...lanes(bb[b.cap + i], bb[2 * b.cap + i], bb[3 * b.cap + i], bb[4 * b.cap + i], bb[5 * b.cap + i])); return new BigUint64Array(new Uint32Array(out).buffer); };
      if (b1.X !== b2.X || b1.Y !== b2.Y || !sameSet(await setOf(b1), await setOf(b2))) { differ++; console.log(`FAIL turned block ${b2.key} differs between window ${win.id} and ${win2.id}`); }
    }
    if (!shared) fail(`windows ${win.id} and ${win2.id} share no turned block: pass --shift`);
    if (differ) edgeBad++;
    console.log(`${differ || !shared ? "FAIL" : "ok  "} ${shared} turned blocks made by two windows (${win.id}, ${win2.id}), ${differ} differ`);
  }
}
await exit(diff || bad || thin || edgeBad || winSet.length !== blockSet.length ? 1 : 0);
