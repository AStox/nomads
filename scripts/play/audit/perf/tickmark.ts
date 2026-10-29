// One wheel tick at a held cursor, judged by the picture and nothing else: the ground the pick names under the cursor gets a magenta disc painted by the planet pass itself at that place (a site made by
// scripts/play/audit/mkmark.sh: the shader marks the pixels whose hit point is within a few px of it), so where the disc is drawn before and after the tick is where the picture draws that ground. No image
// matching, no scale assumption. `picture` is the disc's distance from the cursor after the tick (null: the ground is not drawn anywhere on the screen, hidden behind nearer relief or off it, as when the
// view has turned); `under` is the ground the worker's exact pick finds at the cursor after the tick against the pick before it, in metres and in px (the page's own answer is `api`, screenOf of the pick: it
// stays 0 where the picture turns, which is how e2e OPEN item 2 went unseen by the page's checks).
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/tickmark.ts     SITE (a mkmark.sh site), PROFILE, VIEW=-35.9034,43.5937 ZOOMS=1.5,-2 DIR=-1 (wheel deltaY sign: -1 in)
//   CURSORS=640,400;240,600;... (default: centre, near left and right, near edge, far left and right) ONLY=i,j (cursor numbers) SEQ=n (n ticks one after another, each judged from its own pick)
//   GAP=ms and TICKS=n (n ticks in a burst before the judging) R=disc radius in px (6) SHOTS=dir (keeps the pictures)
import { launch, sleep, load, sharp } from "./lib";
const [lat, lon] = (process.env.VIEW ?? "-35.9034,43.5937").split(",").map(Number), ZS = (process.env.ZOOMS ?? "1.5,-2").split(",").map(Number), DIR = Number(process.env.DIR ?? -1);
const CUR = (process.env.CURSORS ?? "640,400;240,600;1040,600;640,740;240,200;1040,200").split(";").map((s) => s.split(",").map(Number));
const only = (process.env.ONLY ?? "").split(",").filter(Boolean).map(Number), TICKS = Number(process.env.TICKS ?? 1), SEQ = Number(process.env.SEQ ?? 1), GAP = Number(process.env.GAP ?? 0), RPX = Number(process.env.R ?? 6), SHOTS = process.env.SHOTS;
async function disc(png: Buffer) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) { const i = (y * info.width + x) * 3; if (data[i] > 235 && data[i + 1] < 40 && data[i + 2] > 235) { n++; sx += x; sy += y; } }
  return n ? { n, x: sx / n + 0.5, y: sy / n + 0.5 } : { n: 0, x: NaN, y: NaN };
}
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  const mark = (v: number[]) => r.page.evaluate((a: number[]) => (window as any).play.live.debug.check({ op: "mark", v: a }), v);
  for (const Z of ZS) for (let ci = 0; ci < CUR.length; ci++) {
    if (only.length && !only.includes(ci)) continue;
    const [x, y] = CUR[ci];
    await mark([0, 0, 0, 0]);
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, Z);
    await idle();
    await r.page.mouse.move(x, y); await sleep(500);
    for (let k = 0; k < SEQ; k++) {
      const A = await r.page.evaluate((px: number, py: number) => { const w = window as any, P = w.play, L = P.live, a = L.groundUnder(P.view, px, py); if (!a) return null; w.__A = { x: a.x, z: a.z, y: a.y, geo: a.geo }; return { ...w.__A, z0: P.view.zoom, R: L.debug.look(P.view).radiusM, mpp: L.mPerPx(P.view) }; }, x, y);
      if (!A) { console.log(`z ${Z} cursor ${x},${y}: no ground`); break; }
      const la = (A.geo.lat * Math.PI) / 180, lo = (A.geo.lon * Math.PI) / 180, c = Math.cos(la);
      await mark([c * Math.cos(lo), c * Math.sin(lo), Math.sin(la), (RPX * A.mpp) / A.R]);
      await sleep(900);
      const s0 = (await r.page.screenshot({ type: "png" })) as Buffer, d0 = await disc(s0);
      for (let i = 0; i < TICKS; i++) { await r.page.mouse.wheel({ deltaY: DIR * 100 }); if (GAP) await sleep(GAP); }
      await idle(); await sleep(900);
      const s1 = (await r.page.screenshot({ type: "png" })) as Buffer, d1 = await disc(s1);
      const e = await r.page.evaluate((cx: number, cy: number) => {
        const w = window as any, P = w.play, L = P.live, A = w.__A, s = L.screenOf(P.view, A.x, A.z, A.y, A.geo), U = L.groundUnder(P.view, cx, cy);
        let under: any = null;
        if (U) {
          const R = L.debug.look(P.view).radiusM, D = Math.PI / 180, d = Math.hypot((U.geo.lat - A.geo.lat) * D * R, (U.geo.lon - A.geo.lon) * D * R * Math.cos(A.geo.lat * D)), s0 = L.screenOf(P.view, 0, 0, U.y, U.geo), dl = 100 / R / D;
          const se = L.screenOf(P.view, 0, 0, U.y, { lat: U.geo.lat, lon: U.geo.lon + dl / Math.cos(U.geo.lat * D) }), sn = L.screenOf(P.view, 0, 0, U.y, { lat: U.geo.lat + dl, lon: U.geo.lon });
          // the px of a metre of ground there: the root of the area a 100 m square covers
          const pxm = Math.sqrt(Math.abs((se[0] - s0[0]) * (sn[1] - s0[1]) - (se[1] - s0[1]) * (sn[0] - s0[0]))) / 100;
          under = { m: Math.round(d), px: +(d * pxm).toFixed(1), exact: !!L.stats.ground && L.stats.ground.y === U.y, uy: Math.round(U.y) };
        }
        return { z: P.view.zoom, api: Math.hypot(s[0] - cx, s[1] - cy), under };
      }, x, y);
      const dist = (a: { x: number; y: number }) => Math.hypot(a.x - x, a.y - y);
      if (SHOTS) { await sharp(s0).toFile(`${SHOTS}/m-${Z}-${ci}-${k}-a.png`); await sharp(s1).toFile(`${SHOTS}/m-${Z}-${ci}-${k}-b.png`); }
      console.log(JSON.stringify({ z: `${A.z0.toFixed(2)}>${e.z.toFixed(2)}`, cursor: `${x},${y}`, before: d0.n ? +dist(d0).toFixed(1) : null, picture: d1.n ? +dist(d1).toFixed(1) : null, discPx: d1.n, api: +e.api.toFixed(1), pickY: Math.round(A.y), under: e.under }));
    }
  }
  await mark([0, 0, 0, 0]);
} finally { await r.close(); }
