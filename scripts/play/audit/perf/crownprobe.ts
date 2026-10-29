// The arrival's colour step (A z3 after a far jump): per query variant a jump from 60 S 170 E, a screenshot every ~100 ms with the page's own terms sampled each frame (the planet pass's canopy share,
// the ladder's alpha, the window's share) and the mean luma of each shot, then the same view at rest.
//   SITE=http://127.0.0.1:8640/site-main PROFILE=dir lockf /tmp/nomads-gpu.lock bun crownprobe.ts [--place=A] [--zoom=3] [--q=?hour=13&warm=0;?hour=13&warm=0&cn=1] [--secs=3] [--shots=DIR]
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const SITE = process.env.SITE ?? "http://127.0.0.1:8640/site-main";
const PROFILE = process.env.PROFILE ?? join(homedir(), ".cache/nomads-scratch/lead4/crown-scratch/chrome");
const ALL: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-35.9, 43.59], R: [12.02, 83.89] };
const place = args.place ?? "A", zoom = Number(args.zoom ?? 3), secs = Number(args.secs ?? 3);
const queries = (args.q ?? "?hour=13&warm=0").split(";");
const shotsDir = args.shots;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const mean = (d: Buffer) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i]; return s / d.length; };
rmSync(PROFILE, { recursive: true, force: true }); mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000,
  args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1280,943", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const cdp = await page.createCDPSession();
  const shoot = async () => { const r = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: 100, y: 100, width: 600, height: 400, scale: 1 } }); return Buffer.from(r.data, "base64"); };
  const settle = async (maxMs = 14000) => {
    let quiet = 0; const t = Date.now();
    while (Date.now() - t < maxMs && quiet < 3) {
      await sleep(300);
      const r = await page.evaluate(async () => { const L = (window as any).play.live; const c = await L.debug.check({ op: "idle" }); return { busy: c.busy, flying: L.stats.tiles?.flying ?? 0 }; }).catch(() => ({ busy: true, flying: 1 }));
      quiet = !r.busy && !r.flying ? quiet + 1 : 0;
    }
  };
  for (const q of queries) {
    await page.goto(`${SITE}/play/${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("body.ready", { timeout: 120000 });
    await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: -60, lon: 170 }; P.camera.setZoom(1); });
    await settle();
    await page.evaluate(() => {
      const S: any[] = ((window as any).__cs = []);
      const loop = () => { const L = (window as any).play.live.stats; S.push([Math.round(performance.now()), L.canopy ?? null, L.ladderAlpha ?? null, L.window?.share ?? null]); if (S.length < 4000) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    });
    const [lat, lon] = ALL[place];
    const t0: number = await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; (window as any).__cs.length = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); return performance.now(); }, lat, lon, zoom);
    const shots: { t: number; d: Buffer; png: Buffer }[] = [];
    const w0 = Date.now();
    while (Date.now() - w0 < secs * 1000) {
      const ta = await page.evaluate(() => performance.now()), png = await shoot(), tb = await page.evaluate(() => performance.now());
      shots.push({ t: Math.round((ta + tb) / 2 - t0), png, d: await sharp(png).removeAlpha().greyscale().raw().toBuffer() });
      await sleep(40);
    }
    await settle(10000);
    await sleep(1500);
    const fin = await shoot(), finD = await sharp(fin).removeAlpha().greyscale().raw().toBuffer();
    const cs: number[][] = await page.evaluate(() => (window as any).__cs);
    console.log(`${q} ${place} z${zoom}: luma by time`, shots.map((s) => `${s.t}:${mean(s.d).toFixed(1)}`).join(" "), `rest ${mean(finD).toFixed(1)}`);
    const at = (t: number) => { const r = cs.find((x) => x[0] - t0 >= t); return r ? r.slice(1).map((v) => (v === null ? null : +v.toFixed(3))) : null; };
    console.log(" terms [canopy, ladderAlpha, share] at", [100, 300, 500, 700, 900, 1100, 1300, 1500, 2000, 2800].map((t) => `${t}: ${JSON.stringify(at(t))}`).join(" | "));
    if (shotsDir) { const tag = q.replace(/[^a-z0-9]+/gi, "_"); shots.forEach((s, i) => writeFileSync(join(shotsDir, `${tag}-${String(i).padStart(2, "0")}-${s.t}.png`), s.png)); writeFileSync(join(shotsDir, `${tag}-rest.png`), fin); }
  }
} finally {
  try { await browser.close(); } catch {}
  try { browser.process()?.kill("SIGKILL"); } catch {}
}
process.exit(0);
