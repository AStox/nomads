// a long real drag at a zoom, a frame every ~step; luma/detail/diff traces; frames kept
import { session, settle, setView, OUT, sleep, sharp, PLACES } from "./lib.ts";
import { writeFileSync, mkdirSync } from "node:fs";
const [place, zs, dxs, dys, nsteps, prewarm] = process.argv.slice(2); const z = Number(zs), DX = Number(dxs), DY = Number(dys), N = Number(nsteps ?? 24);
const geo = PLACES[place] ?? (place.split(",").map(Number) as [number, number]);
const dir = `${OUT}/pan-${place.replace(",", "_")}-z${z}`; mkdirSync(dir, { recursive: true });
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  if (prewarm === "1") { await setView(page, geo, 3.6); await settle(page, 12000); await sleep(2500); await settle(page, 8000); }
  await setView(page, geo, z); await settle(page, 8000); await sleep(1500);
  const rows: any[] = [];
  const grab = async (i: number) => {
    const png: Buffer = await page.screenshot({ type: "jpeg", quality: 85 }) as any; const f = `${dir}/${String(i).padStart(3, "0")}.jpg`; writeFileSync(f, png);
    const small = await sharp(png).resize(320, 200, { fit: "fill" }).removeAlpha().raw().toBuffer();
    let s = 0, e = 0; const lum = new Float32Array(64000); for (let k = 0; k < 64000; k++) lum[k] = 0.299 * small[k * 3] + 0.587 * small[k * 3 + 1] + 0.114 * small[k * 3 + 2];
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) { const v = lum[y * 320 + x]; s += v; if (x < 319) e += Math.abs(lum[y * 320 + x + 1] - v); if (y < 199) e += Math.abs(lum[(y + 1) * 320 + x] - v); }
    const st = await page.evaluate(() => { const L = (window as any).play.live; return { mode: L.mode, a: +(L.stats.ladderAlpha ?? 0).toFixed(2), t: L.stats.tiles, g: (window as any).play.view.geo }; });
    rows.push({ i, luma: +(s / 64000).toFixed(1), detail: +(e / 128000).toFixed(2), ...st });
  };
  await grab(0);
  const cx = 800, cy = 500; await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= N; i++) { await page.mouse.move(cx + DX * i / N, cy + DY * i / N, { steps: 2 }); await sleep(60); await grab(i); }
  await page.mouse.up();
  for (let i = N + 1; i <= N + 6; i++) { await sleep(400); await grab(i); }
  writeFileSync(`${dir}/rows.json`, JSON.stringify(rows));
  let prev: any = null; for (const r of rows) { const d = prev ? Math.abs(r.luma - prev.luma) : 0; console.log(r.i, r.luma, r.detail, r.mode, r.a, r.t, (r.g?.lat ?? NaN).toFixed(2), (r.g?.lon ?? NaN).toFixed(2), d > 4 ? "<<< JUMP " + d.toFixed(1) : ""); prev = r; }
});
