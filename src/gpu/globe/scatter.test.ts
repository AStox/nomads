// The scatter (scatter.ts): what grew on a tile of the 75 m tier, a pure function of the tile's fields and the draws keyed by its quads. The cases run on the real planet (the bake of seed 1 under
// the bake directory, skipped where it is not) with the ground stage's outputs made for the tiles they need in the bake directory's ground-scratch/bake (ground-staged.ts: the air stage's files, a
// stand-in for the water stage's, the ground's own). The island's own scenery goldens (gpu/terrain/scenery.test.ts) are the proof that the widened kernels are the island's. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/scatter.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { FLORA, SPECIES } from "../../terrain/flora";
import { SHRUBS, TREES } from "../../terrain/niche";
import { releaseGpu } from "../device";
import { REAL, scratchBake } from "./ground-staged";
import { RIVER_HALO, scatterTile, type TileScatter } from "./scatter";
import { tileAt } from "./patch";
import { mappedField } from "./ground";
import type { Ctx } from "./stages";

afterAll(releaseGpu);
const real = REAL ? test : test.skip;
const SEED = 1;
const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const hashOf = (t: TileScatter) => Bun.hash(Buffer.concat([t.flora.start, t.flora.kind, t.flora.species, t.flora.px, t.flora.py, t.flora.size, t.flora.seed].map(bytes).concat([Buffer.from(JSON.stringify(t.flora.ore))]))).toString(16);
const counts = (t: TileScatter) => { const c: Record<string, number> = {}; for (let e = 0; e < t.flora.n; e++) { const k = FLORA[t.flora.kind[e]], s = SPECIES[t.flora.species[e]], key = s ? `${k}:${s}` : k; c[key] = (c[key] ?? 0) + 1; } return c; };
const kindOf = (t: TileScatter, e: number) => FLORA[t.flora.kind[e]];
let made: Promise<Ctx> | undefined;
// the tiles the cases touch: 458 and its east neighbour 459, the forested tile 0 and the coast's 14, and 1500
const TILES = [458, 459, 0, 14, 1500];
const ctx = () => (made ??= scratchBake(TILES, RIVER_HALO));
const forest = (t: TileScatter) => { const c = counts(t); return Object.entries(c).filter(([k]) => k.startsWith("tree")).reduce((a, [, n]) => a + n, 0); };

describe("the scatter of a tile of the real planet (seed 1)", () => {
  real("a tile's objects are the same bytes twice, and the same made after another tile", async () => {
    const c = await ctx(), a = await scatterTile(c, 458, SEED), b = await scatterTile(c, 459, SEED), again = await scatterTile(c, 458, SEED);
    expect(hashOf(again)).toBe(hashOf(a));
    expect(a.flora.n).toBeGreaterThan(100000);
    expect(hashOf(b)).not.toBe(hashOf(a));
    const other = await scatterTile(c, 458, SEED + 1);
    expect(hashOf(other)).not.toBe(hashOf(a));
    console.log(`scatter: tile 458 ${a.flora.n} objects (${forest(a)} trees, ${a.flora.ore.length} bog iron, ${a.segments} stream segments), tile 459 ${b.flora.n}; made twice and after another, equal; another seed differs by ${(Math.abs(other.flora.n / a.flora.n - 1) * 100).toFixed(2)}% in count`);
  }, 280_000);

  real("a halo of 3 cells gives the same objects as a halo of 2", async () => {
    const c = await ctx(), a = await scatterTile(c, 458, SEED, 2), b = await scatterTile(c, 458, SEED, 3);
    expect(hashOf(b)).toBe(hashOf(a));
  }, 280_000);

  real("an object near a tile's edge is made once, by the tile that holds its quad", async () => {
    const c = await ctx(), a = await scatterTile(c, 458, SEED, 2, true), b = await scatterTile(c, 459, SEED, 2, true);
    const A = tileAt(4, 458), B = tileAt(4, 459);
    expect([B.face, B.ty, B.tx]).toEqual([A.face, A.ty, A.tx + 1]);
    // every entry lies in its own tile (to the ten-thousandth of a game tile a position is rounded to)
    for (const t of [a, b]) {
      let outside = 0;
      for (let e = 0; e < t.flora.n; e++) if (t.flora.px[e] < 0 || t.flora.py[e] < 0 || t.flora.px[e] > 128.0002 || t.flora.py[e] > 128.0002) outside++;
      expect(outside).toBe(0);
    }
    // the same object is never in both: positions in game tiles from the face's corner (A's tile is 128 across, B's starts there), with the object's own seed
    const key = (t: TileScatter, e: number, dx: number) => `${Math.round((t.flora.px[e] + dx) * 1e4)}:${Math.round(t.flora.py[e] * 1e4)}:${t.flora.seed[e]}:${t.flora.kind[e]}`;
    const edgeA = new Set<string>();
    for (let e = 0; e < a.flora.n; e++) if (a.flora.px[e] > 120) edgeA.add(key(a, e, 0));
    let twice = 0, inB = 0;
    for (let e = 0; e < b.flora.n; e++) if (b.flora.px[e] < 8) { inB++; if (edgeA.has(key(b, e, 128))) twice++; }
    expect(twice).toBe(0);
    // density across the seam, per cell against its own cover: the objects of a kind in the two cell columns at the seam against the same cover's mean in the tile's cell columns 100 to 200
    // (no dip where a tile ends, no doubling where the next begins)
    const perCell = (t: TileScatter, k: number, kind: string, file: string, lo: number, hi: number) => {
      const cov = coverOf(c, k, file), cells = new Int32Array(256 * 256);
      for (let e = 0; e < t.flora.n; e++) if (kindOf(t, e) === kind) cells[Math.min(255, Math.floor(t.flora.py[e] * 2)) * 256 + Math.min(255, Math.floor(t.flora.px[e] * 2))]++;
      let n = 0, sum = 0;
      for (let y = 0; y < 256; y++) for (let x = lo; x < hi; x++) if (cov[y * 256 + x] > 0.5) { n++; sum += cells[y * 256 + x]; }
      return { n, mean: n ? sum / n : NaN };
    };
    const rows: string[] = [];
    for (const [kind, file] of [["tree", "t4-tree.u8"], ["grass", "t4-grs.u8"]] as const) {
      const seamA = perCell(a, 458, kind, file, 254, 256), inA = perCell(a, 458, kind, file, 100, 200), seamB = perCell(b, 459, kind, file, 0, 2), inB2 = perCell(b, 459, kind, file, 100, 200);
      rows.push(`${kind}: tile 458's last 2 cell columns ${seamA.mean.toFixed(1)} a cell (${seamA.n} cells over half cover) against ${inA.mean.toFixed(1)} inside; tile 459's first 2 ${seamB.mean.toFixed(1)} (${seamB.n}) against ${inB2.mean.toFixed(1)}`);
      if (seamA.n >= 30 && inA.n >= 30) expect(seamA.mean / inA.mean, `${kind} at 458's east edge`).toBeGreaterThan(0.6);
      if (seamB.n >= 30 && inB2.n >= 30) expect(seamB.mean / inB2.mean, `${kind} at 459's west edge`).toBeGreaterThan(0.6);
      if (seamA.n >= 30 && inA.n >= 30) expect(seamA.mean / inA.mean).toBeLessThan(1.6);
      if (seamB.n >= 30 && inB2.n >= 30) expect(seamB.mean / inB2.mean).toBeLessThan(1.6);
    }
    console.log(`scatter: seam of tiles 458 and 459, ${edgeA.size} of A's objects within 1.2 km of the edge and ${inB} of B's, ${twice} in both:\n  ${rows.join("\n  ")}`);
    // the fine field is continuous across the edge: the vertex column at the east edge of A (u = 1024) and the one at the west edge of B (u = 0) are one place, and off the streams the same height
    const M = 1025, RM = 4096;
    let same = 0, compared = 0, worst = 0;
    for (let v = 0; v < M; v++) {
      const ha = a.fine!.h[v * M + 1024], hb = b.fine!.h[v * M], ma = a.fine!.mask[Math.min(RM - 1, 4 * v) * RM + RM - 1], mb = b.fine!.mask[Math.min(RM - 1, 4 * v) * RM];
      if (ma !== 0 || mb !== 0) continue;
      compared++;
      worst = Math.max(worst, Math.abs(ha - hb));
      if (ha === hb) same++;
    }
    console.log(`scatter: the fine field's heights along the seam, ${compared} vertices off the streams: ${same} equal, the greatest difference ${worst.toExponential(2)} m`);
    expect(compared).toBeGreaterThan(500);
    expect(same).toBe(compared);
  }, 280_000);

  real("the objects' kinds follow the covers", async () => {
    const c = await ctx(), results: string[] = [];
    for (const k of [458, 0, 14]) {
      const t = await scatterTile(c, k, SEED), { face, tx, ty } = tileAt(4, k), cover = (file: string) => {
        const m = mappedField(c, file), out = new Float32Array(256 * 256);
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) out[y * 256 + x] = m[(face * 4096 + ty * 256 + y) * 4096 + tx * 256 + x] / 255;
        return out;
      };
      const tree = cover("t4-tree.u8"), grass = cover("t4-grs.u8"), marsh = cover("t4-mar.u8"), cellOf = (e: number) => Math.min(255, Math.floor(t.flora.py[e] * 2)) * 256 + Math.min(255, Math.floor(t.flora.px[e] * 2));
      const per = (field: Float32Array, kind: (e: number) => boolean) => {
        const sums = [0, 0, 0, 0], cells = [0, 0, 0, 0], bin = (v: number) => (v < 0.05 ? 0 : v < 0.3 ? 1 : v < 0.7 ? 2 : 3);
        for (let i = 0; i < 65536; i++) cells[bin(field[i])]++;
        for (let e = 0; e < t.flora.n; e++) if (kind(e)) sums[bin(field[cellOf(e)])]++;
        return sums.map((s, b) => (cells[b] ? s / cells[b] : NaN));
      };
      const treesPer = per(tree, (e) => kindOf(t, e) === "tree"), tussock = per(grass, (e) => kindOf(t, e) === "grass"), reeds = per(marsh, (e) => kindOf(t, e) === "reeds");
      const fmt = (a: number[]) => a.map((v) => (Number.isNaN(v) ? "-" : v.toFixed(1))).join(" / ");
      results.push(`tile ${k}: trees a cell by tree cover (under 5%, 5 to 30, 30 to 70, over 70%): ${fmt(treesPer)}; tussocks by grass cover: ${fmt(tussock)}; reeds by marsh cover: ${fmt(reeds)}`);
      const rising = (a: number[]) => a.filter((v) => !Number.isNaN(v)).every((v, i, all) => i === 0 || v >= all[i - 1] * 0.9);
      expect(rising(tussock), `tile ${k} tussocks by grass ${fmt(tussock)}`).toBe(true);
      // stems fill their crowns' share of the ground, so a count a cell falls where the stand's trees are tall (a stand on poor ground has many small ones): what holds is that cells with no tree cover have
      // few trees and every other bin many
      for (const v of treesPer.slice(1)) if (!Number.isNaN(v)) expect(v, `tile ${k} trees by cover ${fmt(treesPer)}`).toBeGreaterThan(10 * Math.max(0.01, treesPer[0]));
      // names: a tree is a tree species, a bush a shrub, as the island's
      const names = counts(t);
      for (const key of Object.keys(names)) {
        const [kind, sp] = key.split(":");
        if (kind === "tree") expect(TREES as readonly string[], key).toContain(sp);
        if (kind === "bush") expect(SHRUBS as readonly string[], key).toContain(sp);
      }
      // trees stand on ground with soil, not in a cell of standing water
      const water = mappedField(c, "t4-water.u16"), wet = (e: number) => water[(face * 4096 + ty * 256 + Math.floor(cellOf(e) / 256)) * 4096 + tx * 256 + (cellOf(e) % 256)] > 0;
      let treesWet = 0, trees = 0;
      for (let e = 0; e < t.flora.n; e++) if (kindOf(t, e) === "tree") { trees++; if (wet(e)) treesWet++; }
      results.push(`  ${trees} trees, ${treesWet} in a cell with standing water`);
      expect(treesWet).toBeLessThan(0.01 * trees + 1);
    }
    console.log(`scatter:\n  ${results.join("\n  ")}`);
  }, 280_000);

  real("a window's objects are the whole tile's cut to the window, byte for byte, with the whole run's ids", async () => {
    const c = await ctx(), whole = await scatterTile(c, 458, SEED), f = whole.flora, windows = [{ x0: 37, y0: 101, w: 100, h: 64 }, { x0: 0, y0: 0, w: 256, h: 256 }, { x0: 200, y0: 10, w: 0, h: 50 }, { x0: 250, y0: 250, w: 40, h: 40 }];
    const inside = (w: { x0: number; y0: number; w: number; h: number }, tx4: number, ty4: number) => { const cx = Math.floor((tx4 * 2) / 10000), cy = Math.floor((ty4 * 2) / 10000); return cx >= w.x0 && cx < w.x0 + w.w && cy >= w.y0 && cy < w.y0 + w.h; };
    const rows: string[] = [];
    for (const w of windows) {
      const t0 = performance.now(), got = (await scatterTile(c, 458, SEED, undefined, undefined, undefined, w)).flora, s0 = (performance.now() - t0) / 1000;
      const keep: number[] = [];
      for (let e = 0; e < f.n; e++) if (inside(w, Math.round(f.px[e] * 1e4), Math.round(f.py[e] * 1e4))) keep.push(e);
      expect(got.n, `count in ${JSON.stringify(w)}`).toBe(keep.length);
      expect(Array.from(got.ids)).toEqual(keep);
      const same = (a: Float32Array | Uint8Array | Uint32Array, pick: (e: number) => number) => { const want = new (a.constructor as new (v: ArrayLike<number>) => typeof a)(keep.map(pick)); return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(want.buffer, want.byteOffset, want.byteLength)); };
      expect(same(got.px, (e) => f.px[e])).toBe(true);
      expect(same(got.py, (e) => f.py[e])).toBe(true);
      expect(same(got.size, (e) => f.size[e])).toBe(true);
      expect(same(got.kind, (e) => f.kind[e])).toBe(true);
      expect(same(got.species, (e) => f.species[e])).toBe(true);
      expect(same(got.seed, (e) => f.seed[e])).toBe(true);
      const oreKeep = f.ore.map((o, k) => [o, k] as const).filter(([o]) => inside(w, Math.round(o.px * 1e4), Math.round(o.py * 1e4)));
      expect(got.ore).toEqual(oreKeep.map(([o]) => o));
      expect(Array.from(got.oreIds)).toEqual(oreKeep.map(([, k]) => k));
      rows.push(`${JSON.stringify(w)}: ${got.n} of ${f.n} objects, ${got.ore.length} ore, ${s0.toFixed(2)} s`);
    }
    // without a window the bytes are the whole run's, as before
    expect(hashOf(await scatterTile(c, 458, SEED))).toBe(hashOf(whole));
    console.log(`scatter windows on tile 458:\n  ${rows.join("\n  ")}`);
  }, 280_000);

  real("the cost of a tile's scatter", async () => {
    const c = await ctx(), rows: string[] = [];
    await scatterTile(c, 458, SEED); // the pipelines compile on first use
    for (const k of [458, 0, 14, 1500]) {
      const t0 = performance.now(), t = await scatterTile(c, k, SEED), s = (performance.now() - t0) / 1000;
      rows.push(`tile ${k}: ${t.flora.n} objects (${forest(t)} trees) in ${s.toFixed(2)} s`);
    }
    console.log(`scatter cost:\n  ${rows.join("\n  ")}`);
  }, 280_000);
});
const coverOf = (c: Ctx, k: number, file: string) => {
  const { face, tx, ty } = tileAt(4, k), m = mappedField(c, file), out = new Float32Array(256 * 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) out[y * 256 + x] = m[(face * 4096 + ty * 256 + y) * 4096 + tx * 256 + x] / 255;
  return out;
};
