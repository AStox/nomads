// dragshot.ts lat lon zoom dx dy steps out : slow drag with stills at steps 0, 25%, 50%, 75%, 100% (mouse held) and the grabbed point's screen place
import { launch, sleep, idleWaiter, sharp } from "./lib.ts";
const [lat, lon, z, dx, dy, steps, out] = process.argv.slice(2); const VPs = (process.env.VP ?? "1280x800").split("x").map(Number);
await launch(VPs as [number, number], `hour=${process.env.HOUR ?? 13}&warm=0`, async (page) => {
  const idle = idleWaiter(page, 500);
  await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, +lat, +lon, +z);
  await idle();
  const cx = VPs[0] / 2, cy = VPs[1] / 2; await page.mouse.move(cx, cy); await sleep(150);
  await page.evaluate((x: number, y: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, x, y); (window as any).__A = A ? { x: A.x, z: A.z, y: A.y, geo: A.geo } : null; }, cx, cy);
  const where = () => page.evaluate(() => { const P = (window as any).play, A = (window as any).__A; const s = A ? P.live.screenOf(P.view, A.x, A.z, A.y, A.geo) : null; return { s: s ? [Math.round(s[0]), Math.round(s[1])] : null, geo: P.view.geo, zoom: P.view.zoom }; });
  const files: string[] = [];
  const shot = async (n: number, px: number, py: number) => { const w = await where(); console.log(n, "mouse", px, py, JSON.stringify(w)); const f = `${out}-${n}.jpg`; await page.screenshot({ path: f, type: "jpeg", quality: 70 }); files.push(f); };
  await page.mouse.down(); let px = cx, py = cy; await shot(0, px, py);
  const N = +steps;
  for (let i = 1; i <= N; i++) { px += +dx; py += +dy; await page.mouse.move(px, py); await sleep(25); if (i % Math.round(N / 4) === 0) { await sleep(120); await shot(i, px, py); } }
  await sleep(300); await page.mouse.up(); await shot(901, px, py); await sleep(150); await shot(902, px, py); await sleep(300); await shot(903, px, py); await sleep(700); await shot(904, px, py);
});
