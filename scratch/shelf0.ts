// tier-0 coast: the sea depth beside each coast land cell (4-neighbour), and 2 cells out
import { chainArrays } from "./wcarry";
import { g0 } from "./places";
const a = chainArrays()["height"] as Float32Array, fn = g0.fn;
const edges = [-1, 1, 10, 30, 100, 300, 1000, 1e9]; const near = new Array(edges.length).fill(0), far = new Array(edges.length).fill(0); let n = 0, deepRow = 0;
const ix = (f: number, X: number, Y: number) => (f * fn + Y) * fn + X;
for (let f = 0; f < 6; f++) for (let Y = 1; Y < fn - 1; Y++) for (let X = 1; X < fn - 1; X++) {
  const h = a[ix(f, X, Y)] + 0.0345; if (h <= 0) continue;
  let best = 0, dir = -1; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const v = a[ix(f, X + dx, Y + dy)] + 0.0345; if (v <= 0 && v < best) { best = v; dir = dx * 2 + dy * 3; } }
  if (dir === -1 && !(0)) { /* no sea neighbour */ }
  let sea = false; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (a[ix(f, X + dx, Y + dy)] + 0.0345 <= 0) sea = true;
  if (!sea) continue; n++;
  near[edges.findIndex((e) => -best < e)]++;
  // the deepest sea within 3 cells in the same direction
  let dmax = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (a[ix(f, X + dx, Y + dy)] + 0.0345 <= 0) { const X2 = X + 3 * dx, Y2 = Y + 3 * dy; if (X2 >= 0 && Y2 >= 0 && X2 < fn && Y2 < fn) dmax = Math.max(dmax, -(a[ix(f, X2, Y2)] + 0.0345)); }
  far[edges.findIndex((e) => dmax < e)]++;
}
console.log("coast land cells", n, "\nadjacent sea depth <1/10/30/100/300/1000/more m:", near.map((c) => (100 * c / n).toFixed(0) + "%").join(" "), "\n3 cells out (7.2 km):", far.map((c) => (100 * c / n).toFixed(0) + "%").join(" "));
