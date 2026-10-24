import { sharp } from "./lib.ts";
// forest mask from crown-density in the tier and the fine picture of the same view; shift and overlap
const dens = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const W = info.width, H = info.height; const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) { const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2]; g[i] = (G >= R - 4 && G > B + 6 && G < 200) || (R + G + B < 120 && G >= R) ? 1 : 0; }
  const bw = 8, I = new Float32Array((W + 1) * (H + 1)); for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
  const D = new Float32Array(W * H); for (let y = bw; y < H - bw; y++) for (let x = bw; x < W - bw; x++) D[y * W + x] = (I[(y + bw + 1) * (W + 1) + x + bw + 1] - I[(y - bw) * (W + 1) + x + bw + 1] - I[(y + bw + 1) * (W + 1) + x - bw] + I[(y - bw) * (W + 1) + x - bw]) / ((2 * bw + 1) ** 2); return { D, W, H }; };
for (const [name, z] of [["K", 2.5], ["K", 1.8], ["K3", 2.5], ["K3", 1.8]] as [string, number][]) {
  const A = await dens(`cc-${name}-z${z}-tier.png`), B = await dens(`cc-${name}-z${z}-fine.png`); const { W, H } = A;
  const cut = (D: Float32Array) => { const v = Array.from(D).filter((x) => x > 0.02).sort((a, b) => a - b); return 0.5 * v[Math.floor(v.length * 0.9)]; }; const tA = cut(A.D), tB = cut(B.D);
  let best = { dx: 0, dy: 0, iou: -1 }; const iouAt = (dx: number, dy: number) => { let i = 0, u = 0; for (let y = 80; y < H - 120; y += 2) for (let x = 80; x < W - 80; x += 2) { const p = A.D[y * W + x] > tA, q = B.D[(y + dy) * W + x + dx] > tB; if (p && q) i++; if (p || q) u++; } return u ? i / u : 0; };
  for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) { const v = iouAt(dx, dy); if (v > best.iou) best = { dx, dy, iou: v }; }
  let fa = 0, fb = 0, n = 0; for (let y = 80; y < H - 120; y += 2) for (let x = 80; x < W - 80; x += 2) { n++; if (A.D[y * W + x] > tA) fa++; if (B.D[y * W + x] > tB) fb++; }
  console.log(JSON.stringify({ name, z, forestTierPct: +(fa / n * 100).toFixed(1), forestFinePct: +(fb / n * 100).toFixed(1), iouAtZero: +iouAt(0, 0).toFixed(3), best: { ...best, iou: +best.iou.toFixed(3) } }));
}
