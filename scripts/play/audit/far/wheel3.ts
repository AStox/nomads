import { session, settle, setView, sleep, sharp, OUT, PLACES } from "./lib.ts";
import { writeFileSync, mkdirSync } from "node:fs";
const place = process.argv[2] ?? "A", z0 = Number(process.argv[3] ?? 6), tag = process.argv[4] ?? "wheel3";
const geo = PLACES[place] ?? (place.split(",").map(Number) as [number, number]); const dir = `${OUT}/${tag}`; mkdirSync(dir, { recursive: true });
await session([1600, 1000], "hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  await setView(page, geo, z0); await settle(page, 10000); await sleep(3000); await settle(page, 8000);
  const rows: any[] = []; let prev: Buffer | null = null, n = 0, running = true;
  const grab = async () => {
    const png = await page.screenshot({ type: "jpeg", quality: 80 }) as Buffer; const z = await page.evaluate(() => { const P = (window as any).play; return [P.view.zoom, P.live.renderer().gpu]; });
    const small = await sharp(png).resize(320, 200, { fit: "fill" }).removeAlpha().raw().toBuffer(); let s = 0, e = 0, d = 0; const lum = new Float32Array(64000);
    for (let k = 0; k < 64000; k++) lum[k] = 0.299 * small[k * 3] + 0.587 * small[k * 3 + 1] + 0.114 * small[k * 3 + 2];
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) { const v = lum[y * 320 + x]; s += v; if (x < 319) e += Math.abs(lum[y * 320 + x + 1] - v); if (y < 199) e += Math.abs(lum[(y + 1) * 320 + x] - v); }
    if (prev) { for (let k = 0; k < small.length; k++) d += Math.abs(small[k] - prev[k]); d /= small.length; } prev = small;
    writeFileSync(`${dir}/${String(n).padStart(3, "0")}.jpg`, await sharp(png).resize(800).jpeg({ quality: 70 }).toBuffer());
    rows.push({ n: n++, zoom: +(z[0] as number).toFixed(2), gpu: z[1], luma: +(s / 64000).toFixed(1), detail: +(e / 128000).toFixed(2), diff: +d.toFixed(1) });
  };
  const lp = (async () => { while (running) await grab(); })();
  const wheel = async (dir: number, ticks: number, gap: number) => { await page.mouse.move(800, 500); for (let i = 0; i < ticks; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(gap); } };
  await sleep(500); await wheel(1, 22, 170); await sleep(3000); await wheel(-1, 22, 170); await sleep(3500);
  running = false; await lp; writeFileSync(`${dir}/rows.json`, JSON.stringify(rows));
  for (const r of rows) console.log(JSON.stringify(r));
});
