import { session, settle, setView, shot, OUT } from "./lib.ts";
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  const info = await page.evaluate(() => { const P = (window as any).play; return { zmin: P.live.zmin, zmax: P.live.zmax, zoom: P.view.zoom, geo: P.view.geo, bearing: P.view.bearing, keys: Object.keys(P), live: Object.keys(P.live).slice(0, 80), stats: JSON.stringify(P.live.stats).slice(0, 1500), mode: P.live.mode }; });
  console.log(JSON.stringify(info, null, 1));
  for (const z of [info.zmin, -4, -2, 0, 2, 3]) { await setView(page, [4.35, -39.38], z); const s = await settle(page); const r = await shot(page, `p-z${z}`); console.log(z, s, r.f); }
});
