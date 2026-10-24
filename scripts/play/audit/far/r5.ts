import { session, settle, setView, shot, OUT, sleep, PLACES } from "./lib.ts";
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  for (const z of [-2, -1, 0, 1.5, 2.5]) { await setView(page, PLACES.R, z); await settle(page, 6000); await sleep(1200); const r = await shot(page, `river-R-z${z}`); console.log(r.f); }
  const zoomOf = () => page.evaluate(() => (window as any).play.view.zoom);
  for (const z of [zmin, -2]) {
    await setView(page, PLACES.D, z); await settle(page, 5000); await sleep(500); const a = await zoomOf();
    await page.mouse.click(800, 480); await sleep(120); await page.mouse.click(800, 480); await sleep(1500);
    console.log("double click at z", z.toFixed(2), "goal moved: zoom", a.toFixed(2), "->", (await zoomOf()).toFixed(2));
  }
});
