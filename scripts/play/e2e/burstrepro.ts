// burstrepro.ts: replays the random-session wheel bursts that drifted (place, zoom, cursor, ticks from the session logs) at several tick gaps;
// before/after crops around the cursor and the API drift of the grabbed ground point. Output in burstrepro/
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, sleep, sharp, idleWaiter } from "./lib.ts";
mkdirSync("burstrepro", { recursive: true });
// id, vp, lat, lon, z0, cursorX, cursorY, dir (1 = out), ticks, session note
const CASES: [string, [number, number], number, number, number, number, number, number, number][] = [
  ["c1-s202-orbit", [1280, 800], -52.59, 154.51, -5.18, 936, 410, 1, 4],
  ["c2-s203-E2", [1920, 1080], 13.27, 45, -1.12, 1016, 286, -1, 3],
  ["c3-s204-A", [800, 1000], 4.53, -39.53, 1.83, 619, 349, 1, 4],
  ["c4-s205-26N", [1280, 800], 26.5, 32.8, -1.92, 882, 469, -1, 11],
  ["c5-s205-A", [1280, 800], 4.76, -39.04, -0.54, 759, 252, -1, 6],
];
const out: any[] = [];
const [id, vp, lat, lon, z0, cx, cy, dir, n] = CASES.find((c) => c[0].startsWith(process.argv[2]))!;
await launch(vp, "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 700);
  for (const gap of [30, 80, 150]) {
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z0);
    await idle(); await page.mouse.move(cx, cy); await sleep(200);
    const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); (window as any).__A = a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; return !!a; }, cx, cy);
    const before = await page.screenshot({ type: "jpeg", quality: 85 });
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(gap); }
    await idle();
    const r = A ? await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = (window as any).__A, s = P.live.screenOf(P.view, a.x, a.z, a.y, a.geo); return { z: P.view.zoom, d: Math.hypot(s[0] - x, s[1] - y), dx: s[0] - x, dy: s[1] - y }; }, cx, cy) : null;
    const after = await page.screenshot({ type: "jpeg", quality: 85 });
    const row = { id, vp: vp.join("x"), gap, picked: A, z0, z1: r ? +r.z.toFixed(2) : null, drift: r ? +r.d.toFixed(1) : null, dx: r ? +r.dx.toFixed(1) : null, dy: r ? +r.dy.toFixed(1) : null };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(`burstrepro/res-${id}.json`, JSON.stringify(out, null, 1));
    if (r && r.d > 8) { await sharp(before).toFile(`burstrepro/${id}-g${gap}-before.jpg`); await sharp(after).toFile(`burstrepro/${id}-g${gap}-after.jpg`); }
  }
});
