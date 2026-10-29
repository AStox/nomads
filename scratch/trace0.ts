// Contour straightness through the chain's snapshots (scratch/chainraw.ts SNAP=...): coast (h>0), the continental-crust edge (total thickness over CRUST_M) and the plate boundary,
// as the share of edges in straight lattice runs of 6/10/16+ ; and the window view of one place at the steps asked.
//   bun scratch/trace0.ts <snapdir> [face X0 Y0 W H [step,step,...]]      snapshots are snap-<step>.{height.f32,plate.i32,thick.f32}; step "start" is the seed's planet
import { readFileSync, readdirSync } from "node:fs";
import { cellId, tierGrid, FACES, slotOf, inTile, TILE_WORDS } from "../src/gpu/globe/grid";
import { edgeRunsBy } from "./lattice0";
import { makeSetup, extTables, startingState, fineHeight, FLD } from "../src/gpu/globe/tectonics";
import { CHAIN } from "../src/gpu/globe/window";
import { PLANET_RADIUS_M, wordAt, fieldWords } from "../src/gpu/globe/grid";

const dir = process.argv[2].replace(/\/*$/, "/"), CRUST_M = 15000, fn = 256, g = tierGrid(0);
const f32 = (p: string) => { const b = readFileSync(p); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const i32 = (p: string) => { const b = readFileSync(p); return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
interface Snap { h: Float32Array; pl: Int32Array; th: Float32Array }
function load(step: string): Snap {
  if (step === "start") {
    const set = makeSetup({ seed: 1, spanMy: CHAIN.spanMy, plates: CHAIN.plates, seaLevel: 0, radius: PLANET_RADIUS_M }), ext = extTables(set.grid), st = startingState(set, ext.tab);
    const fw = fieldWords(g), th = new Float32Array(FACES * fn * fn);
    for (let f = 0; f < FACES; f++) for (let Y = 0; Y < fn; Y++) for (let X = 0; X < fn; X++) {
      const at = wordAt(g, f, X, Y), a = ext.tab.words[slotOf(g, f, X, Y) * TILE_WORDS + inTile(X, Y)];
      let v = 0; for (let k = 0; k < 5; k++) v += st.S[(FLD.VB + k) * fw + at] >>> 0;
      th[cellId(g, f, X, Y)] = (v * 16) / a;
    }
    return { h: fineHeight(set, ext.tab, st.S), pl: Int32Array.from(st.plate), th };
  }
  const p = String(step).padStart(3, "0");
  return { h: f32(dir + `snap-${p}.height.f32`), pl: i32(dir + `snap-${p}.plate.i32`), th: f32(dir + `snap-${p}.thick.f32`) };
}
const row = (n: string, s: Snap) => {
  const c = edgeRunsBy(s.h, (a, b) => (a > 0) !== (b > 0)), k = edgeRunsBy(s.th, (a, b) => (a > CRUST_M) !== (b > CRUST_M)), p = edgeRunsBy(s.pl, (a, b) => a !== b);
  let land = 0; for (const v of s.h) if (v > 0) land++;
  const f = (r: { total: number; shares: number[] }) => `${String(r.total).padStart(5)} ${r.shares.map((x) => x.toFixed(3)).join("/")}`;
  console.log(`${n.padStart(5)} land ${(land / s.h.length).toFixed(3)} | coast ${f(c)} | crust ${f(k)} | plate ${f(p)}`);
};
const steps = readdirSync(dir).filter((n) => /^snap-\d+\.height\.f32$/.test(n)).map((n) => n.slice(5, 8));
const only = process.argv[8] ? process.argv[8].split(",") : steps;
if (!process.argv[3]) { row("start", load("start")); for (const s of steps) row(String(Number(s)), load(s)); }
else {
  const [face, X0, Y0, W, H] = process.argv.slice(3, 8).map(Number);
  for (const s of only) {
    const sn = load(s);
    console.log(`step ${s}: height (m, k = km), crust thickness (km), plate`);
    for (let Y = Y0; Y < Y0 + H; Y++) {
      let a = "", b = "", c = "";
      for (let X = X0; X < X0 + W; X++) {
        const i = cellId(g, face, X, Y), v = sn.h[i];
        a += (Math.abs(v) < 100 ? v.toFixed(0) : (v / 1000).toFixed(1) + "k").padStart(6);
        b += (sn.th[i] / 1000).toFixed(0).padStart(3);
        c += String(sn.pl[i]).padStart(3);
      }
      console.log(String(Y).padStart(3), a, "|", b, "|", c);
    }
  }
}
