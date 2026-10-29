// shared helpers for the e2e user: launch headless Chrome with WebGPU, hold a page, clean up
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
export const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
export const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
export const sleep = Bun.sleep;
export const HOME_E2E = join(homedir(), ".cache/nomads-scratch/e2e3");
export const SITE = process.env.SITE ?? "http://127.0.0.1:8197";
export const PROFILE = join(HOME_E2E, "chrome");
export async function launch(vp: [number, number], query: string, fn: (page: any, cdp: any, browser: any, errs: any[]) => Promise<void>) {
  const [VW, VH] = vp;
  rmSync(PROFILE, { recursive: true, force: true });
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 25000,
    args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${VW},${VH + 143}`, `--user-data-dir=${PROFILE}`],
    defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  });
  const bye = async () => { try { await browser.close(); } catch {} process.exit(1); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  const errs: any[] = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const t0 = Date.now();
    page.on("pageerror", (e: Error) => errs.push({ t: Date.now(), kind: "pageerror", msg: e.message.slice(0, 300) }));
    page.on("console", (m: any) => { const ty = m.type(); if (ty === "error" || ty === "warning" || /LOST|lost|WEBGPU/.test(m.text())) errs.push({ t: Date.now(), kind: "console." + ty, msg: m.text().slice(0, 300) }); });
    page.on("response", (r: any) => { if (r.status() >= 400) errs.push({ t: Date.now(), kind: "http" + r.status(), msg: r.url().slice(0, 200) }); });
    page.on("requestfailed", (r: any) => errs.push({ t: Date.now(), kind: "requestfailed", msg: (r.url() + " " + (r.failure()?.errorText ?? "")).slice(0, 200) }));
    const cdp = await page.createCDPSession();
    await page.goto(`${SITE}/play/?${query}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("body.ready", { timeout: 120000 });
    console.log("ready after", Date.now() - t0, "ms");
    await fn(page, cdp, browser, errs);
  } finally {
    try { await browser.close(); } catch {}
  }
  process.exit(0);
}
// the page's idle check, used by every still script
export const idleWaiter = (page: any, settleMs = 600) => async () => { for (let i = 0; i < 40; i++) { await sleep(450); const r = await page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!r.busy) { await sleep(settleMs); return; } } };
