// The resizable-mode client drawn over the game view: minimap with compass and orbs, chatbox, side panel with tabs
// and inventory, the mouse-over text and overhead chat, all at the client's native pixel size.
import { text, centered, width } from "./font.js";
import { ITEMS, TABS, MAPICONS, MAPSCENE, SKILLS } from "./icons.js";
import { css } from "./terrain.js";
import { hash } from "../world.js";

// Mottled stone: a base color with grain at two scales, written straight into pixels.
export function stone(g, x, y, w, h, base = [62, 53, 41], amp = 9, seed = 1) {
  const cv = Object.assign(document.createElement("canvas"), { width: w, height: h }), c = cv.getContext("2d"), img = c.createImageData(w, h), d = img.data;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const X = x + i, Y = y + j, o = (j * w + i) * 4;
      const n = (hash(X, Y, seed) - 0.5) * amp + (hash(X >> 2, Y >> 2, seed + 1) - 0.5) * amp * 1.3 + (hash(X >> 4, Y >> 3, seed + 2) - 0.5) * amp * 0.8;
      d[o] = base[0] + n; d[o + 1] = base[1] + n * 0.95; d[o + 2] = base[2] + n * 0.85; d[o + 3] = 255;
    }
  c.putImageData(img, 0, 0);
  // drawImage, not putImageData, so circular clips on the minimap and orbs apply
  g.drawImage(cv, x, y);
}
const box = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
function frame(g, x, y, w, h, light = "#6e6352", dark = "#2b251d") {
  g.strokeStyle = "#0b0a08"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  box(g, x + 1, y + 1, w - 2, 1, light); box(g, x + 1, y + 1, 1, h - 2, light);
  box(g, x + 1, y + h - 2, w - 2, 1, dark); box(g, x + w - 2, y + 1, 1, h - 2, dark);
}
function ringPath(g, cx, cy, r) { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); }

// ---------- minimap ----------
export function minimap(g, F, { G, P, center, look, npcs, fire }) {
  const cx = 1180, cy = 84, r = 72, T = G.T, PX = 4, S = (G.R * 2 + 2) * PX;
  const off = Object.assign(document.createElement("canvas"), { width: S, height: S }), m = off.getContext("2d");
  m.fillStyle = "#000"; m.fillRect(0, 0, S, S);
  const mx = (x) => ((x - center.x) / T) * PX + S / 2, mz = (z) => ((z - center.z) / T) * PX + S / 2;
  const corner = (t, q) => [[0, 0], [1, 0], [1, 1], [0, 1]][q];
  for (const t of G.tiles) {
    const x = Math.round(mx(G.ox + t.i * T)), y = Math.round(mz(G.oz + t.j * T));
    const flat = G.flatColor(t);
    if (t.odd < 0 || !t.over) { m.fillStyle = css(flat); m.fillRect(x, y, PX, PX); continue; }
    m.fillStyle = css(G.flatColor({ ...t, over: 0 })); m.fillRect(x, y, PX, PX);
    m.fillStyle = css(flat); m.beginPath();
    [0, 1, 2, 3].filter((q) => q !== t.odd).forEach((q, n) => { const [a, b] = corner(t, q); n ? m.lineTo(x + a * PX, y + b * PX) : m.moveTo(x + a * PX, y + b * PX); });
    m.closePath(); m.fill();
  }
  const scene = { normal: MAPSCENE.tree(), light: MAPSCENE.tree(), oak: MAPSCENE.tree(), willow: MAPSCENE.tree(), evergreen: MAPSCENE.pine(), dead: MAPSCENE.dead() };
  for (const t of P.trees) { const s = scene[t.model]; m.drawImage(s, Math.round(mx(t.x) - 2), Math.round(mz(t.z) - 4)); }
  const rock = MAPSCENE.rock();
  for (const k of P.rocks) if (k.s > 1.1) m.drawImage(rock, Math.round(mx(k.x) - 2), Math.round(mz(k.z) - 1));

  // frame first, then the rotated map clipped to its circle
  const ring = (rr, c) => { g.fillStyle = c; ringPath(g, cx, cy, rr); g.fill(); };
  ring(r + 9, "#0b0a08");
  g.save(); ringPath(g, cx, cy, r + 8); g.clip(); stone(g, cx - r - 9, cy - r - 9, 2 * r + 18, 2 * r + 18, [78, 68, 54], 12, 5); g.restore();
  ring(r + 2, "#0b0a08");
  const rot = -Math.PI / 2 - look;
  g.save(); ringPath(g, cx, cy, r); g.clip();
  g.imageSmoothingEnabled = false;
  g.translate(cx, cy); g.rotate(rot); g.drawImage(off, -S / 2, -S / 2);
  g.restore();
  const toScreen = (x, z) => { const dx = mx(x) - S / 2, dz = mz(z) - S / 2; return [cx + dx * Math.cos(rot) - dz * Math.sin(rot), cy + dx * Math.sin(rot) + dz * Math.cos(rot)]; };
  const inside = ([x, y], pad = 4) => Math.hypot(x - cx, y - cy) < r - pad;
  for (const s of P.spots) { const p = toScreen(s.x, s.z); if (inside(p, 7)) g.drawImage(MAPICONS.fishing(), Math.round(p[0] - 7), Math.round(p[1] - 7)); }
  if (fire) { const p = toScreen(fire.x, fire.z); if (inside(p, 7)) g.drawImage(MAPICONS.fire(), Math.round(p[0] - 7), Math.round(p[1] - 7)); }
  for (const n of npcs) { const p = toScreen(n.x, n.z); if (inside(p)) { box(g, Math.round(p[0]) - 2, Math.round(p[1]) - 2, 4, 4, "#000"); box(g, Math.round(p[0]) - 2, Math.round(p[1]) - 2, 3, 3, "#ffff00"); } }
  box(g, cx - 2, cy - 2, 4, 4, "#000"); box(g, cx - 2, cy - 2, 3, 3, "#ffffff");

  // compass: a disc with the north arrow turned with the map
  const kx = 1103, ky = 22, kr = 17;
  g.fillStyle = "#0b0a08"; ringPath(g, kx, ky, kr + 2); g.fill();
  g.save(); ringPath(g, kx, ky, kr + 1); g.clip(); stone(g, kx - kr - 2, ky - kr - 2, 2 * kr + 4, 2 * kr + 4, [92, 82, 66], 10, 8); g.restore();
  g.fillStyle = "#1b1712"; ringPath(g, kx, ky, kr - 3); g.fill();
  g.fillStyle = "#c9b98f"; ringPath(g, kx, ky, kr - 4); g.fill();
  const na = -Math.PI - look;
  g.save(); g.translate(kx, ky); g.rotate(na + Math.PI / 2);
  g.fillStyle = "#b01c10"; g.beginPath(); g.moveTo(0, -11); g.lineTo(4, 0); g.lineTo(-4, 0); g.closePath(); g.fill();
  g.fillStyle = "#e8e0c8"; g.beginPath(); g.moveTo(0, 11); g.lineTo(4, 0); g.lineTo(-4, 0); g.closePath(); g.fill();
  g.restore();
  const nx = kx + Math.cos(na) * 9, ny = ky + Math.sin(na) * 9;
  centered(g, F.small, [["N", "#000"]], nx, ny - 6, null);

  orbs(g, F);
  // world map button: a small globe below the ring
  const wx = 1247, wy = 150;
  g.fillStyle = "#0b0a08"; ringPath(g, wx, wy, 14); g.fill();
  g.save(); ringPath(g, wx, wy, 13); g.clip(); stone(g, wx - 14, wy - 14, 28, 28, [84, 74, 58], 10, 9); g.restore();
  g.fillStyle = "#1d4f7a"; ringPath(g, wx, wy, 9); g.fill();
  g.fillStyle = "#3f8a3a"; g.beginPath(); g.ellipse(wx - 3, wy - 2, 4, 3, 0.5, 0, 6.28); g.fill(); g.beginPath(); g.ellipse(wx + 4, wy + 3, 3, 2.5, 0, 0, 6.28); g.fill();
}

function orbs(g, F) {
  const orb = (x, y, value, fill, dark, icon) => {
    // number plate to the left
    g.fillStyle = "#0b0a08"; g.fillRect(x - 44, y - 9, 34, 18);
    stone(g, x - 43, y - 8, 32, 16, [58, 50, 40], 8, 11);
    const v = String(value), vc = value >= 90 || value === "99" ? "#00ff00" : value > 40 ? "#ffff00" : "#ff9800";
    centered(g, F.small, [[v, vc]], x - 26, y - 6);
    g.fillStyle = "#0b0a08"; ringPath(g, x, y, 15); g.fill();
    g.save(); ringPath(g, x, y, 14); g.clip(); stone(g, x - 15, y - 15, 30, 30, [88, 77, 60], 10, 12); g.restore();
    g.fillStyle = "#15120e"; ringPath(g, x, y, 11); g.fill();
    const grad = g.createLinearGradient(0, y - 10, 0, y + 10); grad.addColorStop(0, fill); grad.addColorStop(1, dark);
    g.fillStyle = grad; ringPath(g, x, y, 10); g.fill();
    g.fillStyle = "rgba(255,255,255,0.25)"; g.beginPath(); g.ellipse(x - 3, y - 5, 4, 2.5, -0.4, 0, 6.28); g.fill();
    icon(x, y);
  };
  const heart = (x, y) => { g.fillStyle = "#fff0f0"; g.beginPath(); g.arc(x - 2.5, y - 1, 2.6, 0, 6.28); g.arc(x + 2.5, y - 1, 2.6, 0, 6.28); g.fill(); g.beginPath(); g.moveTo(x - 5, y); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.fill(); };
  const star = (x, y) => { g.fillStyle = "#f4f7ff"; g.beginPath(); [[0, -6], [1.6, -1.6], [6, 0], [1.6, 1.6], [0, 6], [-1.6, 1.6], [-6, 0], [-1.6, -1.6]].forEach(([a, b], i) => (i ? g.lineTo(x + a, y + b) : g.moveTo(x + a, y + b))); g.fill(); };
  const boot = (x, y) => { g.fillStyle = "#3a2410"; g.fillRect(x - 2, y - 6, 4, 8); g.fillRect(x - 2, y + 1, 7, 4); };
  const bolt = (x, y) => { g.fillStyle = "#e9ffe0"; g.beginPath(); [[1, -6], [-3, 1], [0, 1], [-1, 6], [3, -1], [0, -1]].forEach(([a, b], i) => (i ? g.lineTo(x + a, y + b) : g.moveTo(x + a, y + b))); g.fill(); };
  orb(1093, 60, 27, "#d5321f", "#6e110a", heart);
  orb(1091, 94, 43, "#39c0e6", "#0f5670", star);
  orb(1097, 127, 91, "#e8c02a", "#86600c", boot);
  orb(1116, 156, 100, "#5fd15a", "#1f6a1c", bolt);
  // xp drops button beside the compass
  g.fillStyle = "#0b0a08"; ringPath(g, 1070, 26, 11); g.fill();
  g.save(); ringPath(g, 1070, 26, 10); g.clip(); stone(g, 1059, 15, 22, 22, [88, 77, 60], 10, 13); g.restore();
  centered(g, F.small, [["XP", "#ff981f"]], 1070, 20);
}

// ---------- chatbox ----------
export function chatbox(g, F, lines, me) {
  const x = 0, y = 720 - 165, w = 519, h = 142;
  g.fillStyle = "#0b0a08"; g.fillRect(x, y, w, h);
  stone(g, x + 1, y + 1, w - 2, h - 2, [213, 198, 160], 7, 21);
  frame(g, x, y, w, h, "#8a7a5c", "#5d503b");
  box(g, x + 7, y + h - 23, w - 30, 1, "#8f7f60");
  // scrollbar on the right edge
  const sx = x + w - 21, sy = y + 6, sh = h - 30;
  box(g, sx, sy, 16, sh, "#4a4133"); box(g, sx + 1, sy + 1, 14, sh - 2, "#2e281f");
  for (const [yy, up] of [[sy, true], [sy + sh - 16, false]]) {
    stone(g, sx + 1, yy + 1, 14, 14, [96, 84, 66], 8, 22); frame(g, sx, yy, 16, 16);
    g.fillStyle = "#cfc29f"; g.beginPath();
    if (up) { g.moveTo(sx + 8, yy + 5); g.lineTo(sx + 12, yy + 10); g.lineTo(sx + 4, yy + 10); } else { g.moveTo(sx + 8, yy + 11); g.lineTo(sx + 12, yy + 6); g.lineTo(sx + 4, yy + 6); }
    g.fill();
  }
  stone(g, sx + 2, sy + sh - 52, 12, 34, [120, 104, 80], 8, 23); frame(g, sx + 1, sy + sh - 53, 14, 36, "#9b8a6a", "#4a3f30");
  let ly = y + h - 38;
  for (let k = lines.length - 1; k >= 0 && ly > y + 2; k--, ly -= 14) text(g, F.plain, lines[k], x + 9, ly, null);
  text(g, F.plain, [[me + ": ", "#000000"], ["*", "#0000ff"]], x + 9, y + h - 19, null);
  // filter buttons under the box
  const by = 720 - 23, labels = [["All", null], ["Game", ["On", "#00ff00"]], ["Public", ["On", "#00ff00"]], ["Private", ["Friends", "#ffff00"]], ["Channel", ["On", "#00ff00"]], ["Clan", ["On", "#00ff00"]], ["Trade", ["On", "#00ff00"]]];
  let bx = 0;
  labels.forEach(([label, state], k) => {
    const bw = 58;
    g.fillStyle = "#0b0a08"; g.fillRect(bx, by, bw, 23);
    stone(g, bx + 1, by + 1, bw - 2, 21, k === 0 ? [104, 90, 70] : [70, 61, 48], 9, 30 + k);
    frame(g, bx, by, bw, 23, k === 0 ? "#a8956f" : "#83765f", "#2d271f");
    if (state) { centered(g, F.small, [[label, "#ffffff"]], bx + bw / 2, by + 1); centered(g, F.small, [state], bx + bw / 2, by + 11); }
    else centered(g, F.small, [[label, "#ffffff"]], bx + bw / 2, by + 6);
    bx += bw + 1;
  });
  g.fillStyle = "#0b0a08"; g.fillRect(bx, by, 519 - bx, 23);
  stone(g, bx + 1, by + 1, 519 - bx - 2, 21, [70, 61, 48], 9, 40);
  frame(g, bx, by, 519 - bx, 23);
  centered(g, F.small, [["Report", "#ffffff"]], bx + (519 - bx) / 2, by + 6);
}

// ---------- side panel ----------
export function sidePanel(g, F, items) {
  const w = 241, x = 1280 - w, tabH = 36, ph = 262, y0 = 720 - (tabH * 2 + ph);
  g.fillStyle = "#0b0a08"; g.fillRect(x, y0, w, tabH * 2 + ph);
  const top = ["combat", "stats", "quest", "inventory", "equipment", "prayer", "magic"], bottom = ["clan", "friends", "account", "logout", "settings", "emotes", "music"];
  const tw = 33;
  const tabs = (names, y) => names.forEach((name, k) => {
    const tx = x + 4 + k * tw, sel = name === "inventory";
    stone(g, tx + 1, y + 1, tw - 2, tabH - 2, [74, 65, 51], 10, 50 + k + y);
    if (sel) {
      const gr = g.createRadialGradient(tx + tw / 2, y + tabH / 2, 2, tx + tw / 2, y + tabH / 2, 18);
      gr.addColorStop(0, "rgba(170,40,20,0.85)"); gr.addColorStop(1, "rgba(90,15,8,0.6)");
      g.fillStyle = gr; g.fillRect(tx + 1, y + 1, tw - 2, tabH - 2);
    }
    frame(g, tx, y, tw, tabH, sel ? "#c0602f" : "#857761", "#2a241c");
    g.drawImage(TABS[name](), tx + 4, y + 5);
  });
  stone(g, x, y0, w, tabH, [52, 45, 35], 8, 60); stone(g, x, y0 + tabH + ph, w, tabH, [52, 45, 35], 8, 61);
  tabs(top, y0); tabs(bottom, y0 + tabH + ph);
  const py = y0 + tabH;
  stone(g, x, py, w, ph, [55, 48, 38], 9, 62);
  frame(g, x + 2, py, w - 4, ph, "#6c604e", "#221d17");
  stone(g, x + 8, py + 5, w - 16, ph - 10, [62, 54, 42], 10, 63);
  box(g, x + 8, py + 5, w - 16, 1, "#2a241c"); box(g, x + 8, py + 5, 1, ph - 10, "#2a241c");
  items.forEach((it, i) => {
    if (!it) return;
    const c = i % 4, r = Math.floor(i / 4), ix = x + 20 + c * 51, iy = py + 10 + r * 35;
    g.drawImage(it.icon, ix, iy);
    if (it.count) text(g, F.small, [[String(it.count), "#ffff00"]], ix, iy - 1);
  });
}

// Experience drops falling beside the minimap: a skill icon and the amount.
export function xpDrops(g, F, drops) {
  drops.forEach(([skill, n], k) => {
    const y = 40 + k * 22, s = String(n), w = 18 + width(F.plain, s);
    g.drawImage(SKILLS[skill](), 1040 - w, y);
    text(g, F.plain, [[s, "#ffffff"]], 1040 - w + 18, y + 2);
  });
}
export function mouseText(g, F, segs) { text(g, F.bold, segs, 4, 4); }
export function overhead(g, F, s, x, y) { centered(g, F.bold, [[s, "#ffff00"]], x, y - 12); }
export function clickCross(g, x, y) {
  x = Math.round(x); y = Math.round(y);
  for (const [c, o] of [["#000", 1], ["#ffff00", 0]])
    for (let k = -4; k <= 4; k++) {
      box(g, x + k - o, y + k, 1 + 2 * o, 1 + o, c); box(g, x + k - o, y - k, 1 + 2 * o, 1 + o, c);
    }
}
export const itemIcons = () => ({ logs: ITEMS.logs(), oak: ITEMS.oak(), axe: ITEMS.axe(), tinderbox: ITEMS.tinderbox(), raw: ITEMS.shrimps(false), cooked: ITEMS.shrimps(true), net: ITEMS.net(), coins: ITEMS.coins(), knife: ITEMS.knife(), bread: ITEMS.bread() });
