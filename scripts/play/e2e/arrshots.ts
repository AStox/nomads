// arrshots.ts lat lon z outDir: far jump then a screenshot at 60, 400, 900, 1500, 2200, 3600 ms (what does the arrival look like frame by frame)
import { mkdirSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const [lat, lon, z, out] = process.argv.slice(2); mkdirSync(out, { recursive: true });
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 300);
  await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: -60, lon: 170 }; P.camera.setZoom(1); });
  await idle();
  await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, +lat, +lon, +z);
  const t0 = Date.now();
  for (const wait of [60, 400, 900, 1500, 2200, 3600]) { while (Date.now() - t0 < wait) await sleep(15); await page.screenshot({ path: `${out}/t${wait}.jpg`, type: "jpeg", quality: 80 }); }
});
