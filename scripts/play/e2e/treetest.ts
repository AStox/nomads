// treetest.ts <out> lat lon zStart zEnd: wheel zoom ladder in 0.1 steps (one tick of 25 per step), luma and longest frame gap per step, both ways
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, sleep, sharp, idleWaiter } from "./lib.ts";
const OUT = process.argv[2] ?? "tree"; mkdirSync(OUT, { recursive: true });
const [lat, lon, zs, ze] = [+(process.argv[3] ?? 12.23), +(process.argv[4] ?? 83.85), +(process.argv[5] ?? 8.5), +(process.argv[6] ?? 3)];
const res: any[] = [];
await launch([1280, 800], process.env.Q ?? "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 500);
  await page.evaluate((a: number, b: number, z: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(z); }, lat, lon, zs);
  await idle();
  await page.evaluate(() => { const w = window as any; w.__gap = 0; w.__last = performance.now(); const f = (t: number) => { w.__gap = Math.max(w.__gap, t - w.__last); w.__last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await page.mouse.move(640, 400);
  for (const dir of [1, -1]) for (let i = 0; i < 80; i++) {
    const z = await page.evaluate(() => (window as any).play.view.zoom as number);
    if ((dir === 1 && z <= ze) || (dir === -1 && z >= zs)) break;
    await page.evaluate(() => { (window as any).__gap = 0; });
    await page.mouse.wheel({ deltaY: dir * 25 }); await sleep(900);
    const st = await page.evaluate(() => ({ z: (window as any).play.view.zoom, gap: (window as any).__gap }));
    await idle();
    const b = await page.screenshot({ type: "jpeg", quality: 80 });
    const { data } = await sharp(b).extract({ left: 0, top: 70, width: 1280, height: 730 }).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    let m = 0; for (const v of data) m += v; m /= data.length;
    const row = { dir, z: +st.z.toFixed(3), luma: +m.toFixed(2), maxGapMs: +st.gap.toFixed(0) };
    res.push(row); console.log(JSON.stringify(row)); writeFileSync(`${OUT}/res.json`, JSON.stringify(res));
  }
});
