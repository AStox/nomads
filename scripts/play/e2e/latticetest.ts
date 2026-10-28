// latticetest.ts lat lon zoom hour: pan by a known drag; is the fine pattern screen-fixed (corrScreenFixed ~0, bestShift = the drag) or ground-fixed?
import { launch, sleep, sharp, idleWaiter } from "./lib.ts";
const [lat, lon, z, hour] = process.argv.slice(2);
await launch([1280, 800], `hour=${hour ?? 13}&warm=0`, async (page) => {
  const idle = idleWaiter(page, 600);
  await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, +lat, +lon, +z);
  await idle();
  const W = 900, Hh = 600;
  const hp = async () => { const b = await page.screenshot({ type: "png" }); const { data } = await sharp(b).extract({ left: 100, top: 100, width: W, height: Hh }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true }); const o = new Float32Array(W * Hh); for (let y = 1; y < Hh - 1; y++) for (let x = 1; x < W - 1; x++) o[y * W + x] = data[y * W + x] * 4 - data[y * W + x - 1] - data[y * W + x + 1] - data[(y - 1) * W + x] - data[(y + 1) * W + x]; return o; };
  const a = await hp();
  await page.mouse.move(640, 400); await page.mouse.down(); for (let i = 1; i <= 8; i++) { await page.mouse.move(640 + i * 5, 400 + i * 3); await sleep(80); } await page.mouse.up(); await idle();
  const b = await hp();
  const corr = (dx: number, dy: number) => { let s = 0, na = 0, nb = 0; for (let y = 70; y < Hh - 70; y += 2) for (let x = 70; x < W - 70; x += 2) { const p = a[y * W + x], q = b[(y + dy) * W + x + dx]; s += p * q; na += p * p; nb += q * q; } return s / Math.sqrt(na * nb + 1e-9); };
  const c0 = corr(0, 0); let best = -1, bx = 0, by = 0;
  for (let dy = -60; dy <= 60; dy++) for (let dx = -60; dx <= 60; dx++) { const c = corr(dx, dy); if (c > best) { best = c; bx = dx; by = dy; } }
  console.log(JSON.stringify({ lat, lon, z, hour, corrScreenFixed: +c0.toFixed(3), bestShift: [bx, by], bestCorr: +best.toFixed(3) }));
});
