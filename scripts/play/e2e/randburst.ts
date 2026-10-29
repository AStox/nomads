// randburst.ts: wheel bursts at random cursor places, random starts (seeded), settled camera; drift of the ground under the cursor (API, valid below zoom 2.9)
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
let s = +(process.env.SEED ?? 7); const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const PL: [string, number, number][] = [["A", 4.35, -39.38], ["B", -35.9, 43.59], ["R", 12.02, 83.89], ["H", 47.78, 38.63], ["M", -26.17, -36.17], ["E2", 13.27, 45], ["D", -25.71, -40.51], ["K", 25, 15]];
const N = +(process.env.N ?? 24), out: any[] = [];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 600);
  for (let k = 0; k < N; k++) {
    const [nm, la, lo] = PL[Math.floor(rnd() * PL.length)], z0 = -2.5 + rnd() * 4.8, dir = rnd() < 0.5 ? -1 : 1, n = 2 + Math.floor(rnd() * 10), gap = 30 + Math.floor(rnd() * 120), cx = Math.round(80 + rnd() * 1120), cy = Math.round(120 + rnd() * 600);
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, la, lo, z0);
    await idle(); await page.mouse.move(cx, cy); await sleep(200);
    const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); (window as any).__A = a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; return !!a; }, cx, cy);
    if (!A) { out.push({ nm, z0: +z0.toFixed(2), cx, cy, nopick: true }); console.log(JSON.stringify(out[out.length - 1])); continue; }
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(gap); }
    await idle();
    const r = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = (window as any).__A, sc = P.live.screenOf(P.view, a.x, a.z, a.y, a.geo); return { z: P.view.zoom, d: Math.hypot(sc[0] - x, sc[1] - y) }; }, cx, cy);
    const row = { nm, z0: +z0.toFixed(2), z1: +r.z.toFixed(2), dir, n, gap, cx, cy, drift: +r.d.toFixed(1) };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(process.argv[2] ?? "randburst.json", JSON.stringify(out));
  }
});
