// Plate tectonics on the globe (tectonics.ts, wgsl/globe-tectonics.ts), tested one case at a time:
//   bun test ./src/gpu/globe/tectonics.test.ts -t "isostasy" --timeout 280000
// The cases that need no GPU are the seed's draws and the rotations; the rest run the kernels, and one compares them bit for
// bit with their TypeScript twins. The cases state the invariants (conservation, bounds, the law's algebra, determinism) and
// a pinned hash per seed; what the runs measured is in docs/research/globe/2026-10-19-tectonics-impl.md.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { FACES, cellId, fieldWords, fromLatLon, latLon, wordAt, type Tables, type V3 } from "./grid";
import {
  ARC, BOUNDARY, DEFAULTS, RANGE_Z_M, DEFAULT_SWEEPS, FLD, FLUX, HOT_FLUX_HI, HOT_FLUX_LO, LITH, PHYS, SPEED_HI_MM, SPEED_LO_MM, Tectonics, Twin, cellVectors, classifyBoundaries, derive, distanceFrom, extTables,
  makeArcs, makeHotspots, makePlates, makeSetup, measure, rotation, runPlanet, startingState, stateFrom, thermalTable, totals, unpad, type Column, type Plate, type Setup,
} from "./tectonics";

afterAll(releaseGpu);

const hash = (S: Int32Array, fields: number[] = [0, 1, 2, 3, 4, 5, 6, 7]) => {
  const g = new Bun.CryptoHasher("sha256"), fw = S.length / FLD.COUNT;
  for (const f of fields) g.update(S.subarray(f * fw, (f + 1) * fw));
  return g.digest("hex");
};
const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const ext = () => extTables(makeSetup().grid);

// ---- the seed decides the plates ----
test("the seed decides the plates: unit poles, cited speeds, a partition by nearest seed, the same twice", () => {
  const a = makePlates({ ...DEFAULTS, seed: 5 }), b = makePlates({ ...DEFAULTS, seed: 5 }), c = makePlates({ ...DEFAULTS, seed: 6 });
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
  expect(a.length).toBe(10);
  expect(makePlates({ ...DEFAULTS, plates: 6 }).length).toBe(6);
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8])
    for (const p of makePlates({ ...DEFAULTS, seed: s })) {
      expect(Math.abs(norm3(p.pole) - 1)).toBeLessThan(1e-14);
      expect(Math.abs(norm3(p.seed) - 1)).toBeLessThan(1e-14);
      // the speed at 90 degrees from the pole is in the cited range (9.7 to 154.4 mm/yr measured, capped at 100) scaled by the planet's size
      expect(p.speedMmYr).toBeGreaterThanOrEqual(SPEED_LO_MM * DEFAULTS.speedScale - 1e-9);
      expect(p.speedMmYr).toBeLessThanOrEqual(SPEED_HI_MM * DEFAULTS.speedScale + 1e-9);
      // 1 mm a year is 1 km a My: the rate in rad a My is the speed over the radius in km
      expect(p.rate * (DEFAULTS.radius / 1000)).toBeCloseTo(p.speedMmYr, 9);
    }
  // hot spots: unit directions, output in the stated range
  for (const h of makeHotspots(DEFAULTS)) {
    expect(Math.abs(norm3(h.dir) - 1)).toBeLessThan(1e-14);
    expect(h.fluxKm3Yr).toBeGreaterThanOrEqual(HOT_FLUX_LO);
    expect(h.fluxKm3Yr).toBeLessThanOrEqual(HOT_FLUX_HI);
  }
  expect(makeHotspots({ ...DEFAULTS, hotspots: 0 }).length).toBe(0);
  // the arcs' clock: a background of ARC.bg or that plus a flare, as thickness a step of the band
  const steps = 100, arcs = makeArcs(DEFAULTS, steps), bg = Math.round(((ARC.newShare * ARC.bg * DEFAULTS.stepMy) / ARC.widthKm) * 1000), top = Math.round(((ARC.newShare * (ARC.bg + ARC.flareHi) * DEFAULTS.stepMy) / ARC.widthKm) * 1000);
  expect(arcs.length).toBe(10 * (steps + 1));
  for (const v of arcs) { expect(v).toBeGreaterThanOrEqual(bg); expect(v).toBeLessThanOrEqual(top); }
  expect(arcs.some((v) => v > bg)).toBe(true);
  // the partition: every cell is on the plate whose seed is nearest (largest dot product); sampled
  const set = makeSetup({ seed: 5 }), e = ext(), start = startingState(set, e.tab), vec = cellVectors(set.grid), counts = new Map<number, number>();
  for (let i = 0; i < start.plate.length; i++) {
    counts.set(start.plate[i], (counts.get(start.plate[i]) ?? 0) + 1);
    if (i % 53 !== 0) continue;
    const x: V3 = [vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]];
    let best = -2, bp = 0;
    set.plates.forEach((p, k) => { const d = dot3(x, p.seed); if (d > best) { best = d; bp = k; } });
    expect(start.plate[i]).toBe(bp);
  }
  expect([...counts.values()].reduce((s, v) => s + v, 0)).toBe(FACES * 256 * 256);
});

// ---- rotations ----
test("a step's rotation is a rotation, and moves a point by rate times radius times the sine of its angle from the pole", () => {
  const set = makeSetup({ seed: 3 }), L = set.layout;
  set.plates.forEach((p, k) => {
    const R = rotation(p.pole, p.rate * set.params.stepMy);
    // orthogonal with determinant one
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(Math.abs(R[3 * i] * R[3 * j] + R[3 * i + 1] * R[3 * j + 1] + R[3 * i + 2] * R[3 * j + 2] - (i === j ? 1 : 0))).toBeLessThan(1e-15);
    expect(Math.abs(R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]) - 1)).toBeLessThan(1e-15);
    // the table's Q30 words are the matrix to 2^-30
    for (let m = 0; m < 9; m++) expect(Math.abs(set.Q[L.rot + 9 * k + m] / 2 ** 30 - R[m])).toBeLessThanOrEqual(2 ** -31 + 1e-16);
    // a point's chord: 2 sin(angle / 2) sin(theta) on the unit sphere
    for (const x of [fromLatLon(0.3, 1.1), fromLatLon(-1.2, -2.0), fromLatLon(0.0, 0.0)]) {
      const y: V3 = [R[0] * x[0] + R[1] * x[1] + R[2] * x[2], R[3] * x[0] + R[4] * x[1] + R[5] * x[2], R[6] * x[0] + R[7] * x[1] + R[8] * x[2]];
      const chord = Math.hypot(y[0] - x[0], y[1] - x[1], y[2] - x[2]), sinTheta = Math.sqrt(1 - dot3(x, p.pole) ** 2), angle = p.rate * set.params.stepMy;
      expect(Math.abs(chord - 2 * Math.sin(angle / 2) * sinTheta)).toBeLessThan(1e-14);
    }
  });
});

// ---- isostasy ----
// The height of a column by Archimedes' law in float, with an explicit compensation depth: the surface at z has the
// column's crust under it (layers from the top: thickness m, density), mantle below it to depth D under the reference
// level, and above sea level (z >= 0) the air weighs nothing, under water (z < 0) the water does; the thermal deficit of
// young ocean lithosphere (kg/m2) is subtracted from the column's mass. Solved so that the mass above D equals the
// reference column's (35 km of crust of 2800 at the surface z = 0).
function archimedes(layers: { h: number; rho: number }[], deficit = 0): number {
  const rm = PHYS.RHO_M, rw = PHYS.RHO_W, D = 300_000, ref = 2800 * PHYS.H0 + rm * (D - PHYS.H0);
  const h = layers.reduce((s, l) => s + l.h, 0), m = layers.reduce((s, l) => s + l.h * l.rho, 0) - deficit;
  const dry = (ref - m - rm * (D - h)) / rm;
  if (dry >= 0) return dry;
  return -(m + rm * (D - h) - ref) / (rm - rw);
}
const RHO = { basalt: 2900, sediment: 2500, rock: 2800 };
// the deficit that puts a bare 6 km of basalt at the depth of age t: the law of the sea floor, 2.5 km + 0.355 km sqrt(t) capped at 6.4 km
const seaDepth = (t: number) => Math.min(2500 + 355 * Math.sqrt(t), 6400);
function deficitAt(t: number): number {
  const rm = PHYS.RHO_M, rw = PHYS.RHO_W, D = 300_000, ref = 2800 * PHYS.H0 + rm * (D - PHYS.H0), w = seaDepth(t);
  return rw * w + 6000 * RHO.basalt + rm * (D - w - 6000) - ref;
}

test("isostasy: columns of every rock stand where Archimedes puts them, the sea floor deepens as the root of its age", async () => {
  const set = makeSetup({ seed: 1 }), e = ext(), gpu = await theGpu();
  type Spec = { name: string; col: Column; layers: { h: number; rho: number }[]; age?: number };
  const specs: Spec[] = [
    { name: "35 km of granitoid", col: { granitoid: 35_000, plate: 0 }, layers: [{ h: 35_000, rho: RHO.rock }] },
    { name: "50 km", col: { granitoid: 50_000, plate: 0 }, layers: [{ h: 50_000, rho: RHO.rock }] },
    { name: "70 km", col: { granitoid: 70_000, plate: 0 }, layers: [{ h: 70_000, rho: RHO.rock }] },
    { name: "25 km, under water", col: { granitoid: 25_000, plate: 0 }, layers: [{ h: 25_000, rho: RHO.rock }] },
    { name: "mixed rock", col: { granitoid: 20_000, metasediment: 5_000, volcanic: 5_000, sediment: 3_000, plate: 0 }, layers: [{ h: 3_000, rho: RHO.sediment }, { h: 30_000, rho: RHO.rock }] },
    { name: "ridge crest", col: { basalt: 6_000, ageMy: 0, plate: 0 }, layers: [{ h: 6_000, rho: RHO.basalt }], age: 0 },
    { name: "10 My floor", col: { basalt: 6_000, ageMy: 10, plate: 0 }, layers: [{ h: 6_000, rho: RHO.basalt }], age: 10 },
    { name: "50 My floor", col: { basalt: 6_000, ageMy: 50, plate: 0 }, layers: [{ h: 6_000, rho: RHO.basalt }], age: 50 },
    { name: "200 My floor", col: { basalt: 6_000, ageMy: 200, plate: 0 }, layers: [{ h: 6_000, rho: RHO.basalt }], age: 200 },
    { name: "floor under 1 km of sediment", col: { basalt: 6_000, sediment: 1_000, ageMy: 50, plate: 0 }, layers: [{ h: 1_000, rho: RHO.sediment }, { h: 6_000, rho: RHO.basalt }], age: 50 },
    { name: "a plateau of basalt and volcanic rock", col: { basalt: 6_000, volcanic: 10_000, ageMy: 50, plate: 0 }, layers: [{ h: 10_000, rho: RHO.rock }, { h: 6_000, rho: RHO.basalt }], age: 50 },
  ];
  const S = stateFrom(set, e.tab, (i) => specs[i % specs.length].col);
  const tec = new Tectonics(gpu, set, e, S);
  tec.elevate();
  const out = await tec.read(), g = set.grid, fw = fieldWords(g), z = (i: number) => { const f = Math.floor(i / 65536), Y = Math.floor((i % 65536) / 256), X = i % 256; return out[FLD.Z * fw + wordAt(g, f, X, Y)]; };
  specs.forEach((sp, k) => {
    const want = archimedes(sp.layers, sp.age === undefined ? 0 : deficitAt(sp.age) * Math.min(1, (sp.layers.find((l) => l.rho === RHO.basalt)?.h ?? 0) / 6000));
    // the kernel's integer arithmetic is within a few m of the float law (heights are floored from volumes that were floored)
    for (let i = k; i < 6 * 65536; i += specs.length * 4001) expect(Math.abs(z(i) - want)).toBeLessThan(6);
  });
  // the cited numbers the law was built on: 35 km at sea level, 5.3 km for 70 km, young floor 2.5 km, 355 m a root My
  expect(Math.abs(archimedes([{ h: 35_000, rho: 2800 }]))).toBeLessThan(1e-9);
  expect(archimedes([{ h: 70_000, rho: 2800 }])).toBeCloseTo(5303, 0);
  const t = thermalTable();
  expect(t.length).toBe(PHYS.AGE_MAX + 1);
  const depth = (age: number) => { const th = t[Math.round(age / PHYS.AGE_UNIT_MY)]; return (PHYS.H0 * 500 - th - 6000 * 400) / (PHYS.RHO_M - PHYS.RHO_W); };
  expect(depth(0)).toBeCloseTo(2500, 0);
  expect((depth(100) - depth(25)) / (Math.sqrt(100) - Math.sqrt(25))).toBeCloseTo(355, 0);
  expect(depth(400)).toBeCloseTo(6400, 0);
  // the twin's law is the kernel's, word for word
  const twin = new Twin(set, e, S);
  twin.elev();
  for (let k = 0; k < fw; k++) if (out[FLD.Z * fw + k] !== twin.S[FLD.Z * fw + k]) throw new Error(`elevation differs from its twin at word ${k}`);
  // sea level is a parameter: the surface over it moves by exactly the level, and land shrinks as the sea rises
  const d0 = derive(set, e.tab, out), d1 = derive(makeSetup({ seed: 1, seaLevel: 3000 }), e.tab, out);
  for (let i = 0; i < d0.n; i += 997) expect(d0.height[i] - d1.height[i]).toBe(3000);
  expect(d1.land.reduce((a, b) => a + b, 0)).toBeLessThan(d0.land.reduce((a, b) => a + b, 0));
  tec.release();
}, 120_000);

// ---- the move ----
function blobState(set: Setup, tab: Tables, centreLL: [number, number], radiusRad: number) {
  const vec = cellVectors(set.grid), c = fromLatLon(centreLL[0], centreLL[1]);
  return stateFrom(set, tab, (i) => (Math.acos(Math.min(1, dot3([vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]], c))) < radiusRad ? { granitoid: 30_000, plate: 0 } : { basalt: 6_000, ageMy: 20, plate: 0 }));
}
const centroid = (set: Setup, S: Int32Array, field: number): V3 => {
  const g = set.grid, fw = fieldWords(g), vec = cellVectors(g);
  let x = 0, y = 0, z = 0;
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < g.fn; Y++)
      for (let X = 0; X < g.fn; X++) { const v = S[field * fw + wordAt(g, f, X, Y)] >>> 0, i = cellId(g, f, X, Y); x += v * vec[3 * i]; y += v * vec[3 * i + 1]; z += v * vec[3 * i + 2]; }
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
};

test("one plate: a rigid step conserves every volume to the unit and carries mass at the plate's speed", async () => {
  const pole = (() => { const v: V3 = [0.3, -0.5, 0.8], n = norm3(v); return [v[0] / n, v[1] / n, v[2] / n] as V3; })();
  const plate: Plate = { seed: [1, 0, 0], pole, speedMmYr: 40, rate: 0.02 };
  const set = makeSetup({ seed: 1, plates: 1, hotspots: 0 }, DEFAULT_SWEEPS, { plates: [plate], hotspots: [] }), e = ext(), gpu = await theGpu();
  const start = blobState(set, e.tab, [0.35, 0.7], 0.3), tec = new Tectonics(gpu, set, e, start);
  tec.piece("elev");
  const before = totals(set.grid, start), c0 = centroid(set, start, FLD.VB + 3), n = 20;
  for (let s = 0; s < n; s++) { tec.piece("elev"); tec.piece("claim"); tec.piece("deposit"); tec.piece("resolve"); }
  const S = await tec.read(), fl = await tec.fluxes(), after = totals(set.grid, S);
  // each of the five volumes unchanged but for the new basalt where the move left a bare cell and the cell's neighbour-sharing made none of: all of them exact
  for (const k of [1, 2, 3, 4]) expect(after[k]).toBe(before[k]);
  expect(after[0]).toBe(before[0] + fl[FLUX.NEW]);
  expect(fl[FLUX.SUB]).toBe(0n);
  // the leak of the move: a few cells whose coverage falls under 15/16 take new basalt; measured 3.5e-5 of the sea floor's basalt in 20 steps
  expect(Number(fl[FLUX.NEW]) / Number(before[0])).toBeLessThan(1e-4);
  // the granitoid's centre of mass has turned by the plate's rotation, n steps of it: within 0.5 km (measured 0.07 km after 20 steps of 77 km: the cloud in cell sharing keeps the first moment)
  const R = rotation(pole, 0.02 * set.params.stepMy * n), want: V3 = [R[0] * c0[0] + R[1] * c0[1] + R[2] * c0[2], R[3] * c0[0] + R[4] * c0[1] + R[5] * c0[2], R[6] * c0[0] + R[7] * c0[1] + R[8] * c0[2]];
  const got = centroid(set, S, FLD.VB + 3), errKm = (Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2]) * set.params.radius) / 1000;
  const movedKm = (Math.hypot(want[0] - c0[0], want[1] - c0[1], want[2] - c0[2]) * set.params.radius) / 1000;
  expect(movedKm).toBeGreaterThan(300);
  expect(errKm).toBeLessThan(0.5);
  // no plate is lost, no cell is bare
  expect(unpad(set.grid, S, FLD.PL).every((p) => p === 0)).toBe(true);
  tec.release();
}, 120_000);

// ---- boundaries by kinematics ----
// two plates about the pole of the planet, turning opposite ways: they close along the meridian of longitude 0 and part along 180
const ll = (lat: number, lon: number) => fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180);
const closing = (rate: number): Plate[] => [
  { seed: ll(0, -30), pole: [0, 0, 1], speedMmYr: rate * 2000, rate },
  { seed: ll(0, 30), pole: [0, 0, -1], speedMmYr: rate * 2000, rate },
];
function twoPlates(set: Setup, tab: Tables, west: (lat: number, lon: number) => boolean, ages: [number, number]) {
  const vec = cellVectors(set.grid);
  return stateFrom(set, tab, (i) => {
    const x: V3 = [vec[3 * i], vec[3 * i + 1], vec[3 * i + 2]], plate = x[1] <= 0 ? 0 : 1, { lat, lon } = latLon(x);
    if (plate === 0 && west((lat * 180) / Math.PI, (lon * 180) / Math.PI)) return { granitoid: 40_000, sediment: 1_000, plate };
    return { basalt: 6_000, sediment: Math.min(1000, 10 * ages[plate]), ageMy: ages[plate], plate };
  });
}

test("two plates meet: the overlap subducts what the gap makes, along the meridians the motion puts them", async () => {
  const rate = 0.015, set = makeSetup({ seed: 1, plates: 2, hotspots: 0, spanMy: 20 }, DEFAULT_SWEEPS, { plates: closing(rate), hotspots: [] }), e = ext(), gpu = await theGpu();
  const start = twoPlates(set, e.tab, () => false, [30, 100]);
  const tec = new Tectonics(gpu, set, e, start);
  tec.step();
  let S = await tec.read();
  const fl = await tec.fluxes(), g = set.grid;
  // the area the plates close over and part from in a step: 4 omega dt R^2 on each side (each plate moves omega dt R cos(lat) from the pole's axis)
  const area = 4 * rate * set.params.stepMy * (set.params.radius / 1000) ** 2, meanUnitKm3 = ((16 / 1000) * ((4 * Math.PI * (set.params.radius / 1000) ** 2) / (6 * 256 * 256))) / 2 ** 15;
  const expected = (area * 6) / meanUnitKm3;
  // measured 1.0003 and 0.9997 of it
  expect(Number(fl[FLUX.NEW]) / expected).toBeGreaterThan(0.97);
  expect(Number(fl[FLUX.NEW]) / expected).toBeLessThan(1.03);
  expect(Number(fl[FLUX.SUB]) / expected).toBeGreaterThan(0.97);
  expect(Number(fl[FLUX.SUB]) / expected).toBeLessThan(1.03);
  // subduction only where the plates close (longitude 0, x > 0), and the young floor only where they part (x < 0), each within the distance a plate moves in the step, and two cells, of the meridian plane
  const d = derive(set, e.tab, S), sub = unpad(g, S, FLD.SUB), vec = cellVectors(g), plane = Math.sin(rate * set.params.stepMy + 2 * g.width), yOf = (i: number) => vec[3 * i + 1];
  let nSub = 0, nYoung = 0, young0 = 0;
  for (let i = 0; i < d.n; i++) {
    const x = vec[3 * i];
    if (sub[i] > 0) { nSub++; expect(x).toBeGreaterThan(0); expect(Math.abs(yOf(i))).toBeLessThan(plane); }
    if (!d.continental[i] && d.ageMy[i] <= 3) { nYoung++; expect(x).toBeLessThan(0); expect(Math.abs(yOf(i))).toBeLessThan(plane); if (d.plate[i] === 0) young0++; }
  }
  expect(nSub).toBeGreaterThan(200);
  expect(nYoung).toBeGreaterThan(200);
  // the new floor is shared between the plates, about half and half
  expect(young0 / nYoung).toBeGreaterThan(0.35);
  expect(young0 / nYoung).toBeLessThan(0.65);
  // the younger floor rides over the older: the cells of the overlap are the younger plate's
  for (let i = 0; i < d.n; i++) if (sub[i] > 0) expect(d.plate[i]).toBe(0);
  // twenty My on: the books balance to the unit, and arcs have risen over the slab
  for (let s = 1; s < 10; s++) tec.step();
  S = await tec.read();
  const f2 = await tec.fluxes(), sum = (a: bigint[]) => a.reduce((s, x) => s + x, 0n);
  expect(sum(totals(g, S)) - sum(totals(g, start))).toBe(f2[FLUX.NEW] + f2[FLUX.ARC] + f2[FLUX.HOT] + f2[FLUX.PEL] - f2[FLUX.SUB] - f2[FLUX.TRIM]);
  expect(f2[FLUX.ARC]).toBeGreaterThan(0n);
  tec.release();
}, 120_000);

test("a continent rides over ocean floor: the sediment is scraped on, the arc rises about 150 km behind the trench, the books balance", async () => {
  const rate = 0.015, set = makeSetup({ seed: 1, plates: 2, hotspots: 0, spanMy: 24 }, DEFAULT_SWEEPS, { plates: closing(rate), hotspots: [] }), e = ext(), gpu = await theGpu();
  // plate 0 is a continent from longitude 80 W to 1 W (x > 0 is east of 0), plate 1 sea floor of 100 My with 1 km of sediment
  const start = twoPlates(set, e.tab, (_, lon) => lon > -80 && lon < -1, [30, 100]);
  const tec = new Tectonics(gpu, set, e, start), g = set.grid;
  for (let s = 0; s < 8; s++) tec.step();
  const before = derive(set, e.tab, await tec.read());
  tec.step();
  const S = await tec.read(), after = derive(set, e.tab, S), sub = unpad(g, S, FLD.SUB), vec = cellVectors(g);
  const trench: number[] = [];
  for (let i = 0; i < after.n; i++) if (sub[i] > 0) trench.push(i);
  expect(trench.length).toBeGreaterThan(100);
  // distance to the trench in cells: the great circle to the nearest trench cell
  const cellKm = (g.radius * g.width) / 1000;
  const distCells = (i: number) => {
    let b = -2;
    for (const j of trench) b = Math.max(b, vec[3 * i] * vec[3 * j] + vec[3 * i + 1] * vec[3 * j + 1] + vec[3 * i + 2] * vec[3 * j + 2]);
    return (Math.acos(Math.min(1, b)) * (g.radius / 1000)) / cellKm;
  };
  // the arc: granitoid gained in this step beyond the trench's own edge (where the moving continent's front shifts its rock, 7 cells) and
  // within 30 cells of it lies 8 to 16 cells from the nearest trench cell (125 km over a 40 degree slab is 149 km, 12 cells)
  let arcCells = 0, arcInBand = 0;
  for (let i = 0; i < after.n; i += 3) {
    if (after.pools[3][i] - before.pools[3][i] > 100 && Math.abs(vec[3 * i + 1]) < 0.3 && vec[3 * i] > -0.5) {
      const dc = distCells(i);
      if (dc <= 7 || dc > 30) continue;
      arcCells++;
      if (dc >= 8 && dc <= 16) arcInBand++;
    }
  }
  expect(arcCells).toBeGreaterThan(300);
  expect(arcInBand / arcCells).toBeGreaterThan(0.9);
  // the scraped sediment: metasediment appeared, and only on the plate that rode over
  let metaOn0 = 0, metaOn1 = 0;
  for (let i = 0; i < after.n; i++) if (after.pools[2][i] > 100) { if (after.plate[i] === 0) metaOn0++; else metaOn1++; }
  expect(metaOn0).toBeGreaterThan(100);
  expect(metaOn1).toBeLessThan(metaOn0 / 10);
  const f = await tec.fluxes(), sum = (a: bigint[]) => a.reduce((s, x) => s + x, 0n);
  expect(sum(totals(g, S)) - sum(totals(g, start))).toBe(f[FLUX.NEW] + f[FLUX.ARC] + f[FLUX.HOT] + f[FLUX.PEL] - f[FLUX.SUB] - f[FLUX.TRIM]);
  // the lithology classes by origin: granitoid shield inland, the scraped wedge metasedimentary, sea floor basalt
  expect(after.lith.includes(LITH.granitoid)).toBe(true);
  expect(after.lith.includes(LITH.basalt)).toBe(true);
  tec.release();
}, 120_000);

// ---- the kernels against their twins ----
test("the GPU kernels equal their twins bit for bit over steps, with arcs, a hot spot and crust over the limit", async () => {
  const sweeps = { gap: 4, smooth: 2, dist: 12, topple: 4 }, set = makeSetup({ seed: 2 }, sweeps), e = ext(), gpu = await theGpu(), start = startingState(set, e.tab);
  // pile 120 km of granitoid on a patch of cells so that the flow and the cut have something to do
  const g = set.grid, fw = fieldWords(g), S0 = start.S.slice();
  for (let Y = 100; Y < 108; Y++)
    for (let X = 100; X < 108; X++) {
      const at = wordAt(g, 0, X, Y), a = e.tab.words[Y * 256 + X];
      S0[(FLD.VB + 3) * fw + at] = Math.floor((120_000 * a) / 16);
    }
  const tec = new Tectonics(gpu, set, e, S0), twin = new Twin(set, e, S0), steps = 3;
  for (let s = 0; s < steps; s++) tec.step();
  const G = await tec.read(), fg = await tec.fluxes();
  for (let s = 0; s < steps; s++) twin.step(s);
  for (let f = 0; f < FLD.COUNT; f++) {
    let bad = 0;
    for (let k = 0; k < fw; k++) if (G[f * fw + k] !== twin.S[f * fw + k]) bad++;
    expect(bad).toBe(0);
  }
  expect(fg).toEqual(twin.flux);
  // every kind of flux was exercised
  for (const k of [FLUX.NEW, FLUX.SUB, FLUX.ARC, FLUX.HOT, FLUX.PEL, FLUX.TRIM]) expect(fg[k]).toBeGreaterThan(0n);
  tec.release();
}, 280_000);

// ---- runs ----
// Pinned by a deliberate re-record (the sha256 of the five volumes, both age sums and the plate field after 100 steps of 2 My).
const GOLDEN: Record<number, string> = {
  1: "f51e247aa6b638584c467081f3415c9c5495caa13c440415ce07491e9215df5d",
  2: "11d5563f17a77e0435bdca36d6c96d5b2baec06e5b4a31b29cd6b9bd6f1a2aa0",
  3: "8e7b482e906db36ca57041caeeadbeb3d468e33ffc56abeef369adb54bf88e5c",
};

test("a run is the same twice, and its hash is pinned for seeds 1 to 3", async () => {
  const gpu = await theGpu(), seen: Record<number, string> = {};
  for (const seed of [1, 2, 3]) {
    const set = makeSetup({ seed }), a = await runPlanet(gpu, set);
    seen[seed] = hash(a.S);
    if (seed === 1) expect(hash((await runPlanet(gpu, set)).S)).toBe(seen[seed]);
  }
  console.log("hashes", JSON.stringify(seen));
  for (const seed of [1, 2, 3]) expect(seen[seed]).toBe(GOLDEN[seed]);
}, 280_000);

test("ranges rise where the plates close and new floor opens where they part, by the poles' own relative velocity", async () => {
  // At the start the plates are the Voronoi cells and the boundaries are known by relative velocity alone (classifyBoundaries, float); after 12 My they have moved
  // under 200 km, so what rose over 2 km above sea level should lie near a convergent boundary and new floor near a divergent one, against the shares of the planet that lie near them.
  // Hot spots are left out: they raise terrain anywhere by design.
  const gpu = await theGpu(), rows: string[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const set = makeSetup({ seed, hotspots: 0, spanMy: 12 }), e = extTables(set.grid), start = startingState(set, e.tab), fw = fieldWords(set.grid);
    // every floor starts 100 My old, so that floor under 13 My old was made in the run
    for (let k = 0; k < fw; k++) start.S[FLD.AGB * fw + k] = (start.S[FLD.VB * fw + k] >> PHYS.AGE_SHIFT) * Math.round(100 / PHYS.AGE_UNIT_MY);
    const tec = new Tectonics(gpu, set, e, start.S);
    tec.elevate();
    const d0 = derive(set, e.tab, await tec.read());
    for (let s = 0; s < set.steps; s++) tec.step();
    tec.elevate();
    const d1 = derive(set, e.tab, await tec.read()), bd = classifyBoundaries(set.grid, start.plate, set.plates);
    const near = (cls: number) => distanceFrom(set.grid, bd.cls.map((c) => (c === cls ? 1 : 0)), 30);
    const nc = near(BOUNDARY.convergent), nd = near(BOUNDARY.divergent);
    let raised = 0, raisedC = 0, raisedD = 0, allC = 0, allD = 0, young = 0, youngD = 0;
    for (let i = 0; i < d0.n; i++) {
      if (nc[i] >= 0) allC++;
      if (nd[i] >= 0) allD++;
      if (d1.height[i] > RANGE_Z_M && d0.height[i] <= RANGE_Z_M) { raised++; if (nc[i] >= 0) raisedC++; if (nd[i] >= 0) raisedD++; }
      if (!d1.continental[i] && d1.pools[0][i] > 0 && d1.ageMy[i] <= set.params.spanMy + 1) { young++; if (nd[i] >= 0) youngD++; }
    }
    rows.push(`seed ${seed}: ${raised} cells rose over 2 km above sea level, ${(100 * raisedC / raised).toFixed(0)}% within 370 km of a convergent boundary (${(100 * allC / d0.n).toFixed(0)}% of the planet is), ${(100 * raisedD / raised).toFixed(0)}% within 370 km of a divergent one (${(100 * allD / d0.n).toFixed(0)}%); ${young} cells of new floor, ${(100 * youngD / young).toFixed(0)}% within 370 km of a divergent boundary`);
    expect(raised).toBeGreaterThan(300);
    // the lift of the share near a boundary over the share of the planet near it: convergent boundaries raise ranges, divergent ones do not (the windows overlap where
    // boundaries of both kinds are near each other, so divergent lift is not zero)
    const liftC = raisedC / raised / (allC / d0.n), liftD = raisedD / raised / (allD / d0.n);
    expect(liftC).toBeGreaterThan(1.5);
    expect(liftC).toBeGreaterThan(1.4 * liftD);
    expect(youngD / young).toBeGreaterThan(0.95);
    tec.release();
  }
  console.log(rows.join("\n"));
}, 200_000);

test("sea floor made in the run is no older than the run", async () => {
  const gpu = await theGpu(), set = makeSetup({ seed: 4 }), e = extTables(set.grid), start = startingState(set, e.tab), fw = fieldWords(set.grid);
  // every floor starts at age zero
  start.S.fill(0, FLD.AGB * fw, (FLD.AGB + 1) * fw);
  const planet = await runPlanet(gpu, set, undefined, start), d = derive(set, e.tab, planet.S);
  let max = 0, n = 0, sum = 0;
  for (let i = 0; i < d.n; i++) if (!d.continental[i] && d.pools[0][i] > 0) { max = Math.max(max, d.ageMy[i]); sum += d.ageMy[i]; n++; }
  expect(max).toBeLessThanOrEqual(set.params.spanMy);
  // the floor is a mix of what the run made at ridges: its mean age is under half the run and over a tenth of it
  expect(sum / n).toBeLessThan(set.params.spanMy / 2);
  expect(sum / n).toBeGreaterThan(set.params.spanMy / 10);
}, 100_000);

test("seeds 1 to 8: books balance, thickness stays inside the physical bounds, land and ranges are where the processes put them", async () => {
  const gpu = await theGpu(), rows: string[] = [];
  for (let seed = 1; seed <= 8; seed++) {
    const set = makeSetup({ seed }), e = extTables(set.grid), planet = await runPlanet(gpu, set), m = measure(set, e.tab, planet);
    rows.push(`seed ${seed}: land ${m.landStart.toFixed(3)} -> ${m.land.toFixed(3)}, continents ${m.continentsStart} -> ${m.continents}, longest range ${Math.round(m.longestRangeKm)} km, above 2 km ${(100 * m.rangeShare).toFixed(1)}% of the planet (${(100 * m.rangeNearConvergent).toFixed(0)}% of it within 150 km of a convergent boundary, as ${(100 * m.nearConvergentBaseline).toFixed(0)}% of all cells are), over 2 km on ${(100 * m.highAtBoundary.convergent).toFixed(0)}% of convergent, ${(100 * m.highAtBoundary.divergent).toFixed(0)}% of divergent and ${(100 * m.highAtBoundary.transform).toFixed(0)}% of transform boundary cells, sea floor age median ${m.ageMedianMy} My, max ${m.ageMaxMy} My, ${(100 * m.olderThan200).toFixed(1)}% over 200 My, thickness ${Math.round(m.thicknessMin)} to ${Math.round(m.thicknessMax)} m`);
    // the books: the change in the five volumes is the fluxes' account, to the unit
    expect(m.residual).toBe(0n);
    // crust and sediment: under the limit, over nothing
    expect(m.thicknessMax).toBeLessThanOrEqual(PHYS.H_MAX + 50);
    expect(m.thicknessMin).toBeGreaterThan(0);
    // no cell without a plate
    expect(m.unplated).toBe(0);
    // sea floor is no older than the oldest floor of the start plus the span
    expect(m.ageMaxMy).toBeLessThanOrEqual(200 + set.params.spanMy);
    // land fraction in the band the research states: Earth's 29% (R1411 app. B) within a factor of two either way
    expect(m.land).toBeGreaterThan(0.145);
    expect(m.land).toBeLessThan(0.58);
    expect(m.continents).toBeGreaterThanOrEqual(1);
  }
  console.log(rows.join("\n"));
}, 290_000);
