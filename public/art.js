// Procedural "inked atlas" art: watercolor terrain on parchment, sepia linework, painted glyphs.
export const T = 36; // pixels per tile in the prerendered layer
const INK = "#3a2a1a";
const PAPER = [239, 226, 194];
// Watercolor for each kind of ground cover, muted to sit on parchment. Grass runs from dry straw to lush green with
// the water its roots can find; open water deepens from the shallows.
const PAINT = { tree: [100, 128, 72], shrub: [150, 122, 116], marsh: [114, 140, 106], bare: [174, 162, 140], sand: [228, 212, 164] };
const STRAW = [206, 192, 126], LUSH = [166, 188, 106], SHALLOW = [128, 170, 176], DEEP = [72, 112, 140];
const COVER = ["tree", "shrub", "grass", "marsh", "bare", "sand", "moist"];
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * Math.max(0, Math.min(1, t)));
// Isometric view: a tile is a 2*HW by 2*HH diamond, one unit of ground height lifts ZH pixels,
// and the map's cut edge drops SLAB units below the waterline.
export const HW = 26, HH = 13, ZH = 26;
const SLAB = 1.6;
// Light from the upper left of the screen, the map's -u side. RELIEF exaggerates slopes for the shading.
const LIGHT = [-1, -0.3, 1.2].map((v) => v / Math.hypot(1, 0.3, 1.2));
const RELIEF = 2;

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

// Per-tile ground cover on a grid of R samples per tile, with a domain warp so borders wander the way washes do.
const R = 4;
function fields(cover, W, H) {
  const GW = W * R + 1, GH = H * R + 1;
  const src = COVER.map((k) => cover[k]), f = src.map(() => new Float32Array(GW * GH));
  const at = (a, x, y) => a[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      let u = gx / R - 0.5, v = gy / R - 0.5;
      const wu = (fbm(u * 0.3, v * 0.3, 1) - 0.5) * 1.2 + (fbm(u * 1.1, v * 1.1, 3) - 0.5) * 0.6;
      const wv = (fbm(u * 0.3, v * 0.3, 2) - 0.5) * 1.2 + (fbm(u * 1.1, v * 1.1, 4) - 0.5) * 0.6;
      u += wu; v += wv;
      const x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
      for (let k = 0; k < src.length; k++) {
        const a = src[k];
        f[k][gy * GW + gx] = (at(a, x0, y0) * (1 - fx) + at(a, x0 + 1, y0) * fx) * (1 - fy) + (at(a, x0, y0 + 1) * (1 - fx) + at(a, x0 + 1, y0 + 1) * fx) * fy;
      }
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
// Bilinear read of the island's cells at tile coordinates; cell centers sit half a cell in from their corner.
function cells(g, n, W) {
  const k = n / W;
  return (u, v) => {
    const x = Math.max(0, Math.min(n - 1.001, u * k - 0.5)), y = Math.max(0, Math.min(n - 1.001, v * k - 0.5));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * n + x0;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + n] * (1 - fx) + g[i + n + 1] * fx) * fy;
  };
}
// The server's packed island: elevation and standing water per cell, cover per tile, streams as lines.
export function readTerrain(t) {
  const bytes = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
  const height = Float32Array.from(new Uint16Array(bytes(t.ground).buffer), (v) => v / 10 - 100);
  const water = Float32Array.from(bytes(t.water), (v) => v / 4);
  const cover = Object.fromEntries(Object.entries(t.cover).map(([k, s]) => [k, Float32Array.from(bytes(s), (v) => v / 255)]));
  return { ...t, height, water, cover };
}
// Corner-cutting smooths the cell-to-cell path a stream took into a curve; each point carries its discharge.
function chaikin(pts) {
  const out = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push(a.map((v, k) => v * 0.75 + b[k] * 0.25), a.map((v, k) => v * 0.25 + b[k] * 0.75));
  }
  out.push(pts.at(-1));
  return out;
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
// Depth of standing water, run negative over the land next to it: each dry cell measures itself against the highest
// water surface beside it. The shore then falls where the ground rises through the surface, not along cell edges.
function signedDepth({ n, height, water }) {
  const out = Float32Array.from(water);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (water[i] > 0) continue;
      let level = -Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * n + x + dx;
          if (x + dx >= 0 && y + dy >= 0 && x + dx < n && y + dy < n && water[j] > 0) level = Math.max(level, height[j] + water[j]);
        }
      out[i] = Math.max(-2, Math.min(-0.05, level - height[i]));
    }
  return out;
}

export function buildBase(view, ground) {
  const { W, H } = view, n = ground.n, meters = ground.tile / (n / W);
  const F = fields(ground.cover, W, H), field = sampler(F);
  const depth = cells(signedDepth(ground), n, W);
  // Slopes for the shading, from the water surface or ground of each cell: central differences, blended between cells,
  // so the light picks out every spur and gully the rivers carved, not just the tiles the map is drawn with.
  const surface = Float32Array.from(ground.height, (h, i) => Math.max(0, h + ground.water[i]));
  const su = new Float32Array(n * n), sv = new Float32Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(n - 1, x + 1), y0 = Math.max(0, y - 1), y1 = Math.min(n - 1, y + 1);
      su[y * n + x] = ((surface[y * n + x1] - surface[y * n + x0]) / ((x1 - x0) * meters)) * RELIEF;
      sv[y * n + x] = ((surface[y1 * n + x] - surface[y0 * n + x]) / ((y1 - y0) * meters)) * RELIEF;
    }
  const slopeU = cells(su, n, W), slopeV = cells(sv, n, W), elevation = cells(surface, n, W);
  // Paint the washes at 8px per tile; the upscale gives the soft watercolor bleed for free.
  const P = 8, lw = W * P, lh = H * P;
  const low = new OffscreenCanvas(lw, lh), lc = low.getContext("2d");
  const img = lc.createImageData(lw, lh), d = img.data;
  const iceLow = new OffscreenCanvas(lw, lh), ic = iceLow.getContext("2d"), iceImg = ic.createImageData(lw, lh), id = iceImg.data;
  for (let py = 0; py < lh; py++)
    for (let px = 0; px < lw; px++) {
      const u = (px + 0.5) / P, v = (py + 0.5) / P, wet = depth(u, v);
      const mottle = (fbm(u * 0.6, v * 0.6, 5) - 0.5) * 0.16 + (fbm(u * 3, v * 3, 9) - 0.5) * 0.06;
      let rgb, cover = 0.92, k = 1 + mottle;
      if (wet > 0) rgb = mix(SHALLOW, DEEP, (wet - 0.3) / 14);
      else {
        const tree = field(0, u, v), shrub = field(1, u, v), grass = field(2, u, v), marsh = field(3, u, v), bare = field(4, u, v);
        const sand = field(5, u, v), moist = field(6, u, v), sum = tree + shrub + grass + marsh + bare || 1, lush = mix(STRAW, LUSH, moist);
        rgb = [0, 1, 2].map((c) => (tree * PAINT.tree[c] + shrub * PAINT.shrub[c] + grass * lush[c] + marsh * PAINT.marsh[c] + bare * PAINT.bare[c]) / sum);
        rgb = mix(rgb, PAINT.sand, sand * 1.4);
        // Pigment pools where one kind of ground gives way to another.
        const shares = [tree, shrub, grass, marsh, bare].sort((a, b) => b - a);
        const pool = Math.max(0, 1 - ((shares[0] - shares[1]) / sum) * 3) * 0.12;
        // Hillshade: slopes turned to the light brighten, the far sides darken.
        const gu = slopeU(u, v), gv = slopeV(u, v);
        const lit = (LIGHT[2] - gu * LIGHT[0] - gv * LIGHT[1]) / Math.hypot(gu, gv, 1) - LIGHT[2];
        cover = 0.8; k = (1 + mottle - pool) * (1 + lit * 0.45);
      }
      const i = (py * lw + px) * 4;
      d[i] = (PAPER[0] * (1 - cover) + rgb[0] * cover) * k;
      d[i + 1] = (PAPER[1] * (1 - cover) + rgb[1] * cover) * k;
      d[i + 2] = (PAPER[2] * (1 - cover) + rgb[2] * cover) * k;
      d[i + 3] = 255;
      // Ice fades out just inside the shore so the inked coastline stays visible.
      const ia = Math.max(0, Math.min(1, (wet - 0.3) * 3)), deep = Math.min(1, Math.max(0, (wet - 2) / 10));
      const ik = 1 + mottle * 0.6;
      id[i] = (228 - deep * 22) * ik; id[i + 1] = (238 - deep * 14) * ik; id[i + 2] = (242 - deep * 6) * ik; id[i + 3] = ia * 245;
    }
  lc.putImageData(img, 0, 0);
  ic.putImageData(iceImg, 0, 0);

  const base = new OffscreenCanvas(W * T, H * T), c = base.getContext("2d");
  c.imageSmoothingQuality = "high";
  c.drawImage(low, 0, 0, W * T, H * T);

  // Paper grain
  const grain = new OffscreenCanvas(160, 160), gc = grain.getContext("2d"), gi = gc.createImageData(160, 160);
  for (let i = 0; i < gi.data.length; i += 4) {
    const g = Math.random() * 255;
    gi.data[i] = gi.data[i + 1] = gi.data[i + 2] = g; gi.data[i + 3] = 255;
  }
  gc.putImageData(gi, 0, 0);
  c.globalCompositeOperation = "multiply"; c.globalAlpha = 0.07;
  c.fillStyle = c.createPattern(grain, "repeat"); c.fillRect(0, 0, W * T, H * T);
  c.globalCompositeOperation = "source-over"; c.globalAlpha = 1;

  // Grass tufts, rock hatching, heather and reeds stand upright, so they're kept as marks and drawn over the terrain.
  const marks = [];
  for (let y = 0; y < H * 2; y++)
    for (let x = 0; x < W * 2; x++) {
      const u = (x + hash(x, y, 3)) / 2, v = (y + hash(x, y, 4)) / 2, h = hash(x, y, 6);
      if (depth(u, v) > 0) continue;
      if (field(4, u, v) > 0.5 && h < 0.5) marks.push([u, v, 1]);
      else if (field(3, u, v) > 0.4 && h < 0.35) marks.push([u, v, 3]);
      else if (field(1, u, v) > 0.45 && h < 0.3) marks.push([u, v, 2]);
      else if (field(2, u, v) > 0.55 && h < 0.18) marks.push([u, v, 0]);
    }

  // Streams, smoothed from the cell-by-cell path the water took, widening downstream: ink under, water over.
  const widths = [1.3, 1.9, 2.6, 3.4, 4.4];
  const beds = widths.map(() => new Path2D());
  for (const line of ground.rivers) {
    const pts = chaikin(chaikin(line.map(([x, y, q]) => [x * T, y * T, q])));
    for (let i = 1; i < pts.length; i++) {
      const q = (pts[i - 1][2] + pts[i][2]) / 2, k = Math.max(0, Math.min(widths.length - 1, Math.floor(Math.sqrt(q / 0.02) - 1)));
      beds[k].moveTo(pts[i - 1][0], pts[i - 1][1]);
      beds[k].lineTo(pts[i][0], pts[i][1]);
    }
  }
  c.lineJoin = "round"; c.lineCap = "round";
  beds.forEach((p, k) => { c.strokeStyle = "rgba(58, 42, 26, .35)"; c.lineWidth = widths[k] + 1.4; c.stroke(p); });
  beds.forEach((p, k) => { c.strokeStyle = "rgba(96, 140, 160, .95)"; c.lineWidth = widths[k]; c.stroke(p); });

  // Ink: forest edges, shore ripples, coastline.
  const grid = (read) => {
    const g = { f: [new Float32Array(F.GW * F.GH)], GW: F.GW, GH: F.GH };
    for (let gy = 0; gy < F.GH; gy++) for (let gx = 0; gx < F.GW; gx++) g.f[0][gy * F.GW + gx] = read(gx / R, gy / R);
    return g;
  };
  const shore = grid(depth);
  c.strokeStyle = "rgba(48, 66, 32, .32)"; c.lineWidth = 1.1; contour(c, F, 0, 0.5);
  c.strokeStyle = "rgba(58, 42, 26, .18)"; c.lineWidth = 1; contour(c, shore, 0, 4);
  c.strokeStyle = "rgba(58, 42, 26, .28)"; c.lineWidth = 1; contour(c, shore, 0, 1.5);
  c.strokeStyle = "rgba(58, 42, 26, .85)"; c.lineWidth = 1.8; contour(c, shore, 0, 0);
  // Faint height contours every 50 m and a firmer one every 250 m, like an atlas.
  const rise = grid(elevation);
  let top = 0;
  for (const h of surface) top = Math.max(top, h);
  for (let level = 50; level < top; level += 50) {
    c.strokeStyle = level % 250 ? "rgba(92, 64, 36, .16)" : "rgba(92, 64, 36, .3)"; c.lineWidth = level % 250 ? 0.8 : 1.1;
    contour(c, rise, 0, level);
  }

  // Frame vignette baked into the paper edge
  const g = c.createRadialGradient(W * T / 2, H * T / 2, W * T * 0.35, W * T / 2, H * T / 2, W * T * 0.75);
  g.addColorStop(0, "rgba(90, 60, 30, 0)"); g.addColorStop(1, "rgba(90, 60, 30, .28)");
  c.fillStyle = g; c.fillRect(0, 0, W * T, H * T);
  return { base, ice: iceLow, marks };
}

// ---------- isometric terrain ----------
// Layer positions for a W x H map with corner heights `real` (in tile widths), the ground height anywhere as drawn,
// and the map's silhouette.
export function isoView(real, W, H) {
  const C = W + 1;
  // Ground that rises toward the camera faster than it drops on screen would hide what's behind it, and glyphs are
  // drawn over the terrain on the promise that it never does. So the whole island is drawn at whatever height keeps
  // all but its very steepest faces inside that, and those few are trimmed.
  const rise = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * C + x, back = real[i + 1] + real[i + C] - 2 * real[i], front = 2 * real[i + C + 1] - real[i + 1] - real[i + C];
      rise.push(Math.max(back, front));
    }
  rise.sort((a, b) => a - b);
  const lift = Math.min(1, 0.95 / Math.max(1e-6, rise[Math.floor(rise.length * 0.995)]));
  const hs = real.map((v) => v * lift);
  for (let i = 0; i < hs.length; i++) {
    if (i % C) hs[i] = Math.min(hs[i], hs[i - 1] + 0.475);
    if (i >= C) hs[i] = Math.min(hs[i], hs[i - C] + 0.475);
  }
  const top = Math.max(...hs);
  const OX = T + H * HW, OY = top * ZH + T * 1.8;
  // Each tile is two flat triangles split between its (x+1, y) and (x, y+1) corners; heights follow them exactly.
  const z = (u, v) => {
    u = Math.max(0, Math.min(W, u)); v = Math.max(0, Math.min(H, v));
    const x = Math.min(W - 1, Math.floor(u)), y = Math.min(H - 1, Math.floor(v)), fx = u - x, fy = v - y, i = y * C + x;
    return fx + fy <= 1
      ? hs[i] + (hs[i + 1] - hs[i]) * fx + (hs[i + C] - hs[i]) * fy
      : hs[i + C + 1] + (hs[i + C] - hs[i + C + 1]) * (1 - fx) + (hs[i + 1] - hs[i + C + 1]) * (1 - fy);
  };
  const at = (u, v, h = z(u, v)) => [OX + (u - v) * HW, OY + (u + v) * HH - h * ZH];
  // No slope faces away from the camera, so the back edges are the top of the silhouette and the cut is the bottom.
  const outline = new Path2D();
  for (let v = H; v >= 0; v--) outline.lineTo(...at(0, v));
  for (let u = 1; u <= W; u++) outline.lineTo(...at(u, 0));
  for (const [u, v] of [[W, 0], [W, H], [0, H]]) outline.lineTo(...at(u, v, -SLAB));
  outline.closePath();
  return { W, H, OX, OY, top, lift, hs, z, at, outline, width: Math.ceil(2 * T + (W + H) * HW), height: Math.ceil(OY + (W + H) * HH + SLAB * ZH + T) };
}

// Calls fn(x, y) for every tile whose ground can show inside layer rect r grown by pad, back to front.
export function eachTile(view, r, pad, fn) {
  const { W, H, OX, OY, top } = view;
  const e0 = Math.max(-H, Math.floor((r[0] - pad - OX) / HW) - 1), e1 = Math.min(W, Math.ceil((r[2] + pad - OX) / HW) + 1);
  const d0 = Math.max(0, Math.floor((r[1] - pad - OY) / HH) - 2), d1 = Math.min(W + H - 2, Math.ceil((r[3] + pad - OY + top * ZH) / HH) + 1);
  for (let d = d0; d <= d1; d++)
    for (let e = e0 + ((e0 + d) & 1); e <= e1; e += 2) {
      const x = (d + e) / 2, y = (d - e) / 2;
      if (x >= 0 && y >= 0 && x < W && y < H) fn(x, y);
    }
}

// One tile of terrain: its square of the top-down ground laid over its two triangles. Each triangle's clip is
// grown a little so neighbors overlap instead of leaving hairline seams.
export function drawTile(c, ground, view, x, y) {
  const sx = Math.max(0, x * T - 1), sy = Math.max(0, y * T - 1);
  const sw = Math.min(ground.width - sx, T + 2), sh = Math.min(ground.height - sy, T + 2);
  for (const s of [1, -1]) {
    const ox = s > 0 ? x : x + 1, oy = s > 0 ? y : y + 1;
    const p = view.at(ox, oy), pu = view.at(ox + s, oy), pv = view.at(ox, oy + s);
    const gx = (p[0] + pu[0] + pv[0]) / 3, gy = (p[1] + pu[1] + pv[1]) / 3;
    c.save();
    c.beginPath();
    for (const q of [p, pu, pv]) {
      const k = 1 + 0.7 / Math.hypot(q[0] - gx, q[1] - gy);
      c.lineTo(gx + (q[0] - gx) * k, gy + (q[1] - gy) * k);
    }
    c.clip();
    const a = ((pu[0] - p[0]) * s) / T, b = ((pu[1] - p[1]) * s) / T, cx = ((pv[0] - p[0]) * s) / T, cy = ((pv[1] - p[1]) * s) / T;
    c.transform(a, b, cx, cy, p[0] - (a * ox + cx * oy) * T, p[1] - (b * ox + cy * oy) * T);
    c.drawImage(ground, sx, sy, sw, sh, sx, sy, sw, sh);
    c.restore();
  }
}

// The cut along the map's two front edges: earth with a little strata, and water in section where it meets the cut.
export function drawSlab(c, view, tiles) {
  const { W, H, at } = view;
  const sides = [
    { fill: "#a88c5f", n: W, p: (i) => [i, H], tile: (i) => tiles[(H - 1) * W + i] },
    { fill: "#8b6f45", n: H, p: (i) => [W, i], tile: (i) => tiles[i * W + W - 1] },
  ];
  c.save();
  c.lineJoin = "round";
  for (const { fill, n, p, tile } of sides) {
    const face = new Path2D();
    for (let i = 0; i <= n; i++) face.lineTo(...at(...p(i)));
    for (let i = n; i >= 0; i--) face.lineTo(...at(...p(i), -SLAB));
    face.closePath();
    c.fillStyle = fill; c.fill(face);
    c.fillStyle = "rgba(92, 132, 150, .9)";
    for (let i = 0; i < n; i++) {
      if (tile(i) !== "2") continue;
      c.beginPath();
      for (const [j, h] of [[i, 0], [i + 1, 0], [i + 1, -0.45], [i, -0.45]]) c.lineTo(...at(...p(j), h));
      c.fill();
    }
    c.strokeStyle = "rgba(70, 50, 28, .22)"; c.lineWidth = 1;
    c.beginPath();
    for (const h of [-0.8, -1.2]) { c.moveTo(...at(...p(0), h)); c.lineTo(...at(...p(n), h)); }
    c.stroke();
    c.strokeStyle = INK; c.lineWidth = 1.6; c.stroke(face);
  }
  c.restore();
}

// Grass tufts, rock hatching, heather sprigs and reeds, upright wherever they stand. Trampled tiles lose their tufts.
export function drawMarks(c, marks, view, r, paths) {
  const hatch = new Path2D(), tufts = new Path2D(), heather = new Path2D(), reeds = new Path2D();
  for (const [u, v, kind] of marks) {
    const [px, py] = view.at(u, v);
    if (px < r[0] - 8 || px > r[2] + 8 || py < r[1] - 8 || py > r[3] + 8) continue;
    if (kind === 1) {
      for (let j = 0; j < 3; j++) { hatch.moveTo(px + j * 3.5 - 5, py + 4); hatch.lineTo(px + j * 3.5 - 1, py - 3); }
    } else if (kind === 2) {
      for (const dx of [-3, 0, 3]) { heather.moveTo(px + dx, py + 1); heather.lineTo(px + dx * 1.4, py - 3); }
    } else if (kind === 3) {
      reeds.moveTo(px - 2, py + 2); reeds.lineTo(px - 2.5, py - 5);
      reeds.moveTo(px + 1, py + 2); reeds.lineTo(px + 1.5, py - 6);
    } else if (!paths?.[Math.floor(v) * view.W + Math.floor(u)]) {
      tufts.moveTo(px - 3, py - 3); tufts.quadraticCurveTo(px - 1, py, px, py + 2);
      tufts.moveTo(px + 3, py - 4); tufts.quadraticCurveTo(px + 1, py, px, py + 2);
      tufts.moveTo(px, py - 5); tufts.lineTo(px, py + 2);
    }
  }
  c.save();
  c.lineCap = "round";
  c.strokeStyle = "rgba(70, 55, 38, .38)"; c.lineWidth = 1.1; c.stroke(hatch);
  c.strokeStyle = "rgba(80, 90, 40, .45)"; c.lineWidth = 1; c.stroke(tufts);
  c.strokeStyle = "rgba(104, 62, 86, .45)"; c.lineWidth = 1.2; c.stroke(heather);
  c.strokeStyle = "rgba(64, 88, 58, .55)"; c.lineWidth = 1.1; c.stroke(reeds);
  c.restore();
}

// Frozen water over the base. mask: 1 per frozen tile. The mask is upscaled smoothly so ice edges on open water are soft, and it
// spills onto land tiles next to ice so the texture's own fade decides where ice meets the shore.
let iceMaskFor = null, iceMask = null, iceTmp = null;
export function drawIce(c, iceLow, mask, tiles, W, H, x0, y0, x1, y1) {
  if (!mask || !iceLow) return;
  const bx = Math.max(0, x0 - 1), by = Math.max(0, y0 - 1), ex = Math.min(W - 1, x1 + 1), ey = Math.min(H - 1, y1 + 1);
  const frozen = [];
  for (let y = by; y <= ey; y++) for (let x = bx; x <= ex; x++) if (mask[y * W + x]) frozen.push([x, y]);
  if (!frozen.length) return;
  if (iceMaskFor !== mask) {
    iceMaskFor = mask;
    iceMask ??= new OffscreenCanvas(W, H);
    const mc = iceMask.getContext("2d"), img = mc.createImageData(W, H);
    const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let on = at(x, y);
        if (!on && tiles[y * W + x] !== "2") for (let j = -1; j <= 1 && !on; j++) for (let i = -1; i <= 1 && !on; i++) on = at(x + i, y + j);
        img.data[(y * W + x) * 4 + 3] = on ? 255 : 0;
      }
    mc.putImageData(img, 0, 0);
  }
  const rx = bx * T, ry = by * T, rw = (ex - bx + 1) * T, rh = (ey - by + 1) * T;
  iceTmp ??= new OffscreenCanvas(rw, rh);
  if (iceTmp.width !== rw || iceTmp.height !== rh) { iceTmp.width = rw; iceTmp.height = rh; }
  const t = iceTmp.getContext("2d");
  t.globalCompositeOperation = "source-over";
  t.clearRect(0, 0, rw, rh);
  t.imageSmoothingEnabled = true;
  t.drawImage(iceLow, -rx, -ry, W * T, H * T);
  t.globalCompositeOperation = "source-atop";
  t.lineCap = "round";
  for (const [x, y] of frozen) {
    if (tiles[y * W + x] !== "2") continue;
    const h = (s) => hash(x, y, 220 + s);
    if (h(0) < 0.5) {
      let px = (x + 0.15 + h(1) * 0.7) * T - rx, py = (y + 0.15 + h(2) * 0.7) * T - ry, a = h(3) * Math.PI * 2;
      t.beginPath(); t.moveTo(px, py);
      for (let j = 0; j < 3; j++) { a += (h(4 + j) - 0.5) * 1.6; px += Math.cos(a) * T * 0.28; py += Math.sin(a) * T * 0.2; t.lineTo(px, py); }
      t.strokeStyle = "rgba(96, 124, 140, .5)"; t.lineWidth = 0.9; t.stroke();
    }
    if (h(9) < 0.3) {
      const px = (x + h(10)) * T - rx, py = (y + h(11)) * T - ry;
      t.beginPath(); t.moveTo(px - T * 0.2, py + T * 0.06); t.lineTo(px + T * 0.18, py - T * 0.06);
      t.strokeStyle = "rgba(255, 255, 255, .7)"; t.lineWidth = 1.4; t.stroke();
    }
  }
  t.globalCompositeOperation = "destination-in";
  t.drawImage(iceMask, -rx, -ry, W * T, H * T);
  t.globalCompositeOperation = "source-over";
  c.drawImage(iceTmp, rx, ry);
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
// A tree someone cut into: a pale peeled patch where bark came off, amber beads where resin has wept out.
function scars(c, th, x, y, s) {
  if (th.bark) {
    c.beginPath(); c.ellipse(x + s * 0.02, y, s * 0.07, s * 0.16, 0.1, 0, Math.PI * 2);
    c.fillStyle = "#e6cf9f"; c.fill(); c.strokeStyle = "rgba(90, 60, 30, .7)"; c.lineWidth = 0.8; c.stroke();
  }
  for (let i = 0; i < (th.resin ?? 0) * 2; i++) {
    const bx = x + (i % 2 ? 1 : -1) * s * (0.1 + hash(th.x, th.y, 260 + i) * 0.08), by = y + (hash(th.x, th.y, 270 + i) - 0.5) * s * 0.3;
    c.beginPath(); c.moveTo(bx, by - s * 0.07); c.quadraticCurveTo(bx + s * 0.05, by + s * 0.02, bx, by + s * 0.04); c.quadraticCurveTo(bx - s * 0.05, by + s * 0.02, bx, by - s * 0.07);
    c.fillStyle = "#d9901f"; c.fill(); c.strokeStyle = "rgba(90, 45, 10, .8)"; c.lineWidth = 0.7; c.stroke();
    c.fillStyle = "rgba(255, 240, 190, .8)"; c.beginPath(); c.arc(bx - s * 0.012, by - s * 0.01, s * 0.013, 0, Math.PI * 2); c.fill();
  }
}
const PINES = ["#4c6b3c", "#557545", "#46633a", "#5c7a45"];
const LEAVES = ["#6b8a44", "#77924a", "#5f7f3d"];

// Where a thing's glyph sits, in tile units, so live effects line up with the cached glyph.
export function thingSpot(th) {
  return [th.x + 0.5 + (hash(th.x, th.y, 11) - 0.5) * 0.25, th.y + 0.5 + (hash(th.x, th.y, 12) - 0.5) * 0.2];
}
export function drawThing(c, th, ownerColor, kinds) {
  const r = hash(th.x, th.y, 11), r2 = hash(th.x, th.y, 12);
  const [sx, sy] = thingSpot(th), x = sx * T, y = sy * T;
  c.lineJoin = "round"; c.lineCap = "round";
  const tier = th.shelter?.tier ?? 0, abandoned = th.kind === "structure" && !th.owner && tier >= 1;
  const filters = [];
  if (th.burning > 0) filters.push(`brightness(${(1 - th.burning * 0.45).toFixed(2)}) saturate(${(1 - th.burning * 0.5).toFixed(2)})`);
  if (abandoned) filters.push("saturate(.5) brightness(.95)");
  if (filters.length) c.filter = filters.join(" ");
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
      scars(c, th, x, y + s * 0.26, s * 0.5);
      break;
    }
    case "stump": {
      const s = T * 0.5;
      shadow(c, x + 1, y + s * 0.35, s * 0.45);
      c.beginPath(); c.rect(x - s * 0.32, y - s * 0.05, s * 0.64, s * 0.36); inked(c, "#7a5533");
      c.beginPath(); c.ellipse(x, y - s * 0.05, s * 0.32, s * 0.13, 0, 0, Math.PI * 2); inked(c, "#c9a06a");
      c.strokeStyle = "rgba(90, 60, 30, .6)"; c.lineWidth = 0.8;
      c.beginPath(); c.ellipse(x, y - s * 0.05, s * 0.16, s * 0.06, 0, 0, Math.PI * 2); c.stroke();
      scars(c, th, x, y + s * 0.16, s);
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
    case "reeds": {
      const s = T * 0.55;
      c.strokeStyle = "#5d6e32"; c.lineWidth = 1.6;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const bx = x + (i - 2.5) * s * 0.16, lean = (hash(th.x, th.y, 50 + i) - 0.5) * s * 0.5, h = s * (0.6 + hash(th.x, th.y, 60 + i) * 0.5);
        c.moveTo(bx, y + s * 0.3); c.quadraticCurveTo(bx + lean * 0.3, y, bx + lean, y + s * 0.3 - h);
      }
      c.stroke();
      c.fillStyle = "#7a5530";
      for (let i = 0; i < 3; i++) {
        const bx = x + (i - 1) * s * 0.22 + (hash(th.x, th.y, 70 + i) - 0.5) * 3;
        c.beginPath(); c.ellipse(bx, y - s * 0.35 - i * 2, s * 0.05, s * 0.13, 0, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case "clay": {
      const s = T * 0.5;
      c.beginPath(); c.ellipse(x, y + s * 0.1, s * 0.55, s * 0.28, 0, 0, Math.PI * 2);
      inked(c, "#b0703f", 1);
      c.fillStyle = "rgba(255, 220, 180, .35)";
      c.beginPath(); c.ellipse(x - s * 0.15, y, s * 0.2, s * 0.08, 0, 0, Math.PI * 2); c.fill();
      break;
    }
    case "sapling": {
      const g = Math.max(0, Math.min(1, th.stage ?? 0.3)), s = T * (0.4 + g * 0.55);
      shadow(c, x + 1, y + s * 0.32, s * (0.16 + g * 0.14));
      c.strokeStyle = "#6b4a2b"; c.lineWidth = 1 + g * 1.4;
      c.beginPath(); c.moveTo(x, y + s * 0.32); c.quadraticCurveTo(x + (r - 0.5) * s * 0.2, y, x, y - s * 0.24); c.stroke();
      const col = LEAVES[Math.floor(r * LEAVES.length)];
      if (g < 0.45) {
        leaf(c, x, y - s * 0.2, s * 0.3, -Math.PI * 0.85, col);
        leaf(c, x, y - s * 0.24, s * 0.3, -Math.PI * 0.15, col);
        leaf(c, x, y - s * 0.24, s * 0.24, -Math.PI * 0.5, col);
      } else {
        blob(c, [[x - s * 0.13, y - s * 0.28, s * 0.17], [x + s * 0.13, y - s * 0.3, s * 0.17], [x, y - s * 0.44, s * 0.19]]);
        c.fillStyle = col; c.fill(); c.strokeStyle = INK; c.lineWidth = 1; c.stroke();
        c.beginPath(); c.arc(x, y - s * 0.33, s * 0.16, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case "herb": {
      const s = T * 0.6;
      shadow(c, x, y + s * 0.34, s * 0.32);
      for (let i = 0; i < 3; i++) {
        const a = -Math.PI / 2 + (i - 1) * 0.55 + (hash(th.x, th.y, 90 + i) - 0.5) * 0.3, len = s * (0.55 + hash(th.x, th.y, 93 + i) * 0.25);
        const bx = x + (i - 1) * s * 0.08, by = y + s * 0.32, tx = bx + Math.cos(a) * len, ty = by + Math.sin(a) * len;
        c.strokeStyle = "#4f6a2c"; c.lineWidth = 1.1;
        c.beginPath(); c.moveTo(bx, by); c.lineTo(tx, ty); c.stroke();
        for (let j = 1; j <= 3; j++) {
          const k = j / 3.6, lx = bx + (tx - bx) * k, ly = by + (ty - by) * k;
          leaf(c, lx, ly, s * 0.22, a - 0.95, "#8aab55", 0.7);
          leaf(c, lx, ly, s * 0.22, a + 0.95, "#8aab55", 0.7);
        }
        c.beginPath(); c.arc(tx, ty, s * 0.07, 0, Math.PI * 2); inked(c, "#cbb5e2", 0.7);
      }
      break;
    }
    case "dead_bush": {
      const s = T * 0.62;
      shadow(c, x + 1, y + s * 0.34, s * 0.42);
      let q = 0;
      const twig = (x0, y0, a, len, d) => {
        const x1 = x0 + Math.cos(a) * len, y1 = y0 + Math.sin(a) * len;
        c.moveTo(x0, y0); c.lineTo(x1, y1);
        if (d <= 0) return;
        twig(x1, y1, a - 0.35 - hash(th.x, th.y, 110 + q++) * 0.35, len * 0.62, d - 1);
        twig(x1, y1, a + 0.3 + hash(th.x, th.y, 110 + q++) * 0.35, len * 0.58, d - 1);
      };
      c.beginPath();
      for (let i = 0; i < 5; i++) twig(x + (i - 2) * s * 0.05, y + s * 0.32, -Math.PI / 2 + (i - 2) * 0.36 + (hash(th.x, th.y, 100 + i) - 0.5) * 0.25, s * (0.3 + hash(th.x, th.y, 105 + i) * 0.12), 2);
      c.strokeStyle = INK; c.lineWidth = 2.4; c.stroke();
      c.strokeStyle = "#8f7a60"; c.lineWidth = 1.1; c.stroke();
      break;
    }
    case "burnt_stump": {
      const s = T * 0.5;
      c.fillStyle = "rgba(40, 32, 26, .3)";
      c.beginPath(); c.ellipse(x, y + s * 0.3, s * 0.62, s * 0.22, 0, 0, Math.PI * 2); c.fill();
      c.beginPath();
      c.moveTo(x - s * 0.32, y + s * 0.31); c.lineTo(x - s * 0.3, y - s * 0.02); c.lineTo(x - s * 0.12, y - s * 0.2); c.lineTo(x + s * 0.02, y - s * 0.06);
      c.lineTo(x + s * 0.18, y - s * 0.24); c.lineTo(x + s * 0.32, y - s * 0.02); c.lineTo(x + s * 0.32, y + s * 0.31); c.closePath();
      inked(c, "#2f2722");
      c.strokeStyle = "rgba(170, 160, 150, .45)"; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(x - s * 0.15, y + s * 0.28); c.lineTo(x - s * 0.1, y); c.moveTo(x + s * 0.12, y + s * 0.3); c.lineTo(x + s * 0.16, y - s * 0.06); c.stroke();
      c.fillStyle = "rgba(214, 98, 40, .75)";
      for (const [dx, dy] of [[-0.04, 0.12], [0.2, 0.2]]) { c.beginPath(); c.arc(x + dx * s, y + dy * s, s * 0.035, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case "ash": {
      const s = T * 0.55, g = c.createRadialGradient(x, y + s * 0.1, 0, x, y + s * 0.1, s * 0.62);
      g.addColorStop(0, "rgba(92, 88, 84, .55)"); g.addColorStop(0.6, "rgba(118, 114, 108, .3)"); g.addColorStop(1, "rgba(130, 125, 120, 0)");
      c.fillStyle = g; c.beginPath(); c.ellipse(x, y + s * 0.1, s * 0.62, s * 0.34, 0, 0, Math.PI * 2); c.fill();
      for (let i = 0; i < 7; i++) {
        const a = hash(th.x, th.y, 140 + i) * Math.PI * 2, rr = s * hash(th.x, th.y, 150 + i) * 0.42;
        c.fillStyle = i % 2 ? "rgba(60, 55, 50, .5)" : "rgba(210, 205, 196, .6)";
        c.beginPath(); c.arc(x + Math.cos(a) * rr, y + s * 0.1 + Math.sin(a) * rr * 0.5, s * 0.03, 0, Math.PI * 2); c.fill();
      }
      break;
    }
    case "boulder": {
      const s = T * 0.95;
      shadow(c, x + 2, y + s * 0.24, s * 0.5, s * 0.15);
      c.beginPath();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2, rr = s * (0.34 + hash(th.x, th.y, 120 + i) * 0.1);
        const px = x + Math.cos(a) * rr * 1.1, py = y - s * 0.04 + Math.sin(a) * rr * (Math.sin(a) < 0 ? 0.85 : 0.55);
        i ? c.lineTo(px, py) : c.moveTo(px, py);
      }
      c.closePath(); inked(c, "#9e9585", 1.4);
      c.save(); c.clip();
      c.fillStyle = "rgba(60, 45, 30, .2)"; c.beginPath(); c.ellipse(x + s * 0.18, y + s * 0.14, s * 0.4, s * 0.22, 0, 0, Math.PI * 2); c.fill();
      if (r2 > 0.5) { c.fillStyle = "rgba(105, 135, 70, .6)"; c.beginPath(); c.ellipse(x - s * 0.18, y - s * 0.24, s * 0.2, s * 0.08, -0.3, 0, Math.PI * 2); c.fill(); }
      // Rust bleeding out of a seam where ore sits inside.
      if (th.inside?.ore) { c.fillStyle = "rgba(160, 70, 40, .35)"; c.beginPath(); c.ellipse(x + s * 0.05, y + s * 0.05, s * 0.22, s * 0.07, 0.4, 0, Math.PI * 2); c.fill(); }
      // Flint nodules: dark glassy knobs with a pale chalky rind.
      if (th.inside?.flint)
        for (let i = 0; i < 2 + th.inside.flint; i++) {
          const nx = x + (hash(th.x, th.y, 230 + i) - 0.5) * s * 0.55, ny = y - s * 0.06 + (hash(th.x, th.y, 240 + i) - 0.5) * s * 0.3, nr = s * (0.05 + hash(th.x, th.y, 250 + i) * 0.03);
          c.beginPath(); c.ellipse(nx, ny, nr * 1.3, nr, 0, 0, Math.PI * 2);
          c.fillStyle = "#3b3d44"; c.fill(); c.strokeStyle = "rgba(235, 228, 210, .75)"; c.lineWidth = 1; c.stroke();
          c.fillStyle = "rgba(220, 230, 240, .5)"; c.beginPath(); c.arc(nx - nr * 0.4, ny - nr * 0.3, nr * 0.3, 0, Math.PI * 2); c.fill();
        }
      c.restore();
      c.strokeStyle = "rgba(255, 250, 235, .5)"; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(x - s * 0.24, y - s * 0.12); c.lineTo(x - s * 0.04, y - s * 0.3); c.stroke();
      c.strokeStyle = "rgba(58, 42, 26, .6)"; c.lineWidth = 0.9;
      c.beginPath(); c.moveTo(x + s * 0.06, y - s * 0.28); c.lineTo(x + s * 0.12, y - s * 0.1); c.lineTo(x + s * 0.06, y + s * 0.04); c.stroke();
      break;
    }
    case "structure":
      drawStructure(c, th, x, y, abandoned ? RAG : ownerColor);
      if (abandoned) {
        const w = T * (0.45 + tier * 0.12);
        c.strokeStyle = "rgba(80, 96, 40, .85)"; c.lineWidth = 1.1;
        c.beginPath();
        for (let i = 0; i < 5; i++) {
          const bx = x + (hash(th.x, th.y, 200 + i) - 0.5) * w * 1.6, by = y + T * (0.3 + tier * 0.05) + hash(th.x, th.y, 210 + i) * 3;
          c.moveTo(bx - 3, by - 5); c.quadraticCurveTo(bx - 1, by - 1, bx, by);
          c.moveTo(bx + 3, by - 6); c.quadraticCurveTo(bx + 1, by - 1, bx, by);
          c.moveTo(bx, by - 7); c.lineTo(bx, by);
        }
        c.stroke();
      }
      break;
    case "item": drawItem(c, th, x, y, kinds); break;
    case "pit": {
      c.beginPath(); c.ellipse(x + T * 0.3, y - T * 0.1, T * 0.2, T * 0.1, -0.25, 0, Math.PI * 2); inked(c, "#8b6a45", 1);
      c.fillStyle = "rgba(60, 40, 20, .45)";
      for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(x + T * (0.2 + hash(th.x, th.y, 160 + i) * 0.22), y - T * (0.04 + hash(th.x, th.y, 170 + i) * 0.1), 1, 0, Math.PI * 2); c.fill(); }
      hole(c, x, y);
      break;
    }
    case "trap": {
      const reeds = !!th.parts?.reeds, hy = y + HOLE.dy * T, rx = HOLE.rx * T, ry = HOLE.ry * T;
      if (th.caught) {
        hole(c, x, y);
        c.strokeStyle = INK; c.lineWidth = 3;
        const sticks = [[-1.15, -0.3, -0.45, 0.25], [0.95, -0.5, 0.35, 0.3], [-0.2, -1.25, 0.1, -0.2], [0.55, 0.75, 1.1, 1.3]];
        c.beginPath();
        for (const [a, b, p, q] of sticks) { c.moveTo(x + a * rx, hy + b * ry); c.lineTo(x + p * rx, hy + q * ry); }
        c.stroke(); c.strokeStyle = reeds ? "#a3a458" : "#8a6038"; c.lineWidth = 1.6; c.stroke();
      } else {
        c.beginPath(); c.ellipse(x, hy, rx * 1.22, ry * 1.32, 0, 0, Math.PI * 2); inked(c, "#9c7b52", 1);
        c.beginPath(); c.ellipse(x, hy, rx * 1.05, ry * 1.1, 0, 0, Math.PI * 2); c.fillStyle = "#3a2a1a"; c.fill();
        c.save(); c.clip();
        c.strokeStyle = reeds ? "#b3b064" : "#94693f"; c.lineWidth = reeds ? 1.4 : 2.2;
        c.beginPath();
        for (let i = -4; i <= 4; i++) {
          const o = i * rx * 0.26;
          c.moveTo(x + o - rx, hy - ry * 1.4); c.lineTo(x + o + rx * 0.6, hy + ry * 1.4);
          if (!reeds) { c.moveTo(x + o + rx, hy - ry * 1.4); c.lineTo(x + o - rx * 0.6, hy + ry * 1.4); }
        }
        c.stroke();
        c.restore();
        for (let i = 0; i < 4; i++) leaf(c, x + (hash(th.x, th.y, 180 + i) - 0.5) * rx * 1.4, hy + (hash(th.x, th.y, 185 + i) - 0.5) * ry, T * 0.12, hash(th.x, th.y, 190 + i) * 6, "#7f9448", 0.6);
        c.beginPath(); c.ellipse(x, hy, rx * 1.05, ry * 1.1, 0, 0, Math.PI * 2); c.strokeStyle = INK; c.lineWidth = 1; c.stroke();
      }
      if (ownerColor) {
        const px = x + rx * 1.35, py = hy - ry * 0.4;
        c.strokeStyle = INK; c.lineWidth = 2.2; c.beginPath(); c.moveTo(px, py + T * 0.08); c.lineTo(px + T * 0.02, py - T * 0.3); c.stroke();
        c.strokeStyle = "#8a6038"; c.lineWidth = 1; c.stroke();
        c.beginPath(); c.moveTo(px + T * 0.02, py - T * 0.26); c.lineTo(px + T * 0.15, py - T * 0.2); c.lineTo(px + T * 0.01, py - T * 0.17); c.closePath(); inked(c, ownerColor, 0.8);
      }
      break;
    }
    case "well": {
      const hy = y + HOLE.dy * T, rx = HOLE.rx * T, ry = HOLE.ry * T;
      shadow(c, x + 1, hy + ry * 1.2, rx * 1.4, ry * 0.9);
      c.beginPath(); c.ellipse(x, hy, rx * 1.1, ry * 1.1, 0, 0, Math.PI * 2); c.fillStyle = "#4a3524"; c.fill();
      c.beginPath(); c.ellipse(x, hy + ry * 0.2, rx * 0.95, ry * 0.8, 0, 0, Math.PI * 2); c.fillStyle = "#4f7f92"; c.fill();
      c.strokeStyle = "rgba(230, 245, 250, .7)"; c.lineWidth = 1;
      c.beginPath(); c.ellipse(x - rx * 0.1, hy + ry * 0.25, rx * 0.5, ry * 0.3, 0, Math.PI * 1.1, Math.PI * 1.7); c.stroke();
      const n = 11;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.2, px = x + Math.cos(a) * rx * 1.18, py = hy + Math.sin(a) * ry * 1.25;
        c.beginPath(); c.ellipse(px, py, T * 0.075, T * 0.05, 0, 0, Math.PI * 2);
        inked(c, i % 3 ? "#a59c8c" : "#968d7d", 0.9);
      }
      break;
    }
    case "grave": {
      const s = T * 0.55;
      c.beginPath(); c.ellipse(x, y + s * 0.18, s * 0.5, s * 0.2, 0, 0, Math.PI * 2); inked(c, "#8a7650", 1);
      c.fillStyle = "rgba(110, 135, 70, .45)"; c.beginPath(); c.ellipse(x - s * 0.1, y + s * 0.14, s * 0.3, s * 0.09, 0, 0, Math.PI * 2); c.fill();
      if (r < 0.5) {
        for (const [dx, dy, rr] of [[-0.2, 0.08, 0.15], [0.18, 0.1, 0.14], [0, 0.04, 0.15], [-0.08, -0.14, 0.12], [0.1, -0.13, 0.11], [0.01, -0.3, 0.09]]) {
          c.beginPath(); c.ellipse(x + dx * s, y + dy * s, rr * s * 1.15, rr * s * 0.85, 0, 0, Math.PI * 2); inked(c, "#a59c8c", 1);
        }
      } else {
        c.beginPath(); c.moveTo(x - s * 0.16, y + s * 0.14); c.lineTo(x - s * 0.16, y - s * 0.3); c.quadraticCurveTo(x, y - s * 0.48, x + s * 0.16, y - s * 0.3); c.lineTo(x + s * 0.16, y + s * 0.14); c.closePath();
        inked(c, "#a07a4c", 1.1);
        c.strokeStyle = "rgba(60, 40, 20, .55)"; c.lineWidth = 0.9;
        c.beginPath(); c.moveTo(x - s * 0.08, y - s * 0.18); c.lineTo(x + s * 0.08, y - s * 0.18); c.moveTo(x - s * 0.06, y - s * 0.08); c.lineTo(x + s * 0.06, y - s * 0.08); c.stroke();
      }
      if (r2 > 0.55) for (const [dx, col] of [[-0.36, "#e9d57a"], [0.34, "#d98aa0"]]) { c.beginPath(); c.arc(x + dx * s, y + s * 0.2, s * 0.05, 0, Math.PI * 2); inked(c, col, 0.6); }
      break;
    }
  }
  if (filters.length) c.filter = "none";
}
// Tile-unit geometry of dug holes, shared by the cached glyph and the live trapped animal.
const HOLE = { dy: 0.06, rx: 0.3, ry: 0.14 };
function hole(c, x, y) {
  const hy = y + HOLE.dy * T, rx = HOLE.rx * T, ry = HOLE.ry * T;
  c.beginPath(); c.ellipse(x, hy, rx * 1.22, ry * 1.32, 0, 0, Math.PI * 2); inked(c, "#9c7b52", 1);
  c.beginPath(); c.ellipse(x, hy, rx, ry, 0, 0, Math.PI * 2); c.fillStyle = "#5a4230"; c.fill();
  c.save(); c.clip();
  c.beginPath(); c.ellipse(x, hy + ry * 0.5, rx, ry * 0.9, 0, 0, Math.PI * 2); c.fillStyle = "#22170e"; c.fill();
  c.restore();
  c.beginPath(); c.ellipse(x, hy, rx, ry, 0, 0, Math.PI * 2); c.strokeStyle = INK; c.lineWidth = 1.2; c.stroke();
}
function leaf(c, x, y, len, ang, col, lw = 0.8) {
  c.save(); c.translate(x, y); c.rotate(ang);
  c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(len * 0.5, -len * 0.34, len, 0); c.quadraticCurveTo(len * 0.5, len * 0.34, 0, 0); c.closePath();
  inked(c, col, lw);
  c.restore();
}
function blob(c, circles) {
  c.beginPath();
  for (const [x, y, r] of circles) { c.moveTo(x + r, y); c.arc(x, y, r, 0, Math.PI * 2); }
}

// ---------- structures: shape by tier, surface by dominant material ----------
const STYLE = {
  sticks: { wall: "#8f6d45", roof: "#9c8a4e", wt: "twigs", rt: "twigs" },
  reeds: { wall: "#a38b50", roof: "#c9ae62", wt: "thatch", rt: "thatch" },
  logs: { wall: "#8a5a33", roof: "#c7a15c", wt: "logs", rt: "thatch" },
  planks: { wall: "#c49a63", roof: "#7d3b2a", wt: "planks", rt: "bricks" },
  stone: { wall: "#a39a8a", roof: "#6e675e", wt: "blocks", rt: "blocks" },
  brick: { wall: "#a4533a", roof: "#6e3526", wt: "bricks", rt: "bricks" },
  hide: { wall: "#b48c62", roof: "#9a744e", wt: "stitch", rt: "stitch" },
  clay: { wall: "#c28150", roof: "#a4683d", wt: "smooth", rt: "smooth" },
  mixed: { wall: "#94693f", roof: "#b9975a", wt: "logs", rt: "thatch" },
};
const LINE = {
  logs: "rgba(50, 30, 15, .7)", planks: "rgba(90, 60, 30, .55)", blocks: "rgba(55, 45, 35, .5)", bricks: "rgba(245, 220, 195, .5)",
  thatch: "rgba(90, 68, 28, .55)", twigs: "rgba(60, 45, 20, .6)", stitch: "rgba(60, 40, 20, .65)", smooth: "rgba(255, 228, 195, .4)",
};
function texture(c, kind, x0, y0, w, h, seed) {
  c.save(); c.clip();
  c.strokeStyle = LINE[kind]; c.lineWidth = 0.9;
  c.beginPath();
  switch (kind) {
    case "logs":
      for (let i = 1; i < 4; i++) { c.moveTo(x0, y0 + (i * h) / 4); c.lineTo(x0 + w, y0 + (i * h) / 4); }
      break;
    case "planks":
      for (let i = 1; i < 8; i++) { c.moveTo(x0 + (i * w) / 8, y0); c.lineTo(x0 + (i * w) / 8, y0 + h); }
      break;
    case "blocks": case "bricks": {
      const rows = kind === "blocks" ? 3 : 5, cols = kind === "blocks" ? 3 : 5, rh = h / rows, cw = w / cols;
      for (let j = 0; j < rows; j++) {
        const yy = y0 + j * rh, off = (j % 2) * cw * 0.5 + (kind === "blocks" ? (hash(j, 3, seed) - 0.5) * cw * 0.4 : 0);
        if (j) { c.moveTo(x0, yy); c.lineTo(x0 + w, yy); }
        for (let i = -1; i <= cols; i++) { const xx = x0 + i * cw + off; c.moveTo(xx, yy); c.lineTo(xx, yy + rh); }
      }
      break;
    }
    case "thatch":
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 12; i++) {
          const xx = x0 + ((i + hash(i, j, seed) * 0.6) * w) / 12, yy = y0 + (j * h) / 4;
          c.moveTo(xx, yy); c.lineTo(xx + w * 0.015, yy + h / 4 + 1);
        }
      break;
    case "twigs":
      for (let i = -2; i < 8; i++) { c.moveTo(x0 + (i * w) / 6, y0 + h); c.lineTo(x0 + ((i + 2) * w) / 6, y0); }
      break;
    case "stitch":
      c.setLineDash([2, 2]);
      for (let i = 1; i < 3; i++) { c.moveTo(x0 + (i * w) / 3, y0); c.lineTo(x0 + (i * w) / 3 + w * 0.04, y0 + h); }
      break;
    case "smooth":
      c.lineWidth = 1.4;
      c.moveTo(x0 + w * 0.15, y0 + h * 0.3); c.quadraticCurveTo(x0 + w * 0.3, y0 + h * 0.22, x0 + w * 0.42, y0 + h * 0.3);
      c.moveTo(x0 + w * 0.6, y0 + h * 0.62); c.quadraticCurveTo(x0 + w * 0.72, y0 + h * 0.55, x0 + w * 0.82, y0 + h * 0.62);
      break;
  }
  c.stroke(); c.setLineDash([]);
  c.restore();
}
// Fill a shape, texture it, then ink its outline on top so the pattern never frays the edge.
function part(c, trace, fill, tex, box, seed, lw = 1.4) {
  c.beginPath(); trace(); c.fillStyle = fill; c.fill();
  texture(c, tex, ...box, seed);
  c.beginPath(); trace(); c.strokeStyle = INK; c.lineWidth = lw; c.stroke();
}
function drawStructure(c, th, x, y, ownerColor) {
  const style = th.shelter?.style ?? "mixed", tier = th.shelter?.tier ?? 0, st = STYLE[style] ?? STYLE.mixed;
  const seed = Math.floor(hash(th.x, th.y, 13) * 1000);
  if (tier <= 0) return pile(c, style, x, y, seed);
  if (style === "hide") return tent(c, x, y, tier, st, ownerColor, seed);
  if (tier === 1) {
    const s = T * 1.3;
    shadow(c, x + 3, y + s * 0.26, s * 0.5, s * 0.16);
    part(c, () => { c.moveTo(x - s * 0.45, y + s * 0.26); c.lineTo(x + s * 0.3, y - s * 0.3); c.lineTo(x + s * 0.42, y + s * 0.26); c.closePath(); },
      st.roof, st.rt, [x - s * 0.45, y - s * 0.3, s * 0.87, s * 0.56], seed);
    flag(c, x + s * 0.3, y - s * 0.3, s, ownerColor);
  } else if (tier === 2) {
    const s = T * 1.5;
    shadow(c, x + 3, y + s * 0.3, s * 0.52, s * 0.16);
    part(c, () => c.rect(x - s * 0.38, y - s * 0.06, s * 0.76, s * 0.34), st.wall, st.wt, [x - s * 0.38, y - s * 0.06, s * 0.76, s * 0.34], seed);
    const roof = style === "clay"
      ? () => { c.moveTo(x - s * 0.44, y - s * 0.04); c.quadraticCurveTo(x - s * 0.4, y - s * 0.46, x, y - s * 0.46); c.quadraticCurveTo(x + s * 0.4, y - s * 0.46, x + s * 0.44, y - s * 0.04); c.closePath(); }
      : () => { c.moveTo(x - s * 0.46, y - s * 0.04); c.lineTo(x, y - s * 0.4); c.lineTo(x + s * 0.46, y - s * 0.04); c.closePath(); };
    part(c, roof, st.roof, st.rt, [x - s * 0.46, y - s * 0.46, s * 0.92, s * 0.42], seed);
    c.beginPath(); c.rect(x - s * 0.07, y + s * 0.08, s * 0.14, s * 0.2); inked(c, INK, 1);
    flag(c, x + s * 0.3, y - s * 0.26, s, ownerColor);
  } else {
    const s = T * 1.7;
    shadow(c, x + 4, y + s * 0.3, s * 0.55, s * 0.16);
    part(c, () => c.rect(x - s * 0.4, y - s * 0.08, s * 0.8, s * 0.36), st.wall, st.wt, [x - s * 0.4, y - s * 0.08, s * 0.8, s * 0.36], seed);
    part(c, () => { c.moveTo(x - s * 0.48, y - s * 0.06); c.lineTo(x - s * 0.3, y - s * 0.38); c.lineTo(x + s * 0.3, y - s * 0.38); c.lineTo(x + s * 0.48, y - s * 0.06); c.closePath(); },
      st.roof, st.rt, [x - s * 0.48, y - s * 0.38, s * 0.96, s * 0.32], seed);
    c.beginPath(); c.rect(x + s * 0.14, y - s * 0.5, s * 0.08, s * 0.16); inked(c, style === "brick" ? "#8a4430" : "#8c8478", 1);
    c.beginPath(); c.rect(x - s * 0.06, y + s * 0.06, s * 0.13, s * 0.22); inked(c, "#4a2e1a", 1);
    c.beginPath(); c.rect(x - s * 0.3, y + s * 0.02, s * 0.12, s * 0.1); inked(c, "#e8c77a", 1);
    flag(c, x - s * 0.36, y - s * 0.34, s, ownerColor);
  }
}
function tent(c, x, y, tier, st, ownerColor, seed) {
  const s = T * (1.05 + tier * 0.22);
  shadow(c, x + 3, y + s * 0.26, s * 0.48, s * 0.15);
  c.strokeStyle = INK; c.lineWidth = 1.4;
  c.beginPath(); c.moveTo(x - s * 0.1, y - s * 0.5); c.lineTo(x + s * 0.04, y - s * 0.3); c.moveTo(x + s * 0.1, y - s * 0.5); c.lineTo(x - s * 0.04, y - s * 0.3); c.stroke();
  part(c, () => { c.moveTo(x - s * 0.42, y + s * 0.26); c.lineTo(x, y - s * 0.36); c.lineTo(x + s * 0.42, y + s * 0.26); c.quadraticCurveTo(x, y + s * 0.32, x - s * 0.42, y + s * 0.26); c.closePath(); },
    st.wall, "stitch", [x - s * 0.42, y - s * 0.36, s * 0.84, s * 0.66], seed);
  if (tier >= 3) {
    c.strokeStyle = "#7a3a22"; c.lineWidth = 1.4;
    c.beginPath();
    for (let i = 0; i <= 8; i++) { const px = x - s * 0.3 + (i / 8) * s * 0.6, py = y + s * 0.06 + (i % 2 ? -s * 0.04 : 0); i ? c.lineTo(px, py) : c.moveTo(px, py); }
    c.stroke();
  }
  c.beginPath(); c.moveTo(x, y - s * 0.02); c.lineTo(x - s * 0.1, y + s * 0.28); c.lineTo(x + s * 0.1, y + s * 0.28); c.closePath(); inked(c, "#5a3a22", 1);
  flag(c, x + s * 0.1, y - s * 0.5, s * 0.8, ownerColor);
}
// Tier 0: a heap of the stuff it's made of.
function pile(c, style, x, y, seed) {
  const s = T * 0.62;
  shadow(c, x + 1, y + s * 0.3, s * 0.5);
  const rock = (rx, ry, rr) => { c.beginPath(); c.ellipse(rx, ry, rr * 1.2, rr * 0.85, 0, 0, Math.PI * 2); inked(c, "#a59c8c", 1); };
  const stick = (i) => {
    const a = (hash(seed, i, 5) - 0.5) * 0.7 + (i % 2 ? 0.45 : -0.45), px = x + (hash(seed, i, 6) - 0.5) * s * 0.3, py = y + s * 0.12 - i * s * 0.04;
    c.beginPath(); c.moveTo(px - Math.cos(a) * s * 0.42, py - Math.sin(a) * s * 0.3); c.lineTo(px + Math.cos(a) * s * 0.42, py + Math.sin(a) * s * 0.3);
    c.strokeStyle = INK; c.lineWidth = 3.4; c.stroke(); c.strokeStyle = "#8a6038"; c.lineWidth = 1.9; c.stroke();
  };
  switch (style) {
    case "stone":
      for (const [dx, dy, rr] of [[-0.26, 0.18, 0.16], [0, 0.2, 0.17], [0.26, 0.17, 0.15], [-0.13, 0.02, 0.15], [0.13, 0.02, 0.15], [0, -0.13, 0.13]]) rock(x + dx * s, y + dy * s, rr * s);
      break;
    case "brick":
      for (const [dx, dy] of [[-0.26, 0.16], [0.02, 0.16], [0.3, 0.16], [-0.12, 0], [0.16, 0], [0.02, -0.16]]) {
        c.beginPath(); c.roundRect(x + dx * s - s * 0.13, y + dy * s - s * 0.07, s * 0.26, s * 0.14, 1.5); inked(c, "#a4533a", 1);
      }
      break;
    case "logs": case "planks": {
      const plank = style === "planks";
      for (const [dx, dy] of [[-0.06, 0.18], [0.04, 0.02], [-0.02, -0.14]]) {
        c.beginPath(); c.roundRect(x + dx * s - s * 0.4, y + dy * s - s * 0.08, s * 0.8, s * 0.16, plank ? 1 : s * 0.08); inked(c, plank ? "#c9a06a" : "#7a5533", 1);
        if (!plank) { c.beginPath(); c.ellipse(x + dx * s + s * 0.36, y + dy * s, s * 0.045, s * 0.08, 0, 0, Math.PI * 2); inked(c, "#c9a06a", 0.8); }
      }
      break;
    }
    case "reeds":
      c.beginPath(); c.ellipse(x, y + s * 0.08, s * 0.46, s * 0.14, -0.15, 0, Math.PI * 2); inked(c, "#a3a458", 1);
      c.strokeStyle = "rgba(70, 80, 30, .6)"; c.lineWidth = 0.8;
      c.beginPath(); for (let i = -2; i <= 2; i++) { c.moveTo(x - s * 0.42, y + s * 0.14 + i * s * 0.03); c.lineTo(x + s * 0.42, y + s * 0.02 + i * s * 0.03); } c.stroke();
      c.strokeStyle = "#6b4a2b"; c.lineWidth = 2.2;
      c.beginPath(); c.moveTo(x - s * 0.02, y - s * 0.06); c.lineTo(x + s * 0.02, y + s * 0.22); c.stroke();
      break;
    case "hide":
      c.beginPath(); c.moveTo(x - s * 0.46, y - s * 0.02); c.quadraticCurveTo(x, y - s * 0.24, x + s * 0.44, y - s * 0.06); c.lineTo(x + s * 0.38, y + s * 0.26); c.quadraticCurveTo(x, y + s * 0.34, x - s * 0.42, y + s * 0.24); c.closePath();
      inked(c, "#9a6b43");
      c.beginPath(); c.moveTo(x + s * 0.02, y - s * 0.15); c.lineTo(x + s * 0.44, y - s * 0.06); c.lineTo(x + s * 0.08, y + s * 0.1); c.closePath(); inked(c, "#b88a5c", 0.9);
      break;
    case "clay":
      c.beginPath(); c.ellipse(x - s * 0.14, y + s * 0.14, s * 0.3, s * 0.16, 0, 0, Math.PI * 2); inked(c, "#b0703f", 1);
      c.beginPath(); c.ellipse(x + s * 0.16, y + s * 0.04, s * 0.24, s * 0.14, 0, 0, Math.PI * 2); inked(c, "#b87a48", 1);
      break;
    default:
      for (let i = 0; i < 5; i++) stick(i);
      if (style === "mixed") rock(x + s * 0.28, y + s * 0.16, s * 0.13);
  }
}

// ---------- ground items: a glyph picked from the kind's makeup ----------
const NATURAL = {
  meat: "meat", fish: "fish", hide: "hide", bone: "bone", plank: "plank", log: "log", stick: "stick", stone: "stone", clay: "clay", fiber: "cord", berry: "food", mushroom: "food", herb: "food",
  bark: "bark", resin: "resin", flint: "flint", flint_blade: "flintblade", fat: "fat", charcoal: "charcoal", ore: "ore",
};
function bases(kinds, k, out = new Set(), d = 0) {
  if (!k) return out;
  if (k.base) out.add(k.base);
  else if (d < 5) for (const p of k.parts ?? []) bases(kinds, kinds?.[p], out, d + 1);
  return out;
}
export function itemGlyph(k, kinds) {
  if (!k) return "bundle";
  if (k.base) return NATURAL[k.base] ?? "bundle";
  const v = (n) => k.props?.[n] ?? 0, b = bases(kinds, k);
  if (v("container") >= 0.5 && v("hard") >= 0.4 && v("flammable") >= 0.6) return "lamp";
  if (v("metal") >= 0.8) return v("plastic") >= 0.5 ? "hotmetal" : v("long") >= 0.3 ? "tool" : v("sharp") >= 0.3 ? "metalblade" : "metal";
  if (k.id?.startsWith("leather:")) return "leather";
  if (k.id?.startsWith("melt:")) return "resin";
  if (v("container") >= 0.3 && v("flexible") >= 0.5 && v("hard") < 0.3 && !b.has("fiber") && !b.has("bark")) return "bag";
  if (v("container") >= 0.3) return "pot";
  if (v("long") >= 0.3 && (v("sharp") >= 0.3 || v("hard") >= 0.4 || v("heavy") >= 0.4)) return "tool";
  if (v("edible") >= 0.3) return b.has("fish") ? "fish" : b.has("meat") ? "meat" : "food";
  if (v("binding") >= 0.3) return "cord";
  if (v("sharp") >= 0.3) return "blade";
  for (const m of ["hide", "bone", "plank", "log", "clay", "stone", "stick"]) if (b.has(m)) return NATURAL[m];
  return "bundle";
}
function bone(c, x0, y0, x1, y1, k, both = true) {
  c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
  c.strokeStyle = INK; c.lineWidth = k * 0.2 + 1.6; c.stroke();
  c.strokeStyle = "#efe8d6"; c.lineWidth = k * 0.2; c.stroke();
  for (const [ex, ey, ox, oy] of both ? [[x0, y0, x1, y1], [x1, y1, x0, y0]] : [[x1, y1, x0, y0]]) {
    const a = Math.atan2(ey - oy, ex - ox), px = -Math.sin(a) * k * 0.12, py = Math.cos(a) * k * 0.12;
    for (const sg of [1, -1]) { c.beginPath(); c.arc(ex + px * sg, ey + py * sg, k * 0.13, 0, Math.PI * 2); inked(c, "#efe8d6", 0.8); }
  }
}
function drawItem(c, th, x, y, kinds) {
  const k = kinds?.[th.item], g = itemGlyph(k, kinds), cooked = k?.verb === "heat", s = T * 0.52, h = (i) => hash(th.x, th.y, 130 + i);
  shadow(c, x, y + s * 0.3, s * 0.45);
  switch (g) {
    case "meat":
      c.beginPath(); c.ellipse(x - s * 0.08, y + s * 0.04, s * 0.34, s * 0.24, -0.4, 0, Math.PI * 2); inked(c, cooked ? "#8d4a2a" : "#b8433a", 1);
      c.strokeStyle = cooked ? "rgba(230, 180, 120, .6)" : "rgba(255, 225, 210, .7)"; c.lineWidth = 1;
      c.beginPath(); c.ellipse(x - s * 0.1, y + s * 0.04, s * 0.2, s * 0.12, -0.4, Math.PI * 1.1, Math.PI * 1.8); c.stroke();
      bone(c, x + s * 0.18, y - s * 0.08, x + s * 0.4, y - s * 0.28, s * 0.6, false);
      break;
    case "hide":
      c.beginPath(); c.moveTo(x - s * 0.45, y - s * 0.12); c.quadraticCurveTo(x, y - s * 0.3, x + s * 0.42, y - s * 0.16); c.lineTo(x + s * 0.36, y + s * 0.22); c.quadraticCurveTo(x, y + s * 0.32, x - s * 0.4, y + s * 0.2); c.closePath();
      inked(c, "#9a6b43", 1);
      c.beginPath(); c.moveTo(x + s * 0.04, y - s * 0.24); c.lineTo(x + s * 0.42, y - s * 0.16); c.lineTo(x + s * 0.1, y + s * 0.06); c.closePath(); inked(c, "#b88a5c", 0.9);
      break;
    case "bone":
      bone(c, x - s * 0.36, y + s * 0.18, x + s * 0.36, y - s * 0.14, s * 0.6);
      break;
    case "fish":
      c.beginPath(); c.moveTo(x + s * 0.28, y); c.lineTo(x + s * 0.5, y - s * 0.16); c.lineTo(x + s * 0.5, y + s * 0.16); c.closePath(); inked(c, cooked ? "#8a603a" : "#7a9096", 1);
      c.beginPath(); c.ellipse(x - s * 0.05, y, s * 0.36, s * 0.16, 0, 0, Math.PI * 2); inked(c, cooked ? "#a0764a" : "#8fa3a8", 1);
      c.strokeStyle = "rgba(255, 255, 255, .5)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - s * 0.24, y + s * 0.06); c.quadraticCurveTo(x, y + s * 0.12, x + s * 0.2, y + s * 0.05); c.stroke();
      c.fillStyle = INK; c.beginPath(); c.arc(x - s * 0.27, y - s * 0.03, s * 0.035, 0, Math.PI * 2); c.fill();
      break;
    case "cord":
      c.beginPath();
      for (let i = 0; i < 3; i++) { const rx = s * (0.14 + i * 0.1), ry = s * (0.08 + i * 0.06); c.moveTo(x + rx, y); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
      c.moveTo(x + s * 0.34, y); c.quadraticCurveTo(x + s * 0.46, y + s * 0.1, x + s * 0.36, y + s * 0.24);
      c.strokeStyle = INK; c.lineWidth = 2.8; c.stroke(); c.strokeStyle = "#c2a468"; c.lineWidth = 1.4; c.stroke();
      break;
    case "tool": {
      const x0 = x - s * 0.42, y0 = y + s * 0.3, x1 = x + s * 0.28, y1 = y - s * 0.26, a = Math.atan2(y1 - y0, x1 - x0);
      c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1);
      c.strokeStyle = INK; c.lineWidth = 3.6; c.stroke(); c.strokeStyle = "#8a6038"; c.lineWidth = 2; c.stroke();
      c.save(); c.translate(x1, y1); c.rotate(a);
      c.beginPath();
      if ((k?.props?.sharp ?? 0) >= 0.3) { c.moveTo(-s * 0.06, -s * 0.15); c.lineTo(s * 0.24, 0); c.lineTo(-s * 0.06, s * 0.15); c.closePath(); }
      else c.ellipse(s * 0.04, 0, s * 0.15, s * 0.12, 0, 0, Math.PI * 2);
      inked(c, (k?.props?.metal ?? 0) >= 0.8 ? "#b9c1c7" : bases(kinds, k).has("flint_blade") ? "#4a4c53" : "#a59c8c", 1);
      c.strokeStyle = "#c2a468"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(-s * 0.12, -s * 0.06); c.lineTo(-s * 0.12, s * 0.06); c.stroke();
      c.restore();
      break;
    }
    case "pot":
      c.beginPath(); c.moveTo(x - s * 0.3, y - s * 0.18); c.bezierCurveTo(x - s * 0.5, y + s * 0.3, x + s * 0.5, y + s * 0.3, x + s * 0.3, y - s * 0.18); c.closePath();
      inked(c, cooked ? "#9a5a32" : "#b0703f", 1);
      c.beginPath(); c.ellipse(x, y - s * 0.18, s * 0.3, s * 0.08, 0, 0, Math.PI * 2); inked(c, cooked ? "#5e3620" : "#7a4a2a", 1);
      c.strokeStyle = "rgba(255, 225, 190, .4)"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(x - s * 0.24, y - s * 0.02); c.quadraticCurveTo(x - s * 0.24, y + s * 0.12, x - s * 0.12, y + s * 0.16); c.stroke();
      break;
    case "plank":
      c.save(); c.translate(x, y); c.rotate(-0.25 + h(0) * 0.5);
      c.beginPath(); c.rect(-s * 0.46, -s * 0.1, s * 0.92, s * 0.2); inked(c, "#c9a06a", 1);
      c.strokeStyle = "rgba(110, 75, 40, .5)"; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(-s * 0.36, -s * 0.02); c.lineTo(s * 0.36, s * 0.02); c.stroke();
      c.restore();
      break;
    case "log":
      c.beginPath(); c.roundRect(x - s * 0.42, y - s * 0.14, s * 0.84, s * 0.28, s * 0.14); inked(c, "#7a5533", 1);
      c.beginPath(); c.ellipse(x + s * 0.36, y, s * 0.08, s * 0.14, 0, 0, Math.PI * 2); inked(c, "#c9a06a", 0.9);
      c.strokeStyle = "rgba(90, 60, 30, .6)"; c.lineWidth = 0.6;
      c.beginPath(); c.ellipse(x + s * 0.36, y, s * 0.035, s * 0.06, 0, 0, Math.PI * 2); c.stroke();
      break;
    case "stick": {
      const a = h(1) * Math.PI;
      c.beginPath(); c.moveTo(x - Math.cos(a) * s * 0.45, y - Math.sin(a) * s * 0.28); c.lineTo(x + Math.cos(a) * s * 0.45, y + Math.sin(a) * s * 0.28);
      c.strokeStyle = INK; c.lineWidth = 3.2; c.stroke(); c.strokeStyle = "#8a6038"; c.lineWidth = 1.8; c.stroke();
      break;
    }
    case "stone": case "blade":
      c.beginPath();
      if (g === "blade") { c.moveTo(x - s * 0.32, y + s * 0.14); c.lineTo(x + s * 0.04, y - s * 0.26); c.lineTo(x + s * 0.34, y + s * 0.1); c.lineTo(x, y + s * 0.2); c.closePath(); }
      else c.ellipse(x, y, s * 0.3, s * 0.2, 0, 0, Math.PI * 2);
      inked(c, g === "blade" ? "#9d9a92" : "#a59c8c", 1);
      c.strokeStyle = "rgba(255, 250, 235, .7)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - s * 0.18, y - s * 0.02); c.lineTo(x + s * 0.02, y - s * 0.16); c.stroke();
      break;
    case "clay":
      c.beginPath(); c.ellipse(x, y + s * 0.04, s * 0.36, s * 0.2, 0, 0, Math.PI * 2); inked(c, "#b0703f", 1);
      break;
    case "food":
      leaf(c, x - s * 0.34, y + s * 0.1, s * 0.66, -0.2, "#77924a", 0.8);
      for (const [dx, dy] of [[-0.08, -0.04], [0.1, 0.02], [0.02, 0.14]]) {
        c.beginPath(); c.arc(x + dx * s, y + dy * s, s * 0.11, 0, Math.PI * 2); inked(c, "#c2313a", 0.8);
      }
      break;
    case "bark":
      c.beginPath(); c.moveTo(x - s * 0.4, y + s * 0.12); c.quadraticCurveTo(x - s * 0.1, y - s * 0.22, x + s * 0.38, y - s * 0.1);
      c.quadraticCurveTo(x + s * 0.44, y + s * 0.02, x + s * 0.34, y + s * 0.06); c.quadraticCurveTo(x - s * 0.06, y - s * 0.06, x - s * 0.32, y + s * 0.22); c.closePath();
      inked(c, "#7b5a3a", 1);
      c.strokeStyle = "rgba(220, 190, 140, .8)"; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(x - s * 0.28, y + s * 0.12); c.quadraticCurveTo(x, y - s * 0.12, x + s * 0.3, y - s * 0.04); c.stroke();
      break;
    case "resin":
      c.beginPath(); c.moveTo(x - s * 0.26, y + s * 0.16); c.bezierCurveTo(x - s * 0.34, y - s * 0.14, x + s * 0.02, y - s * 0.3, x + s * 0.12, y - s * 0.08);
      c.bezierCurveTo(x + s * 0.34, y - s * 0.1, x + s * 0.34, y + s * 0.2, x + s * 0.06, y + s * 0.2); c.closePath();
      inked(c, k?.id?.startsWith("melt:") ? "#b8611a" : "#d9901f", 1);
      c.fillStyle = "rgba(255, 240, 190, .75)"; c.beginPath(); c.ellipse(x - s * 0.1, y - s * 0.04, s * 0.07, s * 0.04, -0.5, 0, Math.PI * 2); c.fill();
      break;
    case "flint":
      c.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, rr = s * (0.24 + h(i) * 0.1); i ? c.lineTo(x + Math.cos(a) * rr * 1.15, y + Math.sin(a) * rr * 0.8) : c.moveTo(x + Math.cos(a) * rr * 1.15, y + Math.sin(a) * rr * 0.8); }
      c.closePath(); inked(c, "#e4dccb", 1);
      c.beginPath(); c.ellipse(x + s * 0.04, y + s * 0.02, s * 0.2, s * 0.13, 0.3, 0, Math.PI * 2); c.fillStyle = "#3b3d44"; c.fill();
      c.fillStyle = "rgba(220, 230, 240, .6)"; c.beginPath(); c.ellipse(x - s * 0.02, y - s * 0.03, s * 0.06, s * 0.03, 0.3, 0, Math.PI * 2); c.fill();
      break;
    case "flintblade": case "metalblade": {
      const steel = g === "metalblade";
      c.beginPath(); c.moveTo(x - s * 0.38, y + s * 0.16); c.lineTo(x + s * 0.4, y - s * 0.2); c.lineTo(x + s * 0.12, y + s * 0.14); c.closePath();
      inked(c, steel ? "#c3cad0" : "#44464d", 1);
      c.strokeStyle = steel ? "rgba(255, 255, 255, .9)" : "rgba(200, 210, 225, .7)"; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - s * 0.3, y + s * 0.12); c.lineTo(x + s * 0.34, y - s * 0.17); c.stroke();
      break;
    }
    case "fat":
      c.beginPath(); c.ellipse(x, y + s * 0.04, s * 0.3, s * 0.18, 0.2, 0, Math.PI * 2); inked(c, "#efe3c2", 1);
      c.fillStyle = "rgba(200, 150, 110, .5)"; c.beginPath(); c.ellipse(x + s * 0.08, y + s * 0.08, s * 0.12, s * 0.05, 0.2, 0, Math.PI * 2); c.fill();
      break;
    case "charcoal":
      for (const [dx, dy, rr] of [[-0.14, 0.06, 0.15], [0.14, 0.08, 0.13], [0, -0.08, 0.14]]) {
        c.beginPath(); c.moveTo(x + (dx - rr) * s, y + (dy + rr * 0.6) * s); c.lineTo(x + (dx - rr * 0.6) * s, y + (dy - rr * 0.7) * s); c.lineTo(x + (dx + rr) * s, y + (dy - rr * 0.4) * s); c.lineTo(x + (dx + rr * 0.8) * s, y + (dy + rr * 0.7) * s); c.closePath();
        inked(c, "#26221f", 0.9);
      }
      c.strokeStyle = "rgba(170, 170, 180, .55)"; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(x - s * 0.1, y - s * 0.1); c.lineTo(x + s * 0.06, y - s * 0.14); c.stroke();
      break;
    case "ore":
      c.beginPath(); c.ellipse(x, y, s * 0.3, s * 0.21, 0.1, 0, Math.PI * 2); inked(c, "#9c5236", 1);
      c.fillStyle = "rgba(210, 120, 70, .7)";
      for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(x + (h(i) - 0.5) * s * 0.36, y + (h(i + 4) - 0.5) * s * 0.22, s * 0.035, 0, Math.PI * 2); c.fill(); }
      break;
    case "metal": case "hotmetal": {
      const hot = g === "hotmetal";
      if (hot) { const gl = c.createRadialGradient(x, y, 0, x, y, s * 0.55); gl.addColorStop(0, "rgba(255, 150, 60, .55)"); gl.addColorStop(1, "rgba(255, 150, 60, 0)"); c.fillStyle = gl; c.fillRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2); }
      c.beginPath(); c.roundRect(x - s * 0.3, y - s * 0.14, s * 0.6, s * 0.28, s * 0.1); inked(c, hot ? "#f08a3a" : "#8e969c", 1);
      c.strokeStyle = hot ? "rgba(255, 230, 160, .9)" : "rgba(255, 255, 255, .7)"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(x - s * 0.22, y - s * 0.06); c.lineTo(x + s * 0.18, y - s * 0.08); c.stroke();
      break;
    }
    case "leather":
      c.beginPath(); c.moveTo(x - s * 0.42, y - s * 0.1); c.quadraticCurveTo(x, y - s * 0.26, x + s * 0.4, y - s * 0.12); c.lineTo(x + s * 0.34, y + s * 0.22); c.quadraticCurveTo(x, y + s * 0.3, x - s * 0.38, y + s * 0.2); c.closePath();
      inked(c, "#6e4526", 1);
      c.setLineDash([2, 2]); c.strokeStyle = "rgba(230, 200, 150, .8)"; c.lineWidth = 0.8;
      c.beginPath(); c.moveTo(x - s * 0.32, y + s * 0.12); c.quadraticCurveTo(x, y + s * 0.2, x + s * 0.28, y + s * 0.14); c.stroke(); c.setLineDash([]);
      break;
    case "bag":
      c.beginPath(); c.moveTo(x - s * 0.1, y - s * 0.2); c.bezierCurveTo(x - s * 0.46, y - s * 0.1, x - s * 0.38, y + s * 0.3, x, y + s * 0.28); c.bezierCurveTo(x + s * 0.38, y + s * 0.3, x + s * 0.46, y - s * 0.1, x + s * 0.1, y - s * 0.2); c.closePath();
      inked(c, k?.parts?.some((p) => p.startsWith("leather:")) ? "#6e4526" : "#9a6b43", 1);
      c.strokeStyle = "#c2a468"; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x - s * 0.14, y - s * 0.2); c.lineTo(x + s * 0.14, y - s * 0.2); c.stroke();
      break;
    case "lamp": {
      c.beginPath(); c.moveTo(x - s * 0.32, y - s * 0.04); c.bezierCurveTo(x - s * 0.34, y + s * 0.26, x + s * 0.34, y + s * 0.26, x + s * 0.32, y - s * 0.04); c.closePath();
      inked(c, "#9a5a32", 1);
      c.beginPath(); c.ellipse(x, y - s * 0.04, s * 0.32, s * 0.08, 0, 0, Math.PI * 2); inked(c, "#efe3c2", 0.9);
      if (k?.id?.startsWith("burning:")) {
        c.beginPath(); c.moveTo(x - s * 0.06, y - s * 0.06); c.quadraticCurveTo(x - s * 0.07, y - s * 0.24, x, y - s * 0.34); c.quadraticCurveTo(x + s * 0.07, y - s * 0.24, x + s * 0.06, y - s * 0.06); c.closePath();
        c.fillStyle = "#f2a33a"; c.fill();
        c.beginPath(); c.ellipse(x, y - s * 0.12, s * 0.025, s * 0.06, 0, 0, Math.PI * 2); c.fillStyle = "#fff0c0"; c.fill();
      } else { c.strokeStyle = INK; c.lineWidth = 1.2; c.beginPath(); c.moveTo(x, y - s * 0.06); c.lineTo(x + s * 0.03, y - s * 0.16); c.stroke(); }
      break;
    }
    default:
      c.beginPath(); c.moveTo(x - s * 0.3, y + s * 0.26); c.quadraticCurveTo(x - s * 0.44, y - s * 0.1, x - s * 0.1, y - s * 0.18); c.lineTo(x + s * 0.1, y - s * 0.18);
      c.quadraticCurveTo(x + s * 0.44, y - s * 0.1, x + s * 0.3, y + s * 0.26); c.closePath();
      inked(c, "#b59a68", 1);
      c.strokeStyle = INK; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x - s * 0.1, y - s * 0.18); c.lineTo(x - s * 0.18, y - s * 0.32); c.moveTo(x + s * 0.1, y - s * 0.18); c.lineTo(x + s * 0.18, y - s * 0.32); c.stroke();
      c.strokeStyle = "#6b4a2b"; c.lineWidth = 1.8;
      c.beginPath(); c.moveTo(x - s * 0.14, y - s * 0.12); c.lineTo(x + s * 0.14, y - s * 0.12); c.stroke();
  }
  if ((th.n ?? 1) > 1) badge(c, x + s * 0.5, y + s * 0.3, th.n);
}
function badge(c, x, y, n) {
  c.save();
  c.font = `700 9px "Alegreya Sans", sans-serif`;
  const t = String(n), w = Math.max(11, c.measureText(t).width + 6);
  c.beginPath(); c.roundRect(x - w / 2, y - 5.5, w, 11, 5.5);
  c.fillStyle = "rgba(243, 234, 214, .95)"; c.fill(); c.strokeStyle = INK; c.lineWidth = 0.8; c.stroke();
  c.fillStyle = INK; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(t, x, y + 0.5);
  c.restore();
}

// Abandoned homes fly a faded, torn rag instead of an owner's color.
const RAG = "rag";
function flag(c, x, y, s, color) {
  if (!color) return;
  if (color === RAG) {
    c.strokeStyle = INK; c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x, y + s * 0.2); c.lineTo(x + s * 0.02, y - s * 0.14); c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.02, y - s * 0.14); c.lineTo(x + s * 0.1, y - s * 0.1); c.lineTo(x + s * 0.07, y - s * 0.08); c.lineTo(x + s * 0.12, y - s * 0.05); c.lineTo(x + s * 0.015, y - s * 0.04); c.closePath();
    inked(c, "#b7ab92", 0.9);
    return;
  }
  c.strokeStyle = INK; c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(x, y + s * 0.2); c.lineTo(x, y - s * 0.16); c.stroke();
  c.beginPath(); c.moveTo(x, y - s * 0.16); c.lineTo(x + s * 0.2, y - s * 0.1); c.lineTo(x, y - s * 0.03); c.closePath();
  inked(c, color, 1);
}

// Flame colors by how hot the fire burns: orange for wood, yellow in a ring, near white on charcoal with air in it.
const FLAMES = [[1, ["#c4541d", "#e8952e", "#f6d68a"]], [1.3, ["#d8701f", "#f2b340", "#fbe8a8"]], [2, ["#eba83a", "#fadf7c", "#fffbe8"]], [2.5, ["#f4d27e", "#fff4cc", "#f4f9ff"]]];
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function flameColors(heat = 1) {
  const j = FLAMES.findIndex(([h]) => h >= heat), i = j < 0 ? FLAMES.length - 2 : Math.max(0, j - 1), [h0, a] = FLAMES[i], [h1, b] = FLAMES[i + 1];
  const k = h1 > h0 ? Math.max(0, Math.min(1, (heat - h0) / (h1 - h0))) : 0;
  return a.map((ca, j) => { const x = rgb(ca), y = rgb(b[j]); return `rgb(${x.map((v, n) => Math.round(v + (y[n] - v) * k)).join(",")})`; });
}
// Fires are drawn live so they flicker. ring: loose stones, or a built "stone" / "brick" hearth.
// heat tints the flames, coal lays a glowing bed of charcoal under them, covered heaps a smoldering dome over the fire.
export function drawFire(c, x, y, s, now, seed, ring = "loose", power = 1, { heat = 1, coal = false, covered = false } = {}) {
  c.save();
  c.translate(x, y);
  c.lineJoin = "round";
  const loose = ring === "loose", n = loose ? 6 : 11, rx = loose ? 0.28 : 0.4, ry = loose ? 0.12 : 0.17;
  if (!loose) { c.beginPath(); c.ellipse(0, s * 0.12, s * rx, s * ry, 0, 0, Math.PI * 2); c.fillStyle = "#3a2418"; c.fill(); }
  const stone = (i) => {
    const a = (i / n) * Math.PI * 2, px = Math.cos(a) * s * rx, py = Math.sin(a) * s * ry + s * 0.12;
    c.beginPath();
    if (ring === "brick") {
      c.save(); c.translate(px, py); c.rotate(Math.atan2(Math.cos(a) * ry, -Math.sin(a) * rx));
      c.roundRect(-s * 0.07, -s * 0.035, s * 0.14, s * 0.07, 1);
      c.restore();
    } else c.ellipse(px, py, s * (loose ? 0.09 : 0.1), s * (loose ? 0.06 : 0.07), 0, 0, Math.PI * 2);
    c.fillStyle = ring === "brick" ? "#a4533a" : "#9a9080"; c.fill(); c.strokeStyle = INK; c.lineWidth = 0.8; c.stroke();
  };
  const ids = [...Array(n).keys()], behind = (i) => Math.sin((i / n) * Math.PI * 2) < 0;
  ids.filter(behind).forEach(stone);
  const t = now / 140 + seed * 10, hk = power, wk = 0.75 + 0.25 * power;
  if (coal) {
    const pulse = 0.8 + Math.sin(t * 0.7) * 0.15;
    const bed = c.createRadialGradient(0, s * 0.12, 0, 0, s * 0.12, s * 0.34);
    bed.addColorStop(0, `rgba(255, 236, 170, ${pulse})`); bed.addColorStop(0.5, `rgba(240, 110, 40, ${pulse * 0.9})`); bed.addColorStop(1, "rgba(120, 30, 10, 0)");
    c.fillStyle = bed; c.beginPath(); c.ellipse(0, s * 0.12, s * 0.34, s * 0.15, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#2a201b";
    for (let i = 0; i < 5; i++) { c.beginPath(); c.ellipse((hash(seed * 100, i, 3) - 0.5) * s * 0.4, s * (0.1 + hash(seed * 100, i, 4) * 0.06), s * 0.04, s * 0.025, 0, 0, Math.PI * 2); c.fill(); }
  }
  const flame = (h, w, col) => {
    const f1 = Math.sin(t) * 0.08, f2 = Math.cos(t * 1.3) * 0.08;
    h *= hk; w *= wk;
    c.beginPath();
    c.moveTo(-w * s, s * 0.1);
    c.quadraticCurveTo(-w * s * 1.1, -h * s * 0.4, (f1 - 0.02) * s, -h * s);
    c.quadraticCurveTo(w * s * 1.1 + f2 * s, -h * s * 0.4, w * s, s * 0.1);
    c.closePath();
    c.fillStyle = col; c.fill();
  };
  const [outer, mid, core] = flameColors(heat);
  const low = covered ? 0.45 : 1;
  flame((0.62 + Math.sin(t * 1.7) * 0.06) * low, 0.2, outer);
  flame((0.44 + Math.cos(t * 2.1) * 0.05) * low, 0.13, mid);
  flame(0.24 * low, 0.07, core);
  ids.filter((i) => !behind(i)).forEach(stone);
  if (covered) {
    // A dome of stone heaped over the fire, glowing through a gap at the front.
    c.beginPath(); c.ellipse(0, s * 0.1, s * 0.4, s * 0.36, 0, Math.PI, 0); c.lineTo(s * 0.4, s * 0.16); c.lineTo(-s * 0.4, s * 0.16); c.closePath();
    inked(c, ring === "brick" ? "#9a5a3e" : "#958b7b", 1);
    c.save(); c.clip();
    c.strokeStyle = "rgba(58, 42, 26, .45)"; c.lineWidth = 0.8;
    for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse((hash(seed * 100, i, 7) - 0.5) * s * 0.6, -s * (0.02 + hash(seed * 100, i, 8) * 0.2), s * 0.09, s * 0.06, 0, 0, Math.PI * 2); c.stroke(); }
    c.restore();
    const gap = c.createRadialGradient(0, s * 0.1, 0, 0, s * 0.1, s * 0.12);
    gap.addColorStop(0, core); gap.addColorStop(1, outer);
    c.fillStyle = gap; c.beginPath(); c.ellipse(0, s * 0.09, s * 0.1, s * 0.06, 0, Math.PI, 0); c.closePath(); c.fill();
  }
  c.restore();
}
// Flames licking along something that's on fire; k is intensity 0..1.
export function drawFlames(c, x, y, w, h, now, seed, k) {
  const n = 2 + Math.round(k * 3);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1) - 0.5, t = now / 130 + seed * 10 + i * 1.7;
    const hh = h * (0.45 + 0.55 * k) * (0.7 + 0.3 * hash(i, 3, seed * 1000)) * (1 + Math.sin(t * 1.6) * 0.1) * (1 - Math.abs(u) * 0.5);
    const ww = w * (0.12 + 0.08 * k), bx = x + u * w * 0.8, by = y - Math.abs(u) * h * 0.08;
    const layer = (hk, wk, col) => {
      const f1 = Math.sin(t) * 0.1, f2 = Math.cos(t * 1.3) * 0.1;
      c.beginPath(); c.moveTo(bx - ww * wk, by);
      c.quadraticCurveTo(bx - ww * wk * 1.1, by - hh * hk * 0.45, bx + f1 * ww * 2, by - hh * hk);
      c.quadraticCurveTo(bx + ww * wk * 1.1 + f2 * ww, by - hh * hk * 0.45, bx + ww * wk, by);
      c.closePath(); c.fillStyle = col; c.fill();
    };
    layer(1, 1, "rgba(196, 84, 29, .92)");
    layer(0.68, 0.64, "#e8952e");
    layer(0.36, 0.34, "#f6d68a");
  }
}
export function drawSmoke(c, x, y, s, now, seed, k, wind) {
  c.save();
  c.fillStyle = "#6b645c";
  for (let i = 0; i < 4; i++) {
    const p = (now / 2600 + seed + i / 4) % 1;
    c.globalAlpha = (1 - p) * 0.35 * k;
    c.beginPath();
    c.arc(x + (wind?.dx ?? 0) * p * s * 1.8 + Math.sin(p * 6 + i) * s * 0.12, y - p * s * 1.6, s * (0.15 + p * 0.35), 0, Math.PI * 2);
    c.fill();
  }
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
  if (a.stage === "elder") { c.strokeStyle = "rgba(226, 226, 222, .95)"; c.lineWidth = Math.max(1.6, r * 0.14); }
  else { c.strokeStyle = "rgba(255, 240, 210, .45)"; c.lineWidth = 1; }
  c.stroke();
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

// Trampled earth. Strokes of equal wear share one path so overlaps don't darken into beads.
export function drawPaths(c, paths, W, H, x0, y0, x1, y1) {
  if (!paths) return;
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : paths[y * W + x]);
  const pt = (x, y) => [(x + 0.5 + (hash(x, y, 81) - 0.5) * 0.5) * T, (y + 0.5 + (hash(x, y, 82) - 0.5) * 0.5) * T];
  const byWear = Array.from({ length: 10 }, () => []);
  for (let y = y0 - 1; y <= y1 + 1; y++)
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const v = at(x, y);
      if (!v) continue;
      const p = pt(x, y);
      byWear[v].push([p, p]);
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const u = at(x + dx, y + dy);
        if (!u || (dx && dy && (at(x + dx, y) || at(x, y + dy)))) continue;
        byWear[Math.min(v, u)].push([p, pt(x + dx, y + dy)]);
      }
    }
  c.save();
  c.lineCap = "round"; c.lineJoin = "round";
  for (let w = 1; w <= 9; w++) {
    if (!byWear[w].length) continue;
    c.beginPath();
    for (const [[ax, ay], [bx, by]] of byWear[w]) { c.moveTo(ax, ay); c.lineTo(bx, by); }
    c.strokeStyle = `rgba(140, 100, 58, ${(0.06 + w * 0.03).toFixed(3)})`; c.lineWidth = T * (0.12 + w * 0.025);
    c.stroke();
  }
  c.restore();
}

// ---------- weather, in screen space ----------
const mod = (a, m) => ((a % m) + m) % m;
export function drawRain(c, w, h, now, heavy, wind = 0) {
  const n = Math.min(heavy ? 480 : 260, Math.round((w * h) / (heavy ? 3200 : 6000)));
  const len = heavy ? 18 : 12, slant = 0.15 + wind * 0.45;
  c.save();
  c.strokeStyle = heavy ? "rgba(205, 216, 232, .55)" : "rgba(214, 224, 238, .45)"; c.lineWidth = 1; c.lineCap = "round";
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const v = (heavy ? 900 : 650) * (0.75 + hash(i, 2, 5) * 0.5);
    const y = mod(hash(i, 1, 5) * (h + 40) + (now / 1000) * v, h + 40) - 20;
    const x = mod(hash(i, 3, 5) * (w + 80) + y * slant, w + 80) - 40;
    c.moveTo(x - slant * len, y - len); c.lineTo(x, y);
  }
  c.stroke();
  c.restore();
}
export function drawSnow(c, w, h, now, amount, wind = 0) {
  const n = Math.min(320, Math.round(((w * h) / 9000) * amount));
  c.save();
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const v = 22 + hash(i, 2, 8) * 30, r = 0.8 + hash(i, 4, 8) * 1.8;
    const y = mod(hash(i, 1, 8) * (h + 20) + (now / 1000) * v, h + 20) - 10;
    const x = mod(hash(i, 3, 8) * (w + 40) + Math.sin(now / 1600 + i) * 14 + y * wind * 0.35, w + 40) - 20;
    c.moveTo(x + r, y); c.arc(x, y, r, 0, Math.PI * 2);
  }
  c.fillStyle = "rgba(255, 255, 255, .88)"; c.fill();
  c.strokeStyle = "rgba(90, 100, 120, .3)"; c.lineWidth = 0.6; c.stroke();
  c.restore();
}
export function drawBolt(c, x, y, seed) {
  const x0 = x + (hash(seed, 1, 9) - 0.5) * 160;
  c.save();
  c.beginPath(); c.moveTo(x0, 0);
  for (let i = 1; i <= 9; i++) {
    const k = i / 9;
    c.lineTo(x0 + (x - x0) * k + (hash(seed, i + 2, 9) - 0.5) * 50 * (1 - k), y * k);
  }
  c.lineJoin = "round";
  c.shadowColor = "rgba(200, 220, 255, .9)"; c.shadowBlur = 14;
  c.strokeStyle = "rgba(255, 255, 240, .95)"; c.lineWidth = 3; c.stroke();
  c.shadowBlur = 0; c.strokeStyle = "#fff"; c.lineWidth = 1.2; c.stroke();
  c.restore();
}

// ---------- animals: small inked side views, facing dir (1 right, -1 left) ----------
const hashId = (id) => {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return hash(h, 7, 3);
};
export function drawAnimal(c, an, x, y, s, now, dir, moving, selected) {
  const deer = an.species !== "wolf", seed = hashId(an.id);
  const trapped = an.state === "trapped", rest = an.state === "rest" || trapped, down = an.state === "graze" || an.state === "eat";
  const fast = an.state === "flee" || an.state === "hunt" || an.state === "attack";
  const t = now / (fast ? 60 : 110) + seed * 20;
  const body = deer ? "#b98a55" : "#8d8a84", dark = deer ? "#7e5a34" : "#5a5753", lw = Math.max(0.8, s * 0.045);
  c.save();
  if (!trapped) shadowEllipse(c, x, y + s * 0.3, s * 0.36);
  if (selected) {
    c.strokeStyle = "#a8321f"; c.lineWidth = 1.6; c.setLineDash([3, 4]); c.lineDashOffset = -now / 60;
    c.beginPath(); c.ellipse(x, y + s * 0.08, s * 0.6, s * 0.42, 0, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
  }
  if (trapped) c.translate(x + (moving ? Math.sin(now / 45 + seed * 9) * s * 0.025 : 0), y);
  else c.translate(x, y + (moving && !rest ? -Math.abs(Math.sin(t)) * s * 0.06 : 0));
  c.scale(dir < 0 ? -1 : 1, 1);
  c.lineJoin = "round"; c.lineCap = "round";
  const by = rest ? s * 0.17 : 0;
  if (!rest) {
    c.strokeStyle = INK; c.lineWidth = Math.max(1, s * 0.055);
    c.beginPath();
    for (const [lx, ph] of [[-0.2, 0], [-0.13, Math.PI], [0.14, Math.PI * 0.5], [0.21, Math.PI * 1.5]]) {
      c.moveTo(lx * s, s * 0.04); c.lineTo(lx * s + (moving ? Math.sin(t * 2 + ph) * s * 0.07 : 0), s * 0.3);
    }
    c.stroke();
  }
  c.beginPath();
  if (deer) c.ellipse(-s * 0.3, by - s * 0.07, s * 0.05, s * 0.04, -0.5, 0, Math.PI * 2);
  else { c.moveTo(-s * 0.26, by - s * 0.06); c.quadraticCurveTo(-s * 0.46, by - s * 0.02, -s * 0.44, by + s * 0.14); c.quadraticCurveTo(-s * 0.36, by + s * 0.04, -s * 0.24, by + s * 0.02); c.closePath(); }
  inked(c, deer ? "#f1e8d6" : dark, lw);
  const hx = s * 0.34, hy = down ? by + s * 0.14 : trapped ? by - s * 0.22 : rest ? by - s * 0.12 : by - (deer ? s * 0.24 : s * 0.12);
  c.beginPath(); c.moveTo(s * 0.14, by - s * 0.09); c.lineTo(hx - s * 0.04, hy - s * 0.04); c.lineTo(hx + s * 0.01, hy + s * 0.05); c.lineTo(s * 0.24, by + s * 0.06); c.closePath();
  inked(c, body, lw);
  c.beginPath(); c.ellipse(0, by, s * 0.29, s * 0.13, 0, 0, Math.PI * 2); inked(c, body, lw);
  c.fillStyle = deer ? "rgba(255, 240, 215, .45)" : "rgba(60, 55, 50, .45)";
  c.beginPath(); c.ellipse(0, by + (deer ? s * 0.06 : -s * 0.06), s * 0.2, s * 0.045, 0, 0, Math.PI * 2); c.fill();
  c.save(); c.translate(hx, hy); c.rotate(down ? 0.9 : trapped ? -0.35 : deer ? 0.15 : 0.05); c.scale(1.25, 1.25);
  c.beginPath();
  if (deer) c.ellipse(-s * 0.04, -s * 0.08, s * 0.03, s * 0.06, -0.5, 0, Math.PI * 2);
  else { c.moveTo(-s * 0.07, -s * 0.03); c.lineTo(-s * 0.05, -s * 0.13); c.lineTo(0, -s * 0.04); c.closePath(); }
  inked(c, deer ? body : dark, lw * 0.8);
  if (deer && seed > 0.45) {
    c.strokeStyle = "#5a4028"; c.lineWidth = Math.max(0.8, s * 0.03);
    c.beginPath(); c.moveTo(-s * 0.02, -s * 0.06); c.lineTo(-s * 0.06, -s * 0.2); c.moveTo(-s * 0.045, -s * 0.14); c.lineTo(-s * 0.12, -s * 0.18); c.moveTo(-s * 0.055, -s * 0.18); c.lineTo(0, -s * 0.24); c.stroke();
  }
  const snout = deer ? 0.12 : 0.14;
  c.beginPath(); c.moveTo(-s * 0.07, -s * 0.05); c.quadraticCurveTo(s * 0.02, -s * 0.08, s * snout, -s * 0.01); c.quadraticCurveTo(s * 0.1, s * 0.05, -s * 0.02, s * 0.05); c.quadraticCurveTo(-s * 0.09, s * 0.02, -s * 0.07, -s * 0.05); c.closePath();
  inked(c, body, lw);
  c.fillStyle = INK;
  c.beginPath(); c.arc(s * (snout - 0.005), -s * 0.005, s * 0.018, 0, Math.PI * 2); c.fill();
  c.fillStyle = an.state === "attack" || an.state === "hunt" ? "#a8321f" : INK;
  c.beginPath(); c.arc(-s * 0.005, -s * 0.025, s * 0.016, 0, Math.PI * 2); c.fill();
  c.restore();
  c.restore();
}
// An animal stuck in a trap: drawn inside the hole, then the near rim over it. k is screen px per tile.
export function drawTrapped(c, an, x, y, k, now, dir, shake, selected) {
  const hy = y + HOLE.dy * k, rx = HOLE.rx * k, ry = HOLE.ry * k, s = k * (an.species === "wolf" ? 0.95 : 1.05);
  c.save();
  c.beginPath(); c.rect(x - k * 2, y - k * 2, k * 4, hy - (y - k * 2)); c.ellipse(x, hy, rx, ry, 0, 0, Math.PI * 2); c.clip();
  drawAnimal(c, an, x, hy - s * 0.05, s * 0.9, now, dir, shake, false);
  c.restore();
  c.save();
  c.lineCap = "round";
  c.beginPath(); c.ellipse(x, hy, rx, ry, 0, 0.08, Math.PI - 0.08);
  c.strokeStyle = "#9c7b52"; c.lineWidth = Math.max(2, k * 0.07); c.stroke();
  c.strokeStyle = INK; c.lineWidth = Math.max(1, k * 0.035); c.stroke();
  if (selected) {
    c.strokeStyle = "#a8321f"; c.lineWidth = 1.6; c.setLineDash([3, 4]); c.lineDashOffset = -now / 60;
    c.beginPath(); c.ellipse(x, hy - k * 0.1, rx * 1.9, k * 0.42, 0, 0, Math.PI * 2); c.stroke();
  }
  c.restore();
}
