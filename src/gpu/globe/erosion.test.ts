// Erosion and deposition on the globe (erosion.ts, wgsl/globe-erosion.ts), tested one case at a time:
//   bun test ./src/gpu/globe/erosion.test.ts -t "forest" --timeout 280000
// The cases that need no GPU are the tables and the parameters' words; the rest run the kernels on a planet from tectonics (seed 1, 20 steps) or on a
// synthetic one, and state the invariants (the receivers a forest, the discharge area the land's, conservation to the unit, the stream power law's
// own steady state, run to run identity) and a pinned hash. What the runs measured is in docs/research/globe/2026-10-19-erosion-impl.md.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { storage } from "../kernel";
import { buildGeometry, climateGpu } from "./atmosphere";
import { FACES, SMALL_RADIUS_M, cellId, fieldWords, fromLatLon, meanAreaM2, tierGrid } from "./grid";
import { Tectonics, cellAreas, cellVectors, extTables, makeSetup, neighbours, startingState, stateFrom, totals, FLD, type Column } from "./tectonics";
import { ridgePlanet } from "./synthetic";
import {
  EF, K_GRANITE, K_SANDSTONE, K_VOLCANIC, MONTGOMERY_BRANDON, N2_REF, NONE, REF_RAIN_MMYR, Erosion, Twin, accToM2, creepIterations, defaultParams, denudationFromRelief, erosionWords, kForN2, kWord, neighbourTables,
  rainWord, rivers, runChain, type ChainState,
} from "./erosion";

afterAll(releaseGpu);

const sha = (a: Int32Array) => new Bun.CryptoHasher("sha256").update(a).digest("hex");
const g0 = tierGrid(0);
const ext = () => extTables(g0);

// A planet from tectonics: seed 1 after 20 steps (40 My), its state on the device in a buffer of its own, and the setup it came from.
async function planet(seed = 1, steps = 20) {
  const set = makeSetup({ seed }), e = extTables(set.grid), start = startingState(set, e.tab), gpu = await theGpu(), tec = new Tectonics(gpu, set, e, start.S);
  for (let s = 0; s < steps; s++) tec.step();
  tec.elevate();
  return { set, e, gpu, tec, S: await tec.read() };
}
// Heights in 1/256 m for a synthetic planet: land from `land(lat, lon) -> metres` (over 0), the sea 2,000 m deep elsewhere.
function syntheticHeights(land: (i: number, vec: Float64Array) => number): Int32Array {
  const vec = cellVectors(g0), N = FACES * g0.fn * g0.fn, H = new Int32Array(N);
  for (let i = 0; i < N; i++) { const h = land(i, vec); H[i] = Math.round((h > 0 ? h : -2000) * 256); }
  return H;
}
const arc = (vec: Float64Array, i: number, c: readonly number[]) => Math.acos(Math.min(1, vec[3 * i] * c[0] + vec[3 * i + 1] * c[1] + vec[3 * i + 2] * c[2]));

// ---- the tables ----
test("the eight neighbours of a cell: symmetric, 24 missing diagonals at the cube corners, the distances the arcs between centres", () => {
  const { nb, invd } = neighbourTables(g0), N = nb.length / 8;
  let none = 0, dmin = Infinity, dmax = 0;
  for (let i = 0; i < N; i++)
    for (let d = 0; d < 8; d++) {
      const j = nb[i * 8 + d];
      if (j === NONE) { none++; continue; }
      let back = -1;
      for (let e = 0; e < 8; e++) if (nb[j * 8 + e] === i) back = e;
      expect(back).toBeGreaterThanOrEqual(0);
      // the same distance both ways, to a unit of 2^-28 / m
      expect(Math.abs(invd[i * 8 + d] - invd[j * 8 + back])).toBeLessThanOrEqual(1);
      const dist = 2 ** 28 / invd[i * 8 + d];
      dmin = Math.min(dmin, dist); dmax = Math.max(dmax, dist);
    }
  expect(none).toBe(24);
  // a cell 12.3 km wide at most: sides from 8.6 km, and the long diagonal of the cell near a cube corner, where the lines cross at 60 degrees, sqrt(3) times a
  // side of 11.5 km, 19.9 km [derived]
  expect(dmin).toBeGreaterThan(8000); expect(dmax).toBeLessThan(20500);
});

test("parameters become the kernels' words: erodibility by pool, the n = 2 law at the same pace as n = 1 at its reference, rain relative to the reference", () => {
  const p = defaultParams(), set = makeSetup(), w = erosionWords(g0, set, p);
  expect(w[28]).toBe(p.skinM);
  // K dt sqrt(a mean cell / 512) in Q12 for granite
  expect(w[30 + 3]).toBe(Math.round(K_GRANITE * p.dtYr * Math.sqrt(meanAreaM2(g0) / 512) * 4096));
  expect(K_VOLCANIC).toBeGreaterThan(K_SANDSTONE); expect(K_SANDSTONE).toBeGreaterThan(K_GRANITE);
  // the two laws erode at the same rate at the reference slope and area
  const k1 = K_GRANITE, k2 = kForN2(k1);
  expect(k2 * N2_REF.area * N2_REF.slope ** 2).toBeCloseTo(k1 * Math.sqrt(N2_REF.area) * N2_REF.slope, 12);
  expect(kWord(g0, { dtYr: 5e5, n: 2 }, k2)).toBeGreaterThan(0);
  expect(rainWord(REF_RAIN_MMYR, REF_RAIN_MMYR)).toBe(256);
  expect(rainWord(1e9, REF_RAIN_MMYR)).toBe(2048);
  expect(rainWord(-5, REF_RAIN_MMYR)).toBe(0);
  // creep: the fewest equal iterations under the stable number
  const [its, fo] = creepIterations(g0, 100, 5e5);
  expect(fo / 2 ** 24).toBeLessThanOrEqual(0.08 + 1e-6);
  expect(its).toBeGreaterThan(1);
  expect(creepIterations(g0, 0, 5e5)[0]).toBe(0);
});

// ---- flow routing ----
test("flow routing is a forest on the sphere: every chain ends in the ocean, none cycles, and the discharge area sums to the land across face edges and cube corners", async () => {
  const { set, e, gpu, tec, S } = await planet();
  const er = new Erosion(gpu, set, e, tec.S);
  er.heights(); await er.flow();
  expect(await er.flags()).toBe(0);
  const f = await er.readFlow(), { nb } = neighbourTables(g0), N = er.N, areas = cellAreas(g0);
  let crossEdge = 0, land = 0, landArea = 0, sumW = 0;
  const W = await er.readE(EF.W);
  for (let i = 0; i < N; i++) {
    const isLand = f.height[i] > 0;
    // the ocean cells are the roots and only they; the flooded surface is the height there
    expect(f.to[i] === i).toBe(!isLand);
    if (!isLand) { expect(f.flooded[i]).toBe(f.height[i]); continue; }
    land++; landArea += areas[i]; sumW += W[i];
    // the flooded surface is never below the ground; the receiver is a neighbour and strictly lower on it: no cycle
    expect(f.flooded[i]).toBeGreaterThanOrEqual(f.height[i]);
    const j = f.to[i];
    expect([...nb.subarray(i * 8, i * 8 + 8)]).toContain(j);
    expect(f.flooded[j]).toBeLessThan(f.flooded[i]);
    expect(f.depth[i]).toBe(f.depth[j] + 1);
    // across a face edge: the receiver on another face
    if (Math.floor(i / 65536) !== Math.floor(j / 65536)) crossEdge++;
  }
  expect(land).toBeGreaterThan(50000);
  expect(crossEdge).toBeGreaterThan(100);
  // the discharge area: what the ocean cells receive is every land cell's weight, exactly, and the land's area to the rounding of the weights
  let drained = 0n, accMax = 0;
  for (let i = 0; i < N; i++) { if (f.height[i] <= 0) drained += BigInt(f.acc[i]); else accMax = Math.max(accMax, f.acc[i]); }
  expect(drained).toBe(BigInt(sumW));
  const landFromAcc = accToM2(g0, Number(drained)), R2 = g0.radius ** 2;
  expect(Math.abs(landFromAcc / (landArea * R2) - 1)).toBeLessThan(5e-4);
  // the rivers' basins add to the land
  const r = rivers(g0, f.to, Float32Array.from(f.height, (v) => v / 256), neighbourTables(g0).invd, nb);
  expect(Math.abs(r.basins.reduce((s, a) => s + a, 0) * 1e6 / (landArea * R2) - 1)).toBeLessThan(1e-9);
  // the flooded surface is the one fixed point: a priority flood from the ocean by Dijkstra gives the same words
  const twin = new Twin(set, e, er.p), want = twin.flood(Int32Array.from(f.height));
  expect(f.flooded.every((v, i) => v === want[i])).toBe(true);
  er.release(); tec.release();
});

// ---- the kernels equal their twins ----
test("the kernels equal their TypeScript twins over three substeps, word for word: heights, flood, tree, discharge, incision, books, sediment, rings, carry, columns", async () => {
  const { set, e, gpu, tec, S } = await planet();
  const er = new Erosion(gpu, set, e, tec.S), tw = new Twin(set, e, er.p), N = er.N;
  const rain = Float32Array.from({ length: N }, (_, i) => 200 + ((i * 7919) % 1800)); // 200 to 2,000 mm/yr, scattered
  er.setRain(rain);
  const rho = Uint32Array.from(rain, (v) => rainWord(v, er.p.refRainMmYr)), carry = new BigUint64Array(N), St = Int32Array.from(S);
  let extraCells = 0;
  for (let step = 0; step < 3; step++) {
    er.heights(); await er.flow(); er.erode(); er.apply();
    const r = tw.erode(St, rho, carry);
    const same = async (name: string, field: number, want: ArrayLike<number>) => {
      const got = await er.readE(field);
      let bad = 0;
      for (let i = 0; i < N; i++) if (got[i] !== (want[i] | 0)) bad++;
      expect(`${name} ${bad}`).toBe(`${name} 0`);
    };
    await same("H", EF.H, r.H); await same("W", EF.W, r.W); await same("TO", EF.TO, r.to); await same("RD", EF.RD, r.rd); await same("depth", EF.DP, r.depth); await same("ACC", EF.ACC, r.acc);
    await same("KC", EF.KC, r.kc); await same("ER", EF.ER, r.er); await same("RV", EF.RV, r.rv); await same("DS", EF.DS, r.ds); await same("PS", EF.PS, r.ps); await same("AD", EF.AD, r.ad);
    await same("QL", EF.QL, r.ql); await same("QH", EF.QH, r.qh); await same("CD", EF.CD, r.cd); await same("WL", EF.WL, r.wl);
    extraCells += r.extra.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    await same("CL", EF.CL, Uint32Array.from(carry, (v) => Number(v & 0xffffffffn))); await same("CH", EF.CH, Uint32Array.from(carry, (v) => Number(v >> 32n)));
    const fl = await er.readFlooded();
    expect(fl.every((v, i) => v === r.flooded[i])).toBe(true);
    const Sg = await er.readState(), fw = fieldWords(g0);
    for (let i = 0; i < 7 * fw; i++) if (Sg[i] !== St[i]) { expect(`state word ${i}`).toBe("equal"); break; }
    expect(await er.flags()).toBe(0);
  }
  // the relief law was at work in this planet (cells it lowered beyond the river's incision), so the comparison covers it
  expect(extraCells).toBeGreaterThan(50);
  er.release(); tec.release();
});

test("creep and the sea floor's diffusion: the grid's flux as whole volume units, limited by what the giver can spare, equals its twin and conserves to the unit", async () => {
  const { set, e, gpu, tec, S } = await planet();
  const er = new Erosion(gpu, set, e, tec.S, { creepLand: 1e5, creepSea: 1e5 }), tw = new Twin(set, e, er.p), N = er.N;
  const [, fl] = creepIterations(g0, 1e5, er.p.dtYr), before = totals(g0, S);
  await er.creepOnce(fl, fl, false);
  const H = Int32Array.from({ length: N }, (_, k) => tw.height(S, k)), dv = tw.creep(S, H, fl, fl);
  const rv = await er.readE(EF.RV), ad = await er.readE(EF.AD);
  let net = 0n, moved = 0n, bad = 0;
  for (let i = 0; i < N; i++) { const v = (ad[i] >>> 0) - (rv[i] >>> 0); if (v !== dv[i]) bad++; net += BigInt(v); moved += BigInt(Math.abs(v)); }
  expect(bad).toBe(0);
  expect(net).toBe(0n);
  expect(moved).toBeGreaterThan(1_000_000_000n);
  // applied: the five pools' total volume is the same to the unit, and no column went negative
  await er.creepOnce(fl, fl, true);
  const after = totals(g0, await er.readState());
  expect(after.reduce((s, x) => s + x, 0n)).toBe(before.reduce((s, x) => s + x, 0n));
  er.release(); tec.release();
});

// ---- the stream power law's steady state ----
// A cone or a ridge of land on a sea floor, uplifted at U against the implicit stream power step of one rock and one rain until it settles: every land cell then
// stands at S = (U / K)^(1/n) A^(-m/n), A the discharge area from its own flooded flow, S the slope to its receiver over their distance.
async function steady(shape: (i: number, vec: Float64Array) => number, n: 1 | 2, steps = 400) {
  const gpu = await theGpu(), set = makeSetup(), e = ext(), S = storage(gpu, FLD.COUNT * fieldWords(g0) * 4);
  const er = new Erosion(gpu, set, e, S, { n, dtYr: 1e6 });
  const K = n === 1 ? K_GRANITE : kForN2(K_GRANITE), U = 1e-5, upl = Math.round(U * er.p.dtYr * 256), kw = kWord(g0, er.p, K), N = er.N;
  er.loadHeights(syntheticHeights(shape));
  for (let s = 0; s < steps; s++) await er.solverStep(upl, kw);
  const f = await er.readFlow(), ER = await er.readE(EF.ER), { nb, invd } = neighbourTables(g0);
  const ratios: number[] = [], pace: number[] = [], pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const j = f.to[i];
    if (f.height[i] <= 0 || j === i || f.height[j] <= 0 || f.flooded[i] > f.height[i] + ER[i]) continue;
    let d = 0;
    for (let q = 0; q < 8; q++) if (nb[i * 8 + q] === j) d = 2 ** 28 / invd[i * 8 + q];
    const slope = (f.height[i] - f.height[j]) / 256 / d, area = accToM2(g0, f.acc[i]);
    ratios.push(slope / (n === 1 ? (U / K) * area ** -0.5 : Math.sqrt(U / (K * area))));
    pace.push(ER[i] / 256 / (U * er.p.dtYr));
    if (f.acc[i] > 20 * 512) pts.push([Math.log(area), Math.log(slope)]);
  }
  er.release();
  ratios.sort((a, b) => a - b); pace.sort((a, b) => a - b);
  const q = (a: number[], p: number) => a[Math.floor(p * a.length)];
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length, my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return { cells: ratios.length, p5: q(ratios, 0.05), p50: q(ratios, 0.5), p95: q(ratios, 0.95), pace50: q(pace, 0.5), slope, points: pts.length };
}
const cone = (centre: readonly number[], radius: number, peak: number) => (i: number, vec: Float64Array) => { const dd = arc(vec, i, centre) * g0.radius; return dd < radius ? peak * (1 - dd / radius) + 1 : -1; };
// A ridge along the meridian of longitude 45, the edge between faces 0 and 1 from latitude -35 to 35 and the cube's corners at its ends: its flanks drain across the edge.
const ridge = (i: number, vec: Float64Array) => {
  const lat = Math.asin(vec[3 * i + 2]), lon = Math.atan2(vec[3 * i + 1], vec[3 * i]), dlon = Math.atan2(Math.sin(lon - Math.PI / 4), Math.cos(lon - Math.PI / 4));
  const across = Math.abs(Math.asin(Math.cos(lat) * Math.sin(dlon))) * g0.radius, along = Math.abs(lat) * g0.radius;
  return across < 400e3 && along < 1500e3 && Math.cos(lon - Math.PI / 4) > 0 ? 2500 * Math.cos((Math.PI * across) / 800e3) ** 2 * Math.min(1, (1500e3 - along) / 300e3) + 1 : -1;
};

test("steady state, a cone on a cube corner (n = 1, m = 1/2): the slope is (U / K) A^-1/2 at every cell, median to 1%, the log-log slope -0.5", async () => {
  const c = fromLatLon((Math.atan(1 / Math.SQRT2) * 180) / Math.PI * (Math.PI / 180), Math.PI / 4), r = await steady(cone(c, 600e3, 3000), 1);
  console.log("cone n=1", JSON.stringify(r));
  expect(r.cells).toBeGreaterThan(5000);
  expect(Math.abs(r.p50 - 1)).toBeLessThan(0.01);
  expect(r.p5).toBeGreaterThan(0.9); expect(r.p95).toBeLessThan(1.15);
  expect(Math.abs(r.pace50 - 1)).toBeLessThan(0.01);
  expect(Math.abs(r.slope + 0.5)).toBeLessThan(0.03);
});

test("steady state, a cone on a cube corner (n = 2, m = 1): the slope is (U / K A)^1/2 at every cell, the same concavity", async () => {
  const c = fromLatLon(Math.atan(1 / Math.SQRT2), Math.PI / 4), r = await steady(cone(c, 600e3, 3000), 2);
  console.log("cone n=2", JSON.stringify(r));
  expect(Math.abs(r.p50 - 1)).toBeLessThan(0.01);
  expect(r.p5).toBeGreaterThan(0.75); expect(r.p95).toBeLessThan(1.4);
  expect(Math.abs(r.slope + 0.5)).toBeLessThan(0.05);
});

test("steady state, a ridge along a face edge (n = 1): both flanks reach the same law across the edge", async () => {
  const r = await steady(ridge, 1);
  console.log("ridge n=1", JSON.stringify(r));
  expect(r.cells).toBeGreaterThan(3000);
  expect(Math.abs(r.p50 - 1)).toBeLessThan(0.01);
  expect(r.p5).toBeGreaterThan(0.9); expect(r.p95).toBeLessThan(1.15);
  expect(Math.abs(r.slope + 0.5)).toBeLessThan(0.03);
});

// ---- the books ----
test("volume is conserved to the unit: removed = deposited + dissolved + the change in transit, and the columns change by exactly the dissolved and the sediment in transit", async () => {
  const { set, e, gpu, tec, S } = await planet();
  const er = new Erosion(gpu, set, e, tec.S);
  er.setRain(1000);
  const before = totals(g0, S).reduce((s, x) => s + x, 0n);
  let removed = 0n, deposited = 0n, dissolved = 0n;
  for (let q = 0; q < 3; q++) {
    const r = await er.substep(true);
    removed += r.ledger!.removed; deposited += r.ledger!.deposited; dissolved += r.ledger!.dissolved;
  }
  const carry = await er.carry(), after = totals(g0, await er.readState()).reduce((s, x) => s + x, 0n);
  expect(await er.flags()).toBe(0);
  expect(removed).toBeGreaterThan(1_000_000_000n);
  // the sediment: all of it is somewhere (columns) or in transit; the creep moved volume without changing the total
  expect(removed - deposited - dissolved).toBe(carry);
  expect(after - before).toBe(-dissolved - carry);
  // the dissolved share is the cited fraction of what was removed, to the rounding of each cell
  expect(Math.abs(Number(dissolved) / Number(removed) - er.p.dissolved)).toBeLessThan(1e-4);
  er.release(); tec.release();
});

// ---- a rain shadow ----
test("a rain shadow: the windward flank of a ridge in the westerlies erodes more and is more dissected than the lee (the atmosphere's rain)", async () => {
  const gpu = await theGpu(), set = makeSetup({ seed: 1, seaLevel: 0 }), e = ext(), geo = buildGeometry(g0), height = ridgePlanet(geo, { lat0: 56, lat1: 64, lon0: 90, halfKm: 150, peak: 3000 });
  // the columns of that height: granitoid crust over the reference thickness by height / (1 - 2800 / 3300) on land, 6 km of 100 My old basalt under the sea
  const column = (i: number): Column => (height[i] > 0 ? { granitoid: 35000 + height[i] / (1 - 2800 / 3300), plate: 0, orogenyMy: 100 } : { basalt: 6000, ageMy: 100, plate: 0 });
  const Sinit = stateFrom(set, e.tab, column), S = storage(gpu, Sinit);
  const clim = await climateGpu(gpu, g0, height, { seaLevel: 0 }), rain = new Float32Array(height.length);
  for (const s of clim.seasons) for (let i = 0; i < rain.length; i++) rain[i] += s.rain[i];
  // the rain's own effect: the relief law (the same on both flanks) is left out of this case
  const er = new Erosion(gpu, set, e, S, { dtYr: 1e6, relief: false });
  er.setRain(rain);
  const N = er.N, vec = cellVectors(g0), crest = fromLatLon((60 * Math.PI) / 180, (90 * Math.PI) / 180);
  er.heights(); const h0 = Int32Array.from(await er.readE(EF.H));
  const removed = new Float64Array(N);
  for (let q = 0; q < 40; q++) await er.substep(false, async () => { const rv = await er.readE(EF.RV); for (let i = 0; i < N; i++) removed[i] += rv[i] >>> 0; });
  er.heights(); await er.flow();
  const f = await er.readFlow(), areaW = e.T;
  // flanks: cells 50 to 150 km west (windward) and east (lee) of the crest between 57 and 63 degrees north, on the ridge's own land
  const sides = { west: { cells: 0, rock: 0, dropM: 0, channel: 0 }, east: { cells: 0, rock: 0, dropM: 0, channel: 0 } };
  for (let i = 0; i < N; i++) {
    if (h0[i] <= 0) continue;
    const lat = Math.asin(vec[3 * i + 2]) * 180 / Math.PI, lon = Math.atan2(vec[3 * i + 1], vec[3 * i]) * 180 / Math.PI;
    if (lat < 57 || lat > 63) continue;
    const dx = (lon - 90) * Math.cos((60 * Math.PI) / 180) * (Math.PI / 180) * g0.radius, side = dx < 0 ? sides.west : sides.east;
    if (Math.abs(dx) < 50e3 || Math.abs(dx) > 150e3) continue;
    side.cells++; side.rock += (removed[i] * 16) / areaW[i]; side.dropM += (h0[i] - f.height[i]) / 256;
    if (accToM2(g0, f.acc[i]) > 10 * meanAreaM2(g0)) side.channel++;
  }
  const rock = { west: sides.west.rock / sides.west.cells, east: sides.east.rock / sides.east.cells }, drop = { west: sides.west.dropM / sides.west.cells, east: sides.east.dropM / sides.east.cells };
  const rainBy = (lo: number, hi: number) => { let s = 0, c = 0; for (let i = 0; i < N; i++) { const lat = Math.asin(vec[3 * i + 2]) * 180 / Math.PI, lon = Math.atan2(vec[3 * i + 1], vec[3 * i]) * 180 / Math.PI; if (lat < 57 || lat > 63 || h0[i] <= 0) continue; const dx = (lon - 90) * Math.cos((60 * Math.PI) / 180) * (Math.PI / 180) * g0.radius; if (dx >= lo && dx <= hi) { s += rain[i]; c++; } } return s / c; };
  const rainRatio = rainBy(50e3, 150e3) / rainBy(-150e3, -50e3);
  console.log("rain shadow", JSON.stringify({ sides, rockM: rock, dropM: drop, erosionRatio: rock.west / rock.east, rainRatioLeeOverWind: rainRatio, channelShare: { west: sides.west.channel / sides.west.cells, east: sides.east.channel / sides.east.cells } }));
  expect(sides.west.cells).toBeGreaterThan(20); expect(sides.east.cells).toBeGreaterThan(20);
  expect(rainRatio).toBeLessThan(0.5);
  expect(rock.west).toBeGreaterThan(2 * rock.east);
  expect(drop.west).toBeGreaterThan(drop.east);
  er.release();
});

// ---- determinism ----
test("a run is the same twice, and the pinned hash of the columns after four substeps from seed 1 at 40 My", async () => {
  const hashes: string[] = [];
  for (let run = 0; run < 2; run++) {
    const { set, e, gpu, tec } = await planet();
    const er = new Erosion(gpu, set, e, tec.S);
    er.setRain(Float32Array.from({ length: er.N }, (_, i) => 300 + ((i * 31) % 1400)));
    for (let q = 0; q < 4; q++) await er.substep(true);
    const S = await er.readState(), fw = fieldWords(g0), pools = S.subarray(0, 7 * fw);
    hashes.push(sha(pools) + sha(await er.readE(EF.H)).slice(0, 8));
    er.release(); tec.release();
  }
  expect(hashes[0]).toBe(hashes[1]);
  expect(hashes[0].slice(0, 64)).toBe(PINNED);
});

// Re-recorded deliberately (the sha256 of the five volumes, both age sums, the plates and the plate-relative fields, then the heights): the planet it starts from now spreads a step's stacked
// crust as a wedge and drives the channel by the regional thickness (second pass of the ranges unit). First pass (regional ranking, channel flow on each column, foundering at 65.5 km, the relief
// law): e6b26d2806174e70b80e83c4f351aab097f4942cba9900db67174d176b470b3b; before it: b97b4ef3026a12fc3db567aa495480e5288b45b738e25976ec18bb2821a34c1a.
// Third pass: the planet it starts from now moves the crust near a cube corner by overlap (tectonics-corner.ts); before it: 54cf848b33511b6ebf7f1e2a67cd5427cb863b9c11ee0e48f3fdfac4c38c7f19.
const PINNED = "03c587de61dbc030c6bbdcdb9213cc5cb9652a54e79324fe174fb9b898f12fed";


// ---- landscape-scale denudation by relief ----
test("relief denudation (Montgomery and Brandon 2002): E = E0 + K R / (1 - (R / Rc)^2) at its published points, integrated over a substep by the kernel, held under 15/16 of Rc", async () => {
  // the law at the cited points: 0.01 mm/yr at no relief, K R over 1 - (R / Rc)^2 at 1,000 m (0.46 mm/yr) and at 1,400 m
  const mb = MONTGOMERY_BRANDON;
  expect(denudationFromRelief(0)).toBeCloseTo(mb.e0MmYr, 12);
  expect(denudationFromRelief(1000)).toBeCloseTo(0.01 + (2.5e-4 * 1000) / (1 - (1000 / 1500) ** 2), 9);
  expect(denudationFromRelief(1000)).toBeGreaterThan(0.45); expect(denudationFromRelief(1000)).toBeLessThan(0.47);
  // held under the cap: a scarp of 6 km erodes at the cap's rate, 2.9 mm/yr
  expect(denudationFromRelief(6000)).toBe(denudationFromRelief(0.9375 * 1500));
  expect(denudationFromRelief(6000)).toBeGreaterThan(2.8); expect(denudationFromRelief(6000)).toBeLessThan(3.0);
  // the kernel on staged heights: probe cells standing R above four neighbours at 3,000 m, on land; its integral over a substep of 0.5 My against the same law in float (eight sub-intervals)
  const gpu = await theGpu(), set = makeSetup(), e = ext(), er = new Erosion(gpu, set, e, storage(gpu, FLD.COUNT * fieldWords(g0) * 4)), N = er.N, nbs = neighbours(g0);
  const H = new Int32Array(N).fill(3000 * 256), probes: [number, number][] = [[50, 100], [150, 800], [100, 1500], [100, 2200], [60, 3000], [40, 6000], [30, 0]];
  const cells = probes.map(([x, R], k) => ({ i: cellId(g0, 0, 20 + 20 * k, 128), R: R === 800 ? 800 : R }));
  const reliefs = [100, 500, 1000, 1400, 3000, 6000, 0];
  cells.forEach((c, k) => { c.R = reliefs[k]; H[c.i] = Math.round((3000 + reliefs[k]) * 256); });
  er.loadHeights(H);
  er.reliefOnly();
  const WL = await er.readE(EF.WL), dt = er.p.dtYr;
  const reference = (R: number) => {
    let r = R, tot = 0;
    for (let s = 0; s < mb.subIntervals; s++) { const dh = Math.min((denudationFromRelief(r) * 1e-3 * dt) / mb.subIntervals, r); r -= dh; tot += dh; }
    return tot;
  };
  for (const c of cells) {
    expect(Math.abs(WL[c.i] / 256 - reference(c.R))).toBeLessThan(0.1 + 2e-3 * reference(c.R));
    // the neighbours stand no higher than their own neighbours' lowest: their relief is the probe's neighbour drop at most, a few m of E0 at most
    for (let d = 0; d < 4; d++) expect(WL[nbs[4 * c.i + d]] / 256).toBeLessThan(reference(c.R) + 1);
  }
  // monotone in the relief up to the cap, and a scarp of 3 or 6 km loses what the cap allows, 1.46 km in a substep of 0.5 My
  for (let k = 1; k < 5; k++) expect(WL[cells[k].i]).toBeGreaterThan(WL[cells[k - 1].i]);
  expect(WL[cells[5].i]).toBe(WL[cells[4].i]); // 3 km and 6 km are both over the cap: the same rate
  expect(WL[cells[5].i] / 256).toBeGreaterThan(1300); expect(WL[cells[5].i] / 256).toBeLessThan(1500);
  expect(WL[cells[6].i]).toBe(0);
  // the law is off when asked: the words are zero
  expect(erosionWords(g0, set, defaultParams({ relief: false }))[36]).toBe(0);
  er.release();
});

test("the relief law in a dry land: with no rain there is no river to carry the debris, it stays where it fell, and the books balance", async () => {
  // The atmosphere's dry belts have no rain at all. The stream power law takes nothing from a cell with no discharge, but the relief law does, and Davy and Lague's share G w / (G w + A) is
  // 0 / 0 there: the first version of the chain flagged a pile-up at step 0. The debris of a cell with no water is laid down in that cell.
  const { set, e, gpu, tec, S } = await planet(), er = new Erosion(gpu, set, e, tec.S);
  er.setRain(0);
  const before = totals(g0, S);
  let removed = 0n, deposited = 0n, dissolved = 0n;
  for (let q = 0; q < 3; q++) { const r = await er.substep(true); removed += r.ledger!.removed; deposited += r.ledger!.deposited; dissolved += r.ledger!.dissolved; expect(await er.flags()).toBe(0); }
  const after = totals(g0, await er.readState()), sum = (a: bigint[]) => a.reduce((s, x) => s + x, 0n), transit = await er.carry();
  expect(removed).toBeGreaterThan(0n);
  expect(deposited).toBeGreaterThan(0n);
  expect(removed).toBe(deposited + dissolved + transit);
  expect(sum(after) - sum(before)).toBe(-(dissolved + transit));
  er.release(); tec.release();
});

test("a chain stopped at its budget resumes to the bytes of the run made whole, on the small planet", async () => {
  const gpu = await theGpu(), set = makeSetup({ seed: 1, spanMy: 6, radius: SMALL_RADIUS_M, plates: 10 }), o = { rain: async () => 800, rainEveryMy: 4, substeps: 2, afterMy: 1 };
  const whole = await runChain(gpu, set, o);
  let resume: ChainState | undefined, parts = 0, last = await runChain(gpu, set, { ...o, budgetS: 1e-9 });
  while (last.stopped) { parts++; resume = last.stopped; last = await runChain(gpu, set, { ...o, budgetS: 1e-9, resume }); }
  expect(parts).toBeGreaterThanOrEqual(2); // each part made one tectonic step at least
  expect(sha(last.S)).toBe(sha(whole.S));
  expect(Array.from(last.flow.to)).toEqual(Array.from(whole.flow.to));
  expect(Array.from(last.flow.acc)).toEqual(Array.from(whole.flow.acc));
  expect(last.carry).toBe(whole.carry);
  expect(last.ledger).toEqual(whole.ledger);
});
