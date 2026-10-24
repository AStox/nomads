import { launch, sleep } from "./lib";
import { sharp } from "./lib";
const site = process.argv[2], out = process.argv[3];
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
  await sleep(9000);
  const st = await r.page.evaluate(() => { const P = (window as any).play; return { x: P.view.x, z: P.view.z, zoom: P.view.zoom, geo: P.view.geo, bearing: P.view.bearing, mode: P.live.mode, win: P.live.stats.window?.id }; });
  console.log(site, JSON.stringify(st));
  await sharp((await r.page.screenshot({ type: "png" })) as Buffer).resize(800, 500).jpeg({ quality: 80 }).toFile(out);
} finally { await r.close(); }
process.exit(0);
