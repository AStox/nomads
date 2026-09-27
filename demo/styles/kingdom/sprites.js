// Procedural pixel sprites. A sprite holds material codes, not colors, so each depth layer can paint it with its own
// palette: 1..4 main ramp dark to light, 5 main highlight, 6..8 wood dark to light, 9 and 10 accents.
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function h2(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Spr {
  constructor(w, h, ax, ay) {
    this.w = w; this.h = h; this.ax = ax; this.ay = ay;
    this.c = new Uint8Array(w * h);
  }
  set(x, y, v) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.c[y * this.w + x] = v; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.c[y * this.w + x] : 0; }
}

const cache = new Map();
export function cached(key, make) {
  let s = cache.get(key);
  if (!s) cache.set(key, (s = make()));
  return s;
}

// Shade a pixel of a round clump lit from the upper right; v in about -1..1.
const lit = (nx, ny) => nx * 0.52 - ny * 0.85;
const band = (v, a, b, c) => (v > a ? 4 : v > b ? 3 : v > c ? 2 : 1);

function trunk(S, cx, y0, y1, tw, flare) {
  for (let y = Math.max(0, Math.floor(y0)); y <= y1; y++) {
    const t = (y - y0) / Math.max(1, y1 - y0), w = tw + (flare && t > 0.8 ? Math.round((t - 0.8) * 5 * flare) : 0);
    const x0 = Math.round(cx - (w - 1) / 2);
    for (let x = x0; x < x0 + w; x++) S.set(x, y, w < 2 ? 7 : x === x0 ? 6 : x === x0 + w - 1 && w > 2 ? 8 : 7);
  }
}

// Conifer: stacked drooping tiers on a spire, lit on the right.
export function pine(H, seed) {
  return cached(`p${H}|${seed}`, () => {
    const r = rng(seed * 7919 + H);
    const w = Math.max(3, Math.round(H * (0.34 + r() * 0.1))) | 1, cx = (w - 1) / 2;
    const S = new Spr(w, H, cx, H - 1);
    const trunkH = Math.max(1, Math.round(H * 0.1)), crownH = H - trunkH;
    trunk(S, cx, crownH - 3, H - 1, H >= 40 ? 3 : H >= 14 ? 2 : 1, H > 30 ? 1 : 0);
    if (H < 6) {
      for (let y = 0; y < crownH; y++) {
        const hw = ((y + 1) / crownH) * (w / 2);
        for (let x = 0; x < w; x++) if (Math.abs(x - cx) < hw + 0.2) S.set(x, y, x > cx ? 3 : 2);
      }
      return S;
    }
    const tiers = Math.max(2, Math.min(10, Math.round(crownH / (6 + r() * 2)))), phase = r() * 0.3;
    for (let y = 0; y < crownH; y++) {
      const t = (y + 0.5) / crownH, f = t * tiers + phase, i = Math.floor(f), local = f - i;
      let hw = (w / 2) * Math.min(1, 0.1 + 0.9 * t) * (0.42 + 0.58 * Math.pow(local, 0.75));
      if (y < 2) hw = 0.5;
      const jag = (h2(y, i, seed) - 0.5) * 1.2;
      for (let x = 0; x < w; x++) {
        const dx = x - cx, e = hw + (Math.abs(dx) > hw - 1.5 ? jag : 0);
        if (Math.abs(dx) > e) continue;
        // Tips droop: the last row of a tier keeps only its outer ends.
        if (local > 0.9 && Math.abs(dx) < hw * 0.35 && i < tiers - 1 && H > 16) continue;
        const xr = dx / Math.max(e, 0.6);
        let v = xr * 0.9 + (local - 0.55) * 0.5 + (h2(x >> 1, y >> 1, seed + 3) - 0.5) * 0.35;
        if (local < 0.28 && i > 0) v -= 0.55;
        S.set(x, y, band(v, 0.5, -0.05, -0.55));
      }
    }
    // Highlight the sunward tips of each tier.
    for (let y = 1; y < crownH; y++) for (let x = w - 1; x >= 0; x--) {
      const v = S.get(x, y);
      if (v >= 1 && v <= 4) { if (v >= 3 && x > cx) S.set(x, y, 5); break; }
    }
    return S;
  });
}

// Broadleaf: overlapping leaf clumps on a trunk with a few branches showing through gaps.
const BROAD = {
  oak: { wf: 0.82, trunk: 0.34, tw: 0.075, clump: 0.34 },
  ash: { wf: 0.6, trunk: 0.4, tw: 0.055, clump: 0.3 },
  aspen: { wf: 0.36, trunk: 0.36, tw: 0.05, clump: 0.42 },
};
export function broad(kind, H, seed) {
  return cached(`${kind}${H}|${seed}`, () => {
    const K = BROAD[kind], r = rng(seed * 104729 + H);
    const w0 = Math.max(3, Math.round(H * K.wf * (0.88 + r() * 0.24))), pad = H >= 6 ? Math.ceil(w0 * 0.12) : 0, w = w0 + pad * 2;
    const S = new Spr(w, H, (w - 1) / 2, H - 1);
    const cx = (w - 1) / 2, crownB = Math.max(2, Math.round(H * (1 - K.trunk))), rx = w0 / 2, padT = H >= 6 ? Math.round(Math.min(rx, crownB / 2) * 0.3) : 0;
    const ry = (crownB - padT) / 2, cy = padT + ry;
    const tw = Math.max(1, Math.round(H * K.tw));
    trunk(S, cx + (r() - 0.5) * 0.8, cy, H - 1, tw, H > 24 ? 1.2 : 0);
    if (H < 6) {
      for (let y = 0; y < crownB; y++) for (let x = 0; x < w; x++) {
        const nx = (x - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1.05) S.set(x, y, lit(nx, ny) > 0.1 ? 3 : 2);
      }
      return S;
    }
    // Branches, drawn before the leaves so they only show through the gaps.
    for (let b = 0; b < 2 + (H > 30 ? 2 : 0); b++) {
      const side = b % 2 ? 1 : -1, y0 = cy + ry * (0.35 + r() * 0.4);
      for (let k = 0; k < rx * 0.8; k++) S.set(Math.round(cx + side * k), Math.round(y0 - k * (0.6 + r() * 0.3)), 6);
    }
    // A core, lumps crowding the upper rim so the outline is bumpy, and a couple of drooping side masses.
    const n = Math.max(3, Math.min(20, Math.round((w0 * crownB) / (kind === "ash" ? 13 : 18)))), m = Math.min(rx, ry);
    const clumps = [{ x: cx, y: cy + ry * 0.12, r: m * 0.66 }];
    for (let k = 0; k < n; k++) {
      const outer = k < n * 0.6, a = outer ? -Math.PI * (0.04 + r() * 0.92) : r() * Math.PI * 2;
      const d = outer ? 0.74 + r() * 0.3 : Math.sqrt(r()) * 0.7;
      const rc = m * (K.clump + r() * 0.2) * (kind === "aspen" ? 1.2 : 1) * (outer ? 0.85 : 1);
      clumps.push({ x: cx + Math.cos(a) * d * Math.max(0, rx - rc * 0.55), y: cy + Math.sin(a) * d * Math.max(0, ry - rc * 0.55), r: rc });
    }
    for (const s of [-1, 1]) if (r() < 0.8) clumps.push({ x: cx + s * rx * (0.5 + r() * 0.25), y: cy + ry * (0.2 + r() * 0.3), r: m * (0.3 + r() * 0.14) });
    clumps.sort((p, q) => p.y - q.y);
    for (const c of clumps) {
      const R = Math.max(1, c.r);
      for (let y = Math.floor(c.y - R); y <= c.y + R; y++) for (let x = Math.floor(c.x - R); x <= c.x + R; x++) {
        const nx = (x + 0.5 - c.x) / R, ny = (y + 0.5 - c.y) / R, q = nx * nx + ny * ny;
        if (q > 1 || y >= crownB + 1) continue;
        const g = ((x - cx) / rx) * 0.35 - ((y - cy) / ry) * 0.55;
        const v = lit(nx, ny) * 0.6 + g * 0.7 + (h2(x, y, seed) - 0.5) * 0.25 - (q > 0.75 && ny > 0.2 ? 0.35 : 0);
        S.set(x, y, band(v, 0.55, 0.05, -0.45));
      }
    }
    // A few gaps low in the crown.
    if (H > 22) for (let k = 0; k < H / 12; k++) {
      const x = Math.round(cx + (r() - 0.5) * rx * 1.1), y = Math.round(cy + ry * (0.2 + r() * 0.6));
      if (S.get(x, y) >= 1 && S.get(x, y) <= 2) { S.set(x, y, 0); if (r() < 0.5) S.set(x + 1, y, 0); }
    }
    // Sun-catching edge on the upper right of the crown only.
    for (let y = 0; y < crownB; y++) for (let x = w - 1; x >= 0; x--) {
      const v = S.get(x, y);
      if (v >= 1 && v <= 4) { if (v >= 3 && y < cy + ry * 0.1 && y > cy - ry * 0.9) S.set(x, y, 5); break; }
    }
    for (let x = Math.ceil(cx + rx * 0.15); x < w; x++) for (let y = 0; y < crownB; y++) {
      const v = S.get(x, y);
      if (v >= 1 && v <= 5) { if (v >= 3) S.set(x, y, 5); break; }
    }
    // Aspens show pale bark with dark marks.
    if (kind === "aspen") for (let y = Math.round(cy + ry * 0.6); y < H; y++) for (let x = 0; x < w; x++) if (S.get(x, y) >= 6 && S.get(x, y) <= 8) S.set(x, y, h2(x, y, seed) < 0.18 ? 6 : 9);
    return S;
  });
}

export function shrub(H, heath, seed) {
  return cached(`s${H}|${heath}|${seed}`, () => {
    const r = rng(seed * 31 + H), w = Math.max(2, Math.round(H * (heath ? 2.6 : 2.0))), S = new Spr(w, H, (w - 1) / 2, H - 1);
    const n = Math.max(1, Math.min(6, Math.round(w / 4)));
    const clumps = [];
    for (let k = 0; k < n; k++) {
      const rc = H * (0.5 + r() * 0.35);
      clumps.push({ x: (w - 1) * (n === 1 ? 0.5 : k / (n - 1)) * 0.8 + w * 0.1, y: H - rc * 0.8, r: rc });
    }
    clumps.sort((p, q) => p.y - q.y);
    for (const c of clumps) for (let y = Math.floor(c.y - c.r); y < H; y++) for (let x = Math.floor(c.x - c.r); x <= c.x + c.r; x++) {
      const nx = (x + 0.5 - c.x) / c.r, ny = (y + 0.5 - c.y) / c.r;
      if (nx * nx + ny * ny > 1 && !(ny > 0 && Math.abs(nx) < 1)) continue;
      const v = lit(nx, ny) * 0.7 + (h2(x, y, seed) - 0.5) * 0.3 - (y > H - 2 ? 0.5 : 0);
      S.set(x, y, band(v, 0.5, 0, -0.5));
    }
    if (heath) for (let k = 0; k < w * H * 0.12; k++) { const x = Math.floor(r() * w), y = Math.floor(r() * H * 0.7); if (S.get(x, y) >= 2) S.set(x, y, 9); }
    else if (H > 4) for (let k = 0; k < w * 0.2; k++) { const x = Math.floor(r() * w), y = Math.floor(r() * H * 0.6); if (S.get(x, y) >= 3) S.set(x, y, 9); }
    return S;
  });
}

// Boulder: a flattened dome with a lit upper-right face and moss on top.
export function rock(w, seed, moss) {
  return cached(`r${w}|${seed}|${moss}`, () => {
    const r = rng(seed * 13 + w), h = Math.max(1, Math.round(w * (0.5 + r() * 0.25))), S = new Spr(w, h, (w - 1) / 2, h - 1);
    const cx = (w - 1) / 2 + (r() - 0.5) * w * 0.2;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5 - w / 2) / (w / 2), top = h * Math.pow(Math.max(0, 1 - nx * nx), 0.45) * (0.85 + h2(x, 0, seed) * 0.15);
      for (let y = h - 1; y >= h - Math.max(1, Math.round(top)); y--) {
        const ny = (h - 1 - y) / Math.max(1, h - 1), fx = (x - cx) / (w / 2);
        let v = fx * 0.6 + ny * 0.8 - 0.45 + (h2(x >> 1, y >> 1, seed) - 0.5) * 0.3;
        if (y === h - 1) v -= 0.6;
        S.set(x, y, band(v, 0.55, 0.05, -0.4));
      }
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const v = S.get(x, y);
      if (v) { if (moss && h2(x, y, seed + 9) < moss) S.set(x, y, 9); else if (v >= 3 && x > cx - 1) S.set(x, y, 5); break; }
    }
    return S;
  });
}
