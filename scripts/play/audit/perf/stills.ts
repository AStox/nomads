// Stills of named spots at several zooms, each by the one call the page's scripts make (view.geo and camera.setZoom), in order, so a spot's later zooms are the same place at another zoom (e2e item 29: the lift after a
// zoom that is set). SPECS="D:-25.71,-40.51:-1;1;2.5 A:..." OUT=dir; compare two sites' dirs with scripts/play/e2e/cmpstills.ts.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/stills.ts     SITE, PROFILE, Q (page query, hour=17.3&warm=0)
import { launch, sleep, load } from "./lib";
import { mkdirSync } from "node:fs";
const OUT = process.env.OUT!, SPECS = (process.env.SPECS ?? "D:-25.71,-40.51:-1;1;2.5 A:4.35,-39.38:-1;1;2 B:-35.9,43.59:-1;1 R:12.02,83.89:1;2.5 E2:13.27,45:2").split(" ");
mkdirSync(OUT, { recursive: true });
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, `?${process.env.Q ?? "hour=17.3&warm=0"}`);
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(900); return; } } };
  for (const sp of SPECS) {
    const [n, c, zs] = sp.split(":"), [la, lo] = c.split(",").map(Number);
    for (const z of zs.split(";").map(Number)) {
      await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, la, lo, z);
      await idle();
      await r.page.screenshot({ path: `${OUT}/${n}_z${z}.png` });
      console.log(n, z, JSON.stringify(await r.page.evaluate(() => { const P = (window as any).play, L = P.live, a = L.debug.lattice(P.view); return { lift: L.stats.lift, pyr: L.stats.liftInfo?.pyr, sc: a.sc, turn: a.turn, hd: P.view.geo.hd ?? 0, geo: [P.view.geo.lat, P.view.geo.lon] }; })));
    }
  }
} finally { await r.close(); }
