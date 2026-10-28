// The tile stages at the planet's finest tier, 5 (391.1 km, 8,192 cells a face, 32 by 32 tiles a face, 6,144 tiles): on a synthetic store whose files are sparse and hold only the cells a case reads,
// at a cube's corners and along a face's edge, since the real tier is not baked. What must hold: a cell's stored words are the same from two patches that overlap (the tier's block of tier 0
// is 32 cells, not 16, and the halo larger), the stage's files land at the tier's own offsets, and the tier-4 bake's pins (air.test.ts, ground.test.ts) are unchanged by the generalisation.
// Each case alone: bun test ./src/gpu/globe/tier5.test.ts -t "<name>" --timeout 290000
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { GRANITE } from "../../terrain/geology";
import { airHalo, airOf, airOut, airOutputs, airStage, compact } from "./air";
import { BAKE, BakeDir, tierFile } from "./bakedir";
import { PLANET_RADIUS_M, PLANET_TIER } from "./grid";
import { patchAt, patchOf, tileAt, tileCount, type Patch } from "./patch";
import { doneFileOf, runTiles, type Ctx, type TileStage } from "./stages";
import { TERRAIN_HALO, terrainOf } from "./terrain";
import type { Planet } from "./window";

afterAll(releaseGpu);
const TIER = 5, FN = 256 << TIER, N0 = 6 * 256 * 256, HALO = airHalo(TIER), SCRATCH = join(BAKE, "tier5-scratch");
const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const hashOf = (arrays: ArrayBufferView[]) => Bun.hash(Buffer.concat(arrays.map(bytes))).toString(16);

// A planet of the stage's own needs at tier 0 (256 cells a face whatever the finest tier): land with a stripe of sea, smooth air, rain and wind, the rock a single granite pool.
const planetOf = (): Planet => {
  const field = (f: (i: number) => number) => Float32Array.from({ length: N0 }, (_, i) => f(i));
  return {
    n: N0, radius: PLANET_RADIUS_M, height: field((i) => (Math.floor(i / 65536) === 2 && (i % 256) >= 69 && (i % 256) <= 70 ? -50 : 400 + 300 * Math.sin(i * 0.0007))),
    pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === GRANITE ? 2000 : 0)),
    ice: { maxM: new Float32Array(N0).fill(100), laidM: new Float32Array(N0).fill(12), nowM: new Float32Array(N0), cutM: new Float32Array(0) },
    seasons: [5, 15, 12, 2].map((t, k) => ({
      t: field((i) => t + 3 * Math.sin(i * 0.0013 + k)), rain: field((i) => 400 * (1 + 0.5 * Math.sin(i * 0.0021 + k))), snow: new Float32Array(N0), runoff: new Float32Array(N0),
      windE: field((i) => 5 + 1.5 * Math.sin(i * 0.0017)), windN: field((i) => 3 + 1.5 * Math.cos(i * 0.0011)), sst: field((i) => t + 1 + Math.sin(i * 0.0007)),
    })),
  } as unknown as Planet;
};
const positions = (ids: Int32Array) => Array.from(ids, (id) => { const f = Math.floor(id / (FN * FN)), r = id - f * FN * FN, Y = Math.floor(r / FN); return { f, X: r - Y * FN, Y }; });
// Heights (1/256 m) as a function of the cell alone: hills of 150 m over a swell of 100 m
const hills = (ids: Int32Array) => Int32Array.from(positions(ids), ({ f, X, Y }) => Math.round((200 + 100 * Math.sin(X * 0.021 + f) * Math.cos(Y * 0.017) + 50 * Math.sin(X * 0.09 + Y * 0.07)) * 256));
// The words at a patch's cells written into a sparse file of the tier, by the runs of cells that are neighbours in it
function putCells(file: string, ids: Int32Array, words: Int32Array) {
  const fd = openSync(file, "a+");
  try {
    for (let i = 0, j = 1; i < ids.length; i = j, j = i + 1) {
      while (j < ids.length && ids[j] === ids[j - 1] + 1) j++;
      const run = words.subarray(i, j);
      writeSync(fd, bytes(run), 0, run.byteLength, ids[i] * 4);
    }
  } finally { closeSync(fd); }
}

describe("the tile stages at tier 5 on a synthetic store", () => {
  test("a patch at tier 5 is the planet's lattice: 6,144 tiles of 32 by 32 a face, tile numbers and cells agree, a patch at a cube's corner repeats only its missing cell", () => {
    expect(PLANET_TIER).toBe(TIER);
    expect(tileCount(TIER)).toBe(6144);
    expect(tileAt(TIER, 1024)).toEqual({ face: 1, tx: 0, ty: 0 });
    expect(tileAt(TIER, 1023)).toEqual({ face: 0, tx: 31, ty: 31 });
    const p = patchOf(TIER, 0, 0, 0, 16);
    expect(p.ids[(16 + 3) * p.side + 16 + 5]).toBe(3 * FN + 5);
    expect(p.missing.reduce((a, b) => a + b, 0)).toBe(16 * 16);
    expect(HALO).toBe(400);
  });

  test("the terrain stage: a cell's drift is the same from two patches that overlap at a cube's corner", async () => {
    const gpu = await theGpu(), ctx: Ctx = { gpu, planet: planetOf(), dir: null as never, tier: TIER };
    const a = patchAt(TIER, 0, 0, 0, TERRAIN_HALO), b = patchAt(TIER, 0, 128, 0, TERRAIN_HALO);
    const ra = await terrainOf(ctx, a, hills(a.ids)), rb = await terrainOf(ctx, b, hills(b.ids));
    const inB = new Map<number, number>();
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) inB.set(b.ids[(y + TERRAIN_HALO) * b.side + x + TERRAIN_HALO], (y + TERRAIN_HALO) * b.side + x + TERRAIN_HALO);
    let shared = 0;
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const ka = (y + TERRAIN_HALO) * a.side + x + TERRAIN_HALO, kb = inB.get(a.ids[ka]);
        if (kb === undefined) continue;
        shared++;
        expect(rb.drift[kb]).toBe(ra.drift[ka]);
        expect(rb.dd[kb]).toBe(ra.dd[ka]);
        expect(rb.rock[kb]).toBe(ra.rock[ka]);
      }
    expect(shared).toBe(128 * 256);
  }, 120_000);

  // The cells two patches of one face both hold in their interiors, and how many of each stored file's words in them differ
  const compare = (pa: Patch, a: Parameters<typeof compact>[0], pb: Patch, b: Parameters<typeof compact>[0]) => {
    const wa = compact(a, TIER), wb = compact(b, TIER), names = airOutputs(TIER), differing: Record<string, number> = Object.fromEntries(names.map((n) => [n, 0]));
    const x0 = Math.max(pa.x0, pb.x0), xEnd = Math.min(pa.x0, pb.x0) + 256, y0 = Math.max(pa.y0, pb.y0), yEnd = Math.min(pa.y0, pb.y0) + 256;
    let cells = 0;
    for (let Y = y0; Y < yEnd; Y++)
      for (let X = x0; X < xEnd; X++) {
        cells++;
        const ia = (Y - pa.y0 + pa.halo) * pa.side + X - pa.x0 + pa.halo, ib = (Y - pb.y0 + pb.halo) * pb.side + X - pb.x0 + pb.halo;
        for (const n of names) if ((wa[n] as ArrayLike<number>)[ia] !== (wb[n] as ArrayLike<number>)[ib]) differing[n]++;
      }
    return { cells, bad: Object.entries(differing).filter(([, v]) => v > 0) };
  };

  test("the air stage: every stored file is the same bytes in the cells two patches share, at a cube's corner, at the opposite corner and along an edge, with the tier's halo of 400", async () => {
    const gpu = await theGpu(), ctx: Ctx = { gpu, planet: planetOf(), dir: null as never, tier: TIER };
    const run = async (p: Patch) => { const h = hills(p.ids); return airOf(ctx, p, h, h); };
    const cases: [string, number, number, [number, number, number][]][] = [
      ["tile 0, a cube's corner", 0, 0, [[16, 0, HALO], [100, 100, HALO + 16]]],
      ["tile 1023, the opposite corner of face 0", 7936, 7936, [[-100, -100, HALO]]],
      ["tile 31 of face 0 (east edge, south corner), halo 416", 7936, 0, [[-100, 100, HALO + 16]]],
    ];
    for (const [label, x0, y0, others] of cases) {
      const base = patchAt(TIER, 0, x0, y0, HALO), a = await run(base);
      for (const [dx, dy, halo] of others) {
        const p = patchAt(TIER, 0, x0 + dx, y0 + dy, halo), c = compare(base, a, p, await run(p));
        console.log(`${label}, against a patch shifted (${dx}, ${dy}) with halo ${halo}: ${c.cells} shared cells, ${c.bad.length ? c.bad.map(([n, v]) => `${n} ${v}`).join(", ") : "every stored word equal"}`);
        expect(c.bad).toEqual([]);
      }
    }
  }, 290_000);

  test("runTiles at tier 5 writes tiles 0, 1,023 and 1,024 (face 1) of the stage's files at the tier's offsets: tile 1,024 is what airOf gives its patch", async () => {
    const gpu = await theGpu(), dir = new BakeDir(SCRATCH), ctx: Ctx = { gpu, planet: planetOf(), dir, tier: TIER }, stage = airStage(TIER), tiles = [0, 1023, 1024];
    try {
      for (const k of tiles) {
        const { face, tx, ty } = tileAt(TIER, k), p = patchOf(TIER, face, tx, ty, HALO), h = hills(p.ids);
        for (const f of stage.inputs) putCells(dir.path(f), p.ids, h);
      }
      const made = await runTiles(ctx, stage, 1e9, () => {}, tiles);
      expect(made.tiles).toBe(3);
      const { face, tx, ty } = tileAt(TIER, 1024), p = patchOf(TIER, face, tx, ty, HALO), h = hills(p.ids), want = compact(await airOf(ctx, p, h, h), TIER);
      const name = airOut(TIER).pr[1], fd = openSync(dir.path(name), "r"), row = new Uint16Array(256), W = want[name] as Uint16Array;
      try {
        for (const y of [0, 100, 255]) {
          readSync(fd, bytes(row), 0, 512, ((face * FN + ty * 256 + y) * FN + tx * 256) * 2);
          expect(hashOf([row])).toBe(hashOf([W.subarray((y + HALO) * p.side + HALO, (y + HALO) * p.side + HALO + 256)]));
        }
        // a tile that was not asked for has nothing in it
        readSync(fd, bytes(row), 0, 512, ((0 * FN + 5 * 256) * FN + 7 * 256) * 2);
        expect(row.every((v) => v === 0)).toBe(true);
      } finally { closeSync(fd); }
      expect(tierFile(TIER, "pr1.u16")).toBe(name);
    } finally { rmSync(SCRATCH, { recursive: true, force: true }); }
  }, 290_000);

  test("the air stage over a block of 2 by 2 tiles at one patch writes the bytes four single tiles do (the halo shared, nothing else changed), a block that has a tile asked for makes all four", async () => {
    const gpu = await theGpu(), ctx: Ctx = { gpu, planet: planetOf(), dir: null as never, tier: TIER }, tiles = [1024, 1025, 1056, 1057], one = `${SCRATCH}-one`, blk = `${SCRATCH}-block`;
    try {
      const dirs = [new BakeDir(one), new BakeDir(blk)], single = airStage(TIER), block = airStage(TIER, 2);
      for (const k of tiles) {
        const { face, tx, ty } = tileAt(TIER, k), p = patchOf(TIER, face, tx, ty, HALO), h = hills(p.ids);
        for (const d of dirs) for (const f of single.inputs) putCells(d.path(f), p.ids, h);
      }
      const t1 = performance.now(), a = await runTiles({ ...ctx, dir: dirs[0] }, single, 1e9, () => {}, tiles), t2 = performance.now(), b = await runTiles({ ...ctx, dir: dirs[1] }, block, 1e9, () => {}, [1025]), t3 = performance.now();
      expect(a.tiles).toBe(4);
      expect(b.tiles).toBe(4);
      console.log(`tier 5: four tiles one at a time ${((t2 - t1) / 1000).toFixed(1)} s (patches of ${256 + 2 * HALO}), as one block ${((t3 - t2) / 1000).toFixed(1)} s (a patch of ${512 + 2 * HALO})`);
      for (const name of single.outputs) {
        const w = name.endsWith(".u8") ? 1 : 2, K = w === 1 ? Uint8Array : Uint16Array, ra = new K(256), rb = new K(256), fa = openSync(dirs[0].path(name), "r"), fb = openSync(dirs[1].path(name), "r");
        try {
          for (const k of tiles) {
            const { face, tx, ty } = tileAt(TIER, k);
            for (const y of [0, 77, 255]) {
              const at = ((face * FN + ty * 256 + y) * FN + tx * 256) * w;
              readSync(fa, bytes(ra), 0, 256 * w, at); readSync(fb, bytes(rb), 0, 256 * w, at);
              expect(hashOf([rb])).toBe(hashOf([ra]));
            }
          }
        } finally { closeSync(fa); closeSync(fb); }
      }
    } finally { rmSync(`${SCRATCH}-one`, { recursive: true, force: true }); rmSync(`${SCRATCH}-block`, { recursive: true, force: true }); }
  }, 290_000);

  test("a stage's done marker belongs to its tier: a marker of another tier's tile count in the directory is not read, one of this tier's (an old bake's, with no tier in its name) is", async () => {
    const dir = new BakeDir(`${SCRATCH}-marks`), ctx: Ctx = { gpu: null as never, planet: {} as Planet, dir, tier: 2 };
    const made: number[] = [];
    const stage: TileStage = { name: "fake", halo: 0, inputs: [], outputs: ["t2-fake.u8"], async run(_c, p) { made.push(p.tx + 4 * p.ty); return { "t2-fake.u8": new Uint8Array(p.side * p.side) }; } };
    try {
      dir.write("fake-done.u8", new Uint8Array(384).fill(1)); // tier 3's count: not this tier's
      const a = await runTiles(ctx, stage, 1e9, () => {}, [0, 5, 9]);
      expect(made).toEqual([0, 5, 9]);
      expect(a.tiles).toBe(3);
      expect(dir.has(doneFileOf(2, "fake"))).toBe(true);
      rmSync(dir.path(doneFileOf(2, "fake")));
      dir.write("fake-done.u8", Uint8Array.from({ length: 96 }, (_, k) => (k === 5 ? 1 : 0))); // tier 2's count: tile 5 was made
      made.length = 0;
      await runTiles(ctx, stage, 1e9, () => {}, [0, 5, 9]);
      expect(made).toEqual([0, 9]);
    } finally { rmSync(`${SCRATCH}-marks`, { recursive: true, force: true }); }
  });
});
