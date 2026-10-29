// The lift at rest after a jump: view.geo = place, camera.setZoom(z), then every 250 ms the lift the last frame was drawn at (live.stats.lift) against the pyr the worker answered for the view (live.stats.liftInfo.pyr), which is
// the height of the point the camera turns about; at rest the two are one number (the drawn height at the target; with no window the lift is the pyr). PLACES=D:-25.71,-40.51;A:4.35,-39.38 ZOOMS=1,-1,2 SECS=8
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/liftrest.ts      SITE, PROFILE
import { launch, sleep, load } from "./lib";
const PL = (process.env.PLACES ?? "D:-25.71,-40.51;A:4.35,-39.38;B:-35.9,43.59;R:12.02,83.89").split(";").map((s) => { const [n, c] = s.split(":"); const [a, b] = c.split(",").map(Number); return [n, a, b] as [string, number, number]; });
const ZS = (process.env.ZOOMS ?? "1,-1,2").split(",").map(Number), SECS = Number(process.env.SECS ?? 8);
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  for (const [n, la, lo] of PL) for (const z of ZS) {
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, la, lo, z);
    const rows: string[] = [];
    for (let t = 0; t < SECS * 4; t++) {
      await sleep(250);
      const s = await r.page.evaluate(() => { const L = (window as any).play.live, I = L.stats.liftInfo; return [L.stats.lift, I?.pyr, I?.box]; });
      if (t % 4 === 3 || t === 0) rows.push(`${((t + 1) * 0.25).toFixed(2)}s lift ${s[0]?.toFixed(1)} pyr ${s[1]?.toFixed(1)}`);
    }
    const last = rows[rows.length - 1];
    console.log(`${n} z${z}: ${rows.join(" | ")}`);
    void last;
  }
} finally { await r.close(); }
