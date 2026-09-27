// The terminal: a 24-color palette, CP437 bitmap faces, a pixel buffer of glyph cells, and the CRT it is shown on.
export const W = 1280, H = 720;

// One letter per color, used by the text markup ("&W" switches to yellow).
const HEX = {
  0: "#07181a", k: "#0f3b3a", K: "#1f5a57", s: "#5d7a74", y: "#a8c0b8", Y: "#f2f5e8",
  b: "#0a3d8f", B: "#1c86e8", c: "#3aa0b4", C: "#86d0dc",
  p: "#0b6e46", g: "#16902c", G: "#3cc43a", l: "#a4cc3c", v: "#7c7a30",
  w: "#8e6c44", t: "#d0b47a", W: "#ecd35a", O: "#f29a1e", o: "#e8601c", R: "#d0341c",
  M: "#e064cc", P: "#f4a4c0", m: "#9458c8",
};
export const P = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))]));
export const sc = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
export const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// CP437 faces as bit rows (IBM PC BIOS 8x8 for the map, VGA 8x16 for the interface), from the pcface package.
const PCFACE = "https://cdn.jsdelivr.net/npm/pcface@0.3.0/out/";
export async function loadFace(dir, h) {
  const res = await fetch(`${PCFACE}${dir}/fontmap.js`);
  if (!res.ok) throw new Error(`font ${dir}: HTTP ${res.status}`);
  const name = `PC_FACE_${dir.replace(/-/g, "_").toUpperCase()}_FONT_MAP`;
  const map = new Function(`${await res.text()}\nreturn ${name};`)();
  const glyphs = new Map();
  for (const [ch, rows] of Object.entries(map)) {
    if (rows.length !== h) continue;
    const m = new Uint8Array(8 * h);
    rows.forEach((bits, r) => { for (let c = 0; c < 8; c++) m[r * 8 + c] = (bits >> (7 - c)) & 1; });
    glyphs.set(ch, m);
  }
  if (glyphs.size < 250) throw new Error(`font ${dir}: only ${glyphs.size} glyphs`);
  const fallback = glyphs.get("?");
  return { h, get: (ch) => glyphs.get(ch) || fallback, define: (ch, mask) => glyphs.set(ch, mask) };
}

export class Screen {
  constructor() {
    this.img = new ImageData(W, H);
    this.px = this.img.data;
    this.em = new Float32Array(W * H * 3); // light each pixel gives off, for the phosphor bloom
    this.rect(0, 0, W, H, P[0]);
  }
  rect(x0, y0, w, h, col, glow = 0) {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
        const p = y * W + x;
        this.px[p * 4] = col[0]; this.px[p * 4 + 1] = col[1]; this.px[p * 4 + 2] = col[2]; this.px[p * 4 + 3] = 255;
        this.em[p * 3] = col[0] * glow; this.em[p * 3 + 1] = col[1] * glow; this.em[p * 3 + 2] = col[2] * glow;
      }
  }
  // One cell: glyph `ch` of `face` at pixel (x0, y0), scaled by an integer `s`; a null bg leaves what is under it.
  glyph(face, ch, x0, y0, s, fg, bg, glow = 0, bgGlow = 0) {
    const m = face.get(ch), gh = face.h, px = this.px, em = this.em;
    for (let r = 0; r < gh; r++)
      for (let sy = 0; sy < s; sy++) {
        const y = y0 + r * s + sy;
        if (y < 0 || y >= H) continue;
        for (let c = 0; c < 8; c++) {
          const on = m[r * 8 + c], col = on ? fg : bg;
          if (!col) continue;
          const g = on ? glow : bgGlow;
          for (let sx = 0; sx < s; sx++) {
            const x = x0 + c * s + sx;
            if (x < 0 || x >= W) continue;
            const p = y * W + x;
            px[p * 4] = col[0]; px[p * 4 + 1] = col[1]; px[p * 4 + 2] = col[2];
            em[p * 3] = col[0] * g; em[p * 3 + 1] = col[1] * g; em[p * 3 + 2] = col[2] * g;
          }
        }
      }
  }
}

// Text on the 8x16 interface grid with "&X" color codes; returns the column after the last character.
export function text(scr, face, col, row, str, fg = P.y, bg = P[0], glow = 0) {
  let c = col, color = fg;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "&" && i + 1 < str.length && P[str[i + 1]]) { color = P[str[++i]]; continue; }
    scr.glyph(face, str[i], c * 8, row * 16, 1, color, bg, glow * lum(color));
    c++;
  }
  return c;
}
export const plain = (str) => str.replace(/&./g, (m) => (P[m[1]] ? "" : m));

// Word wrap that keeps the color running into the next line.
export function wrap(str, width) {
  const out = [];
  let line = "", len = 0, color = "";
  for (const word of str.split(" ")) {
    const wl = plain(word).length;
    if (len && len + 1 + wl > width) { out.push(line); line = color; len = 0; }
    line += (len ? " " : "") + word;
    len += (len ? 1 : 0) + wl;
    const codes = word.match(/&./g);
    if (codes) color = codes.filter((m) => P[m[1]]).at(-1) || color;
  }
  if (len) out.push(line);
  return out;
}

// Phosphor bloom, scanlines that follow the tube's curve, slight barrel and color fringing, and a vignette.
export function present(canvas, scr) {
  const base = Object.assign(document.createElement("canvas"), { width: W, height: H }), bg = base.getContext("2d");
  bg.putImageData(scr.img, 0, 0);
  const emc = Object.assign(document.createElement("canvas"), { width: W, height: H }), eg = emc.getContext("2d");
  const emi = new ImageData(W, H);
  for (let p = 0; p < W * H; p++) { emi.data[p * 4] = scr.em[p * 3]; emi.data[p * 4 + 1] = scr.em[p * 3 + 1]; emi.data[p * 4 + 2] = scr.em[p * 3 + 2]; emi.data[p * 4 + 3] = 255; }
  eg.putImageData(emi, 0, 0);
  bg.globalCompositeOperation = "lighter";
  for (const [r, a] of [[2, 0.55], [7, 0.5], [22, 0.4]]) { bg.filter = `blur(${r}px)`; bg.globalAlpha = a; bg.drawImage(emc, 0, 0); }
  bg.filter = "none"; bg.globalAlpha = 1; bg.globalCompositeOperation = "source-over";
  const src = bg.getImageData(0, 0, W, H).data, out = new ImageData(W, H), o = out.data;
  // Z > 1 pulls the whole terminal inside the curved glass, so the bulge never clips the frame.
  const K = 0.024, Z = 1.02, fr = [1.0016, 1, 0.9984], bezel = [5, 8, 8];
  const sample = (x, y, ch) => {
    if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return -1;
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const a = src[(y0 * W + x0) * 4 + ch], b = src[(y0 * W + x1) * 4 + ch], c = src[(y1 * W + x0) * 4 + ch], d = src[(y1 * W + x1) * 4 + ch];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const nx = ((x + 0.5) / W) * 2 - 1, ny = ((y + 0.5) / H) * 2 - 1, r2 = nx * nx * 0.9 + ny * ny * 1.1;
      const f = (Z * (1 + K * r2)) / (1 + K), q = (y * W + x) * 4;
      const sy = ((ny * f + 1) / 2) * H - 0.5;
      const scan = 0.86 + 0.14 * Math.cos((sy / 3) * Math.PI * 2);
      const vig = Math.max(0, 1 - 0.3 * Math.pow(r2 / 2, 1.6));
      let edge = 1;
      for (let ch = 0; ch < 3; ch++) {
        const fx = ((nx * f * fr[ch] + 1) / 2) * W - 0.5, fy = ((ny * f * fr[ch] + 1) / 2) * H - 0.5;
        const v = sample(fx, fy, ch);
        if (v < 0) { edge = 0; o[q + ch] = bezel[ch]; continue; }
        o[q + ch] = v * scan * vig * 1.08;
      }
      if (edge) {
        // A soft dark rim just inside the glass edge.
        const ex = Math.min(((nx * f + 1) / 2) * W, W - ((nx * f + 1) / 2) * W), ey = Math.min(((ny * f + 1) / 2) * H, H - ((ny * f + 1) / 2) * H);
        const rim = Math.min(1, Math.min(ex, ey) / 5);
        for (let ch = 0; ch < 3; ch++) o[q + ch] *= 0.35 + 0.65 * rim;
      }
      o[q + 3] = 255;
    }
  canvas.getContext("2d").putImageData(out, 0, 0);
}
