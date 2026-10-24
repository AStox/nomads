// coast position at several zooms through the same ground point (the centre): water masks scaled to the reference zoom, the shift that best aligns each with the reference
import { sharp, OUT } from "./lib.ts";
const [tag, place, ref, ...zs] = process.argv.slice(2);
const ppm = (z: number) => 0.48 * 2 ** (z - 4), Wd = 1600, Hd = 1000, cx = 800, cy = 500;
const mask = async (z: string) => { const { data, info } = await sharp(`${OUT}/${tag}-${place}-${z}-skip.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const m = new Uint8Array(info.width * info.height); for (let i = 0; i < m.length; i++) { const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2]; m[i] = b - r > 30 && b > g - 10 ? 1 : 0; } return m; };
const R = await mask(ref), pr = ppm(+ref);
// the reference's boundary pixels
const edge = (m: Uint8Array) => { const e: number[] = []; for (let y = 1; y < Hd - 1; y++) for (let x = 1; x < Wd - 1; x++) { const v = m[y * Wd + x]; if (v !== m[y * Wd + x + 1] || v !== m[(y + 1) * Wd + x]) e.push(x, y); } return e; };
const Re = edge(R);
console.log(`ref ${ref}: water ${(100 * R.reduce((a, b) => a + b, 0) / R.length).toFixed(1)}% of the screen, ${Re.length / 2} edge px`);
for (const z of zs) {
  const M = await mask(z), k = pr / ppm(+z);   // a pixel of zoom z is k reference px
  // for each reference edge pixel, the zoom-z pixel it maps to: (p - c)/k + c; shifts (dx,dy) in reference px tried; score = share of edge pixels where the mask at z flips across the pixel
  const at = (x: number, y: number) => { const X = Math.round((x - cx) / k + cx), Y = Math.round((y - cy) / k + cy); return X < 1 || Y < 1 || X >= Wd - 1 || Y >= Hd - 1 ? -1 : M[Y * Wd + X]; };
  let best = [1e9, 0, 0], zero = 0;
  const step = Math.max(1, Math.round(k / 2));
  for (let dy = -60; dy <= 60; dy += 2) for (let dx = -60; dx <= 60; dx += 2) {
    // disagreement of the water mask (ref against z at the shifted place) over the reference's pixels near its edge, sampled
    let bad = 0, n = 0; for (let y = 20; y < Hd - 20; y += 6) for (let x = 20; x < Wd - 20; x += 6) { const a = R[y * Wd + x], b = at(x - dx, y - dy); if (b < 0) continue; n++; if (a !== b) bad++; }
    const s = bad / n; if (dx === 0 && dy === 0) zero = s; if (s < best[0]) best = [s, dx, dy];
  }
  console.log(`zoom ${z} (k ${k.toFixed(2)} ref px per px): mismatch ${(100 * zero).toFixed(2)}% at zero, best ${(100 * best[0]).toFixed(2)}% at shift (${best[1]},${best[2]}) ref px = (${(best[1] / pr).toFixed(1)},${(best[2] / pr).toFixed(1)}) plane m`);
}
