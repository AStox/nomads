// drag the ground by a known screen amount; compare where fine texture and coarse features moved
import { session, settle, setView, shot, OUT, PLACES, sleep } from "./lib.ts";
import { luma, box, sub, ncc, bestShift, busiest } from "./img.ts";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const place = args[0] ?? "A", zoom = Number(args[1] ?? 0), DX = Number(args[2] ?? -60), DY = Number(args[3] ?? 0), vp = (args[4] ?? "1600x1000").split("x").map(Number) as [number, number];
const tag = `mo-${place}-z${zoom}-${vp[0]}x${vp[1]}`;
await session(vp, "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const geo = PLACES[place] ?? null;
  await setView(page, geo, zoom); await settle(page, 9000); await sleep(800);
  const a = await shot(page, `${tag}-A`);
  const cx = vp[0] / 2, cy = vp[1] / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  const N = 12; for (let i = 1; i <= N; i++) { await page.mouse.move(cx + DX * i / N, cy + DY * i / N); await sleep(30); }
  await page.mouse.up(); await sleep(1200); await settle(page, 6000); await sleep(500);
  const b = await shot(page, `${tag}-B`);
  const A = await luma(a.png), B = await luma(b.png);
  const lowA = box(A, 6), lowB = box(B, 6);
  const full: [number, number, number, number] = [60, 60, A.w - 60, A.h - 120];
  const g = bestShift(lowA, lowB, full, Math.ceil(Math.abs(DX) + Math.abs(DY)) + 20, 2);
  // refine around g at 1 px
  let gr = g; for (let dy = g.dy - 2; dy <= g.dy + 2; dy++) for (let dx = g.dx - 2; dx <= g.dx + 2; dx++) { const c = ncc(lowA, lowB, full, dx, dy); if (c > gr.c) gr = { dx, dy, c }; }
  const hpA = sub(A, box(A, 3)), hpB = sub(B, box(B, 3));
  const reg = busiest(hpA, 300, 260);
  const c0 = ncc(hpA, hpB, reg, 0, 0), cg = ncc(hpA, hpB, reg, gr.dx, gr.dy), cd = ncc(hpA, hpB, reg, DX, DY);
  const hb = bestShift(hpA, hpB, reg, Math.ceil(Math.abs(DX) + Math.abs(DY)) + 10, 1);
  const res = { tag, drag: [DX, DY], groundShift: gr, region: reg, hpCorr_at_zero: +c0.toFixed(3), hpCorr_at_ground: +cg.toFixed(3), hpCorr_at_drag: +cd.toFixed(3), hpBest: hb };
  console.log(JSON.stringify(res));
  writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(res));
});
