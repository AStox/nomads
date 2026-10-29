// Plate runs along rows of a window through the snapshots: `bun scratch/pbt.ts <snapdir> face X0 X1 Y0 Y1 [rowStep]`, each row printed as plate@firstX segments.
import { readFileSync } from "node:fs";
const dir = process.argv[2], [f, X0, X1, Y0, Y1] = process.argv.slice(3, 8).map(Number), ys = Number(process.argv[8] ?? 2);
for (let s = 0; s < 100; s += 5) {
  const p = String(s).padStart(3, "0"), b = readFileSync(`${dir}/snap-${p}.plate.i32`), pl = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  let line = "";
  for (let Y = Y0; Y <= Y1; Y += ys) { let seq = "", last = -1; for (let X = X0; X <= X1; X++) { const v = pl[(f * 256 + Y) * 256 + X]; if (v !== last) { seq += (seq ? ">" : "") + `${v}@${X}`; last = v; } } line += seq + " | "; }
  console.log(p, line);
}
