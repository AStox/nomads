// Two loads of the same place at the same hour give the same picture (plan R7: what grew is the same every visit). The play page is loaded N times (default 3, a fresh page each, the browser's
// cache warm after the first), its animation clock held, and a still taken at the opening view and at two places jumped to; every load's stills are compared with the first load's by the
// mean absolute difference of their channels (0 is the same picture; the limit is 0.5 of 255). Exits 1 on any pair over it.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/loadsame.ts <siteUrl> [--loads 3] [--limit 0.5] [--vp 1600x1000] [--profile /tmp/dir]
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// puppeteer-core and sharp are global installs, so their paths are known only at run time
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SITE = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const LOADS = Number(at("--loads", "3")), LIMIT = Number(at("--limit", "0.5")), [VW, VH] = at("--vp", "1600x1000").split("x").map(Number), PROFILE = at("--profile", "/tmp/loadsame-chrome");
if (!SITE) { console.error("usage: loadsame.ts <siteUrl> [--loads 3] [--limit 0.5] [--vp 1600x1000] [--profile /tmp/dir]"); process.exit(2); }
const sleep = Bun.sleep;
// [name, place jumped to (null: the opening view), zoom, a fast pan after the settle: no reveal waits for the picture there]
const PLACES: [string, number[] | null, number, boolean][] = [["opening", null, 0, false], ["A z6.5", [4.35, -39.38], 6.5, false], ["B z4.5", [-5.38, 73.13], 4.5, false], ["A z6.5 after a fast pan", [4.35, -39.38], 6.5, true]];
rmSync(PROFILE, { recursive: true, force: true });

const shots: Buffer[][] = [];
for (let load = 0; load < LOADS; load++) {
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 90000,
    args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${VW},${VH + 143}`, `--user-data-dir=${PROFILE}`],
    defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  });
  const bye = async () => { try { await browser.close(); } catch {} process.exit(1); };
  process.once("SIGINT", bye); process.once("SIGTERM", bye);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${SITE}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("body.ready", { timeout: 180000 });
    await page.evaluate(() => (window as any).play.live.debug.hold(1000));
    const row: Buffer[] = [];
    // the view settled: the window made, its trees and the planet's tiles in
    const settle = () => page.evaluate(async () => {
      const L = (window as any).play.live, s = (t: number) => new Promise((r) => setTimeout(r, t));
      const t0 = performance.now(); let quiet = 0;
      while (performance.now() - t0 < 40000 && quiet < 6) { await s(200); const c = await L.debug.check({ op: "idle" }); quiet = c?.busy || L.stats.tiles?.flying ? 0 : quiet + 1; }
    });
    for (const [name, geo, z, pan] of PLACES) {
      if (geo) {
        await page.evaluate((g: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz); }, geo, z);
        await settle();
        if (pan) {
          // eight quick drags the same way (a few kilometres: the window is made again on the way), then the same settle
          for (let k = 0; k < 8; k++) {
            await page.mouse.move(300, 500); await page.mouse.down();
            for (let i = 1; i <= 10; i++) { await page.mouse.move(300 + 100 * i, 500); await sleep(10); }
            await page.mouse.up();
          }
          await settle();
        }
        await sleep(1500);
      } else await sleep(9000);
      row.push(await sharp(await page.screenshot({ type: "png" })).removeAlpha().raw().toBuffer());
      console.log(`load ${load} ${name}`);
    }
    shots.push(row);
  } finally { await browser.close().catch(() => {}); }
}
let bad = 0;
for (let p = 0; p < PLACES.length; p++)
  for (let l = 1; l < LOADS; l++) {
    const A = shots[0][p], B = shots[l][p];
    let s = 0; for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]);
    const d = s / A.length;
    if (d > LIMIT) bad++;
    console.log(`${d > LIMIT ? "FAIL" : "ok  "} ${PLACES[p][0]}: load ${l} against load 0, mean difference ${d.toFixed(3)}`);
  }
process.exit(bad ? 1 : 0);
