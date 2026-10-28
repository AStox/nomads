// Axis-aligned straight runs of the sea-level line in a planet's whole-tier height file (or the tier-0 chain): a run is a stretch of cell edges, consecutive along one grid axis, where land (h > 0)
// meets sea (h <= 0, lake pockets below sea level included), counted by length in km (cells x the tier's cell size, 75 m x 2^(5 - tier)). Also what share of the planet's sea-level edge cells lie in
// runs of 5 km or more. Read only.   bun scripts/straight-coast.ts <tier-file.i32 | chain height.f32> <tier>
import { openSync, readFileSync, readSync } from "node:fs";
const [file, tierS] = process.argv.slice(2), tier = Number(tierS), fn = 256 << tier, cellKm = 0.075 * 2 ** (5 - tier);
const chain = file.endsWith(".f32");
const rows: Float32Array[] = [new Float32Array(fn), new Float32Array(fn)];
const bins = [5, 10, 20, 40, 80, 160], count = bins.map(() => 0), edgeIn = bins.map(() => 0);
let edges = 0;
const flush = (len: number) => { edges += len; const km = len * cellKm; bins.forEach((b, i) => { if (km >= b) { count[i]++; edgeIn[i] += len; } }); };
let h0: Float32Array | null = null;
if (chain) { const b = readFileSync(file); h0 = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
const fd = chain ? -1 : openSync(file, "r"), tmp = new Int32Array(fn);
const rowOf = (f: number, Y: number, out: Float32Array) => {
  if (chain) { for (let X = 0; X < fn; X++) out[X] = h0![(f * fn + Y) * fn + X]; return; }
  readSync(fd, new Uint8Array(tmp.buffer), 0, tmp.byteLength, (f * fn + Y) * fn * 4);
  for (let X = 0; X < fn; X++) out[X] = tmp[X];
};
for (let f = 0; f < 6; f++) {
  const vrun = new Int32Array(fn); // runs of vertical edges (edge between x and x+1) grown row by row
  rowOf(f, 0, rows[0]);
  for (let Y = 0; Y < fn; Y++) {
    const cur = rows[Y & 1], nxt = rows[(Y + 1) & 1];
    if (Y + 1 < fn) rowOf(f, Y + 1, nxt);
    for (let X = 0; X + 1 < fn; X++) { const e = (cur[X] > 0) !== (cur[X + 1] > 0); if (e) vrun[X]++; else if (vrun[X]) { flush(vrun[X]); vrun[X] = 0; } }
    if (Y + 1 < fn) { let run = 0; for (let X = 0; X < fn; X++) { const e = (cur[X] > 0) !== (nxt[X] > 0); if (e) run++; else if (run) { flush(run); run = 0; } } if (run) flush(run); }
  }
  for (let X = 0; X < fn; X++) if (vrun[X]) flush(vrun[X]);
}
console.log(file.split("/").slice(-3).join("/"), "tier", tier, "cell", cellKm.toFixed(3), "km; sea-level edge cells", edges, "(", (edges * cellKm).toFixed(0), "km )");
console.log(" runs of >= " + bins.join(" / ") + " km:", count.join(" / "), "; edge share in them:", edgeIn.map((e) => (100 * e / edges).toFixed(1) + "%").join(" / "));
