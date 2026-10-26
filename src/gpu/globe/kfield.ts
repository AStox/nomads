// A spatial field of erodibility for the tier-0 chain and the fine tiers (option `kvar` of ErosionParams, off by default): the rock of one class is not one K. log K = log K_class + SIGMA g(x), with g a
// fractal of unit variance whose octaves carry amplitude proportional to sqrt(wavelength), i.e. a profile spectrum k^-2 (Brownian: natural topographic profiles, Huang and Turcotte 1989 and Perron et
// al. 2008 as the repo's earlier notes cite them; neither is read here, so the exponent is [design]). g is a sum of plane waves of the sphere's 3D position, each with a direction, a phase and a
// wavelength drawn by a counter-based integer hash (Philox4x32-10), so no wave follows the cube's lattice and nothing repeats across a face edge. The table the kernels read is integers: Q16 of exp(SIGMA g)
// at each tier-0 cell centre; the geometric mean of K stays the class's, the arithmetic mean rises by exp(SIGMA^2 / 2) [derived].
import { philox } from "../rand";
import { GRANITE, ROCKS, SANDSTONE } from "../../terrain/geology";
import { tierGrid } from "./grid";
import { cellVectors } from "./tectonics";

// One sigma of ln K: the repo's own class spread, sandstone over granite, ln (3.2e-7 / 7.1e-8) = 1.5 [design: choice; volcanic over granite would be 4.6].
export const KVAR_SIGMA = Math.log(ROCKS[SANDSTONE].erode / ROCKS[GRANITE].erode);
// Wavelengths 300 km down to 9.4 km in six octaves (the correlation range 10 to 300 km [design]), eight waves an octave.
export const KVAR = { octaves: 6, waves: 8, topKm: 300 } as const;

export function kFactors(radiusM: number, seed: number): Uint32Array {
  const g = tierGrid(0, radiusM), vec = cellVectors(g), n = vec.length / 3;
  const waves: { k: number; d: [number, number, number]; ph: number; a: number }[] = [];
  let variance = 0;
  for (let o = 0; o < KVAR.octaves; o++) {
    const lamM = (KVAR.topKm * 1000) / 2 ** o, a = Math.sqrt(lamM / (KVAR.topKm * 1000));
    for (let w = 0; w < KVAR.waves; w++) {
      const u = philox([w, o, 0, 0x4b564152], [seed >>> 0, 0x4b464c44]), z = (u[0] / 2 ** 32) * 2 - 1, az = (u[1] / 2 ** 32) * 2 * Math.PI, s = Math.sqrt(1 - z * z);
      waves.push({ k: (2 * Math.PI * radiusM) / lamM, d: [s * Math.cos(az), s * Math.sin(az), z], ph: (u[2] / 2 ** 32) * 2 * Math.PI, a });
      variance += (a * a) / 2;
    }
  }
  const norm = 1 / Math.sqrt(variance), out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const w of waves) s += w.a * Math.cos(w.k * (w.d[0] * vec[3 * i] + w.d[1] * vec[3 * i + 1] + w.d[2] * vec[3 * i + 2]) + w.ph);
    const gx = Math.max(-3, Math.min(3, s * norm));
    out[i] = Math.round(Math.exp(KVAR_SIGMA * gx) * 65536);
  }
  return out;
}
