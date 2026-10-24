// per-frame sprite counts while panning east: dips at window switches
import { withBrowser, go, idle, PLACES, sleep, OUT } from "./lib.ts";
import { writeFileSync } from "node:fs";
const place = process.env.PLACE ?? "A", z = Number(process.env.Z ?? 4), speed = Number(process.env.SPEED ?? 900), secs = Number(process.env.SECS ?? 22), dir = process.env.DIR ?? "E";
await withBrowser(async (page) => {
  await go(page, PLACES[place], z);
  await page.evaluate(() => (window as any).play.live.debug.hold(false));
  const log: any[] = await page.evaluate(async (speed: number, secs: number, dir: string) => {
    const P = (window as any).play, L = P.live, V = P.view, D = 180 / (Math.PI * 391100), out: any[] = [];
    let lon = V.geo.lon, lat = V.geo.lat, last = performance.now(); const t0 = last;
    await new Promise<void>((done) => { const tick = () => { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (dir === "E") lon += speed * dt * D / Math.cos(lat * Math.PI / 180); else if (dir === "S") lat -= speed * dt * D; else if (dir === "N") lat += speed * dt * D; else lon -= speed * dt * D / Math.cos(lat * Math.PI / 180);
      V.geo = { lat, lon };
      const c = L.stats.counts; out.push([Math.round(now - t0), c?.sprites ?? -1, c?.points ?? -1, L.stats.window?.id ?? "", Math.round(V.x), Math.round(V.z), L.stats.ladderAlpha ?? 0, L.mode]);
      if (now - t0 > secs * 1000) done(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
    return out;
  }, speed, secs, dir);
  writeFileSync(`${OUT}/t9-${place}-${z}-${dir}.json`, JSON.stringify(log));
  // dips: windows of frames where sprites fall under 60% of the median of the 30 frames before
  let prevWin = "", dip: any = null; const med = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (let i = 30; i < log.length; i++) {
    const m = med(log.slice(i - 30, i).map((r) => r[1])), r = log[i];
    if (r[3] !== prevWin) { console.log(`t${r[0]} window ${prevWin} -> ${r[3]} sprites ${r[1]} (median before ${m}) view plane (${r[4]},${r[5]}) mode ${r[7]} alpha ${r[6]}`); prevWin = r[3]; }
    if (m > 2000 && r[1] < 0.6 * m) { if (!dip) dip = { t0: r[0], min: r[1], n: 0 }; dip.n++; dip.min = Math.min(dip.min, r[1]); } else if (dip) { console.log(`  dip from t${dip.t0}: ${dip.n} frames, lowest ${dip.min} of ${m}`); dip = null; }
  }
  console.log("frames", log.length);
});
