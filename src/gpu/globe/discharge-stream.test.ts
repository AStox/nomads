// The streamed discharge (discharge-stream.ts) against the in-memory sums: on a forest made to cross faces, edges and cube corners (cheap to debug), and on the real planet's tier 4, where the
// in-memory `dischargeOf` result is the oracle. Each case alone:
//   bun test ./src/gpu/globe/discharge-stream.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { BakeDir } from "./bakedir";
import { ONES, gatherTwin, hiFile, loFile, countFile, type WeightField } from "./discharge";
import { BlockGrid, Plane, dischargeStream } from "./discharge-stream";
import { FACES, tierGrid } from "./grid";
import { REAL, SCRATCH, crossings, descentForest, haveReal, randomWeights, sampleOf, sha, weightsOf, wordsOf, wordsOfFile } from "./water-stream-fixture";

const planeOf = (path: string): { at(id: number): number; close(): void } => (path.endsWith("u16") ? new Plane(path, Uint16Array) : new Plane(path, Uint32Array));
const wordsOf16or32 = (path: string): Uint32Array | Uint16Array => (path.endsWith("u16") ? wordsOfFile(path, Uint16Array) : wordsOfFile(path, Uint32Array));

describe("the streamed discharge", () => {
  const TIER = 1, scratch = `${SCRATCH}/unit-discharge`, N = FACES * tierGrid(TIER).fn ** 2;
  const fields: WeightField[] = [{ from: "w0.u32", stem: "t1-q0" }, { from: "w1.u32", stem: "t1-q1" }, { from: ONES, stem: "t1-cells" }];
  const make = (name: string) => {
    const dir = new BakeDir(`${scratch}/${name}`), to = new Uint32Array(dir.has("t1-to.u32") ? dir.raw("t1-to.u32") : new ArrayBuffer(0));
    if (to.length === N) return { dir, to };
    const made = descentForest(TIER);
    dir.write("t1-to.u32", made);
    dir.write("w0.u32", randomWeights(N, 100_000_000, 100_000_000, 1)); // 1.57 M cells of up to 2e8 stay under 2^48, and a basin of 22 cells passes 2^32
    dir.write("w1.u32", randomWeights(N, 0, 1 << 21, 2));
    return { dir, to: made };
  };
  const outputs = ["t1-q0-lo.u32", "t1-q0-hi.u16", "t1-q1-lo.u32", "t1-q1-hi.u16", "t1-cells.u32"];
  const clear = (dir: BakeDir) => { for (const f of outputs) rmSync(dir.path(f), { force: true }); rmSync(dir.path("discharge-stream-t1.work"), { recursive: true, force: true }); };
  const bytesOf = (dir: BakeDir) => outputs.map((f) => sha(dir.path(f)));

  // The in-memory twin's words for each field.
  function twinOf(dir: BakeDir, to: Uint32Array) {
    const w0 = new Uint32Array(dir.raw("w0.u32")), w1 = new Uint32Array(dir.raw("w1.u32"));
    return { q0: wordsOf(gatherTwin(to, w0)), q1: wordsOf(gatherTwin(to, w1)), cells: wordsOf(gatherTwin(to, new Uint32Array(N).fill(1))) };
  }
  function expectEqual(dir: BakeDir, to: Uint32Array) {
    const t = twinOf(dir, to), want: Record<string, Uint32Array | Uint16Array> = { "t1-q0-lo.u32": t.q0.lo, "t1-q0-hi.u16": t.q0.hi, "t1-q1-lo.u32": t.q1.lo, "t1-q1-hi.u16": t.q1.hi, "t1-cells.u32": t.cells.lo };
    for (const [f, words] of Object.entries(want)) {
      const got = wordsOf16or32(dir.path(f));
      expect([f, got.length, Buffer.compare(Buffer.from(got.buffer, got.byteOffset, got.byteLength), Buffer.from(words.buffer, words.byteOffset, words.byteLength))]).toEqual([f, N, 0]);
    }
  }

  test("the forest the tests stage crosses face edges and cube corners, and sums past 2^32", () => {
    const { dir, to } = make("shared"), c = crossings(TIER, to), sums = gatherTwin(to, new Uint32Array(dir.raw("w0.u32")));
    expect(c.faces).toBeGreaterThan(500);
    expect(c.corners).toBeGreaterThan(0);
    expect(sums.filter((v) => v >= 2 ** 32).length).toBeGreaterThan(1000);
    expect(sums.reduce((a, b) => Math.max(a, b), 0)).toBeLessThan(2 ** 48);
  });

  for (const block of [1, 2]) {
    test(`blocks of ${block} tile${block > 1 ? "s" : ""} (a face is ${2 / block} blocks along) make the in-memory words, in order and reversed`, async () => {
      const { dir, to } = make("shared");
      for (const reverse of [false, true]) {
        clear(dir);
        const p = await dischargeStream(dir, TIER, fields, Infinity, () => {}, { block, reverse });
        expect(p.done).toBe(true);
        expect(p.blocks).toBe(new BlockGrid(TIER, block).count);
        expectEqual(dir, to);
      }
    }, 120_000);
  }

  test("calls of no budget, and a block made again, give the same bytes", async () => {
    const { dir, to } = make("shared");
    clear(dir);
    const whole = await dischargeStream(dir, TIER, fields, Infinity, () => {}, { block: 1 });
    expect(whole.done).toBe(true);
    const want = bytesOf(dir);
    clear(dir);
    let calls = 0, redone = false, p = await dischargeStream(dir, TIER, fields, 0, () => {}, { block: 1, reverse: true });
    const seen = new Set<string>([p.stage]);
    for (calls = 1; !p.done && calls < 200; calls++) {
      if (!redone && p.stage === "area2" && p.blocksDone >= 3) { rmSync(`${dir.path("discharge-stream-t1.work")}/a2-23.done`, { force: true }); redone = true; } // a block a dead call may have left half written
      p = await dischargeStream(dir, TIER, fields, 0, () => {}, { block: 1, reverse: true });
      seen.add(p.stage);
    }
    expect(p.done).toBe(true);
    expect(calls).toBeGreaterThan(30);
    expect([...seen].sort()).toEqual(["area1", "area2", "done"]);
    expect(bytesOf(dir)).toEqual(want);
    expectEqual(dir, to);
    expect(existsSync(dir.path("discharge-stream-t1.work"))).toBe(false);
  }, 200_000);

  test("fields that are made are left alone, and another block size in a started run is refused", async () => {
    const { dir } = make("shared");
    clear(dir);
    await dischargeStream(dir, TIER, fields, 0, () => {}, { block: 1 });
    await expect(dischargeStream(dir, TIER, fields, 0, () => {}, { block: 2 })).rejects.toThrow(/remove it/);
    clear(dir);
    const done = await dischargeStream(dir, TIER, fields, Infinity, () => {}, { block: 2 });
    expect(done.done).toBe(true);
    const again = await dischargeStream(dir, TIER, fields, Infinity, () => {}, { block: 2 });
    expect(again.done).toBe(true);
    expect(again.made).toEqual([]);
  }, 120_000);

  test("a sum past 48 bits is refused", async () => {
    // face 0 is one basin of 262,144 cells of 2^32 - 1 (2^50): every row drains west and the first column south to the corner cell; the other faces are roots
    const dir = new BakeDir(`${scratch}/big`), n = tierGrid(TIER).fn, to = Uint32Array.from({ length: N }, (_, i) => i), w = new Uint32Array(N).fill(4294967295);
    for (let Y = 0; Y < n; Y++) for (let X = 0; X < n; X++) if (X > 0) to[Y * n + X] = Y * n + X - 1; else if (Y > 0) to[Y * n] = (Y - 1) * n;
    dir.write("t1-to.u32", to); dir.write("w.u32", w);
    await expect(dischargeStream(dir, TIER, [{ from: "w.u32", stem: "t1-big" }], Infinity, () => {}, { block: 2 })).rejects.toThrow(/48 bits/);
    rmSync(dir.dir, { recursive: true, force: true });
  }, 120_000);
});

describe("the streamed discharge on the real planet's tier 4", () => {
  const dir = new BakeDir(`${SCRATCH}/t4`), N = FACES * 4096 * 4096;
  const stems = [0, 1, 2, 3].map((s) => `t4-q${s}`), outputs = [...stems.flatMap((s) => [loFile(s), hiFile(s)]), countFile("t4-cells")];
  const fields: WeightField[] = [...stems.map((stem, s) => ({ from: `t4-vs${s}.u32`, stem })), { from: ONES, stem: "t4-cells" }];
  // the scratch holds the inputs (links), and the weights, which are found from the in-memory result once
  function prepare() {
    mkdirSync(dir.dir, { recursive: true });
    if (!existsSync(dir.path("t4-to.u32"))) symlinkSync(`${REAL}/t4-to.u32`, dir.path("t4-to.u32"));
    const to = wordsOfFile(`${REAL}/t4-to.u32`, Uint32Array);
    for (let s = 0; s < 4; s++) if (!dir.has(`t4-vs${s}.u32`)) dir.write(`t4-vs${s}.u32`, weightsOf(to, wordsOfFile(`${REAL}/${loFile(stems[s])}`, Uint32Array), wordsOfFile(`${REAL}/${hiFile(stems[s])}`, Uint16Array)));
  }
  const clear = () => { for (const f of outputs) rmSync(dir.path(f), { force: true }); for (const f of readdirOf()) rmSync(dir.path(f), { recursive: true, force: true }); };
  const readdirOf = () => [`discharge-stream-t4.work`].filter((f) => existsSync(dir.path(f)));
  function compare() {
    for (const f of outputs) expect([f, sha(dir.path(f))]).toEqual([f, sha(`${REAL}/${f}`)]);
    for (const f of outputs) {
      const a = planeOf(dir.path(f)), b = planeOf(`${REAL}/${f}`);
      try { for (const k of sampleOf(N)) if (a.at(k) !== b.at(k)) throw new Error(`${f} differs at cell ${k}`); } finally { a.close(); b.close(); }
    }
  }
  const real = test.skipIf(!haveReal());

  real("blocks of 4 tiles (1,024 cells) equal the in-memory discharge, every word", async () => {
    prepare(); clear();
    const p = await dischargeStream(dir, 4, fields, Infinity, (s) => console.log(s), { block: 4 });
    const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`blocks of 4: ${p.seconds.toFixed(1)} s, area1 ${m(p.blockS.area1).toFixed(3)} s a block, skeleton ${p.skelS.toFixed(2)} s, area2 ${m(p.blockS.area2).toFixed(3)} s a block, peak rss ${(process.resourceUsage().maxRSS / 2 ** 20).toFixed(2)} GB`);
    expect(p.done).toBe(true);
    compare(); clear();
  }, 280_000);

  real("blocks of 2 tiles (512 cells) with the blocks in reverse order equal it too", async () => {
    prepare(); clear();
    const p = await dischargeStream(dir, 4, fields, Infinity, (s) => console.log(s), { block: 2, reverse: true });
    const m = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`blocks of 2: ${p.seconds.toFixed(1)} s, area1 ${m(p.blockS.area1).toFixed(3)} s a block, skeleton ${p.skelS.toFixed(2)} s, area2 ${m(p.blockS.area2).toFixed(3)} s a block`);
    expect(p.done).toBe(true);
    compare(); clear();
  }, 280_000);

  real("calls of a few seconds give the same bytes", async () => {
    prepare(); clear();
    let p = await dischargeStream(dir, 4, fields, 8, () => {}, { block: 4 }), calls = 1;
    for (; !p.done && calls < 40; calls++) p = await dischargeStream(dir, 4, fields, 8, () => {}, { block: 4, reverse: calls % 2 === 1 });
    console.log(`split into ${calls} calls of 8 s`);
    expect(calls).toBeGreaterThan(2);
    compare(); clear();
  }, 280_000);
});
