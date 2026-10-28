// look.ts: screenshots of named spots at several zooms. Quote the specs (semicolons): bun look.ts <outDir> "lat,lon,z1;z2;z3" ...
//   env Q (page query, default hour=13&warm=0), VP (WxH)
import { mkdirSync } from "node:fs";
import { launch, idleWaiter } from "./lib.ts";
const [OUT, ...specs] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
await launch((process.env.VP ?? "1280x800").split("x").map(Number) as [number, number], process.env.Q ?? "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 800);
  for (const sp of specs) {
    const [lat, lon, zs] = sp.split(",").length === 3 ? sp.split(",") : [0, 0, ""];
    for (const z of String(zs).split(";").map(Number)) {
      await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, +lat, +lon, z);
      await idle();
      const f = `${OUT}/${lat}_${lon}_z${z}.png`;
      await page.screenshot({ path: f });
      const st = await page.evaluate(() => { const P = (window as any).play; return [P.view.zoom, P.view.geo.lat, P.view.geo.lon]; });
      console.log(f, JSON.stringify(st));
    }
  }
});
