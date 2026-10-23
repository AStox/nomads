// A window of the real bake's tier 5 heights read from the file (no GPU), drawn and measured as the fine tiers' defects are judged: the second difference of the heights by the cell's place in the
// 32-cell block (a constant to a tier-0 cell shows at its edges), the share of cells in flat squares of a block, and the diagonal streak measure.
//   bun scripts/globe-land-real.ts --dir /tmp/planet-75m/1-7f6ff6c82cdd --face 0 --x 7680 --y 4352 --size 256 --out /tmp/planet-75m/land/view/real574.png
import { closeSync, openSync, readSync, writeFileSync } from "node:fs";
import { renderLand } from "./globe-land-metrics";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const FN = 8192, dir = arg("dir", "/tmp/planet-75m/1-7f6ff6c82cdd"), face = Number(arg("face", "0")), x0 = Number(arg("x", "7680")), y0 = Number(arg("y", "4352")), size = Number(arg("size", "256")), pad = 4;
const file = arg("file", "t5-height.i32"), S = size + 2 * pad;
export function window(path: string, f: number, x: number, y: number, n: number): Int32Array {
  const fd = openSync(path, "r"), out = new Int32Array(n * n), row = Buffer.alloc(n * 4);
  try {
    for (let j = 0; j < n; j++) { readSync(fd, row, 0, n * 4, ((f * FN + y + j) * FN + x) * 4); out.set(new Int32Array(row.buffer, row.byteOffset, n), j * n); }
  } finally { closeSync(fd); }
  return out;
}
export function measures(h: Int32Array, n: number, X0: number, Y0: number, per = 32) {
  const prof = new Float64Array(per), cnt = new Float64Array(per), blocks = new Map<number, { s: number; n: number; flat: number }>();
  let planar = 0, total = 0, diagA = 0, diagB = 0, axisA = 0;
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const k = y * n + x;
    if (h[k] <= 256 || h[k - 1] <= 256 || h[k + 1] <= 256 || h[k - n] <= 256 || h[k + n] <= 256) continue;
    const dx = Math.abs(h[k - 1] + h[k + 1] - 2 * h[k]) / 256, dy = Math.abs(h[k - n] + h[k + n] - 2 * h[k]) / 256, d = (dx + dy) / 2, gx = X0 + x, gy = Y0 + y;
    prof[gx % per] += dx; cnt[gx % per]++; prof[gy % per] += 0; 
    const b = Math.floor(gy / per) * 100000 + Math.floor(gx / per), e = blocks.get(b) ?? { s: 0, n: 0, flat: 0 };
    e.s += d; e.n++; if (d < 0.25) e.flat++; blocks.set(b, e);
    total++; if (d < 0.25) planar++;
    // 45 degree streaks: the second difference along the diagonals against along the axes
    diagA += Math.abs(h[k - n - 1] + h[k + n + 1] - 2 * h[k]) / 256 + Math.abs(h[k - n + 1] + h[k + n - 1] - 2 * h[k]) / 256; axisA += dx + dy;
  }
  const mean = Array.from(prof, (s, i) => s / Math.max(1, cnt[i])), inside = mean.slice(2, per - 2).reduce((a, b) => a + b, 0) / (per - 4), edge = (mean[0] + mean[1] + mean[per - 1] + mean[per - 2]) / 4;
  const full = [...blocks.values()].filter((b) => b.n > per * per * 0.8), flatBlocks = full.filter((b) => b.flat / b.n > 0.8).length;
  return { cells: total, d2Inside: +inside.toFixed(2), d2Edge: +edge.toFixed(2), edgeRatio: +(edge / inside).toFixed(2), d2ByX: mean.map((v) => +v.toFixed(1)).join(" "), planarShare: +(planar / total).toFixed(3), blocks: full.length, flatBlocks, diag2axis: +(diagA / (2 * axisA)).toFixed(3) };
}
if (import.meta.main) {
  const h = window(`${dir}/${file}`, face, x0 - pad, y0 - pad, S);
  const at = (x: number, y: number) => h[(Math.min(S - 1, Math.max(0, y + pad)) * S) + Math.min(S - 1, Math.max(0, x + pad))] / 256;
  writeFileSync(arg("out", "/tmp/planet-75m/land/view/real.png"), renderLand(at, null, [0, 0, size], Number(arg("scale", "3")), 1e9, Number(arg("vex", "0"))));
  console.log(JSON.stringify(measures(h, S, x0 - pad, y0 - pad)));
}
