// The ground as pages (demo/tile.ts groundPages) against the window it is made from: a real window at a place, then the 16 pages of 64 cells that tile it, each compared to the matching
// rectangle of the window's own buffers (fine layers, stream mask, light grid); then a second window 40 cells away, whose pages that the first holds must equal the first's.
//   bun scripts/play/groundpage.ts [lat lon] [--key 7f6ff6c82cdd] [--dx 40 --dy -25]
import { holdGpu, exit } from "../seeded";
import { theGpu } from "../../src/gpu/device";
import { readback } from "../../src/gpu/kernel";
import { CELL } from "../../src/terrain/grid";
import { GN, GRID_LAYER_WORDS, GRID_PITCH, FINE_LAYER_WORDS, FINE_OUT_LAYERS, FINE_PITCH, PAGE_FINE_PITCH, PAGE_FINE_LAYER_WORDS, PAGE_FINE_WORDS, PAGE_GRID_PITCH, PAGE_GRID_LAYER_WORDS, PAGE_GRID_WORDS, PAGE_MASK_WORDS, PAGE_NG, PAGE_NV, PAGE_CELLS, PAGE_SCRATCH_LAYER_WORDS } from "../../src/gpu/wgsl/terrain-window";
import * as G from "../../demo/globe";
import * as T from "../../demo/tile";
import type { WindowGround } from "../../demo/tile";
import type { TileSource } from "../../src/gpu/globe/scatter";

const root = `${import.meta.dir}/../..`;
// the page modules import the generator from the built site's island.js; here it is demo/island.ts itself, so groundwin.js is loaded after the plugin is in place
Bun.plugin({
  name: "demo-island",
  setup(b) {
    b.onResolve({ filter: /(^|\/)island\.js$/ }, (a) => (a.importer.includes("/demo/styles/") ? { path: `${root}/demo/island.ts` } : undefined));
  },
});
const G0 = globalThis as Record<string, unknown>;
G0.ISO_LIB = true;
G0.document ??= { createElement: () => ({}) };
const { createWindows } = await import(`${root}/demo/styles/isopixel/groundwin.js`);

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a) => /^-?\d/.test(a) && args[args.indexOf(a) - 1]?.startsWith("--") !== true).map(Number);
const lat = nums[0] ?? 4.35, lon = nums[1] ?? -39.38, key = at("--key", "7f6ff6c82cdd"), TIER = 5, dx = Number(at("--dx", "40")), dy = Number(at("--dy", "-25"));
await holdGpu();
const gpu = await theGpu(), radiusM = ((256 << TIER) * CELL * 2) / Math.PI;

// what each window's ground was made from, kept as windowGround is called
interface Made { src: TileSource; face: number; x0: number; y0: number; wg: WindowGround }
let made: Made | null = null;
const Tcap = { ...T, windowGround: async (g: typeof gpu, src: Made["src"], face: number, x0: number, y0: number, o: object) => (made = { src, face, x0, y0, wg: await T.windowGround(g, src, face, x0, y0, o) }).wg };
const wins = createWindows({ G, T: Tcap, gpu, base: `file:///tmp/planet-75m/1-${key}`, tier: TIER, seed: 1, radiusM, quick: [0, 0, 0, 0], keep: 6 });
const D2R = Math.PI / 180, cellsDeg = CELL / radiusM / D2R, lat1 = lat - dy * cellsDeg, lon1 = lon + (dx * cellsDeg) / Math.cos(lat * D2R);
await wins.build(lat, lon);
const A = made as unknown as Made;
await wins.build(lat1, lon1);
const B = made as unknown as Made;
console.log(`window A ${A.face}:${A.x0}:${A.y0}, window B ${B.face}:${B.x0}:${B.y0}`);

const bits = async (b: GPUBuffer) => new Uint32Array(await readback(gpu, b));
const done = () => gpu.device.queue.onSubmittedWorkDone();
let bad = 0;
const fail = (what: string, n: number, of: number, extra = "") => { const f = n > 0; if (f) bad++; console.log(`${f ? "FAIL" : "ok  "} ${what.padEnd(34)} ${n} of ${of} differ${extra}`); };

// ---------- pages of window A ----------
const list = Array.from({ length: 16 }, (_, k) => ({ px: A.x0 + PAGE_CELLS * (k % 4), py: A.y0 + PAGE_CELLS * Math.floor(k / 4), slot: k }));
const atlas = T.pageAtlas(gpu, 16);
const srcA = T.pageSource(gpu, A.src, A.face, A.x0, A.y0), srcB = T.pageSource(gpu, B.src, B.face, B.x0, B.y0);
const pagesA = T.groundPages(gpu, atlas, srcA, list);
await done();
const ms = (f: () => Promise<unknown>, reps = 5) => (async () => { const t: number[] = []; for (let i = 0; i < reps; i++) { const s = performance.now(); await f(); t.push(performance.now() - s); } return t.sort((a, b) => a - b); })();
const wTimes = await ms(async () => { const w = await T.windowGround(gpu, A.src, A.face, A.x0, A.y0); for (const b of [w.fine, w.mask, w.grid]) b.destroy(); });
const pTimes = await ms(async () => { T.groundPages(gpu, atlas, srcA, list); await done(); });
const cold = await ms(async () => { const sa = T.pageSource(gpu, A.src, A.face, A.x0, A.y0); T.groundPages(gpu, atlas, sa, list); await done(); sa.destroy(); });
const one = await ms(async () => { T.groundPages(gpu, atlas, srcA, list.slice(5, 6)); await done(); });
const show = (t: number[]) => t.map((v) => v.toFixed(0)).join(" ");
console.log(`windowGround ${show(wTimes)} ms; pageSource + 16 pages ${show(cold)} ms; 16 pages from a source in hand ${show(pTimes)} ms; 1 page ${show(one)} ms (sorted, warm)`);
const budget = wTimes[2] * 1.3;
fail("16 pages and their source within the window's time + 30%", cold[2] > budget ? 1 : 0, 1, ` (median ${cold[2].toFixed(0)} ms against ${budget.toFixed(0)})`);
const pageBytes = (PAGE_FINE_WORDS + PAGE_GRID_WORDS + PAGE_MASK_WORDS) * 4;
console.log(`per page: fine ${((PAGE_FINE_WORDS * 4) / 1e6).toFixed(2)} MB (${FINE_OUT_LAYERS} x ${PAGE_NV} rows x ${PAGE_FINE_PITCH} words), grid ${((PAGE_GRID_WORDS * 4) / 1e6).toFixed(2)} MB (5 x ${PAGE_NG} x ${PAGE_GRID_PITCH}), mask ${((PAGE_MASK_WORDS * 4) / 1e6).toFixed(2)} MB; atlas ${((pageBytes * 16) / 1e6).toFixed(1)} MB, scratch ${((2 * PAGE_SCRATCH_LAYER_WORDS * 4 * 16) / 1e6).toFixed(1)} MB a call`);

const Wf = await bits(A.wg.fine), Wg = await bits(A.wg.grid), Wm = await bits(A.wg.mask), Pf = await bits(atlas.fine), Pg = await bits(atlas.grid), Pm = await bits(atlas.mask);
const f32 = (u: number) => { const b = new Uint32Array([u]); return new Float32Array(b.buffer)[0]; };
const M = 1021;
for (const [w, k] of list.map((l, k) => [l, k] as const)) {
  const ox = w.px - A.x0, oy = w.py - A.y0;
  let fine = 0, fineN = 0, off = 0;
  for (let l = 0; l < FINE_OUT_LAYERS; l++) {
    for (let r = 0; r < PAGE_NV; r++) {
      const yw = 766 - 4 * oy + r;
      for (let c = 0; c < PAGE_NV; c++) {
        const xw = 4 * ox + c - 2;
        if (xw < 0 || yw < 0 || xw >= M || yw >= M) { off++; continue; }
        fineN++;
        if (Pf[k * PAGE_FINE_WORDS + l * PAGE_FINE_LAYER_WORDS + r * PAGE_FINE_PITCH + c] !== Wf[l * FINE_LAYER_WORDS + yw * FINE_PITCH + xw]) fine++;
      }
    }
  }
  let mask = 0;
  for (let r = 0; r < 1024; r++) for (let c = 0; c < 256; c++) if (Pm[k * PAGE_MASK_WORDS + r * 256 + c] !== Wm[(3072 - 16 * oy + r) * 1024 + 4 * ox + c]) mask++;
  // the window's grid is evaluated in its own frame's floats (a node's place divided by 18.75 there), a page's from thirds of a vertex, so the layers agree to rounding, not bit for bit
  const lim = [1e-3, 5e-5, 5e-5, 5e-5, 5e-5];
  const names = ["h", "ao", "slope", "gx", "gz"];
  const worst = [0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0];
  for (let l = 0; l < 5; l++) {
    for (let b = 0; b < PAGE_NG; b++) {
      const j = 6 * (192 - oy) + b;
      for (let a = 0; a < PAGE_NG; a++) {
        const i = 6 * ox + a, p = Pg[k * PAGE_GRID_WORDS + l * PAGE_GRID_LAYER_WORDS + b * PAGE_GRID_PITCH + a], w2 = Wg[l * GRID_LAYER_WORDS + j * GRID_PITCH + i];
        if (p !== w2) { cnt[l]++; worst[l] = Math.max(worst[l], Math.abs(f32(p) - f32(w2))); }
      }
    }
  }
  fail(`page ${String(k).padStart(2)} fine (${off} off the crop)`, fine, fineN);
  fail(`page ${String(k).padStart(2)} mask`, mask, 1024 * 256);
  const over = worst.filter((v, l) => v > lim[l]).length;
  fail(`page ${String(k).padStart(2)} grid over its bound`, over, 5, ` (max abs ${names.map((n, l) => `${n} ${worst[l].toExponential(1)}`).join(", ")}; words not bit equal ${cnt.join("/")} of ${PAGE_NG * PAGE_NG})`);
}

// ---------- the edges pageEdges names: the shared line of two neighbours is the same words ----------
{
  let lines = 0, differ = 0;
  for (const p of list) {
    const e = T.pageEdges(p);
    for (const side of [e.xm, e.xp, e.ym, e.yp]) {
      const n = list.find((l) => l.px === side.px && l.py === side.py);
      if (!n) continue;
      const word = (A: Uint32Array, slot: number, base: number, layerWords: number, pitch: number, layers: number, len: number, at: number) => {
        const out: number[] = [];
        for (let l = 0; l < layers; l++) for (let i = 0; i < len; i++) out.push(A[slot * base + l * layerWords + (side.axis === "col" ? i * pitch + at : at * pitch + i)]);
        return out;
      };
      const mine = word(Pf, p.slot, PAGE_FINE_WORDS, PAGE_FINE_LAYER_WORDS, PAGE_FINE_PITCH, FINE_OUT_LAYERS, PAGE_NV, side.fine[0]), theirs = word(Pf, n.slot, PAGE_FINE_WORDS, PAGE_FINE_LAYER_WORDS, PAGE_FINE_PITCH, FINE_OUT_LAYERS, PAGE_NV, side.fine[1]);
      const gm = word(Pg, p.slot, PAGE_GRID_WORDS, PAGE_GRID_LAYER_WORDS, PAGE_GRID_PITCH, 5, PAGE_NG, side.grid[0]), gt = word(Pg, n.slot, PAGE_GRID_WORDS, PAGE_GRID_LAYER_WORDS, PAGE_GRID_PITCH, 5, PAGE_NG, side.grid[1]);
      lines++;
      differ += mine.filter((v, i) => v !== theirs[i]).length + gm.filter((v, i) => v !== gt[i]).length;
    }
  }
  fail("pageEdges lines of neighbours", differ, lines, ` (${lines} shared lines of fine and grid words)`);
}

// ---------- the pages two windows share ----------
const sharedList = list.filter((p) => p.px - B.x0 >= 0 && p.px - B.x0 + PAGE_CELLS <= 256 && p.py - B.y0 >= 0 && p.py - B.y0 + PAGE_CELLS <= 256);
const atlasB = T.pageAtlas(gpu, sharedList.length);
const placed = sharedList.map((p, k) => ({ ...p, slot: k }));
const pagesB = T.groundPages(gpu, atlasB, srcB, placed);
await done();
const Bw = await bits(B.wg.grid), Bf = await bits(atlasB.fine), Bg = await bits(atlasB.grid), Bm = await bits(atlasB.mask);
console.log(`${sharedList.length} pages are in both windows`);
let sFine = 0, sMask = 0, sGrid = 0, sGridAll = 0;
placed.forEach((p, k) => {
  const a = list.find((l) => l.px === p.px && l.py === p.py)!.slot;
  const cmp = (X: Uint32Array, Y: Uint32Array, words: number) => { let n = 0; for (let i = 0; i < words; i++) if (X[a * words + i] !== Y[k * words + i]) n++; return n; };
  // fine pages pad each row; the words past a row's 257 are never written, so compare the rows' values
  let f = 0;
  for (let l = 0; l < FINE_OUT_LAYERS; l++) for (let r = 0; r < PAGE_NV; r++) for (let c = 0; c < PAGE_NV; c++) { const o = l * PAGE_FINE_LAYER_WORDS + r * PAGE_FINE_PITCH + c; if (Pf[a * PAGE_FINE_WORDS + o] !== Bf[k * PAGE_FINE_WORDS + o]) { f++; console.log(`    fine layer ${l} row ${r} col ${c}: ${f32(Pf[a * PAGE_FINE_WORDS + o])} in A, ${f32(Bf[k * PAGE_FINE_WORDS + o])} in B`); } }
  let gd = 0;
  for (let l = 0; l < 5; l++) for (let r = 0; r < PAGE_NG; r++) for (let c = 0; c < PAGE_NG; c++) { const o = l * PAGE_GRID_LAYER_WORDS + r * PAGE_GRID_PITCH + c; if (Pg[a * PAGE_GRID_WORDS + o] !== Bg[k * PAGE_GRID_WORDS + o]) gd++; }
  const both = pagesB[k].exact && pagesA[a].exact;
  if (both) sFine += f;
  sMask += cmp(Pm, Bm, PAGE_MASK_WORDS);
  if (pagesB[k].exact && pagesA[list.findIndex((l) => l.px === p.px && l.py === p.py)].exact) sGrid += gd; else sGridAll += gd;
  console.log(`  page ${p.px - A.x0}, ${p.py - A.y0} in A, ${p.px - B.x0}, ${p.py - B.y0} in B: fine ${f} mask ${cmp(Pm, Bm, PAGE_MASK_WORDS)} grid ${gd} differ, exact in B ${pagesB[k].exact}, in A ${pagesA[a].exact}`);
});
fail("shared pages fine (exact in both)", sFine, sharedList.length * FINE_OUT_LAYERS * PAGE_NV * PAGE_NV, " (a vertex on the window's far lattice edge reads the mask held to its last texel)");
fail("shared pages mask", sMask, sharedList.length * PAGE_MASK_WORDS);
fail("shared pages grid (exact in both)", sGrid, sharedList.length * 5 * PAGE_NG * PAGE_NG, ` (pages held at one window's edge differ by ${sGridAll} words, as they may)`);

// the windows' own grids at the nodes both hold: the size of the rounding the pages are measured against
const nodeShift = 6 * (B.x0 - A.x0), rowShift = 6 * (B.y0 - A.y0), wWorst = [0, 0, 0, 0, 0];
for (let l = 0; l < 5; l++) for (let j = 0; j < GN; j++) for (let i = 0; i < GN; i++) {
  const ib = i - nodeShift, jb = j + rowShift;
  const m = (v: number) => Math.min(v, GN - 1 - v);
  if (Math.min(m(i), m(j), m(ib), m(jb)) < 20) continue;
  const d = Math.abs(f32(Wg[l * GRID_LAYER_WORDS + j * GRID_PITCH + i]) - f32(Bw[l * GRID_LAYER_WORDS + jb * GRID_PITCH + ib]));
  if (d > wWorst[l]) wWorst[l] = d;
}
console.log(`the two windows' own grids at the nodes they share (20 or more from either edge) differ by (max abs) h ${wWorst[0].toExponential(1)}, ao ${wWorst[1].toExponential(1)}, slope ${wWorst[2].toExponential(1)}, gx ${wWorst[3].toExponential(1)}, gz ${wWorst[4].toExponential(1)}`);
await exit(bad ? 1 : 0);
