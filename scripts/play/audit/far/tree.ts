// where the data's tree line (tier 5 tree cover crossing a level) lies against where the picture's crown density crosses half its inside value
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
const base = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid";
const FR = [{ n: [1,0,0], ex: [0,1,0], ey: [0,0,1] }];
const FN = 8192;
const cache = new Map<string, { H: Int16Array; T: Uint8Array } | null>();
function tile(tx: number, ty: number) { const k = `${tx},${ty}`; if (cache.has(k)) return cache.get(k)!; const p = `${base}/t5/f0/${ty}-${tx}.tile.gz`; if (!existsSync(p)) { cache.set(k, null); return null; } const raw = new Uint8Array(gunzipSync(readFileSync(p))); const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true); const meta = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + hl))); let at = 4 + hl; let H: any, T: any; for (const f of meta.fields) { const b = f.type === "i16" || f.type === "u16" ? 2 : 1; if (f.name === "height") H = new Int16Array(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + 65536 * 2)); if (f.name === "tree") T = new Uint8Array(raw.buffer.slice(raw.byteOffset + at, raw.byteOffset + at + 65536)); at += 65536 * b; } const v = { H, T }; cache.set(k, v); return v; }
const at = (X: number, Y: number) => { const t = tile(Math.floor(X / 256), Math.floor(Y / 256)); return t ? { h: t.H[(Y % 256) * 256 + (X % 256)] * 0.25, t: t.T[(Y % 256) * 256 + (X % 256)] / 255 } : { h: NaN, t: NaN }; };
const geoOf = (x: number, y: number) => { const u = Math.tan((x / FN - 0.5) * Math.PI / 2), v = Math.tan((y / FN - 0.5) * Math.PI / 2), F = FR[0]; const p = [0, 1, 2].map((i) => F.n[i] + u * F.ex[i] + v * F.ey[i]); const r = Math.hypot(...p); return { lat: Math.asin(p[2] / r) * 180 / Math.PI, lon: Math.atan2(p[1], p[0]) * 180 / Math.PI }; };
const cell = (lat: number, lon: number) => { const la = lat * Math.PI / 180, lo = lon * Math.PI / 180, p = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)], d = p[0], u = p[1] / d, v = p[2] / d; return [(Math.atan(u) / (Math.PI / 2) + 0.5) * FN, (Math.atan(v) / (Math.PI / 2) + 0.5) * FN]; };
const center: [number, number] = JSON.parse(process.argv[2]); const zs = (process.argv[3] ?? "1.5,2.5,3.2").split(",").map(Number); const tag = process.argv[4] ?? "tree"; const LEVEL = Number(process.argv[5] ?? 0.5);
const [cx0, cy0] = cell(center[0], center[1]);
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  for (const z of zs) {
    await setView(page, center, z); await settle(page, 7000); await sleep(1500); await settle(page, 5000);
    const ppm = await page.evaluate((zz: number) => (window as any).play.live.ppm(zz), z); const mpp = 1 / ppm, Rc = Math.min(900, Math.ceil((900 * mpp) / 75 * 1.2));
    const pts: [number, number][] = []; const step = Math.max(1, Math.floor(Rc / 250));
    for (let Y = Math.floor(cy0 - Rc); Y < cy0 + Rc; Y++) for (let X = Math.floor(cx0 - Rc); X < cx0 + Rc; X++) { const a = at(X, Y); if (!(a.h > 5)) continue; for (const [dx, dy] of [[1, 0], [0, 1]]) { const b = at(X + dx, Y + dy); if (!(b.h > 5)) continue; if ((a.t - LEVEL) * (b.t - LEVEL) < 0 && Math.abs(a.t - b.t) > 0.25 && (X * 7 + Y * 13) % step === 0) { const t = (LEVEL - a.t) / (b.t - a.t); pts.push([X + 0.5 + t * dx, Y + 0.5 + t * dy]); } } }
    const geos = pts.map(([x, y]) => geoOf(x, y));
    const proj: number[][] = await page.evaluate((G: any[]) => { const P = (window as any).play, L = P.live; return G.map((g) => L.screenOf(P.view, 0, 0, 0, g)); }, geos);
    const r = await shot(page, `${tag}-z${z}`);
    const { data, info } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const W = info.width, H = info.height;
    // crown density: share of pixels in a 13 px box that are not the bare/soil/water palette: use hue test on green-dominant or dark-green pixels
    const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) { const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2]; g[i] = (G >= R - 4 && G > B + 6 && G < 200) || (R + G + B < 120 && G >= R) ? 1 : 0; }
    const bw = 6, I = new Float32Array((W + 1) * (H + 1)); for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += g[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
    const D = new Float32Array(W * H); for (let y = bw; y < H - bw; y++) for (let x = bw; x < W - bw; x++) D[y * W + x] = (I[(y + bw + 1) * (W + 1) + x + bw + 1] - I[(y - bw) * (W + 1) + x + bw + 1] - I[(y + bw + 1) * (W + 1) + x - bw] + I[(y - bw) * (W + 1) + x - bw]) / ((2 * bw + 1) ** 2);
    const vals = Array.from(D).filter((v) => v > 0).sort((a, b) => a - b); const inside = vals[Math.floor(vals.length * 0.9)] ?? 1, lv = 0.5 * inside;
    const RS = 40, vx: number[] = [], vy: number[] = [], ds: number[] = [];
    for (const [px, py] of proj) { const X = Math.round(px), Y = Math.round(py); if (X < RS || X >= W - RS || Y < RS || Y >= H - 110) continue; let best = 1e9, bx = 0, by = 0; for (let dy = -RS; dy <= RS; dy += 1) for (let dx = -RS; dx <= RS; dx += 1) { const i = (Y + dy) * W + X + dx; if ((D[i] - lv) * (D[i + 1] - lv) < 0) { const d = Math.hypot(dx + X - px, dy + Y - py); if (d < best) { best = d; bx = dx + X - px; by = dy + Y - py; } } } if (best < 1e9) { ds.push(best); vx.push(bx); vy.push(by); } }
    const med = (a: number[]) => a.length ? +a.sort((x, y) => x - y)[a.length >> 1].toFixed(1) : null;
    console.log(JSON.stringify({ z, mppM: +mpp.toFixed(2), cellPx: +(75 * ppm).toFixed(1), probes: proj.length, matched: ds.length, medDist: med([...ds]), medVec: [med(vx), med(vy)], interiorDensity: +inside.toFixed(2) }));
    const marks = proj.filter((p) => p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H).map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="#00e5ff"/>`).join("");
    await sharp(r.png).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`), left: 0, top: 0 }]).png().toFile(`${OUT}/${tag}-z${z}-marked.png`);
  }
});
