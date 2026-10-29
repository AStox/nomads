// slidertest.ts: click and drag the hour slider (as session.ts does: move there, press, 60 ms, release) at places and zooms; does the camera move? per rAF geo and zoom.
//   VP=1920x1080 PLACES=X CUSTOM=lat,lon ZS=-1.75 lockf /tmp/nomads-gpu.lock bun slidertest.ts out.json
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const [VW, VH] = (process.env.VP ?? "1280x800").split("x").map(Number);
const PL: [string, number, number][] = process.env.CUSTOM ? [["X", ...(process.env.CUSTOM.split(",").map(Number) as [number, number])]] : [["A", 4.35, -39.38], ["B", -35.9, 43.59], ["H", 47.78, 38.63]];
const ZS = (process.env.ZS ?? "-1.75,1").split(",").map(Number), N = +(process.env.N ?? 4);
const out: any[] = [];
await launch([VW, VH], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 500);
  await page.evaluate(() => { const w = window as any; w.__g = []; w.__on = false; const f = () => { if (w.__on) { const g = w.play.view.geo; w.__g.push([performance.now(), g.lat, g.lon, w.play.view.zoom]); } requestAnimationFrame(f); }; requestAnimationFrame(f); });
  for (const [nm, la, lo] of PL) for (const z of ZS) {
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, la, lo, z);
    await idle();
    const h = await page.$("#hud input"); const bb = h && (await h.boundingBox()); if (!bb) { console.log("no slider"); continue; }
    for (let i = 0; i < N; i++) {
      await page.evaluate(() => { (window as any).__g = []; (window as any).__on = true; });
      await page.mouse.move(bb.x + bb.width * (0.1 + 0.2 * i), bb.y + bb.height / 2, { steps: 6 }); await sleep(100);
      await page.mouse.down(); await sleep(60); if (process.env.MOVE) { const mx0 = bb.x + bb.width * (0.1 + 0.2 * i), my0 = bb.y + bb.height / 2; for (let k = 1; k <= 10; k++) { await page.mouse.move(mx0 + k * 25 * (i % 2 ? -1 : 1), my0 + k * 12); await sleep(25); } } await page.mouse.up(); await sleep(1500);
      const g: number[][] = await page.evaluate(() => { (window as any).__on = false; return (window as any).__g; });
      let mx = 0; for (const r of g) mx = Math.max(mx, Math.hypot(r[1] - g[0][1], r[2] - g[0][2]), Math.abs(r[3] - g[0][3]));
      const row = { place: nm, z, press: i, frames: g.length, maxMoveDeg: +mx.toFixed(3) };
      out.push(row); console.log(JSON.stringify(row)); writeFileSync(process.argv[2] ?? "slidertest.json", JSON.stringify(out));
    }
  }
});
