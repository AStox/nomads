// burstx.ts: wheel bursts at a held cursor; drift of the grabbed ground point (API) after the burst, at 30 ms and 120 ms tick gaps
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const CASES: [string, number, number, number, number, number, number, number][] = [
  // name, lat, lon, z0, cursorX, cursorY, deltaY per tick, ticks
  ["B up thru0", -36.0, 43.56, -0.92, 640, 400, -100, 6], ["B down thru0", -36.0, 43.56, 1.2, 500, 450, 100, 10], ["A up", 4.35, -39.38, -1.3, 700, 420, -100, 10], ["A down", 4.35, -39.38, 0.8, 560, 380, 100, 9],
  ["R up", 12.02, 83.89, -0.9, 300, 600, -100, 6], ["R down", 12.02, 83.89, 1.5, 900, 250, 100, 12], ["home up", 47.78, 38.63, -1.0, 640, 400, -100, 7], ["M down", -26.17, -36.17, 1.0, 400, 300, 100, 8], ["E2 up", 13.27, 45, -0.7, 820, 520, -100, 7],
];
const out: any[] = [];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 700);
  for (const [name, lat, lon, z, cx, cy, dy, n] of CASES) for (const gap of [30, 120]) {
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    await page.mouse.move(cx, cy); await sleep(150);
    await page.evaluate((x: number, y: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, x, y); (window as any).__A = A ? { x: A.x, z: A.z, y: A.y, geo: A.geo } : null; }, cx, cy);
    if (!(await page.evaluate(() => !!(window as any).__A))) continue;
    const z0 = await page.evaluate(() => (window as any).play.view.zoom as number);
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dy }); await sleep(gap); }
    await idle();
    const r = await page.evaluate((cx: number, cy: number) => { const P = (window as any).play, A = (window as any).__A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo); return { z: P.view.zoom, d: Math.hypot(s[0] - cx, s[1] - cy) }; }, cx, cy);
    const row = { name, gap, z0: +z0.toFixed(2), z1: +r.z.toFixed(2), drift: +r.d.toFixed(1) };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync("burst.json", JSON.stringify(out));
  }
});
