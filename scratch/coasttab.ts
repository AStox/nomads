// Coast table of the raw chain dump: one row per coast land cell, and the summaries.
import { writeFileSync } from "node:fs";
import { raw, DIR } from "./labload";
import { CHAIN } from "../src/gpu/globe/window";
import { FACES, PLANET_RADIUS_M, cellId, meanCellM, step } from "../src/gpu/globe/grid";
import { cellAreas, classifyBoundaries, makeSetup, neighbours } from "../src/gpu/globe/tectonics";

const r = raw(), g = r.grid, N = r.n, fn = g.fn, nb = neighbours(g), k = r.meta.kmPerUnit as number;
const set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius: PLANET_RADIUS_M });
const bd = classifyBoundaries(g, r.plate, set.plates);
const h = r.height, land = (i: number) => h[i] > 0, cont = (i: number) => r.granitoid[i] + r.metaSed[i] + r.volcanic[i];
const NAMES = ["PASSIVE", "ACTIVE", "OTHER"], BINS = ["<1", "1-10", "10-30", "30-100", "100-300", "300-1000", ">1000"];
const binOf = (d: number) => (d < 1 ? 0 : d < 10 ? 1 : d < 30 ? 2 : d < 100 ? 3 : d < 300 ? 4 : d < 1000 ? 5 : 6);
const rows: string[] = ["face,X,Y,landH,deepD,shallowD,seaSed,seaCont,seaBasalt,seaAgeMy,plateL,plateS,clsL,speedL,clsS,speedS,acc,mouth,dep3km3,depth10,margin"];
const stat: { cls: number; dBin: number; sed: number; cont: number; age: number; dep: number; line: number[] }[] = [];
let edges = 0;
for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
  const i = cellId(g, f, X, Y);
  if (!land(i)) continue;
  let deep = -1, shallow = -1, dd = -Infinity, sd = Infinity, dir = -1;
  for (let d = 0; d < 4; d++) {
    const j = nb[4 * i + d];
    if (land(j)) continue;
    edges++;
    const dep = -h[j];
    if (dep > dd) { dd = dep; deep = j; dir = d; }
    if (dep < sd) { sd = dep; shallow = j; }
  }
  if (deep < 0) continue;
  const s = deep;
  const margin = bd.cls[i] === 1 || bd.cls[s] === 1 ? 1 : r.plate[i] === r.plate[s] ? 0 : 2;
  let dep3 = 0; // sea cells in the 7 by 7 box around the land cell, in its face (clipped at the face edge)
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const x = X + dx, y = Y + dy;
    if (x < 0 || y < 0 || x >= fn || y >= fn) continue;
    const j = cellId(g, f, x, y);
    if (!land(j)) dep3 += r.depositedV[j];
  }
  dep3 *= k;
  // the sea depth at 1..12 cells out along the land-to-sea direction, staying in the face and in the sea
  const line: number[] = [];
  let cf = f, cx = X, cy = Y, ok = true;
  for (let t = 1; t <= 12; t++) {
    const st = step(g, cf, cx, cy, dir);
    if (!ok || st.face !== cf) { ok = false; line.push(-1); continue; }
    cx = st.X; cy = st.Y;
    const j = cellId(g, cf, cx, cy);
    if (land(j)) { ok = false; line.push(-1); } else line.push(-h[j]);
  }
  const dD = -h[s];
  rows.push([f, X, Y, h[i].toFixed(2), dD.toFixed(2), sd.toFixed(2), r.sediment[s].toFixed(1), cont(s).toFixed(1), r.basalt[s].toFixed(1), r.age[s].toFixed(1), r.plate[i], r.plate[s],
    bd.cls[i], bd.speed[i].toFixed(2), bd.cls[s], bd.speed[s].toFixed(2), r.acc[i], land(r.to[i]) ? 0 : 1, dep3.toFixed(1), line[9].toFixed(2), NAMES[margin]].join(","));
  stat.push({ cls: margin, dBin: binOf(dD), sed: r.sediment[s], cont: cont(s), age: r.age[s], dep: dep3, line });
}
writeFileSync(DIR + "coast.csv", rows.join("\n") + "\n");
const q = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const quart = (a: number[]) => `${q(a, 0.25).toFixed(1)} / ${q(a, 0.5).toFixed(1)} / ${q(a, 0.75).toFixed(1)}`;
const T = stat.length;
console.log(`(a) coast land cells ${T}`);
for (let c = 0; c < 3; c++) { const n = stat.filter((s) => s.cls === c).length; console.log(`  ${NAMES[c]}: ${n} (${((100 * n) / T).toFixed(1)}%)`); }
console.log("(b) share % by deepest-sea-neighbour depth bin m: " + BINS.join(" | "));
for (let c = 0; c < 3; c++) { const a = stat.filter((s) => s.cls === c); console.log(`  ${NAMES[c]}: ` + BINS.map((_, b) => ((100 * a.filter((s) => s.dBin === b).length) / a.length).toFixed(1)).join(" | ")); }
console.log("(c) quartiles q25/q50/q75 of: sea sediment m; continental rock m; basalt age My; deposited km3 within 3");
for (let c = 0; c < 3; c++) { const a = stat.filter((s) => s.cls === c); console.log(`  ${NAMES[c]}: sed ${quart(a.map((s) => s.sed))}; cont ${quart(a.map((s) => s.cont))}; age ${quart(a.map((s) => s.age))}; dep ${quart(a.map((s) => s.dep))}`); }
console.log("(d) depth bin: n, share sea-sediment under 1 m, share continental rock over 1 m");
for (let b = 0; b < 7; b++) { const a = stat.filter((s) => s.dBin === b), n = a.length; console.log(`  ${BINS[b]}: n ${n}, sed<1m ${((100 * a.filter((s) => s.sed < 1).length) / n).toFixed(0)}%, cont>1m ${((100 * a.filter((s) => s.cont > 1).length) / n).toFixed(0)}%`); }
console.log("  crosstab bin x (sed>=1m, cont>1m): counts [nosed&nocont, nosed&cont, sed&nocont, sed&cont]");
for (let b = 0; b < 7; b++) { const a = stat.filter((s) => s.dBin === b), c4 = [0, 0, 0, 0]; for (const s of a) c4[(s.sed >= 1 ? 2 : 0) + (s.cont > 1 ? 1 : 0)]++; console.log(`  ${BINS[b]}: ${c4.join(" ")}`); }
console.log("(e) median depth m (n paths) at distance 1..12 along land-to-sea direction");
for (let c = 0; c < 3; c++) { const a = stat.filter((s) => s.cls === c); console.log(`  ${NAMES[c]}: ` + Array.from({ length: 12 }, (_, t) => { const v = a.filter((s) => s.line[t] >= 0 && s.line.slice(0, t + 1).every((x) => x >= 0)).map((s) => s.line[t]); return `${t + 1}:${q(v, 0.5).toFixed(0)}(${v.length})`; }).join(" ")); }
const areas = cellAreas(g); let la = 0; for (let i = 0; i < N; i++) if (land(i)) la += areas[i];
const R = g.radius / 1000, landKm2 = la * R * R, coastKm = (edges * meanCellM(g)) / 1000;
console.log(`(f) coast edges ${edges}; coast length ${coastKm.toFixed(0)} km (edge * ${(meanCellM(g) / 1000).toFixed(3)} km); land ${landKm2.toFixed(0)} km2; coast per land area ${(coastKm / landKm2).toFixed(4)} km/km2`);
