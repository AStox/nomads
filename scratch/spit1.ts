// A window of the raw chain dump's fields: height, total crust (km), basalt (km), plate. `RAW_DIR=<dump> bun scratch/spit1.ts face X0 Y0 W H`
import { raw } from "./labload";
import { cellId, tierGrid } from "../src/gpu/globe/grid";
const r = raw(), g = tierGrid(0), [face, X0, Y0, W, H] = process.argv.slice(2).map(Number);
const cell = (x: number, y: number) => cellId(g, face, x, y);
for (const [label, val] of [["height m", (i: number) => r.height[i]], ["crust km", (i: number) => (r.basalt[i] + r.sediment[i] + r.metaSed[i] + r.granitoid[i] + r.volcanic[i]) / 1000], ["basalt km", (i: number) => r.basalt[i] / 1000], ["plate", (i: number) => r.plate[i]]] as const) {
  console.log(label);
  for (let Y = Y0; Y < Y0 + H; Y++) {
    let s = "";
    for (let X = X0; X < X0 + W; X++) { const v = val(cell(X, Y)); s += (Math.abs(v) < 100 ? v.toFixed(label === "height m" ? 0 : 1) : (v / 1000).toFixed(1) + "k").padStart(6); }
    console.log(String(Y).padStart(3), s);
  }
}
