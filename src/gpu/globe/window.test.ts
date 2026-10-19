// The window: the coarse fields' remap keeps the planet's means, a window at a coastal landing holds the sea and the land with
// the planet's mean height and rain, the planet's rivers come in at the edge, the latitude moves the sun, and a window is the
// same bytes twice with a pinned hash. Run one case at a time:
//   bun test ./src/gpu/globe/window.test.ts -t "<name>" --timeout 280000
// Most cases stand on a staged planet (a coast along a meridian, land rising 80 m a km inland, rivers by steepest descent), so
// they need no chain; the last reads seed 1's planet from the planet store (scripts/globe-window.ts --stage ...) and is
// skipped, saying so, where the store has no planet made by the globe's sources as they are.
import { afterAll, describe, expect, test } from "bun:test";
import { releaseGpu, theGpu } from "../device";
import { ISLAND_PLACE, climateRestGpu } from "../terrain/climate";
import { LEN, N } from "../../terrain/grid";
import { declination, skyAt, sunAt } from "../../sim/sky";
import { midSeason } from "../../terrain/climate";
import { RADIUS_M, tierGrid } from "./grid";
import { cellVectors, neighbours } from "./tectonics";
import { coarseMean, frameAt, landingsOf, readPlanet, remap, remapOf, windowBytes, windowOf, type Planet, type Window } from "./window";
import { diskStore, sourceKey } from "../../../scripts/globe-window";

afterAll(releaseGpu);

// A staged planet: a coast along the meridian through (lat0, lon0), land east of it rising 80 m a km to a ridge of 2,000 m 25 km
// inland, then falling 40 m a km to a second coast 75 km inland; granite under 200 m of sediment; rain of each season the same
// everywhere, three fifths of it running off; a westerly wind; rivers by steepest descent over the four neighbours.
const SITE = { lat: 45, lon: 30 };
function coastPlanet(seed = 7): Planet {
  const g = tierGrid(0), n = 6 * g.fn * g.fn, v = cellVectors(g), f = frameAt(SITE.lat, SITE.lon), nb = neighbours(g);
  const height = new Float32Array(n), pools = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const p = [v[3 * i], v[3 * i + 1], v[3 * i + 2]], d = p[0] * f.c[0] + p[1] * f.c[1] + p[2] * f.c[2];
    const x = (RADIUS_M * (p[0] * f.e[0] + p[1] * f.e[1] + p[2] * f.e[2])) / d / 1000, y = (RADIUS_M * (p[0] * f.n[0] + p[1] * f.n[1] + p[2] * f.n[2])) / d / 1000;
    const land = d > 0.99 && x >= 0 && x < 75 && Math.abs(y) < 300;
    height[i] = land ? (x < 25 ? 80 * x : 2000 - 40 * (x - 25)) : -2000;
    if (land) { pools[1][i] = 200; pools[3][i] = 30000; } else { pools[0][i] = 6000; pools[1][i] = 500; }
  }
  const to = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let best = i;
    if (height[i] > 0) for (let k = 0; k < 4; k++) { const j = nb[4 * i + k]; if (height[j] < height[best]) best = j; }
    to[i] = best;
  }
  const field = (land: number, sea: number) => Float32Array.from(height, (h) => (h > 0 ? land : sea));
  const seasons = [[8, 400, 9], [16, 300, 14], [10, 500, 12], [2, 600, 7]].map(([t, rain, sst]) => ({
    t: new Float32Array(n).fill(t), rain: new Float32Array(n).fill(rain), snow: new Float32Array(n), runoff: field(0.6 * rain, 0),
    windE: new Float32Array(n).fill(5), windN: new Float32Array(n), sst: field(0, sst),
  }));
  const zero = () => new Float32Array(n);
  return { seed, n, height, pools, to, acc: new Uint32Array(n), seasons, ice: { maxM: zero(), nowM: zero(), cutM: zero(), laidM: zero() }, sea: { lowM: -5, nowM: 0 } };
}

const hashOf = (w: Window) => Bun.hash(Buffer.concat(windowBytes(w))).toString(16);
let staged: { planet: Planet; w: Window } | null = null;
async function stagedWindow() {
  if (!staged) {
    const planet = coastPlanet(), at = landingsOf(planet, 1)[0];
    if (!at) throw new Error("the staged planet has no landing");
    staged = { planet, w: await windowOf(await theGpu(), planet, at.latDeg, at.lonDeg) };
  }
  return staged;
}

describe("the window", () => {
  test("the remap keeps the coarse mean", () => {
    const r = remapOf(frameAt(SITE.lat, SITE.lon)), n = 6 * 256 * 256;
    let s = 12345;
    const rand = Float32Array.from({ length: n }, () => { s = (s * 1103515245 + 12345) >>> 0; return (s / 2 ** 32) * 1000 - 300; });
    const out = remap(r, rand);
    let m = 0;
    for (let i = 0; i < LEN; i++) m += out[i];
    // the window's mean is the overlap-weighted mean of the coarse cells, to the float32 rounding of the cells' values
    expect(Math.abs(m / LEN - coarseMean(r, rand))).toBeLessThan(1e-3);
    // a constant comes back as itself everywhere
    const c = remap(r, new Float32Array(n).fill(7.5));
    for (let i = 0; i < LEN; i++) expect(Math.abs(c[i] - 7.5)).toBeLessThan(1e-4);
    // the smoothing spans one coarse cell: the box is a coarse cell's side in window cells, odd
    expect(r.box % 2).toBe(1);
    expect(r.box * 75).toBeGreaterThan(8000);
    expect(r.box * 75).toBeLessThan(12500);
  });

  test("a coastal landing's window holds the sea and the land, with the planet's mean height and rain", async () => {
    const { planet, w } = await stagedWindow(), h = w.isle.height;
    let sea = 0, land = 0, sum = 0, landCoarse = 0, landCells = 0;
    for (let i = 0; i < LEN; i++) {
      if (h[i] <= 0) sea++; else land++;
      sum += h[i];
      if (w.coarse.surface[i] > 0) { landCoarse += w.coarse.surface[i]; landCells++; }
    }
    console.log(`staged window at ${w.latDeg.toFixed(3)}, ${w.lonDeg.toFixed(3)}: sea ${sea}, land ${land}, mean ${(sum / LEN).toFixed(2)} m against ${w.coarse.heightM.toFixed(2)}, uplift ${(w.params.upliftMYr * 1000).toFixed(4)} mm a year, runs' land means ${w.params.probeMeanM.map((v) => v.toFixed(1)).join(" ")}`);
    expect(sea).toBeGreaterThan(LEN / 10);
    expect(land).toBeGreaterThan(LEN / 10);
    // the mean height: the erosion holds the land's mean to 0.5% of it at the lowstand's sea (MEAN_TOLERANCE), then the ice's
    // scour, the till and the lowered sea move it a little more; 2% of the land's mean times its share is the bound [design]
    expect(Math.abs(sum / LEN - w.coarse.heightM)).toBeLessThan(0.02 * (landCoarse / landCells) * (landCells / LEN));
    // the rain of each season: the remap keeps it to float32's rounding
    w.isle.seasons.forEach((s, k) => {
      let r = 0;
      for (let i = 0; i < LEN; i++) r += s.precip[i];
      expect(Math.abs(r / LEN - w.coarse.rainMm[k])).toBeLessThan(1e-4 * w.coarse.rainMm[k]);
    });
    void planet;
  });

  test("rivers from the coarse network come in at the edge", async () => {
    const { w } = await stagedWindow(), flow = w.isle.flow;
    console.log(`inflow: ${w.params.inflow.map((v) => `(${v.x}, ${v.y}) ${v.areaKm2.toFixed(0)} km2 ${(v.m3s.reduce((a, b) => a + b, 0) / 4).toFixed(1)} m3/s, the cell's flow ${flow[v.at].toFixed(1)}`).join("; ")}`);
    expect(w.params.inflow.length).toBeGreaterThan(0);
    for (const v of w.params.inflow) {
      // at the window's edge, on its land
      expect(v.x === 0 || v.y === 0 || v.x === N - 1 || v.y === N - 1).toBe(true);
      expect(w.isle.height[v.at]).toBeGreaterThan(0);
      // the cell's mean flow holds the river's (the four seasons' mean) and what its own ground gives
      const mean = v.m3s.reduce((a, b) => a + b, 0) / 4;
      expect(flow[v.at]).toBeGreaterThanOrEqual(mean * (1 - 1e-3));
    }
    // and the water goes on down: the biggest flow in the window is at least the biggest river's
    let most = 0;
    for (let i = 0; i < LEN; i++) most = Math.max(most, flow[i]);
    expect(most).toBeGreaterThanOrEqual(Math.max(...w.params.inflow.map((v) => v.m3s.reduce((a, b) => a + b, 0) / 4)) * (1 - 1e-3));
  });

  test("the latitude moves the sun", async () => {
    // the island's sky is skyAt(55.1), word for word
    const island = skyAt(55.1);
    for (const day of [1, 9, 16, 30]) for (const hour of [6, 9.5, 13, 17]) expect(island.sunAt(day, hour)).toEqual(sunAt(day, hour));
    // at noon on midsummer's day the sun stands 90 degrees less the latitude and plus the declination
    const day = 16, noon = 13, dec = declination(day, noon);
    for (const lat of [-30, 0, 20, 55.1, 70]) {
      const el = skyAt(lat).sunAt(day, noon).el;
      expect(Math.abs(el - (Math.PI / 2 - Math.abs((lat * Math.PI) / 180 - dec)))).toBeLessThan(1e-9);
    }
    expect(skyAt(70).daylight(16)).toBeGreaterThan(skyAt(20).daylight(16) + 4);
    // the climate stage reckons its sunlight at the place's latitude: on flat land, winter's light at 60 degrees is under half the
    // equator's, and the island's place gives the island's words
    const g = await theGpu(), height = new Float32Array(LEN).fill(10), open = new Uint8Array(LEN), precip = [0, 1, 2, 3].map(() => new Float32Array(LEN).fill(150));
    const at = (latDeg: number) => climateRestGpu(g, { height, open, precip, angle: 1, place: { ...ISLAND_PLACE, latDeg } });
    const [equator, north, same, base] = await Promise.all([at(0), at(60), climateRestGpu(g, { height, open, precip, angle: 1, place: ISLAND_PLACE }), climateRestGpu(g, { height, open, precip, angle: 1 })]);
    const winter = (c: typeof equator) => c.seasons[3].sun[LEN / 2 + N / 2];
    console.log(`winter sun at the equator ${winter(equator).toFixed(2)}, at 60 N ${winter(north).toFixed(2)} MJ/m2 a day (season mid day ${midSeason(3)})`);
    expect(winter(north)).toBeLessThan(winter(equator) / 2);
    expect(Buffer.from(same.seasons[3].sun.buffer).equals(Buffer.from(base.seasons[3].sun.buffer))).toBe(true);
  });

  test("a staged window is the same bytes twice, pinned", async () => {
    const { planet, w } = await stagedWindow(), again = await windowOf(await theGpu(), planet, w.latDeg, w.lonDeg);
    const a = hashOf(w), b = hashOf(again);
    console.log(`staged window hash ${a}`);
    expect(b).toBe(a);
    expect(a).toBe(STAGED_HASH);
  });

  test("seed 1's window at its first landing is the same bytes twice, pinned", async () => {
    const store = diskStore(undefined, process.env.NOMADS_PLANET_KEY ?? sourceKey());
    if (!(await store.get(1, "climate1"))) {
      console.log(`no planet of seed 1 for these sources in ${store.dir(1)}: build it with scripts/globe-window.ts --stage chain, climate0, ice, climate1 (skipped)`);
      return;
    }
    const planet = await readPlanet(1, store), at = landingsOf(planet, 1)[0], g = await theGpu();
    const w = await windowOf(g, planet, at.latDeg, at.lonDeg), again = await windowOf(g, planet, at.latDeg, at.lonDeg);
    const planetHash = Bun.hash(Buffer.concat([planet.height, ...planet.pools].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)))).toString(16);
    console.log(`seed 1 landing ${at.latDeg.toFixed(3)}, ${at.lonDeg.toFixed(3)}: planet ${planetHash}, window ${hashOf(w)}`);
    expect(hashOf(again)).toBe(hashOf(w));
    // the pin holds for the planet it was recorded on (the store's key and the planet's own hash say which)
    if (planetHash === SEED1.planet) expect(hashOf(w)).toBe(SEED1.window);
    else throw new Error(`seed 1's planet is not the one the pin was recorded on (${SEED1.planet}): re-record SEED1 deliberately`);
  });
});

// Bun.hash of windowBytes, recorded on the M3 Pro (one adapter: no second to compare against) [design: the pin's own record].
const STAGED_HASH = "64d8306f54100bd";
// Seed 1's planet (Bun.hash of its height and rock pools) and its first landing's window, recorded together.
const SEED1 = { planet: "59280bbfdd111472", window: "a706caeaf5b5f4a7" };
