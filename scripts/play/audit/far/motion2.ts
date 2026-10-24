import { session, settle, setView, shot, OUT, PLACES, sleep } from "./lib.ts";
import { luma, box, sub, ncc, bestShift, busiest } from "./img.ts";
import { writeFileSync } from "node:fs";
// cases: place:zoom:dx:dy ...
const vp = (process.argv[2] ?? "1600x1000").split("x").map(Number) as [number, number];
const cases = process.argv.slice(3).map((s) => s.split(":"));
await session(vp, "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  for (const [place, zs, dxs, dys] of cases) {
    const zoom = Number(zs), DX = Number(dxs), DY = Number(dys), tag = `mo-${place}-z${zoom}-${vp[0]}x${vp[1]}`;
    const geo = PLACES[place] ?? place.split(",").map(Number) as [number, number];
    if (process.env.PREWARM) { await setView(page, geo, 3.6); await settle(page, 12000); await sleep(5000); await settle(page, 8000); }
    await setView(page, geo, zoom); await settle(page, 7000); await sleep(process.env.PREWARM ? 3000 : 600);
    const a = await shot(page, `${tag}-A`);
    const cx = vp[0] / 2, cy = vp[1] / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    const N = 10; for (let i = 1; i <= N; i++) { await page.mouse.move(cx + DX * i / N, cy + DY * i / N); await sleep(25); }
    await page.mouse.up(); await sleep(900); await settle(page, 5000); await sleep(400);
    const b = await shot(page, `${tag}-B`);
    const A = await luma(a.png), B = await luma(b.png);
    const lowA = box(A, 6), lowB = box(B, 6), full: [number, number, number, number] = [60, 60, A.w - 60, A.h - 120];
    let gr = { dx: DX, dy: DY, c: -2 }; for (let dy = DY - 6; dy <= DY + 6; dy++) for (let dx = DX - 6; dx <= DX + 6; dx++) { const c = ncc(lowA, lowB, [200, 200, 1400, 800], dx, dy); if (c > gr.c) gr = { dx, dy, c }; }
    const hpA = sub(A, box(A, 3)), hpB = sub(B, box(B, 3));
    const reg = busiest(hpA, 300, 260);
    const c0 = ncc(hpA, hpB, reg, 0, 0), cg = ncc(hpA, hpB, reg, gr.dx, gr.dy);
    const res = { tag, drag: [DX, DY], groundShift: gr, region: reg, hpCorr_at_zero: +c0.toFixed(3), hpCorr_at_ground: +cg.toFixed(3) };
    console.log(JSON.stringify(res)); writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(res));
  }
});
