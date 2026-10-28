// The forest edge's straightness and width, measured on stills (scripts/play/audit/perf/edgestills.ts): bun scripts/play/audit/perf/edgestat.ts <stillsDir> <tagA> [tagB ...] [--mask dir]
// Definitions (metres from the zoom: the scale bar is 21.1 m / 2^zoom per screen pixel):
// - forest pixel: green over red and blue (g - r >= 6 and g - b >= 6), as the crowns and the wood's ground read and the open ground (grey, brown, sand) does not; the mask is where the share of forest pixels in a
//   disc of 20 m radius is at least 0.3 (the wood's ground and stems are brown, so a wood is 0.5 to 0.8 of them, the open ground under 0.05), with holes and islands under 60 m by 60 m flipped: sprite gaps and single stems are not edge.
// - straight-run share: of the edge's pixels (the mask's boundary, the HUD and the screen's border left out), the share whose neighbours within 75 m (half of the 150 m, two cells, a straight run must be) lie on one line:
//   they span at least half of what a straight segment through the disc spans (variance along >= rho^2 / 6) and stand off the line by at most 2.5 m rms (a tenth of a cell is 7.5 m).
// - box-counting dimension of the edge from 20 m to 320 m boxes (1 for a line, over 1 for a wandering or broken edge), and the edge's width: 0.8 over the gradient of the share of forest pixels (disc of 20 m) at the edge, median, m.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, mkdirSync } from "node:fs";
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const args = process.argv.slice(2), mi = args.indexOf("--mask"), maskDir = mi >= 0 ? args[mi + 1] : "", rest = args.filter((_, i) => mi < 0 || (i !== mi && i !== mi + 1));
const [dir, ...tags] = rest;
if (maskDir) mkdirSync(maskDir, { recursive: true });
const RHO_M = Number(process.env.RHO ?? 75), DISC_M = 20, RMS_M = Number(process.env.RMS ?? 2.5), SHARE = 0.3, SPECK_M2 = 3600;

async function measure(file: string, zoom: number) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, mpp = 21.1 / 2 ** zoom, px = (m: number) => Math.max(1, Math.round(m / mpp));
  const forest = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2]; forest[i] = g - r >= 6 && g - b >= 6 ? 1 : 0; }
  // the share of forest pixels in a disc: a box blur twice (a close stand-in for a disc, cheap)
  const box = (src: Float32Array, rad: number) => {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H), n = 2 * rad + 1;
    for (let y = 0; y < H; y++) { let s = 0; for (let x = -rad; x <= rad; x++) s += src[y * W + Math.min(W - 1, Math.max(0, x))]; for (let x = 0; x < W; x++) { tmp[y * W + x] = s / n; s += src[y * W + Math.min(W - 1, x + rad + 1)] - src[y * W + Math.max(0, x - rad)]; } }
    for (let x = 0; x < W; x++) { let s = 0; for (let y = -rad; y <= rad; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x]; for (let y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[Math.min(H - 1, y + rad + 1) * W + x] - tmp[Math.max(0, y - rad) * W + x]; } }
    return out;
  };
  const rad = Math.max(1, Math.round(px(DISC_M) * 0.6)), f = box(box(forest, rad), rad), mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = f[i] >= SHARE ? 1 : 0;
  // holes in the wood and islands of it under 60 m by 60 m are not the edge: flipped
  for (const v of [0, 1]) {
    const seen = new Uint8Array(W * H), stack: number[] = [];
    for (let s0 = 0; s0 < W * H; s0++) {
      if (seen[s0] || mask[s0] !== v) continue;
      const comp: number[] = [s0]; seen[s0] = 1; stack.push(s0);
      while (stack.length) { const i = stack.pop()!, x = i % W, y = (i - x) / W; for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) if (j >= 0 && !seen[j] && mask[j] === v) { seen[j] = 1; comp.push(j); stack.push(j); } }
      if (comp.length * mpp * mpp < SPECK_M2) for (const i of comp) mask[i] = 1 - v;
    }
  }
  // the edge: mask pixels with a 4-neighbour of the other value, away from the border (the box blur reads clamped, so a margin of two discs) and the HUD
  const m0 = px(DISC_M) * 2 + 2, edge: [number, number][] = [];
  for (let y = m0; y < H - m0; y++) for (let x = m0; x < W - m0; x++) {
    if (y < 60 && (x < 640 || x > 1230)) continue;
    const v = mask[y * W + x];
    if (v && (!mask[y * W + x - 1] || !mask[y * W + x + 1] || !mask[(y - 1) * W + x] || !mask[(y + 1) * W + x])) edge.push([x, y]);
  }
  if (maskDir) {
    const out = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) { const v = mask[i] ? 90 : 20; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v; }
    for (const [x, y] of edge) { const i = y * W + x; out[i * 3] = 255; out[i * 3 + 1] = 255; out[i * 3 + 2] = 0; }
    await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(`${maskDir}/${file.split("/").pop()}`);
  }
  // straight-run share
  const rho = RHO_M / mpp, cell = Math.max(4, Math.round(rho)), grid = new Map<number, number[]>();
  edge.forEach(([x, y], k) => { const key = Math.floor(y / cell) * 4096 + Math.floor(x / cell); let a = grid.get(key); if (!a) grid.set(key, (a = [])); a.push(k); });
  let straight = 0, counted = 0;
  const step = Math.max(1, Math.floor(edge.length / 6000));
  for (let k = 0; k < edge.length; k += step) {
    const [x, y] = edge[k], near: number[] = [];
    for (let gy = Math.floor((y - rho) / cell); gy <= Math.floor((y + rho) / cell); gy++) for (let gx = Math.floor((x - rho) / cell); gx <= Math.floor((x + rho) / cell); gx++) for (const j of grid.get(gy * 4096 + gx) ?? []) if ((edge[j][0] - x) ** 2 + (edge[j][1] - y) ** 2 <= rho * rho) near.push(j);
    counted++;
    if (near.length < 8) continue;
    let mx = 0, my = 0; for (const j of near) { mx += edge[j][0]; my += edge[j][1]; } mx /= near.length; my /= near.length;
    let sxx = 0, syy = 0, sxy = 0; for (const j of near) { const dx = edge[j][0] - mx, dy = edge[j][1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; } sxx /= near.length; syy /= near.length; sxy /= near.length;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
    if (l1 >= (rho * rho) / 6 && Math.sqrt(l2) <= RMS_M / mpp) straight++;
  }
  // box counting
  const dims: [number, number][] = [];
  for (const m of [20, 40, 80, 160, 320]) { const b = Math.max(1, Math.round(m / mpp)), seen = new Set<number>(); for (const [x, y] of edge) seen.add(Math.floor(y / b) * 65536 + Math.floor(x / b)); dims.push([Math.log(1 / m), Math.log(seen.size)]); }
  const n = dims.length, sx = dims.reduce((a, d) => a + d[0], 0), sy = dims.reduce((a, d) => a + d[1], 0), sxy2 = dims.reduce((a, d) => a + d[0] * d[1], 0), sxx2 = dims.reduce((a, d) => a + d[0] * d[0], 0);
  const dim = (n * sxy2 - sx * sy) / (n * sxx2 - sx * sx);
  // the width: the gradient of f at the edge
  const widths: number[] = [];
  for (let k = 0; k < edge.length; k += Math.max(1, Math.floor(edge.length / 4000))) { const [x, y] = edge[k], gx = (f[y * W + x + 2] - f[y * W + x - 2]) / 4, gy = (f[(y + 2) * W + x] - f[(y - 2) * W + x]) / 4, g = Math.hypot(gx, gy); if (g > 1e-4) widths.push((0.8 / g) * mpp); }
  widths.sort((a, b) => a - b);
  return { edgeM: Math.round((edge.length * mpp)), straight: +(straight / Math.max(1, counted)).toFixed(3), dim: +dim.toFixed(3), widthM: +(widths[Math.floor(widths.length / 2)] ?? NaN).toFixed(1), forest: +(mask.reduce((a, v) => a + v, 0) / (W * H)).toFixed(3) };
}
const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
for (const t of tags) {
  const rows: Record<string, unknown>[] = [];
  for (const f of files.filter((f) => f.startsWith(`${t}-`)).sort()) {
    const m = f.match(/-([A-Z]+)-z(\d+)/)!, r = await measure(join(dir, f), +m[2]);
    rows.push({ place: m[1], zoom: +m[2], ...r });
    console.log(t, m[1], "z" + m[2], JSON.stringify(r));
  }
  const sum = (k: string) => rows.reduce((a, r) => a + (r[k] as number), 0);
  console.log(t, "ALL straight (edge-length weighted)", +(rows.reduce((a, r) => a + (r.straight as number) * (r.edgeM as number), 0) / Math.max(1, sum("edgeM"))).toFixed(3), "dim mean", +(sum("dim") / rows.length).toFixed(3), "width mean", +(sum("widthM") / rows.length).toFixed(1));
}
