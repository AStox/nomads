import { launch, sleep } from "./lib";
const site = process.argv[2];
for (let run = 0; run < 2; run++) {
  const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await sleep(9000);
    const s = await r.page.evaluate(() => { const P = (window as any).play, L = P.live, w = L.stats.window; return { x: P.view.x, z: P.view.z, geo: P.view.geo, up: P.view.up, lift: L.stats.lift, q: L.stats.q, win: w && { id: w.id, builds: w.builds, made: w.made, objects: w.objects, share: w.share, blocks: w.blocks }, log: (L.stats.objectLog ?? []).map((o: any) => `${o.id}:${o.objects}:${o.share}`), mode: L.mode, alpha: L.stats.ladderAlpha }; });
    console.log("run", run, JSON.stringify(s));
  } finally { await r.close(); }
}
process.exit(0);
