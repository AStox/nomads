// Stills of the forest's edge on one build: SITE tag outDir, PLACES="name:lat,lon:zoom;..." (default A, B and the home island at zoom 4, 5, 6). The ground is held (sim paused, sprites on) and each still is
// the page's own canvas, which scripts/play/audit/perf/edgestat.ts then measures.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/edgestills.ts http://127.0.0.1:8390 new /tmp/globe-fix-lead3/j-scratch/new
import { mkdirSync } from "node:fs";
import { launch, settleTo, sleep } from "./lib";
const [site, tag, out] = process.argv.slice(2);
const def = ["A:4.35,-39.38", "B:-5.38,73.13", "H:47.81,38.63"].flatMap((p) => [4, 5, 6].map((z) => `${p}:${z}`)).join(";");
const places = (process.env.PLACES ?? def).split(";").map((s) => { const [n, g, z] = s.split(":"); return [n, g.split(",").map(Number), +z] as [string, number[], number]; });
mkdirSync(out, { recursive: true });
const r = await launch({ profile: process.env.PROFILE ?? "/tmp/globe-fix-lead3/j-chrome" });
try {
  await r.page.goto(`${site}/play/${process.env.QUERY ?? "?hour=13&warm=0"}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  for (const [name, geo, z] of places) {
    const st = await settleTo(r.page, geo, z, 30000);
    await r.page.evaluate(() => (window as any).play.live.debug.hold(true));
    await sleep(1500);
    await r.page.screenshot({ path: `${out}/${tag}-${name}-z${z}.png`, type: "png" });
    await r.page.evaluate(() => (window as any).play.live.debug.hold(false));
    console.log(name, z, JSON.stringify(st), "errors", r.errs.length);
  }
} finally { await r.close(); }
process.exit(0);
