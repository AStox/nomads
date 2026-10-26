// How much of a window's stream centreline is a staircase, before and after the smoothing (src/gpu/globe/streamcurve.ts), and whether two neighbouring windows draw the same curve.
//   bun scripts/play/audit/staircase.ts <lat> <lon> [--bake /tmp/planet-75m-new/1-1121d207f3b8] [--seam]
// CPU only (no GPU, no browser): the ground tile holding (lat, lon) of the finest tier, its stream steps as demo/tile.ts windowRivers makes them against the cell chain (each channel cell's centre to
// its receiver's), both resampled at the mask's texel (4.69 m) along each stream from its source; the share of samples where the line turns by 30 degrees or more within 4 texels either side (a
// D8 chain turns by 45 or 90 at its steps, a smooth curve of 75 m cells by under a few degrees), the 95th and 99th percentile of that turn, how far the nodes move and how far a curve strays from its
// cell step (at most half a cell). With --seam, the tile and its east neighbour's windowRivers over their shared cells, at the steps 6 or more cells inside both patches: the largest difference.
import { readFileSync } from "node:fs";
import { windowRivers } from "../../../demo/tile";
import { fromLatLon, locateVec, tierGrid } from "../../../src/gpu/globe/grid";
import { readGroundTile, tileSource } from "../../../src/gpu/globe/groundtile";
import { RIVER_HALO } from "../../../src/gpu/globe/scatter";
import { SIZE } from "../../../src/terrain/flora";
import { CELL } from "../../../src/terrain/grid";

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const nums = args.filter((a, i) => /^-?\d/.test(a) && args[i - 1] !== "--bake").map(Number), lat = nums[0] ?? 12.23, lon = nums[1] ?? 83.85, BAKE = at("--bake", "/tmp/planet-75m-new/1-1121d207f3b8");
const loc = locateVec(tierGrid(5), fromLatLon((lat * Math.PI) / 180, (lon * Math.PI) / 180)), tx = Math.floor(loc.X / 256), ty = Math.floor(loc.Y / 256);
const load = (x: number, y: number) => tileSource(readGroundTile(readFileSync(`${BAKE}/groundtiles/f${loc.face}/${y}-${x}.gt.gz`)));
const source = load(tx, ty), after = windowRivers(source);
const TEX = SIZE / 4096;

const S = 256 + 2 * RIVER_HALO, n = S * S;
const to = source.recv(RIVER_HALO), chn = source.plane<Uint8Array>("chn", RIVER_HALO), flow = source.plane<Uint32Array>("flow", RIVER_HALO);
const x = (i: number) => (((i % S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2, z = (i: number) => ((Math.floor(i / S) - RIVER_HALO) * CELL + CELL / 2) - SIZE / 2;
const before: number[][][] = [];
for (let i = 0; i < n; i++) { if (!chn[i] || !flow[i] || to[i] < 0 || to[i] === i) continue; before.push([[x(i), z(i)], [x(to[i]), z(to[i])]]); }
const afterPts = after.map((l) => l.map((p) => [p[0], p[1]]));

// the streams as chains of steps: from each step with none before it, on to the step that starts where it ends
function chains(lines: number[][][]) {
  const key = (p: number[]) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`, starts = new Map<string, number[][]>(), ends = new Set<string>();
  for (const l of lines) { starts.set(key(l[0]), l); ends.add(key(l[l.length - 1])); }
  const out: number[][][] = [];
  for (const l of lines) {
    if (ends.has(key(l[0]))) continue;
    const pts = [...l];
    for (let at = l, nx = starts.get(key(at[at.length - 1])), guard = 0; nx && guard < 5000; at = nx, nx = starts.get(key(at[at.length - 1])), guard++) pts.push(...nx.slice(1));
    out.push(pts);
  }
  return out;
}
function resample(pts: number[][], step: number) {
  const out = [pts[0]]; let carry = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = step - carry;
    for (; s <= d; s += step) out.push([a[0] + ((b[0] - a[0]) * s) / d, a[1] + ((b[1] - a[1]) * s) / d]);
    carry = d - (s - step);
  }
  return out;
}
function turns(lines: number[][][], label: string) {
  const N = 4, angles: number[] = [];
  for (const chain of chains(lines)) {
    const r = resample(chain, TEX);
    for (let i = N; i < r.length - N; i++) {
      const a = [r[i][0] - r[i - N][0], r[i][1] - r[i - N][1]], b = [r[i + N][0] - r[i][0], r[i + N][1] - r[i][1]];
      angles.push((Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * 180) / Math.PI);
    }
  }
  angles.sort((p, q) => p - q);
  const share = (deg: number) => ((100 * angles.filter((a) => a >= deg).length) / angles.length).toFixed(2);
  console.log(`${label}: ${angles.length} samples 4.7 m apart; turn within 4 texels either side of 30 degrees or more ${share(30)}%, 60 or more ${share(60)}%; p95 ${angles[Math.floor(angles.length * 0.95)].toFixed(1)}, p99 ${angles[Math.floor(angles.length * 0.99)].toFixed(1)} degrees`);
}
console.log(`face ${loc.face} tile ${tx},${ty}: ${before.length} steps, ${after.reduce((t, l) => t + l.length - 1, 0)} segments after`);
turns(before, "cell chain  ");
turns(afterPts, "smooth curve");

const segDist = (p: number[], a: number[], b: number[]) => { const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz))); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); };
let maxNode = 0, maxStray = 0, sumNode = 0;
for (let i = 0; i < after.length; i++) {
  const d0 = Math.hypot(after[i][0][0] - before[i][0][0], after[i][0][1] - before[i][0][1]);
  maxNode = Math.max(maxNode, d0); sumNode += d0;
  for (const p of after[i]) maxStray = Math.max(maxStray, segDist(p, before[i][0], before[i][1]));
}
console.log(`nodes move at most ${maxNode.toFixed(1)} m (${(maxNode / CELL).toFixed(2)} cell), on average ${(sumNode / after.length).toFixed(1)} m; a curve strays at most ${maxStray.toFixed(1)} m (${(maxStray / CELL).toFixed(2)} cell) from its cell step`);

if (args.includes("--seam")) {
  const B = windowRivers(load(tx + 1, ty));
  // a step's start cell on the face: the window's cells from its origin (x - 8 cells of halo)
  const cell = (p: number[], ox: number) => `${Math.round((p[0] + SIZE / 2 - CELL / 2) / CELL) + ox},${Math.round((p[1] + SIZE / 2 - CELL / 2) / CELL) + ty * 256}`;
  const inB = new Map<string, number[][]>();
  for (const l of B) inB.set(cell(l[0], (tx + 1) * 256), l);
  let both = 0, worst = 0, missing = 0;
  for (const l of after) {
    const col = Math.round((l[0][0] + SIZE / 2 - CELL / 2) / CELL);
    // 6 to 9 cells inside the east tile's patch (its columns -8 ...) and the west one's (... 263): the tile's columns 254 to 257
    if (col < 254 || col > 257) continue;
    const m = inB.get(cell(l[0], tx * 256));
    if (!m || m.length !== l.length) { missing++; continue; }
    both++;
    for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.hypot(l[i][0] - l[0][0] - (m[i][0] - m[0][0]), l[i][1] - l[0][1] - (m[i][1] - m[0][1])));
  }
  console.log(`seam with tile ${tx + 1},${ty}: ${both} steps held 6+ cells inside both windows, ${missing} missing or different in length, largest difference of a curve point ${worst.toExponential(2)} m`);
}
process.exit(0);
