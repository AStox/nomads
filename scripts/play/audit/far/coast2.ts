// where the data's coast (tier 5 cells, h crossing 0) lies on screen against where the picture's water ends
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
const base = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid";
const FR = [{ n: [1,0,0], ex: [0,1,0], ey: [0,0,1] }, { n: [0,1,0], ex: [-1,0,0], ey: [0,0,1] }, { n: [-1,0,0], ex: [0,-1,0], ey: [0,0,1] }, { n: [0,-1,0], ex: [1,0,0], ey: [0,0,1] }, { n: [0,0,1], ex: [1,0,0], ey: [0,1,0] }, { n: [0,0,-1], ex: [1,0,0], ey: [0,-1,0] }];
const FN = 8192, face = 0;
const cache = new Map<string, Int16Array | null>();
function tile(tx: number, ty: number) { const k = `${tx},${ty}`; if (cache.has(k)) return cache.get(k)!; const p = `${base}/t5/f${face}/${ty}-${tx}.tile.gz`; if (!existsSync(p)) { cache.set(k, null); return null; } const raw = new Uint8Array(gunzipSync(readFileSync(p))); const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true); const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))); let at = 4 + hl; let H: Int16Array | null = null; for (const f of meta.fields) { const b = f.type === "i16" || f.type === "u16" ? 2 : 1; if (f.name === "height") H = new Int16Array(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + 65536 * 2)); at += 65536 * b; } cache.set(k, H); return H; }
const hAt = (X: number, Y: number) => { const t = tile(Math.floor(X / 256), Math.floor(Y / 256)); return t ? t[(Y % 256) * 256 + (X % 256)] * 0.25 : NaN; };
const geoOf = (x: number, y: number) => { const u = Math.tan((x / FN - 0.5) * Math.PI / 2), v = Math.tan((y / FN - 0.5) * Math.PI / 2), F = FR[face]; const p = [0, 1, 2].map((i) => F.n[i] + u * F.ex[i] + v * F.ey[i]); const r = Math.hypot(...p); return { lat: Math.asin(p[2] / r) * 180 / Math.PI, lon: Math.atan2(p[1], p[0]) * 180 / Math.PI }; };
const cell = (lat: number, lon: number) => { const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, p = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], F = FR[face], d = p[0] * F.n[0] + p[1] * F.n[1] + p[2] * F.n[2]; const u = (p[0] * F.ex[0] + p[1] * F.ex[1] + p[2] * F.ex[2]) / d, v = (p[0] * F.ey[0] + p[1] * F.ey[1] + p[2] * F.ey[2]) / d; return [(Math.atan(u) / (Math.PI / 2) + 0.5) * FN, (Math.atan(v) / (Math.PI / 2) + 0.5) * FN]; };
const center: [number, number] = JSON.parse(process.argv[2] ?? "[-15.75,26.76]"); const zs = (process.argv[3] ?? "-2,-1,0,1.5,2.5").split(",").map(Number); const tag = process.argv[4] ?? "coast";
const [cx0, cy0] = cell(center[0], center[1]);
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  for (const z of zs) {
    await setView(page, center, z); await settle(page, 7000); await sleep(1500); await settle(page, 5000);
    const ppm = await page.evaluate((zz: number) => (window as any).play.live.ppm(zz), z);
    const mpp = 1 / ppm, Rc = Math.min(1500, Math.ceil((1000 * mpp) / 75 * 1.2));
    const pts: [number, number][] = []; const step = Math.max(1, Math.floor(Rc / 400));
    for (let Y = Math.floor(cy0 - Rc); Y < cy0 + Rc; Y += 1) for (let X = Math.floor(cx0 - Rc); X < cx0 + Rc; X += 1) { const h = hAt(X, Y); if (!(h > 0)) continue; for (const [dx, dy] of [[1, 0], [0, 1]]) { const h2 = hAt(X + dx, Y + dy); if (h2 <= 0) { const t = h / (h - h2); if ((X * 7 + Y * 13) % step === 0) pts.push([X + 0.5 + t * dx, Y + 0.5 + t * dy]); } } }
    const geos = pts.map(([x, y]) => geoOf(x, y));
    const proj: number[][] = await page.evaluate((G: any[]) => { const P = (window as any).play, L = P.live; return G.map((g) => L.screenOf(P.view, 0, 0, 0, g)); }, geos);
    const r = await shot(page, `${tag}-z${z}`);
    const { data, info } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const W = info.width, H = info.height;
    const water = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) { const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2]; water[i] = B > R + 25 && B > 50 && B >= G ? 1 : 0; }
    const shore = new Uint8Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (water[i] && (!water[i - 1] || !water[i + 1] || !water[i - W] || !water[i + W])) shore[i] = 1; }
    const ds: number[] = [], vx: number[] = [], vy: number[] = []; const RS = 24;
    for (const [px, py] of proj) { const X = Math.round(px), Y = Math.round(py); if (X < RS || X >= W - RS || Y < RS || Y >= H - 100) continue; let best = 1e9, bx = 0, by = 0; for (let dy = -RS; dy <= RS; dy++) for (let dx = -RS; dx <= RS; dx++) if (shore[(Y + dy) * W + X + dx]) { const d = Math.hypot(dx + X - px, dy + Y - py); if (d < best) { best = d; bx = dx + X - px; by = dy + Y - py; } } ds.push(best); if (best < 1e9) { vx.push(bx); vy.push(by); } }
    ds.sort((a, b) => a - b); const q = (p: number) => ds.length ? +ds[Math.floor(p * (ds.length - 1))].toFixed(1) : null;
    console.log(JSON.stringify({ z, mppM: +mpp.toFixed(2), cellPx: +(75 * ppm).toFixed(2), probes: ds.length, p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), medVec: [+(vx.sort((a, b) => a - b)[vx.length >> 1] ?? 0).toFixed(1), +(vy.sort((a, b) => a - b)[vy.length >> 1] ?? 0).toFixed(1)], unmatchedPct: +(ds.filter((d) => d > RS).length / Math.max(1, ds.length) * 100).toFixed(1) }));
    const marks = proj.filter((p) => p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H).map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="1.6" fill="#ff0030"/>`).join("");
    await sharp(r.png).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`), left: 0, top: 0 }]).png().toFile(`${OUT}/${tag}-z${z}-marked.png`);
  }
});
