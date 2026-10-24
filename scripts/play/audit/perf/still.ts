// a still camera at many zooms with the clock held: slots (views drawn) and the change between two pictures a moment apart
import { launch, sleep, settleTo } from "./lib";
import { sharp } from "./lib";
const site = process.argv[2] ?? "http://127.0.0.1:8231";
const zs = (process.argv[3] ?? "2.0,2.6,3.2,4,5,6,6.5,7,7.5,8,8.3,9").split(",").map(Number);
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
  for (const z of zs) {
    await settleTo(r.page, [4.35, -39.38], z, 30000); await sleep(2500);
    const slots = await r.page.evaluate(() => (window as any).play.live.stats.slots);
    const a = await sharp((await r.page.screenshot({ type: "png" })) as Buffer).raw().toBuffer(); await sleep(1300);
    const b = await sharp((await r.page.screenshot({ type: "png" })) as Buffer).raw().toBuffer(); await sleep(700);
    const c = await sharp((await r.page.screenshot({ type: "png" })) as Buffer).raw().toBuffer();
    const d = (x: Buffer, y: Buffer) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return (s / x.length).toFixed(2); };
    console.log(`z ${z} slots ${slots} change ${d(a, b)} ${d(b, c)}`);
  }
} finally { await r.close(); }
process.exit(0);
