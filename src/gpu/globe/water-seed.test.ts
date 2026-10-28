// The seeded patch (water-seed.ts, WaterFormat.seeded): the aquifer's start is the coarse global solve's heads carried to the cell, so a cell's seed must not depend on the patch it is read in, and a
// real tile's answer must be the same words in two patches that hold it differently. Each case alone:
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/water-seed.test.ts -t "<name>" --timeout 280000
// The real case needs the planet of key 883a8d9387df baked at tier 4 and its tier-3 global solve (`--stage coarse`) in the bake directory's water-scratch/t3 (t3-g-head1.i32, t3-g-head2.i32).
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { AIR_UNIT, precipOfWord } from "./air";
import { BAKE, BakeDir } from "./bakedir";
import { tierGrid } from "./grid";
import { patchAt } from "./patch";
import type { Ctx, Field } from "./stages";
import { WATER_SEEDED, climateFiles, lastRun, unmap, waterFiles, waterOf } from "./water";
import { seedOf } from "./water-seed";

afterAll(releaseGpu);

describe("the coarse heads carried to a patch", () => {
  const coarse = 3, tier = 4, g = tierGrid(coarse), field = Int32Array.from({ length: 6 * g.fn * g.fn }, (_, i) => Math.imul(i ^ (i >>> 7), 2654435761) >> 12);

  test("a constant is a constant everywhere, across a face's edge and at a cube's corner", () => {
    const flat = new Int32Array(field.length).fill(123456);
    for (const [face, x0, y0] of [[0, 0, 0], [1, 7680, 0], [2, 3840, 7680], [4, 7936, 7936]] as const) {
      const patch = patchAt(tier, face, Math.min(x0, 8192 / 2 - 256), Math.min(y0, 8192 / 2 - 256), 64);
      const s = seedOf(patch, tier, coarse, flat);
      for (let k = 0; k < s.length; k++) if (!patch.missing[k]) expect(s[k]).toBe(123456);
    }
  });

  test("two patches seed a shared cell with the same word (a patch's place is not in a seed)", () => {
    const a = patchAt(tier, 1, 0, 0, 96), b = patchAt(tier, 1, 64, 32, 96), sa = seedOf(a, tier, coarse, field), sb = seedOf(b, tier, coarse, field), at = new Map<number, number>();
    a.ids.forEach((id, k) => { if (!a.missing[k]) at.set(id, sa[k]); });
    let shared = 0;
    b.ids.forEach((id, k) => { const v = at.get(id); if (v !== undefined && !b.missing[k]) { shared++; expect(sb[k]).toBe(v); } });
    expect(shared).toBeGreaterThan(50000);
  });

  test("the children of an interior coarse cell average to it (bilinear, to the rounding)", () => {
    const patch = patchAt(tier, 2, 640, 640, 0, 64), n = patch.side, cx = 323, cy = 323;
    // a field linear in the face's index space is carried exactly by a bilinear stencil, so the 2 x 2 children of the coarse cell (323, 323) (the patch's (6 .. 7, 6 .. 7)) average to its value
    const linear = Int32Array.from({ length: 6 * g.fn * g.fn }, (_, i) => 1000 * (i % g.fn) + 2000 * (Math.floor(i / g.fn) % g.fn)), s = seedOf(patch, tier, coarse, linear);
    const x = 2 * cx - 640, y = 2 * cy - 640, mean = (s[y * n + x] + s[y * n + x + 1] + s[(y + 1) * n + x] + s[(y + 1) * n + x + 1]) / 4;
    expect(patch.ids[y * n + x]).toBe((2 * (2 * g.fn) + 2 * cy) * (2 * g.fn) + 2 * cx);
    expect(Math.abs(mean - linear[2 * g.fn * g.fn + cy * g.fn + cx])).toBeLessThan(2);
  });
});

// the real tier 4: the tier's own files linked into a scratch directory with the tier-3 solve's heads beside them
const REAL = join(BAKE, "1-883a8d9387df"), SCR = join(BAKE, "water-scratch", "t4real"), T3 = join(BAKE, "water-scratch", "t3");
const have = existsSync(`${REAL}/t4-q3-hi.u16`) && existsSync(`${REAL}/t4-cells.u32`) && existsSync(`${T3}/t3-g-head2.i32`);
const hash = (f: Field) => Bun.hash(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)).toString(16);

describe("a real tile", () => {
  const ready = async (): Promise<Ctx> => {
    mkdirSync(SCR, { recursive: true });
    for (const f of readdirSync(REAL)) if (/^t4-/.test(f) && !existsSync(`${SCR}/${f}`)) symlinkSync(`${REAL}/${f}`, `${SCR}/${f}`);
    for (const f of ["t3-g-head1.i32", "t3-g-head2.i32"]) if (!existsSync(`${SCR}/${f}`)) symlinkSync(`${T3}/${f}`, `${SCR}/${f}`);
    return { gpu: await theGpu(), planet: {} as never, dir: new BakeDir(SCR), tier: 4 };
  };
  const climate = climateFiles([0, 1, 2, 3].map((s) => `t4-pr${s}.u16`), [0, 1, 2, 3].map((s) => `t4-pe${s}.u16`), precipOfWord, (w) => w / AIR_UNIT.pe);
  const cfg = { climate, tier: 4, seed: { coarse: WATER_SEEDED.coarse, sweeps: WATER_SEEDED.sweeps } };

  test.skipIf(!have)("mountain tile 458: two runs are the same bytes, and a patch half a tile off gives every shared cell the same words, pinned", async () => {
    const ctx = await ready(), x0 = 10 * 256, y0 = 12 * 256, pa = patchAt(4, 1, x0, y0, WATER_SEEDED.halo), pb = patchAt(4, 1, x0 + 128, y0 + 128, WATER_SEEDED.halo);
    const a = await waterOf(ctx, pa, cfg), sweeps = lastRun.sweeps.join(" and "), a2 = await waterOf(ctx, pa, cfg), b = await waterOf(ctx, pb, cfg);
    for (const f of waterFiles(4)) expect(hash(a2[f])).toBe(hash(a[f]));
    expect(sweeps).toBe(`${WATER_SEEDED.sweeps} and ${WATER_SEEDED.sweeps}`);
    const at = new Map<number, number>();
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const k = (y + pa.halo) * pa.side + x + pa.halo; at.set(pa.ids[k], k); }
    let shared = 0;
    const differ: Record<string, number> = {};
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const kb = (y + pb.halo) * pb.side + x + pb.halo, ka = at.get(pb.ids[kb]);
      if (ka === undefined) continue;
      shared++;
      for (const f of waterFiles(4)) if ((a[f] as ArrayLike<number>)[ka] !== (b[f] as ArrayLike<number>)[kb]) differ[f] = (differ[f] ?? 0) + 1;
    }
    expect(shared).toBe(128 * 128);
    expect(differ).toEqual({});
    const all = Bun.hash(Buffer.concat(waterFiles(4).map((f) => Buffer.from(a[f].buffer, a[f].byteOffset, a[f].byteLength)))).toString(16);
    console.log(`water: seeded tile 458, K ${WATER_SEEDED.sweeps} halo ${WATER_SEEDED.halo}: ${(lastRun.seconds.gpu + lastRun.seconds.inputs).toFixed(2)} s, hash ${all}`);
    expect(all).toBe("4746718631c48ce6");
    unmap();
  });
});
