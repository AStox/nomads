// Ridge direction and spacing of a window (tier-5 coordinates) in each source: the dominant orientation of the high-passed surface's contours (structure tensor, degrees from +x, y up, modulo 180),
// the regional down-slope direction of the window, and the ridge spacing (km) as the first peak of the autocorrelation of the high-passed surface along the direction across the ridges.
//   bun scripts/straight-ridges.ts home|Rblk face x y size src[,src...]
import { sources } from "./straight-pictures";
const [region, faceS, xS, yS, sizeS, names = "newt4,newt5h,old5,oldt5h"] = process.argv.slice(2), s = sources(region), face = Number(faceS);
for (const nm of names.split(",")) {
  const src = s[nm]; if (!src) continue;
  const k = 1 << (5 - src.tier), n = Math.floor(Number(sizeS) / k), z = src.read(face, Math.floor(Number(xS) / k), Math.floor(Number(yS) / k), n, n), cellKm = 0.075 * k;
  if (z.some((v) => Number.isNaN(v))) { console.log(nm, "no data"); continue; }
  const R = Math.max(2, Math.round(1.2 / cellKm)), low = new Float64Array(n * n), tmp = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let a = 0, c = 0; for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < n) { a += z[y * n + xx]; c++; } } tmp[y * n + x] = a / c; }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let a = 0, c = 0; for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < n) { a += tmp[yy * n + x]; c++; } } low[y * n + x] = a / c; }
  const hp = new Float64Array(n * n); for (let i = 0; i < n * n; i++) hp[i] = z[i] - low[i];
  let sxx = 0, sxy = 0, syy = 0, gx0 = 0, gy0 = 0;
  for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
    const gx = hp[y * n + x + 1] - hp[y * n + x - 1], gy = hp[(y + 1) * n + x] - hp[(y - 1) * n + x];
    sxx += gx * gx; sxy += gx * gy; syy += gy * gy; gx0 += z[y * n + x + 1] - z[y * n + x - 1]; gy0 += z[(y + 1) * n + x] - z[(y - 1) * n + x];
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ridge = (((th * 180) / Math.PI + 90) % 180 + 180) % 180, aniso = Math.sqrt((sxx - syy) ** 2 + 4 * sxy ** 2) / (sxx + syy);
  const down = (((Math.atan2(-gy0, -gx0) * 180) / Math.PI) % 360 + 360) % 360;
  // autocorrelation along the across-ridge direction u (gradient orientation th), nearest-neighbour sampling, lags in cells
  const ux = Math.cos(th), uy = Math.sin(th), maxLag = Math.floor(n / 3), ac = new Float64Array(maxLag);
  let var0 = 0;
  for (let lag = 0; lag < maxLag; lag++) { let a = 0, c = 0; for (let y = 0; y < n; y += 2) for (let x = 0; x < n; x += 2) { const x2 = Math.round(x + ux * lag), y2 = Math.round(y + uy * lag); if (x2 >= 0 && y2 >= 0 && x2 < n && y2 < n) { a += hp[y * n + x] * hp[y2 * n + x2]; c++; } } ac[lag] = a / Math.max(1, c); if (lag === 0) var0 = ac[0]; }
  let lag = 1; while (lag < maxLag - 1 && ac[lag] > 0) lag++;
  let best = lag; for (let l = lag; l < maxLag - 1; l++) if (ac[l] > ac[best]) best = l; // the strongest positive lobe after the first zero crossing
  const half = ac[best] / var0;
  console.log(`${src.label.padEnd(22)} ridge ${ridge.toFixed(1)} deg  down-slope ${down.toFixed(1)} deg  aniso ${aniso.toFixed(2)}  spacing ${(best * cellKm).toFixed(2)} km (acf ${half.toFixed(2)})`);
}
