// One fixed limited palette. Everything is drawn as indices into it; shadow, glow and haze are index remaps.
// `?pal=` swaps the hex values behind the same names, so every sprite and ramp re-themes without code changes.
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
  ["haze", "#b8c4cc"], ["haze2", "#dfe6ea"],
];

// Per theme, each ramp family in order (t starts at t1); anything left out keeps its classic value.
const THEMES = {
  // Expedition Morning: TTD's clean sea blue running to turquoise shallows, grass from cool blue-green shade to warm
  // yellow-green sun, gold on lit faces, blue-violet in the shade, pale gold sand
  adventure: {
    g: "132824 1c3c2c 2a562e 437232 638e36 8ea844 c0c86a", t: "0e2220 14322a 1c442e", p: "0a1820 0f2628 163834 204e3e 346848",
    a: "5e5a1c 8f8a28 c4b440 f0da6a", d: "2a1a24 4a2c24 6e442a 94623a ba8a52 dcb47a", r: "2a2632 3f3a40 5c5654 807a70 aca494 d8d0be",
    s: "a8987a d0bc80 e8d89e f8eec8", w: "061840 0a2a68 0f3f90 1858b4 1a84c2 26acc4 6ad6ce f6fdfd", m: "2e3e2a 44582e 5e7238 7c8c48",
    snow: "f4f8ff", ink: "0b0c18", haze: "b4cce0", haze2: "e6f0f2",
  },
  sc2k: {
    g: "222a18 33401f 475628 5c6a30 73823a 8c9848 a8ac62", t: "1a2614 24321a 314222", p: "141c18 1d2a20 283a28 364a32 4c603e",
    a: "5e5626 807638 a49a52 c8bc74", d: "2b1e14 45301f 634529 815d37 9e7a4d bc9a6c", r: "2a2622 3e3833 58514a 736b62 8f877d b1aa9f",
    s: "8c7a5a ab9973 c6b58f ddd0ae", w: "0e1a2a 152640 1e3552 284866 345a78 48708c 7896aa b8cdd3", m: "2d3020 40452c 58603a 717a4c",
    snow: "e6e8e6",
  },
  ttd: {
    g: "18401c 22601f 2f7d23 3f9a2a 58b832 7fd044 b0e470", t: "123a1e 1a5226 236b2e", p: "0c2a22 12402e 1a5a3a 257348 3a8e5a",
    a: "6a6a14 9c9a1c cfc530 f2e45c", d: "3a2210 5a3418 7c4a20 a0662c c48a44 e0b070", r: "2c2c34 44444e 62626e 84848f a8a8b2 d0d0d6",
    s: "b8a070 d8c490 ecdcb0 fcf4d8", w: "001860 00288c 0038b0 0c50cc 2070e0 4890f0 88c0fc d8f0ff", m: "2c4018 3e5820 587430 74903c",
    snow: "f8fcff",
  },
  lush: {
    g: "0e2c14 17421a 215c22 2e782a 419434 62b040 92cc5a", t: "0c2818 12391f 1a4f28", p: "082220 0e3430 16483e 21604c 347a5a",
    a: "5a5c16 8a8420 bca832 e8cf52", d: "301a0e 4c2a14 70401e 94582a b87a3c d8a05c", r: "28262c 3c3a42 58565e 76747c 9a989e c4c2c4",
    s: "b08450 d0a468 e6c486 f6e0b0", w: "042a34 083e4a 0e5460 147078 1c8c8e 32aaa4 6ccac0 c4f0e4", m: "243214 34481c 4c6228 687e38",
    snow: "f4f8f6",
  },
  // golden hour: highlights run to gold, shades to blue-violet, sand and haze pick up pink
  dawn: {
    g: "161c2e 223438 2e4c3a 46663c 708440 a89e50 e0c878", t: "141a2e 1c2a38 263c3c", p: "12162a 1a2238 22344a 2e4a52 486458",
    a: "6a5230 9c7a3a d0a44a f6d27a", d: "2a1a26 44283a 6a3e44 90584c b67a5a daa478", r: "26243a 3a3852 555470 776f86 a0909e d0b8b8",
    s: "b88a86 d4a898 ecc6aa fae2c4", w: "101838 182650 22366a 2e4a80 3e5e92 5a74a6 9a98c0 f0dcd8", m: "2a2a36 3e4234 5a5c3e 7e7a4a",
    snow: "f8e8e0", ink: "100c1c", haze: "c8a8bc", haze2: "f0d0c8",
  },
  dusk: {
    g: "1c1830 2a2a38 363f34 4c5a34 6e7036 a8843e d4a452", t: "1c1630 262238 32303a", p: "140f26 1c1832 26263c 343a40 4c5040",
    a: "7a4424 aa5a28 d8782e f8a044", d: "2a1424 461e30 6c2e34 94443a bc6440 e08c50", r: "261c36 3a2c4a 564462 766078 9a7c88 c8a0a0",
    s: "a8685c c8806a e0a07c f4c490", w: "160e2e 22163e 30204e 40305e 54406e 745a82 b07e8e f4c0a0", m: "2a1e30 3e3232 5a4838 7a6040",
    snow: "f8d8c8", ink: "120a1a", haze: "a06a8e", haze2: "e89a80",
  },
};
const askedPal = new URLSearchParams(globalThis.location?.search ?? "").get("pal");
export const THEME = askedPal === "classic" || askedPal in THEMES ? askedPal : "adventure";
const over = {};
for (const [fam, vals] of Object.entries(THEMES[THEME] ?? {})) {
  const hex = vals.split(" ");
  if (hex.length === 1) over[fam] = hex[0];
  else hex.forEach((h, k) => (over[fam + (fam === "t" ? k + 1 : k)] = h));
}

export const P = {};
export const RGB = LIST.map(([name, hex], i) => {
  P[name] = i;
  const n = parseInt(over[name] ?? hex.slice(1), 16);
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
// Mist: part way to the pale mist color.
export const MIST = Uint8Array.from(RGB, (c, i) => {
  const h = RGB[P.haze2];
  return nearest(c[0] + (h[0] - c[0]) * 0.5, c[1] + (h[1] - c[1]) * 0.5, c[2] + (h[2] - c[2]) * 0.5, (j) => j !== i && (natural(j) || j === P.haze || j === P.haze2));
});
// Distance haze: each color's nearest neighbour part way to the horizon color.
export const HAZE = Uint8Array.from(RGB, (c, i) => {
  const h = RGB[P.haze];
  const k = THEME === "adventure" ? 0.32 : 0.5;
  return nearest(c[0] + (h[0] - c[0]) * k, c[1] + (h[1] - c[1]) * k, c[2] + (h[2] - c[2]) * k, (j) => j !== i && (natural(j) || j === P.haze || j === P.haze2));
});
