import { readFileSync } from "node:fs";
const R = 1024, B = process.env.HOME + "/.cache/nomads-scratch/t6/cem/base/";
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const n of ["rK", "rR", "rA"]) {
  const b = readFileSync(B + n + "/state.i32"), h = new Int32Array(b.buffer, b.byteOffset, R * R);
  const land: number[] = [], sea: number[] = []; let nl = 0;
  for (let i = 0; i < R * R; i++) if (h[i] > 0) nl++;
  for (let y = 80; y < R - 80; y++) for (let x = 80; x < R - 80; x++) {
    const i = y * R + x;
    if (h[i] > 0 && (h[i - 1] <= 0 || h[i + 1] <= 0 || h[i - R] <= 0 || h[i + R] <= 0)) land.push(h[i] / 256);
    if (h[i] <= 0 && (h[i - 1] > 0 || h[i + 1] > 0 || h[i - R] > 0 || h[i + R] > 0)) sea.push(h[i] / 256);
  }
  const f = (a: number[]) => [0.05, 0.25, 0.5, 0.75, 0.95, 0.99].map((p) => q(a, p).toFixed(2)).join(" ");
  console.log(n, "land share", (nl / R / R).toFixed(3), "coast land n", land.length, "q05..99:", f(land), "| sea-side n", sea.length, f(sea));
  // seaward profile: for coast land cells, mean of sea depth at distances 1..8 cells in the row direction? skip; print percentile of sea depth within 4 cells of land
  const d: number[] = [];
  for (let y = 80; y < R - 80; y += 3) for (let x = 80; x < R - 80; x += 3) { const i = y * R + x; if (h[i] > 0) continue; let near = false; for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) if (h[i + dy * R + dx] > 0) { near = true; break; } if (near) d.push(h[i] / 256); }
  console.log("  sea within 4 cells of land: n", d.length, f(d));
  const d2: number[] = [];
  for (let y = 80; y < R - 80; y += 3) for (let x = 80; x < R - 80; x += 3) { const i = y * R + x; if (h[i] > 0) continue; let near = false; for (let dy = -16; dy <= 16 && !near; dy += 2) for (let dx = -16; dx <= 16; dx += 2) if (h[i + dy * R + dx] > 0) { near = true; break; } if (near) d2.push(h[i] / 256); }
  console.log("  sea within 16 cells of land: n", d2.length, f(d2));
}
