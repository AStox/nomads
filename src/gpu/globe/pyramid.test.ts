// The pyramid: a tile read back is the field's integers, the tier above is the 2 by 2 pooled tier below (mean of heights, the commonest rock, the greatest river), and every tile of
// every tier is made once; a bake stopped between units, or killed in one, and run again is the bake run once, byte for byte. Run: bun test ./src/gpu/globe/pyramid.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BakeDir } from "./bakedir";
import { buildPyramid, readTile, tilePath, type PyramidOptions } from "./pyramid";

const synth = (tier: number) => {
  const FN = 256 << tier, n = 6 * FN * FN, dir = new BakeDir(mkdtempSync(join(tmpdir(), "pyr-"))), f = (name: string) => `t${tier}-${name}`;
  const height = Int32Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0) % 4000000 - 1000000), rock = Uint8Array.from({ length: n }, (_, i) => ((i >> 1) ^ (i >> 9)) % 5), river = Uint8Array.from({ length: n }, (_, i) => (i % 97 === 0 ? 200 : i % 7));
  dir.write(f("height.i32"), height); dir.write(f("rock.u8"), rock); dir.write(f("river.u8"), river);
  const sources: PyramidOptions["sources"] = { height: { files: [f("height.i32")], convert: ([v]) => v / 64 }, rock: { files: [f("rock.u8")], convert: ([v]) => v }, river: { files: [f("river.u8"), f("height.i32")], convert: ([v]) => v } };
  return { dir, FN, height, rock, sources, opts: { seed: 1, key: "k", topTier: tier, sources } };
};
// every tile file of the pyramid (`.part` files are not tiles), folded into one hash with its path
const hashOf = (root: string) => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".tile.gz") ? [join(d, e.name)] : []));
  const files = walk(join(root, "pyramid")).sort();
  let h = 0n;
  for (const f of files) h = BigInt.asUintN(64, h * 1000003n + BigInt(Bun.hash(readFileSync(f))) + BigInt(Bun.hash(f.slice(root.length))));
  return { files: files.length, hash: h.toString(16) };
};

describe("the pyramid", () => {
  test("a top tile holds the field's integers and each coarser tile its children pooled", () => {
    const { dir, FN, height, rock, opts } = synth(1);
    const p = buildPyramid(dir, opts);
    expect(p.done).toBe(true);
    expect(p.counts).toEqual([6, 24]);
    const top = readTile(readFileSync(tilePath(dir.dir, 1, 3, 1, 0))), at = (x: number, y: number) => (3 * FN + y) * FN + x;
    expect(top.meta.tier).toBe(1);
    for (const [x, y] of [[0, 0], [255, 7], [100, 200]]) {
      expect(top.planes.height[y * 256 + x]).toBe(Math.max(-32768, Math.min(32767, Math.round(height[at(256 + x, y)] / 64))));
      expect(top.planes.rock[y * 256 + x]).toBe(rock[at(256 + x, y)]);
    }
    const root = readTile(readFileSync(tilePath(dir.dir, 0, 3, 0, 0)));
    for (const [x, y] of [[0, 0], [127, 5], [128, 130], [255, 255], [60, 250]]) {
      const kid = readTile(readFileSync(tilePath(dir.dir, 1, 3, x >> 7, y >> 7))).planes, a = ((y & 127) * 2) * 256 + (x & 127) * 2, w = [kid.height[a], kid.height[a + 1], kid.height[a + 256], kid.height[a + 257]];
      expect(root.planes.height[y * 256 + x]).toBe(Math.round((w[0] + w[1] + w[2] + w[3]) / 4));
      expect(root.planes.river[y * 256 + x]).toBe(Math.max(kid.river[a], kid.river[a + 1], kid.river[a + 256], kid.river[a + 257]));
      const r = [kid.rock[a], kid.rock[a + 1], kid.rock[a + 256], kid.rock[a + 257]], count = (v: number) => r.filter((q) => q === v).length;
      expect(count(root.planes.rock[y * 256 + x])).toBe(Math.max(...r.map(count)));
    }
    expect(dir.json<{ missing: string[] }>("pyramid")!.missing).toContain("tree");
  });

  // the 126 tiles of tier 2's pyramid of this synthetic planet, as the code made them before the tier became an argument and the bake resumable
  const TIER2 = { files: 126, hash: "7a47ba4f4462aad" };
  test("tier 2's tiles are the bytes the whole-face bake wrote", () => {
    const { dir, opts } = synth(2);
    try {
      expect(buildPyramid(dir, opts).done).toBe(true);
      expect(hashOf(dir.dir)).toEqual(TIER2);
    } finally { rmSync(dir.dir, { recursive: true, force: true }); }
  });

  test("a bake stopped after each unit, and one killed inside a unit, is the bake run once", () => {
    const { dir, opts } = synth(2);
    try {
      const o = { ...opts, unitTier: 1, budgetS: 0 };
      let calls = 0, p = buildPyramid(dir, o);
      expect(p.unitsMade).toBe(1);
      expect(p.done).toBe(false);
      expect(existsSync(dir.path("pyramid.json"))).toBe(false);
      // a kill inside a unit: its root is not there and a half-written file is, and so are the unit's tiles already made
      for (let k = 0; k < 2; k++) buildPyramid(dir, o);
      const lost = tilePath(dir.dir, 1, 0, 1, 0);
      rmSync(lost);
      writeFileSync(`${lost}.part`, "half");
      writeFileSync(`${tilePath(dir.dir, 2, 0, 3, 3)}.part`, "half");
      while (!p.done && calls++ < 100) p = buildPyramid(dir, o);
      expect(p.done).toBe(true);
      expect(p.unitsKept + p.unitsMade).toBe(p.units);
      expect(hashOf(dir.dir)).toEqual(TIER2);
      // a bake that is done keeps everything
      const again = buildPyramid(dir, o);
      expect(again.unitsMade).toBe(0);
      expect(again.unitsKept).toBe(24);
      expect(hashOf(dir.dir)).toEqual(TIER2);
    } finally { rmSync(dir.dir, { recursive: true, force: true }); }
  });

  test("the tiers above the units' roots are pooled from the roots' files, whatever the unit tier", () => {
    const a = synth(2), b = synth(2);
    try {
      buildPyramid(a.dir, { ...a.opts, unitTier: 2 });
      buildPyramid(b.dir, { ...b.opts, unitTier: 0 });
      expect(hashOf(a.dir.dir)).toEqual(TIER2);
      expect(hashOf(b.dir.dir)).toEqual(TIER2);
    } finally { rmSync(a.dir.dir, { recursive: true, force: true }); rmSync(b.dir.dir, { recursive: true, force: true }); }
  });
});
