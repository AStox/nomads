// burstinertia.ts: a fast drag released, then a wheel burst START ms later at a held cursor: does the ground under the cursor drift? (inertia / easing after a drag)
import { launch, sleep } from "./lib.ts";
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = async () => { for (let i = 0; i < 40; i++) { await sleep(450); const r = await page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!r.busy) { await sleep(700); return; } } };
  for (const [name, lat, lon, z0, dir, n] of [["A z0.5 in", 4.35, -39.38, 0.5, -1, 6], ["E2 z-1 in", 13.27, 45, -1, -1, 5], ["B z1.8 out", -35.9, 43.59, 1.8, 1, 6]] as [string, number, number, number, number, number][])
    for (const [fast, startMs] of [[false, 0], [true, 0], [true, 150], [true, 500], [true, 1200]] as [boolean, number][]) {
      await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z0);
      await idle();
      await page.mouse.move(500, 400); await page.mouse.down();
      if (fast) for (let i = 0; i < 8; i++) { await page.mouse.move(500 + (i + 1) * 40, 400 + (i + 1) * 10); await sleep(12); } else for (let i = 0; i < 8; i++) { await page.mouse.move(500 + (i + 1) * 5, 400 + (i + 1) * 1); await sleep(70); }
      await page.mouse.up();
      const cx = fast ? 820 : 540, cy = fast ? 480 : 408;
      await sleep(startMs);
      const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); (window as any).__A = a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; return !!a; }, cx, cy);
      for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(60); }
      await idle();
      const r = A ? await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = (window as any).__A, s = P.live.screenOf(P.view, a.x, a.z, a.y, a.geo); return { z: P.view.zoom, d: Math.hypot(s[0] - x, s[1] - y) }; }, cx, cy) : null;
      console.log(JSON.stringify({ name, fastRelease: fast, burstStartsAfterReleaseMs: startMs, z1: r ? +r.z.toFixed(2) : null, drift: r ? +r.d.toFixed(1) : null }));
    }
});
