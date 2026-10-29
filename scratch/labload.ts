// Loads the raw chain dump (scratch/chainraw.ts) as typed arrays, and four-neighbour helpers over the repo's tables.
import { readFileSync } from "node:fs";
import { FACES, cellId, tierGrid, type Grid } from "../src/gpu/globe/grid";
import { neighbours } from "../src/gpu/globe/tectonics";

export const DIR = (process.env.RAW_DIR ?? "/Users/adamstockermans/.cache/nomads-scratch/t7/raw").replace(/\/*$/, "/");
const bytes = (n: string) => { const b = readFileSync(DIR + n); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
export function raw() {
  const meta = JSON.parse(readFileSync(DIR + "meta.json", "utf8"));
  const grid: Grid = tierGrid(0, meta.grid.radius);
  return {
    meta, grid, n: meta.grid.n as number,
    S: new Int32Array(bytes("S.i32")), removedV: new Float64Array(bytes("removedV.f64")), depositedV: new Float64Array(bytes("depositedV.f64")),
    to: new Uint32Array(bytes("to.u32")), acc: new Uint32Array(bytes("acc.u32")), rain: new Float32Array(bytes("rain.f32")), height: new Float32Array(bytes("height.f32")),
    basalt: new Float32Array(bytes("basalt.f32")), sediment: new Float32Array(bytes("sediment.f32")), metaSed: new Float32Array(bytes("meta_sed.f32")),
    granitoid: new Float32Array(bytes("granitoid.f32")), volcanic: new Float32Array(bytes("volcanic.f32")),
    age: new Float32Array(bytes("age.f32")), orogeny: new Float32Array(bytes("orogeny.f32")), plate: new Uint8Array(bytes("plate.u8")),
  };
}
// The four neighbours of a cell in flat order (+X, +Y, -X, -Y), across face edges: tectonics.ts neighbours.
export function neighbours4(g: Grid, face: number, X: number, Y: number): number[] {
  const nb = neighbours(g), c = cellId(g, face, X, Y);
  return [nb[4 * c], nb[4 * c + 1], nb[4 * c + 2], nb[4 * c + 3]];
}
export { FACES };
