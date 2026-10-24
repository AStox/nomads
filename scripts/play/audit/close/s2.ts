// zoom steps at a place, camera fixed, each settled: PLACE ZS TAG
import { withBrowser, go, shot, idle, info, PLACES, sleep } from "./lib.ts";
const place = process.env.PLACE ?? "A", zs = (process.env.ZS ?? "2.6,2.7,2.8,2.9,3.0").split(",").map(Number), tag = process.env.TAG ?? "s2";
await withBrowser(async (page) => {
  await go(page, PLACES[place], zs[0]);
  for (const z of zs) {
    await page.evaluate((zz: number) => { const L = (window as any).play.live; L.debug.hold(false); (window as any).play.camera.setZoom(zz); }, z);
    await sleep(600); await idle(page, 20000);
    await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
    await shot(page, `${tag}-${place}-${z}`);
    const i = await info(page); const cn = (i.alpha ?? 0) > 0 && !process.env.NOCOUNT ? await page.evaluate(() => (window as any).play.live.debug.check({ op: "count" })) : { sprites: -1, points: -1 }; console.log(z, "sprites", cn.sprites, "points", cn.points, i.mode, "alpha", i.alpha?.toFixed?.(2), "canopy", i.canopy?.toFixed(2), "win", i.win);
  }
});
