import { session, settle, setView, shot, OUT, sleep } from "./lib.ts";
import { luma } from "./img.ts";
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  console.log("sky", JSON.stringify(await page.evaluate(() => { const k = (window as any).play.live.sky(); return k && { sun: k.sun, moon: k.moon && { el: k.moon.el, dir: k.moon.dir } }; })));
  const diff = async (a: Buffer, b: Buffer) => { const A = await luma(a), B = await luma(b); let c = 0; for (let i = 0; i < A.d.length; i++) if (Math.abs(A.d[i] - B.d[i]) > 10) c++; return +(c / A.d.length * 100).toFixed(1); };
  for (const z of [zmin, -3, -1, 0]) {
    await setView(page, [16.11, 43.64], z, 0); await settle(page, 6000); await sleep(500);
    const a = await shot(page, `rot-z${z.toFixed(1)}-A`); const b0 = await page.evaluate(() => (window as any).play.view.bearing);
    await page.mouse.move(800, 500); await page.mouse.down({ button: "right" }); for (let i = 1; i <= 6; i++) { await page.mouse.move(800 + i * 30, 500, { steps: 2 }); await sleep(60); } await page.mouse.up({ button: "right" });
    await sleep(1200); await settle(page, 5000); await sleep(400);
    const b = await shot(page, `rot-z${z.toFixed(1)}-B`); const b1 = await page.evaluate(() => (window as any).play.view.bearing);
    console.log("rightdrag z", z.toFixed(2), "bearing", b0, "->", b1.toFixed(3), "pixels changed %", await diff(a.png, b.png));
    await setView(page, null, z, 0); await sleep(200); await page.keyboard.press("e"); await sleep(900); await settle(page, 4000);
    const c = await shot(page, `rot-z${z.toFixed(1)}-E`); const b2 = await page.evaluate(() => (window as any).play.view.bearing);
    console.log("key E z", z.toFixed(2), "bearing ->", b2, "pixels changed % vs A", await diff(a.png, c.png));
    await setView(page, null, null, 0);
  }
  // double click zoom at the orbit
  await setView(page, [16.11, 43.64], zmin, 0); await settle(page, 5000);
  await page.mouse.click(800, 480, { clickCount: 2 }); await sleep(1500);
  console.log("dblclick at orbit: zoom", zmin.toFixed(2), "->", (await page.evaluate(() => (window as any).play.view.zoom)).toFixed(2));
  // zoom out limit: wheel out hard at zmin
  await setView(page, null, zmin + 0.5); for (let i = 0; i < 8; i++) { await page.mouse.wheel({ deltaY: 200 }); await sleep(50); } await sleep(900);
  console.log("wheel out past limit: zoom", (await page.evaluate(() => (window as any).play.view.zoom)).toFixed(3), "zmin", zmin.toFixed(3));
  // wheel zoom in from orbit with the cursor on empty space beside the globe
  await setView(page, null, zmin); await sleep(500); const g0 = await page.evaluate(() => (window as any).play.view.geo);
  await page.mouse.move(150, 150); for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(60); } await sleep(1000);
  const g1 = await page.evaluate(() => (window as any).play.view.geo);
  console.log("wheel in with cursor off the globe: geo", JSON.stringify(g0), "->", JSON.stringify(g1), "zoom", (await page.evaluate(() => (window as any).play.view.zoom)).toFixed(2));
  // drag starting off the globe, and drag leaving the globe
  await setView(page, [16.11, 43.64], zmin); await sleep(500); const h0 = await page.evaluate(() => (window as any).play.view.geo);
  await page.mouse.move(150, 150); await page.mouse.down(); for (let i = 1; i <= 6; i++) { await page.mouse.move(150 + 40 * i, 150 + 20 * i, { steps: 2 }); await sleep(40); } await page.mouse.up(); await sleep(400);
  const h1 = await page.evaluate(() => (window as any).play.view.geo);
  console.log("drag starting off globe: geo", JSON.stringify(h0), "->", JSON.stringify(h1));
  await page.mouse.move(800, 500); await page.mouse.down(); const pos: string[] = [];
  for (let i = 1; i <= 10; i++) { await page.mouse.move(800 + 70 * i, 500, { steps: 2 }); await sleep(60); const g = await page.evaluate(() => (window as any).play.view.geo); pos.push(`${g.lon.toFixed(1)}`); } await page.mouse.up();
  console.log("drag across and off the globe (px 870..1500): lon trace", pos.join(" "));
});
