// The streamed tier solve (tiers-stream.ts) gives the in-memory solve's bytes: the carry to the next tier, steps (the heights and the tier-0 carries), and the settled flow (receivers, discharge
// area, flooded surface), in blocks of 1, 2 and 4 tiles and in another order of the visits, in calls too short to finish a step, and after a call that died inside a step. They run on tier 2
// (6.3 million cells) from a staged ridge along the edge of faces 0 and 1, so that rivers cross tile, block and face edges. Each case alone:
//   bun test ./src/gpu/globe/tiers-stream.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseGpu, theGpu } from "../device";
import { defaultParams } from "./erosion";
import { FACES, centre, tierGrid, type Grid } from "./grid";
import { patchAt } from "./patch";
import { Regional, refineSmooth, remapHeights, tierTable, type RouteLaw } from "./regional";
import { StreamedTier, refineBlock, type StreamOptions } from "./tiers-stream";
import type { Planet } from "./window";

afterAll(releaseGpu);
const DEG = Math.PI / 180, g0 = tierGrid(0), N0 = FACES * 256 * 256;
const ridge = (g: Grid): Float32Array => {
  const out = new Float32Array(FACES * g.fn * g.fn);
  for (let f = 0, i = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++, i++) {
        const p = centre(g, f, X, Y), lat = Math.asin(p[2]) / DEG, lon = Math.atan2(p[1], p[0]) / DEG, d = Math.abs(lon - 45);
        out[i] = Math.abs(lat) < 40 && d < 12 ? 50 + 2450 * Math.exp(-((d / 5) ** 2)) : -1500;
      }
  return out;
};
const planetOf0 = () => ({ radius: g0.radius, pools: [0, 1, 2, 3, 4].map((k) => new Float32Array(N0).fill(k === 3 ? 2000 : 0)) }) as unknown as Planet;
const words = (b: Buffer) => new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const work = () => mkdtempSync(join(tmpdir(), "tiers-stream-"));
interface Words { height: Int32Array; carry: Int32Array; to: Int32Array; acc: Int32Array; flooded: Int32Array }
const same = (a: Int32Array, b: Int32Array) => { if (a.length !== b.length) return -2; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i; return -1; };

describe("the carry to the next tier, a block at a time", () => {
  test("refineBlock is refineSmooth word for word, over every block of faces' edges and corners", () => {
    const from = 1, n = 6 * (256 << from) ** 2, parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = (Math.imul(i, 2654435761) >>> 12) - 2 ** 19;
    const want = refineSmooth(parent, from), fnc = 256 << (from + 1), out = new Int32Array(want.length), ipar = 128;
    for (let f = 0; f < 6; f++)
      for (let ry = 0; ry < (256 << from) / ipar; ry++)
        for (let rx = 0; rx < (256 << from) / ipar; rx++) {
          const blk = refineBlock(parent, from, patchAt(from, f, rx * ipar, ry * ipar, 6, ipar)), ic = 2 * ipar;
          for (let y = 0; y < ic; y++) for (let x = 0; x < ic; x++) out[(f * fnc + ry * ic + y) * fnc + rx * ic + x] = blk[y * ic + x];
        }
    expect(same(out, want)).toBe(-1);
  });
});

describe("the streamed step", () => {
  const TIER = 2, planet = planetOf0(), table = tierTable(planet, TIER, defaultParams({ dtYr: 1e6 })), height = remapHeights(TIER, ridge(g0));
  // the island's law: eight neighbours, the receiver drawn among the lower ones, one rain, and the length of each step (My)
  interface Island { route: RouteLaw; dts: number[]; tableAt: (step: number) => Uint32Array }
  const islandLaw = (dts: number[], slide: 8 | 16 = 16, extra: Partial<RouteLaw> = {}): Island => {
    const made = new Map<number, Uint32Array>();
    return { route: { nflow: 8, stochastic: true, slide, ...extra }, dts, tableAt: (step) => { const dt = dts[Math.min(step, dts.length - 1)]; if (!made.has(dt)) made.set(dt, tierTable(planet, TIER, defaultParams({ dtYr: dt * 1e6 }), true)); return made.get(dt) as Uint32Array; } };
  };
  // the in-memory solve: `steps` steps, the heights and carries after them, then the settled flow of the last heights (the steepest descent, whatever the law)
  async function oracle(steps: number, law?: Island): Promise<Words> {
    const r = new Regional(await theGpu(), TIER, law ? law.tableAt(0) : table, height, law?.route);
    try {
      for (let s = 0; s < steps; s++) { if (law && s > 0 && law.tableAt(s) !== law.tableAt(s - 1)) r.setTable(law.tableAt(s)); await r.step(); }
      const state = await r.state(steps);
      r.setRoute(false);
      await r.flow();
      const flow = await r.readFlow();
      return { height: state.height, carry: state.carry, to: new Int32Array(flow.to.buffer), acc: new Int32Array(flow.acc.buffer), flooded: await r.readFlooded() };
    } finally { r.release(); }
  }
  async function streamed(dir: string, steps: number, o: StreamOptions, budget = Infinity, law?: Island): Promise<Words & { calls: number; visits: Record<string, number>[] }> {
    const calls: StreamedTier[] = [];
    for (let guard = 0; guard < 400; guard++) {
      const st = new StreamedTier(await theGpu(), TIER, dir, law ? law.tableAt(0) : table, law ? { ...o, law: law.route, tableAt: law.tableAt } : o);
      calls.push(st);
      if (!st.started) st.setHeights(height);
      await st.open();
      const r = await st.work(budget, steps, true);
      if (r.done) {
        for (const [p, f] of [["H", "h"], ["TO", "to"], ["ACC", "acc"], ["F", "f"]] as const) st.exportCells(p, join(dir, `${f}.cells`));
        const carry = (await st.solver.readCarry()), visits = st.prog.stepVisits;
        st.release();
        return { height: words(readFileSync(join(dir, "h.cells"))), carry, to: words(readFileSync(join(dir, "to.cells"))), acc: words(readFileSync(join(dir, "acc.cells"))), flooded: words(readFileSync(join(dir, "f.cells"))), calls: calls.length, visits };
      }
      st.release();
    }
    throw new Error("the streamed solve did not finish in 400 calls");
  }
  const equal = (a: Words, b: Words) => {
    expect(same(b.height, a.height)).toBe(-1);
    expect(same(b.carry, a.carry)).toBe(-1);
    expect(same(b.flooded, a.flooded)).toBe(-1);
    expect(same(b.acc, a.acc)).toBe(-1);
    expect(same(b.to, a.to)).toBe(-1);
  };

  test("two steps and the settled flow are the in-memory solve's bytes, in blocks of 1, 2 and 4 tiles and in another order", async () => {
    const want = await oracle(2), seen: string[] = [];
    for (const o of [{ block: 1 }, { block: 2 }, { block: 4 }, { block: 2, order: "reverse" as const }, { block: 1, order: 7 }]) {
      const got = await streamed(work(), 2, o);
      equal(want, got);
      seen.push(`blocks of ${o.block}${o.order ? ` order ${o.order}` : ""}: visits ${JSON.stringify(got.visits[1])}`);
    }
    console.log(`streamed step on tier 2 equals the in-memory step:\n  ${seen.join("\n  ")}`);
  }, 280_000);

  test("the fine tiers' law (eight neighbours, drawn receivers, slides of sixteen neighbours, steps of 26, 6.5 and 1.6 My, one rain) is the in-memory solve's bytes in blocks of 1, 2 and 4 tiles, in another order and in short calls", async () => {
    const law = islandLaw([26, 6.5, 1.6]), want = await oracle(3, law);
    for (const [o, budget] of [[{ block: 1 }, Infinity], [{ block: 4 }, Infinity], [{ block: 2, order: "reverse" as const }, Infinity], [{ block: 1, order: 5 }, Infinity], [{ block: 2 }, 0.6]] as const) equal(want, await streamed(work(), 3, o, budget, law));
  }, 280_000);

  test("the band-limited hold of span 2 is the in-memory solve's bytes in blocks of 1, 2 and 4 tiles, in another order and in short calls, and is not the box hold's", async () => {
    const law = islandLaw([26, 6.5, 1.6], 16, { band: 2 }), want = await oracle(3, law), box = await oracle(3, islandLaw([26, 6.5, 1.6]));
    expect(same(want.height, box.height)).not.toBe(-1);
    for (const [o, budget] of [[{ block: 1 }, Infinity], [{ block: 4 }, Infinity], [{ block: 2, order: "reverse" as const }, Infinity], [{ block: 1, order: 5 }, Infinity], [{ block: 2 }, 0.6]] as const) equal(want, await streamed(work(), 3, o, budget, law));
  }, 280_000);

  test("the band-limited hold of span 1 is the in-memory solve's bytes in blocks of 2 tiles", async () => {
    const law = islandLaw([26, 6.5], 16, { band: 1 }), want = await oracle(2, law);
    equal(want, await streamed(work(), 2, { block: 2 }, Infinity, law));
  }, 280_000);

  test("calls too short to finish a step make the same bytes, and a call that died inside a step is begun again from the step's heights", async () => {
    const want = await oracle(2), dir = work();
    // a call of a fraction of a second at a time
    const got = await streamed(dir, 2, { block: 2 }, 0.4);
    expect(got.calls).toBeGreaterThan(3);
    equal(want, got);
    // the same, with the dead call: after a short call that stops inside a step, mark it as running (it died) and spoil a tile of the heights
    const dir2 = work();
    let spoiled = false;
    for (let guard = 0; guard < 400; guard++) {
      const st = new StreamedTier(await theGpu(), TIER, dir2, table, { block: 2 });
      if (!st.started) st.setHeights(height);
      await st.open();
      const r = await st.work(0.4, 2, true);
      const mid = !r.done && st.prog.job === "step" && st.prog.stage !== "init" && st.prog.steps === 1 && !spoiled;
      if (r.done) { st.release(); break; }
      if (mid) {
        st.store.write("H", 5, new Int32Array(65536).fill(123456));
        st.prog.running = true;
        writeFileSync(join(dir2, "progress.json"), JSON.stringify(st.prog));
        spoiled = true;
      }
      st.release();
    }
    expect(spoiled).toBe(true);
    const done = new StreamedTier(await theGpu(), TIER, dir2, table, { block: 2 });
    await done.open();
    await done.work(Infinity, 2, true);
    done.exportCells("H", join(dir2, "h.cells"));
    done.exportCells("ACC", join(dir2, "acc.cells"));
    done.release();
    expect(same(words(readFileSync(join(dir2, "h.cells"))), want.height)).toBe(-1);
    expect(same(words(readFileSync(join(dir2, "acc.cells"))), want.acc)).toBe(-1);
  }, 280_000);
});
