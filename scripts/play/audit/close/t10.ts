// a jump of the camera within the window (plane x set directly): does the page settle?
import { withBrowser, go, PLACES, sleep } from "./lib.ts";
const X = Number(process.env.X ?? 2800), Z = Number(process.env.ZZ ?? 0);
await withBrowser(async (page) => {
  await go(page, PLACES[process.env.PLACE ?? "A"], Number(process.env.Z ?? 4));
  await page.evaluate((x: number, z: number) => { const P = (window as any).play; P.live.debug.hold(false); P.view.x = x; P.view.z = z; }, X, Z);
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    const r = await page.evaluate(async () => { const L = (window as any).play.live, t = performance.now(); const idle = await Promise.race([L.debug.check({ op: "idle" }), new Promise((r) => setTimeout(() => r("TIMEOUT"), 6000))]); return { idle, win: L.stats.window?.id, mode: L.mode, builds: L.stats.window?.builds, ask: performance.now() - t, x: (window as any).play.view.x }; });
    console.log(Math.round((Date.now() - t0) / 1000), "s", JSON.stringify(r));
    if (r.idle !== "TIMEOUT" && !r.idle.busy && i > 2) break;
  }
});
