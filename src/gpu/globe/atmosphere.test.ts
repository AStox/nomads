// The globe's atmosphere (atmosphere.ts, wgsl/globe-atmosphere.ts) on synthetic planets, tested one case at a time:
//   bun test ./src/gpu/globe/atmosphere.test.ts -t "ridge" --timeout 280000
// The laws' cases need no GPU (insolation, the energy balance against its analytic modes, Held and Hou's edge, the saturation
// column). The kernel case compares every entry point with its TypeScript twin bit for bit. The planet cases build a height
// field from latitude and longitude only (synthetic.ts) and read what the research notes say should come out: the belts of an
// ocean planet, the rain shadow of a ridge with the water budget closed, temperature against latitude and height on two
// continents, a mild west coast, tilt 0 and tilt 90, and the same bytes on a second run. The measured numbers the cases state
// are in docs/research/globe/2026-10-19-atmosphere-impl.md.
import { afterAll, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { locate, tierGrid, cellId } from "./grid";
import { NODE_DEG } from "../wgsl/globe-atmosphere";
import {
  AtmosphereGpu, BANDS, EBM, FIELD, GAMMA, ICE_K, ICE_L, ICE_RHO, SEASON_S, SEASONS, T_FREEZE, buildGeometry, capAt, capTable, circulationOf, climateGpu, edgesTwin, declination, finishTwin, heldHouEdge,
  insolation, mulShr, planetOf, prepTwin, solveEbm, stepTwin, windTable, type Climate, type Ctx, type PlanetParams, type ClimateOptions,
} from "./atmosphere";
import { oceanPlanet, ridgePlanet, twoContinents, westerlyContinent } from "./synthetic";

afterAll(releaseGpu);

const DEG = Math.PI / 180, grid = tierGrid(0), geo = buildGeometry(grid);
const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

// ---- cached runs: a planet's climate is made once and read by several cases ----
const runs = new Map<string, Promise<Climate>>();
function climateOf(key: string, height: () => Float32Array, planet: Partial<PlanetParams> = {}, opts: ClimateOptions = {}) {
  let r = runs.get(key);
  if (!r) runs.set(key, (r = theGpu().then((g) => climateGpu(g, grid, height(), planet, opts))));
  return r;
}
const ocean = () => climateOf("ocean", () => oceanPlanet(geo));
const ridge = () => climateOf("ridge", () => ridgePlanet(geo));
const continents = () => climateOf("continents", () => twoContinents(geo));
const westerly = () => climateOf("westerly", () => westerlyContinent(geo));

// The area-weighted mean of a field over the cells whose latitude lies in [lo, hi) degrees.
function band(f: ArrayLike<number>, lo: number, hi: number, keep: (i: number) => boolean = () => true) {
  let s = 0, w = 0;
  for (let i = 0; i < geo.n; i++) {
    const la = geo.lat[i] / DEG;
    if (la >= lo && la < hi && keep(i)) { s += geo.area[i] * f[i]; w += geo.area[i]; }
  }
  return w > 0 ? s / w : NaN;
}
const annual = (c: Climate, f: (s: Climate["seasons"][number]) => ArrayLike<number>) => Float32Array.from({ length: geo.n }, (_, i) => c.seasons.reduce((a, s) => a + f(s)[i], 0) / 4);
const cellAtLatLon = (lat: number, lon: number) => { const p = locate(grid, lat * DEG, lon * DEG); return cellId(grid, p.face, p.X, p.Y); };
const bytes = (f: Float32Array) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
const golden = (c: Climate) => Bun.hash(Buffer.concat(c.seasons.flatMap((s) => [s.insolation, s.temperature, s.windE, s.windN, s.sst, s.ice, s.rain, s.snow, s.evaporation, s.runoff, s.column].map(bytes)))).toString(16);

// ---- insolation ----
test("insolation: the sphere's mean is S0 over 4, tilt 0 is S0 cos(phi) over pi, polar night is dark, and the annual mean has Earth's P2 term", () => {
  const S0 = 1366;
  // a year's mean over latitude (area) and the orbit's longitude (time)
  let mean = 0, w = 0;
  for (let k = 0; k < 720; k++) {
    const delta = declination((k + 0.5) / 2, 23.44);
    for (let j = 0; j < 360; j++) { const phi = ((j + 0.5) / 2 - 90) * DEG; mean += insolation(phi, delta, S0) * Math.cos(phi); w += Math.cos(phi); }
  }
  expect(mean / w).toBeCloseTo(S0 / 4, 0);
  for (const deg of [0, 30, 60, 85]) expect(insolation(deg * DEG, 0, S0)).toBeCloseTo((S0 * Math.cos(deg * DEG)) / Math.PI, 9);
  expect(insolation(80 * DEG, -23.4 * DEG, S0)).toBe(0);
  expect(insolation(-80 * DEG, 23.4 * DEG, S0)).toBe(0);
  // the pole at midsummer of a planet tilted 90 degrees gets the whole constant [derived: h0 = pi, delta = pi/2]
  expect(insolation(89.99 * DEG, 90 * DEG, S0)).toBeCloseTo(S0, 0);
  // the annual mean as a series in Legendre polynomials of x = sin(phi): s2 = (5/2) integral S P2 dx, Earth's -0.477 [cited, R1437]
  let s2 = 0;
  const nx = 2000;
  for (let j = 0; j < nx; j++) {
    const x = -1 + (2 * (j + 0.5)) / nx, phi = Math.asin(x);
    let q = 0;
    for (let k = 0; k < 360; k++) q += insolation(phi, declination(k + 0.5, 23.44), S0) / 360;
    s2 += (2.5 * (q / (S0 / 4)) * 0.5 * (3 * x * x - 1) * 2) / nx;
  }
  expect(s2).toBeGreaterThan(-0.49);
  expect(s2).toBeLessThan(-0.465);
});

// ---- the energy balance ----
// A planet of Earth's size with a bright sun (no ice anywhere), no land: the annual mean of a linear balance has the exact
// modes T0 = (co-albedo S0/4 - A) / B and T_n = H_n / (B + n (n + 1) D) (North et al. 1981, R1437): the implicit tridiagonal
// solve and the band operator against the analytic answer.
test("energy balance: the annual mean has North's modes T0 and T2 to a percent, the global balance closes and the periodic state is reached", () => {
  const p = planetOf({ radius: 6.371e6, solar: 2000 });
  const ebm = solveEbm(p, new Float64Array(BANDS));
  expect(ebm.diffusion).toBeCloseTo(EBM.D_EARTH, 12);
  const x = Array.from(ebm.phi, (v) => Math.sin(v)), w = ebm.weight;
  const mean = ebm.mean.reduce((a, s) => a.map((v, k) => v + s[k] / 4), new Float64Array(BANDS)), q = ebm.insolation.reduce((a, s) => a.map((v, k) => v + s[k] / 4), new Float64Array(BANDS));
  const proj = (f: ArrayLike<number>, n: number) => { let s = 0; for (let k = 0; k < BANDS; k++) s += w[k] * f[k] * (n === 0 ? 1 : 0.5 * (3 * x[k] * x[k] - 1)); return s * (n === 0 ? 1 : 5); };
  const T0 = proj(mean, 0), T2 = proj(mean, 2), Q0 = proj(q, 0), Q2 = proj(q, 2);
  expect(Q0).toBeGreaterThan(1999 / 4);
  expect(Q0).toBeLessThan(2001 / 4);
  expect(Math.abs(T0 - (EBM.CO_FREE * Q0 - EBM.A) / EBM.B)).toBeLessThan(0.05);
  const T2exact = (EBM.CO_FREE * Q2) / (EBM.B + 6 * EBM.D_EARTH);
  expect(Math.abs(T2 / T2exact - 1)).toBeLessThan(0.02);
  // the year's net flux into the surface columns and the drift over the last year, at the planet's own D
  const planet = solveEbm(planetOf(), new Float64Array(BANDS));
  expect(planet.diffusion).toBeCloseTo((EBM.D_EARTH * 6.371e6) / 2e6, 9);
  expect(Math.abs(planet.balance)).toBeLessThan(0.02);
  expect(planet.drift).toBeLessThan(1e-3);
});

test("energy balance: land swings far more than the sea, the zonal mean falls poleward, and no seasons at tilt 0", () => {
  const frac = new Float64Array(BANDS).fill(0.5), ebm = solveEbm(planetOf(), frac);
  const swing = (t: Float64Array[], k: number) => Math.max(...t.map((s) => s[k])) - Math.min(...t.map((s) => s[k]));
  const k45 = 135 + 0;
  // the cited ratio of a column's seasonal amplitudes, land to sea, is 21 before any transport across the coast (R1437, derived)
  const ratio = swing(ebm.land, k45) / swing(ebm.sea, k45);
  expect(ratio).toBeGreaterThan(4);
  expect(ratio).toBeLessThan(25);
  const annualMean = ebm.mean.reduce((a, s) => a.map((v, k) => v + s[k] / 4), new Float64Array(BANDS));
  for (let k = BANDS / 2; k < BANDS - 1; k++) expect(annualMean[k + 1]).toBeLessThan(annualMean[k]);
  const flat = solveEbm(planetOf({ tiltDeg: 0 }), frac);
  // the same forcing every step: the seasons agree to the periodic state's last digits (1e-12 K)
  for (let s = 1; s < 4; s++) for (let k = 0; k < BANDS; k++) { expect(Math.abs(flat.land[s][k] - flat.land[0][k])).toBeLessThan(1e-9); expect(Math.abs(flat.sea[s][k] - flat.sea[0][k])).toBeLessThan(1e-9); }
});

// ---- the circulation ----
test("circulation: Held and Hou's edge is the note's 28.8 degrees for Earth and 59 for the planet, and the torque law balances", () => {
  const edge = (R: number) => heldHouEdge(R) / DEG;
  const earth = (9.81 * 15000 * (80 / 295)) / (7.292e-5 ** 2 * 6.371e6 ** 2);
  expect(earth).toBeCloseTo(0.185, 3);
  expect(edge(earth)).toBeGreaterThan(28.6);
  expect(edge(earth)).toBeLessThan(29.0);
  // the small-angle limit (5R/3)^(1/2) [cited]
  expect(Math.sin(heldHouEdge(0.001))).toBeCloseTo(Math.sqrt((5 * 0.001) / 3), 3);
  const c = circulationOf(planetOf());
  expect(c.groupR).toBeCloseTo(1.88, 1);
  expect(c.heldHou / DEG).toBeGreaterThan(59);
  expect(c.heldHou / DEG).toBeLessThan(59.8);
  expect(c.eddy / DEG).toBeGreaterThan(53);
  expect(c.eddy / DEG).toBeLessThan(54);
  expect(c.hadley).toBe(c.eddy);
  // Earth's day and radius give the 30 degree eddy edge exactly (the calibration) and the equal-area edge under it
  const e = circulationOf(planetOf({ radius: 6.371e6, dayS: (2 * Math.PI) / 7.292e-5 }));
  expect(e.eddy / DEG).toBeCloseTo(30, 9);
  expect(e.hadley / DEG).toBeLessThan(29);
  // the surface torque: the stress (speed squared, signed by the wind) weighted by cos^2 phi integrates to zero over the lobes
  let torque = 0, scale = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * (Math.PI / 2);
    const lobe = t < c.hadley ? -c.uTrade * Math.sin((Math.PI * t) / c.hadley) : t < c.polarFront ? c.uWest * Math.sin((Math.PI * (t - c.hadley)) / (c.polarFront - c.hadley)) : -c.uPolar * Math.sin((Math.PI * (t - c.polarFront)) / (Math.PI / 2 - c.polarFront));
    torque += Math.sign(lobe) * lobe * lobe * Math.cos(t) ** 2; scale += lobe * lobe * Math.cos(t) ** 2;
  }
  expect(Math.abs(torque / scale)).toBeLessThan(2e-3);
  // the winds: trades blow west and toward the equator, westerlies east and poleward, polar easterlies west and equatorward
  const wt = windTable(planetOf(), c, 0), at = (deg: number) => Math.round((deg + 90) / NODE_DEG);
  expect(wt.u[at(20)]).toBeLessThan(0);
  expect(wt.v[at(20)]).toBeLessThan(0);
  expect(wt.u[at(-20)]).toBeLessThan(0);
  expect(wt.v[at(-20)]).toBeGreaterThan(0);
  expect(wt.u[at(63)]).toBeGreaterThan(0);
  expect(wt.v[at(63)]).toBeGreaterThan(0);
  expect(wt.v[at(-63)]).toBeLessThan(0);
  expect(wt.u[at(82)]).toBeLessThan(0);
  expect(wt.v[at(82)]).toBeLessThan(0);
});

// ---- the saturation column ----
test("saturation: Tetens' pressure, Clausius-Clapeyron's 7% a kelvin and the note's column of 15 mm at 10 C", () => {
  const cap = capTable(), ctx = { T: cap } as unknown as Ctx;
  const col = (t: number) => capAt(ctx, Math.round(t * 65536)) / 2 ** 20;
  // 5,417 e_s / T: e_s 1.228 kPa at 10 C is 23.5 mm, and 0.65 of it is the note's 15 mm [derived]
  expect(col(10)).toBeGreaterThan(23.3);
  expect(col(10)).toBeLessThan(23.7);
  expect(col(10) * 0.65).toBeGreaterThan(15);
  expect(col(10) * 0.65).toBeLessThan(15.6);
  // 7.3% a kelvin at 0 C and 6.3% at 20 C in the vapour pressure (R1436); the column also has the 1/T of the gas law, 0.35% a K less
  const rate = (t: number) => col(t + 0.5) / col(t - 0.5) - 1;
  expect(rate(0)).toBeGreaterThan(0.065);
  expect(rate(0)).toBeLessThan(0.076);
  expect(rate(20)).toBeGreaterThan(0.056);
  expect(rate(20)).toBeLessThan(0.066);
  for (let i = 0; i + 1 < cap.length; i++) expect(cap[i + 1]).toBeGreaterThanOrEqual(cap[i]);
  expect(cap[0]).toBe(0);
});

// ---- the grid's geometry ----
test("geometry: neighbours are mutual, link normals are unit and opposite, and an edge wind computed from either side is the same", () => {
  const n = geo.n;
  let worst = 0;
  for (let id = 0; id < n; id += 7) for (let d = 0; d < 4; d++) {
    const j = geo.nbr[id * 4 + d];
    let back = -1;
    for (let b = 0; b < 4; b++) if (geo.nbr[j * 4 + b] === id) back = b;
    expect(back).toBeGreaterThanOrEqual(0);
    const o = (8 * n) + (id * 4 + d) * 4, ob = (8 * n) + (j * 4 + back) * 4, G = geo.gdata;
    expect(G[ob] + G[o + 2]).toBe(0); expect(G[ob + 1] + G[o + 3]).toBe(0); expect(G[ob + 2] + G[o]).toBe(0); expect(G[ob + 3] + G[o + 1]).toBe(0);
    const len = Math.hypot(G[o], G[o + 1]) / 16384;
    worst = Math.max(worst, Math.abs(len - 1));
    // the link's length times the wind: a_i * (L / a_i) = a_j * (L / a_j) to the table's rounding
    const li = (G[4 * n + id * 4 + d] / 2 ** 28) * geo.area[id], lj = (G[4 * n + j * 4 + back] / 2 ** 28) * geo.area[j];
    expect(Math.abs(li / lj - 1)).toBeLessThan(2e-4);
  }
  expect(worst).toBeLessThan(0.02);
  // the cells' areas sum to the sphere
  expect(Math.abs(sum(geo.area) / (4 * Math.PI * grid.radius ** 2) - 1)).toBeLessThan(1e-10);
  // the least distance of a latitude fraction (Q16 words) from a rounding tie: a double's error in the latitude of a few units in
  // the last place moves a fraction by under 1e-7 of a word, so none rounds the other way on another engine [derived]
  expect(geo.margin).toBeGreaterThan(1e-6);
});

// ---- the kernels against their twins ----
test("kernels: prep, edges, step (twice, then with the accumulators) and finish equal their twins bit for bit", async () => {
  const g = await theGpu();
  const a = await AtmosphereGpu.make(g, grid, ridgePlanet(geo), {});
  try {
    const n = a.n, pick = new Set<number>();
    for (let i = 0; i < n; i += 13) pick.add(i);
    for (let i = 0; i < n; i++) if (a.land[i] || i % 29 === 0) pick.add(i);
    const ids = [...pick];
    const same = (ctx: Ctx, S2: Int32Array, fields: number[], what: string) => {
      for (const id of ids) for (const f of fields) if (S2[f * n + id] !== ctx.S[f * n + id]) throw new Error(`${what}: field ${f} of cell ${id}: kernel ${ctx.S[f * n + id]} twin ${S2[f * n + id]}`);
    };
    a.loadSeason(1);
    const ctx0 = await a.snapshot(0);
    // prep: the twin starts from the planet fields and the tables, the kernel's other words are not read by it
    const t0 = { ...ctx0, S: Int32Array.from(ctx0.S) };
    a.run("prep");
    const afterPrep = await a.snapshot(0);
    for (const id of ids) prepTwin(t0, id);
    same(afterPrep, t0.S, [FIELD.U, FIELD.V, FIELD.U0, FIELD.V0, FIELD.TS, FIELD.SST, FIELD.INS, FIELD.LAP, FIELD.FE, FIELD.MSAT, FIELD.FC, FIELD.FF, FIELD.ICE, ...[0, 1, 2, 3, 4].map((q) => FIELD.ST + q), FIELD.PACC], "prep");
    // edges: from the kernel's winds (all cells' winds are read, a neighbour's too)
    const t1 = { ...afterPrep, S: Int32Array.from(afterPrep.S) };
    a.run("edges");
    const afterEdges = await a.snapshot(0);
    for (const id of ids) edgesTwin(t1, id);
    same(afterEdges, t1.S, [0, 1, 2, 3].map((d) => FIELD.R + d), "edges");
    const dt = await a.chooseStep();
    // step, from the kernel's rates; the twin reads the state set the kernel read
    let prev = await a.snapshot(0);
    prev.dt = dt;
    for (let s = 0; s < 3; s++) {
      const par = s & 1, acc = s === 2;
      a.run("step", par, acc ? 1 : 0, 1);
      const next = await a.snapshot(1 - par);
      const t = { ...prev, S: Int32Array.from(prev.S), par, dt, acc };
      for (const id of ids) stepTwin(t, id);
      same(next, t.S, [0, 1, 2, 3, 4].map((q) => FIELD.ST + 5 * (1 - par) + q), `step ${s}`);
      if (acc) same(next, t.S, [FIELD.PACC, FIELD.EACC, FIELD.RACC], "step accumulators");
      prev = { ...next, dt, par: 1 - par };
    }
    a.run("finish", prev.par, 0);
    const done = await a.snapshot(prev.par);
    const tf = { ...prev, S: Int32Array.from(prev.S) };
    for (const id of ids) finishTwin(tf, id);
    same(done, tf.S, [FIELD.TN, FIELD.SNOW], "finish");
    expect(ids.length).toBeGreaterThan(30000);
  } finally { a.release(); }
});

test("mulShr: the kernel's 64-bit product shifted and rounded half away from zero, against exact integers", () => {
  expect(mulShr(3, 5, 1)).toBe(8);
  expect(mulShr(-3, 5, 1)).toBe(-8);
  expect(mulShr(1, 1, 1)).toBe(1);
  expect(mulShr(-1, 1, 1)).toBe(-1);
  expect(mulShr(2 ** 27, 2 ** 29, 30)).toBe(2 ** 26);
  expect(mulShr(123456789, 987654321, 30)).toBe(Math.round((123456789 * 987654321) / 2 ** 30));
});

// ---- the planets ----
test("ocean planet: wet at the equator and the polar front, dry at the Hadley edge, winds that reverse across it, temperature falling poleward", async () => {
  const c = await ocean(), circ = c.circulation;
  const edge = circ.hadley / DEG, front = circ.polarFront / DEG;
  const rain = annual(c, (s) => s.rain), mmDay = (v: number) => (v / 365.25) * 4;
  const prof: number[] = [];
  for (let la = 0; la < 90; la += 2) prof.push(mmDay(band(rain, la, la + 2)));
  const peak = Math.max(...prof.slice(0, 16)), itcz = prof.indexOf(peak) * 2 + 1;
  // the wet belts and the dry one, in degrees [the note's expectation for this planet: dry at the cell edge near 45 to 59]
  console.log(`ocean: Hadley ${edge.toFixed(1)}, polar front ${front.toFixed(1)}; rain mm/day by 2 degrees ${prof.map((v) => v.toFixed(2)).join(" ")}; ITCZ peak ${peak.toFixed(2)} at ${itcz}`);
  expect(itcz).toBeLessThan(12);
  const dry = (la: number) => mmDay(band(rain, la, la + 2));
  expect(dry(Math.round(edge))).toBeLessThan(0.35 * peak);
  const storm = Math.max(...prof.slice(Math.floor(edge / 2), 45));
  expect(storm).toBeGreaterThan(dry(Math.round(edge)));
  // the winds reverse across the cell's edge: east-west and north-south
  const u = annual(c, (s) => s.windE), v = annual(c, (s) => s.windN);
  expect(band(u, edge - 10, edge - 6)).toBeLessThan(0);
  expect(band(u, edge + 4, edge + 8)).toBeGreaterThan(0);
  expect(band(v, edge - 10, edge - 6)).toBeLessThan(0);
  expect(band(v, edge + 4, edge + 8)).toBeGreaterThan(0);
  expect(band(u, front + 4, front + 12)).toBeLessThan(0);
  // temperature falls poleward on the annual mean everywhere and in every season poleward of 25 degrees (the sun's own latitude
  // moves the warmest band off the equator in a season); the two hemispheres are mirrors on the annual mean
  const tn = annual(c, (s) => s.temperature);
  for (let la = 0; la < 85; la += 5) expect(band(tn, la + 5, la + 10)).toBeLessThan(band(tn, la, la + 5) + 1e-3);
  for (const s of c.seasons) for (const sign of [1, -1]) {
    const t: number[] = [];
    for (let la = 25; la < 90; la += 5) t.push(sign > 0 ? band(s.temperature, la, la + 5) : band(s.temperature, -la - 5, -la));
    for (let k = 0; k + 1 < t.length; k++) expect(t[k + 1]).toBeLessThan(t[k] + 0.01);
  }
  for (let la = 5; la < 85; la += 10) expect(Math.abs(band(tn, la, la + 5) - band(tn, -la - 5, -la))).toBeLessThan(0.3);
  expect(Math.abs(mmDay(band(rain, 5, 15)) - mmDay(band(rain, -15, -5))) / mmDay(band(rain, 5, 15))).toBeLessThan(0.05);
});

test("ridge: rain on the windward slope, a rain shadow in the lee, water conserved and the rain no more than the air supplies", async () => {
  const g = await theGpu();
  const a = await AtmosphereGpu.make(g, grid, ridgePlanet(geo), {});
  try {
    const out = await a.season(1, {});
    const n = a.n, R = grid.radius, lat = 60;
    const at = (km: number, dl = 0) => cellAtLatLon(lat + dl, 90 + (km * 1000) / (R * Math.cos(lat * DEG)) / DEG);
    const mean = (f: Float32Array, km0: number, km1: number) => { let s = 0, k = 0; for (let dl = -1; dl <= 1; dl += 0.5) for (let km = km0; km <= km1; km += 12) { s += f[at(km, dl)]; k++; } return s / k; };
    const row: string[] = [];
    for (let km = -600; km <= 600; km += 100) row.push(`${km}:${mean(out.rain, km - 12, km + 12).toFixed(0)}`);
    console.log(`ridge rain mm/season, km east of the crest at 60 N: ${row.join(" ")}`);
    const upwind = mean(out.rain, -500, -300), windward = mean(out.rain, -150, -50), crest = mean(out.rain, -12, 12), lee = mean(out.rain, 50, 150), farLee = mean(out.rain, 300, 500);
    console.log(`ridge: upwind ${upwind.toFixed(0)}, windward ${windward.toFixed(0)}, crest ${crest.toFixed(0)}, lee ${lee.toFixed(0)}, far lee ${farLee.toFixed(0)}; shadow ratio lee/windward ${(lee / windward).toFixed(3)}`);
    // the ridge is a 3 km barrier, so the air that arrives at 40% of saturation (see the impl note) is lifted past it: rain
    // above 100 mm a season on its windward slope against none upwind, a shadow behind it [validation F2: the lee under half]
    expect(upwind).toBeLessThan(1);
    expect(windward).toBeGreaterThan(100);
    expect(lee).toBeLessThan(0.5 * windward);
    expect(farLee).toBeLessThan(0.5 * windward);
    // water: what the sea gave less what fell equals the change in the air's store over the window, to half a percent of the
    // evaporation (the links' rates are rounded to Q28 per cell, 4e-5 each [derived])
    const b = out.budget;
    console.log(`ridge budget over the window: evaporated ${b.evaporated.toExponential(4)}, rained ${b.rained.toExponential(4)}, held ${b.held0.toExponential(4)} to ${b.held1.toExponential(4)}`);
    expect(Math.abs(b.evaporated - b.rained - (b.held1 - b.held0)) / b.evaporated).toBeLessThan(0.005);
    // the column holds no more than the air's saturation (to the change of the temperature in one step, under 0.001 mm), and no
    // cell rains more than what arrives and evaporates there
    const par = (out.spinSteps + out.windowSteps) & 1, final = await a.snapshot(par), fa = FIELD.ST + 5 * par, S = final.S;
    let over = 0, worst = 0;
    const secs = out.windowSteps * out.dt;
    for (let i = 0; i < n; i++) {
      const cap = capAt(final, S[fa * n + i] - S[FIELD.LAP * n + i]);
      over = Math.max(over, S[(fa + 1) * n + i] - cap);
      let supply = S[FIELD.EACC * n + i] / secs;
      for (let d = 0; d < 4; d++) { const r = S[(FIELD.R + d) * n + i]; if (r < 0) { const j = geo.nbr[i * 4 + d]; supply += (-r / 2 ** 30) * (S[(fa + 1) * n + j] + S[(fa + 2) * n + j] + S[(fa + 3) * n + j]); } }
      worst = Math.max(worst, S[FIELD.PACC * n + i] / secs - 1.05 * supply - 1);
    }
    console.log(`ridge: the column exceeds saturation by at most ${(over / 2 ** 20).toExponential(2)} mm`);
    expect(over).toBeLessThan(2 ** 20 / 1000);
    expect(worst).toBeLessThanOrEqual(0);
  } finally { a.release(); }
});

test("ridge: from an unsettled start the air's store is carried on and the water still closes", async () => {
  const g = await theGpu();
  const a = await AtmosphereGpu.make(g, grid, ridgePlanet(geo), {});
  try {
    const out = await a.season(1, { spinDays: 1, windowDays: 1 });
    const b = out.budget, carried = b.held1 - b.held0;
    console.log(`ridge, first days: evaporated ${b.evaporated.toExponential(4)}, rained ${b.rained.toExponential(4)}, carried on ${carried.toExponential(4)} m3`);
    expect(carried).toBeGreaterThan(0.05 * b.evaporated);
    expect(Math.abs(b.evaporated - b.rained - carried) / b.evaporated).toBeLessThan(0.005);
  } finally { a.release(); }
});

test("blocking: a gentle ridge leaves the wind as the circulation gives it, a steep one removes the upslope part of the wind and keeps the part along the contour", async () => {
  const g = await theGpu();
  const winds = async (peak: number, halfKm: number) => {
    const a = await AtmosphereGpu.make(g, grid, ridgePlanet(geo, { peak, halfKm }), {});
    try {
      a.loadSeason(1); a.run("prep");
      return { u: await a.read(FIELD.U), v: await a.read(FIELD.V), u0: await a.read(FIELD.U0), v0: await a.read(FIELD.V0), sx: await a.read(FIELD.SLX), sy: await a.read(FIELD.SLY), land: a.land };
    } finally { a.release(); }
  };
  const gentle = await winds(300, 150), steep = await winds(6000, 80), q = 65536;
  let moved = 0, slowest = 1, widest = 0, count = 0, upslope = 0, kept = 0;
  for (let i = 0; i < geo.n; i++) {
    if (gentle.u[i] !== gentle.u0[i] || gentle.v[i] !== gentle.v0[i]) moved++;
    if (!steep.land[i]) { expect(steep.u[i]).toBe(steep.u0[i]); continue; }
    const s0 = Math.hypot(steep.u0[i], steep.v0[i]), s1 = Math.hypot(steep.u[i], steep.v[i]);
    slowest = Math.min(slowest, s1 / s0); widest = Math.max(widest, s1 / s0);
    if (s1 >= 0.9 * s0) continue;
    count++;
    const g0 = Math.hypot(steep.sx[i], steep.sy[i]), nx = steep.sx[i] / g0, ny = steep.sy[i] / g0;
    const up0 = (steep.u0[i] * nx + steep.v0[i] * ny) / q, up1 = (steep.u[i] * nx + steep.v[i] * ny) / q;
    const al0 = (steep.u0[i] * ny - steep.v0[i] * nx) / q, al1 = (steep.u[i] * ny - steep.v[i] * nx) / q;
    if (up1 < up0) upslope++;
    if (Math.abs(al1 - al0) < 0.01) kept++;
  }
  console.log(`blocking: a 300 m ridge moved ${moved} cells' winds; on a 6 km ridge the slowest cell keeps ${(slowest * 100).toFixed(0)}% of its wind, ${count} cells lose over a tenth, in ${upslope} the upslope part is less and in ${kept} the part along the contour is kept to 0.01 m/s`);
  expect(moved).toBe(0);
  expect(slowest).toBeLessThan(0.7);
  expect(widest).toBeLessThanOrEqual(1.0001);
  expect(count).toBeGreaterThan(50);
  expect(upslope).toBe(count);
  expect(kept).toBe(count);
});

test("two continents: temperature falls with latitude and with height at the lapse rate, and the polar land swings far more than the sea", async () => {
  const c = await continents(), o = await ocean();
  const tn = annual(c, (s) => s.temperature), on = annual(o, (s) => s.temperature);
  const land = (i: number) => c.land[i] === 1;
  // latitude: the polar continent's annual mean at 74 to 80 against 80 to 90 (north of 72 it is all land)
  const polarLow = band(tn, 74, 80, land), polarHigh = band(tn, 82, 90, land);
  console.log(`polar continent: annual mean ${polarLow.toFixed(2)} C at 74 to 80 N, ${polarHigh.toFixed(2)} C at 82 to 90 N; the ocean planet's ${band(on, 74, 80).toFixed(2)} and ${band(on, 82, 90).toFixed(2)}`);
  expect(polarHigh).toBeLessThan(polarLow);
  // the same latitude: land against sea over the year, and the seasons' swing
  const swing = (cl: Climate, lo: number, hi: number, keep: (i: number) => boolean) => {
    const t = cl.seasons.map((s) => band(s.temperature, lo, hi, keep));
    return Math.max(...t) - Math.min(...t);
  };
  const swingLand = swing(c, 82, 90, land), swingSea = swing(o, 82, 90, () => true);
  // the cited 21 is a column's before any transport; this planet's eddy diffusion (2.07 W/m2/K) couples the pole to the lower
  // latitudes and the measured ratio is far under it (a finding of the impl note), so the check is the direction with a margin
  console.log(`seasonal swing at 82 to 90 N: land ${swingLand.toFixed(1)} K, sea ${swingSea.toFixed(1)} K, ratio ${(swingLand / swingSea).toFixed(1)} (a column's cited ratio before transport is 21)`);
  expect(swingLand).toBeGreaterThan(1.2 * swingSea);
  // height: across the equatorial plateau (200 to 3,000 m) the near-surface temperature falls at the lapse rate, 6.5 K/km
  const hs: number[] = [], ts: number[] = [], heights = twoContinents(geo);
  for (let i = 0; i < geo.n; i++) {
    const la = geo.lat[i] / DEG, lo = (geo.lon[i] / DEG + 360) % 360;
    if (Math.abs(la) < 3 && lo > 55 && lo < 105 && land(i)) { hs.push(heights[i]); ts.push(tn[i]); }
  }
  expect(hs.length).toBeGreaterThan(100);
  // the lapse term of each cell is the height times the rate (the field identity), and the sea-level air is nearly the same
  // across the plateau, so the near-surface temperature falls with height at the lapse rate
  const mh = hs.reduce((a, v) => a + v, 0) / hs.length, mt = ts.reduce((a, v) => a + v, 0) / ts.length;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < hs.length; k++) { sxy += (hs[k] - mh) * (ts[k] - mt); sxx += (hs[k] - mh) ** 2; }
  const slope = (sxy / sxx) * 1000;
  console.log(`equatorial plateau: ${hs.length} cells from ${Math.min(...hs).toFixed(0)} to ${Math.max(...hs).toFixed(0)} m, dT/dz ${slope.toFixed(2)} K/km (lapse ${(GAMMA * 1000).toFixed(1)})`);
  expect(Math.max(...hs)).toBeGreaterThan(2500);
  expect(slope).toBeLessThan(-5.5);
  expect(slope).toBeGreaterThan(-7.5);
  // the equatorial lowlands against the sea at the same latitude: within 2 K on the annual mean
  const lowLand = band(tn, -3, 3, (i) => land(i) && (((geo.lon[i] / DEG) + 360) % 360 < 40 || ((geo.lon[i] / DEG) + 360) % 360 > 120));
  expect(Math.abs(lowLand - band(on, -3, 3))).toBeLessThan(2);
});

test("west coast: the sea at its back makes a mid-latitude west coast milder in winter, with a smaller range and more rain than its east coast", async () => {
  const c = await westerly();
  const R = grid.radius, lat = 62, inland = 100;
  const km = (lon0: number, dk: number) => lon0 + (dk * 1000) / (R * Math.cos(lat * DEG)) / DEG;
  const spots = { west: km(40, inland), east: km(100, -inland), middle: 70 };
  const read = (lon: number, f: (s: Climate["seasons"][number]) => Float32Array) => {
    const i = cellAtLatLon(lat, lon);
    return c.seasons.map((s) => f(s)[i]);
  };
  const out: Record<string, { winter: number; summer: number; rain: number }> = {};
  for (const [name, lon] of Object.entries(spots)) {
    const t = read(lon, (s) => s.temperature), r = read(lon, (s) => s.rain);
    out[name] = { winter: t[3], summer: t[1], rain: r.reduce((a, v) => a + v, 0) };
  }
  const range = (k: string) => out[k].summer - out[k].winter;
  console.log(`62 N, 100 km in from each coast: winter west ${out.west.winter.toFixed(1)} / middle ${out.middle.winter.toFixed(1)} / east ${out.east.winter.toFixed(1)} C; range ${range("west").toFixed(1)} / ${range("middle").toFixed(1)} / ${range("east").toFixed(1)} K; rain ${out.west.rain.toFixed(0)} / ${out.middle.rain.toFixed(0)} / ${out.east.rain.toFixed(0)} mm; winter contrast west minus east ${(out.west.winter - out.east.winter).toFixed(1)} K, range ratio west/east ${(range("west") / range("east")).toFixed(2)}`);
  expect(out.west.winter).toBeGreaterThan(out.east.winter + 2);
  expect(range("west")).toBeLessThan(range("east"));
  expect(range("middle")).toBeLessThan(range("east") + 1e-6 + range("east"));
  expect(out.west.winter).toBeGreaterThan(out.middle.winter);
});

test("tilt: none gives no seasons, and tilted at the sun one pole has its summer where the other has its winter and then they swap", async () => {
  const short = { spinDays: 4, windowDays: 0.5 };
  const flat = await climateOf("ocean-tilt0", () => oceanPlanet(geo), { tiltDeg: 0 }, short);
  for (let s = 1; s < 4; s++) {
    let dT = 0, dR = 0, rain0 = 0;
    for (let i = 0; i < geo.n; i++) { dT = Math.max(dT, Math.abs(flat.seasons[s].temperature[i] - flat.seasons[0].temperature[i])); dR = Math.max(dR, Math.abs(flat.seasons[s].rain[i] - flat.seasons[0].rain[i])); rain0 = Math.max(rain0, flat.seasons[0].rain[i]); }
    console.log(`tilt 0, season ${SEASONS[s]} against spring: largest temperature difference ${dT.toExponential(2)} K, rain ${dR.toExponential(2)} mm of ${rain0.toFixed(0)}`);
    expect(dT).toBeLessThan(1e-3);
    expect(dR).toBeLessThan(1e-3 * rain0 + 0.01);
  }
  // a planet of land (a column with a heat capacity of 0.16 B years answers the sun within weeks), tilted 90 degrees: at the
  // northern solstice the north pole gets all of S0 and the south pole none, and the other way at the southern one [derived]
  const land = await climateOf("land-tilt90", () => new Float32Array(geo.n).fill(100), { tiltDeg: 90 }, short);
  const polar = (c: Climate, s: number, sign: number) => (sign > 0 ? band(c.seasons[s].temperature, 85, 90) : band(c.seasons[s].temperature, -90, -85));
  console.log(`tilt 90, land: north pole ${[0, 1, 2, 3].map((s) => polar(land, s, 1).toFixed(1)).join(" ")}, south pole ${[0, 1, 2, 3].map((s) => polar(land, s, -1).toFixed(1)).join(" ")} C by season (spring summer autumn winter)`);
  expect(polar(land, 1, 1)).toBeGreaterThan(polar(land, 1, -1) + 20);
  expect(polar(land, 3, -1)).toBeGreaterThan(polar(land, 3, 1) + 20);
  // the south pole's year is the north pole's two seasons on (spring is not the equinox's mirror: the sun crosses from the south
  // pole to the north in it, and a land column keeps weeks of what it was given)
  for (let s = 0; s < 4; s++) expect(Math.abs(polar(land, s, 1) - polar(land, (s + 2) % 4, -1))).toBeLessThan(1e-3);
  // and the pole is warmer in its summer than the equator [derived: at 90 degrees the pole gets all of S0, the equator none]
  expect(polar(land, 1, 1)).toBeGreaterThan(band(land.seasons[1].temperature, -3, 3));
  // the same on a planet of sea: the 75 m mixed layer's lag puts each pole's warmest season after its summer, and the south
  // pole's year is the north's two seasons on
  const sea = await climateOf("ocean-tilt90", () => oceanPlanet(geo), { tiltDeg: 90 }, short);
  const series = (sign: number) => [0, 1, 2, 3].map((s) => polar(sea, s, sign));
  console.log(`tilt 90, sea: north pole ${series(1).map((v) => v.toFixed(1)).join(" ")}, south pole ${series(-1).map((v) => v.toFixed(1)).join(" ")} C by season`);
  for (let s = 0; s < 4; s++) expect(Math.abs(series(1)[s] - series(-1)[(s + 2) % 4])).toBeLessThan(0.1);
  expect(series(1).indexOf(Math.max(...series(1)))).toBe(2);
  for (const s of sea.seasons) for (const f of [s.temperature, s.rain, s.windE, s.windN, s.insolation]) for (let i = 0; i < geo.n; i += 97) expect(Number.isFinite(f[i])).toBe(true);
});

test("sea: the sea surface is the energy balance's ocean column held at freezing, and sea ice grows by Stefan's law where it would be colder", async () => {
  const warm = await ocean(), cold = await climateOf("ocean-dim", () => oceanPlanet(geo), { solar: 1000 }, { spinDays: 6, windowDays: 0.5 });
  const column = (c: Climate, s: number, i: number) => {
    const x = Math.min(BANDS - 1, Math.max(0, geo.lat[i] / DEG + 89.5)), b = Math.min(BANDS - 2, Math.floor(x)), f = x - b, t = c.ebm.sea[s];
    return t[b] * (1 - f) + t[b + 1] * f;
  };
  let worstSst = 0, worstIce = 0, iced = 0, open = 0;
  for (const [c, s] of [[warm, 1], [cold, 3], [cold, 1]] as const) {
    for (let i = 0; i < geo.n; i += 11) {
      const tw = column(c, s, i), sst = c.seasons[s].sst[i], ice = c.seasons[s].ice[i];
      worstSst = Math.max(worstSst, Math.abs(sst - Math.max(tw, T_FREEZE)));
      const expected = tw < T_FREEZE ? Math.sqrt(((2 * ICE_K * SEASON_S) / (ICE_RHO * ICE_L)) * (T_FREEZE - tw)) : 0;
      if (expected > 0.05) { worstIce = Math.max(worstIce, Math.abs(ice - expected) / expected); iced++; } else { expect(ice).toBeLessThan(0.06); open++; }
    }
  }
  console.log(`sea: surface within ${worstSst.toExponential(1)} K of the column held at freezing, ice within ${(100 * worstIce).toFixed(1)}% of Stefan's law, ${iced} iced and ${open} open samples`);
  expect(worstSst).toBeLessThan(0.01);
  expect(iced).toBeGreaterThan(1000);
  expect(worstIce).toBeLessThan(0.02);
  // the warm planet has none, and ice thickens poleward on the cold one
  expect(Math.max(...warm.seasons[3].ice)).toBe(0);
  expect(band(cold.seasons[3].ice, 80, 90)).toBeGreaterThan(band(cold.seasons[3].ice, 70, 80));
  expect(band(cold.seasons[3].ice, 70, 80)).toBeGreaterThan(0);
});

test("snow: all of a winter's precipitation on the ridge's crest falls as snow and none at sea level", async () => {
  const c = await ridge(), w = c.seasons[3];
  const R = grid.radius, lat = 60, at = (km: number) => cellAtLatLon(lat, 90 + (km * 1000) / (R * Math.cos(lat * DEG)) / DEG);
  const crest = at(0), shore = at(-250);
  console.log(`winter ridge: crest ${w.temperature[crest].toFixed(1)} C, rain ${w.rain[crest].toFixed(0)} mm of which snow ${w.snow[crest].toFixed(0)}; sea level ${w.temperature[shore].toFixed(1)} C, snow ${w.snow[shore].toFixed(0)}`);
  expect(w.temperature[crest]).toBeLessThan(-1);
  expect(w.rain[crest]).toBeGreaterThan(100);
  expect(Math.abs(w.snow[crest] - w.rain[crest])).toBeLessThan(0.01 * w.rain[crest]);
  expect(w.temperature[shore]).toBeGreaterThan(1);
  expect(w.snow[shore]).toBe(0);
  for (let i = 0; i < geo.n; i += 5) expect(w.snow[i]).toBeLessThanOrEqual(w.rain[i] * 1.0001 + 1e-3);
});

test("land water: where nothing is stored, the rain that falls on land goes back to the air or runs off", async () => {
  const c = await westerly();
  for (const s of c.seasons) {
    let rain = 0, back = 0, off = 0;
    for (let i = 0; i < geo.n; i++) if (c.land[i]) { rain += geo.area[i] * s.rain[i]; back += geo.area[i] * s.evaporation[i]; off += geo.area[i] * s.runoff[i]; }
    console.log(`${SEASONS[c.seasons.indexOf(s)]}: land rain ${(rain / 1e12).toExponential(3)} (mm km2 order), evaporated back ${((back / rain) * 100).toFixed(1)}%, runoff ${((off / rain) * 100).toFixed(1)}%`);
    expect(Math.abs(rain - back - off) / rain).toBeLessThan(0.01);
    expect(back).toBeGreaterThan(0);
    expect(off).toBeGreaterThan(back);
  }
});

// The pinned output of the ridge planet over a short run (3 days of spin-up, a half-day window): Bun.hash over the four seasons'
// fields, as the bytes of each field in the order of `golden`. Re-record deliberately when a law or a constant changes. The
// energy balance and the circulation's tables are made in float64 and rounded to the kernels' integers, so the hash is one
// engine's (Bun, JavaScriptCore) as the grid's tables are (grid.md, gap 3).
const RIDGE_HASH = "3e6df7dbcb2e883a";
test("determinism: the same planet twice gives the same bytes, pinned to a hash", async () => {
  const short = { spinDays: 3, windowDays: 0.5 };
  const g = await theGpu();
  const first = await climateGpu(g, grid, ridgePlanet(geo), {}, short), second = await climateGpu(g, grid, ridgePlanet(geo), {}, short);
  const h = golden(first);
  console.log(`ridge short-run hash ${h}`);
  expect(golden(second)).toBe(h);
  for (let s = 0; s < 4; s++) { expect(first.seasons[s].rain).toEqual(second.seasons[s].rain); expect(first.seasons[s].temperature).toEqual(second.seasons[s].temperature); }
  expect(h).toBe(RIDGE_HASH);
});
