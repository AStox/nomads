// Lab dump of the raw chain (no margin stage). Run repeatedly until it says dumped; each call is one part of BUDGET s.
// Per-cell removed/deposited volumes are summed across parts in the part file.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { holdGpu, exit } from "../scripts/seeded";
import { theGpu } from "../src/gpu/device";
import { runChain, erosionFor, type ChainState } from "../src/gpu/globe/erosion";
import { CHAIN, annualRain, unpackRecord } from "../src/gpu/globe/window";
import { PLANET_RADIUS_M, FACES, cellId, fieldWords, wordAt, slotOf, inTile, TILE_WORDS } from "../src/gpu/globe/grid";
import { FLD, PHYS, extTables, fineHeight, makeSetup, unpad } from "../src/gpu/globe/tectonics";
import { SHIFT } from "../src/gpu/wgsl/globe-grid";

const OUT = "/Users/adamstockermans/.cache/nomads-scratch/t7/raw/", PART = OUT + "part/", BUDGET = Number(process.env.BUDGET ?? 150);
mkdirSync(PART, { recursive: true });
const wr = (n: string, a: ArrayBufferView) => writeFileSync(OUT + n, new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
const rd = <T,>(n: string, C: new (b: ArrayBuffer) => T): T => { const b = readFileSync(PART + n); return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

await holdGpu();
const gpu = await theGpu(), radius = PLANET_RADIUS_M;
const set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius }), ext = extTables(set.grid), g = set.grid, N = FACES * g.fn * g.fn;
let resume: ChainState | undefined, before = 0, rv0: Float64Array | undefined, ad0: Float64Array | undefined;
if (existsSync(PART + "meta.json")) {
  const m = JSON.parse(readFileSync(PART + "meta.json", "utf8"));
  resume = { S: rd("S", Int32Array), carryLo: rd("carryLo", Int32Array), carryHi: rd("carryHi", Int32Array), rain: rd("rain", Float32Array), nextRain: m.nextRain, step: m.step, quiet: m.quiet, rounds: m.rounds, ledger: m.ledger };
  before = m.seconds; rv0 = rd("removedV", Float64Array); ad0 = rd("depositedV", Float64Array);
}
const res = await runChain(gpu, set, { rain: (h) => annualRain(gpu, h, radius), rainEveryMy: CHAIN.rainEveryMy, substeps: CHAIN.substeps, afterMy: CHAIN.afterMy, resume, budgetS: process.env.WHOLE ? undefined : BUDGET, params: erosionFor(radius), track: true });
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
// the dump's height must be the t5 store's
const chain = unpackRecord(new Uint8Array(readFileSync("/Users/adamstockermans/.cache/nomads-scratch/t5/bake/small/store/1-b4c6e7d1b819/chain.bin"))).arrays.height as Float32Array;
let diff = 0; for (let i = 0; i < N; i++) if (chain[i] !== height[i] && !(Number.isNaN(chain[i]) && Number.isNaN(height[i]))) diff++;
console.log(`dumped; ${seconds.toFixed(0)} s; height differs from the t5 chain.bin in ${diff} of ${N} cells`);
await exit(diff ? 1 : 0);
