// burstfresh.ts <case> : same burst as burstrepro but started WAITMS after the jump (no idle wait), to test "burst right after an arrival"
import { writeFileSync } from "node:fs";
import { launch, sleep, sharp } from "./lib.ts";
const CASES: Record<string, [[number, number], number, number, number, number, number, number, number]> = {
  c1: [[1280, 800], -52.59, 154.51, -5.18, 936, 410, 1, 4], c2: [[1920, 1080], 13.27, 45, -1.12, 1016, 286, -1, 3], c3: [[800, 1000], 4.53, -39.53, 1.83, 619, 349, 1, 4], c4: [[1280, 800], 26.5, 32.8, -1.92, 882, 469, -1, 11], c5: [[1280, 800], 4.76, -39.04, -0.54, 759, 252, -1, 6],
};
const [vp, lat, lon, z0, cx, cy, dir, n] = CASES[process.argv[2]];
await launch(vp, "hour=13&warm=0", async (page) => {
  const out: any[] = [];
  for (const wait of [100, 400, 800, 1500, 3000]) {
    await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: -60, lon: 170 }; P.camera.setZoom(1); });
    await sleep(2500);
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z0);
    await sleep(wait);
    await page.mouse.move(cx, cy); await sleep(50);
    const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); (window as any).__A = a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; return !!a; }, cx, cy);
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(60); }
    for (let i = 0; i < 40; i++) { await sleep(450); const r = await page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!r.busy) { await sleep(700); break; } }
    const r = A ? await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = (window as any).__A, s = P.live.screenOf(P.view, a.x, a.z, a.y, a.geo); return { z: P.view.zoom, d: Math.hypot(s[0] - x, s[1] - y), under: !!P.live.groundUnder(P.view, x, y) }; }, cx, cy) : null;
    out.push({ case: process.argv[2], waitAfterJumpMs: wait, picked: A, z1: r ? +r.z.toFixed(2) : null, drift: r ? +r.d.toFixed(1) : null, cursorStillOnGround: r?.under });
    console.log(JSON.stringify(out[out.length - 1]));
  }
});
