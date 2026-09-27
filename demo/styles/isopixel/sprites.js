// Procedural pixel sprites: every tree, bush, rock, tuft and person is painted pixel by pixel from a few ramps.
import { P, ramp, SHADOW } from "./pal.js";
import { Spr, dith, h2 } from "./px.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const R = {
  pine: ramp("ink", "p0", "p1", "p2", "p3", "p4", "g4"),
  oak: ramp("ink", "p0", "t1", "t2", "t3", "g3", "g4", "g5"),
  ash: ramp("ink", "t1", "g1", "g2", "g3", "g4", "g5", "g6"),
  aspen: ramp("p0", "g1", "g2", "g3", "g4", "g5", "g6", "a3"),
  gold: ramp("d0", "d1", "a0", "a1", "a2", "a3", "s3"),
  bush: ramp("ink", "t1", "g1", "g2", "g3", "g4", "g5"),
  heath: ramp("ink", "m0", "m1", "m2", "m3", "a1", "a2"),
  rock: ramp("ink", "r0", "r1", "r2", "r3", "r4", "r5"),
  bark: ramp("d0", "d1", "d2", "d3"),
  grass: ramp("g1", "g2", "g3", "g4", "g5", "g6"),
};
// Upper-left key light, the same everywhere.
const LX = -0.55, LY = -0.62, LZ = 0.56;

// Leaf clusters: the nearest point of a jittered grid, each clump lit on its upper left with dark gaps between.
function clumps(x, y, c, seed) {
  const gx = x / c, gy = y / c, ix = Math.floor(gx), iy = Math.floor(gy);
  let bd = 9, ox = 0, oy = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const px = ix + i + 0.2 + 0.6 * h2(ix + i, iy + j, seed + 1), py = iy + j + 0.2 + 0.6 * h2(ix + i, iy + j, seed + 2);
      const d = (gx - px) ** 2 + (gy - py) ** 2;
      if (d < bd) { bd = d; ox = gx - px; oy = gy - py; }
    }
  return -(ox * 0.7 + oy * 0.8) * 0.9 - bd * 0.6 + 0.15;
}

export function pine(hpx, seed, snow = false) {
  const h = Math.max(6, Math.round(hpx)), trunk = Math.max(1, Math.round(h * 0.11)), crown = h - trunk;
  let w = Math.max(3, Math.round(h * 0.42));
  if (w % 2 === 0) w++;
  const S = new Spr(w + 3, h + 2, (w + 1) >> 1, h), cx = S.ax, r = R.pine;
  const tiers = clamp(Math.round(crown / 4.2), 2, 8);
  for (let y = 0; y < crown; y++) {
    const t = (y + 0.5) / crown, tp = (t * tiers) % 1;
    const half = (w / 2) * (0.1 + 0.9 * t) * (0.5 + 0.5 * tp) + (h2(y, seed, 3) - 0.5) * 0.7;
    const hl = Math.round(half + (h2(y, seed, 4) - 0.5) * 0.8), hr = Math.round(half);
    for (let dx = -hl; dx <= hr; dx++) {
      const x = cx + dx, f = dx / Math.max(1, half);
      let v = 3.4 - f * 1.5 - tp * 1.1 + (h2(x, y, seed) - 0.5) * 0.9;
      if (dx === hr) v -= 1.1;
      if (tp > 0.78) v -= 0.9;
      if (dx === -hl && tp < 0.6) v += 0.8;
      S.set(x, y, dith(r, v, x, y));
      if (snow && tp < 0.3 && dx < 0 && h2(x, y, seed + 9) < 0.6) S.set(x, y, P.snow);
    }
  }
  S.set(cx, 0, r[4]);
  for (let y = crown; y < h; y++) { S.set(cx, y, P.d1); if (h >= 18) S.set(cx - 1, y, P.d2); }
  S.outline(r[0], true);
  return S;
}

// A round crown built from overlapping leaf clumps, each shaded as a little sphere.
export function broad(hpx, kind, seed, tint) {
  const h = Math.max(6, Math.round(hpx));
  const r = kind === "aspen" && tint > 0.8 ? R.gold : R[kind] || R.ash;
  const cw = Math.max(4, Math.round(h * (kind === "oak" ? 0.8 : kind === "ash" ? 0.68 : 0.5)));
  const ch = Math.max(4, Math.round(h * (kind === "aspen" ? 0.74 : 0.66)));
  const W = cw + 4, S = new Spr(W, h + 2, W >> 1, h), cx = W / 2, cy = ch / 2 + 0.5;
  const n = clamp(Math.round(cw / 3.2), 3, 9), rad = Math.min(cw, ch) / 2;
  const blobs = [[cx, cy, rad * 0.78]];
  for (let k = 1; k < n; k++) {
    const a = h2(k, seed, 1) * 6.283, d = rad * (0.35 + 0.35 * h2(k, seed, 2)), br = rad * (0.4 + 0.25 * h2(k, seed, 3));
    blobs.push([cx + Math.cos(a) * d * (cw / Math.max(cw, ch)) * 1.1, cy + Math.sin(a) * d * 0.85, br]);
  }
  const lift = (tint - 0.5) * 1.3 - 0.35;
  for (let y = 0; y < ch + 2; y++)
    for (let x = 0; x < W; x++) {
      let best = -1, nx = 0, ny = 0, nz = 0, rim = 0;
      for (const [bx, by, br] of blobs) {
        const dx = (x + 0.5 - bx) / br, dy = (y + 0.5 - by) / br, d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const z = Math.sqrt(1 - d2), score = z * br + by * 0.25;
        if (score > best) { best = score; nx = dx; ny = dy; nz = z; rim = d2; }
      }
      if (best < 0) continue;
      let l = nx * LX + ny * LY + nz * LZ + (h2(x, y, seed) - 0.5) * 0.25;
      l += h >= 18 ? clumps(x, y, Math.max(2.4, h / 13), seed) : (h2((x + seed) >> 1, y >> 1, 5) - 0.5) * 0.5;
      let v = 1.1 + (l * 0.55 + 0.45) * (r.length - 1.4) + lift;
      if (rim > 0.72 && nx + ny > 0.45) v -= 1.2;
      S.set(x, y, dith(r, v, x, y));
    }
  const tw = h >= 14 ? Math.max(2, Math.round(h / 15)) : 1, t0 = Math.round(ch * 0.78), tx = Math.floor(cx) - (tw >> 1);
  for (let y = t0; y < h; y++)
    for (let k = 0; k < tw; k++) {
      if (S.get(tx + k, y) !== 255 && y < ch) continue;
      const f = tw === 1 ? 0.5 : k / (tw - 1);
      S.set(tx + k, y, h2(tx + k, y >> 1, seed) < 0.12 ? P.d1 : f < 0.34 ? P.d3 : f < 0.7 ? P.d2 : P.d1);
    }
  if (h >= 16) { S.set(tx - 1, h - 1, P.d2); S.set(tx + tw, h - 1, P.d0); }
  S.outline(r[0], true);
  return S;
}

export function bush(size, seed, heath = 0, berries = 0) {
  const w = Math.max(3, Math.round(size * 1.5)), hh = Math.max(2, Math.round(size)), r = heath > 0.5 ? R.heath : R.bush;
  const S = new Spr(w + 3, hh + 3, (w + 3) >> 1, hh + 1), cx = (w + 3) / 2, cy = hh / 2 + 1;
  const blobs = [[cx, cy + 0.3, Math.min(w / 2, hh) * 0.95]];
  for (let k = 1; k < 4; k++) blobs.push([cx + (h2(k, seed, 1) - 0.5) * w * 0.7, cy + (h2(k, seed, 2) - 0.3) * hh * 0.4, hh * (0.45 + 0.3 * h2(k, seed, 3))]);
  for (let y = 0; y < S.h - 1; y++)
    for (let x = 0; x < S.w; x++) {
      let best = -1, nx = 0, ny = 0, nz = 0;
      for (const [bx, by, br] of blobs) {
        const dx = (x + 0.5 - bx) / (br * 1.25), dy = (y + 0.5 - by) / br, d2 = dx * dx + dy * dy;
        if (d2 >= 1 || y + 0.5 > cy + hh * 0.55) continue;
        const z = Math.sqrt(1 - d2);
        if (z > best) { best = z; nx = dx; ny = dy; nz = z; }
      }
      if (best < 0) continue;
      const l = nx * LX + ny * LY + nz * LZ + (size >= 8 ? clumps(x, y, Math.max(2.2, size / 5), seed) : (h2(x >> 1, y >> 1, seed) - 0.5) * 0.5);
      S.set(x, y, dith(r, 1.2 + (l * 0.55 + 0.45) * (r.length - 1.6), x, y));
      if (ny < -0.1 && nx < 0.3 && h2(x, y, seed + 7) < (heath > 0.5 ? 0.18 : berries > 0.75 ? 0.08 : 0)) S.set(x, y, heath > 0.5 ? P.violet : berries > 0.9 ? P.red : P.snow);
    }
  S.outline(r[0], true);
  return S;
}

export function rock(size, seed, moss = 0) {
  const rx = Math.max(1, size * 0.62), ry = Math.max(1, size * 0.42), w = Math.ceil(rx * 2) + 3, hh = Math.ceil(ry * 1.7) + 3;
  const S = new Spr(w, hh, w >> 1, hh - 2), cx = w / 2, base = hh - 2;
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - base) / (ry * 1.6);
      const bump = (h2(Math.floor((x + 0.5 - cx) / 1.8 + 9), Math.floor(dy * 3 + 9), seed) - 0.5) * 0.35;
      if (dy > 0.18 || dx * dx + dy * dy > 1 + bump) continue;
      const nz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
      // facets: quantize the normal's direction so the boulder reads as chipped planes
      const a = Math.round(Math.atan2(dy, dx) / 1.0472) * 1.0472, m = Math.hypot(dx, dy);
      const l = Math.cos(a) * m * LX + Math.sin(a) * m * LY + nz * LZ;
      let v = 1.4 + (l * 0.6 + 0.45) * 5 + (h2(x, y, seed) - 0.5) * 0.4;
      if (dy > 0.05) v -= 1;
      S.set(x, y, moss > 0.4 && dy < -0.55 && h2(x, y, seed + 3) < moss ? (h2(x, y, 4) < 0.5 ? P.g2 : P.g3) : dith(R.rock, v, x, y));
    }
  S.outline(P.r0, true);
  return S;
}

export function tuft(hpx, seed, dry = 0) {
  const h = Math.max(2, Math.round(hpx)), S = new Spr(9, h + 1, 4, h), r = dry > 0.6 ? ramp("m1", "m2", "a1", "a2", "a3", "s2") : R.grass;
  const blades = 3 + Math.floor(h2(1, seed, 1) * 4);
  for (let b = 0; b < blades; b++) {
    const x0 = 4 + Math.round((h2(b, seed, 2) - 0.5) * 4), lean = (h2(b, seed, 3) - 0.5) * 1.3, L = Math.max(1, Math.round(h * (0.55 + 0.45 * h2(b, seed, 4))));
    for (let k = 0; k < L; k++) {
      const x = Math.round(x0 + lean * k * (k / L)), f = k / L;
      S.set(x, h - k, r[clamp(Math.floor(f * 3.2 + (lean < 0 ? 1.2 : 0.2)), 0, r.length - 1)]);
    }
  }
  return S;
}

const PETAL = [P.red, P.f3, P.snow, P.violet, P.a3, P.k0];
export function flower(hpx, hue, seed) {
  const h = Math.max(2, Math.round(hpx)), S = new Spr(5, h + 2, 2, h + 1), c = PETAL[Math.floor(hue * PETAL.length) % PETAL.length];
  for (let k = 1; k <= h; k++) S.set(2 + (k === h && h2(1, seed) < 0.5 ? 0 : 0), h + 1 - k, k === 1 ? P.g1 : P.g2);
  if (h >= 4) { S.set(1, 1, c); S.set(3, 1, c); S.set(2, 0, c); S.set(2, 2, c); S.set(2, 1, P.f3 === c ? P.d3 : P.f3); }
  else S.set(2, 0, c);
  return S;
}

export function reeds(hpx, seed) {
  const h = Math.max(3, Math.round(hpx)), S = new Spr(9, h + 2, 4, h + 1), r = ramp("m1", "m2", "m3", "a1", "a2");
  const n = 4 + Math.floor(h2(0, seed) * 4);
  for (let s = 0; s < n; s++) {
    const x0 = 4 + Math.round((h2(s, seed, 1) - 0.5) * 7), L = Math.max(2, Math.round(h * (0.5 + 0.5 * h2(s, seed, 2)))), lean = (h2(s, seed, 3) - 0.5) * 0.6;
    for (let k = 0; k < L; k++) S.set(Math.round(x0 + lean * k), h + 1 - k, r[clamp(Math.floor((k / L) * 4 + h2(s, seed, 4)), 0, 4)]);
    if (h >= 6 && h2(s, seed, 5) < 0.45) { S.set(Math.round(x0 + lean * L), h + 1 - L, P.d1); S.set(Math.round(x0 + lean * L), h + 2 - L, P.d2); }
  }
  return S;
}

export function pebble(size, seed) {
  const w = Math.max(1, Math.round(size * 1.4)), hh = Math.max(1, Math.round(size * 0.8)), S = new Spr(w + 1, hh + 1, w >> 1, hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) S.set(x, y, y === 0 && x < w - 1 ? P.r4 : x === w - 1 ? P.r2 : P.r3);
  for (let x = 0; x <= w; x++) S.set(x, hh, P.r1);
  if (h2(seed, 1) < 0.3) S.set(0, 0, P.r5);
  return S;
}

// Island-scale trees: a few hand-placed pixels each.
const MINI = {
  pine: [" a ", " b ", "abc", "abc", " t "],
  pine2: [" a ", "abc", " b ", "abc", "abc", " t "],
  broad: [" ab ", "abbc", "bbcc", " cc ", "  t "],
  broad2: [" ab", "abc", " t "],
};
export function mini(kind, rp) {
  const rows = MINI[kind], S = new Spr(rows[0].length + 1, rows.length + 1, rows[0].length >> 1, rows.length - 1);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== " ") S.set(x, y, ch === "t" ? P.d1 : rp[ch === "a" ? 2 : ch === "b" ? 1 : 0]); }));
  S.outline(P.ink, true);
  return S;
}

export function miniTent() {
  const S = new Spr(6, 4, 2, 2);
  ["  a  ", " abc ", "abbcc"].forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== " ") S.set(x, y, ch === "a" ? P.s3 : ch === "b" ? P.s2 : P.s0); }));
  S.outline(P.ink, true);
  return S;
}

// People: head, body, arms and legs from rectangles, shaded lit-left, then outlined.
export function person(hpx, cloth, facing, pose, seed, side = 0) {
  const skin = h2(seed, 1) < 0.35 ? [P.k1, P.k2] : [P.k0, P.k1];
  const hair = [P.d0, P.d1, P.ink, P.d3, P.d2][Math.floor(h2(seed, 2) * 5)];
  const pants = [P.d1, P.r1, P.d2, P.m1][Math.floor(h2(seed, 3) * 4)];
  const dark = SHADOW[cloth];
  if (hpx >= 9 && hpx < 16) {
    // small: a 4-pixel body, readable at a glance
    const sit = pose === "sit", S = new Spr(8, 14, 3, 12), o = sit ? 3 : 1, back = facing === "back";
    const px = (x, y, c) => S.set(x + 1, y + o, c);
    px(1, 0, hair); px(2, 0, hair);
    if (back) for (let x = 0; x < 4; x++) px(x, 1, hair);
    else { px(0, 1, hair); px(1, 1, skin[0]); px(2, 1, skin[0]); px(3, 1, facing === "side" ? skin[1] : hair); }
    px(1, 2, back ? hair : skin[0]); px(2, 2, back ? hair : skin[1]);
    for (let x = 0; x < 4; x++) { px(x, 3, x === 3 ? dark : cloth); px(x, 4, x >= 2 ? dark : cloth); }
    px(0, 5, skin[0]); px(1, 5, cloth); px(2, 5, dark); px(3, 5, skin[1]);
    if (sit) {
      const d = side ? 1 : -1, x0 = side ? 3 : 0;
      for (let x = 0; x < 4; x++) px(x, 6, x >= 2 ? SHADOW[pants] : pants);
      px(x0 + d, 6, pants); px(x0 + d, 7, P.ink);
    } else {
      for (let x = 0; x < 4; x++) px(x, 6, x >= 2 ? SHADOW[pants] : pants);
      px(0, 7, pants); px(3, 7, SHADOW[pants]); px(0, 8, P.ink); px(3, 8, P.ink);
    }
    S.outline(P.ink);
    return S;
  }
  if (hpx < 9) {
    // tiny: 3 wide
    const sit = pose === "sit", S = new Spr(5, 9, 2, 8);
    S.set(2, sit ? 2 : 0, hair); S.set(2, sit ? 3 : 1, facing === "back" ? hair : skin[0]);
    for (let y = sit ? 4 : 2; y <= (sit ? 5 : 4); y++) { S.set(1, y, cloth); S.set(2, y, cloth); S.set(3, y, dark); }
    if (sit) { S.set(1, 6, pants); S.set(2, 6, pants); S.set(3, 6, pants); S.set(side ? 4 : 0, 6, pants); }
    else { S.set(1, 5, pants); S.set(3, 5, pants); S.set(1, 6, P.ink); S.set(3, 6, P.ink); }
    return S;
  }
  // big: proportions follow the height, so close views get bigger, more detailed people
  const H = Math.round(hpx), sit = pose === "sit", back = facing === "back", prof = facing === "side", dir = side ? 1 : -1;
  let hd = Math.max(5, Math.round(H * 0.22));
  if (hd % 2 === 0) hd++;
  let tw = hd + 2;
  if (tw % 2 === 0) tw++;
  const th = Math.round(H * 0.34), lh = H - hd - th, drop = sit ? Math.round(lh * 0.5) : 0;
  const W = tw + 14, S = new Spr(W, H + 3, W >> 1, H), cx = W >> 1;
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) S.set(x, y, c); };
  const top = drop, r = hd / 2;
  for (let y = 0; y < hd; y++)
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      const dy = y + 0.5 - r;
      if (dx * dx + dy * dy > r * r + 0.6) continue;
      const hairTop = y < hd * 0.36, hairSide = Math.abs(dx) >= r - 1.1 && y < hd * 0.8;
      let c;
      if (back) c = hair;
      else if (prof) c = hairTop || dx * dir < 0 ? hair : skin[0];
      else c = hairTop || hairSide ? hair : dx > r - 2 ? skin[1] : skin[0];
      S.set(cx + dx, top + y, c);
    }
  if (!back) {
    const ey = top + Math.round(hd * 0.56);
    if (prof) { S.set(cx + dir * Math.round(r - 1.5), ey, P.ink); S.set(cx + dir * Math.ceil(r + 0.2), ey + 1, skin[0]); }
    else { S.set(cx - Math.round(r * 0.45), ey, P.ink); S.set(cx + Math.round(r * 0.45), ey, P.ink); if (hd >= 7) S.set(cx, ey + 2, skin[1]); }
  }
  // torso, shaded dark on the right third, with a neckline and belt
  const ty = top + hd, half = tw >> 1, bw = prof ? half - 1 : half;
  for (let y = 0; y < th; y++) {
    const w0 = y === 0 || y >= th - 2 ? bw - 1 : bw;
    for (let x = -w0; x <= w0; x++) S.set(cx + x, ty + y, x > w0 * 0.34 ? dark : cloth);
  }
  if (!back && !prof) { S.set(cx, ty, skin[1]); S.set(cx, ty + 1, skin[1]); }
  rect(cx - bw + 1, ty + th - 1, cx + bw - 1, ty + th - 1, P.d1);
  if (!back && !prof && H >= 24) S.set(cx, ty + th - 1, P.a2);
  const aw = H >= 26 ? 2 : 1, al = th - 2;
  if (!prof) {
    rect(cx - bw - aw, ty + 1, cx - bw - 1, ty + al, cloth);
    rect(cx + bw + 1, ty + 1, cx + bw + aw, ty + al, dark);
    rect(cx - bw - aw, ty + al + 1, cx - bw - 1, ty + al + 2, skin[0]);
    rect(cx + bw + 1, ty + al + 1, cx + bw + aw, ty + al + 2, skin[1]);
  } else {
    rect(cx + (dir > 0 ? 0 : -aw + 1), ty + 1, cx + (dir > 0 ? aw - 1 : 0), ty + al, dark);
    rect(cx + dir * 1, ty + al + 1, cx + dir * aw, ty + al + 2, skin[1]);
  }
  const ly = ty + th, lw = Math.max(1, half - 1), pd = SHADOW[pants];
  if (!sit) {
    const ll = H - ly - 1;
    if (!prof) { rect(cx - lw, ly, cx - 1, ly + ll - 1, pants); rect(cx + 1, ly, cx + lw, ly + ll - 1, pd); rect(cx - lw - 1, H - 1, cx - 1, H - 1, P.d0); rect(cx + 1, H - 1, cx + lw + 1, H - 1, P.d0); }
    else {
      rect(cx - lw + 1, ly, cx + lw - 1, ly + 1, pants);
      rect(cx - dir, ly + 2, cx - dir + (lw > 1 ? -dir : 0), H - 2, pd);
      rect(cx + dir, ly + 2, cx + dir + (lw > 1 ? dir : 0), H - 2, pants);
      rect(Math.min(cx - dir * 2, cx + dir * 3), H - 1, Math.max(cx - dir * 2, cx + dir * 3), H - 1, P.d0);
    }
  } else {
    // seated on a log: thighs forward, shins down
    const lx0 = cx - bw - 3, lx1 = cx + bw + 3;
    rect(lx0, ly + 1, lx1, H - 1, P.d2);
    rect(lx0, ly + 1, lx1, ly + 1, P.d3);
    rect(lx0, H - 1, lx1, H - 1, P.d1);
    rect(lx0, ly + 1, lx0, H - 1, P.d4); S.set(lx0, ly + 2, P.d3);
    if (prof) {
      rect(cx - lw, ly, cx + dir * (lw + 3), ly + 1, pants);
      const kx = cx + dir * (lw + 3);
      rect(Math.min(kx, kx - dir), ly + 2, Math.max(kx, kx - dir), H - 1, pd);
      rect(Math.min(kx - dir, kx + dir * 2), H, Math.max(kx - dir, kx + dir * 2), H, P.d0);
    } else if (!back) {
      rect(cx - lw - 1, ly, cx + lw + 1, ly + 1, pants);
      rect(cx + 1, ly, cx + lw + 1, ly + 1, pd);
      rect(cx - lw, ly + 2, cx - 1, H - 1, pants); rect(cx + 1, ly + 2, cx + lw, H - 1, pd);
      rect(cx - lw - 1, H, cx - 1, H, P.d0); rect(cx + 1, H, cx + lw + 1, H, P.d0);
    }
  }
  S.outline(P.ink);
  return S;
}

// A stack of split logs seen end-on, the bark running back into the scene.
export function woodpile(r, seed) {
  const cols = [[-2, 0], [0, 0], [2, 0], [-1, 1], [1, 1], [0, 2]];
  const len = r * 3, W = Math.ceil(r * 7 + len * 1.2), H = Math.ceil(r * 5.5 + len * 0.7), S = new Spr(W, H, Math.round(r * 3.5), H - 1);
  const ends = cols.map(([c, row]) => [S.ax + c * r * 1.05, H - 1 - r - row * r * 1.75]);
  for (const [ex, ey] of ends)
    for (let k = len; k >= 0; k--) {
      const ox = ex + k * 1.0, oy = ey - k * 0.5;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + 0.5) S.set(ox + dx, oy + dy, dy < -r * 0.4 ? P.d3 : dy > r * 0.4 ? P.d0 : h2(Math.round(ox + dx), Math.round(oy + dy), seed) < 0.3 ? P.d1 : P.d2);
    }
  for (const [ex, ey] of ends)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r + 0.3) continue;
        S.set(ex + dx, ey + dy, d > r - 0.7 ? P.d1 : d < r * 0.35 ? P.d3 : dx + dy < 0 ? P.d5 : P.d4);
      }
  S.outline(P.ink, true);
  return S;
}

// Flames: tongues banded from a white-yellow core out to dark red, with sparks above.
export function flames(hpx, seed) {
  const h = Math.max(4, Math.round(hpx)), w = Math.max(3, Math.round(h * 0.8)), S = new Spr(w + 4, h + 6, (w + 4) >> 1, h + 5), cx = S.ax + 0.5;
  const tongues = [[0, 1], [-0.3, 0.7], [0.32, 0.75], [-0.15, 0.55], [0.18, 0.5]];
  for (const [ox, sc] of tongues) {
    const th = h * sc * (0.85 + 0.3 * h2(ox * 10, seed)), tw = w * 0.42 * (0.7 + sc * 0.4), bx = cx + ox * w;
    for (let y = 0; y < th; y++) {
      const t = y / th, half = tw * Math.pow(Math.sin(Math.PI * Math.min(1, 0.25 + t * 0.85)), 0.8) * (1 - t * 0.55);
      const lean = Math.sin(t * 3 + seed) * t * 1.2;
      for (let x = Math.floor(bx - half + lean); x <= Math.ceil(bx + half + lean); x++) {
        const d = Math.abs(x + 0.5 - bx - lean) / Math.max(0.6, half);
        if (d > 1) continue;
        const heat = (1 - d) * 1.4 + (1 - t) * 1.6 + (h2(x, y, seed) - 0.5) * 0.6;
        S.set(x, S.ay - 1 - y, heat > 2.4 ? P.f4 : heat > 1.8 ? P.f3 : heat > 1.1 ? P.f2 : heat > 0.6 ? P.f1 : P.f0);
      }
    }
  }
  for (let k = 0; k < 5; k++) S.set(cx + (h2(k, seed, 8) - 0.5) * w * 1.4, S.ay - h - 1 - h2(k, seed, 9) * 4, h2(k, seed, 10) < 0.5 ? P.f3 : P.f4);
  return S;
}
