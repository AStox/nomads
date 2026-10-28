// arrsettle.ts: arrivals (a far jump first, then the place at a zoom): correlation of a screenshot every ~150 ms with the final picture
import { launch, sleep, sharp, idleWaiter } from "./lib.ts";
const PLACES: [string, number, number, number, number][] = [["sea25N15E z2", 25, 15, 2, 13], ["sea25N15E z3", 25, 15, 3, 13], ["sea15N71W z2", 15.02, -71.76, 2, 20.5], ["sea15N71W z4", 15.02, -71.76, 4, 20.5], ["A z2", 4.35, -39.38, 2, 13], ["A z3", 4.35, -39.38, 3, 13], ["A z4", 4.35, -39.38, 4, 13], ["B z3", -35.9, 43.59, 3, 13], ["home z3", 47.78, 38.63, 3, 13], ["R z4", 12.02, 83.89, 4, 13], ["E2 z2", 13.27, 45, 2, 13], ["M z3", -26.17, -36.17, 3, 13]];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 300);
  const hp = (d: Buffer) => { const W = 600, H = 400, o = new Float32Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) o[y * W + x] = d[y * W + x] * 4 - d[y * W + x - 1] - d[y * W + x + 1] - d[(y - 1) * W + x] - d[(y + 1) * W + x]; return o; };
  const corr = (a: Float32Array, b: Float32Array) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i += 2) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb + 1e-9); };
  for (const [name, lat, lon, z, hour] of PLACES) {
    await page.evaluate((h: number) => { const el = document.querySelector("#hud input") as HTMLInputElement | null; if (el) { el.value = String(h); el.dispatchEvent(new Event("input", { bubbles: true })); } }, hour);
    await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: -60, lon: 170 }; P.camera.setZoom(1); });
    await idle();
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    const shots: Buffer[] = [], ts: number[] = []; const t0 = Date.now();
    for (let i = 0; i < 20; i++) { const b = await page.screenshot({ type: "jpeg", quality: 88 }); shots.push(await sharp(b).extract({ left: 100, top: 100, width: 600, height: 400 }).removeAlpha().greyscale().raw().toBuffer()); ts.push(Date.now() - t0); await sleep(120); }
    const h = shots.map(hp), last = h[h.length - 1], c = h.map((x, i) => [ts[i], +corr(x, last).toFixed(2)]);
    const first = c.find((x) => x[1] >= 0.9);
    console.log(JSON.stringify({ name, firstFrameCorr: c[0][1], t90ms: first ? first[0] : null, corr: c.filter((_, i) => i % 3 === 0) }));
  }
});
