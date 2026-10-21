// The pyramid: a tile read back is the field's integers, the tier above is the 2 by 2 pooled tier below (mean of heights, the commonest rock, the greatest river), and every tile of
// every tier is made once. Run: bun test ./src/gpu/globe/pyramid.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { BakeDir } from "./bakedir";
import { buildPyramid, readTile, tilePath } from "./pyramid";

const TOP = 1, FN = 256 << TOP;

describe("the pyramid", () => {
  test("a top tile holds the field's integers and each coarser tile its children pooled", () => {
    const dir = new BakeDir(mkdtempSync(join(tmpdir(), "pyr-"))), n = 6 * FN * FN;
    const height = Int32Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0) % 4000000 - 1000000), rock = Uint8Array.from({ length: n }, (_, i) => ((i >> 1) ^ (i >> 9)) % 5), river = Uint8Array.from({ length: n }, (_, i) => (i % 97 === 0 ? 200 : i % 7));
    dir.write("t1-height.i32", height); dir.write("t1-rock.u8", rock); dir.write("t1-river.u8", river);
    const counts = buildPyramid(dir, { seed: 1, key: "k", topTier: TOP, sources: { height: { files: ["t1-height.i32"], convert: ([v]) => v / 64 }, rock: { files: ["t1-rock.u8"], convert: ([v]) => v }, river: { files: ["t1-river.u8", "t1-height.i32"], convert: ([v]) => v } } });
    expect(counts).toEqual([6, 24]);
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
});
