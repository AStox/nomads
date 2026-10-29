import { readWin } from "./places";
const H = process.env.HOME + "/.cache/", T5 = H + "nomads-scratch/t5/";
const stat = (h: ArrayLike<number>, S: number, m = 64) => {
  let land = 0, u1 = 0, u01 = 0, dead = 0;
  for (let y = m; y < S - m; y++) for (let x = m; x < S - m; x++) { const v = h[y * S + x]; if (v <= 0) continue; land++; if (v < 256) u1++; if (v < 26) u01++; const e = h[y * S + x + 1], w = h[y * S + x - 1], n = h[(y + 1) * S + x], s = h[(y - 1) * S + x]; if (v === e && v === w && v === n && v === s) dead++; }
  return `land ${land} under 1 m ${(u1 / land * 100).toFixed(1)}% under 0.1 m ${(u01 / land * 100).toFixed(1)}% dead flat (4 equal neighbours) ${(dead / land * 100).toFixed(2)}%`;
};
const R: [string, number, number, number][] = [["rR", 1, 14, 10], ["rA", 4, 24, 20], ["rK", 1, 6, 6], ["rB", 1, 1, 6], ["rL", 1, 14, 18], ["rH", 4, 26, 25]];
for (const [n, f, tx, ty] of R) {
  for (const [lab, h] of [["old", readWin(H + "nomads-scratch/t4/old/t5-height.i32", 8192, f, tx * 256, ty * 256, 1024)], ["new", readWin(H + "nomads-bakes-next/1-6f5e2898ad43/t5-height.i32", 8192, f, tx * 256, ty * 256, 1024)], ["A", readWin(T5 + `bakeA/land/${n}/state.i32`, 1024, 0, 0, 0, 1024)], ["A2", readWin(T5 + `bakeA2/land/${n}/state.i32`, 1024, 0, 0, 0, 1024)], ["B", readWin(T5 + `bakeB/land/${n}/state.i32`, 1024, 0, 0, 0, 1024)]] as const) console.log(n.padEnd(3), lab.padEnd(4), stat(h, 1024));
}
