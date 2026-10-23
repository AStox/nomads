// Live-page gate for the tile cache: the first visit of a place on a cold profile, then a reload and the second visit (the window's
// network bytes must be 0 and its ground tiles faster), then stills at the three places at zoom 9.2 on that warm page.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/tilecache-live.ts <siteDir> <stillsDir> [profileDir]
// siteDir is a build of the site (scripts/demo.ts styles --out <dir>), served here with the tile files held to a link of LINK_MBIT
// (default 100, 0 for none) and 30 ms of latency: on localhost the network is as fast as the disk, so the cold visit would show nothing.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// puppeteer-core is a global install, so its path is known only at run time
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const [DIR, STILLS, PROFILE = "/tmp/globe-slice-a-chrome"] = process.argv.slice(2);
const LINK = Number(process.env.LINK_MBIT ?? 100);
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname), file = Bun.file(join(DIR, path.endsWith("/") ? `${path}index.html` : path));
    if (!(await file.exists())) return new Response("no", { status: 404 });
    if (LINK && /\.(gt|tile)\.gz$/.test(path)) await Bun.sleep(30 + (file.size * 8) / (LINK * 1000));
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  },
});
const SITE = `http://localhost:${server.port}`;
const CAP = readFileSync("/tmp/globe-seamless/cap.js", "utf8");
const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38] };
const sleep = Bun.sleep;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(STILLS, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1600,1143", `--user-data-dir=${PROFILE}`],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed = true; };

// Moves the camera to a place at a zoom and returns the window stats the moment the first window of the page arrives.
const firstWindow = (page: any, geo: [number, number], z: number) => page.evaluate(async (g: [number, number], zoom: number) => {
  const P = (window as any).play, L = P.live;
  L.debug.hold(false);
  P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zoom);
  const t0 = performance.now();
  while (performance.now() - t0 < 90000) {
    if (L.mode === "win" && L.stats.window?.builds > 0) return { ms: Math.round(performance.now() - t0), bytes: L.stats.window.bytes, tiles: L.stats.window.ms.tiles, tilesFetched: L.stats.window.tiles, builds: L.stats.window.builds };
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}, geo, z);

const ready = async (page: any) => {
  await page.goto(`${SITE}/play/?zoom=island&hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("body.ready", { timeout: 120000 });
  await page.evaluate(() => { (window as any).play.sim.paused = true; });
  await sleep(3000);
  const bad = await page.evaluate(() => document.body.dataset.error ?? "");
  check(!bad, `body.ready${bad ? ` with error ${bad}` : ""}`);
};

try {
  const page = await browser.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e: Error) => errs.push(e.message));
  page.on("console", (m: any) => { if (/WEBGPU LOST/.test(m.text())) errs.push(m.text()); });
  await ready(page);
  const cold = await firstWindow(page, PLACES.A, 9.2);
  console.log("cold first visit of A:", JSON.stringify(cold));
  await sleep(8000);

  await ready(page);
  const warm = await firstWindow(page, PLACES.A, 9.2);
  console.log("second visit of A after reload:", JSON.stringify(warm));
  check(!!cold && !!warm && warm.bytes === 0, `second visit moved 0 window bytes (cold ${cold?.bytes})`);
  check(!!cold && !!warm && warm.tiles < cold.tiles, `first window's ground tiles faster (${warm?.tiles?.toFixed(0)} vs ${cold?.tiles?.toFixed(0)} ms)`);

  await page.evaluate(`window.__cap = ${CAP}`);
  for (const [name, geo] of Object.entries(PLACES)) {
    await page.evaluate((g: [number, number]) => (window as any).__cap({ geo: g, z: 9.2 }), geo);
    await page.waitForFunction(() => (window as any).__capr, { timeout: 120000 });
    await page.screenshot({ path: join(STILLS, `${name}-9.2.png`) });
    await page.evaluate(() => { (window as any).__capr = null; });
  }
  check(errs.length === 0, `no page errors or WEBGPU LOST${errs.length ? `: ${errs[0]}` : ""}`);
  console.log("stills in", STILLS);
} finally {
  await browser.close();
  server.stop(true);
  rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
