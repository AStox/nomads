// Small renderer for comparing a landform at every stage of the generator and between planets: windows of height planes in TIER-5 cell coordinates (face, x, y), each read from its own tier's file
// or harness state, hillshaded at its own resolution and blown up by nearest neighbour to one pixel per tier-5 cell (so panels of one window overlay exactly), sea (h <= 0) in the globe's blue, lakes
// (a priority flood of the window, cells the fill raises) marked, panels joined side by side with labels. Pure CPU, no GPU. Used by scripts/straight-pictures.ts.
import { closeSync, openSync, readSync, readFileSync } from "node:fs";
import { heightColor, png, type RGB } from "./globe-maps";

export type Win = { face: number; x: number; y: number; w: number; h: number }; // tier-5 cells; y up in the picture

// A height source at tier `tier` (0 to 5): `read(face, X0, Y0, W, H)` returns metres at that tier's own cells X0.., Y0.. (NaN where the source has no data).
export interface Source { label: string; tier: number; read(face: number, X0: number, Y0: number, W: number, H: number): Float32Array }

export const fnOf = (tier: number) => 256 << tier;

// a whole-tier file of int32 heights in 1/256 m, face-major (face * fn + Y) * fn + X, read a row at a time
export function tierFile(label: string, path: string, tier: number, scale = 256): Source {
  const fn = fnOf(tier), fd = openSync(path, "r");
  return {
    label, tier,
    read(face, X0, Y0, W, H) {
      const out = new Float32Array(W * H).fill(NaN), row = new Int32Array(W);
      for (let y = 0; y < H; y++) {
        const Y = Y0 + y;
        if (Y < 0 || Y >= fn) continue;
        const xa = Math.max(0, X0), xb = Math.min(fn, X0 + W);
        if (xb <= xa) continue;
        readSync(fd, new Uint8Array(row.buffer, 0, (xb - xa) * 4), 0, (xb - xa) * 4, ((face * fn + Y) * fn + xa) * 4);
        for (let x = xa; x < xb; x++) out[y * W + x - X0] = row[x - xa] / scale;
      }
      return out;
    },
  };
}

// a region state of the harness (interior only, size x size, int32 1/256 m) whose origin is (x0, y0) of `face` at `tier`
export function regionState(label: string, path: string, tier: number, face: number, x0: number, y0: number, size: number): Source {
  const b = readFileSync(path), a = new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return {
    label, tier,
    read(f, X0, Y0, W, H) {
      const out = new Float32Array(W * H).fill(NaN);
      if (f !== face) return out;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xx = X0 + x - x0, yy = Y0 + y - y0;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) out[y * W + x] = a[yy * size + xx] / 256;
      }
      return out;
    },
  };
}

// the chain (tier 0) heights as f32 (scripts/straight-dump0.ts)
export function chainSource(label: string, path: string): Source {
  const b = readFileSync(path), a = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  return {
    label, tier: 0,
    read(face, X0, Y0, W, H) {
      const out = new Float32Array(W * H).fill(NaN);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const xx = X0 + x, yy = Y0 + y; if (xx >= 0 && xx < 256 && yy >= 0 && yy < 256) out[y * W + x] = a[(face * 256 + yy) * 256 + xx]; }
      return out;
    },
  };
}

// Priority flood of a height window: the cells' filled height, where the window's edge and every h <= 0 cell drain (a lake is a cell the fill raises).
export function fill(z: Float32Array, W: number, H: number): Float32Array {
  const f = new Float32Array(z).fill(Infinity), heap: number[] = [], key: number[] = [];
  const push = (i: number, k: number) => { heap.push(i); key.push(k); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (key[p] <= key[c]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; [key[p], key[c]] = [key[c], key[p]]; c = p; } };
  const pop = () => {
    const top = heap[0], lastI = heap.pop()!, lastK = key.pop()!;
    if (heap.length) { heap[0] = lastI; key[0] = lastK; let c = 0; for (;;) { let m = c; const l = 2 * c + 1, r = l + 1; if (l < heap.length && key[l] < key[m]) m = l; if (r < heap.length && key[r] < key[m]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; [key[m], key[c]] = [key[c], key[m]]; c = m; } }
    return top;
  };
  const done = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0, v = z[i]; if (Number.isNaN(v)) { done[i] = 1; f[i] = v; continue; } if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || v <= 0) { f[i] = v; done[i] = 1; push(i, v); } }
  while (heap.length) {
    const i = pop(), x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (done[j]) continue;
      done[j] = 1; f[j] = Math.max(z[j], f[i]); push(j, f[j]);
    }
  }
  return f;
}

export interface Look { vex: number; lattice?: boolean; coast?: boolean }

const L = [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)];

// One panel of window `win` from `src`: W x H pixels RGB (y up), 1 px per tier-5 cell. Marks: lake (cell the fill raises by 0.5 m or more: cyan), coast sliver (0 < h <= 0.1 m: magenta,
// `look.coast`), the tier-0 lattice (a line every 32 tier-5 cells at the cell edges, `look.lattice`: dark red), cells outside the source in grey.
export function panel(src: Source, win: Win, look: Look): Uint8Array {
  const s = 5 - src.tier, k = 1 << s, M = 4, // margin in native cells for the fill and the shading
    X0 = Math.floor(win.x / k) - M, Y0 = Math.floor(win.y / k) - M, X1 = Math.floor((win.x + win.w - 1) / k) + M, Y1 = Math.floor((win.y + win.h - 1) / k) + M, W = X1 - X0 + 1, H = Y1 - Y0 + 1;
  const z = src.read(win.face, X0, Y0, W, H), fl = fill(z, W, H), cellM = 75 * k;
  const rgb = new Uint8Array(win.w * win.h * 3);
  for (let py = 0; py < win.h; py++) for (let px = 0; px < win.w; px++) {
    const X = win.x + px, Y = win.y + py, cx = Math.floor(X / k) - X0, cy = Math.floor(Y / k) - Y0, h = z[cy * W + cx];
    let c: RGB;
    if (Number.isNaN(h)) c = [120, 120, 120];
    else {
      c = heightColor(h);
      if (h > 0) {
        const zz = (x: number, y: number) => { const v = z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]; return Number.isNaN(v) ? h : v; };
        const sx = (look.vex * (zz(cx + 1, cy) - zz(cx - 1, cy))) / (2 * cellM), sy = (look.vex * (zz(cx, cy + 1) - zz(cx, cy - 1))) / (2 * cellM), nz = 1 / Math.hypot(sx, sy, 1);
        const sh = Math.max(0.15, -sx * nz * L[0] - sy * nz * L[1] + nz * L[2]);
        c = [Math.min(255, c[0] * sh * 1.3), Math.min(255, c[1] * sh * 1.3), Math.min(255, c[2] * sh * 1.3)];
        if (fl[cy * W + cx] - h >= 0.5) c = [60, 230, 230];
        else if (look.coast && h <= 0.1) c = [255, 0, 255];
      }
    }
    if (look.lattice && (X % 32 === 0 || Y % 32 === 0)) c = [Math.min(255, c[0] * 0.5 + 120), c[1] * 0.5, c[2] * 0.5];
    const o = ((win.h - 1 - py) * win.w + px) * 3;
    rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2];
  }
  return rgb;
}

// ---- text (5x7 caps) and sheets
const G: Record<string, string> = {
  A: "01110 10001 10001 11111 10001 10001 10001", B: "11110 10001 10001 11110 10001 10001 11110", C: "01110 10001 10000 10000 10000 10001 01110", D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111", F: "11111 10000 10000 11110 10000 10000 10000", G: "01110 10001 10000 10111 10001 10001 01111", H: "10001 10001 10001 11111 10001 10001 10001",
  I: "01110 00100 00100 00100 00100 00100 01110", J: "00111 00010 00010 00010 00010 10010 01100", K: "10001 10010 10100 11000 10100 10010 10001", L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001", N: "10001 11001 10101 10011 10001 10001 10001", O: "01110 10001 10001 10001 10001 10001 01110", P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101", R: "11110 10001 10001 11110 10100 10010 10001", S: "01111 10000 10000 01110 00001 00001 11110", T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110", V: "10001 10001 10001 10001 10001 01010 00100", W: "10001 10001 10001 10101 10101 11011 10001", X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100", Z: "11111 00001 00010 00100 01000 10000 11111",
  "0": "01110 10001 10011 10101 11001 10001 01110", "1": "00100 01100 00100 00100 00100 00100 01110", "2": "01110 10001 00001 00010 00100 01000 11111", "3": "11110 00001 00001 01110 00001 00001 11110",
  "4": "00010 00110 01010 10010 11111 00010 00010", "5": "11111 10000 11110 00001 00001 10001 01110", "6": "00110 01000 10000 11110 10001 10001 01110", "7": "11111 00001 00010 00100 01000 01000 01000",
  "8": "01110 10001 10001 01110 10001 10001 01110", "9": "01110 10001 10001 01111 00001 00010 01100",
  "-": "00000 00000 00000 11111 00000 00000 00000", ":": "00000 00100 00000 00000 00000 00100 00000", ".": "00000 00000 00000 00000 00000 01100 01100", ",": "00000 00000 00000 00000 01100 00100 01000",
  "/": "00001 00010 00010 00100 01000 01000 10000", "(": "00010 00100 01000 01000 01000 00100 00010", ")": "01000 00100 00010 00010 00010 00100 01000", "=": "00000 00000 11111 00000 11111 00000 00000",
  "+": "00000 00100 00100 11111 00100 00100 00000", "<": "00010 00100 01000 10000 01000 00100 00010", " ": "00000 00000 00000 00000 00000 00000 00000", "%": "11001 11010 00010 00100 01000 01011 10011",
};
export function text(rgb: Uint8Array, W: number, x: number, y: number, s: string, scale = 2, c: RGB = [255, 255, 255], bg: RGB | null = [0, 0, 0]) {
  const H = rgb.length / 3 / W;
  if (bg) for (let yy = y - 1; yy < y + 7 * scale + 1; yy++) for (let xx = x - 1; xx < x + s.length * 6 * scale; xx++) if (xx >= 0 && xx < W && yy >= 0 && yy < H) { const o = (yy * W + xx) * 3; rgb[o] = bg[0]; rgb[o + 1] = bg[1]; rgb[o + 2] = bg[2]; }
  [...s.toUpperCase()].forEach((ch, i) => {
    const g = (G[ch] ?? G[" "]).split(" ");
    for (let r = 0; r < 7; r++) for (let q = 0; q < 5; q++) if (g[r][q] === "1") for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) {
      const xx = x + (i * 6 + q) * scale + a, yy = y + r * scale + b;
      if (xx >= 0 && xx < W && yy >= 0 && yy < H) { const o = (yy * W + xx) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; }
    }
  });
}

// panels (each w x h RGB) laid out in `cols` columns with a 4 px gap, each labelled in its top-left corner; returns PNG bytes
export function sheet(panels: { label: string; rgb: Uint8Array }[], w: number, h: number, cols: number, title = "") {
  const rows = Math.ceil(panels.length / cols), gap = 4, T = title ? 18 : 0, W = cols * w + (cols - 1) * gap, H = rows * h + (rows - 1) * gap + T, out = new Uint8Array(W * H * 3).fill(20);
  panels.forEach((p, i) => {
    const ox = (i % cols) * (w + gap), oy = T + Math.floor(i / cols) * (h + gap);
    for (let y = 0; y < h; y++) out.set(p.rgb.subarray(y * w * 3, (y + 1) * w * 3), ((oy + y) * W + ox) * 3);
    text(out, W, ox + 4, oy + 4, p.label, 2);
  });
  if (title) text(out, W, 4, 2, title, 2, [255, 255, 255], null);
  return png(W, H, out);
}
