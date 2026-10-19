// Look at the globe's climate: renders the atmosphere's fields for a synthetic planet or for a real height field as
// equirectangular PNG maps (720 x 360, the whole sphere, longitude from -180 to 180) under --out, one per field and season,
// and prints the zonal means.
//   bun scripts/globe-climate-maps.ts --planet ridge --out /tmp/globe-climate/ridge
//   bun scripts/globe-climate-maps.ts --height /path/heights.f32 --sea 0 --out /tmp/globe-climate/real
// Planets: ocean, ridge, continents (a polar and an equatorial one), west (a box continent in the westerlies), earth (four
// continents on 29% land with a range on two west and east coasts). --height reads
// a raw little-endian float32 file of 6 * 256 * 256 heights in metres, in cell-id order ((face * 256 + Y) * 256 + X, the faces
// and axes of src/gpu/globe/grid.ts). Options: --tilt degrees (23.4), --day hours (24), --radius m, --spin days (30),
// --solar W/m2 (1366). Also writes zonal.json: the 10 degree bands' annual rain, evaporation and temperature, for comparing two builds.
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync } from "node:fs";
import { theGpu } from "../src/gpu/device";
import { RADIUS_M, locate, cellId, tierGrid } from "../src/gpu/globe/grid";
import { SEASONS, buildGeometry, climateGpu, type Climate, type SeasonClimate } from "../src/gpu/globe/atmosphere";
import { earthlikePlanet, oceanPlanet, ridgePlanet, twoContinents, westerlyContinent } from "../src/gpu/globe/synthetic";
import { exit, holdGpu } from "./seeded";

type RGB = [number, number, number];
const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg("out", "/tmp/globe-climate"), planetName = arg("planet", "ridge"), W = 720, H = 360;
mkdirSync(out, { recursive: true });

function png(w: number, h: number, rgb: Uint8Array) {
  const row = w * 3 + 1, raw = new Uint8Array(row * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * row + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    dv.setUint32(8 + data.length, Bun.hash.crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const head = new Uint8Array(13), dv = new DataView(head.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}
const mix = (a: RGB, b: RGB, t: number): RGB => { const u = Math.max(0, Math.min(1, t)); return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; };
// blue (cold) through white to red (hot)
const heat = (t: number): RGB => (t < 0.5 ? mix([40, 70, 190], [245, 245, 245], t * 2) : mix([245, 245, 245], [200, 40, 30], (t - 0.5) * 2));
const wet = (t: number): RGB => (t < 0.5 ? mix([214, 190, 130], [70, 150, 100], t * 2) : mix([70, 150, 100], [20, 60, 170], (t - 0.5) * 2));

const g = tierGrid(0, Number(arg("radius", String(RADIUS_M)))), geo = buildGeometry(g);
const sea = Number(arg("sea", "0"));
const height = arg("height", "")
  ? new Float32Array(readFileSync(arg("height", "")).buffer.slice(0))
  : { ocean: oceanPlanet, ridge: ridgePlanet, continents: twoContinents, west: westerlyContinent, earth: earthlikePlanet }[planetName]!(geo);
// the cell under each pixel
const cellAt = new Int32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const p = locate(g, (90 - (y + 0.5) / 2) * (Math.PI / 180), ((x + 0.5) / 2 - 180) * (Math.PI / 180));
  cellAt[y * W + x] = cellId(g, p.face, p.X, p.Y);
}

const t0 = performance.now();
await holdGpu();
const c: Climate = await climateGpu(await theGpu(), g, height, { tiltDeg: Number(arg("tilt", "23.4")), dayS: Number(arg("day", "24")) * 3600, solar: Number(arg("solar", "1366")), seaLevel: sea, radius: g.radius }, { spinDays: Number(arg("spin", "30")), soilRounds: Number(arg("soil-rounds", "3")) });
const circ = c.circulation;
console.log(`${planetName}: ${Math.round(performance.now() - t0)} ms, land ${((c.land.reduce((a, v) => a + v, 0) / c.land.length) * 100).toFixed(1)}% of cells`);
console.log(`energy balance: diffusion ${c.ebm.diffusion.toFixed(2)} W/m2/K, drift over the last year ${c.ebm.drift.toExponential(1)} K, net flux ${c.ebm.balance.toFixed(4)} W/m2`);
console.log(`circulation: Held-Hou edge ${((circ.heldHou * 180) / Math.PI).toFixed(1)}, eddy edge ${((circ.eddy * 180) / Math.PI).toFixed(1)}, Hadley ${((circ.hadley * 180) / Math.PI).toFixed(1)}, polar front ${((circ.polarFront * 180) / Math.PI).toFixed(1)} degrees; peak winds trades ${circ.uTrade.toFixed(1)} westerlies ${circ.uWest.toFixed(1)} m/s; circulation centre by season ${c.ebm.phi0.map((v) => ((v * 180) / Math.PI).toFixed(1)).join(", ")} degrees`);

function save(name: string, color: (i: number) => RGB, arrows?: SeasonClimate) {
  const rgb = new Uint8Array(W * H * 3);
  for (let k = 0; k < W * H; k++) { const col = color(cellAt[k]); rgb[3 * k] = col[0]; rgb[3 * k + 1] = col[1]; rgb[3 * k + 2] = col[2]; }
  if (arrows) {
    // an arrow every 24 pixels: its length is the speed, 3 pixels a m/s, drawn east and north as on the plate carree
    for (let y = 12; y < H; y += 24) for (let x = 12; x < W; x += 24) {
      const i = cellAt[y * W + x], u = arrows.windE[i], v = arrows.windN[i], len = Math.hypot(u, v);
      if (len < 0.2) continue;
      const k = 4, steps = Math.ceil(len * k);
      for (let s = 0; s <= steps; s++) {
        const px = Math.round(x + (u / len) * (s / k)), py = Math.round(y - (v / len) * (s / k));
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const o = 3 * (py * W + px);
        rgb[o] = 20; rgb[o + 1] = 20; rgb[o + 2] = 20;
      }
      const hx = Math.round(x + (u / len) * (steps / k)), hy = Math.round(y - (v / len) * (steps / k));
      if (hx >= 0 && hx < W && hy >= 0 && hy < H) { const o = 3 * (hy * W + hx); rgb[o] = 220; rgb[o + 1] = 30; rgb[o + 2] = 30; }
    }
  }
  Bun.write(`${out}/${name}.png`, png(W, H, rgb));
}
const landMix = (i: number, ocean: RGB, land: RGB) => (c.land[i] ? land : ocean);
save("height", (i) => (c.land[i] ? mix([110, 150, 80], [245, 245, 240], height[i] / 3000) : mix([60, 100, 170], [20, 40, 100], -height[i] / 5000)));
c.seasons.forEach((s, k) => {
  const name = SEASONS[k];
  save(`temperature-${name}`, (i) => heat((s.temperature[i] + 40) / 80));
  save(`rain-${name}`, (i) => wet(s.rain[i] / 1200));
  save(`snow-${name}`, (i) => mix([40, 60, 90], [255, 255, 255], s.snow[i] / 600));
  save(`wind-${name}`, (i) => landMix(i, [210, 225, 240], [225, 215, 190]), s);
  save(`insolation-${name}`, (i) => heat(s.insolation[i] / 500));
  save(`sst-${name}`, (i) => (c.land[i] ? [150, 140, 120] : s.ice[i] > 0 ? [250, 250, 255] : heat((s.sst[i] + 5) / 40)));
  save(`vapour-${name}`, (i) => wet(s.column[i] / 50));
});
save("rain-annual", (i) => wet(c.seasons.reduce((a, s) => a + s.rain[i], 0) / 3000));
save("temperature-annual", (i) => heat((c.seasons.reduce((a, s) => a + s.temperature[i], 0) / 4 + 40) / 80));
save("evaporation-annual", (i) => wet(c.seasons.reduce((a, s) => a + s.evaporation[i], 0) / 2500));
save("runoff-annual", (i) => (c.land[i] ? wet(c.seasons.reduce((a, s) => a + s.runoff[i], 0) / 2000) : [90, 110, 150]));
save("potential-annual", (i) => (c.land[i] ? wet(c.seasons.reduce((a, s) => a + (s.potential?.[i] ?? 0), 0) / 2500) : [90, 110, 150]));
save("evaporation-share-annual", (i) => (c.land[i] ? wet(c.seasons.reduce((a, s) => a + s.evaporation[i], 0) / Math.max(1, c.seasons.reduce((a, s) => a + s.rain[i], 0)) / 1.2) : [90, 110, 150]));

// zonal means, 10 degree bands: area-weighted annual rain, evaporation and temperature, the zonal wind and the seasons' temperatures
const bands = 18, acc = (f: (i: number) => number) => { const s = new Float64Array(bands), w = new Float64Array(bands); for (let i = 0; i < geo.n; i++) { const b = Math.min(bands - 1, Math.floor(((geo.lat[i] * 180) / Math.PI + 90) / 10)); s[b] += geo.area[i] * f(i); w[b] += geo.area[i]; } return s.map((v, b) => v / w[b]); };
const rainA = acc((i) => c.seasons.reduce((a, s) => a + s.rain[i], 0) / 365.25), evapA = acc((i) => c.seasons.reduce((a, s) => a + s.evaporation[i], 0) / 365.25);
const tAnn = acc((i) => c.seasons.reduce((a, s) => a + s.temperature[i], 0) / 4), uZ = acc((i) => c.seasons.reduce((a, s) => a + s.windE[i], 0) / 4), vZ = acc((i) => c.seasons.reduce((a, s) => a + s.windN[i], 0) / 4);
const tS = c.seasons.map((s) => acc((i) => s.temperature[i]));
console.log("lat band   rain mm/d  evap mm/d  T annual  T spring summer autumn winter   u annual  v annual");
for (let b = bands - 1; b >= 0; b--) console.log(`${String(b * 10 - 90).padStart(4)}..${String(b * 10 - 80).padStart(3)}  ${rainA[b].toFixed(2).padStart(9)}  ${evapA[b].toFixed(2).padStart(9)}  ${tAnn[b].toFixed(1).padStart(8)}  ${tS.map((t) => t[b].toFixed(1).padStart(6)).join(" ")}   ${uZ[b].toFixed(2).padStart(8)}  ${vZ[b].toFixed(2).padStart(8)}`);
for (const [k, s] of c.seasons.entries()) console.log(`${SEASONS[k]}: step ${s.dt} s, spin ${s.spinSteps} + window ${s.windowSteps} steps; water over the window: evaporated ${s.budget.evaporated.toExponential(3)} m3, rained ${s.budget.rained.toExponential(3)}, held ${s.budget.held0.toExponential(3)} then ${s.budget.held1.toExponential(3)}`);
// global means over the year: rain and evaporation in mm/day, the column's vapour in mm, and the residence time of the water in the air
const total = geo.area.reduce((a, v) => a + v, 0), mean = (f: (i: number) => number) => { let s = 0; for (let i = 0; i < geo.n; i++) s += geo.area[i] * f(i); return s / total; };
const gP = mean((i) => c.seasons.reduce((a, s) => a + s.rain[i], 0) / 365.25), gE = mean((i) => c.seasons.reduce((a, s) => a + s.evaporation[i], 0) / 365.25), gW = mean((i) => c.seasons.reduce((a, s) => a + s.column[i], 0) / 4);
console.log(`global means: rain ${gP.toFixed(2)} mm/day, evaporation ${gE.toFixed(2)} mm/day, vapour in the layer ${gW.toFixed(1)} mm, residence ${(gW / gP).toFixed(1)} days (Earth: 2.69, 2.78, 24.6, 8)`);
console.log(`maps in ${out}`);
// the planet's poles and its land: the annual contrast, whether ice and snow form, and the land's water
const bandMean = (f: (i: number) => number, lo: number, hi: number, keep: (i: number) => boolean = () => true) => { let s = 0, w = 0; for (let i = 0; i < geo.n; i++) { const la = (geo.lat[i] * 180) / Math.PI; if (la >= lo && la < hi && keep(i)) { s += geo.area[i] * f(i); w += geo.area[i]; } } return w > 0 ? s / w : NaN; };
const ann = (f: (s: SeasonClimate, i: number) => number) => (i: number) => c.seasons.reduce((a, s) => a + f(s, i), 0) / 4;
const tA = ann((s, i) => s.temperature[i]);
const north = bandMean(tA, 80, 90), south = bandMean(tA, -90, -80), eq = bandMean(tA, -10, 10);
console.log(`temperature: equator (10 S to 10 N) ${eq.toFixed(1)} C, poles ${north.toFixed(1)} N and ${south.toFixed(1)} S, equator to pole ${(eq - (north + south) / 2).toFixed(1)} K (Earth about 40); coldest season at the poles ${Math.min(...c.seasons.map((s) => bandMean((i) => s.temperature[i], 80, 90))).toFixed(1)} C`);
const iceMax = Math.max(...c.seasons.flatMap((s) => [bandMean((i) => s.ice[i], 60, 90), bandMean((i) => s.ice[i], -90, -60)]));
const snowShare = bandMean((i) => c.seasons.reduce((a, s) => a + s.snow[i], 0), 70, 90) / Math.max(1e-9, bandMean((i) => c.seasons.reduce((a, s) => a + s.rain[i], 0), 70, 90));
const seaIce = c.seasons.map((s) => { let a = 0, tot = 0; for (let i = 0; i < geo.n; i++) if (!c.land[i] && Math.abs(geo.lat[i]) > 0.8) { tot += geo.area[i]; if (s.ice[i] > 0.05) a += geo.area[i]; } return a / tot; });
console.log(`polar ice: mean sea ice thickness poleward of 60 degrees at its thickest ${iceMax.toFixed(2)} m; sea ice covers ${seaIce.map((v) => (v * 100).toFixed(0)).join(", ")}% of the sea poleward of 46 degrees by season; snow is ${(snowShare * 100).toFixed(0)}% of the precipitation at 70 to 90 degrees`);
const landArea = geo.area.reduce((a, v, i) => a + (c.land[i] ? v : 0), 0);
if (landArea > 0) {
  const lm = (f: (s: SeasonClimate, i: number) => number) => { let s = 0; for (let i = 0; i < geo.n; i++) if (c.land[i]) s += geo.area[i] * c.seasons.reduce((a, q) => a + f(q, i), 0); return s; };
  const lr = lm((s, i) => s.rain[i]), le = lm((s, i) => s.evaporation[i]), lo = lm((s, i) => s.runoff[i]), lp = lm((s, i) => s.potential?.[i] ?? 0), ls = lm((s, i) => s.storage?.[i] ?? 0);
  console.log(`land: ${((landArea / total) * 100).toFixed(1)}% of the planet; rain ${(lr / landArea / 365.25).toFixed(2)} mm/day, evaporation ${(le / landArea / 365.25).toFixed(2)}, runoff ${(lo / landArea / 365.25).toFixed(2)}, potential ${(lp / landArea / 365.25).toFixed(2)}, soil storage over the year ${((ls / lr) * 100).toFixed(2)}% of the rain; evaporation is ${((le / lr) * 100).toFixed(0)}% of the land's rain (Earth 65% by the rivers' 35%), runoff ${((lo / lr) * 100).toFixed(0)}%; soil rounds ${c.soil?.rounds ?? 1}, last march ${((c.soil?.residual ?? 0) * 100).toFixed(1)}% from the bucket's`);
}
await Bun.write(`${out}/zonal.json`, JSON.stringify({ planet: planetName, bands: Array.from({ length: bands }, (_, b) => b * 10 - 90), rain: Array.from(rainA), evaporation: Array.from(evapA), temperature: Array.from(tAnn) }));
await exit();
