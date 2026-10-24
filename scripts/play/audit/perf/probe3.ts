import { launch, sleep } from "./lib";
const site = process.argv[2];
for (let run = 0; run < 4; run++) {
  const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await sleep(9000);
    const s = await r.page.evaluate(() => { const P = (window as any).play, L = P.live; return { slots: L.stats.slots, level: L.level && { L: L.level.L, s: L.level.s }, counts: L.stats.counts, parts: L.lastParts, tiles: L.stats.tiles, passes: L.stats.passes && Object.keys(L.stats.passes).length }; });
    console.log("run", run, JSON.stringify(s).slice(0, 400));
  } finally { await r.close(); }
}
process.exit(0);
