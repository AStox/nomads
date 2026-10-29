// Lab dump of the raw chain (no margin stage). Run repeatedly until it says dumped; each call is one part of BUDGET s.
// Per-cell removed/deposited volumes are summed across parts in the part file.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { holdGpu, exit } from "../scripts/seeded";
import { theGpu } from "../src/gpu/device";
import { runChain, erosionFor, CREEP_SEA, SHELF_SLOPE, type ChainState } from "../src/gpu/globe/erosion";
import { CHAIN, annualRain, unpackRecord } from "../src/gpu/globe/window";
import { PLANET_RADIUS_M, FACES, cellId, fieldWords, wordAt, slotOf, inTile, TILE_WORDS } from "../src/gpu/globe/grid";
import { FLD, PHYS, extTables, fineHeight, makeSetup, unpad } from "../src/gpu/globe/tectonics";
import { SHIFT } from "../src/gpu/wgsl/globe-grid";

const OUT = (process.env.RAW_DIR ?? "/Users/adamstockermans/.cache/nomads-scratch/t7/raw").replace(/\/*$/, "/"), PART = OUT + "part/", BUDGET = Number(process.env.BUDGET ?? 150);
mkdirSync(PART, { recursive: true });
const wr = (n: string, a: ArrayBufferView) => writeFileSync(OUT + n, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const rd = <T,>(n: string, C: new (b: ArrayBuffer) => T): T => { const b = readFileSync(PART + n); return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

await holdGpu();
const gpu = await theGpu(), radius = PLANET_RADIUS_M;
const set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius, ...(process.env.STEP_MY ? { stepMy: Number(process.env.STEP_MY) } : {}) }), ext = extTables(set.grid), g = set.grid, N = FACES * g.fn * g.fn;
let resume: ChainState | undefined, before = 0, rv0: Float64Array | undefined, ad0: Float64Array | undefined;
if (existsSync(PART + "meta.json")) {
  const m = JSON.parse(readFileSync(PART + "meta.json", "utf8"));
  resume = { S: rd("S", Int32Array), carryLo: rd("carryLo", Int32Array), carryHi: rd("carryHi", Int32Array), rain: rd("rain", Float32Array), nextRain: m.nextRain, step: m.step, quiet: m.quiet, rounds: m.rounds, ledger: m.ledger };
  before = m.seconds; rv0 = rd("removedV", Float64Array); ad0 = rd("depositedV", Float64Array);
}
// Lab switches: SUBSTEPS (erosion substeps per tectonic step; 0 = tectonics only), SNAP (comma list of tectonic steps, or "every:N": write snap-<step>.{height.f32,plate.i32,thick.f32} into the dump dir).
const snaps = process.env.SNAP ?? "", every = snaps.startsWith("every:") ? Number(snaps.slice(6)) : 0, list = new Set(every ? [] : snaps.split(",").filter(Boolean).map(Number));
const onStep = snaps ? async (s: number, _er: unknown, tec: { elevate(): void; read(): Promise<Int32Array> }) => {
  if (!(every ? s % every === 0 : list.has(s))) return;
  tec.elevate();
  const Ss = await tec.read(), h = fineHeight(set, ext.tab, Ss), fwx = fieldWords(g), th = new Float32Array(N);
  for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
    const i = cellId(g, f, X, Y), at = wordAt(g, f, X, Y), a = ext.tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
    let v = 0; for (let k = 0; k < 5; k++) v += (Ss[(FLD.VB + k) * fwx + at] >>> 0);
    th[i] = (v * 16) / a;
  }
  wr(`snap-${String(s).padStart(3, "0")}.height.f32`, h); wr(`snap-${String(s).padStart(3, "0")}.plate.i32`, unpad(g, Ss, FLD.PL)); wr(`snap-${String(s).padStart(3, "0")}.thick.f32`, th);
} : undefined;
const res = await runChain(gpu, set, { rain: (h) => annualRain(gpu, h, radius), rainEveryMy: CHAIN.rainEveryMy, substeps: process.env.SUBSTEPS !== undefined ? Number(process.env.SUBSTEPS) : CHAIN.substeps, onStep, afterMy: CHAIN.afterMy, resume, budgetS: process.env.WHOLE ? undefined : BUDGET, params: { ...erosionFor(radius), creepSea: CREEP_SEA * Number(process.env.CREEP_SEA_X ?? 1), shelfSlope: process.env.SHELF_SLOPE ? Number(process.env.SHELF_SLOPE) : SHELF_SLOPE }, track: true });
const removedV = res.removedV!, depositedV = res.depositedV!;
if (rv0) for (let i = 0; i < N; i++) { removedV[i] += rv0[i]; depositedV![i] += ad0![i]; }
const seconds = before + res.seconds;
if (res.stopped) {
  const s = res.stopped;
  for (const [n, a] of [["S", s.S], ["carryLo", s.carryLo], ["carryHi", s.carryHi], ["rain", s.rain], ["removedV", removedV], ["depositedV", depositedV]] as const) writeFileSync(PART + n, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  writeFileSync(PART + "meta.json", JSON.stringify({ nextRain: s.nextRain, step: s.step, quiet: s.quiet, rounds: s.rounds, ledger: s.ledger, seconds }));
  console.log(`part kept at step ${s.step} quiet ${s.quiet}, ${seconds.toFixed(0)} s so far`);
  await exit(0);
}
const S = res.S, fw = fieldWords(g), height = fineHeight(set, ext.tab, S);
wr("S.i32", S); wr("removedV.f64", removedV); wr("depositedV.f64", depositedV); wr("to.u32", res.flow.to); wr("acc.u32", res.flow.acc); wr("rain.f32", res.rain); wr("height.f32", height);
// Thickness in m of a volume v on a cell of area weight a: v * 16 / a (tectonics.ts derive and fineHeight).
const pools = Array.from({ length: 5 }, () => new Float32Array(N)), age = new Float32Array(N), org = new Float32Array(N), plate = new Uint8Array(N);
for (let f = 0; f < FACES; f++) for (let Y = 0; Y < g.fn; Y++) for (let X = 0; X < g.fn; X++) {
  const i = cellId(g, f, X, Y), at = wordAt(g, f, X, Y), a = ext.tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
  for (let k = 0; k < 5; k++) pools[k][i] = ((S[(FLD.VB + k) * fw + at] >>> 0) * 16) / a;
  const vb = S[FLD.VB * fw + at] >>> 0, nb = vb >>> PHYS.AGE_SHIFT;
  age[i] = nb > 0 ? Math.min(Math.floor((S[FLD.AGB * fw + at] >>> 0) / nb), PHYS.AGE_MAX) * PHYS.AGE_UNIT_MY : 0;
  let vt = 0; for (let k = 0; k < 5; k++) vt = (vt + (S[(FLD.VB + k) * fw + at] >>> 0)) >>> 0;
  const nt = vt >>> PHYS.AGE_SHIFT;
  org[i] = nt > 0 ? Math.min(Math.floor((S[FLD.ORG * fw + at] >>> 0) / nt), PHYS.AGE_MAX) * PHYS.AGE_UNIT_MY : 0;
  plate[i] = S[FLD.PL * fw + at];
}
["basalt", "sediment", "meta_sed", "granitoid", "volcanic"].forEach((n, k) => wr(n + ".f32", pools[k]));
wr("age.f32", age); wr("orogeny.f32", org); wr("plate.u8", plate);
const ice = unpackRecord(new Uint8Array(readFileSync("/Users/adamstockermans/.cache/nomads-scratch/t5/bake/small/store/1-b4c6e7d1b819/ice.bin"))).meta;
const kmPerUnit = (16 * ((2 * Math.PI) / 3 / (g.fn * g.fn) / 2 ** SHIFT.area) * radius * radius) / 1e9;
writeFileSync(OUT + "meta.json", JSON.stringify({
  ledger: { removed: String(res.ledger.removed), deposited: String(res.ledger.deposited), dissolved: String(res.ledger.dissolved) }, carry: String(res.carry),
  fw, grid: { fn: g.fn, radius: g.radius, faces: FACES, n: N }, FLD, iceFreeSeaLevelM: 0, seaNowM: ice.nowM, seaLowM: ice.lowM, kmPerUnit, seconds, rounds: res.rounds,
}, null, 1));
rmSync(PART, { recursive: true, force: true });
if (process.env.CREEP_SEA_X || process.env.SHELF_SLOPE || process.env.RAW_DIR) { console.log(`dumped variant; ${seconds.toFixed(0)} s`); await exit(0); }
// the dump's height must be the t5 store's
const chain = unpackRecord(new Uint8Array(readFileSync("/Users/adamstockermans/.cache/nomads-scratch/t5/bake/small/store/1-b4c6e7d1b819/chain.bin"))).arrays.height as Float32Array;
let diff = 0; for (let i = 0; i < N; i++) if (chain[i] !== height[i] && !(Number.isNaN(chain[i]) && Number.isNaN(height[i]))) diff++;
console.log(`dumped; ${seconds.toFixed(0)} s; height differs from the t5 chain.bin in ${diff} of ${N} cells`);
await exit(diff ? 1 : 0);
