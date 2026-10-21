// The tile store keeps a tier's planes tile-major on disk: a tile is a contiguous block, a gathered patch is the very field patch.ts's gather gives from the whole tier (across tile and
// face edges, beside a cube's corner), a scattered interior is what a whole-tier write would have made, the cells file round trips, and the cache holds to its byte budget.
// Each case alone: bun test ./src/gpu/globe/tilestore.test.ts -t "<name>" --timeout 120000
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierGrid } from "./grid";
import { gather, patchAt, patchOf } from "./patch";
import { TileStore } from "./tilestore";

const dir = mkdtempSync(join(tmpdir(), "tilestore-"));
const fieldOf = (tier: number) => { const n = 6 * (256 << tier) ** 2, f = new Int32Array(n); for (let i = 0; i < n; i++) f[i] = (Math.imul(i, 2654435761) >>> 5) - 2 ** 26; return f; };
// the store holding a whole-tier field (through the cells file, which is the way the chain's files come in)
function stored(tier: number, name: string, field: Int32Array, cache?: number): TileStore {
  const path = join(dir, `${name}.cells.i32`);
  writeFileSync(path, new Uint8Array(field.buffer));
  const s = new TileStore(join(dir, name), tier, { a: "i32", b: "i32" }, cache);
  s.fromCells("a", path);
  return s;
}
afterAll(() => { /* the temp directory is under the system's temp, cleared by it */ });

describe("the tile store", () => {
  test("a tile is the block of the tier's cells at tile = face * T * T + ty * T + tx, and a plane survives the store being closed", () => {
    const tier = 1, field = fieldOf(tier), s = stored(tier, "t1", field), n = tierGrid(tier).fn;
    for (const [f, tx, ty] of [[0, 0, 0], [3, 1, 0], [5, 1, 1], [2, 0, 1]] as const) {
      const t = s.read("a", s.tileIndex(f, tx, ty)) as Int32Array;
      for (const [x, y] of [[0, 0], [255, 0], [0, 255], [17, 200], [255, 255]]) expect(t[y * 256 + x]).toBe(field[(f * n + ty * 256 + y) * n + tx * 256 + x]);
      expect(s.tileAt(s.tileIndex(f, tx, ty))).toEqual({ face: f, tx, ty });
    }
    s.close();
    const again = new TileStore(join(dir, "t1"), tier, { a: "i32" });
    expect((again.read("a", 5) as Int32Array)[300]).toBe(field[(s.tileAt(5).face * n + s.tileAt(5).ty * 256 + 1) * n + s.tileAt(5).tx * 256 + 44]);
    again.close();
  });

  test("a gathered patch is patch.ts's gather of the whole field: tiles, blocks of tiles, edges and cube corners, any halo", () => {
    const tier = 2, field = fieldOf(tier), s = stored(tier, "t2", field);
    const cases: [number, number, number, number, number][] = [[0, 0, 0, 1, 256], [0, 256, 768, 1, 256], [3, 768, 0, 4, 256], [5, 0, 0, 1, 512], [2, 512, 512, 1, 512], [4, 0, 512, 17, 256], [1, 512, 0, 1, 512]];
    for (const [f, x0, y0, halo, interior] of cases) {
      const p = patchAt(tier, f, x0, y0, halo, interior), want = gather(p, field), got = s.gather("a", p) as Int32Array;
      expect(got.length).toBe(want.length);
      let bad = 0;
      for (let k = 0; k < want.length; k++) if (got[k] !== want[k]) bad++;
      expect(bad).toBe(0);
    }
    s.close();
  });

  test("a scattered interior is written where the whole-tier scatter writes it, and the cells file comes back as it went in", () => {
    const tier = 2, field = fieldOf(tier), s = stored(tier, "t2s", field), p = patchOf(tier, 4, 2, 1, 2, 512);
    const patchField = new Int32Array(p.side * p.side).map((_, k) => k * 7 - 11);
    s.scatter("b", p, patchField);
    // every tile of the interior holds the patch's cells; the others are zero
    const want = new Int32Array(field.length);
    for (let y = 0; y < p.interior; y++) for (let x = 0; x < p.interior; x++) want[p.ids[(y + p.halo) * p.side + x + p.halo]] = patchField[(y + p.halo) * p.side + x + p.halo];
    s.toCells("b", join(dir, "t2s.out.i32"));
    const back = new Int32Array(readFileSync(join(dir, "t2s.out.i32")).buffer.slice(0));
    expect(back.length).toBe(want.length);
    let bad = 0;
    for (let k = 0; k < want.length; k++) if (back[k] !== want[k]) bad++;
    expect(bad).toBe(0);
    s.toCells("a", join(dir, "t2s.a.i32"));
    expect(Buffer.compare(readFileSync(join(dir, "t2s.a.i32")), Buffer.from(field.buffer))).toBe(0);
    s.close();
  });

  test("swap trades two planes, and the cache stays within its budget", () => {
    const tier = 1, field = fieldOf(tier), s = stored(tier, "t1c", field, 3 * 256 * 1024);
    s.write("b", 7, new Int32Array(65536).fill(42));
    s.swap("a", "b");
    expect((s.read("b", 3) as Int32Array)[10]).toBe(field[256 * 512 + 256 + 10]);
    expect((s.read("a", 7) as Int32Array)[5]).toBe(42);
    for (let t = 0; t < s.tiles; t++) s.view("b", t);
    expect(s.stats.readBytes).toBeGreaterThan(0);
    // 3 tiles of 256 KB are the budget: a pass over 24 tiles holds at most that many
    expect(s.cachedBytes).toBeLessThanOrEqual(3 * 256 * 1024);
    s.close();
  });
});
