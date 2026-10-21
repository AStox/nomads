// The air stage (air.ts): the island's rain and climate on a patch of the 75 m tier, as one solve: a cell's stored words are the same under any tiling. Each case alone:
//   bun test ./src/gpu/globe/air.test.ts -t "<name>" --timeout 280000
// The cases on a staged planet (a synthetic tier 0 whose air varies smoothly with the cell, heights that are a function of the cell id) say what must hold anywhere: the rain is
// never negative, windward slopes are wetter than lee ones, a run is the same twice and, the heart of the unit, every stored file is the SAME BYTES in the cells two patches share
// (patches at other offsets and with other halos). The cases on the real planet (the bake of seed 1 under /tmp/planet-75m, skipped where it is not) say it of real tiles (458, 1, 14,
// 17; tiles 1, 14 and 17 lie on face 0's edge against face 5), pin tile 458, measure the same place seen from two faces, and run the stage over a handful of tiles in two calls.
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { releaseGpu, theGpu } from "../device";
import { SMALL_RADIUS_M } from "./grid";
import { patchAt, type Patch } from "./patch";
import { tableMargin } from "../terrain/rain";
import { AIR_HALO, AIR_OUT, AIR_OUTPUTS, WORD_MAX_MM, airOf, airStage, bgField, compact, geometryOf, neighbours0, precipOfWord, rainOf, sampleFast, sampledOf, type AirTile } from "./air";
import { sampleCoarse } from "./sample";
import { eastNorth, pointOf, tierGrid } from "./grid";
import { runTiles, type Ctx } from "./stages";
import { BakeDir } from "./tiers";
import { readPlanet, type Planet } from "./window";
import { diskStore } from "../../../scripts/globe-window";

afterAll(releaseGpu);
const N0 = 6 * 256 * 256, FN = 4096, TIER = 4;
const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const hashOf = (arrays: ArrayBufferView[]) => Bun.hash(Buffer.concat(arrays.map(bytes))).toString(16);

// A planet of the stage's own needs: land at 100 m everywhere but a stripe of sea, an air, rain and wind that vary smoothly from cell to cell (a function of the cell's index
// alone), and the rain of the first season a given mm a season.
const planetOf = (rain: number, e: number, n: number): Planet => {
  const field = (f: (i: number) => number) => Float32Array.from({ length: N0 }, (_, i) => f(i));
  const stripe = (i: number) => { const t = i % 65536, X = t % 256; return Math.floor(i / 65536) === 2 && X >= 69 && X <= 70; };
  return {
    n: N0, radius: SMALL_RADIUS_M, height: field((i) => (stripe(i) ? -50 : 100)),
    seasons: [5, 15, 12, 2].map((t, k) => ({
      t: field((i) => t + 3 * Math.sin(i * 0.0013 + k)), rain: field((i) => rain * (1 + 0.5 * Math.sin(i * 0.0021 + k))), snow: new Float32Array(N0), runoff: new Float32Array(N0),
      windE: field((i) => e + 1.5 * Math.sin(i * 0.0017)), windN: field((i) => n + 1.5 * Math.cos(i * 0.0011)), sst: field((i) => t + 1 + Math.sin(i * 0.0007)),
    })),
  } as unknown as Planet;
};
const ctxOf = async (planet: Planet): Promise<Ctx> => ({ gpu: await theGpu(), planet, dir: null as never, tier: TIER });
const positions = (ids: Int32Array) => Array.from(ids, (id) => { const f = Math.floor(id / (FN * FN)), r = id - f * FN * FN, Y = Math.floor(r / FN); return { f, X: r - Y * FN, Y }; });
// Heights (1/256 m) as a function of the cell alone: hills of 150 m over a swell of 100 m, in metres
const hills = (ids: Int32Array) => Int32Array.from(positions(ids), ({ f, X, Y }) => Math.round((200 + 100 * Math.sin(X * 0.021 + f) * Math.cos(Y * 0.017) + 50 * Math.sin(X * 0.09 + Y * 0.07)) * 256));
// A ridge along y, 400 m high and 8 cells (600 m) wide, at face column `at`: below a tier-0 cell, so the planet's own surface (and rain) does not hold it
const ridge = (at: number) => (ids: Int32Array) => Int32Array.from(positions(ids), ({ X }) => Math.round((100 + 400 * Math.exp(-(((X - at) / 8) ** 2))) * 256));
const mean = (xs: ArrayLike<number>) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; };

// How much a field steps across the edges of the 16 by 16 blocks, as the mean of |d| between neighbouring cells across a block's edge over the mean inside blocks (1 where the
// edges are like any other place), over the patch's cells `margin` blocks in from its border, along x and along y. The patch starts on a block.
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

// The cells two patches of one face both hold in their interiors, and how many of each stored file's words in them differ (the words are compact()'s, the file's own).
function compare(pa: Patch, a: AirTile, pb: Patch, b: AirTile) {
  const wa = compact(a), wb = compact(b), Sa = pa.side, Sb = pb.side, Xa = pa.x0 - pa.halo, Ya = pa.y0 - pa.halo, Xb = pb.x0 - pb.halo, Yb = pb.y0 - pb.halo;
  if (pa.face !== pb.face) throw new Error("compare: patches of one face");
  const x0 = Math.max(pa.x0, pb.x0), x1 = Math.min(pa.x0, pb.x0) + 256 + Math.abs(pa.x0 - pb.x0) - Math.abs(pa.x0 - pb.x0), y0 = Math.max(pa.y0, pb.y0);
  void x1;
  const xEnd = Math.min(pa.x0 + 256, pb.x0 + 256), yEnd = Math.min(pa.y0 + 256, pb.y0 + 256), differing: Record<string, number> = {};
  let cells = 0;
  for (const name of AIR_OUTPUTS) differing[name] = 0;
  for (let Y = y0; Y < yEnd; Y++)
    for (let X = x0; X < xEnd; X++) {
      cells++;
      const ia = (Y - Ya) * Sa + X - Xa, ib = (Y - Yb) * Sb + X - Xb;
      for (const name of AIR_OUTPUTS) if ((wa[name] as ArrayLike<number>)[ia] !== (wb[name] as ArrayLike<number>)[ib]) differing[name]++;
    }
  return { cells, differing };
}

describe("the air stage on a staged planet", () => {
  test("the transforms' tables are well clear of rounding ties on the patch's grid, so an engine's last-place cosine cannot change a word", () => {
    expect(tableMargin(512)).toBeGreaterThan(1e-6);
  });

  test("the planet's rain made mean-keeping: the 256 children of a tier-0 cell, read by sampleCoarse, average to the cell's own rain (also at face edges and cube corners)", () => {
    const g0 = tierGrid(0), nb = neighbours0(), p0 = Float32Array.from({ length: N0 }, (_, i) => { const f = Math.floor(i / 65536), Y = Math.floor((i % 65536) / 256), X = i % 256; return 300 + 150 * Math.sin(X * 0.1 + f) * Math.cos(Y * 0.13 + 2 * f); });
    const q = bgField(p0, nb);
    let worst = 0;
    const corner = (f: number, X: number, Y: number) => (f * 256 + Y) * 256 + X;
    for (const b of [corner(0, 0, 0), corner(0, 255, 0), corner(1, 255, 255), corner(2, 0, 255), corner(3, 128, 0), corner(4, 255, 128), corner(5, 7, 250), corner(0, 100, 100), corner(2, 30, 200)]) {
      const f = Math.floor(b / 65536), py = Math.floor((b % 65536) / 256), px = b % 256, ids = new Int32Array(256);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) ids[y * 16 + x] = (f * FN + py * 16 + y) * FN + px * 16 + x;
      worst = Math.max(worst, Math.abs(mean(sampleCoarse(TIER, ids, [q])[0]) - p0[b]) / p0[b]);
    }
    console.log(`the mean-keeping rain: worst relative error of a block's mean ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-4);
    expect(g0.fn).toBe(256);
  });

  test("the faster sampler gives the floats sampleCoarse gives, over a patch across a face's edge and a cube's corner", () => {
    const patch = patchAt(TIER, 0, 0, 0, 64), a = Float32Array.from({ length: N0 }, (_, i) => Math.sin(i * 0.002) * 100), b = Float32Array.from({ length: N0 }, (_, i) => (i % 977) * 0.5);
    const fast = sampleFast(TIER, patch.ids, [a, b]), slow = sampleCoarse(TIER, patch.ids, [a, b]);
    expect(hashOf(fast)).toBe(hashOf(slow));
  });

  test("a cell's lattice metric: a step of the lattice offsets toward east reaches 75 m east and none north, at a face's middle and in a corner tile where the axes are 27 degrees off square", () => {
    const g = tierGrid(TIER);
    for (const [x0, y0] of [[1920, 1920], [3840, 3840]]) {
      const patch = patchAt(TIER, 0, x0, y0, 16), geo = geometryOf(patch, SMALL_RADIUS_M), S = patch.side;
      const at = (i: number) => { const id = patch.ids[i], f = Math.floor(id / (FN * FN)), r = id - f * FN * FN, Y = Math.floor(r / FN); return pointOf(f, g.mid[r - Y * FN], g.mid[Y]); };
      let skew = 0, worst = 0;
      for (const [x, y] of [[40, 40], [100, 150], [200, 60], [30, 220]]) {
        const i = y * S + x, p = at(i), [e, n] = eastNorth(p), px = at(i + 1), mx = at(i - 1), py = at(i + S), my = at(i - S);
        const m = [0, 1, 2, 3].map((k) => geo.gm[4 * i + k] / 65536), sx = m[0] * 1 + m[2] * 0, sy = m[1] * 1 + m[3] * 0;
        const d = [0, 1, 2].map((a) => ((sx * (px[a] - mx[a])) / 2 + (sy * (py[a] - my[a])) / 2) * SMALL_RADIUS_M), dot = (v: number[], w: readonly number[]) => v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
        worst = Math.max(worst, Math.abs(dot(d, e) - 75) / 75, Math.abs(dot(d, n)) / 75);
        skew = Math.max(skew, Math.abs(geo.skewDeg[i]));
      }
      console.log(`lattice at (${x0}, ${y0}): the largest error of an east step ${worst.toExponential(2)}, the axes' skew up to ${skew.toFixed(1)} degrees`);
      expect(worst).toBeLessThan(0.02);
    }
  });

  test("the rain is never negative; a ridge below a tier-0 cell lifts the air on its windward side and dries it on its lee, the other way for the other wind; the rain has no step at a block's edge", async () => {
    const ctx = await ctxOf(planetOf(300, 8, 0)), patch = patchAt(TIER, 0, 1920, 1920, AIR_HALO), cx = 1920 + 128, h = ridge(cx)(patch.ids);
    const rain = await rainOf(ctx, patch, Float32Array.from(h, (v) => v / 256), geometryOf(patch, ctx.planet.radius), sampledOf(ctx, patch)), S = patch.side;
    for (let k = 0; k < 4; k++) expect(rain.precip[k].every((v) => v >= 0)).toBe(true);
    const band = (r: Float32Array[], from: number, to: number, k: number) => { let s = 0, c = 0; for (let y = patch.halo; y < patch.halo + 256; y++) for (let X = from; X < to; X++) { s += r[k][y * S + (X - (1920 - patch.halo))]; c++; } return s / c; };
    // the orographic part (the waves' rain before the block's mean is taken out): up the windward slope, down the lee
    const windward = band(rain.oro, cx - 28, cx - 8, 0), lee = band(rain.oro, cx + 8, cx + 28, 0);
    console.log(`ridge, the wind toward the east: the orographic part windward ${windward.toFixed(1)} mm, lee ${lee.toFixed(1)} mm`);
    expect(windward).toBeGreaterThan(0);
    expect(lee).toBeLessThan(0);
    const west = await ctxOf(planetOf(300, -8, 0)), back = await rainOf(west, patch, Float32Array.from(h, (v) => v / 256), geometryOf(patch, west.planet.radius), sampledOf(west, patch));
    console.log(`ridge, the wind toward the west: the orographic part on the west side ${band(back.oro, cx - 28, cx - 8, 0).toFixed(1)} mm, east side ${band(back.oro, cx + 8, cx + 28, 0).toFixed(1)} mm`);
    expect(band(back.oro, cx + 8, cx + 28, 0)).toBeGreaterThan(0);
    expect(band(back.oro, cx - 28, cx - 8, 0)).toBeLessThan(0);
    // a block's mean is its tier-0 cell's rain where the cut at none does not bite; report where it does
    let worst = 0;
    const t0 = ctx.planet.seasons[0].rain;
    for (let by = 8; by < S / 16 - 8; by++) for (let bx = 8; bx < S / 16 - 8; bx++) {
      let s = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += rain.precip[0][(by * 16 + y) * S + bx * 16 + x];
      const id = patch.ids[by * 16 * S + bx * 16], f0 = Math.floor(id / (FN * FN)), r = id - f0 * FN * FN;
      worst = Math.max(worst, Math.abs(s / 256 - t0[f0 * 65536 + (Math.floor(r / FN) >> 4) * 256 + ((r % FN) >> 4)]) / 300);
    }
    console.log(`ridge: block means against the tier-0 rain, worst ${worst.toExponential(2)} of 300 mm`);
    const steps = [0, 1, 2, 3].map((k) => edgeStep(rain.precip[k], patch, 3));
    console.log(`ridge: edge-step ratio by season ${steps.map((v) => v.toFixed(3)).join(" ")}`);
    for (const v of steps) expect(v).toBeLessThan(1.5);
  }, 120_000);

  test("every stored file is the same bytes in the cells that two patches share: patches at other offsets, other halos, a second run", async () => {
    const ctx = await ctxOf(planetOf(400, 5, 3)), base = patchAt(TIER, 2, 1024, 2048, AIR_HALO);
    const run = async (p: Patch) => { const h = hills(p.ids); return airOf(ctx, p, h, h); };
    const a = await run(base);
    const again = await run(base);
    const wa = compact(a), wb = compact(again);
    expect(hashOf(AIR_OUTPUTS.map((n) => wa[n] as ArrayBufferView))).toBe(hashOf(AIR_OUTPUTS.map((n) => wb[n] as ArrayBufferView)));
    for (const [label, p] of [["shifted 16 east", patchAt(TIER, 2, 1040, 2048, AIR_HALO)], ["shifted 100 east, 36 north", patchAt(TIER, 2, 1124, 2084, AIR_HALO)], ["shifted 128 east and north", patchAt(TIER, 2, 1152, 2176, AIR_HALO)], ["halo 352", patchAt(TIER, 2, 1024, 2048, 352)], ["shifted 100 west, halo 336", patchAt(TIER, 2, 924, 2048, 336)]] as const) {
      const c = compare(base, a, p, await run(p)), bad = Object.entries(c.differing).filter(([, v]) => v > 0);
      console.log(`${label}: ${c.cells} shared cells, ${bad.length ? bad.map(([n, v]) => `${n} ${v}`).join(", ") : "every stored word equal"}`);
      expect(c.cells).toBeGreaterThan(10_000);
      expect(bad).toEqual([]);
    }
  }, 250_000);
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
const heightsAt = (p: Patch) => ({ h: gatherFile(`${BAKE}/t4-height.i32`, p), f: gatherFile(`${BAKE}/t4-flooded.i32`, p) });
// The pinned hash of tile 458's stored words (this planet's and this engine's: re-record when the air stage, the planet or the bake changes, and say so)
const PIN = { tile458: "" };

describe("the air stage on the real planet (seed 1)", () => {
  real("tile 458 (face 1, a range with land and sea): the same twice, the stored words pinned, no word saturates, the rain smooth and its extremes", async () => {
    const ctx = await realCtx(), { face, tx, ty } = tileOf(458), p = patchAt(TIER, face, tx * 256, ty * 256, AIR_HALO), { h, f } = heightsAt(p);
    const t0 = performance.now(), a = await airOf(ctx, p, h, f), s1 = (performance.now() - t0) / 1000, again = await airOf(ctx, p, h, f);
    const stored = compact(a), interior = (field: ArrayLike<number>) => { const out = new Int32Array(256 * 256); for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) out[y * 256 + x] = field[(y + p.halo) * p.side + x + p.halo]; return out; };
    const words = AIR_OUTPUTS.map((name) => interior(stored[name] as unknown as ArrayLike<number>));
    const wordsAgain = AIR_OUTPUTS.map((name) => interior(compact(again)[name] as unknown as ArrayLike<number>));
    expect(hashOf(words)).toBe(hashOf(wordsAgain));
    console.log(`tile 458: ${s1.toFixed(2)} s (a patch of ${p.side} by ${p.side}), stored words hash ${hashOf(words)}, saturated words ${a.saturated}`);
    if (PIN.tile458) expect(hashOf(words)).toBe(PIN.tile458);
    expect(a.saturated).toBe(0);
    for (const k of [0, 1, 2, 3]) expect(a.precip[k].every((v) => v >= 0)).toBe(true);
    // the rain's extremes against the planet's own, and the blocks' means
    const P0 = ctx.planet.seasons.map((s) => s.rain), S = p.side, top = (x: Float32Array) => x.reduce((m, v) => Math.max(m, v), 0);
    console.log(`real tile: the wettest cell of each season ${a.precip.map((x) => top(x).toFixed(0)).join(" ")} mm, the planet's wettest tier-0 cell ${P0.map((x) => top(x).toFixed(0)).join(" ")} mm`);
    for (const k of [0, 1, 2, 3]) expect(top(a.precip[k])).toBeLessThan(WORD_MAX_MM);
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
    const q = (fr: number) => errs[Math.floor(fr * (errs.length - 1))];
    console.log(`real tile: block means against the tier-0 rain: summed |error| over summed rain ${(miss / mass).toExponential(2)}, the tile's total ${(got / mass).toFixed(4)} of the planet's; of ${errs.length} blocks over 50 mm: median ${q(0.5).toExponential(2)}, p90 ${q(0.9).toExponential(2)}, worst ${q(1).toExponential(2)}`);
    const steps = [0, 1, 2, 3].map((k) => edgeStep(a.precip[k], p, 3));
    console.log(`real tile: edge-step ratio of the rain by season ${steps.map((v) => v.toFixed(3)).join(" ")}`);
    for (const v of steps) expect(v).toBeLessThan(1.5);
    // the stored words hold what the stage made to their units
    const pr = stored[AIR_OUT.pr[0]] as Uint16Array;
    let off = 0;
    for (let i = 0; i < pr.length; i++) off = Math.max(off, Math.abs(precipOfWord(pr[i]) - a.precip[0][i]) / Math.max(1, a.precip[0][i]));
    expect(off).toBeLessThan(0.01);
    const wsh = stored[AIR_OUT.wsh] as Uint8Array, fog = stored[AIR_OUT.fog] as Uint8Array, snp = stored[AIR_OUT.snp[3]] as Uint16Array;
    let dw = 0, df = 0, dp = 0;
    for (let i = 0; i < wsh.length; i++) { dw = Math.max(dw, Math.abs(wsh[i] / 255 - a.windShare[i])); df = Math.max(df, Math.abs(fog[i] / 255 - a.fog[i])); dp = Math.max(dp, Math.abs(snp[i] / 4 - a.snowpack[3][i])); }
    expect(dw).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    expect(df).toBeLessThanOrEqual(0.5 / 255 + 1e-6);
    expect(dp).toBeLessThanOrEqual(0.125 + 1e-3);
  }, 280_000);

  real("tiles 458, 1, 14 and 17 under other tilings: every stored file is the same bytes in the cells two patches share", async () => {
    const ctx = await realCtx();
    for (const [tile, others] of [[458, [[16, 0, AIR_HALO], [100, 36, AIR_HALO], [128, 128, AIR_HALO], [0, 0, 352]]], [1, [[100, 0, AIR_HALO], [0, 100, 336]]], [14, [[-100, 100, AIR_HALO]]], [17, [[100, 100, 352]]]] as const) {
      const { face, tx, ty } = tileOf(tile), base = patchAt(TIER, face, tx * 256, ty * 256, AIR_HALO), run = async (p: Patch) => { const { h, f } = heightsAt(p); return airOf(ctx, p, h, f); };
      const a = await run(base);
      for (const [dx, dy, halo] of others) {
        const p = patchAt(TIER, face, tx * 256 + dx, ty * 256 + dy, halo), c = compare(base, a, p, await run(p)), bad = Object.entries(c.differing).filter(([, v]) => v > 0);
        console.log(`tile ${tile} against a patch shifted (${dx}, ${dy}) with halo ${halo}: ${c.cells} shared cells, ${bad.length ? bad.map(([n, v]) => `${n} ${v}`).join(", ") : "every stored word equal"}`);
        expect(bad).toEqual([]);
      }
    }
  }, 290_000);

  real("one place seen from the two faces that meet at an edge: a tile of face 0 and the tile of face 5 beside it hold the same cells in their halo and interior; the lattices differ, so the sun is reported", async () => {
    const ctx = await realCtx(), a = patchAt(TIER, 0, 256, 0, AIR_HALO), S = a.side;
    // the tile that holds the cells across the edge from tile 1 of face 0, and its patch
    const across = a.ids[(AIR_HALO - 5) * S + AIR_HALO + 10], fb = Math.floor(across / (FN * FN)), rb = across - fb * FN * FN, Yb = Math.floor(rb / FN), Xb = rb - Yb * FN;
    const b = patchAt(TIER, fb, (Xb >> 8) * 256, (Yb >> 8) * 256, AIR_HALO), at = new Map<number, number>();
    for (let i = 0; i < b.ids.length; i++) if (!b.missing[i]) at.set(b.ids[i], i);
    const [ha, hb] = [heightsAt(a), heightsAt(b)], [ra, rb2] = [await airOf(ctx, a, ha.h, ha.f), await airOf(ctx, b, hb.h, hb.f)];
    const pairs: [number, number][] = [];
    for (let y = AIR_HALO; y < AIR_HALO + 16; y++) for (let x = AIR_HALO; x < AIR_HALO + 256; x++) { const j = at.get(a.ids[y * S + x]); if (j !== undefined) pairs.push([y * S + x, j]); }
    console.log(`face 0 tile 1 and face ${fb} tile (${Xb >> 8}, ${Yb >> 8}): ${pairs.length} cells in both`);
    expect(pairs.length).toBeGreaterThan(2000);
    const fields: [string, (t: AirTile) => Float32Array][] = [["sun summer", (t) => t.sun[1]], ["sun winter", (t) => t.sun[3]], ["temp summer", (t) => t.temp[1]], ["temp winter", (t) => t.temp[3]], ["sky", (t) => t.sky], ["pool", (t) => t.pool], ["breeze", (t) => t.breeze], ["precip spring", (t) => t.precip[0]], ["precip autumn", (t) => t.precip[2]]];
    const rows: Record<string, { rms: number; worst: number; scale: number; equal: number }> = {};
    for (const [name, f] of fields) {
      const u = f(ra), v = f(rb2), scale = mean(pairs.map(([i]) => Math.abs(u[i])));
      let rms = 0, worst = 0, equal = 0;
      for (const [i, j] of pairs) { rms += (u[i] - v[j]) ** 2; worst = Math.max(worst, Math.abs(u[i] - v[j])); if (u[i] === v[j]) equal++; }
      rows[name] = { rms: Math.sqrt(rms / pairs.length), worst, scale, equal };
      console.log(`${name.padEnd(14)} rms ${rows[name].rms.toExponential(2)} worst ${worst.toExponential(2)} of a mean ${scale.toFixed(3)}, ${equal} of ${pairs.length} cells equal`);
    }
    console.log(`face edge: the sun's rms difference is ${((100 * rows["sun summer"].rms) / rows["sun summer"].scale).toFixed(1)}% of its mean in summer and ${((100 * rows["sun winter"].rms) / rows["sun winter"].scale).toFixed(1)}% in winter`);
    expect(rows["sky"].rms).toBeLessThan(0.01);
    expect(rows["temp summer"].rms).toBeLessThan(0.5);
    expect(rows["temp winter"].rms).toBeLessThan(0.5);
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
      expect(p2.done).toBe(true);
      await runTiles(whole, airStage, 1e9, () => {}, tiles);
      console.log(`runTiles: tile 458 ${p1.tileS[0].toFixed(2)} s, then tiles 1 and 14 ${p2.tileS.map((v) => v.toFixed(2)).join(" and ")} s`);
      const cellsAt = (tile: number) => { const { face, tx, ty } = tileOf(tile); return Array.from({ length: 256 }, (_, y) => (face * FN + ty * 256 + y) * FN + tx * 256); };
      for (const name of AIR_OUTPUTS) {
        const A = new (name.endsWith(".u8") ? Uint8Array : Uint16Array)(split.dir.raw(name)), B = new (name.endsWith(".u8") ? Uint8Array : Uint16Array)(whole.dir.raw(name));
        for (const t of tiles) for (const row of cellsAt(t)) for (let x = 0; x < 256; x++) if (A[row + x] !== B[row + x]) throw new Error(`${name}: tile ${t} differs`);
      }
      const sun = new Uint16Array(split.dir.raw("t4-sun1.u16"));
      expect(sun[cellsAt(458)[10] + 10]).toBeGreaterThan(0);
      expect(sun[cellsAt(15)[10] + 10]).toBe(0);
    } finally { rmSync(work, { recursive: true, force: true }); rmSync(one, { recursive: true, force: true }); }
  }, 280_000);
});
