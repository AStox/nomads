// Windows of 8 x 8 tier-5 tiles (512 x 512 tier-3 cells) of a planet's tier 3 that hold lowland coast and lakes, ranked: land between a third and two thirds, most land under 40 m, most lake cells
// (cells under water of the tier's own flooded surface). Read only.   bun scripts/straight-scan.ts <t3-height.i32> <t3-flooded.i32> [top=12]
import { readFileSync } from "node:fs";
const [hp, fp, top = "12"] = process.argv.slice(2);
const rd = (p: string) => { const b = readFileSync(p); return new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const h = rd(hp), fl = fp && fp !== "-" ? rd(fp) : null, fn = 2048, win = 512, stride = 128;
const rows: { face: number; tx: number; ty: number; land: number; low: number; lake: number; coast: number; score: number }[] = [];
for (let f = 0; f < 6; f++)
  for (let ty = 0; ty + 16 <= 64 - 0; ty += 4) for (let tx = 0; tx + 16 <= 64; tx += 4) {
    // tiles of 256 tier-5 cells = 64 tier-3 cells; a window is 8 tiles = 512 cells
    if (tx + 8 > 32 || ty + 8 > 32) continue;
    const x0 = tx * 64, y0 = ty * 64;
    let land = 0, low = 0, lake = 0, coast = 0;
    for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) {
      const i = (f * fn + y0 + y) * fn + x0 + x, v = h[i];
      if (v > 0) { land++; if (v < 40 * 256) low++; if (fl && fl[i] - v > 128) lake++; if (x + 1 < win && h[i + 1] <= 0) coast++; }
    }
    const n = win * win;
    rows.push({ face: f, tx, ty, land: land / n, low: low / n, lake: lake / n, coast: coast / win, score: 0 });
  }
void stride;
for (const r of rows) r.score = r.land > 0.25 && r.land < 0.75 ? r.low * 2 + r.lake * 20 + r.coast / 500 : 0;
rows.sort((a, b) => b.score - a.score);
for (const r of rows.slice(0, Number(top))) console.log(JSON.stringify({ ...r, land: +r.land.toFixed(2), low: +r.low.toFixed(2), lake: +r.lake.toFixed(3), coast: Math.round(r.coast), score: +r.score.toFixed(2) }));
