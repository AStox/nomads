// orbitroll.ts <out>: orbit drags (zoom Z, default -5.5) at several latitudes, press at 0.5/0.9 of the disc radius, east/south/north.
// Roll = change of the screen angle of the south direction at the view centre; hop = per step screen jump of the grabbed place minus the mouse step.
// env LATS FR DIRS Z SHOTS
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const OUT = process.argv[2] ?? "orbitroll"; mkdirSync(OUT, { recursive: true });
const LATS = (process.env.LATS ?? "20,42,58,75,89.96").split(",").map(Number), FR = (process.env.FR ?? "0.5,0.9").split(",").map(Number), Z = +(process.env.Z ?? -5.5);
const out: any[] = [];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 400);
  for (const lat of LATS) for (const fr of FR) for (const dir of (process.env.DIRS ?? "E,S,N").split(",")) {
    await page.evaluate((a: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: 10 }; P.camera.setZoom(zz); }, lat, Z);
    await idle();
    const R = await page.evaluate(() => { const P = (window as any).play; let lo = 0, hi = 640; for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (P.live.groundUnder(P.view, 640 + m, 400)) lo = m; else hi = m; } return lo; });
    const cx = 640 + fr * R, cy = 400;
    await page.evaluate((x: number, y: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, x, y); (window as any).__A = A ? { x: A.x, z: A.z, y: A.y, geo: A.geo } : null; }, cx, cy);
    if (!(await page.evaluate(() => !!(window as any).__A))) continue;
    const ang = () => page.evaluate(() => { const P = (window as any).play, g = P.view.geo, a = P.live.screenOf(P.view, 0, 0, 0, { lat: g.lat, lon: g.lon }), b = P.live.screenOf(P.view, 0, 0, 0, { lat: g.lat - 0.5, lon: g.lon }); return Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; });
    const st = () => page.evaluate(() => { const P = (window as any).play, A = (window as any).__A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo); return [s[0], s[1]]; });
    const hd0 = await ang();
    let px = cx, py = cy; await page.mouse.move(px, py); await sleep(100); await page.mouse.down();
    const dx = dir === "E" ? 5 : 0, dy = dir === "S" ? 5 : dir === "N" ? -5 : 0;
    let prev = await st(), maxHop = 0, maxRoll = 0, maxOff = 0;
    for (let i = 1; i <= 30; i++) {
      px += dx; py += dy; await page.mouse.move(px, py); await sleep(70);
      const s = await st(), a = await ang();
      maxHop = Math.max(maxHop, Math.hypot(s[0] - prev[0] - dx, s[1] - prev[1] - dy)); maxRoll = Math.max(maxRoll, Math.abs(((a - hd0 + 540) % 360) - 180)); maxOff = Math.max(maxOff, Math.hypot(s[0] - px, s[1] - py)); prev = s;
    }
    const a1 = await ang(), s1 = await st(); await sleep(700); const a2 = await ang(), s2 = await st();
    await page.mouse.up(); await sleep(1500); const a3 = await ang();
    const row = { lat, fr, dir, maxRollDeg: +maxRoll.toFixed(1), maxHopPx: +maxHop.toFixed(1), maxOffMouse: +maxOff.toFixed(1), stillMovePx: +Math.hypot(s1[0] - s2[0], s1[1] - s2[1]).toFixed(2), stillDeg: +Math.abs(((a1 - a2 + 540) % 360) - 180).toFixed(2), afterReleaseDeg: +(((a3 - hd0 + 540) % 360) - 180).toFixed(1) };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(`${OUT}/res.json`, JSON.stringify(out));
  }
});
