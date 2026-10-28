// burstframes.ts: the B zoom 1.8 fast-release-then-burst case with a screenshot after the release and after each tick (and the API drift per tick)
import { mkdirSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
mkdirSync("burstframes", { recursive: true });
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 700);
  await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, -35.9, 43.59, 1.8);
  await idle();
  await page.mouse.move(500, 400); await page.mouse.down();
  for (let i = 0; i < 8; i++) { await page.mouse.move(500 + (i + 1) * 40, 400 + (i + 1) * 10); await sleep(12); }
  await page.mouse.up();
  const cx = 820, cy = 480;
  const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); (window as any).__A = a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; return !!a; }, cx, cy);
  const drift = () => page.evaluate((x: number, y: number) => { const P = (window as any).play, a = (window as any).__A, s = P.live.screenOf(P.view, a.x, a.z, a.y, a.geo); return [+P.view.zoom.toFixed(2), +s[0].toFixed(0), +s[1].toFixed(0), +Math.hypot(s[0] - x, s[1] - y).toFixed(1)]; }, cx, cy);
  await page.mouse.move(cx, cy);
  await page.screenshot({ path: "burstframes/f0-before.jpg", type: "jpeg", quality: 85 });
  console.log("picked", A, "start", JSON.stringify(await drift()));
  for (let i = 1; i <= 6; i++) { await page.mouse.wheel({ deltaY: 100 }); await sleep(60); console.log("tick", i, "zoom,screen x,y,drift", JSON.stringify(await drift())); if (i === 2 || i === 4 || i === 6) await page.screenshot({ path: `burstframes/f${i}.jpg`, type: "jpeg", quality: 85 }); }
  await idle(); console.log("settled", JSON.stringify(await drift()));
  await page.screenshot({ path: "burstframes/f9-settled.jpg", type: "jpeg", quality: 85 });
});
