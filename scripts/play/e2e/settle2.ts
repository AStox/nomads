// settle2.ts lat lon z hour: screenshots every ~200 ms right after arriving; correlation with the last one (does the sea/ground keep sliding?)
import { launch, sleep, sharp, idleWaiter } from "./lib.ts";
const [lat, lon, z, hour] = process.argv.slice(2);
await launch([1280, 800], `hour=${hour ?? 13}&warm=0`, async (page) => {
  const idle = idleWaiter(page, 600);
  await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, +lat, +lon, +z);
  await idle();
  const t0 = Date.now(), shots: any[] = [];
  for (let i = 0; i < 24; i++) { shots.push({ t: Date.now() - t0, b: await page.screenshot({ type: "jpeg", quality: 85 }) }); await sleep(150); }
  const raw = await Promise.all(shots.map(async (s) => sharp(s.b).extract({ left: 100, top: 100, width: 600, height: 400 }).removeAlpha().greyscale().raw().toBuffer()));
  const hp = (d: Buffer) => { const W = 600, H = 400, o = new Float32Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) o[y * W + x] = d[y * W + x] * 4 - d[y * W + x - 1] - d[y * W + x + 1] - d[(y - 1) * W + x] - d[(y + 1) * W + x]; return o; };
  const h = raw.map(hp), last = h[h.length - 1];
  const corr = (a: Float32Array, b: Float32Array) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i += 2) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb + 1e-9); };
  console.log(JSON.stringify({ lat, lon, z, vsFinal: shots.map((s, i) => [s.t, +corr(h[i], last).toFixed(2)]) }));
});
