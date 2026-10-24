// shared harness for the close-zoom audit: bun <script> under lockf /tmp/nomads-gpu.lock
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
export const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
export const sleep = Bun.sleep;
export const SITE = process.env.SITE ?? "http://127.0.0.1:8231";
export const PLACES: Record<string, [number, number]> = {
  A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38],
  M: [15.083, 41.133], K: [21.017, 65.742], L: [-18.428, -75.586], C1: [7.58, -37.266], R: [-30.572, 63.633],
  K2: [21.045, 65.995], C2: [7.0233, -36.98], L2: [-18.428, -75.586], E3: [13.27, 44.99], E4: [13.27, 45.01],
  K3: [4.35, -35.6385],
  E2: [13.27, 45.0],      // cube edge of faces 0/1 (E2: along lon 45 at lat 13.27)
};
const PROFILE = "/tmp/globe-fix-lead/chrome";
export const OUT = "/tmp/globe-fix-lead/out";
mkdirSync(OUT, { recursive: true });

export async function withBrowser(fn: (page: any, errs: string[], browser: any) => Promise<void>, opts: { vp?: [number, number]; q?: string } = {}) {
  const [VW, VH] = opts.vp ?? [1600, 1000];
  rmSync(PROFILE, { recursive: true, force: true });
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000,
    args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${VW},${VH + 143}`, `--user-data-dir=${PROFILE}`],
    defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  });
  const bye = async () => { try { await browser.close(); } catch {} process.exit(1); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  const errs: string[] = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", (e: Error) => errs.push("pageerror: " + e.message));
    page.on("console", (m: any) => { const t = m.text(); if (/WEBGPU LOST|pages:|every slot/.test(t)) errs.push(t.slice(0, 200)); else if (m.type() === "error") errs.push("console.error: " + t.slice(0, 200)); });
    await page.goto(`${SITE}/play/?${opts.q ?? process.env.Q ?? "zoom=island&hour=13&warm=0"}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("body.ready", { timeout: 120000 });
    await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
    await sleep(1500);
    await fn(page, errs, browser);
    console.log("errors:", errs.length ? errs.join(" | ") : "none");
  } finally {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
}

// move the camera to geo at zoom z and wait (at most `max` ms) until the page has stopped making things for 2.5 s; then hold the clock (or leave it running)
export async function go(page: any, geo: [number, number], z: number, o: { max?: number; hold?: boolean; bearing?: number } = {}) {
  await page.evaluate((g: [number, number], zz: number) => {
    const P = (window as any).play, L = P.live; L.debug.hold(false);
    P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz);
  }, geo, z);
  await idle(page, o.max ?? 25000);
  if (o.hold !== false) { await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500); }
}
export async function idle(page: any, max = 25000) {
  const t0 = Date.now(); let calm = 0;
  while (calm < 5 && Date.now() - t0 < max) {
    await sleep(500);
    const r = await page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true }));
    calm = r.busy ? 0 : calm + 1;
  }
  return calm >= 5;
}
export const shot = (page: any, name: string) => page.screenshot({ path: join(OUT, name + ".png"), type: "png" });
export const info = (page: any) => page.evaluate(() => {
  const P = (window as any).play, L = P.live;
  return { zoom: P.view.zoom, geo: P.view.geo, mode: L.mode, alpha: L.stats.ladderAlpha, win: L.stats.window?.id, ppm: L.ppm(P.view.zoom), canopy: L.stats.canopy, share: L.stats.window?.share, objects: L.stats.window?.objects, q: L.stats.q, lift: L.stats.lift };
});
export const skip = (page: any, names: string[] | null) => page.evaluate((n: string[] | null) => (window as any).play.live.debug.check({ op: "skip", names: n ?? [] }), names);

// grayscale high-passed raw buffer of a png file
export async function hp(file: string, blur = 8) {
  const { data, info } = await sharp(file).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const lo = await sharp(file).removeAlpha().greyscale().blur(blur).raw().toBuffer();
  const o = new Float32Array(data.length); for (let i = 0; i < o.length; i++) o[i] = data[i] - lo[i];
  return { d: o, w: info.width, h: info.height };
}
// block shift search of b against a: for a block (x0,y0,bw,bh) the (dx,dy) in +-r minimising mean |a(x,y) - b(x+dx,y+dy)|, and the cost at zero and at `expect`
export function shiftSearch(A: any, B: any, x0: number, y0: number, bw: number, bh: number, r: number, expect?: [number, number], step = 1) {
  const cost = (dx: number, dy: number) => { let s = 0, n = 0; for (let y = y0; y < y0 + bh; y += 2) for (let x = x0; x < x0 + bw; x += 2) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= A.h || xx < 0 || xx >= A.w) continue; s += Math.abs(A.d[y * A.w + x] - B.d[yy * B.w + xx]); n++; } return s / Math.max(n, 1); };
  let best = [1e9, 0, 0]; for (let dy = -r; dy <= r; dy += step) for (let dx = -r; dx <= r; dx += step) { const c = cost(dx, dy); if (c < best[0]) best = [c, dx, dy]; }
  return { best: best.slice(1), cost: +best[0].toFixed(2), zero: +cost(0, 0).toFixed(2), at: expect ? +cost(expect[0], expect[1]).toFixed(2) : undefined };
}
