// lat, lon of tier-5 cells ("face:X:Y,...") and the tier-5 cell of the highest land of a bake: bun scripts/globe-places.ts <t5-height.i32> face:X:Y ...
import { closeSync, openSync, readSync } from "node:fs";
import { centre, latLon, tierGrid } from "../src/gpu/globe/grid";

const [file, ...cells] = process.argv.slice(2), g5 = tierGrid(5), fn = g5.fn, DEG = 180 / Math.PI;
for (const c of cells) {
  const [f, X, Y] = c.split(":").map(Number), ll = latLon(centre(g5, f, X, Y));
  console.log(c, (ll.lat * DEG).toFixed(3), (ll.lon * DEG).toFixed(3));
}
const fd = openSync(file, "r"), row = new Int32Array(fn);
let best = -1, bf = 0, bx = 0, by = 0;
for (let f = 0; f < 6; f++) for (let y = 0; y < fn; y++) {
  readSync(fd, new Uint8Array(row.buffer), 0, fn * 4, (f * fn + y) * fn * 4);
  for (let x = 0; x < fn; x++) if (row[x] > best) { best = row[x]; bf = f; bx = x; by = y; }
}
closeSync(fd);
const ll = latLon(centre(g5, bf, bx, by));
console.log(`highest tier-5 cell: ${(best / 256).toFixed(0)} m at face ${bf} X ${bx} Y ${by}: ${(ll.lat * DEG).toFixed(3)}, ${(ll.lon * DEG).toFixed(3)}`);
