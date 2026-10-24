// does the ground texture move with the ground when dragged? real mouse drag, stills before/after, shift searched on low and high passes
import { withBrowser, go, shot, info, idle, PLACES, hp, shiftSearch, sleep, OUT } from "./lib.ts";
import { join } from "node:path";
const place = process.env.PLACE ?? "A", zs = (process.env.ZS ?? "2.4,3.3,4,6.5").split(",").map(Number);
const DX = 60, DY = 30;
await withBrowser(async (page) => {
  for (const z of zs) {
    await go(page, PLACES[place], z);
    const sc = () => page.evaluate(() => { const P = (window as any).play, L = P.live; return L.screenOf(P.view, 0, 0, 0, P.view.geo); });
    await shot(page, `t1-${place}-${z}-a`);
    const s0 = await sc();
    await page.evaluate(() => (window as any).play.live.debug.hold(false));
    await page.mouse.move(800, 500); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(800 + DX * i / 12, 500 + DY * i / 12); await sleep(30); }
    await page.mouse.up();
    await sleep(300);
    await idle(page, 15000);
    await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
    await shot(page, `t1-${place}-${z}-b`);
    const inf = await info(page);
    // the geo is where the camera is now; the old target's screen place
    const s1 = await page.evaluate((g: any) => { const P = (window as any).play, L = P.live; return L.screenOf(P.view, 0, 0, 0, g); }, PLACES[place] ? { lat: PLACES[place][0], lon: PLACES[place][1] } : null);
    const dx = s1[0] - s0[0], dy = s1[1] - s0[1];
    const A = await hp(join(OUT, `t1-${place}-${z}-a.png`), 8), B = await hp(join(OUT, `t1-${place}-${z}-b.png`), 8);
    const A2 = await hp(join(OUT, `t1-${place}-${z}-a.png`), 24), B2 = await hp(join(OUT, `t1-${place}-${z}-b.png`), 24);
    const ex: [number, number] = [Math.round(dx), Math.round(dy)];
    const rows = [];
    for (const [bx, by] of [[300, 250], [900, 250], [300, 650], [900, 650]]) {
      const lo = shiftSearch(A2, B2, bx, by, 300, 250, 90, ex, 2), hi = shiftSearch(A, B, bx, by, 300, 250, 90, ex, 1);
      rows.push({ blk: [bx, by], low: lo, high: hi });
    }
    console.log(z, "mode", inf.mode, "expected shift of target", ex, JSON.stringify(rows));
  }
});
