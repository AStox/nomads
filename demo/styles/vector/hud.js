// The cabinet's HUD, all in beam strokes: radar scope round the camp, compass tape, counters, target brackets.
import { clamp } from "../world.js";
import { PAL } from "./beam.js";
import { text, textWidth } from "./font.js";

const ring = (cx, cy, r, n = 48) => { const p = []; for (let k = 0; k < n; k++) { const a = (k / n) * 6.2832; p.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } return p; };
const pad = (v, n) => String(Math.max(0, Math.round(v))).padStart(n, "0");

function panel(beam, x, y, w, h, I) {
  const p = [x, y, x + w, y, x + w, y + h, x, y + h];
  beam.occlude(p);
  // corner ticks only, like a gunsight frame
  const t = 7, c = PAL.hud;
  for (const [ax, ay, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x + w, y + h, -1, -1], [x, y + h, 1, -1]]) beam.poly([ax + sx * t, ay, ax, ay, ax, ay + sy * t], false, c, I * 0.8, { ends: true });
}

export function hud(beam, info) {
  const { W, H } = beam, c = PAL.hud, I = 0.95;
  beam.J = 0.18;
  // ---------- radar ----------
  const R = 50, cx = W / 2, cy = 68, fh = info.fh, rx = -fh[1], rz = fh[0];
  beam.occlude(ring(cx, cy, R + 3, 32));
  beam.poly(ring(cx, cy, R), true, c, I);
  const half = ring(cx, cy, R / 2, 40);
  for (let k = 0; k < half.length; k += 4) beam.seg(half[k], half[k + 1], half[k + 2], half[k + 3], c, I * 0.45);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 6.2832, l = k % 3 ? 4 : 8;
    beam.seg(cx + Math.cos(a) * R, cy + Math.sin(a) * R, cx + Math.cos(a) * (R - l), cy + Math.sin(a) * (R - l), c, I * 0.8);
  }
  const toRadar = (dx, dz) => [cx + ((dx * rx + dz * rz) / info.range) * R, cy - ((dx * fh[0] + dz * fh[1]) / info.range) * R];
  // the sweep, with blips brightest just behind it as the phosphor decays
  const sweep = info.sweep, decay = (px, py) => { let a = Math.atan2(py - cy, px - cx) - sweep; a = ((a % 6.2832) + 6.2832) % 6.2832; return 0.35 + 1.1 * Math.exp(-(6.2832 - a) / 1.6); };
  // water as the same scan lines the scene uses, one run per row where the ground under it is wet
  for (let py = cy - R + 2; py < cy + R - 1; py += 3) {
    const half = Math.sqrt(Math.max(0, (R - 2) ** 2 - (py - cy) ** 2)), b = (-(py - cy) / R) * info.range;
    let run = null;
    for (let px = cx - half; px <= cx + half; px += 1.5) {
      const a = ((px - cx) / R) * info.range, wet = info.isWater(a * rx + b * fh[0], a * rz + b * fh[1]);
      if (wet && run === null) run = px;
      if (!wet && run !== null) { beam.seg(run, py, px - 1.5, py, PAL.water, 0.55 * decay((run + px) / 2, py), 1); run = null; }
    }
    if (run !== null) beam.seg(run, py, cx + half, py, PAL.water, 0.55 * decay((run + cx + half) / 2, py), 1);
  }
  for (const [dx, dz] of info.trees) { const [px, py] = toRadar(dx, dz); if (Math.hypot(px - cx, py - cy) < R - 2) beam.dot(px, py, PAL.plant, 0.55 * decay(px, py), 1.2); }
  for (let k = 0; k < 10; k++) {
    const a = sweep - k * 0.07;
    beam.seg(cx, cy, cx + Math.cos(a) * (R - 1), cy + Math.sin(a) * (R - 1), c, I * (k ? 0.28 * (1 - k / 10) : 1));
  }
  // north mark turns with the heading; the camera's field of view is a V opening upward
  const nb = toRadar(0, -info.range * 1.18);
  text(beam, "N", nb[0] - 3.5, nb[1] - 5, 10, c, I);
  if (info.eyeRel) {
    const [ex, ey] = toRadar(info.eyeRel[0], info.eyeRel[1]), inside = Math.hypot(ex - cx, ey - cy) < R - 3;
    const ox = inside ? ex : cx, oy = inside ? ey : cy + R - 3, hf = info.hfov / 2, L = R * 0.9;
    for (const s of [-1, 1]) {
      const x1 = ox + Math.sin(hf * s) * L, y1 = oy - Math.cos(hf * s) * L, t = clamp((R - 2 - Math.hypot(ox - cx, oy - cy)) / L, 0.2, 1);
      beam.seg(ox, oy, ox + (x1 - ox) * t, oy + (y1 - oy) * t, c, I * 0.5);
    }
    if (inside) beam.poly([ex - 3, ey + 3, ex, ey - 4, ex + 3, ey + 3], true, c, I, { ends: "all" });
  }
  beam.poly([cx - 4, cy, cx + 4, cy], false, PAL.camp, I, { ends: true });
  beam.poly([cx, cy - 4, cx, cy + 4], false, PAL.camp, I, { ends: true });
  beam.occlude([cx + R + 6, cy + R - 34, cx + R + 66, cy + R - 34, cx + R + 66, cy + R - 4, cx + R + 6, cy + R - 4]);
  text(beam, "RNG", cx + R + 12, cy + R - 30, 9, c, I * 0.8);
  text(beam, `${pad(info.range, 4)}M`, cx + R + 12, cy + R - 16, 9, c, I * 0.8);

  // ---------- compass tape ----------
  const ty = cy + R + 20, tw = 300, hd = info.heading;
  const names = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
  beam.occlude([cx - tw / 2 - 80, ty - 2, cx + tw / 2 + 4, ty - 2, cx + tw / 2 + 4, ty + 26, cx - tw / 2 - 80, ty + 26]);
  beam.seg(cx - tw / 2, ty + 10, cx + tw / 2, ty + 10, c, I * 0.5);
  for (let d = Math.ceil((hd - 50) / 5) * 5; d <= hd + 50; d += 5) {
    const x = cx + ((d - hd) / 50) * (tw / 2), n = ((d % 360) + 360) % 360, big = n % 15 === 0;
    const fall = 1 - Math.abs(d - hd) / 55;
    beam.seg(x, ty + 10, x, ty + (big ? 2 : 6), c, I * fall * (big ? 1 : 0.6));
    if (n % 45 === 0) text(beam, names[n], x, ty + 14, 9, c, I * fall, "c");
    else if (n % 15 === 0) text(beam, pad(n, 3), x, ty + 14, 7, c, I * fall * 0.7, "c");
  }
  beam.poly([cx - 5, ty - 6, cx, ty, cx + 5, ty - 6], false, c, I * 1.2, { ends: "all" });
  text(beam, `HDG ${pad(hd, 3)}`, cx - tw / 2 - 12, ty + 6, 9, c, I, "r");

  // ---------- counters ----------
  const rows = (x, y, list, align) => list.forEach(([k, v], n) => {
    const s = `${k} ${v}`;
    text(beam, s, align === "r" ? x : x, y + n * 22, 12, c, I, align);
  });
  panel(beam, 24, 20, 204, 84, I);
  rows(38, 32, [["DAY", pad(info.day, 3)], ["TREES", pad(info.treesInRange, 5)], ["WATER", `${pad(info.water, 4)}M`]], "l");
  panel(beam, W - 228, 20, 204, 84, I);
  rows(W - 38, 32, [["POP", pad(info.pop, 2)], ["ELEV", `${pad(info.elev, 4)}M`], ["ALT", `${pad(info.alt, 4)}M`]], "r");

  // ---------- target brackets: the camp from afar, a selected nomad up close ----------
  if (info.target) {
    const [tx, ty2, sw, sh, label, sub, below] = info.target, l = Math.max(6, Math.min(sw, sh) * 0.4);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) beam.poly([tx + sx * sw, ty2 + sy * (sh - l), tx + sx * sw, ty2 + sy * sh, tx + sx * (sw - l), ty2 + sy * sh], false, c, I, { ends: "all" });
    const lx = tx + sw + 16, ly = below ? ty2 + sh + 26 : ty2 - sh - 16;
    beam.poly([tx + sw, below ? ty2 + sh : ty2 - sh, lx, ly, lx + textWidth(label, 11) + 6, ly], false, c, I * 0.8, { ends: true });
    text(beam, label, lx + 3, ly - 15, 11, c, I);
    if (sub) text(beam, sub, lx + 3, ly + 5, 8, c, I * 0.75);
  }

  // ---------- bottom line ----------
  if (info.alert) text(beam, info.alert, W / 2, H - 58, 14, c, I * 1.1, "c");
  text(beam, info.status, 40, H - 44, 9, c, I * 0.75);
  text(beam, "NOMADS", W - 40, H - 50, 16, c, I, "r");
  beam.seg(W - 40 - textWidth("NOMADS", 16), H - 28, W - 40, H - 28, c, I * 0.6);
  beam.J = 0.28;
}
