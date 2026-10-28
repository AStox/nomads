// The overlap proof: a region's state (land-region harness, `state.i32`, size x size heights in 1/256 m at face / x0 / y0 of the tier) against the same cells of the streamed whole-planet
// tier file (t4-height.i32 or t5-height.i32, face-major `(face * fn + Y) * fn + X`, fn the tier's cells a side: 4096 at tier 4, 8192 at tier 5). The region's ring is carried, not solved, so
// equality is expected well inside; the count of equal cells (integer, exact) is printed by distance to the region's edge (d = min(x, y, size - 1 - x, size - 1 - y)) in the bands
// [0,8) [8,16) [16,32) [32,64) [64,128) [128,256) [256,512) [512,..), then the cumulative count of cells at least each band's start from the edge, and the largest |difference| in metres.
//   bun scripts/globe-overlap.ts <tier file> <state.i32> <face> <x0> <y0> <size> <fn>
import { closeSync, openSync, readFileSync, readSync } from "node:fs";

export const BANDS = [0, 8, 16, 32, 64, 128, 256, 512];

// landCells / landEqual: of the region's land cells (state height above 0), how many there are and how many are equal (sea cells are trivially equal when both sides are sea)
export interface BandRow { from: number; to: number | null; cells: number; equal: number; landCells: number; landEqual: number; maxDiffM: number }

// a: the streamed tier's window rows (row y of the region), b: the region state; both size x size.
export function overlap(a: Int32Array, b: Int32Array, size: number): { bands: BandRow[]; total: { cells: number; equal: number; landCells: number; landEqual: number; maxDiffM: number } } {
  const bands: BandRow[] = BANDS.map((from, i) => ({ from, to: i + 1 < BANDS.length ? BANDS[i + 1] : null, cells: 0, equal: 0, landCells: 0, landEqual: 0, maxDiffM: 0 }));
  let cells = 0, equal = 0, max = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.min(x, y, size - 1 - x, size - 1 - y);
    let i = BANDS.length - 1; while (BANDS[i] > d) i--;
    const diff = Math.abs(a[y * size + x] - b[y * size + x]) / 256, r = bands[i];
    r.cells++; cells++;
    const land = b[y * size + x] > 0;
    if (land) r.landCells++;
    if (diff === 0) { r.equal++; equal++; if (land) r.landEqual++; } else { if (diff > r.maxDiffM) r.maxDiffM = diff; if (diff > max) max = diff; }
  }
  return { bands, total: { cells, equal, landCells: bands.reduce((a, r) => a + r.landCells, 0), landEqual: bands.reduce((a, r) => a + r.landEqual, 0), maxDiffM: max } };
}

export function readWindow(path: string, face: number, x0: number, y0: number, size: number, fn: number): Int32Array {
  const fd = openSync(path, "r"), out = new Int32Array(size * size), row = Buffer.alloc(size * 4);
  try {
    for (let y = 0; y < size; y++) {
      readSync(fd, row, 0, size * 4, ((face * fn + y0 + y) * fn + x0) * 4);
      out.set(new Int32Array(row.buffer.slice(row.byteOffset, row.byteOffset + row.byteLength)), y * size);
    }
  } finally { closeSync(fd); }
  return out;
}

if (import.meta.main) {
  const [file, state, face, x0, y0, size, fn] = process.argv.slice(2);
  if (!fn) throw new Error("usage: globe-overlap.ts <tier file> <state.i32> <face> <x0> <y0> <size> <fn>");
  const n = Number(size), s = readFileSync(state), region = new Int32Array(s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength));
  if (region.length !== n * n) throw new Error(`${state}: ${region.length} cells, wanted ${n} x ${n}`);
  const { bands, total } = overlap(readWindow(file, Number(face), Number(x0), Number(y0), n, Number(fn)), region, n);

  const atLeast = bands.map((b) => { const c = bands.filter((o) => o.from >= b.from).reduce((a, o) => a + o.cells, 0), e = bands.filter((o) => o.from >= b.from).reduce((a, o) => a + o.equal, 0); return { from: b.from, cells: c, equal: e, landCells: bands.filter((o) => o.from >= b.from).reduce((a, o) => a + o.landCells, 0), landEqual: bands.filter((o) => o.from >= b.from).reduce((a, o) => a + o.landEqual, 0) }; });

  for (const b of bands) console.log(JSON.stringify({ measure: "overlap.band", file, face: Number(face), x0: Number(x0), y0: Number(y0), size: n, ...b }));
  for (const c of atLeast) console.log(JSON.stringify({ measure: "overlap.atLeast", ...c }));
  console.log(JSON.stringify({ measure: "overlap.total", ...total, equalShare: +(total.equal / total.cells).toFixed(6), landEqualShare: +(total.landEqual / Math.max(1, total.landCells)).toFixed(6) }));
}
