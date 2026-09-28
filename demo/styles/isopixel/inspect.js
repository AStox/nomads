// The inspector: a bevelled window in the manner of a 1990s sim showing one selected thing's real data, with an icon
// of its sprite, bars for hp and needs, and a scrolling list of rows. Drawn in palette indices into a px.js Buf.
import { P, ramp } from "./pal.js";
import { Buf, dith, h2 } from "./px.js";
import { text } from "./ui.js";
import * as SP from "./sprites.js";
import * as LF from "./life.js";
import * as TH from "./things.js";
import { COLORS } from "../island.js";

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
    const r = d.rows?.find(([l]) => String(l).toLowerCase() === n);
    if (r) return r[1];
  }
  return undefined;
};
// A sprite standing for the selection, drawn at about close zoom so it fills the icon slot.
export function iconSprite(d) {
  const kind = String(d.kind ?? "").toLowerCase(), sp = String(d.species ?? "").toLowerCase(), seed = (d.seed ?? h2(String(d.id).length, 3) * 1e6) | 0;
  // an agent's color is one of the sim's COLORS, which pal.js holds as c0..c4
  const ci = COLORS.findIndex((c) => String(c).toLowerCase() === String(d.color ?? "").toLowerCase());
  const cloth = P["c" + ((ci >= 0 && ci < 5 ? ci : d.cloth ?? [...String(d.id ?? "")].reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 5)];
  switch (kind) {
    case "agent": case "person": {
      const st = String(field(d, "stage") ?? d.state ?? "adult").toLowerCase();
      return st === "adult" ? SP.person(28, cloth, "front", "stand", seed, 1) : TH.walker(28, cloth, "front", 1, "none", st, seed);
    }
    case "animal":
      if (d.state != null && sp !== "deer" && sp !== "rabbit") return TH.animal(sp, String(d.state), sp === "wolf" ? 12 : sp === "fish" ? 10 : BIRDS.has(sp) ? 16 : 18, 1, seed, 1);
      if (/perch|rest|sit/.test(String(field(d, "state") ?? "")) && BIRDS.has(sp)) return TH.perched(sp, 8, seed);
      if (sp === "deer") return LF.deer(18, "stand", 1, seed);
      if (sp === "wolf") return TH.wolf(12, "stand", 0, seed);
      if (sp === "rabbit" || sp === "hare") return LF.rabbit(12, "sit", seed);
      if (sp === "heron" || sp === "egret") return LF.heron(18, "stand", seed);
      if (sp === "fish") return LF.fish(1, seed, 10);
      if (sp === "butterfly") return LF.butterfly(0, seed);
      return LF.bird(16, 1, BIRDS.has(sp) ? sp : "gull", seed);
    case "tree": return sp === "pine" ? SP.pine(34, seed) : SP.broad(32, ["oak", "ash", "aspen"].includes(sp) ? sp : "oak", seed, 0.5);
    case "stump": return SP.stump(6, 5, seed);
    case "burnt_stump": return TH.burnt(14, seed);
    case "bush": { const b = field(d, "berries", "fruit", "n"); return TH.object("bush", 12, seed, { species: sp, berries: b == null ? undefined : Number(b) > 0 }); }
    case "dead_bush": return TH.deadbush(12, seed);
    case "sapling": return TH.sapling(16, seed);
    case "stick": return TH.stick(14, seed);
    case "stone": return SP.rock(6, seed);
    case "pebble": return SP.pebble(4, seed);
    case "boulder": return SP.rock(16, seed, 0.4);
    case "reeds": return SP.reeds(14, seed);
    case "log": case "fallen_log": return TH.object("fallen_log", 30, seed, { species: sp, dir: 1 });
    case "clay": return TH.clay(7, seed);
    case "ash": return TH.ash(8, seed);
    case "pit": return TH.pit(8, 1, seed);
    case "trap": return TH.trap(16, false, seed);
    case "well": return TH.well(18, seed);
    case "grave": return TH.grave(14, seed);
    case "mushroom": return TH.object("mushroom", 5, seed, { species: sp });
    case "herb": return TH.object("herb", 8, seed, { species: sp });
    case "fern": return TH.object("fern", 9, seed, { species: sp });
    case "flower": case "flowers": return TH.object("flowers", 9, seed, { species: sp });
    case "fire": return TH.object("fire", 16, seed, { contained: !!field(d, "contained"), covered: !!field(d, "covered"), charcoal: !!field(d, "charcoal"), burning: Number(field(d, "burning") ?? 1) });
    case "item": return TH.object("item", 9, seed, { species: sp });
    case "structure": case "shelter": {
      const tier = Number(field(d, "tier") ?? 2), style = String(field(d, "style") ?? (sp || "sticks")).toLowerCase();
      return TH.shelter(tier, style, tier >= 3 ? 26 : 30, seed);
    }
  }
  return null;
}
// A square of ground in its cover's colours, standing for a picked point of bare terrain.
function groundTile(B, x0, y0, w, h, d) {
  const cls = String(field(d, "tile", "class", "tile class", "cover") ?? "grass").toLowerCase();
  const R = /water|sea|lake|river/.test(cls) ? ramp("w2", "w3", "w4", "w5") : /rock|stone|cliff/.test(cls) ? ramp("r1", "r2", "r3", "r4")
    : /sand|beach/.test(cls) ? ramp("s0", "s1", "s2", "s3") : /marsh|bog|wet/.test(cls) ? ramp("m0", "m1", "m2", "m3") : /snow|ice/.test(cls) ? ramp("r4", "r5", "snow")
      : /forest|wood/.test(cls) ? ramp("t1", "t2", "g2", "g3") : ramp("g2", "g3", "g4", "g5");
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
function backdrop(B, x0, y0, w, h, d) {
  const sp = String(d.species ?? "").toLowerCase();
  const sky = BIRDS.has(sp) || sp === "butterfly", wet = sp === "fish" || sp === "heron" || sp === "egret";
  const hz = sky ? h : Math.round(h * 0.55);
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const t = (y - y0) / h;
      if (y - y0 < hz) put(B, x, y, dith(ramp("w5", "w6", "haze2"), 2.2 - t * 1.6, x, y));
      else put(B, x, y, wet ? dith(ramp("w2", "w3", "w4"), 1.2 + (h2(x >> 1, y, 3) - 0.5), x, y) : dith(ramp("g2", "g3", "g4"), 0.8 + t + (h2(x, y, 4) - 0.5) * 0.7, x, y));
    }
}
// Paint a sprite into the slot, scaled up by a whole number so it fills it, standing on the slot's floor.
function paintSprite(B, S, x0, y0, w, h, sp = "") {
  let x1 = S.w, x2 = -1, y1 = S.h, y2 = -1;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) if (S.p[y * S.w + x] !== 255) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
  if (x2 < 0) return;
  const bw = x2 - x1 + 1, bh = y2 - y1 + 1, k = Math.max(1, Math.min(Math.floor((w - 2) / bw), Math.floor((h - 2) / bh), 4));
  // fliers hang in the sky, everything else stands a little way into the ground
  const ox = x0 + Math.floor((w - bw * k) / 2), oy = BIRDS.has(sp) || sp === "butterfly" ? y0 + Math.floor((h * 0.5 - bh * k) / 2) + 2 : y0 + h - 4 - bh * k;
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
    if (S) { backdrop(B, ...inner, d); paintSprite(B, S, ...inner, String(d.species ?? "").toLowerCase()); }
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
