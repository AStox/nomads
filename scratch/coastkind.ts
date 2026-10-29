// coast cells by what backs them: the highest land within 16 cells (1.2 km) inland of the cell, in m (tier 5 windows of 1024)
import { readFileSync } from "node:fs";
const H = process.env.HOME + "/.cache/nomads-scratch/t5/bakeA2/land/";
const R = 1024, bins = [1, 5, 10, 30, 100, 1e9];
for (const n of ["rK", "rR", "rA", "rL", "rB", "rH"]) {
  const b = readFileSync(H + n + "/state.i32"), h = new Int32Array(b.buffer, b.byteOffset, R * R);
  const cnt = new Array(bins.length).fill(0); let coast = 0;
  for (let y = 80; y < R - 80; y++) for (let x = 80; x < R - 80; x++) {
    const i = y * R + x; if (h[i] <= 0) continue;
    if (!(h[i - 1] <= 0 || h[i + 1] <= 0 || h[i - R] <= 0 || h[i + R] <= 0)) continue;
    coast++; let mx = 0; for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) mx = Math.max(mx, h[i + dy * R + dx] / 256);
    cnt[bins.findIndex((v) => mx < v)]++;
  }
  console.log(n, "coast cells", coast, "backed by max land <1/5/10/30/100/more m:", cnt.map((c) => (100 * c / coast).toFixed(0) + "%").join(" "));
}
