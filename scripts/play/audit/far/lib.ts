import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
export const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
export const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
export const sleep = Bun.sleep;
export const OUT = "/tmp/globe-fix-lead/out";
export const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], D: [16.11, 43.64], E: [35.26, 45], G: [44.9, 133.05], K: [-15.75, 26.76], R: [12.02, 83.89] };
export async function session(vp: [number, number], query: string, fn: (page: any, browser: any) => Promise<void>) {
  const [VW, VH] = vp;
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000,
    args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${VW},${VH + 143}`, `--user-data-dir=/tmp/globe-fix-lead/chrome`],
    defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
  });
  const bye = async () => { try { await browser.close(); } catch {} process.exit(1); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    const errs: string[] = [];
    page.on("pageerror", (e: Error) => errs.push("PAGEERR " + e.message));
    page.on("console", (m: any) => { const t = m.text(); if (/LOST|error|Error|warn|WebGPU|render worker|pages:/i.test(t) && !/font/i.test(t)) errs.push(t.slice(0, 200)); });
    await page.goto(`http://127.0.0.1:8231/play/?${query}`, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("body.ready", { timeout: 90000 });
    (page as any).errs = errs;
    await fn(page, browser);
    if (errs.length) console.log("console issues:", [...new Set(errs)].slice(0, 10));
  } finally {
    try { await browser.close(); } catch {}
  }
}
// wait until the view stops changing (tiles, window, cap) at most ms
export const settle = (page: any, ms = 6000) => page.evaluate(async (max: number) => {
  const L = (window as any).play.live, s = (t: number) => new Promise((r) => setTimeout(r, t));
  const key = () => `${L.mode}|${(L.stats.ladderAlpha ?? 0).toFixed(3)}|${L.stats.tiles ?? ""}|${JSON.stringify(L.stats.planet ?? "")}`;
  const t0 = performance.now(); let last = key(), since = performance.now();
  await s(300);
  while (performance.now() - t0 < max) { await s(100); const k = key(); if (k !== last) { last = k; since = performance.now(); } else if (performance.now() - since > 600) break; }
  return { settled: performance.now() - since > 600 };
}, ms);
export const setView = (page: any, geo: [number, number] | null, zoom: number | null, bearing: number | null = null) => page.evaluate((g: any, z: any, b: any) => {
  const P = (window as any).play; if (g) P.view.geo = { lat: g[0], lon: g[1] }; if (z != null) P.camera.setZoom(z); if (b != null) P.view.bearing = b;
}, geo, zoom, bearing);
export async function shot(page: any, name: string) {
  const png: Buffer = await page.screenshot({ type: "png" });
  const f = `${OUT}/${name}.png`; writeFileSync(f, png); return { f, png };
}
