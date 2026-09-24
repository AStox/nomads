// Procedural "inked atlas" art: watercolor terrain on parchment, sepia linework, painted glyphs.
export const T = 36; // pixels per tile in the prerendered layer
const INK = "#3a2a1a";
const PAPER = [239, 226, 194];
// grass, forest, water, rock
const WASH = [[186, 190, 122], [112, 138, 78], [120, 160, 172], [176, 160, 132]];

export function hash(x, y, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
const fbm = (x, y, s) => vnoise(x, y, s) * 0.6 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.1;

// Smooth per-terrain fields on a grid of R samples per tile, with a domain warp so borders wander.
const R = 4;
function fields(tiles, W, H) {
  const GW = W * R + 1, GH = H * R + 1;
  const f = [0, 1, 2, 3].map(() => new Float32Array(GW * GH));
  const tile = (x, y) => +tiles[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      let u = gx / R - 0.5, v = gy / R - 0.5;
      const wu = (fbm(u * 0.3, v * 0.3, 1) - 0.5) * 1.6 + (fbm(u * 1.1, v * 1.1, 3) - 0.5) * 0.7;
      const wv = (fbm(u * 0.3, v * 0.3, 2) - 0.5) * 1.6 + (fbm(u * 1.1, v * 1.1, 4) - 0.5) * 0.7;
      u += wu; v += wv;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const t = [tile(x0, y0), tile(x0 + 1, y0), tile(x0, y0 + 1), tile(x0 + 1, y0 + 1)];
      for (let i = 0; i < 4; i++) f[t[i]][gy * GW + gx] += w[i];
    }
  return { f, GW, GH };
}
function sampler({ f, GW, GH }) {
  return (k, u, v) => {
    u = Math.max(0, Math.min(GW - 1.001, u * R)); v = Math.max(0, Math.min(GH - 1.001, v * R));
    const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, a = f[k], i = y0 * GW + x0;
    return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + GW] * (1 - fx) + a[i + GW + 1] * fx) * fy;
  };
}

// Marching squares: one stroked path of contour segments at `level`.
function contour(ctx, { f, GW, GH }, k, level) {
  const a = f[k], s = T / R;
  ctx.beginPath();
  const lerp = (p, q) => (level - p) / (q - p);
  for (let y = 0; y < GH - 1; y++)
    for (let x = 0; x < GW - 1; x++) {
      const tl = a[y * GW + x], tr = a[y * GW + x + 1], br = a[(y + 1) * GW + x + 1], bl = a[(y + 1) * GW + x];
      const pts = [];
      if ((tl > level) !== (tr > level)) pts.push([x + lerp(tl, tr), y]);
      if ((tr > level) !== (br > level)) pts.push([x + 1, y + lerp(tr, br)]);
      if ((bl > level) !== (br > level)) pts.push([x + lerp(bl, br), y + 1]);
      if ((tl > level) !== (bl > level)) pts.push([x, y + lerp(tl, bl)]);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        ctx.moveTo(pts[i][0] * s, pts[i][1] * s);
        ctx.lineTo(pts[i + 1][0] * s, pts[i + 1][1] * s);
      }
    }
  ctx.stroke();
}

export function buildBase(tiles, W, H) {
  const F = fields(tiles, W, H), at = sampler(F);
  // Paint the washes at 8px per tile; the upscale gives the soft watercolor bleed for free.
  const P = 8, lw = W * P, lh = H * P;
  const low = new OffscreenCanvas(lw, lh), lc = low.getContext("2d");
  const img = lc.createImageData(lw, lh), d = img.data;
  for (let py = 0; py < lh; py++)
    for (let px = 0; px < lw; px++) {
      const u = (px + 0.5) / P, v = (py + 0.5) / P;
      let best = 0, bv = -1, second = -1;
      const vals = [0, 1, 2, 3].map((k) => at(k, u, v));
      vals.forEach((val, k) => { if (val > bv) { second = bv; bv = val; best = k; } else if (val > second) second = val; });
      const margin = bv - second;
      const pool = Math.max(0, 1 - margin * 4) * 0.16; // pigment pools at the edge of a wash
      const mottle = (fbm(u * 0.6, v * 0.6, 5) - 0.5) * 0.16 + (fbm(u * 3, v * 3, 9) - 0.5) * 0.06;
      let [r, g, b] = WASH[best];
      if (best === 2) {
        const deep = Math.min(1, Math.max(0, (vals[2] - 0.55) * 2.2));
        r -= deep * 38; g -= deep * 34; b -= deep * 22;
      }
      const cover = best === 2 ? 0.92 : 0.8;
      const k = 1 + mottle - pool;
      const i = (py * lw + px) * 4;
      d[i] = (PAPER[0] * (1 - cover) + r * cover) * k;
      d[i + 1] = (PAPER[1] * (1 - cover) + g * cover) * k;
      d[i + 2] = (PAPER[2] * (1 - cover) + b * cover) * k;
      d[i + 3] = 255;
    }
  lc.putImageData(img, 0, 0);

  const base = new OffscreenCanvas(W * T, H * T), c = base.getContext("2d");
  c.imageSmoothingQuality = "high";
  c.drawImage(low, 0, 0, W * T, H * T);

  // Paper grain
  const grain = new OffscreenCanvas(160, 160), gc = grain.getContext("2d"), gi = gc.createImageData(160, 160);
  for (let i = 0; i < gi.data.length; i += 4) {
    const n = Math.random() * 255;
    gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = n; gi.data[i + 3] = 255;
  }
  gc.putImageData(gi, 0, 0);
  c.globalCompositeOperation = "multiply"; c.globalAlpha = 0.07;
  c.fillStyle = c.createPattern(grain, "repeat"); c.fillRect(0, 0, W * T, H * T);
  c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;

  // Rock hatching and grass tufts
  c.lineCap = "round";
  for (let y = 0; y < H * 2; y++)
    for (let x = 0; x < W * 2; x++) {
      const u = (x + hash(x, y, 3)) / 2, v = (y + hash(x, y, 4)) / 2, h = hash(x, y, 6);
      const rock = at(3, u, v), grass = at(0, u, v);
      const px = u * T, py = v * T;
      if (rock > 0.6 && h < 0.55) {
        c.strokeStyle = "rgba(70, 55, 38, .38)"; c.lineWidth = 1.1;
        c.beginPath();
        for (let j = 0; j < 3; j++) { c.moveTo(px + j * 3.5 - 5, py + 4); c.lineTo(px + j * 3.5 - 1, py - 3); }
        c.stroke();
      } else if (grass > 0.7 && h < 0.16) {
        c.strokeStyle = "rgba(80, 90, 40, .45)"; c.lineWidth = 1;
        c.beginPath();
        c.moveTo(px - 3, py - 3); c.quadraticCurveTo(px - 1, py, px, py + 2);
        c.moveTo(px + 3, py - 4); c.quadraticCurveTo(px + 1, py, px, py + 2);
        c.moveTo(px, py - 5); c.lineTo(px, py + 2);
        c.stroke();
      }
    }

  // Ink: forest edges, shore ripples, coastline
  c.lineJoin = "round";
  c.strokeStyle = "rgba(48, 66, 32, .32)"; c.lineWidth = 1.1; contour(c, F, 1, 0.5);
  c.strokeStyle = "rgba(58, 42, 26, .18)"; c.lineWidth = 1; contour(c, F, 2, 0.78);
  c.strokeStyle = "rgba(58, 42, 26, .28)"; c.lineWidth = 1; contour(c, F, 2, 0.64);
  c.strokeStyle = "rgba(58, 42, 26, .85)"; c.lineWidth = 1.8; contour(c, F, 2, 0.5);

  // Frame vignette baked into the paper edge
  const g = c.createRadialGradient(W * T / 2, H * T / 2, W * T * 0.35, W * T / 2, H * T / 2, W * T * 0.75);
  g.addColorStop(0, "rgba(90, 60, 30, 0)"); g.addColorStop(1, "rgba(90, 60, 30, .28)");
  c.fillStyle = g; c.fillRect(0, 0, W * T, H * T);
  return base;
}

// ---------- glyphs ----------
function shadow(c, x, y, w, h = w * 0.35) {
  c.fillStyle = "rgba(50, 35, 20, .22)";
  c.beginPath(); c.ellipse(x, y, w, h, 0, 0, Math.PI * 2); c.fill();
}
function inked(c, fill, lw = 1.2) {
  c.fillStyle = fill; c.fill();
  c.strokeStyle = INK; c.lineWidth = lw; c.stroke();
}
const PINES = ["#4c6b3c", "#557545", "#46633a", "#5c7a45"];
const LEAVES = ["#6b8a44", "#77924a", "#5f7f3d"];

export function drawThing(c, th, ownerColor) {
  const cx = th.x * T + T / 2, cy = th.y * T + T / 2, r = hash(th.x, th.y, 11), r2 = hash(th.x, th.y, 12);
  const jx = (r - 0.5) * T * 0.25, jy = (r2 - 0.5) * T * 0.2;
  const x = cx + jx, y = cy + jy;
  c.lineJoin = "round"; c.lineCap = "round";
  switch (th.kind) {
    case "tree": {
      const s = T * (0.95 + r * 0.3);
      shadow(c, x + 2, y + s * 0.34, s * 0.34);
      if (r2 < 0.72) {
        c.fillStyle = "#6b4a2b"; c.fillRect(x - s * 0.05, y + s * 0.14, s * 0.1, s * 0.2);
        const col = PINES[Math.floor(r * PINES.length)];
        for (let i = 0; i < 3; i++) {
          const ty = y - s * 0.58 + i * s * 0.22, hw = s * (0.2 + i * 0.09);
          c.beginPath(); c.moveTo(x, ty); c.lineTo(x + hw, ty + s * 0.34); c.lineTo(x - hw, ty + s * 0.34); c.closePath();
          inked(c, col);
        }
        c.strokeStyle = "rgba(240, 230, 190, .35)"; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(x - 1, y - s * 0.5); c.lineTo(x - s * 0.18, y - s * 0.2); c.stroke();
      } else {
        c.fillStyle = "#6b4a2b"; c.fillRect(x - s * 0.05, y, s * 0.1, s * 0.34);
        c.strokeStyle = INK; c.lineWidth = 1; c.strokeRect(x - s * 0.05, y, s * 0.1, s * 0.34);
        const col = LEAVES[Math.floor(r * LEAVES.length)];
        c.beginPath();
        c.arc(x - s * 0.14, y - s * 0.06, s * 0.2, 0, Math.PI * 2);
        c.arc(x + s * 0.14, y - s * 0.08, s * 0.2, 0, Math.PI * 2);
        c.arc(x, y - s * 0.26, s * 0.23, 0, Math.PI * 2);
        c.fillStyle = col; c.fill();
        c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke();
        c.fillStyle = col;
        c.beginPath(); c.arc(x, y - s * 0.12, s * 0.2, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case "stump": {
      const s = T * 0.5;
      shadow(c, x + 1, y + s * 0.35, s * 0.45);
      c.beginPath(); c.rect(x - s * 0.32, y - s * 0.05, s * 0.64, s * 0.36); inked(c, "#7a5533");
      c.beginPath(); c.ellipse(x, y - s * 0.05, s * 0.32, s * 0.13, 0, 0, Math.PI * 2); inked(c, "#c9a06a");
      c.strokeStyle = "rgba(90, 60, 30, .6)"; c.lineWidth = 0.8;
      c.beginPath(); c.ellipse(x, y - s * 0.05, s * 0.16, s * 0.06, 0, 0, Math.PI * 2); c.stroke();
      break;
    }
    case "bush": {
      const s = T * 0.62;
      shadow(c, x + 1, y + s * 0.34, s * 0.5);
      c.beginPath();
      c.arc(x - s * 0.24, y + s * 0.04, s * 0.26, 0, Math.PI * 2);
      c.arc(x + s * 0.24, y + s * 0.04, s * 0.26, 0, Math.PI * 2);
      c.arc(x, y - s * 0.14, s * 0.3, 0, Math.PI * 2);
      c.fillStyle = "#6f9443"; c.fill(); c.strokeStyle = INK; c.lineWidth = 1.1; c.stroke();
      c.fillStyle = "#6f9443"; c.beginPath(); c.arc(x, y, s * 0.26, 0, Math.PI * 2); c.fill();
      c.fillStyle = "rgba(230, 240, 180, .35)"; c.beginPath(); c.arc(x - s * 0.08, y - s * 0.22, s * 0.12, 0, Math.PI * 2); c.fill();
      const n = th.n ?? 0;
      for (let i = 0; i < Math.min(6, n * 2); i++) {
        const a = hash(th.x, th.y, 20 + i) * Math.PI * 2, rr = s * (0.1 + hash(th.x, th.y, 30 + i) * 0.3);
        c.beginPath(); c.arc(x + Math.cos(a) * rr, y - s * 0.05 + Math.sin(a) * rr * 0.7, s * 0.075, 0, Math.PI * 2);
        c.fillStyle = "#c2313a"; c.fill(); c.strokeStyle = "rgba(60, 10, 10, .75)"; c.lineWidth = 0.7; c.stroke();
      }
      break;
    }
    case "mushroom": {
      const s = T * 0.46;
      shadow(c, x, y + s * 0.4, s * 0.35);
      c.beginPath(); c.rect(x - s * 0.1, y, s * 0.2, s * 0.38); inked(c, "#efe4c8", 1);
      c.beginPath(); c.arc(x, y + s * 0.02, s * 0.36, Math.PI, 0); c.closePath(); inked(c, "#b8412e");
      c.fillStyle = "#f4ead0";
      for (const [dx, dy] of [[-0.16, -0.12], [0.1, -0.2], [0.2, -0.05]]) { c.beginPath(); c.arc(x + dx * s, y + dy * s, s * 0.05, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case "stick": {
      const s = T * 0.5, a = r * Math.PI;
      c.strokeStyle = INK; c.lineWidth = 3.6;
      c.beginPath(); c.moveTo(x - Math.cos(a) * s * 0.5, y - Math.sin(a) * s * 0.3); c.lineTo(x + Math.cos(a) * s * 0.5, y + Math.sin(a) * s * 0.3); c.stroke();
      c.strokeStyle = "#8a6038"; c.lineWidth = 2;
      c.stroke();
      break;
    }
    case "stone": {
      const s = T * 0.42;
      shadow(c, x + 1, y + s * 0.3, s * 0.55);
      c.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2, rr = s * (0.36 + hash(th.x, th.y, 40 + i) * 0.14);
        const px = x + Math.cos(a) * rr * 1.2, py = y + Math.sin(a) * rr * 0.8;
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.closePath(); inked(c, "#a59c8c", 1.1);
      c.strokeStyle = "rgba(255, 250, 235, .5)"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(x - s * 0.25, y - s * 0.1); c.lineTo(x - s * 0.05, y - s * 0.22); c.stroke();
      break;
    }
    case "shelter": {
      const s = T * 1.5;
      shadow(c, x + 3, y + s * 0.26, s * 0.5, s * 0.16);
      c.beginPath(); c.moveTo(x - s * 0.44, y + s * 0.24); c.lineTo(x, y - s * 0.34); c.lineTo(x + s * 0.44, y + s * 0.24); c.closePath();
      inked(c, "#c7a15c", 1.5);
      c.strokeStyle = "rgba(90, 60, 25, .55)"; c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < 6; i++) { const t = i / 6; c.moveTo(x, y - s * 0.34); c.lineTo(x - s * 0.44 + t * s * 0.88, y + s * 0.24); }
      c.stroke();
      c.beginPath(); c.moveTo(x - s * 0.12, y + s * 0.24); c.lineTo(x, y - s * 0.02); c.lineTo(x + s * 0.12, y + s * 0.24); c.closePath();
      inked(c, "#3a2a1a", 1);
      c.strokeStyle = INK; c.lineWidth = 1.6;
      c.beginPath(); c.moveTo(x - s * 0.08, y - s * 0.44); c.lineTo(x + s * 0.08, y - s * 0.26); c.moveTo(x + s * 0.08, y - s * 0.44); c.lineTo(x - s * 0.08, y - s * 0.26); c.stroke();
      if (ownerColor) {
        c.strokeStyle = INK; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(x + s * 0.3, y + s * 0.12); c.lineTo(x + s * 0.3, y - s * 0.3); c.stroke();
        c.beginPath(); c.moveTo(x + s * 0.3, y - s * 0.3); c.lineTo(x + s * 0.5, y - s * 0.24); c.lineTo(x + s * 0.3, y - s * 0.17); c.closePath();
        inked(c, ownerColor, 1);
      }
      break;
    }
  }
}

// Fires are drawn live so they flicker.
export function drawFire(c, x, y, s, now, seed) {
  c.save();
  c.translate(x, y);
  c.lineJoin = "round";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    c.beginPath(); c.ellipse(Math.cos(a) * s * 0.28, Math.sin(a) * s * 0.12 + s * 0.12, s * 0.09, s * 0.06, 0, 0, Math.PI * 2);
    c.fillStyle = "#9a9080"; c.fill(); c.strokeStyle = INK; c.lineWidth = 0.8; c.stroke();
  }
  const t = now / 140 + seed * 10;
  const flame = (h, w, col) => {
    const f1 = Math.sin(t) * 0.08, f2 = Math.cos(t * 1.3) * 0.08;
    c.beginPath();
    c.moveTo(-w * s, s * 0.1);
    c.quadraticCurveTo(-w * s * 1.1, -h * s * 0.4, (f1 - 0.02) * s, -h * s);
    c.quadraticCurveTo(w * s * 1.1 + f2 * s, -h * s * 0.4, w * s, s * 0.1);
    c.closePath();
    c.fillStyle = col; c.fill();
  };
  flame(0.62 + Math.sin(t * 1.7) * 0.06, 0.2, "#c4541d");
  flame(0.44 + Math.cos(t * 2.1) * 0.05, 0.13, "#e8952e");
  flame(0.24, 0.07, "#f6d68a");
  c.restore();
}

// Wax-seal token for a person.
export function drawToken(c, a, x, y, r, now, selected) {
  c.save();
  shadowEllipse(c, x, y + r * 0.9, r * 0.8);
  if (selected) {
    c.strokeStyle = "#a8321f"; c.lineWidth = 2; c.setLineDash([4, 4]); c.lineDashOffset = -now / 60;
    c.beginPath(); c.arc(x, y, r + 6, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  }
  c.beginPath();
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2, rr = r * (1 + (hash(i, a.name.length, 7) - 0.5) * 0.12);
    const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath();
  const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r * 1.1);
  g.addColorStop(0, lighten(a.color, 1.35)); g.addColorStop(1, a.color);
  c.fillStyle = g; c.fill();
  c.strokeStyle = "rgba(30, 18, 10, .7)"; c.lineWidth = 1.2; c.stroke();
  c.beginPath(); c.arc(x, y, r * 0.72, 0, Math.PI * 2);
  c.strokeStyle = "rgba(255, 240, 210, .45)"; c.lineWidth = 1; c.stroke();
  if (r >= 9) {
    c.fillStyle = "rgba(255, 244, 222, .95)";
    c.font = `${Math.round(r * 1.05)}px "IM Fell English", serif`;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(a.name[0], x, y + r * 0.08);
  }
  c.restore();
}
function shadowEllipse(c, x, y, w) {
  c.fillStyle = "rgba(40, 25, 10, .28)";
  c.beginPath(); c.ellipse(x, y, w, w * 0.32, 0, 0, Math.PI * 2); c.fill();
}
export function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.min(255, Math.round(v * k));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

export function drawLabel(c, text, x, y) {
  c.save();
  c.font = `600 13px "Alegreya Sans", sans-serif`;
  const w = c.measureText(text).width + 14, h = 18;
  c.fillStyle = "rgba(243, 234, 214, .94)";
  c.strokeStyle = "rgba(58, 42, 26, .75)"; c.lineWidth = 1;
  c.beginPath();
  c.moveTo(x - w / 2, y); c.lineTo(x + w / 2, y); c.lineTo(x + w / 2 - 4, y + h / 2); c.lineTo(x + w / 2, y + h);
  c.lineTo(x - w / 2, y + h); c.lineTo(x - w / 2 + 4, y + h / 2); c.closePath();
  c.fill(); c.stroke();
  c.fillStyle = INK; c.textAlign = "center"; c.textBaseline = "middle";
  c.fillText(text, x, y + h / 2 + 0.5);
  c.restore();
}

export function drawThinking(c, x, y, now) {
  c.save();
  c.fillStyle = "rgba(243, 234, 214, .96)"; c.strokeStyle = "rgba(58, 42, 26, .8)"; c.lineWidth = 1;
  c.beginPath(); c.roundRect(x - 13, y - 9, 26, 16, 8); c.fill(); c.stroke();
  for (let i = 0; i < 3; i++) {
    c.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.sin(now / 200 - i * 0.9));
    c.fillStyle = INK; c.beginPath(); c.arc(x - 6 + i * 6, y - 1, 1.8, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}
export function drawSleep(c, x, y, now) {
  c.save();
  c.fillStyle = "#3a2a1a"; c.font = `italic 600 12px "IM Fell English", serif`;
  const k = (now / 900) % 1;
  c.globalAlpha = 1 - k; c.fillText("z", x, y - k * 8);
  c.globalAlpha = 1 - ((k + 0.5) % 1); c.fillText("z", x + 6, y - 6 - ((k + 0.5) % 1) * 8);
  c.restore();
}
