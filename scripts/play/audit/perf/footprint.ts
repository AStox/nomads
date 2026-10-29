// the ground under a grid of screen points at A z3 at rest (play.live.groundUnder), as a JSON of geos: footprint.ts OUT
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SITE = process.env.SITE ?? "http://127.0.0.1:8640/site-new";
const PROFILE = process.env.PROFILE ?? join(homedir(), ".cache/nomads-scratch/lead4/crown-scratch/chrome");
rmSync(PROFILE, { recursive: true, force: true }); mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000, args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1280,943", `--user-data-dir=${PROFILE}`, "--no-first-run"], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 } });
try {
  const page = await browser.newPage();
  await page.goto(`${SITE}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("body.ready", { timeout: 120000 });
  await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: 4.35, lon: -39.38 }; P.camera.setZoom(3); });
  for (let i = 0; i < 25; i++) { await sleep(500); const b = await page.evaluate(async () => (await (window as any).play.live.debug.check({ op: "idle" })).busy); if (!b && i > 6) break; }
  await sleep(1500);
  const pts = await page.evaluate(() => { const P = (window as any).play, out: any[] = []; for (let y = 100; y <= 500; y += 50) for (let x = 100; x <= 700; x += 50) { const g = P.live.groundUnder(P.view, x, y); out.push([x, y, g?.geo?.lat ?? null, g?.geo?.lon ?? null, g?.y ?? null]); } return out; });
  writeFileSync(process.argv[2] ?? "footprint.json", JSON.stringify(pts));
  console.log(pts.slice(0, 5), pts.length);
} finally { try { await browser.close(); } catch {} try { browser.process()?.kill("SIGKILL"); } catch {} }
process.exit(0);
