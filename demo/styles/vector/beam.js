// The vector monitor: a beam that draws lines on black, black occluder fills for hidden-line removal, then the
// phosphor (glow, hot white cores), the dark glass and the tube's curvature.

// One colour per class of thing, as on a colour vector cabinet.
export const PAL = {
  land: [0.3, 0.42, 1.0],
  rock: [0.7, 0.66, 1.0],
  sand: [1.0, 0.82, 0.3],
  plant: [0.24, 1.0, 0.42],
  water: [0.16, 0.86, 1.0],
  camp: [1.0, 0.82, 0.28],
  fire: [1.0, 0.36, 0.1],
  flame: [1.0, 0.78, 0.25],
  people: [1.0, 0.96, 0.86],
  hud: [1.0, 0.18, 0.22],
};

export const mkCanvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });

export class Beam {
  constructor(W, H, seed = 1) {
    this.W = W;
    this.H = H;
    this.canvas = mkCanvas(W, H);
    const g = (this.g = this.canvas.getContext("2d", { willReadFrequently: true }));
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    g.lineCap = g.lineJoin = "round";
    let s = (seed * 2654435761) >>> 0;
    this.rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.J = 0.28;
    this.width = 1.15;
  }
  j() { return (this.rand() + this.rand() - 1) * this.J; }
  css(c, I) {
    const k = 255 * I;
    return `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
  }
  // Black occluder with a black hairline round it so neighbouring fills leave no seams for hidden lines to leak through.
  occlude(p) {
    const g = this.g;
    g.beginPath();
    g.moveTo(p[0], p[1]);
    for (let k = 2; k < p.length; k += 2) g.lineTo(p[k], p[k + 1]);
    g.closePath();
    g.fillStyle = "#000";
    g.fill();
    g.lineWidth = 1.1;
    g.strokeStyle = "#000";
    g.stroke();
  }
  // A run of vectors. Short runs come out brighter since the beam's dwell at the ends dominates; ends get a bright dot.
  poly(p, closed, c, I, o) {
    if (I <= 0.01) return;
    const g = this.g, n = p.length;
    let len = 0;
    for (let k = 2; k < n; k += 2) len += Math.abs(p[k] - p[k - 2]) + Math.abs(p[k + 1] - p[k - 1]);
    const boost = 1 + 0.7 / (1 + len / 6);
    const jit = !(o && o.steady);
    g.beginPath();
    g.moveTo(p[0] + (jit ? this.j() : 0), p[1] + (jit ? this.j() : 0));
    for (let k = 2; k < n; k += 2) g.lineTo(p[k] + (jit ? this.j() : 0), p[k + 1] + (jit ? this.j() : 0));
    if (closed) g.closePath();
    g.lineWidth = (o && o.width) || this.width;
    g.strokeStyle = this.css(c, I * boost);
    g.stroke();
    if (o && o.ends) {
      g.fillStyle = this.css(c, Math.min(1.6, I * boost * 1.35));
      const r = (o.dot || 1.7) / 2;
      g.fillRect(p[0] - r, p[1] - r, r * 2, r * 2);
      if (!closed) g.fillRect(p[n - 2] - r, p[n - 1] - r, r * 2, r * 2);
      if (o.ends === "all") for (let k = 2; k < n - 2; k += 2) g.fillRect(p[k] - r, p[k + 1] - r, r * 2, r * 2);
    }
  }
  seg(x0, y0, x1, y1, c, I, w) {
    if (I <= 0.01) return;
    const g = this.g, len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.lineWidth = w || this.width;
    g.strokeStyle = this.css(c, I * (1 + 0.7 / (1 + len / 6)));
    g.stroke();
  }
  dot(x, y, c, I, d = 1.7) {
    if (I <= 0.01) return;
    this.g.fillStyle = this.css(c, I);
    this.g.fillRect(x - d / 2, y - d / 2, d, d);
  }
  // Emissive strokes (flames, sparks) add up instead of covering, as overlapping beams do on the phosphor.
  glow(fn) {
    this.g.globalCompositeOperation = "lighter";
    fn();
    this.g.globalCompositeOperation = "source-over";
  }
}

function blurred(src, W, H, radius, scale) {
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const small = mkCanvas(w, h), s = small.getContext("2d");
  s.filter = `blur(${Math.max(0.5, radius * scale)}px)`;
  s.drawImage(src, 0, 0, w, h);
  const big = mkCanvas(W, H), b = big.getContext("2d", { willReadFrequently: true });
  b.imageSmoothingEnabled = true;
  b.imageSmoothingQuality = "high";
  b.drawImage(small, 0, 0, W, H);
  return b.getImageData(0, 0, W, H).data;
}

// Phosphor and tube: bloom layers, hot cores bleaching toward white, glass reflection, and barrel curvature.
export function present(beam, out) {
  const { W, H } = beam, src = beam.canvas;
  const core = beam.g.getImageData(0, 0, W, H).data;
  const g1 = blurred(src, W, H, 1.6, 1), g2 = blurred(src, W, H, 6, 0.5), g3 = blurred(src, W, H, 22, 0.25);
  out.width = W;
  out.height = H;
  const o = out.getContext("2d"), img = o.createImageData(W, H), d = img.data;
  const cx = 5.2, cy = 4.2; // tube curvature: bigger is flatter
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < H; y++) {
    const ny = (y + 0.5) / H * 2 - 1;
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5) / W * 2 - 1;
      const ux = nx * (1 + (ny / cx) ** 2), uy = ny * (1 + (nx / cy) ** 2);
      const q = (y * W + x) * 4;
      // rounded edge of the tube face
      const ex = Math.max(0, Math.abs(ux) - 0.94) / 0.06, ey = Math.max(0, Math.abs(uy) - 0.9) / 0.1;
      const edge = Math.hypot(ex, ey);
      if (edge >= 1) {
        const rim = Math.max(0, 1 - (edge - 1) * 40) * 10;
        d[q] = 3 + rim; d[q + 1] = 3 + rim; d[q + 2] = 4 + rim; d[q + 3] = 255;
        continue;
      }
      const sy = (uy + 1) / 2 * H - 0.5, y0 = Math.max(0, Math.min(H - 2, Math.floor(sy))), fy = Math.max(0, Math.min(1, sy - y0));
      // the three guns converge a little off toward the edges, as on a real colour tube
      const mis = 0.3 + 0.9 * (ux * ux + uy * uy * 0.5);
      const lit = [0, 0, 0];
      let ni = 0;
      for (let c = 0; c < 3; c++) {
        const sx = (ux + 1) / 2 * W - 0.5 + (1 - c) * mis;
        const x0 = Math.max(0, Math.min(W - 2, Math.floor(sx))), fx = Math.max(0, Math.min(1, sx - x0));
        const i00 = (y0 * W + x0) * 4, i01 = i00 + W * 4;
        const b = (core[i00 + c] * (1 - fx) + core[i00 + 4 + c] * fx) * (1 - fy) + (core[i01 + c] * (1 - fx) + core[i01 + 4 + c] * fx) * fy;
        if (c === 1) ni = i00;
        lit[c] = b;
      }
      for (let c = 0; c < 3; c++) lit[c] = (lit[c] + g1[ni + c] * 0.7 + g2[ni + c] * 0.6 + g3[ni + c] * 0.45) / 255;
      // hot beams bleach toward white where one gun saturates
      const m = Math.max(lit[0], lit[1], lit[2]), over = Math.max(0, m - 0.85) * 0.6;
      // dark glass: a vignette and a whisper of grain
      const r2 = ux * ux * 0.8 + uy * uy;
      // a window behind the player reflected in the glass: a soft pane up left, a thin diagonal glint, a dim lamp low right
      const pane = Math.exp(-(((ux + 0.58) ** 2) / 0.16 + ((uy + 0.62) ** 2) / 0.07));
      const glint = Math.exp(-((ux * 0.7 + uy + 1.05) ** 2) / 0.004) * Math.max(0, -ux - 0.1);
      const sheen = 0.06 * pane + 0.035 * glint + 0.014 * Math.exp(-(((ux - 0.6) ** 2) / 0.5 + ((uy - 0.75) ** 2) / 0.2));
      const vig = 1 - 0.28 * r2, fade = Math.min(1, (1 - edge) * 6);
      const grain = (rnd() - 0.5) * 0.012;
      const glass = [0.012 + sheen * 0.8 + grain, 0.016 + sheen * 0.9 + grain, 0.022 + sheen + grain];
      for (let c = 0; c < 3; c++) {
        const v = Math.min(1, lit[c] + over) * vig;
        d[q + c] = Math.max(0, Math.min(255, (1 - (1 - v) * (1 - glass[c])) * 255 * fade + 3 * (1 - fade)));
      }
      d[q + 3] = 255;
    }
  }
  o.putImageData(img, 0, 0);
}
