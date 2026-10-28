// A stand-in for a tier-3 file that is gone: the 4 x 4 means of a planet's tier-5 height file (1/256 m, face-major), written as a tier-3 file (6 x 2048^2). The old planet's t3-height.i32 was deleted
// by the restore bake's driver ("spent": last read by coarse); the old harness's tier-4 start (tier 3 carried down) comes from this instead. The tier-5 file is read only.
//   bun scripts/straight-pseudo-t3.ts <t5-height.i32> <out t3-height.i32>
import { closeSync, openSync, readSync, writeSync } from "node:fs";
const [src, dst] = process.argv.slice(2), fn5 = 8192, fn3 = 2048, fd = openSync(src, "r"), out = openSync(dst, "w");
const rows = new Int32Array(4 * fn5), res = new Int32Array(fn3);
for (let f = 0; f < 6; f++)
  for (let Y = 0; Y < fn3; Y++) {
    readSync(fd, new Uint8Array(rows.buffer), 0, rows.byteLength, ((f * fn5 + 4 * Y) * fn5) * 4);
    for (let X = 0; X < fn3; X++) {
      let s = 0;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) s += rows[r * fn5 + 4 * X + c];
      res[X] = Math.round(s / 16);
    }
    writeSync(out, new Uint8Array(res.buffer), 0, res.byteLength, ((f * fn3 + Y) * fn3) * 4);
  }
closeSync(fd); closeSync(out);
console.log("wrote", dst);
