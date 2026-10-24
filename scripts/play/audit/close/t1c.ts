// drag test, shift found from the large scale, then the speckle's agreement at that shift against at zero
import { withBrowser, go, shot, info, idle, PLACES, hp, shiftSearch, sleep, OUT, sharp } from "./lib.ts";
import { join } from "node:path";
const place = process.env.PLACE ?? "A", zs = (process.env.ZS ?? "1.6,2.0,2.4,2.7,2.9").split(",").map(Number);
const DX = Number(process.env.DX ?? 60), DY = Number(process.env.DY ?? 30);
const big = async (f: string, k: number) => { const { data, info } = await sharp(f).removeAlpha().greyscale().blur(k).raw().toBuffer({ resolveWithObject: true }); const o = new Float32Array(data.length); for (let i = 0; i < o.length; i++) o[i] = data[i]; return { d: o, w: info.width, h: info.height }; };
await withBrowser(async (page) => {
  for (const z of zs) {
    await go(page, PLACES[place], z); if (process.env.SKIP) { await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: ["*"] })); await sleep(1500); }
    await shot(page, `t1c-${place}-${z}-a`);
    await page.evaluate(() => (window as any).play.live.debug.hold(false));
    await page.mouse.move(800, 500); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(800 + DX * i / 12, 500 + DY * i / 12); await sleep(30); }
    await page.mouse.up(); await sleep(300); await idle(page, 15000);
    await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
    await shot(page, `t1c-${place}-${z}-b`);
    const fa = join(OUT, `t1c-${place}-${z}-a.png`), fb = join(OUT, `t1c-${place}-${z}-b.png`);
    const A6 = await big(fa, 6), B6 = await big(fb, 6), Ah = await hp(fa, 6), Bh = await hp(fb, 6);
    const rows = [];
    for (const [bx, by] of [[300, 250], [900, 250], [300, 650], [900, 650]]) {
      const c = shiftSearch(A6, B6, bx, by, 300, 250, 100, undefined, 2);
      const ref = shiftSearch(Ah, Bh, bx, by, 300, 250, 3, [c.best[0], c.best[1]], 1);   // search near the coarse answer is not possible with a window origin; use explicit cost
      // explicit: cost at coarse shift, and the best within +-3 of it
      const cost = (dx: number, dy: number) => { let s = 0, n = 0; for (let y = by; y < by + 250; y += 2) for (let x = bx; x < bx + 300; x += 2) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= Ah.h || xx < 0 || xx >= Ah.w) continue; s += Math.abs(Ah.d[y * Ah.w + x] - Bh.d[yy * Bh.w + xx]); n++; } return s / n; };
      let best: [number, number, number] = [1e9, 0, 0]; for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) { const v = cost(c.best[0] + i, c.best[1] + j); if (v < best[0]) best = [v, c.best[0] + i, c.best[1] + j]; }
      rows.push({ blk: [bx, by], coarse: c.best, coarseCost: c.cost, hiAtCoarse: +cost(c.best[0], c.best[1]).toFixed(1), hiBestNear: [best[1], best[2], +best[0].toFixed(1)], hiAtZero: +cost(0, 0).toFixed(1) });
    }
    console.log(z, JSON.stringify(await info(page)).slice(0, 90), JSON.stringify(rows));
  }
});
