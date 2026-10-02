// The inspector: a bevelled window in the manner of a 1990s sim showing one selected thing's real data, with an icon
// of its sprite, bars for hp and needs, and tabs of sections whose rows open, link and scroll (drawPanel, which the
// page's other windows use too). Drawn in palette indices into a px.js Buf.
import { P, ramp } from "./pal.js";
import { Buf, Spr, dith, h2 } from "./px.js";
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


// ------------------------------------------------------------------------------------------------------ small icons

// Items as sim.inspect's lookOf names them, 7x7 in the palette, outlined like the map's markers: the raw materials as
// themselves, a made thing by the shape its properties give it.
const ITEMS = {
  berry: [["....gg.", "...g...", ".rr.rr.", "rWrrWrr", "rrrrrrr", ".rr.rr."], { g: "g4", r: "red", W: "k0" }],
  nut: [["...d...", ".ddddd.", "ddddddd", ".lllll.", ".lllll.", "..lll.."], { d: "d2", l: "d4" }],
  mushroom: [[".rrrrr.", "rrWrrWr", "rrrrrrr", "...s...", "..sss..", "..sss.."], { r: "red", W: "snow", s: "s3" }],
  herb: [["g..g..g", ".g.g.g.", "..ggg..", "...G...", "...G...", "..G...."], { g: "g5", G: "g3" }],
  fish: [["..bbb.b", ".bbbbbb", "bibbbbb", ".lllllb", "..lll.b"], { b: "w4", l: "w6", i: "ink" }],
  meat: [["..rrr..", ".rRrrr.", ".rrrrr.", "..rrr..", "...w...", "..w.w.."], { r: "f0", R: "red", w: "snow" }],
  hide: [["d.ddd.d", "ddddddd", ".dDDDd.", ".dDDDd.", "ddddddd", "d.....d"], { d: "d3", D: "d4" }],
  bone: [["ww.....", "www....", ".www...", "..www..", "...www.", "....www", ".....ww"], { w: "r5" }],
  bone_shard: [["....w..", "...ww..", "..www..", ".www...", "ww....."], { w: "r5" }],
  stick: [["......d", ".....d.", "...ld..", "...d...", "..d....", ".d.....", "d......"], { d: "d3", l: "g4" }],
  stone: [["..sss..", ".sWsss.", "sWsssss", "sssssss", ".sssss."], { s: "r3", W: "r5" }],
  sharp_stone: [["......s", ".....ss", "....sWs", "...sWss", "..ssss.", ".sss...", "ss....."], { s: "r3", W: "r5" }],
  fiber: [["g.g.g..", "g.g.g..", ".g.g.g.", ".g.g.g.", "g.g.g..", "g.g.g.."], { g: "a2" }],
  clay: [["..ccc..", ".cWccc.", "ccccccc", "ccccccc", ".ccccc."], { c: "k1", W: "k0" }],
  log: [["dddddLL", "ddddLlL", "ddddLLL"], { d: "d2", L: "d4", l: "d3" }],
  plank: [["lllllll", "lllllll", "ddddddd"], { l: "d5", d: "d3" }],
  bark: [["..dd...", ".dDd...", "dDd....", "dd.dd..", "..dDd..", "...dd.."], { d: "d1", D: "d3" }],
  resin: [["...a...", "..aaa..", ".aaWaa.", ".aaaaa.", "..aaa.."], { a: "f2", W: "f4" }],
  flint: [["..ss...", ".sWss..", "sssssss", ".sssss."], { s: "r1", W: "r3" }],
  flint_blade: [["......s", ".....ss", "....sWs", "...sWss", "..ssss.", ".sss...", "ss....."], { s: "r1", W: "r3" }],
  fat: [[".www...", "wwwww..", "wwwwww.", ".wwwww."], { w: "s3" }],
  charcoal: [["..cc...", ".cWcc..", "ccccccc", ".ccccc."], { c: "r0", W: "r2" }],
  ore: [["..rr...", ".rWrr..", "rrrrrrr", "rrrrrr.", ".rrrr.."], { r: "k2", W: "f1" }],
  pebble: [[".ss.", "sWss", "ssss"], { s: "r3", W: "r5" }],
  fern: [["g.g.g.g", ".ggggg.", "g.g.g.g", ".ggggg.", "...g...", "...g..."], { g: "g3" }],
  flower: [[".v.v.", "vvyvv", ".vvv.", "..g..", ".gg..", "..g.."], { v: "violet", y: "f3", g: "g4" }],
  metal: [["..sss..", ".sWWss.", "sssssss"], { s: "r4", W: "snow" }],
  pot: [[".ddddd.", "..ddd..", ".ddddd.", "ddDdddd", "ddddddd", ".ddddd."], { d: "k2", D: "k1" }],
  bag: [["..aaa..", "...h...", ".hhhhh.", "hhHhhhh", "hhhhhhh", ".hhhhh."], { h: "d3", H: "d4", a: "a1" }],
  basket: [["..aaa..", ".a...a.", "aAaAaAa", "AaAaAaA", "aAaAaAa", ".AaAaA."], { a: "a2", A: "a3" }],
  bow: [["..dd...", ".d.a...", "d..a...", "d..a...", "d..a...", ".d.a...", "..dd..."], { d: "d3", a: "a1" }],
  axe: [[".ssd", "sWsd", "sssd", ".ssd", "...d", "...d", "...d"], { s: "r4", W: "snow", d: "d3" }],
  spear: [[".....ss", "....sWs", "....ds.", "...d...", "..d....", ".d.....", "d......"], { s: "r4", W: "snow", d: "d3" }],
  blade: [["......s", ".....ss", "....sW.", "...ss..", "..dd...", ".dd....", "d......"], { s: "r4", W: "snow", d: "d2" }],
  cloth: [["ccccccc", "cCcCcCc", "ccccccc", "cCcCcCc", "ccccccc"], { c: "d4", C: "d5" }],
  cord: [[".aaaa..", "a....a.", "a.aa.a.", "a.a..a.", ".a..a..", "..aa..."], { a: "a1" }],
  food: [["..rfr..", ".rfrfr.", "ddddddd", ".ddddd.", "..ddd.."], { r: "red", f: "f2", d: "d2" }],
  club: [[".....dd", "....ddd", "...ddd.", "..dd...", ".d.....", "d......"], { d: "d3" }],
  rod: [["......d", ".....d.", "....d..", "...d...", "..d....", ".d.....", "d......"], { d: "d4" }],
  brick: [["kkkkkkk", "kKkkkKk", "kkkkkkk"], { k: "k2", K: "k1" }],
  lump: [["..lll..", ".lllll.", "lllllll", ".lllll."], { l: "h2" }],
  grain: [["y.y.y..", ".y.y.y.", "y.yYy..", ".yYyY..", "..yYy..", "...g...", "...g..."], { y: "a2", Y: "a3", g: "a1" }],
  meal: [["..sss..", ".sSsss.", "ddddddd", ".ddddd.", "..ddd.."], { s: "s3", S: "snow", d: "d2" }],
  dough: [["..sss..", ".sssss.", "sSsssss", ".sssss."], { s: "s2", S: "s3" }],
  bread: [[".ddddd.", "dDdDdDd", "ddddddd", ".ddddd."], { d: "d3", D: "d5" }],
  smoked: [["..rrr..", ".rRrrr.", ".rrrrr.", "..rrr..", "...w...", "..w.w.."], { r: "d1", R: "f0", w: "s3" }],
};
function itemSprite(look) {
  const [rows, names] = ITEMS[look] ?? ITEMS.lump, w = Math.max(...rows.map((r) => r.length));
  const S = new Spr(w + 2, rows.length + 2, (w + 2) >> 1, rows.length + 1);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (names[ch]) S.set(x + 1, y + 1, P[names[ch]]); }));
  S.outline(P.ink);
  return S;
}
const SMALL = new Map();
// "act:<activity>" the map's marker, "item:<look>", "animal:<species>", "agent:<color>": a sprite about row high
export function smallIcon(name) {
  if (!name) return null;
  if (SMALL.has(name)) return SMALL.get(name);
  const [kind, arg] = [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)];
  let S = null;
  try {
    if (kind === "act") S = TH.icon(arg);
    else if (kind === "item") S = itemSprite(arg);
    else if (kind === "animal") S = TH.animal(arg, "stand", arg === "butterfly" ? 4 : BIRDS.has(arg) ? 6 : 7, 0, 0, 1);
    else if (kind === "agent") S = TH.walker(9, clothOf(arg), "front", 0, "none", "adult", 0);
  } catch { S = null; }
  SMALL.set(name, S);
  return S;
}
// a sprite at scale k with its box's left top at (x, y)
function stamp(B, S, x, y, k = 1) {
  for (let j = 0; j < S.h; j++) for (let i = 0; i < S.w; i++) { const c = S.p[j * S.w + i]; if (c !== 255) fill(B, x + i * k, y + j * k, x + i * k + k - 1, y + j * k + k - 1, c); }
}

// ------------------------------------------------------------------------------------------------------ bars

const NEED = { food: ramp("f0", "f2", "f3"), hunger: ramp("f0", "f2", "f3"), fed: ramp("f0", "f2", "f3"), energy: ramp("a0", "a2", "a3"), rest: ramp("a0", "a2", "a3"), warmth: ramp("f0", "f1", "f2"), social: ramp("d0", "violet", "k0"), thirst: ramp("w2", "w4", "w6"), water: ramp("w2", "w4", "w6") };
function barRamp(label, f) {
  const l = String(label).toLowerCase();
  for (const k in NEED) if (l.includes(k)) return NEED[k];
  return f > 0.6 ? ramp("g2", "g4", "g6") : f > 0.3 ? ramp("a0", "a2", "a3") : ramp("f0", "red", "k0");
}
// a sunken bar filled to value of max; with min below zero it fills from the middle, green one way and red the other
function bar(B, x0, y, x1, label, value, max, min = 0, plain = false) {
  bevel(B, x0, y, x1, y + 6, true, P.r1);
  const run = (a, b, R) => { for (let x = a; x <= b; x++) { put(B, x, y + 1, R[2]); for (let j = 2; j <= 4; j++) put(B, x, y + j, R[1]); put(B, x, y + 5, R[0]); } };
  if (min < 0) {
    const mid = Math.round((x0 + x1) / 2), f = Math.max(-1, Math.min(1, value / (value < 0 ? -min : max))), n = Math.round((x1 - x0 - 1) / 2 * Math.abs(f));
    if (f > 0) run(mid, mid + n - 1, ramp("g2", "g4", "g6")); else if (f < 0) run(mid - n + 1, mid, ramp("f0", "red", "k0"));
    put(B, mid, y + 5, P.r0); put(B, mid, y + 1, P.r0);
    return;
  }
  const f = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  run(x0 + 1, x0 + Math.round((x1 - x0 - 1) * f), plain ? ramp("w3", "w4", "w6") : barRamp(label, f));
  // quarter ticks so a value can be judged without its number
  for (const q of [0.25, 0.5, 0.75]) { const x = x0 + Math.round((x1 - x0) * q); put(B, x, y + 5, P.r0); }
}

// ------------------------------------------------------------------------------------------------------ panel

const ROW = 10, HEAD = 12, LINE = 9, CELL = 22, TABH = 13, PAD = 4, SLOT = 42;
const inBox = (p, h) => p && p.x >= h.x0 && p.x <= h.x1 && p.y >= h.y0 && p.y <= h.y1;
// whether a toggle is set the other way from how the thing starts
const isOpen = (open, key, start = false) => (open?.has(key) ? !start : start);
// The tabs of data.sections and the sections of the shown one, in the box x0..x1, y0..y1 of B. A row says what it is
// (sim inspect.ts Row): a label, a value, an icon, a bar [value, max, min?], a link (an id to go to), more lines that
// open under it, spark (a list of numbers drawn as a line, h px tall). A section can start folded (fold: true; key: what
// remembers it open, its tab and title unless given) and
// holds rows, a bag of items, or neither (none: what to say then). st: { tab, open (a Set of toggled keys), scroll,
// hover {x, y} }; tab false shows none of them. Returns what a caller needs to drive it: hits [{ x0, y0, x1, y1, tab | toggle | link }], the tab
// shown, scroll clamped, scrollMax.
export function drawPanel(B, x0, y0, x1, y1, data, st = {}) {
  const hits = [], sections = (data.sections ?? []).filter(Boolean);
  const tabs = [...new Set(sections.map((s) => s.tab ?? ""))];
  // tab false: none shown, as a closed window's tab strip
  const tab = st.tab === false ? null : tabs.includes(st.tab) ? st.tab : tabs[0];
  let top = y0;
  if (tabs.length > 1) {
    // raised tabs along the top, the shown one joined to the list below it
    const ws = tabs.map((t) => width(String(t).toUpperCase())), room = x1 - x0 + 1, gap = Math.max(2, Math.min(8, Math.floor((room - ws.reduce((a, b) => a + b, 0)) / tabs.length) - 1));
    let x = x0;
    tabs.forEach((t, i) => {
      const w = ws[i] + gap, on = t === tab, h = { x0: x, y0, x1: Math.min(x1, x + w), y1: y0 + TABH - 1, tab: t };
      bevel(B, h.x0, on ? y0 : y0 + 2, h.x1, y0 + TABH, false, on ? P.r5 : inBox(st.hover, h) ? P.r4 : P.r3);
      say(B, clip(String(t).toUpperCase(), h.x1 - h.x0 - 2), x + (gap >> 1) + 1, (on ? y0 + 3 : y0 + 4), on ? P.ink : P.r1);
      hits.push(h);
      x += w + 1;
    });
    top = y0 + TABH;
  }
  const lx = x0, ly = top, lw = x1 - x0 + 1, lh = y1 - top + 1;
  if (lh < ROW + 2) return { hits, tab, scroll: 0, scrollMax: 0 };
  const shown = sections.filter((s) => (s.tab ?? "") === tab);
  // lay the lines out at a width, then again narrower if they need a scrollbar
  let lines = [];
  const lay = (W) => {
    lines = [];
    let y = 2;
    const push = (ln) => { ln.y = y; lines.push(ln); y += ln.h; };
    for (const s of shown) {
      const skey = s.key ?? `${tab}|${s.title ?? ""}`, folded = s.fold && !isOpen(st.open, skey, false);
      if (s.title) push({ kind: "head", text: s.title, h: HEAD, toggle: s.fold ? skey : null, folded });
      if (folded) continue;
      const rows = s.rows ?? [], items = s.bag ?? [];
      if (!rows.length && !items.length) { if (s.none) push({ kind: "none", text: s.none, h: ROW }); continue; }
      const gut = rows.some((r) => r.more?.length || (!r.link && !fits(r, W))) ? 6 : 0;
      rows.forEach((r, i) => {
        // a row that goes somewhere stays a link even when its words are cut short
        const key = `${skey}|${r.label}`, long = !r.link && !fits(r, W - gut), more = r.more?.length || long ? [...(long ? [r.value != null && r.value !== "" ? `${r.label}: ${fmt(r.value)}` : r.label] : []), ...(r.more ?? [])] : null;
        const open = more && isOpen(st.open, key);
        push({ kind: "row", r, gut, odd: i & 1, h: r.spark ? Math.max(ROW + 8, r.h ?? 24) : ROW, toggle: more ? key : null, link: !more && r.link ? r.link : null, open });
        if (open) for (const l of more) {
          const link = typeof l === "object" ? l.link : null, text = typeof l === "object" ? l.text : String(l);
          wrap(text, W - 14).forEach((t, k) => push({ kind: "more", text: t, link, h: LINE, first: k === 0 }));
        }
      });
      if (items.length) {
        const cols = Math.max(1, Math.floor((W - 2) / CELL)), n = Math.ceil(items.length / cols);
        push({ kind: "bag", items, cols, skey, h: n * CELL + 2 });
        for (const it of items) if (isOpen(st.open, `${skey}|bag|${it.k}`)) {
          push({ kind: "more", text: `${it.n} ${it.name}`, h: LINE, strong: true, first: true });
          for (const l of it.more) {
            const link = typeof l === "object" ? l.link : null, text = typeof l === "object" ? l.text : String(l);
            wrap(text, W - 14).forEach((t) => push({ kind: "more", text: t, link, h: LINE }));
          }
        }
      }
    }
    return y + 1;
  };
  const inner = lw - 2;
  let content = lay(inner), sb = content > lh - 2;
  if (sb) content = lay(inner - 8);
  const maxS = Math.max(0, content - (lh - 2)), s = Math.max(0, Math.min(maxS, Math.round(st.scroll ?? 0)));
  const L = new Buf(inner - (sb ? 8 : 0), Math.max(1, content));
  L.c.fill(P.r5);
  // the hover point in the list's own coordinates
  const hv = st.hover && st.hover.x > lx && st.hover.x < lx + 1 + L.w && st.hover.y > ly && st.hover.y < ly + lh - 1 ? { x: st.hover.x - lx - 1, y: st.hover.y - ly - 1 + s } : null;
  const hit = (h) => { const y0h = h.y0 - s + ly + 1, y1h = h.y1 - s + ly + 1; if (y1h >= ly + 1 && y0h <= ly + lh - 2) hits.push({ ...h, x0: h.x0 + lx + 1, x1: h.x1 + lx + 1, y0: Math.max(ly + 1, y0h), y1: Math.min(ly + lh - 2, y1h) }); };
  for (const ln of lines) {
    const y = ln.y, box = { x0: 0, y0: y - 1, x1: L.w - 1, y1: y + ln.h - 2 }, hot = (ln.toggle || ln.link) && inBox(hv, box);
    if (ln.kind === "head") {
      if (hot) fill(L, 0, y, L.w - 1, y + HEAD - 3, P.w6);
      let x = 2;
      if (ln.toggle) { arrow(L, 2, y + 1, !ln.folded, P.w2); x = 8; }
      say(L, clip(String(ln.text).toUpperCase(), L.w - x - 2), x, y + 1, P.w2);
      fill(L, 2, y + 9, L.w - 3, y + 9, P.w5);
      if (ln.toggle) hit({ ...box, toggle: ln.toggle });
    } else if (ln.kind === "none") say(L, clip(String(ln.text).toUpperCase(), L.w - 6), 4, y, P.r2);
    else if (ln.kind === "row") {
      if (hot) fill(L, 0, y - 1, L.w - 1, y + ln.h - 2, P.w6);
      else if (ln.r.hot) fill(L, 0, y - 1, L.w - 1, y + ln.h - 2, P.s2);
      else if (ln.odd) fill(L, 0, y - 1, L.w - 1, y + ln.h - 2, P.s3);
      drawRow(L, ln, y, hot);
      if (ln.toggle) hit({ ...box, toggle: ln.toggle });
      else if (ln.link) hit({ ...box, link: ln.link });
    } else if (ln.kind === "more") {
      fill(L, 4, y - 1, L.w - 3, y + LINE - 2, P.s3);
      fill(L, 4, y - 1, 4, y + LINE - 2, P.r3);
      if (ln.link) {
        const lhot = inBox(hv, box), t = clip(String(ln.text).toUpperCase(), L.w - 16);
        say(L, t, 8, y, lhot ? P.w4 : P.w3);
        fill(L, 8, y + 7, 8 + width(t) - 2, y + 7, lhot ? P.w4 : P.w5);
        say(L, ">", L.w - 9, y, P.w3);
        hit({ ...box, link: ln.link });
      } else say(L, clip(String(ln.text).toUpperCase(), L.w - 12), 8, y, ln.strong ? P.ink : P.d1);
    } else if (ln.kind === "bag") {
      ln.items.forEach((it, i) => {
        const cx = 2 + (i % ln.cols) * CELL, cy = y + Math.floor(i / ln.cols) * CELL, key = `${ln.skey}|bag|${it.k}`, c = { x0: cx, y0: cy, x1: cx + CELL - 2, y1: cy + CELL - 2, toggle: key };
        const on = isOpen(st.open, key), over = inBox(hv, c);
        bevel(L, c.x0, c.y0, c.x1, c.y1, !on, on ? P.s2 : over ? P.w6 : P.r4);
        if (on) { fill(L, c.x0, c.y0, c.x1, c.y0, P.f3); fill(L, c.x0, c.y1, c.x1, c.y1, P.f3); fill(L, c.x0, c.y0, c.x0, c.y1, P.f3); fill(L, c.x1, c.y0, c.x1, c.y1, P.f3); }
        const S = smallIcon(`item:${it.look}`);
        if (S) { const k = S.w * 2 <= CELL - 3 && S.h * 2 <= CELL - 3 ? 2 : 1; stamp(L, S, cx + Math.floor((CELL - 1 - S.w * k) / 2), cy + Math.floor((CELL - 1 - S.h * k) / 2) - (it.n > 1 ? 1 : 0), k); }
        if (it.n > 1) { const t = String(it.n), tx = c.x1 - width(t), ty = c.y1 - 7; for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) say(L, t, tx + dx, ty + dy, P.ink); say(L, t, tx, ty, P.snow); }
        hit(c);
      });
    }
  }
  bevel(B, lx, ly, lx + lw - 1, ly + lh - 1, true, P.r5);
  for (let j = 0; j < lh - 2; j++) {
    const src = s + j;
    if (src >= L.h) break;
    B.c.set(L.c.subarray(src * L.w, src * L.w + L.w), (ly + 1 + j) * B.w + lx + 1);
  }
  if (!lines.length) say(B, "NOTHING TO SHOW", lx + 4, ly + 3, P.r2);
  if (sb) {
    // scrollbar: a sunken track with a raised thumb sized to the visible share
    const bx0 = lx + lw - 9, by0 = ly + 1, bh = lh - 2;
    bevel(B, bx0, by0, bx0 + 7, by0 + bh - 1, true);
    const th = Math.max(8, Math.round((bh * (lh - 2)) / content)), ty = by0 + Math.round(((bh - th) * s) / Math.max(1, maxS));
    bevel(B, bx0 + 1, ty, bx0 + 6, ty + th - 1, false);
    for (let k = -1; k <= 1; k++) fill(B, bx0 + 2, ty + (th >> 1) + k * 2, bx0 + 5, ty + (th >> 1) + k * 2, P.r2);
  }
  return { hits, tab, scroll: s, scrollMax: maxS, listY: ly, listH: lh };
}
// a little triangle, pointing right when closed and down when open
function arrow(B, x, y, open, c) {
  if (open) { fill(B, x, y + 2, x + 4, y + 2, c); fill(B, x + 1, y + 3, x + 3, y + 3, c); put(B, x + 2, y + 4, c); }
  else { fill(B, x + 1, y + 1, x + 1, y + 5, c); fill(B, x + 2, y + 2, x + 2, y + 4, c); put(B, x + 3, y + 3, c); }
}
const LABEL_W = 78;
// whether a row says all it has to on one line at width W
function fits(r, W) {
  const iw = r.icon ? 11 : 0, l = width(String(r.label)), v = r.value != null && r.value !== "" ? width(fmt(r.value)) : 0;
  if (r.spark) return true;
  if (r.bar) return l + iw <= LABEL_W && (!v || v <= W - LABEL_W - 40);
  return v ? iw + l + 8 + v <= W - 2 : iw + l <= W - 4;
}
function drawRow(L, ln, y, hot) {
  const r = ln.r, W = L.w;
  let x = 2;
  if (ln.toggle) { arrow(L, 1, y, ln.open, P.r2); x = 1 + ln.gut; } else x = 2 + ln.gut;
  if (r.icon) { const S = smallIcon(r.icon); if (S) stamp(L, S, x + Math.floor((9 - S.w) / 2), y + 7 - S.h + 1); x += 11; }
  const label = String(r.label), value = r.value != null && r.value !== "" ? fmt(r.value) : null, lc = r.hot ? P.ink : value != null || r.bar || r.spark ? P.d2 : P.ink;
  if (r.spark) {
    // scaled between its own low and high, so a change shows however big the number; a flat one runs through the middle
    const vs = r.spark, top = y + ROW - 1, h = ln.h - ROW - 1, n = vs.length, hi = Math.max(...vs, 0), lo = Math.min(...vs, hi), span = hi - lo;
    const t = value ?? `${span ? `${fmt(lo)}-${fmt(hi)}  ` : ""}NOW ${fmt(vs.at(-1) ?? 0)}`;
    say(L, t, W - 3 - width(t), y, P.ink);
    say(L, clip(label.toUpperCase(), W - x - width(t) - 6), x, y, lc);
    fill(L, 2, top, W - 3, top + h - 1, P.s3);
    fill(L, 2, top + h - 1, W - 3, top + h - 1, P.r3);
    const c = r.color ?? P.w3, cw = W - 5;
    let py = null;
    for (let i = 0; i <= cw; i++) {
      const v = n > 1 ? vs[Math.round((i / cw) * (n - 1))] : vs[0] ?? 0, yy = top + h - 2 - Math.round((span ? (v - lo) / span : 0.5) * (h - 3));
      fill(L, 2 + i, yy + 1, 2 + i, top + h - 2, P.s2);
      if (py != null) fill(L, 2 + i, Math.min(py, yy), 2 + i, Math.max(py, yy), c); else put(L, 2 + i, yy, c);
      py = yy;
    }
    return;
  }
  if (r.bar) {
    // the bars of a section line up in one column; a measure, not a need, so one plain colour
    const [v, max = 1, min = 0] = r.bar, num = value ?? fmt(v), nw = width(num), bx = 2 + ln.gut + LABEL_W;
    say(L, clip(label.toUpperCase(), bx - x - 3), x, y, lc);
    bar(L, bx, y, W - 4 - nw, label, Number(v) || 0, Number(max) || 1, min, true);
    say(L, num, W - 2 - nw, y, P.ink);
    return;
  }
  if (value == null) { say(L, clip(label.toUpperCase(), W - x - 2), x, y, lc); return; }
  // the value keeps what it needs first, up to two thirds of the row; the label gets the rest
  const vw = Math.min(width(value), Math.floor(((W - x) * 2) / 3)), lw = W - x - vw - 8, lt = clip(label.toUpperCase(), lw), vt = clip(value.toUpperCase(), W - x - width(lt) - 8);
  say(L, lt, x, y, lc);
  const vx = W - 2 - width(vt), link = !!ln.link;
  say(L, vt, vx, y, link ? (hot ? P.w4 : P.w3) : P.ink);
  if (link) fill(L, vx, y + 7, W - 3, y + 7, hot ? P.w4 : P.w5);
}

// ------------------------------------------------------------------------------------------------------ inspector

// data: what sim.inspect and sim.inspectGround return (src/sim/inspect.ts Inspected: facts, bars, sections), or the
// older flat { rows: [label, value][] } where a row with an empty value heads a section. opts: w, h (art px), sprite (an
// optional Spr for the portrait), and the panel's state: tab, open, scroll, hover (drawPanel). Returns a Buf filled edge
// to edge, with `hits`, `tab`, `scroll` (clamped) and `scrollMax` set from the panel.
export function drawInspector(data = {}, { w = 184, h = 232, sprite, ...st } = {}) {
  const B = new Buf(w, h), d = data ?? {};
  B.c.fill(P.ink);
  bevel(B, 1, 1, w - 2, h - 2, false);
  // title bar
  fill(B, 3, 3, w - 4, 13, P.w2);
  fill(B, 3, 3, w - 4, 3, P.w4);
  fill(B, 3, 13, w - 4, 13, P.w1);
  say(B, clip(String(d.name ?? d.kind ?? "Nothing").toUpperCase(), w - (st.back ? 40 : 24)), st.back ? 18 : 6, 5, P.snow);
  // portrait and the facts beside it
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
  const facts = d.facts ? d.facts.map((f, i) => [String(f), i ? P.r1 : P.ink]) : [[kind, P.ink], ...(d.px != null ? [[`AT ${fmt(Number(d.px))} ${fmt(Number(d.py))}`, P.r1]] : []), ...(d.id != null && String(d.kind).toLowerCase() !== "ground" ? [[`ID ${d.id}`, P.r1]] : [])];
  let fy = sy + 2;
  // what they are at, with the marker the map shows over them
  if (d.activity) { const S = smallIcon(`act:${d.activity}`); if (S) stamp(B, S, tx, fy - 1); }
  facts.slice(0, 4).forEach(([s, c], i) => { const x = i === 0 && d.activity ? tx + 11 : tx; say(B, clip(s.toUpperCase(), tw - (x - tx)), x, fy, c); fy += 10; });
  // bars
  let y = sy + SLOT + 3;
  const bars = d.bars ?? [];
  for (const [label, value, max] of bars) {
    const v = Number(value) || 0, m = Number(max) || 100, num = `${fmt(v)}/${fmt(m)}`, lw = 44, nw = width(num);
    say(B, clip(String(label).toUpperCase(), lw - 2), PAD + 1, y, P.ink);
    bar(B, PAD + lw, y, w - PAD - 3 - Math.max(nw, 30), label, v, m);
    say(B, num, w - PAD - 1 - nw, y, P.ink);
    y += 9;
  }
  if (bars.length) y += 2;
  const p = drawPanel(B, PAD, y, w - PAD - 1, h - PAD - 1, d.sections ? d : { sections: legacy(d.rows ?? []) }, st);
  Object.assign(B, p);
  return B;
}
// flat [label, value] rows as one tab's sections, a row with no value heading the next
function legacy(rows) {
  const out = [{ tab: "", rows: [] }];
  for (const [label, value] of rows) {
    const v = fmt(value);
    if (v === "") out.push({ tab: "", title: String(label), rows: [] });
    else out.at(-1).rows.push({ label: String(label), value: v });
  }
  return out;
}
