import { session, sleep } from "./lib.ts";
const reps = Number(process.argv[2] ?? 1), gap = Number(process.argv[3] ?? 170), ticks = Number(process.argv[4] ?? 30);
await session([1600, 1000], "hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  await sleep(4000);
  for (let r = 0; r < reps; r++) {
    const log: string[] = []; let lostAt: string | null = null;
    const poll = async () => { const z = await page.evaluate(() => { const P = (window as any).play, L = P.live; return [P.view.zoom, L.renderer().gpu, L.stats.gpuMs, L.stats.workerMs, L.stats.ladderAlpha]; }); log.push(`${(z[0] as number).toFixed(2)}:${z[1] ? "ok" : "LOST"}:g${Math.round(z[2] as number)}`); if (!z[1] && !lostAt) lostAt = `zoom ${(z[0] as number).toFixed(2)} ladderAlpha ${z[4]}`; };
    await page.mouse.move(800, 500);
    for (let i = 0; i < ticks; i++) { await page.mouse.wheel({ deltaY: 100 }); await sleep(gap); await poll(); }
    await sleep(2500); await poll();
    console.log(`rep ${r} wheel out ${ticks} ticks every ${gap} ms (no screenshots):`, lostAt ?? "no loss", "|", log.join(" "));
    for (let i = 0; i < ticks; i++) { await page.mouse.wheel({ deltaY: -100 }); await sleep(gap); await poll(); }
    await sleep(2500); await poll(); console.log(`rep ${r} back in: last`, log.slice(-3).join(" "));
  }
});
