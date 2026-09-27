// One fixed 64-color palette. Everything is drawn as indices into it; shadow and fire glow are index remaps.
import { COLORS } from "../island.js";

const LIST = [
  ["ink", "#0d0b14"],
  ["g0", "#1b2f20"], ["g1", "#26452b"], ["g2", "#355f30"], ["g3", "#4b7a35"], ["g4", "#67963c"], ["g5", "#8bb14a"], ["g6", "#b4cd64"],
  ["t1", "#152f25"], ["t2", "#1d4630"], ["t3", "#2a5f36"],
  ["p0", "#0f1b21"], ["p1", "#16302f"], ["p2", "#20473f"], ["p3", "#2f614a"], ["p4", "#487b55"],
  ["a0", "#5c5a22"], ["a1", "#8a8530"], ["a2", "#b9ad44"], ["a3", "#e2d268"],
  ["d0", "#2a1916"], ["d1", "#46291e"], ["d2", "#693f28"], ["d3", "#8e5d36"], ["d4", "#b1804b"], ["d5", "#d2a76c"],
  ["r0", "#25242e"], ["r1", "#3a3a46"], ["r2", "#555663"], ["r3", "#737682"], ["r4", "#979aa3"], ["r5", "#c1c3c6"],
  ["s0", "#9e855a"], ["s1", "#c2a872"], ["s2", "#dcc690"], ["s3", "#efe3b8"],
  ["w0", "#0a1730"], ["w1", "#0f264b"], ["w2", "#15386a"], ["w3", "#1e5089"], ["w4", "#2c6ca8"], ["w5", "#478fc6"], ["w6", "#81c1e4"], ["w7", "#d4eef6"],
  ["m0", "#28331f"], ["m1", "#3c4a29"], ["m2", "#546534"], ["m3", "#728244"],
  ["snow", "#eef2f6"],
  ["k0", "#f1c294"], ["k1", "#c88b5b"], ["k2", "#8a5535"],
  ["f0", "#7a1a12"], ["f1", "#c63b16"], ["f2", "#ed7b1f"], ["f3", "#f9b93b"], ["f4", "#fff28c"],
  ["red", "#cf3a48"], ["violet", "#9459c4"],
  ...COLORS.slice(0, 5).map((c, k) => ["c" + k, c]),
];

export const P = {};
export const RGB = LIST.map(([name, hex], i) => {
  P[name] = i;
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
});
export const NCOL = RGB.length;
export const ramp = (...names) => names.map((n) => P[n]);

const lum = ([r, g, b]) => r * 0.3 + g * 0.59 + b * 0.11;
function nearest(r, g, b, ok) {
  let best = 0, bd = Infinity;
  RGB.forEach((c, i) => {
    if (!ok(i)) return;
    const d = 2 * (c[0] - r) ** 2 + 4 * (c[1] - g) ** 2 + 3 * (c[2] - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
// Shadows go darker and a touch bluer; glow goes lighter and warmer. Both stay inside the palette.
const natural = (i) => i < P.k0;
export const SHADOW = Uint8Array.from(RGB, (c, i) => { const L = lum(c); return nearest(c[0] * 0.58, c[1] * 0.62, c[2] * 0.7 + 10, (j) => j !== i && natural(j) && lum(RGB[j]) < L); });
export const GLOW = Uint8Array.from(RGB, (c, i) => { const L = lum(c); const j = nearest(c[0] * 1.08 + 70, c[1] * 1.02 + 34, c[2] * 0.85, (j) => j !== i && lum(RGB[j]) > L && (natural(j) || (j >= P.f0 && j <= P.f4))); return lum(RGB[j]) > L ? j : i; });
