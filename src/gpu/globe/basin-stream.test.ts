// The streamed lakes (basin-stream.ts) against the in-memory `basinOf`: on hollows staged to cross tile, face and cube edges (cheap to debug), on the staged planet's tier 2 (the discharge streamed
// too; the GPU makes its in-memory files), and on the real planet's tier 4, where `t4-basin.u8` is the oracle. Each case alone:
//   bun test ./src/gpu/globe/basin-stream.test.ts -t "<name>" --timeout 280000
// (the staged planet's case under `lockf /tmp/nomads-gpu.lock`)
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { BakeDir } from "./bakedir";
import { basinStream } from "./basin-stream";
import { Plane, dischargeStream } from "./discharge-stream";
import { FACES, tierGrid } from "./grid";
import { cellAcross } from "./patch";
import type { Ctx } from "./stages";
import { STAGED_TIER, stagedPlanet } from "./water-staged";
import { REAL, SCRATCH, basinFixture, descentForest, haveReal, linkInto, sampleOf, sha } from "./water-stream-fixture";
import { basinOf, dischargeFields, unmap, type LakeCount } from "./water";

afterAll(async () => { unmap(); await releaseGpu(); });
const ctxOf = (dir: BakeDir, tier: number) => ({ dir, tier }) as unknown as Ctx;
const same = (a: string, b: string) => expect(sha(a)).toBe(sha(b));
const SEASON_STEMS = (tier: number) => [0, 1, 2, 3].map((s) => `t${tier}-q${s}`);
const INPUTS = (tier: number) => [`t${tier}-height.i32`, `t${tier}-flooded.i32`, `t${tier}-lakenet.i32`, `t${tier}-to.u32`, ...SEASON_STEMS(tier).flatMap((s) => [`${s}-lo.u32`, `${s}-hi.u16`])];

describe("the streamed lakes", () => {
  const TIER = 1, root = `${SCRATCH}/unit-basin`, N = FACES * tierGrid(TIER).fn ** 2;
  // the in-memory result of the staged hollows, once, with its count of lakes and dry hollows
  function reference() {
    const ref = new BakeDir(`${root}/ref`);
    if (!ref.has("t1-basin.u8")) { basinFixture(ref, TIER, descentForest(TIER)); ref.putJson("stats", basinOf(ctxOf(ref, TIER))); }
    unmap();
    return { ref, stats: ref.json<LakeCount>("stats") as LakeCount };
  }
  const into = (name: string) => { const dir = new BakeDir(`${root}/${name}`); linkInto(reference().ref, dir, INPUTS(TIER)); rmSync(dir.path("t1-basin.u8"), { force: true }); return dir; };

  test("the hollows the tests stage hold lakes and dry hollows, and a lake lies over a face's edge", () => {
    const { ref, stats } = reference(), lake = new Uint8Array(ref.raw("t1-basin.u8")), g = tierGrid(TIER), n = g.fn;
    let across = 0;
    for (let f = 0; f < FACES; f++) for (let k = 0; k < n; k++) for (const [X, Y, X2, Y2] of [[0, k, -1, k], [n - 1, k, n, k], [k, 0, k, -1], [k, n - 1, k, n]]) {
      const c = cellAcross(g, f, X2, Y2);
      if (c >= 0 && lake[(f * n + Y) * n + X] && lake[c]) across++;
    }
    expect(lake.reduce((a, v) => a + v, 0)).toBeGreaterThan(1000);
    expect(stats.lakes).toBeGreaterThan(5);
    expect(stats.dry).toBeGreaterThan(5);
    expect(across).toBeGreaterThan(0);
  });

  for (const [block, reverse] of [[1, false], [2, false], [1, true]] as const) {
    test(`blocks of ${block} tile${block > 1 ? "s" : ""}${reverse ? " in reverse order" : ""} make the in-memory lakes, byte for byte`, async () => {
      const { ref, stats } = reference(), dir = into(`s${block}${reverse ? "r" : ""}`);
      const p = await basinStream(dir, TIER, Infinity, () => {}, { block, reverse });
      expect(p.done).toBe(true);
      expect([p.lakes, p.dry]).toEqual([stats.lakes, stats.dry]);
      same(dir.path("t1-basin.u8"), ref.path("t1-basin.u8"));
    }, 120_000);
  }

  test("calls of no budget give the same bytes, and a block made again changes nothing", async () => {
    const { ref, stats } = reference(), dir = into("resume");
    let p = await basinStream(dir, TIER, 0, () => {}, { block: 1 }), calls = 1, redone = false;
    const seen = new Set<string>([p.stage]);
    for (; !p.done && calls < 400; calls++) {
      const work = dir.path("basin-stream-t1.work"), made = p.stage === "write" ? readdirSync(work).find((f) => f.startsWith("wr-")) : undefined;
      if (!redone && made) { rmSync(`${work}/${made}`); redone = true; } // a block a dead call may have left half written
      p = await basinStream(dir, TIER, 0, () => {}, { block: 1, reverse: calls % 2 === 1 });
      seen.add(p.stage);
    }
    expect(p.done).toBe(true);
    expect([p.lakes, p.dry]).toEqual([stats.lakes, stats.dry]);
    expect(calls).toBeGreaterThan(40);
    expect([...seen].sort()).toEqual(["done", "inflow", "label", "write"]);
    same(dir.path("t1-basin.u8"), ref.path("t1-basin.u8"));
    expect(existsSync(dir.path("basin-stream-t1.work"))).toBe(false);
  }, 200_000);

  test("a finished tier is left alone", async () => {
    const { ref } = reference(), p = await basinStream(ref, TIER, Infinity, () => {}, { block: 1 });
    expect(p.done).toBe(true);
    expect(p.blockS.label.length).toBe(0);
  });
});

describe("the streamed discharge and lakes on the staged planet's tier 2", () => {
  const root = `${SCRATCH}/unit-staged`, T = STAGED_TIER;
  test("blocks of 1, 2 and 4 tiles make the in-memory discharge and lakes (lakes over a tile's edge and a face's edge)", async () => {
    const ctx = await stagedPlanet(await theGpu(), new BakeDir(`${root}/ref`), (s) => console.log(s)), ref = ctx.dir;
    const weights = dischargeFields(T).map((f) => f.from).filter((f) => f !== "ones"), outs = dischargeFields(T).flatMap((f) => (f.from === "ones" ? [`${f.stem}.u32`] : [`${f.stem}-lo.u32`, `${f.stem}-hi.u16`]));
    for (const block of [1, 2, 4]) {
      const dir = new BakeDir(`${root}/s${block}`);
      linkInto(ref, dir, [...weights, `t${T}-to.u32`, `t${T}-height.i32`, `t${T}-flooded.i32`, `t${T}-lakenet.i32`]);
      for (const f of [...outs, `t${T}-basin.u8`]) rmSync(dir.path(f), { force: true });
      const d = await dischargeStream(dir, T, dischargeFields(T), Infinity, () => {}, { block, reverse: block === 2 });
      expect(d.done).toBe(true);
      for (const f of outs) same(dir.path(f), ref.path(f));
      const p = await basinStream(dir, T, Infinity, () => {}, { block, reverse: block === 1 });
      expect(p.done).toBe(true);
      expect(p.lakes).toBeGreaterThan(0);
      same(dir.path(`t${T}-basin.u8`), ref.path(`t${T}-basin.u8`));
    }
  }, 280_000);
});

describe("the streamed lakes on the real planet's tier 4", () => {
  const dir = new BakeDir(`${SCRATCH}/t4b`), N = FACES * 4096 * 4096, real = test.skipIf(!haveReal());
  function prepare() {
    mkdirSync(dir.dir, { recursive: true });
    for (const f of INPUTS(4)) if (!existsSync(dir.path(f))) symlinkSync(`${REAL}/${f}`, dir.path(f));
    rmSync(dir.path("t4-basin.u8"), { force: true });
    rmSync(dir.path("basin-stream-t4.work"), { recursive: true, force: true });
  }
  const check = () => {
    expect(sha(dir.path("t4-basin.u8"))).toBe(sha(`${REAL}/t4-basin.u8`));
    const a = new Plane(dir.path("t4-basin.u8"), Uint8Array), b = new Plane(`${REAL}/t4-basin.u8`, Uint8Array);
    try { for (const k of sampleOf(N, 20_000)) if (a.at(k) !== b.at(k)) throw new Error(`the lakes differ at cell ${k}`); } finally { a.close(); b.close(); }
    rmSync(dir.path("t4-basin.u8"), { force: true });
  };
  const m = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  real("blocks of 4 tiles equal t4-basin.u8, byte for byte", async () => {
    prepare();
    const p = await basinStream(dir, 4, Infinity, (s) => console.log(s), { block: 4 });
    console.log(`blocks of 4: ${p.seconds.toFixed(1)} s, label ${m(p.blockS.label).toFixed(3)} s a block, merge ${p.mergeS.toFixed(2)} s, inflow ${m(p.blockS.inflow).toFixed(3)} s a block, write ${m(p.blockS.write).toFixed(3)} s a block (${p.blockS.write.length} blocks), ${p.lakes} lakes, ${p.dry} dry, peak rss ${(process.resourceUsage().maxRSS / 2 ** 20).toFixed(2)} GB`);
    expect(p.done).toBe(true);
    check();
  }, 280_000);

  real("blocks of 2 tiles in reverse order equal it too", async () => {
    prepare();
    const p = await basinStream(dir, 4, Infinity, (s) => console.log(s), { block: 2, reverse: true });
    console.log(`blocks of 2: ${p.seconds.toFixed(1)} s, label ${m(p.blockS.label).toFixed(3)} s a block, merge ${p.mergeS.toFixed(2)} s, inflow ${m(p.blockS.inflow).toFixed(3)} s a block, write ${m(p.blockS.write).toFixed(3)} s a block, ${p.lakes} lakes, ${p.dry} dry`);
    expect(p.done).toBe(true);
    check();
  }, 280_000);

  real("calls of a second give the same bytes", async () => {
    prepare();
    let p = await basinStream(dir, 4, 1, () => {}, { block: 4 }), calls = 1;
    for (; !p.done && calls < 100; calls++) p = await basinStream(dir, 4, 1, () => {}, { block: 4, reverse: calls % 2 === 1 });
    console.log(`split into ${calls} calls of 1 s`);
    expect(calls).toBeGreaterThan(3);
    check();
  }, 280_000);
});
