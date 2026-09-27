// Threshold maps for 1-bit dithering: a void-and-cluster blue noise tile and an ordered Bayer tile.

// Ulichney's void-and-cluster: every rank goes to the emptiest spot left (or leaves the densest), so each threshold
// level on its own is an even, patternless scatter.
export function blueNoise(S = 64, sigma = 1.6, seed = 7) {
  const n = S * S, lut = new Float32Array(n);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = Math.min(x, S - x), dy = Math.min(y, S - y);
      lut[y * S + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const energy = new Float32Array(n), bits = new Uint8Array(n), rank = new Int32Array(n);
  const splat = (p, sgn) => {
    const px = p % S, py = (p - px) / S;
    for (let y = 0; y < S; y++) {
      const ly = ((y - py + S) % S) * S, row = y * S;
      for (let x = 0; x < S; x++) energy[row + x] += sgn * lut[ly + ((x - px + S) % S)];
    }
  };
  const tightest = () => { let b = -1, e = -Infinity; for (let i = 0; i < n; i++) if (bits[i] && energy[i] > e) { e = energy[i]; b = i; } return b; };
  const emptiest = () => { let b = -1, e = Infinity; for (let i = 0; i < n; i++) if (!bits[i] && energy[i] < e) { e = energy[i]; b = i; } return b; };
  const ones = Math.floor(n / 10);
  for (let k = 0; k < ones; ) { const p = Math.floor(rand() * n); if (!bits[p]) { bits[p] = 1; splat(p, 1); k++; } }
  for (let it = 0; it < 4 * n; it++) {
    const c = tightest();
    bits[c] = 0; splat(c, -1);
    const v = emptiest();
    bits[v] = 1; splat(v, 1);
    if (v === c) break;
  }
  const proto = bits.slice(), protoE = energy.slice();
  for (let k = ones - 1; k >= 0; k--) { const c = tightest(); bits[c] = 0; splat(c, -1); rank[c] = k; }
  bits.set(proto); energy.set(protoE);
  for (let k = ones; k < n; k++) { const v = emptiest(); bits[v] = 1; splat(v, 1); rank[v] = k; }
  return { size: S, t: Float32Array.from(rank, (r) => (r + 0.5) / n) };
}

export function bayer(S = 8) {
  let m = [[0]];
  while (m.length < S) {
    const s = m.length, r = [];
    for (let y = 0; y < 2 * s; y++) {
      r.push([]);
      for (let x = 0; x < 2 * s; x++) r[y].push(4 * m[y % s][x % s] + [[0, 2], [3, 1]][(y / s) | 0][(x / s) | 0]);
    }
    m = r;
  }
  return { size: S, t: Float32Array.from(m.flat(), (v) => (v + 0.5) / (S * S)) };
}
