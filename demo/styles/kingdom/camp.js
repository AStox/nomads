// Camp sprites: tents, people, the fire, the woodpile and torches, all in material codes like sprites.js.
import { Spr, rng, h2 } from "./sprites.js";

// Tents are canvas (1..5), poles (6..8), the dark doorway (9) and a painted band (10). `toward` is +1 when the fire
// is to the right, so the fire side of the canvas is brighter.
export function tent(kind, w, h, toward, seed) {
  const r = rng(seed), top = kind === 1 ? Math.round(h * 0.16) : Math.round(h * 0.08);
  const S = new Spr(w + 2, h + top, (w + 1) / 2, h + top - 1), cx = (w + 1) / 2, base = h + top - 1;
  const face = (x, y, edge) => {
    const side = Math.sign(x - cx) === toward ? 1 : -1, seam = h2(x, y >> 2, seed) < 0.08;
    let v = side > 0 ? 3 : 2;
    if (edge) v = side > 0 ? 5 : 1;
    if (seam) v -= 1;
    if (y > base - 2) v = Math.min(v, 2);
    return Math.max(1, v);
  };
  if (kind === 1) {
    // Tall cone with its poles sticking out of the smoke hole.
    const apex = top;
    for (let y = apex; y <= base; y++) {
      const t = (y - apex) / (base - apex), hw = 1 + t * (w / 2 - 1);
      for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) S.set(x, y, face(x, y, Math.abs(x - cx) > hw - 1));
      const b = Math.round((base - apex) * 0.55) + apex;
      if (y >= b && y < b + Math.max(1, Math.round(h * 0.08))) for (let x = Math.ceil(cx - hw) + 1; x < cx + hw; x++) S.set(x, y, h2(x >> 1, 0, seed) < 0.5 ? 10 : 9);
    }
    for (const s of [-1, 1, -0.4]) for (let k = 0; k <= top + 1; k++) S.set(Math.round(cx + s * (top + 1 - k) * 0.7), k, k === 0 ? 8 : 7);
    const dw = Math.max(1, Math.round(w * 0.14)), dx = Math.round(cx + toward * w * 0.12);
    for (let y = base - Math.round(h * 0.38); y <= base; y++) for (let x = dx - dw; x <= dx + dw; x++) {
      const t = (y - (base - h * 0.38)) / (h * 0.38);
      if (Math.abs(x - dx) <= dw * t + 0.3) S.set(x, y, 9);
    }
  } else if (kind === 0) {
    // A-frame seen from its open end: a triangle with a door and crossed poles at the ridge.
    const apex = top;
    for (let y = apex; y <= base; y++) {
      const t = (y - apex) / (base - apex), hw = 0.5 + t * (w / 2);
      for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) S.set(x, y, face(x, y, Math.abs(x - cx) > hw - 1));
    }
    const dh = Math.round(h * 0.62);
    for (let y = base - dh; y <= base; y++) {
      const t = (y - (base - dh)) / dh, hw = t * w * 0.2;
      for (let x = Math.ceil(cx - hw); x <= Math.floor(cx + hw); x++) S.set(x, y, 9);
      const fx = Math.round(cx + toward * (hw + 1));
      if (t > 0.3) S.set(fx, y, 4);
    }
    for (const s of [-1, 1]) for (let k = 0; k < top + 2; k++) S.set(Math.round(cx + s * (top + 1 - k) * 0.8), k, 7);
  } else {
    // Low ridge tent from the side: sagging ridge, sloped ends, a rolled-up flap.
    const ridge = top + 1;
    for (let x = 1; x <= w; x++) {
      const t = (x - 1) / (w - 1), end = Math.min(t, 1 - t), sag = Math.sin(t * Math.PI) * h * 0.08;
      const yTop = Math.round(ridge + sag + Math.max(0, 0.22 - end) * h * 3.2);
      for (let y = yTop; y <= base; y++) {
        let v = y < yTop + 2 ? 4 : (y - yTop) / (base - yTop) < 0.5 ? 3 : 2;
        if (x === 1 || x === w) v = 1;
        if (h2(x >> 2, 1, seed) < 0.2 && y > yTop + 1) v -= 1;
        S.set(x, y, Math.max(1, v));
      }
      if (x === Math.round(w * 0.3) || x === Math.round(w * 0.7)) for (let y = ridge - top; y < yTop; y++) S.set(x, y, 7);
    }
    const fx = Math.round(cx + toward * w * 0.18), fw = Math.max(1, Math.round(w * 0.1));
    for (let y = ridge + Math.round(h * 0.3); y <= base; y++) for (let x = fx - fw; x <= fx + fw; x++) S.set(x, y, 9);
    for (let x = fx - fw - 1; x <= fx + fw + 1; x++) S.set(x, ridge + Math.round(h * 0.3) - 1, 5);
  }
  // Guy ropes and pegs.
  for (const s of [-1, 1]) S.set(Math.round(cx + s * (w / 2 + 1)), base, 6);
  return S;
}

// People, drawn from hand-made pixel templates facing right (mirror for left): clothing 1..5, skin 6..7, hair 8,
// trousers 9, eyes and boots 10, a staff 11.
const BIG = {
  stand: ["...hhh...", "..hhhhhh.", "..hhhsss.", "..hhsses.", "..hhssss.", "...hhSs..", "...dccC..", "..ddccCC.", "..ddccCC.", "..ddccCC.", "..dbbbbC.", "..ddccCs.", ".dddcccC.", ".dddcccC.", "...pp.p..", "...pp.p..", "...pp.pp.", "..kkk.kkk"],
  sit: ["...hhh....", "..hhhhhh..", "..hhhsss..", "..hhsses..", "..hhssss..", "...hhSs...", "...dccC...", "..ddccCC..", "..ddccCCs.", "..ddccCC..", "..dbbbbC..", "..dpppppp.", "..ppppppp.", ".......pp.", "......kkk."],
  crouch: [".....hhh..", "....hhhhhh", "....hhhsss", "....hhsses", "....hhssss", ".....hSs..", "...ddccC..", "..dddccCC.", "..dddccCCs", "..ddccCC..", "..dbbbbC..", "..dppppp..", "..pp..pp..", ".kkk..kkk."],
  staff: ["...hhh...w", "..hhhhhh.w", "..hhhsss.w", "..hhsses.w", "..hhssss.w", "...hhSs..w", "...dccC..w", "..ddccCCsw", "..ddccCC.w", "..ddccCC.w", "..dbbbbC.w", "..ddccCC.w", ".dddcccC.w", ".dddcccC.w", "...pp.p..w", "...pp.p..w", "...pp.pp.w", "..kkk.kkkw"],
};
const MID = {
  stand: ["..hh..", ".hhhs.", ".hhse.", "..hs..", "..cC..", ".dcCC.", ".dcCs.", ".dcCC.", "..pp..", "..p.p.", ".kk.kk"],
  sit: ["..hh...", ".hhhs..", ".hhse..", "..hs...", ".dcCs..", ".dcCC..", ".dpppp.", ".....k."],
  crouch: ["...hh..", "..hhhs.", "..hhse.", ".dcCs..", ".dcCCs.", ".dcCC..", ".dppp..", ".kk.kk."],
  staff: ["..hh..w", ".hhhs.w", ".hhse.w", "..hs..w", "..cC..w", ".dcCCsw", ".dcC..w", ".dcCC.w", "..pp..w", "..p.p.w", ".kk.kkw"],
};
const SMALL = {
  stand: [".hh.", ".hs.", ".cC.", "dcCs", ".cC.", ".p.p", ".p.p"],
  sit: [".hh..", ".hs..", ".cCs.", ".cppp", "...p."],
  crouch: ["..hh.", "..hs.", ".ccCs", ".cpp.", ".p.p."],
  staff: [".hh.w", ".hs.w", ".cCsw", "dcC.w", ".cC.w", ".p.pw", ".p.pw"],
};
const CODE = { ".": 0, h: 8, s: 7, S: 6, e: 10, D: 1, d: 2, c: 3, C: 4, L: 5, b: 1, p: 9, k: 10, w: 11 };
const POSES = ["stand", "sit", "crouch", "staff"];
export function person(H, pose, seed) {
  const rows = (H >= 13 ? BIG : H >= 8 ? MID : SMALL)[POSES[pose]], r = rng(seed * 977 + pose);
  const hood = r() < 0.4, long = r() < 0.5, w = rows[0].length, S = new Spr(w + 1, rows.length, Math.floor(w / 2), rows.length - 1);
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    let v = CODE[ch];
    if (ch === "h" && hood) v = y === 0 || x < 4 ? 2 : 3;
    if (v) S.set(x + 1, y, v);
  }));
  if (long && !hood && H >= 12) for (let y = 3; y < 7; y++) S.set(2, y, 8);
  return S;
}
export function seat(w, h) {
  const S = new Spr(w, h, Math.floor(w / 2), h - 1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) S.set(x, y, x === w - 1 ? 8 : y === 0 ? 8 : y === h - 1 ? 6 : 7);
  return S;
}

// Fire: stones (9, 10), logs (6..8) and flames 1..5 from ember red to white-hot.
export function fire(w, hFlame, seed) {
  const r = rng(seed), hs = Math.max(1, Math.round(w * 0.16)), H = hFlame + hs + 1, S = new Spr(w, H, (w - 1) / 2, H - 1);
  const cx = (w - 1) / 2, base = H - 1;
  for (let x = 0; x < w; x++) {
    const t = Math.abs(x - cx) / (w / 2);
    const tongue = Math.pow(Math.max(0, 1 - t * 1.25), 0.8) * (0.55 + 0.45 * Math.abs(Math.sin(x * 1.7 + r() * 6))) * (0.75 + r() * 0.35);
    const fh = Math.round(hFlame * tongue);
    for (let k = 0; k < fh; k++) {
      const q = k / Math.max(1, fh), core = 1 - t * 1.6 - q * 0.9;
      S.set(x, base - hs - k, core > 0.45 ? 5 : core > 0.1 ? 4 : q > 0.8 ? 2 : 3);
    }
  }
  // A few detached flame licks and sparks.
  for (let k = 0; k < Math.max(1, Math.round(hFlame / 3)); k++) S.set(Math.round(cx + (r() - 0.5) * w * 0.5), Math.round(base - hs - hFlame * (0.9 + r() * 0.3)), r() < 0.5 ? 4 : 3);
  for (let x = 1; x < w - 1; x++) S.set(x, base - hs, S.get(x, base - hs) ? 4 : 1);
  for (let x = Math.round(w * 0.15); x < w * 0.85; x++) S.set(x, base - hs + 1, x % 3 === 0 ? 8 : 6);
  for (let x = 0; x < w; x++) for (let y = base - hs + 1; y <= base; y++) if (x < hs || x >= w - hs || y === base) S.set(x, y, (x + y) % 3 === 0 ? 10 : 9);
  return S;
}

export function woodpile(w, seed) {
  const r = rng(seed), rad = Math.max(1, Math.round(w / 10)), rows = 4, H = rows * rad * 2 + 1, S = new Spr(w, H, (w - 1) / 2, H - 1);
  for (let row = 0; row < rows; row++) {
    const y = H - 1 - rad - row * rad * 2, inset = row * rad, n = Math.floor((w - inset * 2) / (rad * 2));
    for (let k = 0; k < n; k++) {
      const x = inset + rad + k * rad * 2 + (row % 2 ? 0 : 0), jitter = r() < 0.3 ? 1 : 0;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const q = (dx * dx + dy * dy) / (rad * rad + 0.5);
        if (q > 1.05) continue;
        S.set(x + dx, y + dy - jitter, q > 0.6 ? (dx + dy < 0 ? 7 : 6) : q > 0.22 ? 3 : dx - dy > 0 ? 5 : 4);
      }
    }
  }
  return S;
}

// Torch on a pole: flame 1..5, pole 6..8, cloth wrap 9.
export function torch(H, seed) {
  const r = rng(seed), w = Math.max(3, Math.round(H * 0.28)) | 1, S = new Spr(w, H, (w - 1) / 2, H - 1), cx = (w - 1) / 2;
  const fh = Math.max(2, Math.round(H * 0.22));
  for (let y = fh + 1; y < H; y++) S.set(cx, y, y === fh + 1 || y === fh + 2 ? 9 : y % 5 === 0 ? 8 : 7);
  if (H > 12) S.set(cx + 1, fh + 1, 9);
  for (let k = 0; k <= fh; k++) {
    const t = k / fh, hw = (1 - t) * (w / 2) * (0.8 + r() * 0.3);
    for (let x = 0; x < w; x++) if (Math.abs(x - cx) <= hw) S.set(x, fh - k, t < 0.35 && Math.abs(x - cx) < hw * 0.6 ? 5 : t < 0.7 ? 4 : 3);
  }
  return S;
}

// A cooking pot hung from a tripod over the fire: wood 6..8, iron 1..3.
export function tripod(w, h) {
  const S = new Spr(w, h, (w - 1) / 2, h - 1), cx = (w - 1) / 2;
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1);
    S.set(Math.round(cx - t * (w / 2 - 0.5)), y, 6);
    S.set(Math.round(cx + t * (w / 2 - 0.5)), y, 7);
  }
  const py = Math.round(h * 0.45), pr = Math.max(1, Math.round(w * 0.16));
  for (let y = 1; y < py; y++) S.set(cx, y, 1);
  for (let y = py; y <= py + pr * 2; y++) for (let x = Math.round(cx - pr); x <= Math.round(cx + pr); x++) S.set(x, y, x > cx ? 3 : y === py ? 3 : 2);
  return S;
}
