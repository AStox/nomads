import { puppeteer, sleep, OUT, sharp } from "./lib.ts";
import { writeFileSync } from "node:fs";
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000, args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1280,943", `--user-data-dir=${OUT}/chrome`], defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 2 } });
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, async () => { try { await browser.close(); } catch {} process.exit(1); });
try {
  const page = await browser.newPage(); page.setDefaultTimeout(30000);
  await page.goto("http://127.0.0.1:8197/play/?zoom=island&hour=13&warm=0", { waitUntil: "domcontentloaded", timeout: 120000 }); await page.waitForSelector("body.ready", { timeout: 90000 });
  const set = (z: number) => page.evaluate((zz: number) => { const P = (window as any).play; P.view.geo = { lat: 16.11, lon: 43.64 }; P.camera.setZoom(zz); return [P.live.zmin, P.live.canvasW]; }, z);
  const zmin = (await set(-9))[0]; console.log("zmin at dpr2 1280x800 css:", zmin);
  for (const z of [zmin, -3, 0]) { await set(z); await sleep(5000); const png = await page.screenshot({ type: "png" }) as Buffer; writeFileSync(`${OUT}/dpr2-z${z.toFixed(1)}.png`, png); const m = await sharp(png).metadata(); console.log("z", z.toFixed(2), "shot", m.width, m.height); }
} finally { await browser.close(); }
