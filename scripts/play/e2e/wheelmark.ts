// wheelmark.ts: a continuous wheel zoom (a tick every GAP ms) at a held cursor on a mark site; screenshots as fast as they come, each: the zoom then (rAF log by time), the magenta disc's distance from the cursor
// (null: not drawn), its size. Shows whether the ground under the cursor stays under it WHILE zooming, and when the picture turns (disc leaves or jumps).
//   SITE PROFILE VIEW=lat,lon Z0=1.5 CURSOR=240,600 TICKS=12 GAP=150 DIR=-1 OUT=dir (keeps pictures)  lockf /tmp/nomads-gpu.lock bun wheelmark.ts
import { launch, sleep, load, sharp } from "./lib";
const [lat, lon] = (process.env.VIEW ?? "-35.9034,43.5937").split(",").map(Number), Z0 = Number(process.env.Z0 ?? 1.5), [cx, cy] = (process.env.CURSOR ?? "240,600").split(",").map(Number);
const TICKS = Number(process.env.TICKS ?? 12), GAP = Number(process.env.GAP ?? 150), DIR = Number(process.env.DIR ?? -1), OUT = process.env.OUT;
async function disc(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 3; if (data[i] > 235 && data[i + 1] < 40 && data[i + 2] > 235) { n++; sx += x; sy += y; } }
  return n ? { n, x: sx / n + 0.5, y: sy / n + 0.5 } : { n: 0, x: NaN, y: NaN };
}
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  await r.page.evaluate(() => { const w = window as any; w.__zl = []; const f = () => { w.__zl.push([Date.now(), w.play.view.zoom]); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, Z0);
  await idle();
  await r.page.mouse.move(cx, cy); await sleep(500);
  const A = await r.page.evaluate((px: number, py: number) => { const w = window as any, P = w.play, L = P.live, a = L.groundUnder(P.view, px, py); if (!a) return null; return { geo: a.geo, R: L.debug.look(P.view).radiusM, mpp: L.mPerPx(P.view) }; }, cx, cy);
  if (!A) throw new Error("no ground under the cursor");
  const la = (A.geo.lat * Math.PI) / 180, lo = (A.geo.lon * Math.PI) / 180, c = Math.cos(la);
  await r.page.evaluate((v: number[]) => (window as any).play.live.debug.check({ op: "mark", v }), [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la), (6 * A.mpp) / A.R]);
  await sleep(900);
  const shots: { t: number; png: Buffer }[] = []; let go = true;
  const shooter = (async () => { while (go) { const png = (await r.page.screenshot({ type: "png" })) as Buffer; shots.push({ t: Date.now(), png }); } })();
  for (let i = 0; i < TICKS; i++) { await r.page.mouse.wheel({ deltaY: DIR * 100 }); await sleep(GAP); }
  await sleep(1200); go = false; await shooter;
  const zl: number[][] = await r.page.evaluate(() => (window as any).__zl);
  const zAt = (t: number) => { let b = zl[0]; for (const x of zl) { if (x[0] <= t) b = x; else break; } return b[1]; };
  const t0 = shots[0].t; let k = 0;
  for (const s of shots) {
    const d = await disc(s.png);
    if (OUT) await sharp(s.png).resize(640).jpeg({ quality: 75 }).toFile(`${OUT}/w${String(k).padStart(3, "0")}.jpg`);
    console.log(JSON.stringify({ k: k++, ms: s.t - t0, z: +zAt(s.t).toFixed(2), off: d.n ? +Math.hypot(d.x - cx, d.y - cy).toFixed(1) : null, discPx: d.n }));
  }
  await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "mark", v: [0, 0, 0, 0] }));
} finally { await r.close(); }
process.exit(0);
