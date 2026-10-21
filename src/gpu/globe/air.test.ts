// The air stage (air.ts): the island's rain and climate on a patch of the 75 m tier. Each case alone: bun test ./src/gpu/globe/air.test.ts -t "<name>" --timeout 280000
// The cases on a staged planet (a synthetic tier 0 and heights that are a function of the cell id) say what must hold anywhere: the rain is never negative and every block of
// tier 0 keeps its planet's rain, windward slopes are wetter than lee ones and a wind along a ridge makes no such contrast, a run is the same twice, the answers the heights
// alone make (sun, sky, cold-air pools, fog) are the same from two patches that overlap and the rest differ by what their halos cut. The cases on the real planet (the bake of
// seed 1 under /tmp/planet-75m, skipped where it is not) pin a tile, measure the same overlap, and run the stage over a handful of tiles in two calls.
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { SMALL_RADIUS_M } from "./grid";
import { patchAt, type Patch } from "./patch";
import { tableMargin } from "../terrain/rain";
import { AIR_HALO, AIR_OUT, AIR_OUTPUTS, WORD_MAX_MM, airOf, airStage, blockMeans, compact, geometryOf, precipOfWord, rainOf, sampledOf, smoothBlocks, type AirTile } from "./air";
import { PATCH_SNOW_SHIFT } from "../terrain/climate";
import { runTiles, type Ctx } from "./stages";
import { BakeDir } from "./tiers";
import { readPlanet, type Planet } from "./window";
import { diskStore } from "../../../scripts/globe-window";

afterAll(releaseGpu);
const N0 = 6 * 256 * 256, FN = 4096, TIER = 4;
const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const hashOf = (arrays: ArrayBufferView[]) => Bun.hash(Buffer.concat(arrays.map(bytes))).toString(16);

// A planet of the stage's own needs: land at 100 m everywhere (no sea), the air a season each of 5, 15, 12 and 2 C, a rain of `rain` mm a season, and a wind of (e, n) m/s.
const planetOf = (rain: number, e: number, n: number): Planet => ({
  n: N0, radius: SMALL_RADIUS_M, height: new Float32Array(N0).fill(100),
  seasons: [5, 15, 12, 2].map((t) => ({ t: new Float32Array(N0).fill(t), rain: new Float32Array(N0).fill(rain), snow: new Float32Array(N0), runoff: new Float32Array(N0), windE: new Float32Array(N0).fill(e), windN: new Float32Array(N0).fill(n), sst: new Float32Array(N0) })),
}) as unknown as Planet;
const ctxOf = async (planet: Planet): Promise<Ctx> => ({ gpu: await theGpu(), planet, dir: null as never, tier: TIER });
const positions = (ids: Int32Array) => Array.from(ids, (id) => { const f = Math.floor(id / (FN * FN)), r = id - f * FN * FN, Y = Math.floor(r / FN); return { f, X: r - Y * FN, Y }; });
// Heights (1/256 m) as a function of the cell alone: hills of 150 m over a swell of 100 m, in metres
const hills = (ids: Int32Array) => Int32Array.from(positions(ids), ({ f, X, Y }) => Math.round((200 + 100 * Math.sin(X * 0.021 + f) * Math.cos(Y * 0.017) + 50 * Math.sin(X * 0.09 + Y * 0.07)) * 256));
// A ridge along y, 400 m high and 8 cells (600 m) wide, at face column `at`
const ridge = (at: number) => (ids: Int32Array) => Int32Array.from(positions(ids), ({ X }) => Math.round((100 + 400 * Math.exp(-(((X - at) / 8) ** 2))) * 256));
const cells = (p: Patch) => ({ x0: p.halo, S: p.side });
const interior = (p: Patch, f: ArrayLike<number>) => { const { x0, S } = cells(p), out = new Float32Array(256 * 256); for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) out[y * 256 + x] = f[(y + x0) * S + x + x0]; return out; };
const mean = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; };

// How much a field steps across the edges of the 16 by 16 blocks, as the mean of |d| between neighbouring cells across a block's edge over the mean inside blocks (1 where the
// edges are like any other place), taken over the patch's cells `margin` blocks in from its border, along x and along y.
function edgeStep(f: ArrayLike<number>, p: Patch, margin: number) {
  const S = p.side, lo = margin * 16, hi = S - margin * 16;
  let across = 0, inside = 0, na = 0, ni = 0;
  for (let y = lo; y < hi - 1; y++)
    for (let x = lo; x < hi - 1; x++) {
      const dx = Math.abs(f[y * S + x + 1] - f[y * S + x]), dy = Math.abs(f[(y + 1) * S + x] - f[y * S + x]);
      if (x % 16 === 15) { across += dx; na++; } else { inside += dx; ni++; }
      if (y % 16 === 15) { across += dy; na++; } else { inside += dy; ni++; }
    }
  return inside > 0 ? across / na / (inside / ni) : 1; // a field with no variation has no step
}

describe("the air stage on a staged planet", () => {
  test("the transforms' tables are well clear of rounding ties on the patch's grid, so an engine's last-place cosine cannot change a word", () => {
    expect(tableMargin(512)).toBeGreaterThan(1e-6);
  });
  test("the rain is never negative, every block of tier 0 keeps its planet's rain, and a ridge is wetter on its windward side than its lee", async () => {
    const ctx = await ctxOf(planetOf(300, 8, 0)), patch = patchAt(TIER, 0, 1920, 1920, AIR_HALO), cx = 1920 + 128, h = ridge(cx)(patch.ids);
    const geo = geometryOf(patch, ctx.planet.radius), smp = sampledOf(ctx, patch);
    const rain = await rainOf(ctx, patch, Float32Array.from(h, (v) => v / 256), geo, smp), S = patch.side;
    let worst = 0;
    for (let k = 0; k < 4; k++) {
      expect(rain.precip[k].every((v) => v >= 0)).toBe(true);
      // the blocks wholly in the patch: 16 by 16 cells from a multiple of 16 of the patch's own columns (the patch starts on a block)
      for (let by = 0; by < S / 16; by++) for (let bx = 0; bx < S / 16; bx++) {
        let s = 0;
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += rain.precip[k][(by * 16 + y) * S + bx * 16 + x];
        worst = Math.max(worst, Math.abs(s / 256 - 300) / 300);
      }
    }
    console.log(`the rain's block means against the planet's 300 mm: worst relative ${worst.toExponential(2)}, the wettest cell ${Math.max(...rain.precip[0]).toFixed(0)} mm`);
    for (let k = 0; k < 4; k++) expect(Math.max(...rain.precip[k])).toBeLessThanOrEqual(WORD_MAX_MM);
    expect(worst).toBeLessThan(0.01);
    const steps = [0, 1, 2, 3].map((k) => edgeStep(rain.precip[k], patch, 3));
    console.log(`staged ridge: edge-step ratio of the rain by season ${steps.map((v) => v.toFixed(3)).join(" ")}`);
    for (const v of steps) expect(v).toBeLessThan(1.5);
    // the wind blows toward east (x grows east at the centre of face 0): the windward side is x below the ridge
    const band = (from: number, to: number, k: number) => { let s = 0, c = 0; for (let y = patch.halo; y < patch.halo + 256; y++) for (let X = from; X < to; X++) { s += rain.precip[k][y * S + (X - (1920 - patch.halo))]; c++; } return s / c; };
    const windward = band(cx - 24, cx - 8, 0), lee = band(cx + 8, cx + 24, 0);
    console.log(`ridge: windward ${windward.toFixed(1)} mm, lee ${lee.toFixed(1)} mm of 300`);
    expect(windward).toBeGreaterThan(1.05 * lee);
    // a wind along the ridge (north) makes less contrast across it
    const north = await ctxOf(planetOf(300, 0, 8)), along = await rainOf(north, patch, Float32Array.from(h, (v) => v / 256), geo, sampledOf(north, patch));
    const side = (from: number, to: number) => { let s = 0, c = 0; for (let y = patch.halo; y < patch.halo + 256; y++) for (let X = from; X < to; X++) { s += along.precip[0][y * S + (X - (1920 - patch.halo))]; c++; } return s / c; };
    console.log(`wind along the ridge: west ${side(cx - 24, cx - 8).toFixed(1)} mm, east ${side(cx + 8, cx + 24).toFixed(1)} mm`);
    // and a wind the other way round (toward the west) wets the other side: the wind's direction is read in the patch's axes
    const west = await ctxOf(planetOf(300, -8, 0)), back = await rainOf(west, patch, Float32Array.from(h, (v) => v / 256), geo, sampledOf(west, patch));
    const sideBack = (from: number, to: number) => { let s = 0, c = 0; for (let y = patch.halo; y < patch.halo + 256; y++) for (let X = from; X < to; X++) { s += back.precip[0][y * S + (X - (1920 - patch.halo))]; c++; } return s / c; };
    console.log(`wind toward the west: west side ${sideBack(cx - 24, cx - 8).toFixed(1)} mm, east side ${sideBack(cx + 8, cx + 24).toFixed(1)} mm`);
    expect(sideBack(cx + 8, cx + 24)).toBeGreaterThan(1.05 * sideBack(cx - 24, cx - 8));
    // (a measured rose is not symmetric about its mean, so some contrast remains)
    expect(Math.abs(side(cx - 24, cx - 8) - side(cx + 8, cx + 24))).toBeLessThan(0.8 * (windward - lee));
  }, 120_000);

  test("the block-mean scale is read between the blocks' centres: a constant is itself, a ramp of the blocks is a ramp of the cells, and the means of a patch field are its blocks'", () => {
    const S = 64, B = 4;
    expect(Array.from(smoothBlocks(new Float64Array(B * B).fill(5), B, S)).every((v) => Math.abs(v - 5) < 1e-12)).toBe(true);
    const ramp = Float64Array.from({ length: B * B }, (_, b) => 10 + 16 * (b % B)), got = smoothBlocks(ramp, B, S);
    expect(got[5 * S + 24]).toBeCloseTo(10 + 24 - 7.5, 9);
    expect(got[5 * S + 40]).toBeCloseTo(10 + 40 - 7.5, 9);
    const f = Float64Array.from({ length: S * S }, (_, i) => (i % S >> 4) * 100 + (i % 16));
    expect(blockMeans(f, S)[2]).toBeCloseTo(200 + 7.5, 9);
  });

  test("a planet's rain of 20,000 mm a season, shared out by a mountain, holds no cell past the words, and the block keeps its rain", async () => {
    const ctx = await ctxOf(planetOf(20_000, 8, 0)), patch = patchAt(TIER, 0, 1920, 1920, AIR_HALO), h = ridge(1920 + 128)(patch.ids);
    const rain = await rainOf(ctx, patch, Float32Array.from(h, (v) => v / 256), geometryOf(patch, ctx.planet.radius), sampledOf(ctx, patch));
    for (let k = 0; k < 4; k++) {
      const top = Math.max(...rain.precip[k]);
      console.log(`season ${k}: the wettest cell ${top.toFixed(0)} mm of ${WORD_MAX_MM}`);
      expect(top).toBeLessThanOrEqual(WORD_MAX_MM * (1 + 1e-6));
    }
    const S = patch.side;
    let s = 0;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += rain.precip[0][(16 * 20 + y) * S + 16 * 20 + x];
    expect(Math.abs(s / 256 - 20_000) / 20_000).toBeLessThan(1e-5);
    // and the climate over it runs: a year of 80,000 mm is inside the snow years' words
    expect(80_000).toBeLessThan(3000 * 2 ** PATCH_SNOW_SHIFT);
    const hh = hills(patch.ids), air = await airOf(ctx, patch, hh, hh);
    expect(air.precip[0].every((v) => Number.isFinite(v))).toBe(true);
    expect(air.snowCover.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(air.saturated).toBe(0);
  }, 120_000);

  test("a run is the same twice, and what the heights alone make is the same from two patches that overlap", async () => {
    const ctx = await ctxOf(planetOf(400, 5, 3)), a = patchAt(TIER, 2, 1024, 2048, AIR_HALO), b = patchAt(TIER, 2, 1152, 2048, AIR_HALO);
    const run = (p: Patch) => { const h = hills(p.ids); return airOf(ctx, p, h, h); };
    const [a1, a2, b1] = [await run(a), await run(a), await run(b)];
    const out = (t: AirTile) => Object.values(compact(t));
    expect(hashOf(out(a1))).toBe(hashOf(out(a2)));
    // A's columns 128 to 256 of its interior are B's 0 to 128: no tile's own edge is in them
    const shared = (t: AirTile, p: Patch, f: (t: AirTile) => Float32Array, first: number) => { const S = p.side, o: number[] = []; for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) o.push(f(t)[(y + p.halo) * S + p.halo + first + x]); return o; };
    const diff = (f: (t: AirTile) => Float32Array) => { const u = shared(a1, a, f, 128), v = shared(b1, b, f, 0); let worst = 0, rms = 0; for (let i = 0; i < u.length; i++) { worst = Math.max(worst, Math.abs(u[i] - v[i])); rms += (u[i] - v[i]) ** 2; } return { worst, rms: Math.sqrt(rms / u.length) }; };
    const exact: [string, (t: AirTile) => Float32Array][] = [["sun summer", (t) => t.sun[1]], ["sun winter", (t) => t.sun[3]], ["sky", (t) => t.sky], ["pool", (t) => t.pool], ["fog", (t) => t.fog]];
    for (const [name, f] of exact) { const d = diff(f); console.log(`overlap ${name}: worst ${d.worst}`); expect(d.worst, name).toBe(0); }
    const near: [string, (t: AirTile) => Float32Array, number][] = [["temp summer", (t) => t.temp[1], 0.05], ["temp winter", (t) => t.temp[3], 0.05], ["humid", (t) => t.humid[1], 0.01], ["breeze", (t) => t.breeze, 0.5], ["salt", (t) => t.salt, 0.05]];
    for (const [name, f, tol] of near) { const d = diff(f); console.log(`overlap ${name}: worst ${d.worst.toExponential(2)}, rms ${d.rms.toExponential(2)}`); expect(d.worst, name).toBeLessThan(tol); }
    const rain = diff((t) => t.precip[0]);
    console.log(`overlap rain (spring): worst ${rain.worst.toFixed(2)} mm, rms ${rain.rms.toFixed(2)} mm of ${mean(a1.precip[0]).toFixed(0)}`);
  }, 200_000);
});

// ---------- the real planet ----------
const KEY = "883a8d9387df", BAKE = `/tmp/planet-75m/1-${KEY}`, STOREDIR = "/tmp/planet-small/store";
const REAL = existsSync(`${BAKE}/t4-height.i32`) && existsSync(`${BAKE}/t4-flooded.i32`) && existsSync(`${STOREDIR}/1-${KEY}`);
const real = REAL ? test : test.skip;
let planet: Planet | null = null;
const realCtx = async (): Promise<Ctx> => ({ gpu: await theGpu(), planet: (planet ??= await readPlanet(1, diskStore(STOREDIR, KEY))), dir: new BakeDir(BAKE), tier: TIER });
const tileOf = (k: number) => ({ face: Math.floor(k / 256), tx: k % 16, ty: Math.floor((k % 256) / 16) });
// A patch's words of a global file, read by the runs of cells that are neighbours in it (a test of a tile need not hold 400 MB of the planet)
const gatherFile = (file: string, p: Patch) => {
  const fd = openSync(file, "r"), out = new Int32Array(p.ids.length);
  try {
    for (let i = 0, j = 1; i < p.ids.length; i = j, j = i + 1) {
      while (j < p.ids.length && p.ids[j] === p.ids[j - 1] + 1) j++;
      const run = new Int32Array(j - i);
      readSync(fd, new Uint8Array(run.buffer), 0, run.byteLength, p.ids[i] * 4);
      out.set(run, i);
    }
  } finally { closeSync(fd); }
  return out;
};
const heightsAt = async (_: Ctx, p: Patch) => ({ h: gatherFile(`${BAKE}/t4-height.i32`, p), f: gatherFile(`${BAKE}/t4-flooded.i32`, p) });
// The pinned hash of tile 458's stored words (this planet's and this engine's: re-record when the air stage, the planet or the bake changes, and say so)
const PIN = { tile458: "cce96bfdfcff1a51" };

describe("the air stage on the real planet (seed 1)", () => {
  real("tile 458 (face 1, a range with land and sea): the same twice, the stored words pinned, rain kept by block, and the stored files' sizes", async () => {
    const ctx = await realCtx(), { face, tx, ty } = tileOf(458), p = patchAt(TIER, face, tx * 256, ty * 256, AIR_HALO), { h, f } = await heightsAt(ctx, p);
    const t0 = performance.now(), a = await airOf(ctx, p, h, f), s1 = (performance.now() - t0) / 1000, again = await airOf(ctx, p, h, f);
    const words = (t: AirTile) => { const c = compact(t); return AIR_OUTPUTS.map((name) => Int32Array.from(interior(p, c[name] as unknown as ArrayLike<number>))); };
    expect(hashOf(words(a))).toBe(hashOf(words(again)));
    console.log(`tile 458: ${s1.toFixed(2)} s (a patch of ${p.side} by ${p.side}), stored words hash ${hashOf(words(a))}, saturated words ${a.saturated}`);
    if (PIN.tile458) expect(hashOf(words(a))).toBe(PIN.tile458);
    // every whole block of the tile keeps the tier-0 cell's rain, to what the smooth scale's passes leave (the interpolated scale is not exactly the block's own)
    const P0 = ctx.planet.seasons.map((s) => s.rain), S = p.side;
    // (the planet's rain between its centres is not mean-keeping where it changes fast, so a block beside a much drier one is held to what a smooth scale can do)
    const errs: number[] = [];
    let mass = 0, miss = 0, got = 0;
    for (let k = 0; k < 4; k++)
      for (let by = 0; by < 16; by++) for (let bx = 0; bx < 16; bx++) {
        let sum = 0;
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) sum += a.precip[k][(p.halo + by * 16 + y) * S + p.halo + bx * 16 + x];
        const id = p.ids[(p.halo + by * 16) * S + p.halo + bx * 16], f0 = Math.floor(id / (FN * FN)), r = id - f0 * FN * FN, want = P0[k][f0 * 65536 + (Math.floor(r / FN) >> 4) * 256 + ((r % FN) >> 4)];
        mass += want; miss += Math.abs(sum / 256 - want); got += sum / 256;
        if (want >= 50) errs.push(Math.abs(sum / 256 - want) / want);
      }
    errs.sort((u, v) => u - v);
    const q = (f: number) => errs[Math.floor(f * (errs.length - 1))];
    console.log(`real tile: block means against the tier-0 rain: summed |error| over summed rain ${(miss / mass).toExponential(2)}, the tile's total ${(got / mass).toFixed(4)} of the planet's; of ${errs.length} blocks over 50 mm: median ${q(0.5).toExponential(2)}, p90 ${q(0.9).toExponential(2)}, worst ${q(1).toExponential(2)}`);
    expect(miss / mass).toBeLessThan(0.1);
    expect(Math.abs(got / mass - 1)).toBeLessThan(0.05);
    for (const k of [0, 1, 2, 3]) expect(a.precip[k].every((v) => v >= 0)).toBe(true);
    // the stored words hold what the stage made: the units' rounding is under half a unit
    const stored = compact(a), pr = stored[AIR_OUT.pr[0]] as Uint16Array;
    let off = 0;
    for (let i = 0; i < pr.length; i++) off = Math.max(off, Math.abs(precipOfWord(pr[i]) - a.precip[0][i]));
    expect(off).toBeLessThan(0.2);
    expect(a.saturated).toBe(0);
    // the three fields the page reads: wind share, fog (1/255 of 0..1) and the snowpack (1/4 mm), each the stage's word to its unit
    const wsh = stored[AIR_OUT.wsh] as Uint8Array, fog = stored[AIR_OUT.fog] as Uint8Array, snp = stored[AIR_OUT.snp[3]] as Uint16Array;
    let dw = 0, df = 0, dp = 0, packed = 0;
    for (let i = 0; i < wsh.length; i++) {
      dw = Math.max(dw, Math.abs(wsh[i] / 255 - a.windShare[i])); df = Math.max(df, Math.abs(fog[i] / 255 - a.fog[i])); dp = Math.max(dp, Math.abs(snp[i] / 4 - a.snowpack[3][i]));
      if (snp[i] > 0) packed++;
    }
    console.log(`real tile: wind share, fog and snowpack words decode to within ${dw.toExponential(1)}, ${df.toExponential(1)} and ${dp.toFixed(3)} mm; ${packed} cells hold winter snow`);
    expect(dw).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    expect(df).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    expect(dp).toBeLessThanOrEqual(0.125 + 1e-3);
    // no cell holds more than the words downstream hold, and the rain has no step at a block's edge
    for (let k = 0; k < 4; k++) expect(Math.max(...a.precip[k])).toBeLessThanOrEqual(WORD_MAX_MM);
    const steps = [0, 1, 2, 3].map((k) => edgeStep(a.precip[k], p, 3));
    console.log(`real tile: edge-step ratio of the rain (mean |d| across a block's edge over inside it), by season ${steps.map((v) => v.toFixed(3)).join(" ")}`);
    for (const v of steps) expect(v).toBeLessThan(1.5);
  }, 280_000);

  real("two patches of one tile that overlap agree: what the heights alone make exactly, the rest within what a halo cuts (measured, written as a gap in the note)", async () => {
    const ctx = await realCtx(), { face, tx, ty } = tileOf(458);
    const a = patchAt(TIER, face, tx * 256, ty * 256, AIR_HALO), b = patchAt(TIER, face, tx * 256 + 128, ty * 256, AIR_HALO);
    const [ha, hb] = [await heightsAt(ctx, a), await heightsAt(ctx, b)], [ra, rb] = [await airOf(ctx, a, ha.h, ha.f), await airOf(ctx, b, hb.h, hb.f)];
    const shared = (t: AirTile, p: Patch, f: (t: AirTile) => Float32Array, first: number) => { const S = p.side, o: number[] = []; for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) o.push(f(t)[(y + p.halo) * S + p.halo + first + x]); return o; };
    const fields: [string, (t: AirTile) => Float32Array][] = [
      ["precip spring", (t) => t.precip[0]], ["precip winter", (t) => t.precip[3]], ["pet summer", (t) => t.pet[1]], ["sun summer", (t) => t.sun[1]], ["sun winter", (t) => t.sun[3]],
      ["temp summer", (t) => t.temp[1]], ["temp winter", (t) => t.temp[3]], ["humid summer", (t) => t.humid[1]], ["snow cover", (t) => t.snowCover], ["salt", (t) => t.salt], ["breeze", (t) => t.breeze], ["sky", (t) => t.sky], ["pool", (t) => t.pool],
    ];
    const rows: Record<string, { worst: number; rms: number; scale: number }> = {};
    for (const [name, f] of fields) {
      const u = shared(ra, a, f, 128), v = shared(rb, b, f, 0), sorted = Float32Array.from(u, Math.abs).sort();
      let worst = 0, rms = 0;
      for (let i = 0; i < u.length; i++) { worst = Math.max(worst, Math.abs(u[i] - v[i])); rms += (u[i] - v[i]) ** 2; }
      rows[name] = { worst, rms: Math.sqrt(rms / u.length), scale: sorted[Math.floor(0.99 * (sorted.length - 1))] };
      console.log(`${name.padEnd(14)} worst ${worst.toExponential(2)} rms ${rows[name].rms.toExponential(2)} (the field's p99 ${rows[name].scale.toFixed(3)})`);
    }
    // what the heights alone make is the same word for word
    for (const name of ["sun summer", "sun winter", "sky", "pool"]) expect(rows[name].worst, name).toBe(0);
    // the rest: rms within a few percent of the field's p99 (the wake and the rain's tails reach past a halo)
    for (const [name, r] of Object.entries(rows)) expect(r.rms, name).toBeLessThan(0.05 * r.scale + 1e-6);
  }, 280_000);

  real("one place seen from the two faces that meet at an edge: a tile of face 0 and the tile of face 5 beside it hold the same cells in their halo and interior, and agree to the grid's own skew", async () => {
    const ctx = await realCtx(), a = patchAt(TIER, 0, 256, 0, AIR_HALO), S = a.side;
    // the tile that holds the cells across the edge from tile 1 of face 0, and its patch
    const across = a.ids[(AIR_HALO - 5) * S + AIR_HALO + 10], fb = Math.floor(across / (FN * FN)), rb = across - fb * FN * FN, Yb = Math.floor(rb / FN), Xb = rb - Yb * FN;
    const b = patchAt(TIER, fb, (Xb >> 8) * 256, (Yb >> 8) * 256, AIR_HALO), at = new Map<number, number>();
    for (let i = 0; i < b.ids.length; i++) if (!b.missing[i]) at.set(b.ids[i], i);
    const [ha, hb] = [await heightsAt(ctx, a), await heightsAt(ctx, b)], [ra, rb2] = [await airOf(ctx, a, ha.h, ha.f), await airOf(ctx, b, hb.h, hb.f)];
    // cells of a's interior at most 16 rows from the face's edge (112 or more from the edge of b's patch where the sun's horizons are whole)
    const pairs: [number, number][] = [];
    for (let y = AIR_HALO; y < AIR_HALO + 16; y++) for (let x = AIR_HALO; x < AIR_HALO + 256; x++) { const j = at.get(a.ids[y * S + x]); if (j !== undefined) pairs.push([y * S + x, j]); }
    console.log(`face 0 tile 1 and face ${fb} tile (${Xb >> 8}, ${Yb >> 8}): ${pairs.length} cells in both`);
    expect(pairs.length).toBeGreaterThan(2000);
    const fields: [string, (t: AirTile) => Float32Array][] = [["sun summer", (t) => t.sun[1]], ["sun winter", (t) => t.sun[3]], ["temp summer", (t) => t.temp[1]], ["temp winter", (t) => t.temp[3]], ["sky", (t) => t.sky], ["pool", (t) => t.pool], ["breeze", (t) => t.breeze], ["precip spring", (t) => t.precip[0]]];
    const rows: Record<string, { rms: number; worst: number; scale: number }> = {};
    for (const [name, f] of fields) {
      const u = f(ra), v = f(rb2), scale = mean(pairs.map(([i]) => Math.abs(u[i])));
      let rms = 0, worst = 0;
      for (const [i, j] of pairs) { rms += (u[i] - v[j]) ** 2; worst = Math.max(worst, Math.abs(u[i] - v[j])); }
      rows[name] = { rms: Math.sqrt(rms / pairs.length), worst, scale };
      console.log(`${name.padEnd(14)} rms ${rows[name].rms.toExponential(2)} worst ${worst.toExponential(2)} of a mean ${scale.toFixed(3)}`);
    }
    // the same cells, laid out by two sets of axes: the kernels read an index grid as a square one, so a skewed grid reads slopes and bearings a little differently
    expect(rows["sun summer"].rms).toBeLessThan(0.1 * rows["sun summer"].scale);
    expect(rows["temp summer"].rms).toBeLessThan(0.5);
  }, 280_000);

  real("the stage over a handful of real tiles, in two calls that resume, writes the same bytes as one call", async () => {
    const ctx = await realCtx(), tiles = [458, 1, 14], work = "/tmp/planet-75m/air-scratch/stage", one = `${work}-one`;
    for (const d of [work, one]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); for (const f of airStage.inputs) linkSync(`${BAKE}/${f}`, `${d}/${f}`); }
    const split = { ...ctx, dir: new BakeDir(work) }, whole = { ...ctx, dir: new BakeDir(one) };
    try {
      const p1 = await runTiles(split, airStage, 1e9, () => {}, [458]);
      expect(p1.tiles).toBe(1);
      const p2 = await runTiles(split, airStage, 1e9, () => {}, tiles);
      expect(p2.tileS.length).toBe(2); // the first was kept
      console.log(`runTiles: tile 458 ${p1.tileS[0].toFixed(2)} s, then tiles 1 and 14 ${p2.tileS.map((v) => v.toFixed(2)).join(" and ")} s (the inputs' two 400 MB files are read once for the process, in the first)`);
      expect(p2.done).toBe(true);
      await runTiles(whole, airStage, 1e9, () => {}, tiles);
      const cellsAt = (tile: number) => { const { face, tx, ty } = tileOf(tile); return Array.from({ length: 256 }, (_, y) => (face * FN + ty * 256 + y) * FN + tx * 256); };
      for (const name of AIR_OUTPUTS) {
        const A = new (name.endsWith(".u8") ? Uint8Array : Uint16Array)(split.dir.raw(name)), B = new (name.endsWith(".u8") ? Uint8Array : Uint16Array)(whole.dir.raw(name));
        for (const t of tiles) for (const row of cellsAt(t)) for (let x = 0; x < 256; x++) if (A[row + x] !== B[row + x]) throw new Error(`${name}: tile ${t} differs`);
      }
      // a tile never made stays zero, a made one holds the stage's words
      const sun = new Uint16Array(split.dir.raw("t4-sun1.u16"));
      expect(sun[cellsAt(458)[10] + 10]).toBeGreaterThan(0);
      expect(sun[cellsAt(15)[10] + 10]).toBe(0);
    } finally { rmSync(work, { recursive: true, force: true }); rmSync(one, { recursive: true, force: true }); }
  }, 280_000);
});
