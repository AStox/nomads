// The pooled coarse tier: every cell of tier 0 pooled from tier 2's files (the 4 by 4 children, as tier 3 from tier 5) is what plain arithmetic over its children gives, the classes by their most
// held code, the companded rain by the mean of the squares; a stopped and resumed pool is the bytes of one call; the marker belongs to the tier it pools to.
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, openSync, readSync, rmSync } from "node:fs";
import { forget, KINDS, typeOf } from "./stages";
import { BAKE, BakeDir, tierFile } from "./bakedir";
import { POOL, poolTier } from "./pool";
import { doneFileOf } from "./stages";

const DIR = join(BAKE, "pool-scratch"), FROM = 2, TO = 0, N = 256 << FROM, n = 256 << TO;
afterAll(() => { forget(); for (const d of [DIR, `${DIR}-b`]) rmSync(d, { recursive: true, force: true }); });
// words as a function of the cell and the file alone (a hash of both), in the range each file holds
function make(dir: BakeDir) {
  for (const [m, f] of POOL.entries()) {
    const K = KINDS[typeOf(f.file)], a = new K(6 * N * N), range = f.file.startsWith("rock") || f.file.startsWith("drift") ? 4 : f.file.startsWith("pr") ? 20000 : f.file.startsWith("dd") ? 65536 : 30000;
    for (let i = 0; i < a.length; i++) a[i] = f.kind === "mode" ? ((Math.imul(i >> 2, 2654435761) ^ m) >>> 7) % range : (Math.imul(i ^ (m * 977), 2654435761) >>> 9) % range;
    dir.write(tierFile(FROM, f.file), a);
  }
}
const sample = (dir: BakeDir, file: string, cell: number) => { const K = KINDS[typeOf(file)], fd = openSync(dir.path(file), "r"), a = new K(1); try { readSync(fd, new Uint8Array(a.buffer), 0, K.BYTES_PER_ELEMENT, cell * K.BYTES_PER_ELEMENT); } finally { closeSync(fd); } return a[0]; };

describe("the pooled coarse tier", () => {
  test("each cell is plain arithmetic over its 16 children; a stopped and resumed pool is one call's bytes; the marker is the tier's", () => {
    rmSync(DIR, { recursive: true, force: true }); rmSync(`${DIR}-b`, { recursive: true, force: true });
    const a = new BakeDir(DIR), b = new BakeDir(`${DIR}-b`);
    make(a);
    for (const f of POOL) b.write(tierFile(FROM, f.file), new Uint8Array(a.raw(tierFile(FROM, f.file))));
    const first = poolTier(a, FROM, TO, 1e9, () => {}, POOL, [0, 3]);
    expect(first.tiles).toBe(2);
    expect(a.has(doneFileOf(TO, "pool"))).toBe(true);
    const rest = poolTier(a, FROM, TO, 1e9);
    expect(rest.done).toBe(true);
    expect(rest.tileS.length).toBe(4); // the two kept were not made again
    expect(poolTier(b, FROM, TO, 1e9).done).toBe(true);
    for (const f of POOL) expect(Bun.hash(new Uint8Array(a.raw(tierFile(TO, f.file))))).toBe(Bun.hash(new Uint8Array(b.raw(tierFile(TO, f.file)))));
    // by plain arithmetic, for cells over the faces, their edges and corners
    for (let c = 0; c < 6 * n * n; c += c % 7 === 0 ? 211 : 37) {
      const face = Math.floor(c / (n * n)), Y = Math.floor((c - face * n * n) / n), X = c - face * n * n - Y * n, kids: number[] = [];
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) kids.push((face * N + 4 * Y + j) * N + 4 * X + i);
      for (const f of POOL) {
        const v = kids.map((k) => sample(a, tierFile(FROM, f.file), k)), got = sample(a, tierFile(TO, f.file), c);
        let want: number;
        if (f.kind === "mode") { const counts = new Map<number, number>(); for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1); want = [...counts.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0]; }
        else if (f.kind === "mean") want = Math.floor((v.reduce((s, x) => s + x, 0) + 8) / 16);
        else want = Math.round(Math.sqrt(v.reduce((s, x) => s + x * x, 0) / 16));
        expect(got).toBe(want);
      }
    }
  }, 120_000);

  test("a source file that is not there is named, and a finer tier is required", () => {
    const d = new BakeDir(`${DIR}-b`);
    expect(() => poolTier(d, 1, 3, 1)).toThrow("not coarser");
    expect(() => poolTier(new BakeDir(`${DIR}-c`), 2, 0, 1)).toThrow("t2-rock.u8");
    rmSync(`${DIR}-c`, { recursive: true, force: true });
  });
});
