import { withBrowser, go, info, PLACES } from "./lib.ts";
await withBrowser(async (page) => {
  for (const z of (process.env.ZS ?? "2.4,3.3,2.4").split(",").map(Number)) { await go(page, PLACES[process.env.PLACE ?? "A"], z); const i = await info(page); const e = await page.evaluate(() => { const P = (window as any).play, L = P.live; return { camH: L.camH(P.view.x, P.view.z), cam: L.stats.camHeight, under: L.groundUnder(P.view, 800, 500) }; }); console.log(z, i.mode, "lift", i.lift, "q", JSON.stringify(i.q), "geo", JSON.stringify(i.geo), "camH", e.camH, JSON.stringify(e.under)); }
});
