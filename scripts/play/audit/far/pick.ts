import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
const SUMMITS: [number, number, number][] = [[16.11, 43.64, 5405], [5.06, 40.39, 5195], [6.91, 51.99, 5197], [15.34, 50.23, 5193], [-26.17, -36.17, 5229]];
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  // 1. round trip groundUnder -> screenOf over a grid at several zooms
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  for (const z of [zmin, -4, -3, -2, -1.6, -1, 0, 2]) {
    await setView(page, [10, 47], z); await settle(page, 5000); await sleep(300);
    const r = await page.evaluate(() => { const P = (window as any).play, L = P.live, v = P.view, out: any[] = []; let worst = 0, n = 0, miss = 0;
      for (let j = 1; j < 9; j++) for (let i = 1; i < 9; i++) { const sx = i * 160 - 80, sy = j * 100 - 50, g = L.groundUnder(v, sx, sy); if (!g) { miss++; continue; } const s = L.screenOf(v, g.x, g.z, g.y, g.geo), e = Math.hypot(s[0] - sx, s[1] - sy); worst = Math.max(worst, e); n++; if (e > 1) out.push([sx, sy, +e.toFixed(1)]); }
      return { n, miss, worst: +worst.toFixed(2), bad: out.slice(0, 5), lift: L.stats.lift }; });
    console.log("roundtrip z", z.toFixed(2), JSON.stringify(r));
  }
  // 2. summits' projected place against the drawn summit (overlay)
  for (const z of [-3, -2, -1.6]) {
    await setView(page, [11, 46], z); await settle(page, 6000); await sleep(500);
    const pts = await page.evaluate((S: any) => { const P = (window as any).play, L = P.live, v = P.view; return S.map(([la, lo, h]: number[]) => { const s = L.screenOf(v, 0, 0, 0, { lat: la, lon: lo }); return [s[0], s[1], h]; }); }, SUMMITS);
    const r = await shot(page, `pick-summits-z${z}`);
    const marks = pts.filter((p: number[]) => p[0] > 0 && p[0] < 1600 && p[1] > 0 && p[1] < 1000).map((p: number[]) => `<circle cx="${p[0]}" cy="${p[1]}" r="9" fill="none" stroke="#ff0030" stroke-width="2"/><line x1="${p[0] - 14}" y1="${p[1]}" x2="${p[0] + 14}" y2="${p[1]}" stroke="#ff0030"/><line x1="${p[0]}" y1="${p[1] - 14}" x2="${p[0]}" y2="${p[1] + 14}" stroke="#ff0030"/>`).join("");
    await sharp(r.png).composite([{ input: Buffer.from(`<svg width="1600" height="1000" xmlns="http://www.w3.org/2000/svg">${marks}</svg>`), left: 0, top: 0 }]).png().toFile(`${OUT}/pick-summits-z${z}-marked.png`);
    console.log("summit marks z", z, JSON.stringify(pts.map((p: number[]) => [Math.round(p[0]), Math.round(p[1])])));
  }
});
