// The ground tiles (groundtile.ts): a tile written from the stage files reads back as the stage files' words (every field, over the tile's cells and its halo of 8), the receivers survive the code,
// and the scatter of the unpacked tile is the scatter of the stage files. Runs on the real planet's tile 458 of the scratch bake (ground-staged.ts), skipped where the bake is not. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/groundtile.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { releaseGpu } from "../device";
import { GROUNDTILE_FIELDS, GROUNDTILE_HALO, groundTilePath } from "./bake";
import { BakeDir, tierFile } from "./bakedir";
import { KEY, REAL, TIER, scratchBake } from "./ground-staged";
import { mappedField } from "./ground";
import { buildGroundTiles, groundTileBytes, makeGroundTile, readGroundTile, tileSource } from "./groundtile";
import { tierGrid } from "./grid";
import { cellAcross, localOf, patchOf, tileAt, tileCount } from "./patch";
import { RIVER_HALO, scatterTile, stageSource, type TileScatter } from "./scatter";

afterAll(releaseGpu);
const real = REAL ? test : test.skip;
const hashOf = (t: TileScatter) => Bun.hash(Buffer.concat([t.flora.start, t.flora.kind, t.flora.species, t.flora.px, t.flora.py, t.flora.size, t.flora.seed].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).concat([Buffer.from(JSON.stringify(t.flora.ore))]))).toString(16);

describe("the ground tile of the real planet's tile 458", () => {
  real("a tile read back is the stage files' words", async () => {
    const ctx = await scratchBake([458], RIVER_HALO), { face, tx, ty } = tileAt(TIER, 458), path = groundTilePath(ctx.dir.dir, face, tx, ty);
    rmSync(path, { force: true });
    const p = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tier: TIER, tiles: [458] });
    expect(p.made).toBe(1);
    const gz = readFileSync(path), gt = readGroundTile(gz), patch = patchOf(TIER, face, tx, ty, GROUNDTILE_HALO);
    expect(gt.meta.side).toBe(272);
    expect(gt.meta.absent).toEqual([]);
    expect(gt.meta.lostReceivers).toBe(0);
    let compared = 0;
    for (const f of GROUNDTILE_FIELDS) {
      if (f.name === "dir") continue;
      const m = mappedField(ctx, tierFile(TIER, f.file)), plane = gt.planes[f.name];
      expect(plane.length, f.name).toBe(patch.ids.length);
      for (let i = 0; i < plane.length; i++) {
        if (f.name === "chn" && patch.missing[i]) continue;
        if (plane[i] !== m[patch.ids[i]]) throw new Error(`${f.name} differs at ${i}`);
      }
      compared++;
    }
    // the receivers: decoded, each is the patch's own index of the cell the stage's receiver names
    const local = localOf(patch), to = mappedField(ctx, tierFile(TIER, "to.u32")), recv = tileSource(gt).recv(GROUNDTILE_HALO), stage = stageSource(ctx, 458).recv(GROUNDTILE_HALO);
    let rivers = 0;
    for (let i = 0; i < recv.length; i++) { expect(recv[i] === -1 || recv[i] === stage[i]).toBe(true); if (recv[i] >= 0) rivers++; else expect(stage[i] === -1 || stage[i] === i || local(to[patch.ids[i]]) === i).toBe(true); }
    console.log(`groundtile: tile 458: ${compared} fields equal over ${patch.ids.length} cells, ${rivers} receivers coded, file ${gz.length} bytes gzipped (${(gz.length / patch.ids.length).toFixed(1)} a cell, ${(gz.length * tileCount(TIER) / 1e9).toFixed(2)} GB for ${tileCount(TIER)} tiles), fields: ${gt.meta.fields.length}`);
  }, 280_000);

  real("the scatter of the unpacked tile is the scatter of the stage files", async () => {
    const ctx = await scratchBake([458], RIVER_HALO), { face, tx, ty } = tileAt(TIER, 458), path = groundTilePath(ctx.dir.dir, face, tx, ty);
    if (!existsSync(path)) buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tier: TIER, tiles: [458] });
    const gt = readGroundTile(readFileSync(path)), a = await scatterTile(ctx, 458, 1), b = await scatterTile(ctx, 458, 1, 2, false, tileSource(gt));
    expect(b.flora.n).toBe(a.flora.n);
    expect(hashOf(b)).toBe(hashOf(a));
    expect(b.segments).toBe(a.segments);
    console.log(`groundtile: scatter of tile 458 from the file ${b.flora.n} objects, the same words as from the stage files`);
  }, 280_000);

  real("a call stops at its budget and the next resumes", async () => {
    const ctx = await scratchBake([458, 459], RIVER_HALO);
    for (const k of [458, 459]) { const { face, tx, ty } = tileAt(TIER, k); rmSync(groundTilePath(ctx.dir.dir, face, tx, ty), { force: true }); }
    const first = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tier: TIER, tiles: [458, 459], budgetS: 0 });
    expect(first.made).toBeLessThan(2);
    const second = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tier: TIER, tiles: [458, 459], budgetS: 100 });
    expect(second.done).toBe(true);
    expect(first.made + second.made).toBe(2);
  }, 280_000);
});

// CPU only: tier 5 on a sparse store (the fields hold the cell's own id, so a plane says which cell of the planet each halo cell is) and tier 4 on the real bake.
describe("the ground tile at any tier", () => {
  const SCRATCH = "/tmp/planet-75m/pyramidtiles-scratch";
  test("tier 5's halos across a face's edge and a cube's corner are patch.ts's cells", () => {
    const T5 = 5, g = tierGrid(T5), fn = g.fn, cells = 6 * fn * fn, tiles = [0, 15, 31, 992, 1023, 1024, 1500], root = join(SCRATCH, "gt5");
    rmSync(root, { recursive: true, force: true });
    const dir = new BakeDir(root);
    try {
      const open = (name: string, bytes: number) => { const fd = openSync(dir.path(tierFile(T5, name)), "w"); ftruncateSync(fd, cells * bytes); return fd; };
      const height = open("height.i32", 4), to = open("to.u32", 4), chn = open("chn.u8", 1), w4 = new Uint32Array(1), w1 = new Uint8Array([1]);
      for (const k of tiles) {
        const { face, tx, ty } = tileAt(T5, k), p = patchOf(T5, face, tx, ty, GROUNDTILE_HALO);
        for (let i = 0; i < p.ids.length; i++) {
          const id = p.ids[i], X = id % fn;
          w4[0] = id; writeSync(height, w4, 0, 4, id * 4);
          w4[0] = X < fn - 1 ? id + 1 : id; writeSync(to, w4, 0, 4, id * 4);
          writeSync(chn, w1, 0, 1, id);
        }
      }
      for (const fd of [height, to, chn]) closeSync(fd);
      for (const k of tiles) {
        const { face, tx, ty } = tileAt(T5, k), { meta, planes } = makeGroundTile(dir, k, { seed: 1, key: "k", tier: T5 }), S = meta.side, H = GROUNDTILE_HALO;
        expect([meta.tile, meta.face, meta.tx, meta.ty]).toEqual([k, face, tx, ty]);
        expect(k).toBe(face * 1024 + ty * 32 + tx);
        expect(S).toBe(272);
        let across = 0, corner = 0;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const X = tx * 256 - H + x, Y = ty * 256 - H + y, id = cellAcross(g, face, X, Y), got = planes.height[y * S + x];
          if (id >= 0) {
            expect(got).toBe(id);
            expect(planes.chn[y * S + x]).toBe(1);
            if (Math.floor(id / (fn * fn)) !== face) across++;
          } else {
            // a cube's corner: the nearest cell of the face, no channel
            expect(got).toBe((face * fn + Math.min(fn - 1, Math.max(0, Y))) * fn + Math.min(fn - 1, Math.max(0, X)));
            expect(planes.chn[y * S + x]).toBe(0);
            corner++;
          }
        }
        // the receiver code: east (1) wherever the east neighbour is in the patch, none at a face's east edge
        const east = planes.dir[(H + 5) * S + H + 5];
        expect(east).toBe(1);
        expect(readGroundTile(groundTileBytes(meta, planes)).planes.height[H * S + H]).toBe(planes.height[H * S + H]);
        const onEdge = tx === 0 || ty === 0 || tx === 31 || ty === 31;
        expect(across > 0).toBe(onEdge);
        expect(corner).toBe((tx === 0 || tx === 31) && (ty === 0 || ty === 31) ? 64 : 0);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  const real = existsSync("/tmp/planet-75m/1-883a8d9387df/t4-height.i32") ? test : test.skip;
  real("tier 4 on the real bake is the file the tier-4-only code wrote", () => {
    const dir = new BakeDir("/tmp/planet-75m/1-883a8d9387df");
    for (const k of [0, 458, 1535]) {
      const { face, tx, ty } = tileAt(4, k), path = groundTilePath(dir.dir, face, tx, ty);
      if (!existsSync(path)) continue;
      const { meta, planes } = makeGroundTile(dir, k, { seed: 1, key: "883a8d9387df", tier: 4 });
      expect(Buffer.from(groundTileBytes(meta, planes)).equals(readFileSync(path)), `tile ${k}`).toBe(true);
    }
  }, 120_000);
});
