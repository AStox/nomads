// The water as one solve (water-global.ts) on the staged planet at tier 2 (water-staged.ts: 6.3 million cells, pits whose lakes cross a tile's edge and a face's edge): the chain runs to every
// stored file, every piece of it is the same cell by cell whatever patch it is made on (tile independence: patches at offsets that are not tiles, across tile and face edges, equal the
// files bytes for bytes), and the relaxation is the same bytes visited in the reverse order. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/water-global.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { BakeDir } from "./bakedir";
import { patchAt, type Patch } from "./patch";
import { TILE } from "./grid";
import type { Ctx } from "./stages";
import { STAGED_TIER, stagedClimate, stagedPlanet } from "./water-staged";
import { beginsStage, coef1Stage, coef2Stage, finalPass, globalWater, GHALO, route1Stage, route2Stage, solveOf } from "./water-global";
import { mapped, unmap, waterFiles } from "./water";

afterAll(releaseGpu);
const T = STAGED_TIER, SCRATCH = "/tmp/planet-75m/water-scratch", cfg = { climate: stagedClimate, tier: T };
let fixture: Promise<Ctx> | undefined;
const ready = () => (fixture ??= (async () => {
  const gpu = await theGpu(), ctx = await stagedPlanet(gpu, new BakeDir(`${SCRATCH}/stage-t${T}`)), p = await globalWater(ctx, cfg, 280);
  if (!p.done) throw new Error(`staged water chain stopped at ${p.at}`);
  return ctx;
})());

describe("the water as one solve", () => {
  test("the chain makes every stored file, with channels, lakes, flows and a table", async () => {
    const ctx = await ready(), n = 6 * 1024 * 1024 * 0 + (mapped(ctx, `t${T}-height.i32`) as Int32Array).length;
    let channels = 0, flowing = 0, water = 0, tabs = 0;
    const chn = mapped(ctx, `t${T}-chn.u8`) as Uint8Array, flow = mapped(ctx, `t${T}-flow.u32`) as Uint32Array, wat = mapped(ctx, `t${T}-water.u16`) as Uint16Array, tab = mapped(ctx, `t${T}-tab.u16`) as Uint16Array;
    for (let i = 0; i < n; i++) { channels += chn[i]; if (flow[i] > 0) flowing++; if (wat[i] > 0) water++; if (tab[i] > 0) tabs++; }
    for (const f of waterFiles(T)) expect(ctx.dir.bytes(f)).toBeGreaterThan(0);
    expect(channels).toBeGreaterThan(5000);
    expect(flowing).toBeGreaterThan(100000);
    expect(water).toBeGreaterThan(10000);
    expect(tabs).toBeGreaterThan(100000);
  });

  test("every piece of the chain is the same cell by cell on patches that are not the tiles", async () => {
    const ctx = await ready(), stages = [beginsStage(T, cfg), coef1Stage(T, cfg), route1Stage(T, cfg), coef2Stage(T, cfg), route2Stage(T, cfg), finalPass(T, cfg)];
    // a patch across the pits at tile edges, one across the face's edge between faces 0 and 1 (x = 1024), one on the other face, one on the pole's face, each at an offset of 100 or so cells from a tile, its interior inside its face (a tile is never across a face edge)
    const patches: Patch[] = [patchAt(T, 0, 700, 300, GHALO), patchAt(T, 0, 768, 450, GHALO), patchAt(T, 1, 37, 290, GHALO), patchAt(T, 4, 611, 700, GHALO)];
    let compared = 0;
    for (const stage of stages)
      for (const patch of patches) {
        const out = await stage.run(ctx, patch, {});
        for (const name of stage.outputs) {
          const file = mapped(ctx, name);
          let wrong = 0, first = -1;
          for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const k = (y + GHALO) * patch.side + x + GHALO; if (file[patch.ids[k]] !== out[name][k]) { wrong++; if (first < 0) first = k; } }
          expect(wrong, `${stage.name} ${name} on the patch at (${patch.x0}, ${patch.y0}) of face ${patch.face}: first at ${first}`).toBe(0);
          compared += TILE * TILE;
        }
      }
    console.log(`water-global: ${compared} words of ${stages.length} passes equal on ${patches.length} offset patches`);
    unmap();
  });

  test("the relaxation is the same bytes visited from the last cell to the first, and settled", async () => {
    const ctx = await ready(), out = `t${T}-g-head1-reverse.i32`, r = await solveOf(ctx, 1, 400000, () => {}, { reverse: true, out });
    expect(r.change).toBeLessThan(67);
    expect(Bun.hash(new Uint8Array(ctx.dir.raw(out)))).toBe(Bun.hash(new Uint8Array(ctx.dir.raw(`t${T}-g-head1.i32`))));
    ctx.dir.remove(out);
    console.log(`water-global: solve 1 at tier ${T} settled in ${r.sweeps} sweeps, ${r.seconds.toFixed(1)} s`);
  });
});
