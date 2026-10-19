// Ice ages on the planet the chain made: tectonics with erosion between its steps (the erosion unit's runChain), the atmosphere's
// climate of the result, then the ice: equilibrium glaciation against cooling, and an orbit-forced glacial cycle with the sea level
// falling and rising, the glacial cut of the bed, and PNG maps of it. Each stage is its own command so that none passes five minutes
// and each leaves a file for the next in the work directory (/tmp/globe-ice/<seed>):
//   bun scripts/globe-ice-maps.ts --seed 1 --stage planet            # height.f32: tectonics and erosion, about 2.5 minutes
//   bun scripts/globe-ice-maps.ts --seed 1 --stage climate           # climate.f32: the atmosphere's four seasons, about 40 seconds
//   bun scripts/globe-ice-maps.ts --seed 1 --stage sweep             # equilibrium ice against a uniform cooling
//   bun scripts/globe-ice-maps.ts --seed 1 --stage cycle             # an orbit-forced cycle scaled to the cited glacial cooling (saves max.state, end.state)
//   bun scripts/globe-ice-maps.ts --seed 1 --stage bias              # from max.state: 5 kyr at the maximum's forcing at dtMin 2, 1 and 0.5 (the flux cap's bias)
//   bun scripts/globe-ice-maps.ts --seed 1 --stage melt              # from end.state: 40 kyr at +6 K then 200 kyr at +30 K (the sea's return)
//   bun scripts/globe-ice-maps.ts --seed 1 --stage tier1             # from max.state: --years 10000 more at the maximum's forcing at tier 0 and at tier 1 (6 km), troughs in a region (--at, --radius-km 600); 20 kyr passes five minutes
// Options: --sweep "0,-2,-4,-6,-8,-10" the offsets (K) of the equilibrium runs and --relax 6000 the years each is held; --years 100000 the
// cycle's length (after --spin 40000 years held at no offset, the interglacial), --offset <K> to hold one uniform offset in the cycle stage instead of the orbit's; --outer 500 the years between
// forcing and sea-level updates; --dt-min 2 the least step (the cost's floor); --law cook|herman; --k-slide 1e-13; --out <dir>;
// --width 1440; --zoom "lat,lon,spanDeg" (default: where the ice cut the most).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { releaseGpu, theGpu } from "../src/gpu/device";
import { climateGpu } from "../src/gpu/globe/atmosphere";
import { FACES, tierGrid, type Grid } from "../src/gpu/globe/grid";
import { DEFAULTS, cellVectors, derive, extTables, makeSetup } from "../src/gpu/globe/tectonics";
import { runChain } from "../src/gpu/globe/erosion";
import { DT_LGM, EROSION, IF, IceGpu, bedsOf, books, defaultLaw, forcingTable, landComponents, lgmForcing, orbitOf, runIce, troughs, unitM3, type IceInputs, type IceLaw, type IceRecord, type Trough } from "../src/gpu/globe/ice";
import { annualRain, regionMap } from "./globe-erosion-maps";
import { heightColor, mix, ramp, writeLayers, type Layer, type RGB } from "./globe-maps";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const seed = Number(arg("seed", "1")), work = arg("work", `/tmp/globe-ice/${seed}`), stage = arg("stage", "sweep");
mkdirSync(work, { recursive: true });
const N = 6 * 256 * 256;
const loadF32 = (name: string) => { const b = readFileSync(`${work}/${name}`); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const saveF32 = (name: string, a: Float32Array) => writeFileSync(`${work}/${name}`, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const saveState = async (name: string, ice: IceGpu, meta: Record<string, unknown>) => {
  const s = await ice.readState();
  writeFileSync(`${work}/${name}.state`, new Uint8Array(s.buffer, s.byteOffset, s.byteLength));
  writeFileSync(`${work}/${name}.json`, JSON.stringify({ ...meta, seaM: ice.seaM }));
};
const loadState = (name: string, ice: IceGpu): { seaM: number; offset: number | number[] } & Record<string, unknown> => {
  const b = readFileSync(`${work}/${name}.state`), meta = JSON.parse(readFileSync(`${work}/${name}.json`, "utf8"));
  ice.writeState(new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  ice.seaM = meta.seaM;
  return meta;
};
// A volume field's ice thickness in metres, as the kernels' thick6 rounds it (Q6 m of a volume on a cell of area weight tab[i]).
const thickOf = (v: Int32Array, tab: Int32Array) => Float32Array.from(v, (x, i) => (Math.floor(x / tab[i]) * 1024 + Math.floor(((x % tab[i]) * 1024) / tab[i])) / 64);
// The drowned troughs in a few numbers: all, those of two cells or more, the marine ones (open to the highstand's sea: fjords and drowned
// valleys) and of those the ones cut into the land, reaching two cells or more from the highstand's coast (the rest are strips along it).
function troughSummary(tr: Trough[], g: Grid) {
  const cellKm = (g.radius * g.width) / 1000, long = tr.filter((t) => t.cells >= 2), marine = long.filter((t) => t.marine), inland = marine.filter((t) => t.inlandKm >= 1.5 * cellKm);
  return {
    cells: tr.reduce((s, t) => s + t.cells, 0), count: tr.length, countOver1Cell: long.length, marineOver1Cell: marine.length, marineReachingInland: inland.length, longestKm: tr[0]?.lengthKm ?? 0,
    lengthsKm: long.slice(0, 12).map((t) => Math.round(t.lengthKm)), marineLengthsKm: marine.slice(0, 12).map((t) => Math.round(t.lengthKm)), marineWidthsKm: marine.slice(0, 12).map((t) => Math.round(t.widthKm)),
    marineInlandKm: marine.slice(0, 12).map((t) => Math.round(t.inlandKm)), deepestM: tr.reduce((m, t) => Math.max(m, t.deepestM), 0), marineDeepestM: marine.slice(0, 12).map((t) => Math.round(t.deepestM)),
    inland: inland.slice(0, 12).map((t) => ({ lengthKm: Math.round(t.lengthKm), widthKm: Math.round(t.widthKm), inlandKm: Math.round(t.inlandKm), deepestM: Math.round(t.deepestM) })),
  };
}

// ---- stage 1: the planet ----
async function planetStage() {
  const set = makeSetup({ seed, spanMy: DEFAULTS.spanMy, plates: DEFAULTS.plates, seaLevel: 0 }), ext = extTables(set.grid), gpu = await theGpu();
  const res = await runChain(gpu, set, { rain: (h) => annualRain(h, 0), rainEveryMy: 67, substeps: 4, afterMy: 50 });
  const d = derive(set, ext.tab, res.S), h = Float32Array.from(d.height);
  saveF32("height.f32", h);
  let land = 0; for (let i = 0; i < h.length; i++) if (h[i] > 0) land++;
  console.log(`planet ${seed}: ${res.seconds.toFixed(0)} s, land ${(land / h.length).toFixed(3)} of the cells, highest ${Math.max(...h).toFixed(0)} m`);
}

// ---- stage 2: the climate ----
async function climateStage() {
  const height = loadF32("height.f32"), gpu = await theGpu(), g = tierGrid(0);
  let windowDays = 2, c;
  for (;; windowDays /= 2) {
    try { c = await climateGpu(gpu, g, height, { seaLevel: 0 }, { windowDays }); break; } catch (e) { if (windowDays <= 0.25 || !String(e).includes("accumulator")) throw e; }
  }
  const out = new Float32Array(3 * 4 * N);
  c.seasons.forEach((s, k) => { out.set(s.seaLevelTemperature, (0 * 4 + k) * N); out.set(s.rain, (1 * 4 + k) * N); out.set(s.temperature, (2 * 4 + k) * N); });
  saveF32("climate.f32", out);
  const yearT = (a: Float32Array) => { let s = 0; for (let i = 0; i < N; i++) s += a[i]; return s / N; };
  console.log(`climate: window ${windowDays} days; mean sea-level air ${[0, 1, 2, 3].map((k) => yearT(out.subarray(k * N, (k + 1) * N)).toFixed(1)).join(" ")} C; mean rain ${[0, 1, 2, 3].map((k) => yearT(out.subarray((4 + k) * N, (5 + k) * N)).toFixed(0)).join(" ")} mm a season`);
}

const sliceOf = (a: Float32Array, kind: number) => [0, 1, 2, 3].map((k) => a.subarray((kind * 4 + k) * N, (kind * 4 + k + 1) * N));
const km2 = (g: Grid, areas: Float64Array, mask: (i: number) => boolean) => { let a = 0; for (let i = 0; i < areas.length; i++) if (mask(i)) a += areas[i] * g.radius * g.radius; return a / 1e6; };

async function inputs(): Promise<{ g: Grid; height: Float32Array; inp: IceInputs; law: IceLaw }> {
  const g = tierGrid(0), height = loadF32("height.f32"), clim = loadF32("climate.f32");
  const law = defaultLaw({ erosion: arg("law", "cook") === "herman" ? EROSION.herman : EROSION.cook, kSlide: Number(arg("k-slide", String(defaultLaw().kSlide))) });
  return { g, height, inp: { bed: height, ts: sliceOf(clim, 0), precip: sliceOf(clim, 1) }, law };
}

// ---- the layers ----
const iceColor = (h: number): RGB => ramp([[0, [225, 238, 255]], [300, [170, 205, 245]], [1000, [90, 140, 225]], [2500, [40, 70, 170]]], h);
function layers(g: Grid, height: Float32Array, ela: Int32Array, iceM: Float32Array, cut: Float32Array, after: Float32Array, seaMin: number): Layer[] {
  const drowned = (i: number) => height[i] >= 0 && after[i] < 0;
  return [
    { name: "ela", color: (i) => (ela[i] >= 2147483647 ? [235, 235, 235] : ela[i] <= -64000 ? [30, 70, 130] : ramp([[0, [30, 90, 170]], [1000, [90, 170, 120]], [2500, [230, 210, 110]], [4500, [200, 80, 50]], [7000, [90, 20, 20]]], ela[i] / 64)) },
    { name: "ice", color: (i) => (iceM[i] > 0 ? iceColor(iceM[i]) : height[i] <= 0 ? (height[i] > seaMin ? [236, 190, 120] : heightColor(height[i])) : heightColor(height[i])) },
    { name: "cut", color: (i) => (height[i] <= -1000 ? [20, 30, 60] : ramp([[0, [245, 245, 245]], [20, [250, 220, 140]], [100, [230, 120, 50]], [400, [150, 30, 20]], [1500, [60, 0, 30]]], cut[i])) },
    { name: "drowned", color: (i) => (drowned(i) ? [230, 40, 40] : height[i] >= 0 ? mix(heightColor(height[i]), [255, 255, 255], 0.45) : [30, 60, 100]) },
    { name: "bed-change", color: (i) => ramp([[-800, [150, 30, 20]], [-100, [240, 150, 80]], [0, [245, 245, 245]], [100, [120, 170, 230]], [800, [30, 50, 150]]], after[i] - height[i]) },
  ];
}

// ---- stage 3: equilibrium ice against cooling ----
async function sweepStage() {
  const { g, height, inp, law } = await inputs(), gpu = await theGpu(), ext = extTables(g);
  const ice = new IceGpu(gpu, ext.tab, inp, law), areas = ice.areas, dtMin = Number(arg("dt-min", "2")), outer = Number(arg("outer", "500")), out = arg("out", `/tmp/globe-ice-${seed}`);
  mkdirSync(out, { recursive: true });
  const landKm2 = km2(g, areas, (i) => height[i] > 0), t0 = performance.now();
  ice.setOffset(0);
  const ela0 = await ice.ela(), lat = ice.latDeg;
  const med = (lo: number, hi: number) => { const v: number[] = []; for (let i = 0; i < N; i++) if (Math.abs(lat[i]) >= lo && Math.abs(lat[i]) < hi && ela0[i] < 2147483647 && ela0[i] > -64000) v.push(ela0[i] / 64); v.sort((a, b) => a - b); return v.length ? Math.round(v[Math.floor(v.length / 2)]) : null; };
  const overEla = km2(g, areas, (i) => height[i] > 0 && height[i] > ela0[i] / 64);
  const summary: Record<string, unknown> = { seed, law: arg("law", "cook"), landKm2, highestM: Math.max(...height), elaMedianByLatitude: Object.fromEntries([[0, 15], [15, 30], [30, 45], [45, 60], [60, 75], [75, 90]].map(([a, b]) => [`${a}-${b}`, med(a, b)])), landOverElaAtNoOffset: overEla };
  console.log(JSON.stringify(summary));
  const sweep = arg("sweep", "0,-2,-4,-6,-8,-10").split(",").map(Number), relax = Number(arg("relax", "6000")), rows: Record<string, unknown>[] = [];
  for (const dT of sweep) {
    const recs = await runIce(ice, { years: relax, outerYr: Math.min(outer, relax), offset: () => dT, dtMin });
    const r = recs[recs.length - 1], half = recs[Math.max(0, Math.floor(recs.length / 2) - 1)], b = await books(ice);
    const [iv, bed] = await Promise.all([ice.read(IF.ICE), ice.read(IF.BEF)]);
    const thick = thickOf(iv, ice.aw);
    const lowland = km2(g, areas, (i) => thick[i] > 0 && bed[i] / 64 < 500), seaMin = r.seaM;
    const row = { offsetK: dT, iceAreaKm2: Math.round(r.iceAreaKm2), shareOfLand: r.iceAreaKm2 / landKm2, iceKm3: Math.round(r.iceKm3), seaDropM: -r.seaM, lowlandIceKm2: Math.round(lowland), cappedShare: r.cappedShare, dtMean: r.dtMean, rockKm3: (Number(b.rock) * unitM3(g)) / 1e9, volumeChangeLastHalf: r.iceKm3 > 0 ? (r.iceKm3 - half.iceKm3) / r.iceKm3 : 0 };
    rows.push(row); console.log(JSON.stringify(row), `${((performance.now() - t0) / 1000).toFixed(0)} s`);
    const { cut, after } = await bedsOf(ice);
    if (dT === sweep[sweep.length - 1] || dT === -6) {
      ice.setOffset(dT);
      const ela = await ice.ela();
      writeLayers(g, `${out}/offset${dT}`, layers(g, height, ela, thick, cut, after, seaMin), Number(arg("width", "1440")), false);
    }
  }
  summary.equilibrium = rows; summary.seconds = (performance.now() - t0) / 1000;
  writeFileSync(`${out}/sweep.json`, JSON.stringify(summary, null, 1));
}

// ---- stage 4: an orbit-forced glacial cycle ----
async function cycleStage() {
  const { g, height, inp, law } = await inputs(), gpu = await theGpu(), ext = extTables(g);
  const ice = new IceGpu(gpu, ext.tab, inp, law), areas = ice.areas, dtMin = Number(arg("dt-min", "2")), outer = Number(arg("outer", "500")), years = Number(arg("years", "100000")), out = arg("out", `/tmp/globe-ice-${seed}`);
  mkdirSync(out, { recursive: true });
  const o = orbitOf(seed), uniform = arg("offset", ""), spin = Number(arg("spin", "40000")), f = lgmForcing(o, years, outer), t0 = performance.now(), landKm2 = km2(g, areas, (i) => height[i] > 0);
  let maxVol = -1, maxAt = 0, maxIce: Int32Array | null = null, lowSea = 0, lowAt = 0;
  const off = (t: number) => (uniform ? Number(uniform) : t < spin ? 0 : forcingTable(o, t - spin, f));
  const recs = await runIce(ice, {
    years: spin + years, outerYr: outer, dtMin, offset: off,
    onOuter: async (r) => {
      if (r.iceKm3 > maxVol) {
        maxVol = r.iceKm3; maxAt = r.tYr; maxIce = await ice.read(IF.ICE);
        const fo = off(r.tYr - outer / 2);
        await saveState("max", ice, { tYr: r.tYr, offset: typeof fo === "number" ? fo : Array.from(fo) });
      }
      if (r.seaM < lowSea) { lowSea = r.seaM; lowAt = r.tYr; }
      if (Math.round(r.tYr / outer) % 20 === 0) console.log(`t ${(r.tYr / 1000).toFixed(1)} kyr  offset65 ${r.offset65.toFixed(1)} K  ice ${r.iceKm3.toExponential(2)} km3  area ${r.iceAreaKm2.toExponential(2)} km2  sea ${r.seaM.toFixed(1)} m  dt ${r.dtMean.toFixed(1)}  capped ${r.cappedShare.toFixed(2)}  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    },
  });
  await saveState("end", ice, { tYr: spin + years, offset: 0 });
  const thick = maxIce ? thickOf(maxIce, ice.aw) : new Float32Array(N);
  const { before, after, cut } = await bedsOf(ice), b = await books(ice), tr = troughs(g, before, after);
  const glaciated = km2(g, areas, (i) => thick[i] > 0), cutCells = km2(g, areas, (i) => cut[i] > 10);
  const th = Array.from(thick).filter((x) => x > 0).sort((a, b) => a - b), tmpEnd = await ice.read(IF.TMP), iceEnd = await ice.read(IF.ICE);
  let thickest = 0; for (let i = 0; i < N; i++) if (thick[i] > thick[thickest]) thickest = i;
  const vec0 = cellVectors(g), over4 = km2(g, areas, (i) => thick[i] > 4000);
  const iceThickness = { thickestAt: { latDeg: ice.latDeg[thickest], lonDeg: (Math.atan2(vec0[3 * thickest + 1], vec0[3 * thickest]) * 180) / Math.PI, bedM: height[thickest], iceM: thick[thickest] }, over4kmKm2: over4, meanM: th.reduce((a, b) => a + b, 0) / Math.max(1, th.length), p95M: th[Math.floor(th.length * 0.95)] ?? 0, maxM: th[th.length - 1] ?? 0 };
  const temperateShare = km2(g, areas, (i) => iceEnd[i] > 0 && tmpEnd[i] === 1) / Math.max(1e-9, km2(g, areas, (i) => iceEnd[i] > 0));
  const spinEnd = recs[Math.round(spin / outer) - 1];
  let maxCut = 0, maxCutAt = 0; for (let i = 0; i < N; i++) if (before[i] > 0 && cut[i] > maxCut) { maxCut = cut[i]; maxCutAt = i; }
  const coldest = Math.min(...recs.map((r) => r.offset65));
  ice.setOffset(coldest);
  const ela = await ice.ela();
  // lowland (land under 500 m at the highstand): where the coldest offset puts the equilibrium line at or under the ground (ice can start there
  // in place), and where ice stood at the maximum
  const lowland = (i: number) => height[i] > 0 && height[i] < 500;
  const lowlandIce = { lowlandKm2: km2(g, areas, lowland), inceptionKm2AtColdest: km2(g, areas, (i) => lowland(i) && ela[i] / 64 <= height[i]), iceKm2AtMax: km2(g, areas, (i) => lowland(i) && thick[i] > 0), coldestOffset65K: coldest };
  const summary = {
    seed, law: arg("law", "cook"), years, spinYears: spin, orbitPhase: o.phase, gain: f.gain, base: f.base, landKm2, maxIceKm3: maxVol, maxIceAtKyr: maxAt / 1000, glaciatedKm2AtMax: glaciated, glaciatedShareOfLand: glaciated / landKm2,
    seaDropM: -lowSea, seaLowestAtKyr: lowAt / 1000, finalSeaM: recs[recs.length - 1].seaM, finalIceKm3: recs[recs.length - 1].iceKm3, cutOver10mKm2: cutCells, iceThickness, temperateShareAtEnd: temperateShare, interglacial: spinEnd ? { iceKm3: spinEnd.iceKm3, iceAreaKm2: spinEnd.iceAreaKm2, seaM: spinEnd.seaM } : null, maxCutM: maxCut, rockKm3: (Number(b.rock) * unitM3(g)) / 1e9,
    dissolvedKm3: (Number(b.dissolved) * unitM3(g)) / 1e9, debrisInIceKm3: (Number(b.debris) * unitM3(g)) / 1e9,
    troughs: troughSummary(tr, g),
    landComponentsBefore: landComponents(g, before), landComponentsAfter: landComponents(g, after), seconds: (performance.now() - t0) / 1000,
    cappedShareMean: recs.reduce((s, r) => s + r.cappedShare, 0) / recs.length, lowlandIce,
  };
  writeFileSync(`${out}/cycle.json`, JSON.stringify(summary, null, 1));
  writeFileSync(`${out}/timeline.csv`, ["tKyr,offset65K,iceKm3,iceAreaKm2,seaM,dtMean,cappedShare", ...recs.map((r: IceRecord) => [r.tYr / 1000, r.offset65, r.iceKm3, r.iceAreaKm2, r.seaM, r.dtMean, r.cappedShare].join(","))].join("\n"));
  writeLayers(g, out, layers(g, height, ela, thick, cut, after, lowSea), Number(arg("width", "1440")), false);
  const vec = cellVectors(g), zoom = arg("zoom", "").split(",").filter(Boolean).map(Number), lonOf = (i: number) => (Math.atan2(vec[3 * i + 1], vec[3 * i]) * 180) / Math.PI;
  const fjord = tr.find((t) => t.marine && t.cells >= 2);
  const views: [string, number, number, number][] = zoom.length === 3 ? [["zoom", zoom[0], zoom[1], zoom[2]]] : [["zoom-cut", ice.latDeg[maxCutAt], lonOf(maxCutAt), 14]];
  if (fjord && zoom.length !== 3) views.push(["zoom-trough", ice.latDeg[fjord.deepestAt], lonOf(fjord.deepestAt), 8]);
  for (const [name, la, lo, sp] of views) {
    writeFileSync(`${out}/${name}-before.png`, regionMap(g, before, la, lo, sp));
    writeFileSync(`${out}/${name}-after.png`, regionMap(g, after, la, lo, sp));
    writeFileSync(`${out}/${name}-ice.png`, regionMap(g, Float32Array.from(before, (v, i) => v + thick[i]), la, lo, sp));
  }
  console.log(JSON.stringify(summary, null, 1));
  console.log(`DT_LGM ${DT_LGM}`);
}

// ---- stage 5: the flux cap's bias, from the maximum ----
async function biasStage() {
  const { g, inp, law } = await inputs(), gpu = await theGpu(), ext = extTables(g), ice = new IceGpu(gpu, ext.tab, inp, law), areas = ice.areas, years = Number(arg("years", "5000"));
  const rows: Record<string, number>[] = [], t0 = performance.now();
  for (const dtMin of arg("dt-mins", "2,1,0.5").split(",").map(Number)) {
    const meta = loadState("max", ice), fo = typeof meta.offset === "number" ? meta.offset : Float64Array.from(meta.offset);
    const rock0 = (await books(ice)).rock;
    ice.dtYr = dtMin;
    const recs = await runIce(ice, { years, outerYr: 500, offset: () => fo, dtMin }), r = recs[recs.length - 1];
    const thick = thickOf(await ice.read(IF.ICE), ice.aw);
    let hmax = 0; for (let i = 0; i < N; i++) hmax = Math.max(hmax, thick[i]);
    const row = { dtMin, iceKm3: r.iceKm3, iceAreaKm2: r.iceAreaKm2, seaM: r.seaM, maxIceM: hmax, over2kmKm2: km2(g, areas, (i) => thick[i] > 2000), rockCutKm3: (Number((await books(ice)).rock - rock0) * unitM3(g)) / 1e9, cappedShare: recs.reduce((s, x) => s + x.cappedShare, 0) / recs.length, seconds: (performance.now() - t0) / 1000 };
    rows.push(row); console.log(JSON.stringify(row));
  }
  writeFileSync(`${arg("out", `/tmp/globe-ice-${seed}`)}/bias.json`, JSON.stringify({ seed, years, from: "max.state", rows }, null, 1));
}

// ---- stage 6: the sea's return, from the cycle's end ----
async function meltStage() {
  const { g, inp, law } = await inputs(), gpu = await theGpu(), ext = extTables(g), ice = new IceGpu(gpu, ext.tab, inp, law), dtMin = Number(arg("dt-min", "2")), out = arg("out", `/tmp/globe-ice-${seed}`);
  const start = loadState("end", ice);
  const warmRecs = await runIce(ice, { years: 40_000, outerYr: 500, offset: () => 6, dtMin, dtMax: 500 });
  let fastest = 0; for (let k = 1; k < warmRecs.length; k++) fastest = Math.max(fastest, (warmRecs[k].seaM - warmRecs[k - 1].seaM) / 0.5); // m a kyr
  const warm = warmRecs[warmRecs.length - 1];
  const gone = await runIce(ice, { years: 200_000, outerYr: 5000, offset: () => 30, dtMin, dtMax: 5000 }), dep = await ice.read(IF.DEP), end = gone[gone.length - 1];
  const { before, after } = await bedsOf(ice), tr = troughs(g, before, after);
  const melt = { seed, startSeaM: start.seaM, at6K: { iceKm3: warm.iceKm3, seaM: warm.seaM, fastestRiseMPerKyr: fastest }, atPlus30K: { iceKm3: end.iceKm3, seaM: end.seaM, maxDepressionLeftM: Math.max(...dep) / 4096 }, troughs: troughSummary(tr, g), landComponentsBefore: landComponents(g, before), landComponentsAfter: landComponents(g, after) };
  writeFileSync(`${out}/melt.json`, JSON.stringify(melt, null, 1));
  writeLayers(g, `${out}/melted`, [{ name: "drowned", color: (i) => (before[i] >= 0 && after[i] < 0 ? [230, 40, 40] : after[i] >= 0 ? heightColor(after[i]) : [30, 60, 100]) }], Number(arg("width", "1440")), false);
  console.log(JSON.stringify(melt, null, 1));
}

// ---- stage 7: the glacial maximum carried on at tier 1 (6 km cells) against tier 0 over the same years ----
// A tier-0 field goes to tier 1 by bilinear interpolation between cell centres in a face's own angles (the centres nest: four tier-1 cells to a
// tier-0 cell), clamped at the face's edge. The bed so made has no relief under 12 km but what the ice then cuts [design].
function prolong(g0: Grid, g1: Grid, a: ArrayLike<number>): Float32Array {
  const n0 = g0.fn, n1 = g1.fn, out = new Float32Array(FACES * n1 * n1);
  for (let f = 0; f < FACES; f++)
    for (let Y = 0; Y < n1; Y++)
      for (let X = 0; X < n1; X++) {
        const u = Math.min(n0 - 1, Math.max(0, (X + 0.5) / 2 - 0.5)), v = Math.min(n0 - 1, Math.max(0, (Y + 0.5) / 2 - 0.5));
        const x0 = Math.min(n0 - 2, Math.floor(u)), y0 = Math.min(n0 - 2, Math.floor(v)), fx = u - x0, fy = v - y0, base = f * n0 * n0;
        const lo = a[base + y0 * n0 + x0] * (1 - fx) + a[base + y0 * n0 + x0 + 1] * fx, hi = a[base + (y0 + 1) * n0 + x0] * (1 - fx) + a[base + (y0 + 1) * n0 + x0 + 1] * fx;
        out[(f * n1 + Y) * n1 + X] = lo * (1 - fy) + hi * fy;
      }
  return out;
}
async function tier1Stage() {
  const { g, inp, law } = await inputs(), gpu = await theGpu(), years = Number(arg("years", "10000")), out = arg("out", `/tmp/globe-ice-${seed}`), radiusKm = Number(arg("radius-km", "600"));
  const ice0 = new IceGpu(gpu, extTables(g).tab, inp, law), meta = loadState("max", ice0), fo = typeof meta.offset === "number" ? meta.offset : Float64Array.from(meta.offset);
  const atMax = await bedsOf(ice0), h0 = thickOf(await ice0.read(IF.ICE), ice0.aw), dep0 = await ice0.read(IF.DEP);
  // the region: around the cell the ice had cut deepest by the maximum, or --at "lat,lon"
  let deepest = 0; for (let i = 0; i < ice0.N; i++) if (atMax.before[i] > 0 && atMax.cut[i] > atMax.cut[deepest]) deepest = i;
  const vec0 = cellVectors(g), at = arg("at", "").split(",").filter(Boolean).map(Number);
  const [la0, lo0] = at.length === 2 ? at : [ice0.latDeg[deepest], (Math.atan2(vec0[3 * deepest + 1], vec0[3 * deepest]) * 180) / Math.PI];
  const t0 = performance.now();
  ice0.dtYr = 2;
  const r0 = await runIce(ice0, { years, outerYr: 500, offset: () => fo, dtMin: 2 }), end0 = await bedsOf(ice0), hEnd0 = thickOf(await ice0.read(IF.ICE), ice0.aw);
  const s0 = (performance.now() - t0) / 1000;
  ice0.release();
  const g1 = tierGrid(1), up = (a: ArrayLike<number>) => prolong(g, g1, a);
  const ice1 = new IceGpu(gpu, extTables(g1).tab, { bed: up(atMax.after), ts: inp.ts.map(up), precip: inp.precip.map(up) }, law);
  ice1.write(IF.ICE, Int32Array.from(up(h0), (h, i) => Math.round((h * ice1.aw[i]) / 16)));
  ice1.write(IF.DEP, Int32Array.from(up(dep0), Math.round));
  ice1.seaM = meta.seaM; ice1.dtYr = 0.5;
  const r1 = await runIce(ice1, { years, outerYr: 500, offset: () => fo, dtMin: 0.5 }), end1 = await bedsOf(ice1), hEnd1 = thickOf(await ice1.read(IF.ICE), ice1.aw);
  const before1 = up(atMax.before), after1 = end1.after;
  // the region's troughs at each tier: cells outside the region count as unchanged land
  const D = Math.PI / 180, region = (gr: Grid, before: Float32Array, after: Float32Array) => {
    const v = cellVectors(gr), c = [Math.cos(la0 * D) * Math.cos(lo0 * D), Math.cos(la0 * D) * Math.sin(lo0 * D), Math.sin(la0 * D)], b = Float32Array.from(before), a = Float32Array.from(after);
    for (let i = 0; i < b.length; i++) if (Math.acos(Math.min(1, v[3 * i] * c[0] + v[3 * i + 1] * c[1] + v[3 * i + 2] * c[2])) * (gr.radius / 1000) > radiusKm) { b[i] = 1; a[i] = 1; }
    return troughSummary(troughs(gr, b, a), gr);
  };
  const last = (r: IceRecord[]) => ({ iceKm3: r[r.length - 1].iceKm3, iceAreaKm2: r[r.length - 1].iceAreaKm2, seaM: r[r.length - 1].seaM, cappedShare: r.reduce((s, x) => s + x.cappedShare, 0) / r.length, steps: r.reduce((s, x) => s + x.steps, 0) });
  const summary = {
    seed, years, centre: { latDeg: la0, lonDeg: lo0 }, radiusKm, startSeaM: meta.seaM,
    tier0: { ...last(r0), seconds: s0, regionTroughs: region(g, end0.before, end0.after), globeTroughs: troughSummary(troughs(g, end0.before, end0.after), g) },
    tier1: { ...last(r1), seconds: (performance.now() - t0) / 1000 - s0, regionTroughs: region(g1, before1, after1), globeTroughs: troughSummary(troughs(g1, before1, after1), g1) },
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/tier1.json`, JSON.stringify(summary, null, 1));
  const sp = Number(arg("span", "10"));
  writeFileSync(`${out}/tier1-t0-after.png`, regionMap(g, end0.after, la0, lo0, sp));
  writeFileSync(`${out}/tier1-t1-after.png`, regionMap(g1, after1, la0, lo0, sp));
  writeFileSync(`${out}/tier1-t0-ice.png`, regionMap(g, Float32Array.from(end0.after, (v, i) => v + hEnd0[i]), la0, lo0, sp));
  writeFileSync(`${out}/tier1-t1-ice.png`, regionMap(g1, Float32Array.from(after1, (v, i) => v + hEnd1[i]), la0, lo0, sp));
  console.log(JSON.stringify(summary, null, 1));
}

if (import.meta.main) {
  if (stage === "planet") await planetStage();
  else if (stage === "climate") await climateStage();
  else if (stage === "sweep") await sweepStage();
  else if (stage === "cycle") await cycleStage();
  else if (stage === "bias") await biasStage();
  else if (stage === "melt") await meltStage();
  else if (stage === "tier1") await tier1Stage();
  else throw new Error(`unknown stage ${stage}`);
  await releaseGpu();
  process.exit(0);
}
