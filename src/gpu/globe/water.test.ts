// The planet's water stage (water.ts): the island's hydrology on a tile's patch, with the planet's receivers, flooded surface, hollows and discharge. The cases run on a staged planet at tier 2
// (water-staged.ts: the regional kernels' own flood and receivers over a ridge on the cube's edge, with three pits whose lakes cross a tile's edge and a face's edge) and one on the real tier 4.
// Each case alone (the staged fixture is made once, about 40 s, and kept in /tmp/planet-75m/water-scratch):
//   lockf /tmp/nomads-gpu.lock bun test ./src/gpu/globe/water.test.ts -t "<name>" --timeout 280000
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, symlinkSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { SEASON_S } from "../../terrain/water";
import { BakeDir } from "./bakedir";
import { gatherTwin, readDischarge, valueAt } from "./discharge";
import { tierGrid } from "./grid";
import { localOf, patchAt, patchOf, tileAt, type Patch } from "./patch";
import { runTiles, type Ctx, type Field } from "./stages";
import { STAGED_TIER, stagedClimate, stagedPlanet } from "./water-staged";
import { WATER_HALO, cellsStem, dischargeStems, inflowOf, mapped, unmap, waterFiles, waterOf, waterStage, lastRun, climateFor } from "./water";

afterAll(releaseGpu);
const SCRATCH = "/tmp/planet-75m/water-scratch", T = STAGED_TIER, p = `t${T}-`;
let fixture: Promise<Ctx> | undefined;
const staged = () => (fixture ??= theGpu().then((gpu) => stagedPlanet(gpu, new BakeDir(`${SCRATCH}/stage-t${T}`))));
const hash = (f: Field) => Bun.hash(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)).toString(16);
const out = (name: string, r: Record<string, Field>) => r[`${p}${name}`];

// the cells two patches' interiors share, as [index in a, index in b]
function shared(a: Patch, b: Patch): [number, number][] {
  const at = new Map<number, number>(), n = a.side;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) at.set(a.ids[(y + a.halo) * n + x + a.halo], (y + a.halo) * n + x + a.halo);
  const pairs: [number, number][] = [];
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const k = (y + b.halo) * b.side + x + b.halo, i = at.get(b.ids[k]); if (i !== undefined) pairs.push([i, k]); }
  return pairs;
}
const worst = (a: Field, b: Field, pairs: [number, number][]) => { let m = 0; for (const [i, k] of pairs) m = Math.max(m, Math.abs(a[i] - b[k])); return m; };

describe("the planet's water stage", () => {
  test("a patch's water is the same bytes twice", async () => {
    const ctx = await staged(), patch = patchAt(T, 0, 768, 256, WATER_HALO), a = await waterOf(ctx, patch, { climate: stagedClimate, tier: T }), b = await waterOf(ctx, patch, { climate: stagedClimate, tier: T });
    for (const f of waterFiles(T)) expect(hash(b[f])).toBe(hash(a[f]));
    console.log(`water: a staged tile's patch of ${patch.side}: ${lastRun.seconds.gpu.toFixed(2)} s, aquifer sweeps ${lastRun.sweeps.join(" and ")}, ${lastRun.inflows} inflows`);
    let channels = 0, wet = 0;
    for (let k = 0; k < patch.ids.length; k++) { channels += (out("chn.u8", a) as Uint8Array)[k]; if ((out("flow.u32", a) as Uint32Array)[k] > 0) wet++; }
    expect(channels).toBeGreaterThan(500);
    expect(wet).toBeGreaterThan(5000);
  });

  test("two patches a half tile apart agree over the cells they share", async () => {
    const ctx = await staged(), a = patchAt(T, 0, 768, 256, WATER_HALO), b = patchAt(T, 0, 768, 384, WATER_HALO), c = { climate: stagedClimate, tier: T };
    const ra = await waterOf(ctx, a, c), rb = await waterOf(ctx, b, c), pairs = shared(a, b);
    expect(pairs.length).toBe(256 * 128);
    // the standing water, the channels and the floodplains are the same cells; the flow and the water table agree to the last place a word keeps of them (the relaxation's own tolerance:
    // a head moves by under half a millimetre a sweep before it stops) and the power by what that flow gives it
    for (const f of ["water.u16", "chn.u8", "valley.u8"]) expect(worst(out(f, ra), out(f, rb), pairs), f).toBe(0);
    const flow = worst(out("flow.u32", ra), out("flow.u32", rb), pairs), table = Math.max(...["stb0", "stb1", "stb2", "stb3", "dry"].map((s) => worst(out(`${s}.u16`, ra), out(`${s}.u16`, rb), pairs)));
    const power = worst(out("pwr.u16", ra), out("pwr.u16", rb), pairs);
    console.log(`water: two patches of halo ${WATER_HALO} over ${pairs.length} shared cells: flow differs by at most ${flow} of 65536 m3/s, the table by ${table} of 64 per m, the power by ${power} of 16 per W/m2`);
    expect(flow).toBeLessThanOrEqual(2);
    expect(table).toBeLessThanOrEqual(2);
    expect(power).toBeLessThanOrEqual(4);
  });

  test("the water that enters a patch is the global discharge of the cells outside whose receiver is inside", async () => {
    const ctx = await staged(), g = tierGrid(T), N = 6 * g.fn * g.fn, patch = patchAt(T, 0, 768, 128, WATER_HALO), local = localOf(patch);
    const to = mapped(ctx, `${p}to.u32`) as Uint32Array, q = dischargeStems(T).map((s) => readDischarge(ctx.dir, s)), cells = readDischarge(ctx.dir, cellsStem(T));
    const inflow = inflowOf(ctx, patch, local, to, q, cells);
    // brute force over the whole tier
    const want = new Map<number, { cells: number; q6: number[] }>();
    for (let o = 0; o < N; o++) {
      if (to[o] === o || local(o) >= 0) continue;
      const at = local(to[o]);
      if (at < 0) continue;
      const e = want.get(at) ?? { cells: 0, q6: [0, 0, 0, 0] };
      e.cells += valueAt(cells, o);
      for (let s = 0; s < 4; s++) e.q6[s] += valueAt(q[s], o);
      want.set(at, e);
    }
    expect(inflow.length).toBe(want.size);
    expect(inflow.length).toBeGreaterThan(10);
    for (const f of inflow) expect(want.get(f.at)).toEqual({ cells: f.cells, q6: [...f.q6!] });
    // and the identity that makes the network one: over the patch's own forest, each cell's own surplus and the inflow add up to the global discharge at it, for every cell of the patch
    const vs = [0, 1, 2, 3].map((s) => mapped(ctx, `${p}vs${s}.u32`) as Uint32Array), n = patch.ids.length, lto = new Int32Array(n);
    for (let k = 0; k < n; k++) { const r = patch.missing[k] ? -1 : local(to[patch.ids[k]]); lto[k] = r < 0 ? k : r; }
    for (let s = 0; s < 4; s++) {
      const w = new Float64Array(n);
      for (let k = 0; k < n; k++) if (!patch.missing[k]) w[k] = vs[s][patch.ids[k]];
      for (const f of inflow) w[f.at] += f.q6![s];
      const sum = gatherTwin(lto, w);
      let wrong = 0, checked = 0;
      for (let k = 0; k < n; k++) if (!patch.missing[k]) { checked++; if (sum[k] !== valueAt(q[s], patch.ids[k])) wrong++; }
      expect(wrong).toBe(0);
      expect(checked).toBeGreaterThan(n / 2);
    }
  });

  test("with no rain in the patch the flow in every cell is the global discharge arriving over its border", async () => {
    const ctx = await staged(), patch = patchAt(T, 1, 0, 0, WATER_HALO), local = localOf(patch), dry = climateFor(() => ({ precip: [0, 0, 0, 0], pet: [0, 0, 0, 0] }));
    const r = await waterOf(ctx, patch, { climate: dry, tier: T, extra: ["sf0"] });
    const to = mapped(ctx, `${p}to.u32`) as Uint32Array, q = dischargeStems(T).map((s) => readDischarge(ctx.dir, s)), cells = readDischarge(ctx.dir, cellsStem(T)), inflow = inflowOf(ctx, patch, local, to, q, cells);
    const n = patch.ids.length, lto = new Int32Array(n);
    for (let k = 0; k < n; k++) { const t = patch.missing[k] ? -1 : local(to[patch.ids[k]]); lto[k] = t < 0 ? k : t; }
    // the kernel's own words: each season's volume (1/64 m3) as a flow, Q16 m3 a second (volume x C / 2^32, C = 2^(32 + 10) / SEASON_S, held under 2^29), and the mean of the four
    const C = BigInt(Math.round((2 ** 32 * 2 ** 10) / SEASON_S)), seasons = [0, 1, 2, 3].map((s) => {
      const w = new Float64Array(n);
      for (const f of inflow) w[f.at] += f.q6![s];
      return gatherTwin(lto, w);
    });
    // (the sea and a lake hold the head at their own level beside ground that stands lower, and give it water: the cells within 12 of either are left out)
    const flow = out("flow.u32", r) as Uint32Array, hh = mapped(ctx, `${p}height.i32`) as Int32Array, bb = mapped(ctx, `${p}basin.u8`) as Uint8Array, near = new Uint8Array(n), S = patch.side;
    for (let k = 0; k < n; k++) if (hh[patch.ids[k]] <= 0 || bb[patch.ids[k]]) for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) { const x = (k % S) + dx, y = Math.floor(k / S) + dy; if (x >= 0 && y >= 0 && x < S && y < S) near[y * S + x] = 1; }
    let wrong = 0, moving = 0;
    for (let k = 0; k < n; k++) {
      if (near[k]) continue;
      const sf = seasons.map((v) => { const x = (BigInt(v[k]) * C) >> 32n; return x > 0x1fffffffn ? 0x1fffffff : Number(x); });
      const mean = Math.floor((sf[0] + sf[1] + sf[2] + sf[3] + 2) / 4);
      if (mean > 0) moving++;
      if (mean !== flow[k]) wrong++;
    }
    expect(moving).toBeGreaterThan(100);
    expect(wrong).toBe(0);
  });

  test("a lake that crosses a tile's edge or a face's edge is the same lake from both sides", async () => {
    const ctx = await staged(), c = { climate: stagedClimate, tier: T }, h = mapped(ctx, `${p}height.i32`) as Int32Array, f = mapped(ctx, `${p}flooded.i32`) as Int32Array, basin = mapped(ctx, `${p}basin.u8`) as Uint8Array;
    const check = (patch: Patch, r: Record<string, Field>) => {
      let lake = 0, off = 0, deepest = 0;
      const water = out("water.u16", r) as Uint16Array;
      for (let y = 0; y < 256; y++)
        for (let x = 0; x < 256; x++) {
          const k = (y + patch.halo) * patch.side + x + patch.halo, id = patch.ids[k];
          if (!basin[id]) continue;
          lake++;
          // the lake stands at the flooded surface, to the centimetre the word keeps
          const level = h[id] / 256 + water[k] / 100;
          if (Math.abs(level - f[id] / 256) > 0.0101) off++;
          deepest = Math.max(deepest, water[k]);
        }
      return { lake, off, deepest };
    };
    // the pit on a tile's edge (Y = 512): the tile on either side, and a patch that holds all of it
    const up = patchAt(T, 0, 768, 256, WATER_HALO), down = patchAt(T, 0, 768, 512, WATER_HALO), both = patchAt(T, 0, 768, 384, WATER_HALO);
    const [ru, rd, rb] = [await waterOf(ctx, up, c), await waterOf(ctx, down, c), await waterOf(ctx, both, c)];
    const [u, d, b] = [check(up, ru), check(down, rd), check(both, rb)];
    expect(u.off + d.off + b.off).toBe(0);
    expect(u.lake).toBeGreaterThan(5);
    expect(d.lake).toBeGreaterThan(5);
    expect(b.deepest).toBeGreaterThan(300);
    // the same cells from two patches have the same depth
    for (const [x, y] of [[up, ru], [down, rd]] as const) expect(worst(out("water.u16", rb), out("water.u16", y), shared(both, x))).toBe(0);
    // the pit on the face's edge: the cells of face 0 and of face 1 stand at one surface
    const east = patchAt(T, 0, 768, 256, WATER_HALO), west = patchAt(T, 1, 0, 256, WATER_HALO), [re, rw] = [await waterOf(ctx, east, c), await waterOf(ctx, west, c)];
    const [e, w] = [check(east, re), check(west, rw)];
    expect(e.off + w.off).toBe(0);
    expect(e.lake).toBeGreaterThan(5);
    expect(w.lake).toBeGreaterThan(5);
    const cells = tierGrid(T).fn ** 2, level = (patch: Patch) => { let s = 0, n = 0; for (const id of patch.ids) if (basin[id] && Math.abs(Math.floor((id % cells) / tierGrid(T).fn) - 400) < 12 && f[id] !== 0) { s += f[id] / 256; n++; } return s / n; };
    expect(Math.abs(level(east) - level(west))).toBeLessThan(0.25);
  });

  test("runTiles makes the tiles asked for, resumes, and is the bytes of one call", async () => {
    const ctx = await staged(), other = new BakeDir(`${SCRATCH}/stage-t${T}-b`);
    for (const f of [`${p}height.i32`, `${p}flooded.i32`, `${p}to.u32`, `${p}rock.u8`, `${p}drift.u8`, `${p}dd.u16`, `${p}basin.u8`, `${p}cells.u32`, ...[0, 1, 2, 3].flatMap((s) => [`${p}q${s}-lo.u32`, `${p}q${s}-hi.u16`])])
      if (!existsSync(other.path(f))) symlinkSync(ctx.dir.path(f), other.path(f));
    const stage = waterStage({ climate: stagedClimate, tier: T }), tiles = [7, 11];
    for (const f of waterFiles(T)) other.remove(f);
    other.remove("water-done.u8");
    const made = new BakeDir(`${SCRATCH}/stage-t${T}-c`);
    for (const f of [`${p}height.i32`, `${p}flooded.i32`, `${p}to.u32`, `${p}rock.u8`, `${p}drift.u8`, `${p}dd.u16`, `${p}basin.u8`, `${p}cells.u32`, ...[0, 1, 2, 3].flatMap((s) => [`${p}q${s}-lo.u32`, `${p}q${s}-hi.u16`])])
      if (!existsSync(made.path(f))) symlinkSync(ctx.dir.path(f), made.path(f));
    for (const f of waterFiles(T)) made.remove(f);
    made.remove("water-done.u8");
    const a: Ctx = { ...ctx, dir: other }, b: Ctx = { ...ctx, dir: made };
    const one = await runTiles(a, stage, 250, () => {}, tiles);
    expect(one.done).toBe(true);
    const first = await runTiles(b, stage, 250, () => {}, [7]), second = await runTiles(b, stage, 250, () => {}, tiles);
    expect(first.tileS.length).toBe(1);
    expect(second.tileS.length).toBe(1);
    expect(second.done).toBe(true);
    for (const f of waterFiles(T)) expect(hash(new Uint8Array(made.raw(f)))).toBe(hash(new Uint8Array(other.raw(f))));
    // the tile made is what a patch of its own gives: tile 7's cells in the file are waterOf's interior
    const { face, tx, ty } = tileAt(T, 7), patch = patchOf(T, face, tx, ty, WATER_HALO), r = await waterOf(ctx, patch, { climate: stagedClimate, tier: T }), file = new Uint32Array(other.raw(`${p}flow.u32`));
    let wrong = 0, wet = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const k = (y + WATER_HALO) * patch.side + x + WATER_HALO; if (file[patch.ids[k]] !== (out("flow.u32", r) as Uint32Array)[k]) wrong++; if (file[patch.ids[k]] > 0) wet++; }
    expect(wrong).toBe(0);
    expect(wet).toBeGreaterThan(1000);
    unmap();
  });

  // the real tier 4's mountain tile 458 (face 1, tile 10, 12), with the global discharge the planet's bake holds: pinned to the bake of 2026-10-21 (the stand-in rain until the air stage's files exist)
  const key = "/tmp/planet-75m/1-c418e5fe9b5e", have = existsSync(`${key}/t4-q3-hi.u16`) && existsSync(`${key}/t4-cells.u32`) && existsSync(`${key}/t4-dd.u16`);
  test.skipIf(!have)("a mountain tile of the real planet is the same bytes twice, pinned", async () => {
    const ctx: Ctx = { gpu: await theGpu(), planet: {} as never, dir: new BakeDir(key), tier: 4 }, patch = patchOf(4, 1, 10, 12, WATER_HALO);
    const climate = climateFor((h) => ({ precip: [1.3, 0.8, 0.6, 1.3].map((w) => (20 + 0.02 * Math.max(0, h)) * w), pet: [0.3, 1.3, 1.6, 0.5].map((x) => 40 * x) }));
    const a = await waterOf(ctx, patch, { climate, tier: 4 }), seconds = lastRun.seconds.gpu + lastRun.seconds.inputs, sweeps = lastRun.sweeps.join(" and ");
    const b = await waterOf(ctx, patch, { climate, tier: 4 });
    for (const f of waterFiles(4)) expect(hash(b[f])).toBe(hash(a[f]));
    const all = Bun.hash(Buffer.concat(waterFiles(4).map((f) => Buffer.from(a[f].buffer, a[f].byteOffset, a[f].byteLength)))).toString(16);
    console.log(`water: real tile 458 at halo ${WATER_HALO}: ${seconds.toFixed(1)} s, aquifer sweeps ${sweeps}, ${lastRun.inflows} inflows, hash ${all}`);
    expect(all).toBe("8f9706040f726c4f");
    unmap();
  });
});
