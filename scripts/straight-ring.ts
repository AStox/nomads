// How often a tier's cell is on the other side of sea level from its tier-0 parent: the carry's overshoot (land over a sea parent, "spit") and undershoot (sea in a land parent, "moat/lake strip"),
// counted over a whole planet's tier file against its tier-0 chain (height.f32 from scripts/straight-dump0.ts), by the parent's height class. Read only.
//   bun scripts/straight-ring.ts <tier-file.i32> <tier> <chain height.f32>
import { openSync, readFileSync, readSync } from "node:fs";
const [file, tierS, chain] = process.argv.slice(2), tier = Number(tierS), fn = 256 << tier, s = tier;
const b = readFileSync(chain), h0 = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), fd = openSync(file, "r"), row = new Int32Array(fn);
const classes = [[0, 1], [1, 5], [5, 20], [20, 100], [100, 1e9]] as const;
const under = classes.map(() => 0), parents = classes.map(() => 0), over = [0, 0, 0, 0, 0], sea = [0, 0, 0, 0, 0];
const seaClasses = [[0, -1], [-1, -5], [-5, -20], [-20, -100], [-100, -1e9]] as const;
let land = 0, cells = 0;
for (let f = 0; f < 6; f++)
  for (let Y = 0; Y < fn; Y++) {
    readSync(fd, new Uint8Array(row.buffer), 0, row.byteLength, (f * fn + Y) * fn * 4);
    for (let X = 0; X < fn; X++) {
      const p = h0[(f * 256 + (Y >> s)) * 256 + (X >> s)], v = row[X] / 256;
      cells++;
      if (v > 0) land++;
      if (p > 0) classes.forEach(([a, c], i) => { if (p > a && p <= c) { parents[i]++; if (v <= 0) under[i]++; } });
      else seaClasses.forEach(([a, c], i) => { if (p <= a && p > c) { sea[i]++; if (v > 0) over[i]++; } });
    }
  }
const pc = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(3)}%` : "-");
console.log(file.split("/").slice(-3).join("/"), "tier", tier, "land share", (land / cells).toFixed(4));
console.log(" sea cells in land parents by parent height (0-1,1-5,5-20,20-100,>100 m):", classes.map((_, i) => `${under[i]}/${parents[i]} ${pc(under[i], parents[i])}`).join("  "));
console.log(" land cells in sea parents by parent depth (0-1,1-5,5-20,20-100,>100 m):", seaClasses.map((_, i) => `${over[i]}/${sea[i]} ${pc(over[i], sea[i])}`).join("  "));
