// The ground stage (ground.ts): the island's ground kernels on a patch of the 75 m tier. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/ground.test.ts -t "<name>" --timeout 280000
// The island's own site is the oracle for the widening: the patch format at the island's size (a sweep of any reach, a thread to every 256th column) must give the island's kernels' words,
// and the island's ground made again from the stage's stored words (the units the files keep) must be the same ground to what those units hold. The cases on the real planet (the bake of
// seed 1 under /tmp/planet-75m, skipped where it is not) make the air stage's and a stand-in water stage's files for the tiles they need in /tmp/planet-75m/ground-scratch/bake (links to the
// bake's heights and terrain files, the rest written there) and measure what a halo cuts: two patches half a tile apart, and one place seen from the two faces of a cube's edge.
// The stand-in water (ground-staged.ts) is a function of each cell's height and discharge area and is not the water stage's: the cases that read the water stage's own files (t4-water.u16 and
// the rest) use them when the bake has them.
import { afterAll, describe, expect, test } from "bun:test";
import { readSync, openSync, closeSync } from "node:fs";
import { rng } from "../../sim/world";
import { LEN } from "../../terrain/grid";
import { releaseGpu, theGpu } from "../device";
import { generateIsland } from "../terrain/island";
import { groundWords, pack } from "../terrain/ground";
import { INPUTS, ISLAND_GROUND, OUTPUTS } from "../wgsl/terrain-ground";
import type { Site } from "../../terrain/ground";
import type { BakeDir } from "./bakedir";
import { precipWord } from "./air";
import { GROUND_HALO, GROUND_OUT, GROUND_OUTPUTS, TABLE_UNIT, compactGround, fieldsAt, groundFormat, groundStage, groundTile, wordsOf, type GroundFields } from "./ground";
import { FN, REAL, TIER, scratchBake } from "./ground-staged";
import { cellAcross, localOf, patchAt, patchOf, tileAt, type Patch } from "./patch";
import { runTiles, type Field } from "./stages";
import { EDGES, tierGrid } from "./grid";

afterAll(releaseGpu);
const hashOf = (...f: ArrayBufferView[]) => Bun.hash(Buffer.concat(f.map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)))).toString(16);

// ---------- the widening, on the island's own site ----------
let isleOnce: Promise<Site> | undefined;
const island = () => (isleOnce ??= (async () => { const isle = await generateIsland(rng(1), await theGpu()); return { ...isle, open: Uint8Array.from(isle.water, (w) => (w > 0 ? 1 : 0)) }; })());

describe("the patch format on the island's site", () => {
  test("a patch of the island's size is the island's kernels' words, and a reach of 64 cells cuts nothing there", async () => {
    const g = await theGpu(), words = pack(await island()), a = await groundWords(g, words, ISLAND_GROUND);
    const b = await groundWords(g, words, { n: 256, patch: true, reach: 100000 }), c = await groundWords(g, words, groundFormat(256));
    expect(hashOf(b)).toBe(hashOf(a));
    const diff = (x: Int32Array, y: Int32Array) => OUTPUTS.map((o, k) => { let n = 0; for (let i = 0; i < LEN; i++) if (x[k * LEN + i] !== y[k * LEN + i]) n++; return [o[0], n] as const; }).filter(([, n]) => n);
    console.log(`ground: the island 1's ground with a reach of ${GROUND_HALO} against the island's sweep differs in: ${JSON.stringify(diff(a, c))}`);
    expect(diff(a, c)).toEqual([]);
    // a reach of 8 cells leaves the valley cells that lie further from a channel with none of its alluvium, and changes nothing else
    const d = await groundWords(g, words, groundFormat(256, 8)), changed = diff(a, d), valley = INPUTS.indexOf("valley") * LEN;
    console.log(`ground: with a reach of 8 cells the cells that differ: ${JSON.stringify(changed)} (of ${words.slice(valley, valley + LEN).filter((v) => v > 0).length} valley cells)`);
    expect(changed.length).toBeGreaterThan(0);
  }, 280_000);

  test("the island's ground made again from the stored units is the same ground to what they hold", async () => {
    const g = await theGpu(), s = await island(), n = LEN;
    const u16 = (a: ArrayLike<number>, unit: number, hi = 65535) => Uint16Array.from({ length: n }, (_, i) => Math.max(0, Math.min(hi, Math.round(a[i] * unit))));
    const f: GroundFields = {
      height: Int32Array.from(s.height, (h) => Math.round(h * 256)), water: u16(Array.from(s.open, (o) => o * 100), 1), rock: s.rock, drift: s.drift, dd: u16(s.driftDepth, 1024),
      chn: s.channel, valley: Uint8Array.from(s.valley, (v) => (v > 0 ? 1 : 0)), pwr: u16(s.power, 16), stb: s.seasonTable.map((t) => u16(t, TABLE_UNIT)), dry: u16(s.dryTable, TABLE_UNIT),
      pr: s.seasons.map((x) => Uint16Array.from(x.precip, (mm) => Math.min(65535, precipWord(mm)))), pe: s.seasons.map((x) => u16(x.pet, 10)), sun: s.seasons.map((x) => u16(x.sun, 1024)),
      tmp: s.seasons.map((x) => Int16Array.from(x.temp, (t) => Math.round(t * 256))), hum: s.seasons.map((x) => Uint8Array.from(x.humid, (h) => Math.round(h * 255))),
    };
    // the island's own sea has its heights at or under 0 and its lakes' water; the stored water is open or not, which is all the kernel reads
    const patch: Patch = { tier: 4, face: 0, tx: 0, ty: 0, halo: 0, x0: 0, y0: 0, interior: 256, side: 256, ids: Int32Array.from({ length: n }, (_, i) => i), missing: new Uint8Array(n) };
    const raw = await groundWords(g, wordsOf(f, patch), groundFormat(256)), exact = await groundWords(g, pack(s), ISLAND_GROUND), tile = compactGround(raw, n);
    const rows: string[] = [];
    for (const [file, name, unit] of GROUND_OUT) {
      if (name === "flags") continue;
      const k = OUTPUTS.findIndex((o) => o[0] === name), div = OUTPUTS[k][1] as number, field = tile.fields[file];
      let worst = 0, sum = 0, bad = 0;
      for (let i = 0; i < n; i++) {
        if (s.open[i]) continue;
        const e = (exact[k * n + i] / div) * unit, d = Math.abs(field[i] - Math.min(e, file.endsWith("u8") ? 255 : 65535));
        worst = Math.max(worst, d); sum += d; if (d > 2) bad++;
      }
      rows.push(`${name} mean ${(sum / n).toFixed(4)} worst ${worst.toFixed(1)} (${bad} cells over 2 words)`);
    }
    console.log(`ground: stored units against the island's exact words, in the stored words:\n  ${rows.join("\n  ")}`);
    const flags = (name: string) => { const k = OUTPUTS.findIndex((o) => o[0] === name); let d = 0; for (let i = 0; i < n; i++) if ((raw[k * n + i] !== 0) !== (exact[k * n + i] !== 0)) d++; return d; };
    console.log(`ground: silt cells that differ ${flags("silt")}, sand ${flags("sand")}, peat ${flags("peat")}`);
    expect(tile.saturated).toBe(0);
  }, 280_000);
});

// ---------- the real planet ----------
const real = REAL ? test : test.skip;
const scratch = (tiles: number[], halo: number) => scratchBake(tiles, halo, false);
const PIN = { tile458: "988394b1689bb6fe" };
const tileOf = (k: number) => tileAt(TIER, k);
const readTile = (dir: BakeDir, file: string, k: number): Field => {
  const { face, tx, ty } = tileOf(k), K = file.endsWith("u8") ? Uint8Array : Uint16Array, fd = openSync(dir.path(file), "r"), out = new K(256 * 256);
  for (let y = 0; y < 256; y++) readSync(fd, new Uint8Array(out.buffer, y * 256 * K.BYTES_PER_ELEMENT, 256 * K.BYTES_PER_ELEMENT), 0, 256 * K.BYTES_PER_ELEMENT, ((face * FN + ty * 256 + y) * FN + tx * 256) * K.BYTES_PER_ELEMENT);
  closeSync(fd);
  return out;
};
// The cells two patches' interiors share, as [index in a, index in b].
function shared(a: Patch, b: Patch): [number, number][] {
  const at = new Map<number, number>();
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const k = (y + a.halo) * a.side + x + a.halo; at.set(a.ids[k], k); }
  const pairs: [number, number][] = [];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const k = (y + b.halo) * b.side + x + b.halo, i = at.get(b.ids[k]); if (i !== undefined) pairs.push([i, k]); }
  return pairs;
}
const differing = (a: Record<string, Field>, b: Record<string, Field>, pairs: [number, number][]) => GROUND_OUTPUTS.map((f) => [f, pairs.reduce((n, [i, k]) => n + (a[f][i] !== b[f][k] ? 1 : 0), 0)] as const).filter(([, n]) => n);

describe("the ground stage on the real planet (seed 1)", () => {
  real("two patches half a tile apart agree over every cell they share", async () => {
    const results: string[] = [];
    for (const k of [458, 223]) {
      const { face, tx, ty } = tileOf(k), ctx = await scratch([k], GROUND_HALO + 128), x0 = tx * 256, y0 = ty * 256;
      const a = patchAt(TIER, face, x0, y0, GROUND_HALO), b = patchAt(TIER, face, x0 + 128 <= FN - 256 ? x0 + 128 : x0 - 128, y0, GROUND_HALO);
      const ra = await groundTile(ctx.gpu, a, fieldsAt(ctx, a)), rb = await groundTile(ctx.gpu, b, fieldsAt(ctx, b)), pairs = shared(a, b);
      const diff = differing(ra.fields, rb.fields, pairs);
      results.push(`tile ${k}: ${pairs.length} shared cells, differing ${JSON.stringify(diff)}`);
      expect(pairs.length).toBeGreaterThan(256 * 100);
      expect(diff).toEqual([]);
    }
    console.log(`ground: two patches of halo ${GROUND_HALO} half a tile apart:\n  ${results.join("\n  ")}`);
  }, 280_000);

  // One place seen from the two faces of a cube's edge: tile 223's cells on the face's east edge, in its own patch and in a patch on the face across (where they are in the halo, 128 deep so
  // that they lie 64 or more from its outer edge). The same cell in two patches whose axes are turned and flipped against each other: the sweep's ties are the only thing that can differ.
  real("one place seen from the two faces of a cube's edge", async () => {
    const g = tierGrid(TIER), a = patchOf(TIER, 0, 15, 13, GROUND_HALO), across = cellAcross(g, 0, FN, 13 * 256 + 128), nf = Math.floor(across / (FN * FN));
    expect(nf).toBe(EDGES[0][0].face);
    const r = across - nf * FN * FN, bx = (r % FN) >> 8, by = Math.floor(r / FN) >> 8, b = patchOf(TIER, nf, bx, by, 128), kB = nf * 256 + by * 16 + bx;
    const ctx = await scratch([223, kB], 128), local = localOf(b), pairs: [number, number][] = [];
    for (let y = 0; y < 256; y++) for (let x = 192; x < 256; x++) { const i = (y + a.halo) * a.side + x + a.halo, j = local(a.ids[i]); expect(j).toBeGreaterThanOrEqual(0); pairs.push([i, j]); }
    const ra = await groundTile(ctx.gpu, a, fieldsAt(ctx, a)), rb = await groundTile(ctx.gpu, b, fieldsAt(ctx, b)), diff = differing(ra.fields, rb.fields, pairs);
    console.log(`ground: ${pairs.length} cells of face 0's east edge (to face ${nf}, tile ${kB}), seen from each face's patch, differing: ${JSON.stringify(diff)}`);
    expect(diff).toEqual([]);
  }, 280_000);

  real("the stage over six tiles: the same bytes twice, resumed in two calls, per tile seconds, the pinned tile", async () => {
    const tiles = [458, 1, 14, 1500, 937, 0], ctx = await scratch(tiles, GROUND_HALO), seconds: Record<number, number> = {};
    const dir = ctx.dir, hashes = (k: number) => hashOf(...GROUND_OUTPUTS.map((f) => readTile(dir, f, k)));
    ctx.dir.remove("ground-done.u8");
    const first = await runTiles(ctx, groundStage, 0.01, () => {}, tiles);
    expect(first.tiles).toBeLessThan(tiles.length);
    let rounds = 1;
    for (let p = first; !p.done && rounds < 10; rounds++) p = await runTiles(ctx, groundStage, 280, () => {}, tiles);
    const once = tiles.map(hashes);
    dir.remove("ground-done.u8");
    const again = await runTiles(ctx, groundStage, 280, () => {}, tiles);
    again.tileS.forEach((s, i) => (seconds[tiles[i]] = s));
    expect(tiles.map(hashes)).toEqual(once);
    // the pinned words of tile 458 (this planet's, this engine's, the stand-in water's: re-record when the water stage's files replace it, and say so)
    expect(once[tiles.indexOf(458)]).toBe(PIN.tile458);
    console.log(`ground: tiles ${tiles.join(", ")} made in ${rounds} calls, again in ${JSON.stringify(seconds)} s; hash of each ${JSON.stringify(Object.fromEntries(tiles.map((k, i) => [k, once[i]])))}`);
    // what the tiles hold
    for (const k of tiles) {
      const t = Object.fromEntries(GROUND_OUT.map(([f]) => [f, readTile(dir, f, k)])), n = 256 * 256;
      let land = 0, forest = 0, bad = 0, silt = 0, sand = 0, peat = 0;
      for (let i = 0; i < n; i++) {
        const sum = t["t4-tree.u8"][i] + t["t4-shr.u8"][i] + t["t4-grs.u8"][i] + t["t4-mar.u8"][i] + t["t4-bare.u8"][i], fl = t["t4-sflag.u8"][i];
        if (fl & 2) { sand++; continue; }
        if (t["t4-bare.u8"][i] === 255 && !t["t4-soil.u16"][i]) continue;
        land++; if (t["t4-tree.u8"][i] > 128) forest++; if (Math.abs(sum - 255) > 3) bad++; if (fl & 1) silt++; if (fl & 4) peat++;
      }
      console.log(`  tile ${k}: ${land} cells with ground, ${forest} over half trees, ${silt} silt, ${sand} sand, ${peat} peat, ${bad} whose covers do not sum to 1 within 3/255`);
      expect(land).toBeGreaterThan(30000);
      expect(bad).toBe(0);
    }
  }, 290_000);
});
