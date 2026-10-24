import { launch, sleep, take, summarize } from "./lib";
const site = process.env.SITE ?? "http://127.0.0.1:8231";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  for (const z of [9.2, 8.6, 7.5, 6]) {
    await r.page.evaluate((zz: number) => { const P = (window as any).play; P.view.geo = { lat: 16.11, lon: 43.64 }; P.camera.setZoom(zz); }, z);
    await sleep(6000); await take(r.page); await sleep(3000);
    const d = await take(r.page), s = summarize(d);
    const st = await r.page.evaluate(() => { const S = (window as any).play.live.stats; return [S.tilesMax, S.tilesCut, S.counts?.tilesDrawn, S.passes && Object.fromEntries(Object.entries(S.passes).map(([k, v]: any) => [k, +v.toFixed(1)]))]; });
    console.log(`D z ${z}: drawn ${st[2]} max ${st[0]} cut ${st[1]} gpu ${s.gpuMs.mean}/${s.gpuMs.p95} drawnHz ${s.gpuMs.n / 3} ${JSON.stringify(st[3])}`);
  }
} finally { await r.close(); }
process.exit(0);
