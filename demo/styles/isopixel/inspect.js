// The inspector: a bevelled window in the manner of a 1990s sim showing one selected thing's real data, with an icon
// of its sprite, bars for hp and needs, and a scrolling list of rows. Drawn in palette indices into a px.js Buf.
import { P, ramp } from "./pal.js";
import { Buf, dith, h2 } from "./px.js";
import { text } from "./ui.js";
import * as SP from "./sprites.js";
import * as TH from "./things.js";

// Glyphs the ui.js font lacks, in the same 5x7 rows; everything else goes through ui.js text().
const EXTRA = Object.fromEntries(Object.entries({
  "%": "11001 11010 00010 00100 01000 01011 10011", "(": "00010 00100 01000 01000 01000 00100 00010",
  ")": "01000 00100 00010 00010 00010 00100 01000", "'": "00100 00100 01000 00000 00000 00000 00000",
  '"': "01010 01010 10100 00000 00000 00000 00000", "+": "00000 00100 00100 11111 00100 00100 00000",
  "?": "01110 10001 00001 00110 00100 00000 00100", "!": "00100 00100 00100 00100 00100 00000 00100",
  "=": "00000 00000 11111 00000 11111 00000 00000", "<": "00010 00100 01000 10000 01000 00100 00010",
  ">": "01000 00100 00010 00001 00010 00100 01000", "_": "00000 00000 00000 00000 00000 00000 11111",
  "#": "01010 01010 11111 01010 11111 01010 01010", "*": "00000 10101 01110 11111 01110 10101 00000",
  "&": "01100 10010 10100 01000 10101 10010 01101", ";": "00000 01100 01100 00000 01100 00100 01000",
  "[": "01110 01000 01000 01000 01000 01000 01110", "]": "01110 00010 00010 00010 00010 00010 01110",
  "~": "00000 00000 01000 10101 00010 00000 00000", "°": "01100 10010 10010 01100 00000 00000 00000",
  "|": "00100 00100 00100 00100 00100 00100 00100", "@": "01110 10001 10111 10101 10111 10000 01110",
}).map(([k, v]) => [k, v.split(" ").map((r) => parseInt(r, 2))]));
const adv = (ch) => (ch === " " ? 4 : 6);
const width = (s) => [...s].reduce((a, ch) => a + adv(ch), 0);
function say(B, s, x, y, c) {
  for (const ch of String(s)) {
    const g = EXTRA[ch];
    if (g) g.forEach((row, j) => { for (let i = 0; i < 5; i++) if (row & (16 >> i)) put(B, x + i, y + j, c); });
    else text(B, ch, x, y, c);
    x += adv(ch);
  }
  return x;
}
function put(B, x, y, c) { if (x >= 0 && y >= 0 && x < B.w && y < B.h) B.c[y * B.w + x] = c; }
function fill(B, x0, y0, x1, y1, c) { for (let y = Math.max(0, y0); y <= Math.min(B.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(B.w - 1, x1); x++) B.c[y * B.w + x] = c; }
function bevel(B, x0, y0, x1, y1, sunk, face = sunk ? P.r3 : P.r4) {
  fill(B, x0, y0, x1, y1, face);
  fill(B, x0, y0, x1, y0, sunk ? P.r1 : P.r5); fill(B, x0, y0, x0, y1, sunk ? P.r1 : P.r5);
  fill(B, x0, y1, x1, y1, sunk ? P.r5 : P.r1); fill(B, x1, y0, x1, y1, sunk ? P.r5 : P.r1);
}
// Fit a string into a width, ending in ".." when it has to be cut.
function clip(s, w) {
  s = String(s);
  if (width(s) <= w) return s;
  while (s.length && width(s + "..") > w) s = s.slice(0, -1);
  return s.trimEnd() + "..";
}
// Break a string into lines at spaces, cutting any word that is still too long.
function wrap(s, w) {
  const out = [];
  let line = "";
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + word : word;
    if (width(next) <= w) { line = next; continue; }
    if (line) out.push(line);
    line = width(word) <= w ? word : clip(word, w);
  }
  if (line || !out.length) out.push(line);
  return out;
}
const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) || Math.abs(v) >= 100 ? String(Math.round(v)) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/0$/, "")) : v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

// ------------------------------------------------------------------------------------------------------ icon

const BIRDS = new Set(["gull", "crow", "eagle"]);
const field = (d, ...names) => {
  for (const n of names) {
    if (d[n] != null) return d[n];
    const r = d.rows?.find(([l]) => String(l).toLowerCase() === n) ?? d.bars?.find(([l]) => String(l).toLowerCase() === n);
    if (r) return r[1];
  }
  return undefined;
};
// The portrait draws what the map draws, so its sprite choice and variation copy live.js and main.js exactly:
// agents and animals vary by a hash of their id, things by their sim seed.
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const AGENT_CLOTH = ["#9e3b2f", "#2f4a6d", "#a8812a", "#4e6b3a", "#6b3f5e"];
const clothOf = (color) => { const k = AGENT_CLOTH.indexOf(String(color).toLowerCase()); return P["c" + (k >= 0 ? k : strHash(String(color)) % 5)]; };
const TIERS = ["pile", "lean-to", "hut", "cabin"];
const yes = (v) => v != null && v !== false && v !== 0 && v !== "no" && v !== "";
const mirrored = (S) => {
  const T = { ...S, p: new Uint8Array(S.p.length), ax: S.w - 1 - S.ax };
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) T.p[y * S.w + S.w - 1 - x] = S.p[y * S.w + x];
  return T;
};
// A sprite standing for the selection, drawn at about close zoom so it fills the icon slot.
export function iconSprite(d) {
  const kind = String(d.kind ?? "").toLowerCase(), sp = String(d.species ?? "").toLowerCase(), id = String(d.id ?? "");
  const seed = (d.seed ?? strHash(id)) >>> 0, vr = seed % 8, obj = vr * 131 + 7, flip = ((seed >>> 3) & 1) === 1;
  if (kind === "agent" || kind === "person") {
    const st = String(d.state ?? field(d, "stage") ?? "adult").toLowerCase(), stage = /child|elder/.test(st) ? st.match(/child|elder/)[0] : "adult";
    const cloth = d.color != null ? clothOf(d.color) : P["c" + ((d.colorIndex ?? 0) % 5)];
    return TH.walker(28, cloth, "front", 0, "none", stage, strHash(id) % 997);
  }
  if (kind === "animal") {
    const state = String(d.state ?? field(d, "doing") ?? "wander").replaceAll(" ", "_"), fly = BIRDS.has(sp) || sp === "butterfly";
    const px = sp === "wolf" ? 12 : sp === "fish" ? 10 : sp === "butterfly" ? 5 : BIRDS.has(sp) ? 16 : sp === "rabbit" ? 12 : 18;
    return TH.animal(sp, state, px, fly ? 1 : 0, strHash(id) % 8, 1);
  }
  if (kind === "tree") {
    const tint = ((seed >>> 8) & 255) / 255, S = sp === "pine" ? SP.pine(34, vr * 17 + 34) : SP.broad(32, sp || "oak", vr * 31 + 32, tint);
    return flip ? mirrored(S) : S;
  }
  // everything else goes through object() with the map's seed and the same look-changing fields
  const o = { species: sp || undefined, dir: (seed >>> 5) & 7 };
  const n = field(d, "n", "berries", "count"), grown = field(d, "stage", "grown");
  if (n != null) o.n = Number(n);
  if (grown != null) o.stage = Number(grown);
  let px = 12;
  switch (kind) {
    case "structure": case "shelter": {
      const t = d.tier ?? field(d, "tier") ?? TIERS.indexOf(String(d.name ?? "").toLowerCase());
      o.tier = Number(t) >= 0 ? Number(t) : 1;
      o.species = String(d.style ?? field(d, "style") ?? (sp || "sticks")).toLowerCase();
      px = [10, 18, 24, 34][o.tier] ?? 24;
      break;
    }
    case "item": o.species = String(d.item ?? d.species ?? d.name ?? "").toLowerCase().replaceAll(" ", "_"); px = 9; break;
    case "fire": {
      o.contained = yes(field(d, "contained", "ringed")); o.covered = yes(field(d, "covered")); o.charcoal = yes(field(d, "charcoal"));
      // a fire thing only exists while it burns; its own burning field is for things caught alight
      o.burning = 1; px = 16; break;
    }
    case "trap": o.caught = yes(field(d, "caught")); px = 16; break;
    case "pit": px = 12; break;
    case "well": px = 18; break;
    case "grave": px = 14; break;
    case "grass": px = 22; break;
    case "stick": px = 22; break;
    case "log": case "fallen_log": px = 40; o.dir = 1; break;
    case "boulder": px = 16; break;
    case "stone": px = 7; break;
    case "pebble": px = 5; break;
    case "mushroom": px = 5; break;
    case "herb": case "flower": case "flowers": case "fern": px = 9; break;
    case "reeds": case "sapling": px = 16; break;
    case "bush": case "dead_bush": px = 12; break;
    case "stump": case "burnt_stump": px = 12; break;
    case "clay": case "ash": px = 9; break;
  }
  if (kind !== "fire") o.burning = Number(d.burning ?? 0);
  let S;
  try { S = TH.object(kind, px, obj, o); } catch { return null; }
  return S && !["structure", "shelter", "trap", "well", "grave", "item", "fire", "log", "fallen_log"].includes(kind) && flip ? mirrored(S) : S;
}
// A square of ground in its cover's colours, standing for a picked point of bare terrain.
function groundTile(B, x0, y0, w, h, d) {
  // the point's own class (the shared groundClass, else the inspector's name for it), never the 150 m tile's
  const cls = String(d.groundClass ?? d.name ?? field(d, "tile") ?? "grassland").toLowerCase();
  const R = /deep/.test(cls) ? ramp("w1", "w2", "w3", "w4") : /water|sea|lake/.test(cls) ? ramp("w3", "w4", "w5", "w6") : /stream|river/.test(cls) ? ramp("r2", "w4", "w5", "r4")
    : /rock|stone|cliff|scree/.test(cls) ? ramp("r1", "r2", "r3", "r4") : /sand|beach/.test(cls) ? ramp("s0", "s1", "s2", "s3")
      : /marsh|bog|wet/.test(cls) ? ramp("m0", "m1", "m2", "m3") : /snow|ice/.test(cls) ? ramp("r4", "r5", "snow")
        : /forest|wood/.test(cls) ? ramp("t1", "t2", "g2", "g3") : /scrub|heath/.test(cls) ? ramp("m1", "m2", "g3", "a1") : ramp("g2", "g3", "g4", "g5");
  const cx = x0 + w / 2, cy = y0 + h / 2 + 2, hw = w * 0.42, hh = hw / 2;
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const e = Math.abs(x + 0.5 - cx) / hw + Math.abs(y + 0.5 - cy) / hh;
      if (e <= 1) put(B, x, y, dith(R, 1.4 + (0.5 - (y - cy + hh) / (2 * hh)) + (h2(x >> 1, y, 7) - 0.5) * 0.9, x, y));
      else if (e <= 1 + 1.4 / hh && y > cy) put(B, x, y + 1, R[0]);
    }
  // a pin at the picked point
  for (let j = 0; j < 7; j++) put(B, Math.round(cx), Math.round(cy) - j, j > 4 ? P.red : P.ink);
  put(B, Math.round(cx) - 1, Math.round(cy) - 6, P.red); put(B, Math.round(cx) + 1, Math.round(cy) - 6, P.red); put(B, Math.round(cx), Math.round(cy) - 7, P.red);
}
// The slot's backdrop: open sky for things in flight, water for swimmers and waders, a patch of meadow otherwise,
// so grey rock and pale birds keep their contrast.
// Only an animal actually in the air hangs in the sky; a bird feeding, perching or landing stands on the ground.
function airborne(d) {
  const sp = String(d.species ?? "").toLowerCase(), st = String(d.state ?? field(d, "doing") ?? "").toLowerCase();
  if (!(BIRDS.has(sp) || sp === "butterfly" || sp === "heron" || sp === "egret")) return false;
  if (/fly|soar|dive|flutter/.test(st)) return true;
  if (/perch|rest|sit|feed|eat|land|wade|graze|wander|trapped/.test(st)) return false;
  return Number(d.alt ?? 0) > 0.5;
}
function backdrop(B, x0, y0, w, h, d) {
  const sp = String(d.species ?? "").toLowerCase();
  const sky = airborne(d), wet = !sky && (sp === "fish" || sp === "heron" || sp === "egret");
  const hz = sky ? h : Math.round(h * 0.55);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const t = (y - y0) / h;
      if (y - y0 < hz) put(B, x, y, dith(ramp("w5", "w6", "haze2"), 2.2 - t * 1.6, x, y));
      else put(B, x, y, wet ? dith(ramp("w2", "w3", "w4"), 1.2 + (h2(x >> 1, y, 3) - 0.5), x, y) : dith(ramp("g2", "g3", "g4"), 0.8 + t + (h2(x, y, 4) - 0.5) * 0.7, x, y));
    }
}
// Paint a sprite into the slot, scaled up by a whole number so it fills it, standing on the slot's floor.
function paintSprite(B, S, x0, y0, w, h, inAir = false) {
  let x1 = S.w, x2 = -1, y1 = S.h, y2 = -1;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) if (S.p[y * S.w + x] !== 255) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  if (x2 < 0) return;
  const bw = x2 - x1 + 1, bh = y2 - y1 + 1, k = Math.max(1, Math.min(Math.floor((w - 2) / bw), Math.floor((h - 2) / bh), 4));
  // fliers hang in the sky, everything else stands a little way into the ground
  const ox = x0 + Math.floor((w - bw * k) / 2), oy = inAir ? y0 + Math.floor((h * 0.5 - bh * k) / 2) + 2 : y0 + h - 4 - bh * k;
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++) {
      const c = S.p[y * S.w + x];
      if (c !== 255) fill(B, ox + (x - x1) * k, oy + (y - y1) * k, ox + (x - x1) * k + k - 1, oy + (y - y1) * k + k - 1, c);
    }
}

// ------------------------------------------------------------------------------------------------------ bars

const NEED = { food: ramp("f0", "f2", "f3"), hunger: ramp("f0", "f2", "f3"), energy: ramp("a0", "a2", "a3"), rest: ramp("a0", "a2", "a3"), warmth: ramp("f0", "f1", "f2"), social: ramp("d0", "violet", "k0"), thirst: ramp("w2", "w4", "w6"), water: ramp("w2", "w4", "w6") };
function barRamp(label, f) {
  const l = String(label).toLowerCase();
  for (const k in NEED) if (l.includes(k)) return NEED[k];
  return f > 0.6 ? ramp("g2", "g4", "g6") : f > 0.3 ? ramp("a0", "a2", "a3") : ramp("f0", "red", "k0");
}
function bar(B, x0, y, x1, label, value, max) {
  const f = Math.max(0, Math.min(1, max > 0 ? value / max : 0)), R = barRamp(label, f), n = Math.round((x1 - x0 - 1) * f);
  bevel(B, x0, y, x1, y + 6, true, P.r1);
  for (let x = 1; x <= n; x++) { put(B, x0 + x, y + 1, R[2]); for (let j = 2; j <= 4; j++) put(B, x0 + x, y + j, R[1]); put(B, x0 + x, y + 5, R[0]); }
  // quarter ticks so a value can be judged without its number
  for (const q of [0.25, 0.5, 0.75]) { const x = x0 + Math.round((x1 - x0) * q); put(B, x, y + 5, P.r0); }
}

// ------------------------------------------------------------------------------------------------------ panel

const ROW = 9, PAD = 4, SLOT = 42;
// data: { id, kind, name, species?, px, py, rows: [label, value][], bars: [label, value, max][] }, as sim.inspect and
// sim.inspectGround return; a row with a null or empty value is a section heading. opts: w, h (art px), scroll (px
// into the row list), sprite (an optional Spr for the icon slot). Returns a Buf filled edge to edge, with
// `scroll` clamped and `scrollMax`, `listY`, `listH` set so a caller can scroll with the wheel.
export function drawInspector(data = {}, { w = 184, h = 232, scroll = 0, sprite } = {}) {
  const B = new Buf(w, h), d = data ?? {};
  B.c.fill(P.ink);
  bevel(B, 1, 1, w - 2, h - 2, false);
  // title bar
  fill(B, 3, 3, w - 4, 13, P.w2);
  fill(B, 3, 3, w - 4, 3, P.w4);
  fill(B, 3, 13, w - 4, 13, P.w1);
  say(B, clip(d.name ?? d.kind ?? "Nothing", w - 12), 6, 5, P.snow);
  // icon slot and the facts beside it
  const sy = 16;
  bevel(B, PAD, sy, PAD + SLOT - 1, sy + SLOT - 1, true, P.r5);
  const inner = [PAD + 1, sy + 1, SLOT - 2, SLOT - 2];
  if (String(d.kind).toLowerCase() === "ground") groundTile(B, ...inner, d);
  else {
    let S = sprite;
    try { S ??= iconSprite(d); } catch { S = null; }
    if (S) { backdrop(B, ...inner, d); paintSprite(B, S, ...inner, airborne(d)); }
    else say(B, "?", PAD + SLOT / 2 - 2, sy + SLOT / 2 - 3, P.r2);
  }
  const tx = PAD + SLOT + 5, tw = w - tx - PAD - 1;
  const kind = [d.kind, d.species].filter((v) => v != null && v !== "").map((v) => String(v).replaceAll("_", " ")).join("  ");
  const facts = [[kind, P.ink]];
  if (d.px != null) facts.push([`AT ${fmt(Number(d.px))} ${fmt(Number(d.py))}`, P.r1]);
  if (d.id != null && String(d.kind).toLowerCase() !== "ground") facts.push([`ID ${d.id}`, P.r1]);
  facts.forEach(([s, c], i) => say(B, clip(s, tw), tx, sy + 2 + i * ROW, c));
  // bars
  let y = sy + SLOT + 3;
  const bars = d.bars ?? [];
  for (const [label, value, max] of bars) {
    const v = Number(value) || 0, m = Number(max) || 100, num = `${fmt(v)}/${fmt(m)}`, lw = 44, nw = width(num);
    say(B, clip(String(label), lw - 2), PAD + 1, y, P.ink);
    bar(B, PAD + lw, y, w - PAD - 3 - Math.max(nw, 30), label, v, m);
    say(B, num, w - PAD - 1 - nw, y, P.ink);
    y += ROW;
  }
  if (bars.length) y += 1;
  // the row list, laid out once at full height, then shown through a window
  const lx = PAD, ly = y, lh = h - PAD - 1 - ly, lw = w - 2 * PAD;
  B.listY = ly; B.listH = lh;
  if (lh < ROW + 2) { B.scroll = 0; B.scrollMax = 0; return B; }
  const lines = [], full = lw - 4;
  const lay = (lineW) => {
    lines.length = 0;
    let n = 0;
    for (const [label, value] of d.rows ?? []) {
      const v = fmt(value), l = String(label);
      if (v === "") { lines.push({ head: l }); n = 0; continue; }
      const odd = n++ & 1;
      if (width(l) + 8 + width(v) <= lineW) { lines.push({ l, v, odd }); continue; }
      lines.push({ l: clip(l, lineW), odd });
      for (const p of wrap(v, lineW - 8)) lines.push({ v: p, indent: true, odd });
    }
  };
  lay(full);
  let content = lines.length * ROW + 3, bar_ = content > lh - 2;
  if (bar_) { lay(full - 8); content = lines.length * ROW + 3; }
  const maxS = Math.max(0, content - (lh - 2)), s = Math.max(0, Math.min(maxS, Math.round(scroll)));
  B.scroll = s; B.scrollMax = maxS;
  const L = new Buf(lw - 2 - (bar_ ? 8 : 0), Math.max(1, content));
  L.c.fill(P.r5);
  lines.forEach((ln, i) => {
    const yy = 2 + i * ROW;
    if (ln.odd) fill(L, 0, yy - 1, L.w - 1, yy + 7, P.s3);
    if (ln.head) { say(L, clip(ln.head, L.w - 4), 2, yy, P.w2); fill(L, 2, yy + 8, L.w - 3, yy + 8, P.w5); return; }
    if (ln.l) say(L, ln.l, 2, yy, P.d2);
    if (ln.v != null) say(L, ln.v, Math.max(ln.indent ? 10 : 2, L.w - 2 - width(ln.v)), yy, P.ink);
  });
  bevel(B, lx, ly, lx + lw - 1, ly + lh - 1, true, P.r5);
  for (let j = 0; j < lh - 2; j++) {
    const src = s + j;
    if (src >= L.h) break;
    B.c.set(L.c.subarray(src * L.w, src * L.w + L.w), (ly + 1 + j) * w + lx + 1);
  }
  if (!lines.length) say(B, "NOTHING TO SHOW", lx + 4, ly + 3, P.r2);
  if (bar_) {
    // scrollbar: a sunken track with a raised thumb sized to the visible share
    const bx0 = lx + lw - 9, by0 = ly + 1, bh = lh - 2;
    bevel(B, bx0, by0, bx0 + 7, by0 + bh - 1, true);
    const th = Math.max(8, Math.round((bh * (lh - 2)) / content)), ty = by0 + Math.round(((bh - th) * s) / Math.max(1, maxS));
    bevel(B, bx0 + 1, ty, bx0 + 6, ty + th - 1, false);
    for (let k = -1; k <= 1; k++) fill(B, bx0 + 2, ty + (th >> 1) + k * 2, bx0 + 5, ty + (th >> 1) + k * 2, P.r2);
  }
  return B;
}
