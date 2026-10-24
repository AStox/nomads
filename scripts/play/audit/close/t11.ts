// screencast during an eastward pan: per frame the centre region's luminance spread (trees give texture, bare ground less), dips listed, the frames kept
import { withBrowser, go, PLACES, sleep, OUT, sharp } from "./lib.ts";
import { writeFileSync, mkdirSync } from "node:fs";
const place = process.env.PLACE ?? "A", z = Number(process.env.Z ?? 4), speed = Number(process.env.SPEED ?? 900), secs = Number(process.env.SECS ?? 20);
mkdirSync(`${OUT}/t11`, { recursive: true });
await withBrowser(async (page) => {
  await go(page, PLACES[place], z);
  const cdp = await page.createCDPSession();
  const frames: { t: number; b: Buffer }[] = [];
  cdp.on("Page.screencastFrame", async (e: any) => { frames.push({ t: e.metadata.timestamp, b: Buffer.from(e.data, "base64") }); try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {} });
  await page.evaluate(() => { (window as any).__sw = []; (window as any).play.live.debug.hold(false); });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 500, everyNthFrame: 1 });
  const sw: any[] = await page.evaluate(async (speed: number, secs: number) => {
    const P = (window as any).play, L = P.live, V = P.view, D = 180 / (Math.PI * 391100), out: any[] = [];
    let lon = V.geo.lon, lat = V.geo.lat, last = performance.now(), prev = L.stats.window?.id; const t0 = last;
    await new Promise<void>((done) => { const tick = () => { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; lon += speed * dt * D / Math.cos(lat * Math.PI / 180); V.geo = { lat, lon };
      const w = L.stats.window?.id; if (w !== prev) { out.push({ wall: Date.now() / 1000, id: w }); prev = w; }
      if (now - t0 > secs * 1000) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    return out;
  }, speed, secs);
  await cdp.send("Page.stopScreencast");
  console.log("screencast frames", frames.length, "window switches at wall time (s)", JSON.stringify(sw.map((s) => +(s.wall).toFixed(2))));
  // the spread of luminance in the centre 400x250 of each frame
  const rows: number[][] = [];
  for (let i = 0; i < frames.length; i++) { const { data, info } = await sharp(frames[i].b).extract({ left: 200, top: 120, width: 400, height: 250 }).greyscale().raw().toBuffer({ resolveWithObject: true }); let m = 0, s = 0; for (const v of data) m += v; m /= data.length; for (const v of data) s += (v - m) ** 2; rows.push([frames[i].t, m, Math.sqrt(s / data.length)]); }
  writeFileSync(`${OUT}/t11/rows.json`, JSON.stringify({ sw, rows }));
  for (const s of sw) {
    const near = rows.map((r, i) => [i, r[0] - s.wall, r[1], r[2]]).filter((r) => Math.abs(r[1]) < 1.2);
    console.log("switch", s.id, "frames within 1.2 s:", near.map((r) => `${r[1].toFixed(2)}:${r[3].toFixed(0)}`).join(" "));
    for (const r of near) if (Math.abs(r[1]) < 0.6) writeFileSync(`${OUT}/t11/sw${String(s.id).replace(/:/g, "_")}-${r[1].toFixed(2)}.jpg`, frames[r[0]].b);
  }
});
