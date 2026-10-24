// where does the window ask loop thrash? zoom scan at an ocean place and a forest place: frames done per second and ground messages in 4 s, per window size
//   lockf ... bun band.ts --vp=1600x1000 --tag=band1
import { launch, load, take, sleep, save, summarize, SITE } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const vp = (args.vp ?? "1600x1000").split("x").map(Number), tag = args.tag ?? "band";
const OCEAN = [[25.77, -45.48], [-48.77, 145.55], [34.06, 10.52], [-17.66, 129.3], [44.48, -13.6], [-45.8, -138.7], [49.4, -66.3], [35.0, -8.5], [-16.9, 96.2], [55.6, 122.6]];
const zs = (args.zooms ?? "2.6,2.8,3.0,3.2,3.4,3.6,3.8,4.0,4.4").split(",").map(Number);
const r = await launch({ vw: vp[0], vh: vp[1], profile: "/tmp/globe-fix-lead/chrome" });
const out: any = { vp, rows: [] };
const t0 = Date.now();
try {
  if (args.site) { await r.page.goto(`${args.site}/play/?hour=13&abl=${args.abl ?? ""}`, { waitUntil: "domcontentloaded" }); await r.page.waitForSelector("body.ready", { timeout: 120000 }); } else await load(r, "?hour=13");
  await sleep(500);
  let i = 0;
  for (const z of zs) {
    if (Date.now() - t0 > 225000) break;
    const g = OCEAN[i++ % OCEAN.length];
    await r.page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: 10, lon: 10 }; P.camera.setZoom(1); }); await sleep(1500);
    await take(r.page);
    const tj = await r.page.evaluate((gg: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: gg[0], lon: gg[1] }; P.camera.setZoom(zz); return performance.now(); }, g, z);
    await sleep(5000);
    const d = await take(r.page);
    const late = d.frames.filter((x: any) => x[0] > tj + 3000), nGround = d.msgs.filter((m: any) => m[1] === "ground").length;
    const ext = await r.page.evaluate(() => { const P = (window as any).play; return { mode: P.live.mode }; });
    const row = { z, at: g, framesLate: +(late.length / 2).toFixed(1), groundMsgs: nGround, mode: ext.mode, lagMax: Math.max(0, ...d.wlag.map((x: any) => x.ms)), lagN: d.wlag.length };
    out.rows.push(row);
    console.log(`${vp.join("x")} z ${z}: done in last 2 s ${row.framesLate}Hz, ground msgs in 5 s ${nGround}, worker stalls ${row.lagN} (max ${Math.round(row.lagMax)} ms) mode ${row.mode}`);
  }
} finally { save(tag, out); await r.close(); }
process.exit(0);
