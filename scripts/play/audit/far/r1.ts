import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
import { luma } from "./img.ts";
const SUMMITS: [number, number, number][] = [[16.11, 43.64, 5405], [5.06, 40.39, 5195], [6.91, 51.99, 5197], [15.34, 50.23, 5193], [-26.17, -36.17, 5229]];
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  // 1 roundtrip
  for (const z of [zmin, -4, -3, -2, -1.6, -1, 0, 2]) {
    await setView(page, [10, 47], z); await settle(page, 5000); await sleep(300);
    const r = await page.evaluate(() => { const P = (window as any).play, L = P.live, v = P.view, out: any[] = []; let worst = 0, n = 0, miss = 0;
      for (let j = 1; j < 9; j++) for (let i = 1; i < 9; i++) { const sx = i * 160 - 80, sy = j * 100 - 50, g = L.groundUnder(v, sx, sy); if (!g) { miss++; continue; } const s = L.screenOf(v, g.x, g.z, g.y, g.geo), e = Math.hypot(s[0] - sx, s[1] - sy); worst = Math.max(worst, e); n++; if (e > 1) out.push([sx, sy, +e.toFixed(1)]); }
      return { n, miss, worst: +worst.toFixed(2), bad: out.slice(0, 4), lift: L.stats.lift }; });
    console.log("roundtrip z", z.toFixed(2), JSON.stringify(r));
  }
  // 2 summit overlay
  for (const z of [-3, -2, -1.6]) {
    await setView(page, [11, 46], z); await settle(page, 6000); await sleep(500);
    const pts = await page.evaluate((S: any) => { const P = (window as any).play, L = P.live, v = P.view; return S.map(([la, lo, h]: number[]) => { const s = L.screenOf(v, 0, 0, 0, { lat: la, lon: lo }); return [s[0], s[1], h]; }); }, SUMMITS);
    const r = await shot(page, `pick-summits-z${z}`);
    const marks = pts.filter((p: number[]) => p[0] > 0 && p[0] < 1600 && p[1] > 0 && p[1] < 1000).map((p: number[]) => `<circle cx="${p[0]}" cy="${p[1]}" r="9" fill="none" stroke="#ff0030" stroke-width="2"/><line x1="${p[0] - 14}" y1="${p[1]}" x2="${p[0] + 14}" y2="${p[1]}" stroke="#ff0030"/><line x1="${p[0]}" y1="${p[1] - 14}" x2="${p[0]}" y2="${p[1] + 14}" stroke="#ff0030"/>`).join("");
    await sharp(r.png).composite([{ input: Buffer.from(`<svg width="1600" height="1000" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`), left: 0, top: 0 }]).png().toFile(`${OUT}/pick-summits-z${z}-marked.png`);
    console.log("summit marks z", z, JSON.stringify(pts.map((p: number[]) => [Math.round(p[0]), Math.round(p[1])])));
  }
  // 3 shimmer: a still camera, frames 150 ms apart
  for (const z of [zmin, -3, -1, 0, 2]) {
    await setView(page, [16.11, 43.64], z); await settle(page, 6000); await sleep(800);
    const ims = []; for (let i = 0; i < 6; i++) { const r = await page.screenshot({ type: "png" }); ims.push(await luma(r as Buffer)); await sleep(150); }
    const fr: number[] = []; for (let i = 1; i < ims.length; i++) { let c = 0; const a = ims[i - 1].d, b = ims[i].d; for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - b[k]) > 6) c++; fr.push(+(c / a.length * 100).toFixed(3)); }
    console.log("shimmer z", z.toFixed(2), "% pixels changed between still frames:", fr.join(" "));
  }
  // 4 wheel anchor: the ground under the cursor stays under it
  for (const [z, cx, cy, ticks] of [[-2.5, 1100, 300, -4], [zmin, 880, 430, -5], [-4, 700, 600, -3], [-1, 400, 350, -3]] as number[][]) {
    await setView(page, [16.11, 43.64], z); await settle(page, 5000); await sleep(400);
    const g0 = await page.evaluate((x: number, y: number) => { const P = (window as any).play; const g = P.live.groundUnder(P.view, x, y); return g && g.geo; }, cx, cy);
    await page.mouse.move(cx, cy);
    for (let i = 0; i < Math.abs(ticks); i++) { await page.mouse.wheel({ deltaY: ticks > 0 ? 100 : -100 }); await sleep(50); }
    await sleep(900); await settle(page, 5000); await sleep(300);
    const o = await page.evaluate((x: number, y: number, g0: any) => { const P = (window as any).play, L = P.live, v = P.view; const s = L.screenOf(v, 0, 0, 0, g0); return { zoom: v.zoom, atCursorNow: s, geoNow: L.groundUnder(v, x, y)?.geo }; }, cx, cy, g0);
    console.log("wheel anchor z0", z.toFixed(2), "cursor", cx, cy, "g0", JSON.stringify(g0), "->", JSON.stringify(o), "px err", g0 && o.atCursorNow ? Math.hypot(o.atCursorNow[0] - cx, o.atCursorNow[1] - cy).toFixed(1) : "n/a");
  }
  // 5 resize
  for (const [w, h] of [[800, 600], [1280, 720], [600, 1000], [2560, 1000]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 }); await sleep(800);
    const zm = await page.evaluate(() => (window as any).play.live.zmin); await setView(page, [16.11, 43.64], zm); await settle(page, 6000); await sleep(600);
    const r = await shot(page, `resize-${w}x${h}-zmin`); console.log("resize", w, h, "zmin", zm.toFixed(2), r.f);
  }
});
