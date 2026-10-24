import { session, settle, setView, shot, OUT, sleep, PLACES } from "./lib.ts";
import { luma, box, ncc } from "./img.ts";
const places: Record<string, [number, number]> = JSON.parse(process.argv[2]); const zs = (process.argv[3] ?? "2.0").split(",").map(Number);
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  for (const [name, geo] of Object.entries(places)) for (const z of zs) {
    await setView(page, geo, z); await settle(page, 7000); await sleep(1500);
    const a = await shot(page, `t5-${name}-z${z}-tier5`);
    const st1 = await page.evaluate(() => { const L = (window as any).play.live; return { mode: L.mode, alpha: L.stats.ladderAlpha, win: !!L.stats.window }; });
    await setView(page, null, 3.6); await settle(page, 12000); await sleep(3000); await settle(page, 8000);
    await setView(page, null, z); await settle(page, 8000); await sleep(2500);
    const b = await shot(page, `t5-${name}-z${z}-fine`);
    const st2 = await page.evaluate(() => { const L = (window as any).play.live; return { mode: L.mode, alpha: L.stats.ladderAlpha, win: !!L.stats.window }; });
    const A = await luma(a.png), B = await luma(b.png), la = box(A, 6), lb = box(B, 6);
    let best = { dx: 0, dy: 0, c: -2 }; for (let dy = -24; dy <= 24; dy += 2) for (let dx = -24; dx <= 24; dx += 2) { const c = ncc(la, lb, [200, 200, 1400, 800], dx, dy); if (c > best.c) best = { dx, dy, c }; }
    const mean = (I: any) => I.d.reduce((s: number, v: number) => s + v, 0) / I.d.length;
    console.log(JSON.stringify({ name, z, st1, st2, lumaTier5: +mean(A).toFixed(1), lumaFine: +mean(B).toFixed(1), ncc0: +ncc(la, lb, [200, 200, 1400, 800], 0, 0).toFixed(3), best }));
  }
});
