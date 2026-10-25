// Channel nucleation: the detail a smooth carry cannot give a tier's start (refineSmooth and refineBlock carry a tier's eroded heights to the next tier as a quadratic B-spline, so nothing
// lies below the parent cell's size), added as a zero-sum detail of the four children of each parent: the parent's mean, and with it every tier-0 cell's mean the lift holds, is exact.
// Perron, Kirchner and Dietrich 2008 (JGR 113 F04016) and 2009 (Nature 460, 502-505) and Smith and Bretherton 1972 (WRR 8(6)): valleys grow from small perturbations of a slope and their
// spacing comes of the process (diffusion against incision), not of the perturbation's size; the perturbation only has to differ from place to place.
// Spectrum: one octave a tier, a Haar detail (the children's departure from the parent's mean) of independent draws, the octave of a surface of profile spectrum k^-2 (Huang and Turcotte 1989,
// Brownian profile), whose detail variance falls by 2 each octave of cell size (the amplitude `sigmaM` is the last resolved octave's measured detail over the square root of 2: tools/octaves.ts).
// The draw is an integer hash of the child's global cell id and the tier, so a streamed block and a region patch make the same.

// murmur3's 32-bit finaliser
const mix = (h: number): number => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
};
const unit = (id: number, tier: number, k: number): number => mix(mix(id ^ Math.imul(tier + 1, 0x9e3779b1)) ^ Math.imul(k + 1, 0x85ebca6b) ^ 0x4e554331) / 4294967296;
// near-Gaussian with unit variance: four uniforms summed (Irwin-Hall), centred and scaled by sqrt 3
const draw = (id: number, tier: number): number => { let s = 0; for (let k = 0; k < 4; k++) s += unit(id, tier, k); return (s - 2) * Math.sqrt(3); };

// The four children `w` (1/256 m; ids `ids` at `tier`) with the detail added, `sigmaM` metres rms of a child's departure from its parent's mean. A parent with a child under four sigma above the
// sea is left alone (the coast and the sea stay where they are: a land cell stays land).
export function nucleate(w: number[], ids: number[], tier: number, sigmaM: number): number[] {
  const s = sigmaM * 256;
  if (!(s > 0) || Math.min(w[0], w[1], w[2], w[3]) <= 4 * s) return w;
  const g = ids.map((id) => draw(id, tier)), mean = (g[0] + g[1] + g[2] + g[3]) / 4, scale = s / Math.sqrt(0.75);
  const n = g.map((v) => Math.round((v - mean) * scale)), d = -(n[0] + n[1] + n[2] + n[3]), base4 = Math.floor(d / 4), rem = d - base4 * 4;
  return w.map((v, j) => v + n[j] + base4 + (j < rem ? 1 : 0));
}
