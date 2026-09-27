// The island view: the client's world map interface, a flat top-down pixel map of the whole island in the map's
// palette, forests packed with little tree pictures, and map function icons for what the data holds.
import { text, centered, width } from "./font.js";
import { MAPICONS } from "./icons.js";
import { stone } from "./ui.js";
import { hash, clamp, fbm } from "../world.js";
import { hsl } from "./terrain.js";

const ORANGE = "#ff981f";
const MAPCOL = {
  sea: hsl(218, 0.36, 0.36), shallow: hsl(214, 0.38, 0.44), grass: hsl(86, 0.46, 0.35), forest: hsl(96, 0.42, 0.27), shrub: hsl(78, 0.38, 0.33),
  marsh: hsl(68, 0.32, 0.32), bare: hsl(36, 0.13, 0.43), sand: hsl(44, 0.42, 0.56), snow: hsl(210, 0.1, 0.9), coast: hsl(90, 0.3, 0.13),
};
const to255 = (c) => c.map((v) => Math.round(clamp(v, 0, 1) * 255));

export function drawWorldMap(g, F, W, paths, seed) {
  const SW = 1280, SH = 720, keyW = 186, top = 26, bot = 28, mx0 = 6, my0 = top, mw = SW - keyW - 12, mh = SH - top - bot;
  // window chrome
  g.fillStyle = "#0b0a08"; g.fillRect(0, 0, SW, SH);
  stone(g, 1, 1, SW - 2, SH - 2, [66, 57, 45], 10, 70);
  for (const [x, y, w, h] of [[mx0 - 1, my0 - 1, mw + 2, mh + 2], [SW - keyW - 3, my0 - 1, keyW - 3, mh + 2]]) { g.fillStyle = "#0b0a08"; g.fillRect(x, y, w, h); }
  centered(g, F.bold, [["Nomads", ORANGE]], (SW - keyW) / 2, 6);
  // close button
  g.fillStyle = "#0b0a08"; g.fillRect(SW - 26, 3, 21, 20);
  stone(g, SW - 25, 4, 19, 18, [96, 30, 22], 10, 71);
  g.strokeStyle = "#ffcf9e"; g.lineWidth = 2; g.beginPath(); g.moveTo(SW - 20, 8); g.lineTo(SW - 11, 17); g.moveTo(SW - 11, 8); g.lineTo(SW - 20, 17); g.stroke();
  // map area drop-down
  g.fillStyle = "#0b0a08"; g.fillRect(6, 3, 160, 20);
  stone(g, 7, 4, 158, 18, [44, 38, 30], 8, 72);
  text(g, F.plain, [["Nomads Island", ORANGE]], 12, 6);
  g.fillStyle = ORANGE; g.beginPath(); g.moveTo(150, 10); g.lineTo(158, 10); g.lineTo(154, 16); g.fill();

  // ---------- the painted map ----------
  const S = 2, RW = Math.floor(mw / S), RH = Math.floor(mh / S);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const { isle, N, CELL, START } = W;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (isle.height[j * N + i] > 0) { const x = START + i * CELL, z = START + j * CELL; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const mpp = Math.max((x1 - x0 + 500) / RW, (z1 - z0 + 360) / RH), cxw = (x0 + x1) / 2, czw = (z0 + z1) / 2;
  const wx = (px) => cxw + (px + 0.5 - RW / 2) * mpp, wz = (py) => czw + (py + 0.5 - RH / 2) * mpp;
  const px = (x) => (x - cxw) / mpp + RW / 2, py = (z) => (z - czw) / mpp + RH / 2;
  const cv = Object.assign(document.createElement("canvas"), { width: RW, height: RH }), m = cv.getContext("2d"), img = m.createImageData(RW, RH), d = img.data;
  const water = new Uint8Array(RW * RH), height = new Float32Array(RW * RH), kindAt = new Float32Array(RW * RH);
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) {
      const X = wx(x), Z = wz(y), h = W.heightAt(X, Z), lv = paths.level(X, Z), k = y * RW + x;
      height[k] = h;
      if (h < lv) { water[k] = lv > 0.5 ? 2 : 1; continue; }
    }
  for (let y = 0; y < RH; y++)
    for (let x = 0; x < RW; x++) {
      const k = y * RW + x, X = wx(x), Z = wz(y), o = k * 4;
      let c;
      if (water[k]) {
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) { const q = (y + dy) * RW + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < RW && y + dy < RH && !water[q]) { near = true; break; } }
        c = near || water[k] === 2 ? MAPCOL.shallow : MAPCOL.sea;
      } else {
        const cv6 = { forest: W.fine(W.cover.tree, X, Z), shrub: W.fine(W.cover.shrub, X, Z), grass: W.fine(W.cover.grass, X, Z), marsh: W.fine(W.cover.marsh, X, Z), bare: W.fine(W.cover.bare, X, Z), sand: W.fine(W.cover.sand, X, Z) };
        c = [0, 0, 0];
        for (const [key, w] of Object.entries(cv6)) for (let q = 0; q < 3; q++) c[q] += MAPCOL[key][q] * w;
        const snow = W.bilinear(isle.snow, (X - START) / CELL, (Z - START) / CELL);
        if (snow > 0.118) c = c.map((v, q) => v + (MAPCOL.snow[q] - v) * clamp((snow - 0.118) * 60, 0, 0.8));
        const hs = clamp(1 + (height[k] - (height[k + 1] ?? height[k])) * 0.004 - (height[k] - (height[k + RW] ?? height[k])) * 0.004, 0.9, 1.1);
        c = c.map((v) => v * hs * (1 + 0.05 * fbm(X / 400, Z / 400, 3, 2)));
        let coast = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = (y + dy) * RW + x + dx; if (x + dx >= 0 && y + dy >= 0 && x + dx < RW && y + dy < RH && water[q]) coast = true; }
        if (coast) c = MAPCOL.coast;
      }
      const [r, gg, b] = to255(c);
      d[o] = r & 0xfc; d[o + 1] = gg & 0xfc; d[o + 2] = b & 0xfc; d[o + 3] = 255;
    }
  m.putImageData(img, 0, 0);
  // tree pictures packed over the forests, conifer or broadleaf by what grows there; rock piles on bare heights
  const bins = new Map();
  for (const t of W.trees) { const k = Math.floor(py(t.z) / 3) * 1000 + Math.floor(px(t.x) / 3); const b = bins.get(k) || { n: 0, pine: 0 }; b.n++; if (t.kind === "pine") b.pine++; bins.set(k, b); }
  const treeSprite = (x, y, pine, shade) => {
    const dark = `rgb(${to255(hsl(110, 0.5, 0.12 + shade * 0.03)).join(",")})`, mid = `rgb(${to255(hsl(pine ? 128 : 100, 0.5, 0.24 + shade * 0.05)).join(",")})`, lit = `rgb(${to255(hsl(pine ? 120 : 88, 0.5, 0.36 + shade * 0.05)).join(",")})`;
    if (pine) {
      m.fillStyle = dark; m.fillRect(x - 2, y + 1, 5, 2); m.fillRect(x - 1, y - 1, 3, 2); m.fillRect(x, y - 3, 1, 2);
      m.fillStyle = mid; m.fillRect(x - 1, y + 1, 3, 1); m.fillRect(x, y - 1, 1, 2);
      m.fillStyle = "#3b2612"; m.fillRect(x, y + 3, 1, 1);
    } else {
      m.fillStyle = dark; m.fillRect(x - 2, y - 1, 5, 3); m.fillRect(x - 1, y - 2, 3, 5);
      m.fillStyle = mid; m.fillRect(x - 1, y - 1, 3, 2);
      m.fillStyle = lit; m.fillRect(x - 1, y - 1, 1, 1);
      m.fillStyle = "#3b2612"; m.fillRect(x, y + 3, 1, 1);
    }
  };
  for (let y = 2; y < RH - 2; y += 3)
    for (let x = 2; x < RW - 2; x += 3) {
      const b = bins.get(Math.floor(y / 3) * 1000 + Math.floor(x / 3));
      const k = y * RW + x;
      if (water[k]) continue;
      const X = wx(x), Z = wz(y), tc = W.fine(W.cover.tree, X, Z), r = hash(x, y, 5);
      if ((b && b.n > 8 && tc > 0.35 && r < tc * 0.7) || (b && b.n > 3 && r < 0.12)) treeSprite(x + Math.floor(hash(x, y, 6) * 3) - 1, y + Math.floor(hash(x, y, 7) * 3) - 1, b.pine / b.n > 0.5, r);
      else if (W.fine(W.cover.bare, X, Z) > 0.5 && height[k] > 60 && r < 0.35) {
        m.fillStyle = "#4a443b"; m.fillRect(x - 2, y, 5, 2); m.fillRect(x - 1, y - 1, 3, 1);
        m.fillStyle = "#8d8676"; m.fillRect(x - 1, y - 1, 1, 1); m.fillRect(x - 2, y, 1, 1);
      }
    }
  // streams, one or two map pixels wide
  m.fillStyle = `rgb(${to255(MAPCOL.shallow).join(",")})`;
  for (const line of W.rivers)
    for (let k = 1; k < line.length; k++) {
      const [ax, az, q] = line[k - 1], [bx, bz] = line[k], n = Math.ceil(Math.hypot(bx - ax, bz - az) / (mpp * 0.5)), wide = W.riverWidth(q) > 6 ? 2 : 1;
      for (let s = 0; s <= n; s++) m.fillRect(Math.floor(px(ax + ((bx - ax) * s) / n)), Math.floor(py(az + ((bz - az) * s) / n)), wide, wide);
    }

  g.imageSmoothingEnabled = false;
  g.drawImage(cv, mx0, my0, RW * S, RH * S);
  const sx = (x) => mx0 + px(x) * S, sy = (z) => my0 + py(z) * S;

  // ---------- map functions from the data ----------
  const camp = W.camp.at, icons = [];
  const icon = (kind, x, z) => { if (icons.every((q) => Math.hypot(sx(q.x) - sx(x), sy(q.z) - sy(z)) > 26)) icons.push({ kind, x, z }); };
  icon("fire", camp.x, camp.z);
  if (paths.shore) icon("fishing", paths.shore.x, paths.shore.z);
  // fishing spots where streams run into the sea, water sources at stream heads and lake middles
  for (const line of W.rivers) {
    const end = line[line.length - 1], head = line[0];
    icon("fishing", end[0], end[1]);
    if (W.heightAt(head[0], head[1]) > 5) icon("water", head[0], head[1]);
  }
  const lakes = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; if (isle.water[k] > 0 && isle.height[k] + isle.water[k] > 1) lakes.push([START + i * CELL, START + j * CELL, isle.water[k]]); }
  lakes.sort((a, b) => b[2] - a[2]).slice(0, 6).forEach(([x, z]) => icon("water", x, z));
  // rare trees: the densest stands of old oak
  const stands = [...bins.entries()].filter(([, b]) => b.n > 30 && b.pine / b.n < 0.3).sort((a, b) => b[1].n - a[1].n);
  for (const [k] of stands.slice(0, 40)) { const bx = (k % 1000) * 3 + 1.5, by = Math.floor(k / 1000) * 3 + 1.5; if (icons.filter((q) => q.kind === "tree").length < 5) icon("tree", wx(bx), wz(by)); }
  // mining rocks on the highest bare ground
  const peaks = W.rocks.filter((r) => r.y > 150 && r.size > 3).sort((a, b) => b.y - a.y);
  for (const r of peaks.slice(0, 60)) if (icons.filter((q) => q.kind === "rocks").length < 3) icon("rocks", r.x, r.z);
  const sprites = Object.fromEntries(Object.keys(MAPICONS).map((k) => [k, MAPICONS[k]()]));
  for (const q of icons) g.drawImage(sprites[q.kind], Math.round(sx(q.x) - 7), Math.round(sy(q.z) - 7));

  // labels and the player marker
  const label = (s, x, z, f = F.bold, c = "#ffffff") => centered(g, f, [[s, c]], sx(x), sy(z));
  label("Camp", camp.x, camp.z + 330);
  let peak = null;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; if (!peak || isle.height[k] > peak.h) peak = { h: isle.height[k], x: START + i * CELL, z: START + j * CELL }; }
  label(`Summit (${Math.round(peak.h)}m)`, peak.x, peak.z + 220, F.plain);
  const big = lakes[0];
  if (big) label("Lake", big[0], big[1] - 240, F.plain, "#e0e8ff");
  const [cx, cy] = [Math.round(sx(camp.x)), Math.round(sy(camp.z))];
  g.fillStyle = "#000"; g.fillRect(cx - 3, cy - 20, 6, 6); g.fillStyle = "#fff"; g.fillRect(cx - 2, cy - 19, 4, 4);
  g.fillStyle = "#000"; g.beginPath(); g.moveTo(cx - 7, cy - 34); g.lineTo(cx + 7, cy - 34); g.lineTo(cx, cy - 23); g.fill();
  g.fillStyle = "#ffff00"; g.beginPath(); g.moveTo(cx - 5, cy - 33); g.lineTo(cx + 5, cy - 33); g.lineTo(cx, cy - 25); g.fill();
  // compass rose in the map corner
  const rx = mx0 + 34, ry = my0 + 34;
  g.fillStyle = "#0b0a08"; g.beginPath(); g.arc(rx, ry, 24, 0, 6.28); g.fill();
  g.fillStyle = "#c9b98f"; g.beginPath(); g.arc(rx, ry, 22, 0, 6.28); g.fill();
  g.fillStyle = "#b01c10"; g.beginPath(); g.moveTo(rx, ry - 18); g.lineTo(rx + 5, ry); g.lineTo(rx - 5, ry); g.fill();
  g.fillStyle = "#e8e0c8"; g.beginPath(); g.moveTo(rx, ry + 18); g.lineTo(rx + 5, ry); g.lineTo(rx - 5, ry); g.fill();
  centered(g, F.bold, [["N", "#000"]], rx, ry - 36 + 8, null);
  // scale bar: a kilometre in map pixels
  const km = (1000 / mpp) * S, bx = mx0 + 14, byy = my0 + mh - 20;
  g.fillStyle = "#000"; g.fillRect(bx - 1, byy - 1, km + 2, 6);
  for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? "#e8e0c8" : "#3a2a18"; g.fillRect(bx + (k * km) / 4, byy, km / 4, 4); }
  text(g, F.small, [["1 km", "#ffffff"]], bx + km + 6, byy - 5);

  // ---------- key ----------
  const kx = SW - keyW + 2, ky = my0 + 6;
  stone(g, kx - 4, my0, keyW - 5, mh, [48, 42, 33], 8, 73);
  centered(g, F.bold, [["Key", ORANGE]], kx + keyW / 2 - 8, ky);
  g.fillStyle = "#6c604e"; g.fillRect(kx + 4, ky + 18, keyW - 22, 1);
  const count = (k) => icons.filter((q) => q.kind === k).length;
  [["fire", "Campfire"], ["fishing", "Fishing spot"], ["water", "Water source"], ["tree", "Rare trees"], ["rocks", "Mining site"]].forEach(([k, name], n) => {
    const y = ky + 28 + n * 24;
    g.drawImage(sprites[k], kx + 6, y);
    text(g, F.plain, [[name, ORANGE]], kx + 28, y + 1);
    text(g, F.small, [[String(count(k)), "#ffffff"]], kx + keyW - 34, y + 2);
  });
  const ky2 = ky + 28 + 5 * 24 + 10;
  g.fillStyle = "#6c604e"; g.fillRect(kx + 4, ky2, keyW - 22, 1);
  centered(g, F.bold, [["Island", ORANGE]], kx + keyW / 2 - 8, ky2 + 6);
  const facts = [["Trees", W.trees.length.toLocaleString("en")], ["Shrubs", W.shrubs.length.toLocaleString("en")], ["Rocks", W.rocks.length.toLocaleString("en")], ["Streams", String(W.rivers.length)], ["Campers", String(W.camp.people.length)]];
  facts.forEach(([a, b], n) => { text(g, F.plain, [[a, "#ffffff"]], kx + 8, ky2 + 28 + n * 16); text(g, F.plain, [[b, "#ffff00"]], kx + keyW - 22 - width(F.plain, b), ky2 + 28 + n * 16); });

  // bottom bar: zoom buttons and the overview toggle
  const by = SH - bot + 3;
  const button = (x, w, s) => { g.fillStyle = "#0b0a08"; g.fillRect(x, by, w, 22); stone(g, x + 1, by + 1, w - 2, 20, [80, 70, 55], 10, 74 + x); centered(g, F.plain, [[s, ORANGE]], x + w / 2, by + 4); };
  button(6, 24, "-"); button(34, 24, "+");
  text(g, F.plain, [["Zoom: 100%", ORANGE]], 66, by + 4);
  button(SW - keyW - 186, 90, "Overview"); button(SW - keyW - 92, 86, "Key");
  text(g, F.small, [[`Seed ${seed}  /  ${Math.round((x1 - x0) / 100) / 10} km across`, "#c8b890"]], SW - keyW + 8, by + 6);
}
