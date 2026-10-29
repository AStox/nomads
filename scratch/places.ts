// shared: the six places, windows of whole-tier files, tier-0 heights
import { closeSync, openSync, readSync, readFileSync } from "node:fs";
import { locate, tierGrid } from "../src/gpu/globe/grid";
export const PLACES: Record<string, [number, number]> = { spit: [55.13, 31.15], river: [-10.48, 90.29], lake: [12.13, 90.05], shelf: [53.84, 27.26], home: [46.43, 45.76], ridges: [45.4, 39.2], K3: [-20.56, 69.9], E2: [17.35, 45.0], B: [-17.14, 49.33], E2w: [17.35, -45.0] };
export const g5 = tierGrid(5), g0 = tierGrid(0);
export const at = (n: string, g = g5) => { const [la, lo] = PLACES[n]; return locate(g, la * Math.PI / 180, lo * Math.PI / 180); };
export function readWin(path: string, fn: number, face: number, x0: number, y0: number, w: number, h = w, bytes = 4): Int32Array {
  const fd = openSync(path, "r"), out = new Uint8Array(w * h * bytes);
  try { for (let y = 0; y < h; y++) readSync(fd, out.subarray(y * w * bytes, (y + 1) * w * bytes), 0, w * bytes, ((face * fn + y0 + y) * fn + x0) * bytes); } finally { closeSync(fd); }
  return bytes === 4 ? new Int32Array(out.buffer) : bytes === 2 ? Int32Array.from(new Uint16Array(out.buffer)) : Int32Array.from(out);
}
