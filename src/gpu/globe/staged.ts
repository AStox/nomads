// A staged planet for the window tests, with no chain behind it: a coast along the meridian through SITE, land east of it rising 80 m
// a km to a ridge of 2,000 m 25 km inland, then falling 40 m a km to a second coast 75 km inland; granite under 200 m of sediment;
// rain of each season the same everywhere, three fifths of it running off; a westerly wind; rivers by steepest descent over the four
// neighbours.
import { RADIUS_M, tierGrid } from "./grid";
import { cellVectors, neighbours } from "./tectonics";
import { frameAt, type Planet } from "./window";

export const SITE = { lat: 45, lon: 30 };
export function coastPlanet(seed = 7): Planet {
  const g = tierGrid(0), n = 6 * g.fn * g.fn, v = cellVectors(g), f = frameAt(SITE.lat, SITE.lon), nb = neighbours(g);
  const height = new Float32Array(n), pools = [0, 1, 2, 3, 4].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const p = [v[3 * i], v[3 * i + 1], v[3 * i + 2]], d = p[0] * f.c[0] + p[1] * f.c[1] + p[2] * f.c[2];
    const x = (RADIUS_M * (p[0] * f.e[0] + p[1] * f.e[1] + p[2] * f.e[2])) / d / 1000, y = (RADIUS_M * (p[0] * f.n[0] + p[1] * f.n[1] + p[2] * f.n[2])) / d / 1000;
    const land = d > 0.99 && x >= 0 && x < 75 && Math.abs(y) < 300;
    height[i] = land ? (x < 25 ? 80 * x : 2000 - 40 * (x - 25)) : -2000;
    if (land) { pools[1][i] = 200; pools[3][i] = 30000; } else { pools[0][i] = 6000; pools[1][i] = 500; }
  }
  const to = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let best = i;
    if (height[i] > 0) for (let k = 0; k < 4; k++) { const j = nb[4 * i + k]; if (height[j] < height[best]) best = j; }
    to[i] = best;
  }
  const field = (land: number, sea: number) => Float32Array.from(height, (h) => (h > 0 ? land : sea));
  const seasons = [[8, 400, 9], [16, 300, 14], [10, 500, 12], [2, 600, 7]].map(([t, rain, sst]) => ({
    t: new Float32Array(n).fill(t), rain: new Float32Array(n).fill(rain), snow: new Float32Array(n), runoff: field(0.6 * rain, 0),
    windE: new Float32Array(n).fill(5), windN: new Float32Array(n), sst: field(0, sst),
  }));
  const zero = () => new Float32Array(n);
  return { seed, n, height, pools, to, acc: new Uint32Array(n), seasons, ice: { maxM: zero(), nowM: zero(), cutM: zero(), laidM: zero() }, sea: { lowM: -5, nowM: 0 } };
}
