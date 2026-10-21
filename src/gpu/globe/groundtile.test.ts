// The ground tiles (groundtile.ts): a tile written from the stage files reads back as the stage files' words (every field, over the tile's cells and its halo of 8), the receivers survive the code,
// and the scatter of the unpacked tile is the scatter of the stage files. Runs on the real planet's tile 458 of the scratch bake (ground-staged.ts), skipped where the bake is not. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/groundtile.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { releaseGpu } from "../device";
import { GROUNDTILE_FIELDS, GROUNDTILE_HALO, groundTilePath } from "./bake";
import { KEY, REAL, TIER, scratchBake } from "./ground-staged";
import { mappedField } from "./ground";
import { buildGroundTiles, readGroundTile, tileSource } from "./groundtile";
import { localOf, patchOf, tileAt } from "./patch";
import { RIVER_HALO, scatterTile, stageSource, type TileScatter } from "./scatter";

afterAll(releaseGpu);
const real = REAL ? test : test.skip;
const hashOf = (t: TileScatter) => Bun.hash(Buffer.concat([t.flora.start, t.flora.kind, t.flora.species, t.flora.px, t.flora.py, t.flora.size, t.flora.seed].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).concat([Buffer.from(JSON.stringify(t.flora.ore))]))).toString(16);

describe("the ground tile of the real planet's tile 458", () => {
  real("a tile read back is the stage files' words", async () => {
    const ctx = await scratchBake([458], RIVER_HALO), { face, tx, ty } = tileAt(TIER, 458), path = groundTilePath(ctx.dir.dir, face, tx, ty);
    rmSync(path, { force: true });
    const p = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tiles: [458] });
    expect(p.made).toBe(1);
    const gz = readFileSync(path), gt = readGroundTile(gz), patch = patchOf(TIER, face, tx, ty, GROUNDTILE_HALO);
    expect(gt.meta.side).toBe(272);
    expect(gt.meta.absent).toEqual([]);
    expect(gt.meta.lostReceivers).toBe(0);
    let compared = 0;
    for (const f of GROUNDTILE_FIELDS) {
      if (f.name === "dir") continue;
      const m = mappedField(ctx, f.file), plane = gt.planes[f.name];
      expect(plane.length, f.name).toBe(patch.ids.length);
      for (let i = 0; i < plane.length; i++) {
        if (f.name === "chn" && patch.missing[i]) continue;
        if (plane[i] !== m[patch.ids[i]]) throw new Error(`${f.name} differs at ${i}`);
      }
      compared++;
    }
    // the receivers: decoded, each is the patch's own index of the cell the stage's receiver names
    const local = localOf(patch), to = mappedField(ctx, "t4-to.u32"), recv = tileSource(gt).recv(GROUNDTILE_HALO), stage = stageSource(ctx, 458).recv(GROUNDTILE_HALO);
    let rivers = 0;
    for (let i = 0; i < recv.length; i++) { expect(recv[i] === -1 || recv[i] === stage[i]).toBe(true); if (recv[i] >= 0) rivers++; else expect(stage[i] === -1 || stage[i] === i || local(to[patch.ids[i]]) === i).toBe(true); }
    console.log(`groundtile: tile 458: ${compared} fields equal over ${patch.ids.length} cells, ${rivers} receivers coded, file ${gz.length} bytes gzipped (${(gz.length / patch.ids.length).toFixed(1)} a cell, ${(gz.length * 1536 / 1e9).toFixed(2)} GB for 1,536 tiles), fields: ${gt.meta.fields.length}`);
  }, 280_000);

  real("the scatter of the unpacked tile is the scatter of the stage files", async () => {
    const ctx = await scratchBake([458], RIVER_HALO), { face, tx, ty } = tileAt(TIER, 458), path = groundTilePath(ctx.dir.dir, face, tx, ty);
    if (!existsSync(path)) buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tiles: [458] });
    const gt = readGroundTile(readFileSync(path)), a = await scatterTile(ctx, 458, 1), b = await scatterTile(ctx, 458, 1, 2, false, tileSource(gt));
    expect(b.flora.n).toBe(a.flora.n);
    expect(hashOf(b)).toBe(hashOf(a));
    expect(b.segments).toBe(a.segments);
    console.log(`groundtile: scatter of tile 458 from the file ${b.flora.n} objects, the same words as from the stage files`);
  }, 280_000);

  real("a call stops at its budget and the next resumes", async () => {
    const ctx = await scratchBake([458, 459], RIVER_HALO);
    for (const k of [458, 459]) { const { face, tx, ty } = tileAt(TIER, k); rmSync(groundTilePath(ctx.dir.dir, face, tx, ty), { force: true }); }
    const first = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tiles: [458, 459], budgetS: 0 });
    expect(first.made).toBeLessThan(2);
    const second = buildGroundTiles(ctx.dir, { seed: 1, key: KEY, tiles: [458, 459], budgetS: 100 });
    expect(second.done).toBe(true);
    expect(first.made + second.made).toBe(2);
  }, 280_000);
});
