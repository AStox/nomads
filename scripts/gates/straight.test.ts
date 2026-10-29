// The straight-coast, straight-lake and thin-spit gates against inputs with a known answer (CPU only): a square island, a disc, a square rotated 20 degrees, a thin N-S spit, a lake strip.
import { describe, expect, test } from "bun:test";
import { coastTeeth, crop, edgePhase, exactRuns, floodLakes, lakeMeasures, patchShapes, shoreChains, spitMeasures, straightMeasures } from "./straight";

const CELL = 75;
// heights in 1/256 m from a function of the cell (metres)
function field(side: number, f: (x: number, y: number) => number): Int32Array {
  const h = new Int32Array(side * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) h[y * side + x] = Math.round(256 * f(x, y));
  return h;
}
const run = (h: Int32Array, side: number) => straightMeasures({ h, size: side, cellM: CELL, margin: 0 });

describe("straight coast", () => {
  test("a square island's coast is all axis-aligned runs, none along the control directions", () => {
    const side = 512, r = run(field(side, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 400 ? 50 : -50)), side);
    expect(r.coast.cells).toBe(4 * 300 - 4);
    expect(r.coast.chains).toBe(1);
    expect(r.coast.axis.L128).toBeGreaterThan(0.99); expect(r.coast.axis.L16).toBe(1);
    expect(r.rot!.coast.axis.L64).toBeLessThan(0.1); expect(r.rot!.coast.axisOverRotated.L64 === null || r.rot!.coast.axisOverRotated.L64 > 10).toBe(true);
    expect(r.coast.ctrl.L16).toBeLessThan(0.05); expect(r.coast.ctrl20.L32).toBeLessThan(0.05);
    expect(r.coast.diag.L16).toBeLessThan(0.05);
    expect(r.coast.longestKm.axis).toBeCloseTo((300 * CELL) / 1000, 3); expect(r.coast.longestKm.ctrl).toBeLessThan(0.5);
    expect(r.coast.ratio.L64).toBeNull();
  });
  test("a disc has the raster's bias but no lattice structure: its turned copy has the same axis shares", () => {
    const side = 512, r = run(field(side, (x, y) => (Math.hypot(x - 256, y - 256) < 150 ? 50 : -50)), side);
    // the raster's own bias: runs along a row cost no stair jitter, runs at 20 degrees do, so ctrl sits under axis; the turned disc pays the same bias and the ratio is near 1
    expect(r.coast.axis.L16).toBeGreaterThan(0.1); expect(r.coast.ctrl.L16).toBeGreaterThan(0.05); expect(r.coast.ctrl.L16).toBeLessThan(r.coast.axis.L16);
    expect(r.coast.ctrl.L64).toBe(0); expect(r.coast.diag.L64).toBe(0);
    expect(r.rot!.coast.axisOverRotated.L16!).toBeGreaterThan(0.7); expect(r.rot!.coast.axisOverRotated.L16!).toBeLessThan(1.4);
  });
  test("a square rotated 20 degrees is a control-direction coast, not an axis one", () => {
    const side = 600, t = (20 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const r = run(field(side, (x, y) => { const u = (x - 300) * c + (y - 300) * s, v = -(x - 300) * s + (y - 300) * c; return Math.abs(u) < 140 && Math.abs(v) < 140 ? 50 : -50; }), side);
    // two of its four sides run at 20 degrees (ctrl20), the other two at 110 (the same pair)
    expect(r.coast.ctrl20.L64).toBeGreaterThan(0.45); expect(r.coast.ctrl20.L64).toBeLessThan(0.55); expect(r.coast.ctrl.L64).toBeGreaterThan(0.45);
    expect(r.coast.axis.L32).toBeLessThan(0.1); expect(r.coast.diag.L32).toBeLessThan(0.1);
    expect(r.coast.longestKm.ctrl).toBeGreaterThan((250 * CELL) / 1000);
  });
  test("a square at 22.5 degrees is straight along the axes of the turned block, and the ratio of the block's axis share to the turned one's is under 0.1", () => {
    const side = 600, t = (22.5 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const r = run(field(side, (x, y) => { const u = (x - 300) * c + (y - 300) * s, v = -(x - 300) * s + (y - 300) * c; return Math.abs(u) < 140 && Math.abs(v) < 140 ? 50 : -50; }), side);
    expect(r.coast.axis.L64).toBeLessThan(0.05); expect(r.rot!.coast.axis.L64).toBeGreaterThan(0.35); expect(r.rot!.coast.axisOverRotated.L64!).toBeLessThan(0.1);
  });
  test("edge phase: a square's edges at 100 and 400 lie on multiples of 2 and 4 (both), 8 and 16 (400 only), and a shift of the origin moves them", () => {
    const side = 512, mask = Uint8Array.from(field(side, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 400 ? 50 : -50)), (v) => (v > 0 ? 0 : 1)), p = edgePhase(mask, side, 0, 0);
    expect(p.edges.x).toBe(600); expect(p.x.slice(0, 5)).toEqual([1, 1, 0.5, 0.5, 0]); expect(p.y.slice(0, 5)).toEqual([1, 1, 0.5, 0.5, 0]);
    expect(edgePhase(mask, side, 1, 0).x[0]).toBe(0); expect(edgePhase(mask, side, 0, 4).y.slice(0, 3)).toEqual([1, 1, 0.5]);
  });
  test("exact runs: a square's four sides are four runs of 300; a disc has none of 64", () => {
    const side = 512, sq = Uint8Array.from(field(side, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 400 ? 50 : -50)), (v) => (v > 0 ? 0 : 1)), r = exactRuns(sq, side, 0, 0, CELL);
    expect(r.edges).toBe(1200); expect(r.share.L128).toBe(1); expect(r.top.length).toBe(4); expect(r.top[0].len).toBe(300); expect(r.longestKm).toBeCloseTo(22.5, 3);
    expect(r.top.map((t) => t.line).sort()).toEqual([100, 100, 400, 400]);
    const disc = Uint8Array.from(field(side, (x, y) => (Math.hypot(x - 256, y - 256) < 200 ? 50 : -50)), (v) => (v > 0 ? 0 : 1));
    expect(exactRuns(disc, side, 0, 0, CELL).share.L64).toBe(0);
  });
  test("a coast cut by the block's edge is an open chain, and the margin cuts it off", () => {
    const side = 256, h = field(side, (x) => (x < 128 ? 50 : -50)), r = run(h, side);
    expect(r.coast.chains).toBe(1); expect(r.coast.cells).toBe(256); expect(r.coast.axis.L128).toBe(1);
    const m = straightMeasures({ h, size: side, cellM: CELL, margin: 64 });
    expect(m.size).toBe(128); expect(m.coast.cells).toBe(128);
  });
  test("two islands are two chains, one open and one closed, and the walk visits each coast cell once", () => {
    const side = 128, h = field(side, (x, y) => ((x < 40 && y < 40) || (x >= 70 && x < 100 && y >= 70 && y < 100) ? 10 : -10));
    const inside = Uint8Array.from(h, (v) => (v > 0 ? 1 : 0)), water = Uint8Array.from(inside, (v) => 1 - v), ch = shoreChains(inside, water, side);
    expect(ch.seq.length).toBe(2); // the first island meets the block's corner: its chain is open, the second island's is closed
    expect(ch.closed.filter((x) => x).length).toBe(1);
    expect(new Set(ch.seq.flatMap((c) => [...c])).size).toBe(79 + 116);
  });
});

describe("straight lakes and spits", () => {
  test("a N-S lake strip is a strip with an axis-aligned principal axis and straight shores; a diagonal one is a diagonal strip", () => {
    const side = 400, v = field(side, (x, y) => (x >= 200 && x < 206 && y >= 100 && y < 200 ? 50 : 100)), r = run(v, side);
    expect(r.lakes.n).toBe(1); expect(r.lakes.areaKm2).toBeCloseTo((6 * 100 * CELL * CELL) / 1e6, 3);
    expect(r.lakes.strips.moment.n).toBe(1); expect(r.lakes.strips.moment.axis).toBe(1); expect(r.lakes.strips.bbox.n).toBe(1);
    expect(r.lakes.shore.axis.L64).toBeGreaterThan(0.85); expect(r.lakes.shore.ctrl.L64).toBeLessThan(0.1);
    expect(r.coast.cells).toBe(0);
    const d = field(side, (x, y) => (Math.abs(x - y) < 4.5 && x >= 100 && x < 300 ? 50 : 100)), q = run(d, side);
    expect(q.lakes.strips.moment.n).toBe(1); expect(q.lakes.strips.moment.diag).toBe(1); expect(q.lakes.strips.bbox.n).toBe(0);
    expect(q.lakes.shore.diag.L64).toBeGreaterThan(0.8); expect(q.lakes.shore.axis.L64).toBeLessThan(0.1);
  });
  test("lakes come from the flood: a pit is a lake, a slope into the sea is not", () => {
    const side = 64, h = field(side, (x, y) => (x < 32 ? 20 + x : 60 - x * 0.5) - (x >= 10 && x < 14 && y >= 10 && y < 20 ? 15 : 0));
    const lake = floodLakes(h, side);
    expect(lake[15 * side + 11]).toBe(1); expect(lake[40]).toBe(0);
    const f = Int32Array.from(h); for (let y = 10; y < 20; y++) for (let x = 10; x < 14; x++) f[y * side + x] = h[y * side + x] + 256 * 15;
    const file = lakeMeasures(h, Uint8Array.from(h, (v, k) => (f[k] > v ? 1 : 0)), side, CELL, "file");
    expect(file.n).toBe(1); expect(file.source).toBe("file");
  });
  test("a thin N-S spit of 4 cells, 150 long, is one axis run; a fat peninsula has none", () => {
    const side = 600, h = field(side, (x, y) => ((x >= 150 && x < 400 && y >= 100 && y < 300) || (x >= 250 && x < 254 && y >= 300 && y < 450) ? 50 : -50)), s = spitMeasures(h, side, CELL);
    expect(s.axisRun64).toBeGreaterThan(4 * 140); expect(s.axisRun64).toBeLessThan(4 * 160 + 40);
    expect(s.axisRunKm).toBeGreaterThan((140 * CELL) / 1000); expect(s.strips.n).toBe(1); expect(s.strips.axis).toBe(1);
    const fat = spitMeasures(field(side, (x, y) => ((x >= 150 && x < 400 && y >= 100 && y < 300) || (x >= 250 && x < 270 && y >= 300 && y < 450) ? 50 : -50)), side, CELL);
    expect(fat.axisRun64).toBe(0); expect(fat.strips.n).toBe(0);
    const diag = spitMeasures(field(side, (x, y) => (Math.abs(x - y) < 2.5 ? 50 : -50)), side, CELL);
    expect(diag.strips.n).toBe(1); expect(diag.strips.diag).toBe(1); expect(diag.axisRun64).toBeLessThan(10);
  });
  test("a sea channel of 8 cells, 150 long, is an inlet strip along an axis", () => {
    const side = 400, r = run(field(side, (x, y) => (x >= 196 && x < 204 && y >= 100 && y < 250 ? -50 : 50)), side);
    expect(r.inlets.strips.n).toBe(1); expect(r.inlets.strips.axis).toBe(1); expect(r.inlets.axisRun64).toBeGreaterThan(8 * 140); expect(r.inlets.axisRunKm).toBeGreaterThan((140 * CELL) / 1000);
  });
  test("the margin crop keeps the middle", () => {
    const side = 8, a = Int32Array.from({ length: 64 }, (_, i) => i), c = crop(a, side, 2);
    expect(c.length).toBe(16); expect(c[0]).toBe(18); expect(c[15]).toBe(45);
  });
});

const chainsOf = (h: Int32Array, side: number) => shoreChains(Uint8Array.from(h, (v) => (v > 0 ? 1 : 0)), Uint8Array.from(h, (v) => (v > 0 ? 0 : 1)), side);
const maskOf = (side: number, f: (x: number, y: number) => boolean) => { const m = new Uint8Array(side * side); for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) m[y * side + x] = f(x, y) ? 1 : 0; return m; };

describe("coast teeth", () => {
  test("a staircase of 32 by 32 cell steps reverses at every step; a square island and a disc never do", () => {
    const side = 512, stairs = field(side, (x, y) => (y >= 100 + 32 * Math.floor(x / 32) ? 50 : -50)), t = coastTeeth(chainsOf(stairs, side), side, CELL);
    expect(t.reversals).toBeGreaterThanOrEqual(12); expect(t.teeth).toBeGreaterThanOrEqual(12); expect(t.teethPerKm!).toBeGreaterThan(0.3); expect(t.reversalsPerKm!).toBeGreaterThan(0.3); expect(t.reversalsPerKm!).toBeLessThan(0.5); expect(t.axis.L16).toBeGreaterThan(0.8); expect(t.axis.L32).toBeGreaterThan(0.6);
    const sq = coastTeeth(chainsOf(field(side, (x, y) => (x >= 100 && x < 400 && y >= 100 && y < 400 ? 50 : -50)), side), side, CELL);
    expect(sq.corners).toBe(4); expect(sq.reversals).toBe(0); expect(sq.teeth).toBe(0);
    const disc = coastTeeth(chainsOf(field(side, (x, y) => (Math.hypot(x - 256, y - 256) < 150 ? 50 : -50)), side), side, CELL);
    expect(disc.reversals).toBe(0); expect(disc.corners).toBe(0);
  });
  test("a zigzag of 45 degree teeth reverses at every tooth, a straight diagonal coast has no corner but is all diagonal run", () => {
    const side = 512, zig = field(side, (x, y) => (y >= 200 + Math.abs(((x % 64) + 64) % 64 - 32) ? 50 : -50)), t = coastTeeth(chainsOf(zig, side), side, CELL);
    expect(t.reversals).toBeGreaterThanOrEqual(12); expect(t.diag.L16).toBeGreaterThan(0.8);
    const band = coastTeeth(chainsOf(field(side, (x, y) => (y > x ? 50 : -50)), side), side, CELL);
    expect(band.corners).toBeLessThanOrEqual(2); expect(band.reversals).toBe(0); expect(band.diag.L32).toBeGreaterThan(0.95); expect(band.axis.L8).toBeLessThan(0.1);
  });
  test("a coast of wandering curves has no tooth", () => {
    const side = 512, wave = field(side, (x, y) => (y >= 256 + 40 * Math.sin(x / 40) + 15 * Math.sin(x / 13) ? 50 : -50)), t = coastTeeth(chainsOf(wave, side), side, CELL);
    expect(t.reversals).toBe(0); expect(t.teeth).toBe(0);
  });
  test("a short-legged zigzag reverses but has no tooth of 1 km", () => {
    const side = 512, zig = field(side, (x, y) => (y >= 200 + Math.abs(((x % 16) + 16) % 16 - 8) ? 50 : -50)), t = coastTeeth(chainsOf(zig, side), side, CELL);
    expect(t.teeth).toBe(0);
  });
});

describe("patch shapes", () => {
  test("a rectangular lake is squared and straight, a disc is neither, a turned rectangle is rectangular by its oriented box and not its bounding box", () => {
    const side = 300, rect = patchShapes(maskOf(side, (x, y) => x >= 100 && x < 140 && y >= 100 && y < 125), side, CELL);
    expect(rect.n).toBe(1); expect(rect.fillBox.median).toBe(1); expect(rect.fillObb.median).toBe(1); expect(rect.corners.mean).toBe(4); expect(rect.corners.squared).toBe(1);
    expect(rect.straight.exactAxis).toBeGreaterThan(0.5); expect(rect.straight.axis).toBeGreaterThan(0.5);
    const disc = patchShapes(maskOf(side, (x, y) => Math.hypot(x - 150, y - 150) < 25), side, CELL);
    expect(disc.fillObb.median).toBeGreaterThan(0.72); expect(disc.fillObb.median).toBeLessThan(0.85); expect(disc.corners.squared).toBe(0); expect(disc.corners.mean).toBe(0);
    const t = Math.PI / 4, turned = patchShapes(maskOf(side, (x, y) => { const u = ((x - 150) * Math.cos(t) + (y - 150) * Math.sin(t)), v = (-(x - 150) * Math.sin(t) + (y - 150) * Math.cos(t)); return Math.abs(u) < 25 && Math.abs(v) < 15; }), side, CELL);
    expect(turned.fillBox.median).toBeLessThan(0.65); expect(turned.fillObb.median).toBeGreaterThan(0.9); expect(turned.straight.diag).toBeGreaterThan(0.4); expect(turned.straight.axis).toBeLessThan(0.1);
  });
  test("patches under 64 cells and patches on the block's edge are not counted", () => {
    const side = 200, m = maskOf(side, (x, y) => (x >= 10 && x < 17 && y >= 10 && y < 17) || (x < 20 && y >= 100 && y < 140) || (x >= 100 && x < 120 && y >= 100 && y < 120));
    const p = patchShapes(m, side, CELL);
    expect(p.n).toBe(1); expect(p.areaKm2).toBeCloseTo((400 * CELL * CELL) / 1e6, 4);
  });
  test("a sea-level pit inland is a pit patch; the sea beside the block's edge is not; a flat-bottomed square basin is squared", () => {
    const side = 300, h = field(side, (x, y) => (x < 30 ? -20 : x >= 100 && x < 130 && y >= 100 && y < 120 ? -1 : 10)), r = run(h, side);
    expect(r.patches.pits.n).toBe(1); expect(r.patches.pits.corners.squared).toBe(1); expect(r.patches.pits.fillObb.median).toBe(1);
  });
});
