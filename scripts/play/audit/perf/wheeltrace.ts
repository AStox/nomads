// A continuous wheel zoom at a held cursor, the page's own numbers every frame: zoom, the target, the lattice's turn and sc and its cover, the lift, where the ground picked under the cursor at the start is drawn (screenOf at the
// height the worker answers for it) and the exact pick under the cursor. CURSOR=640,400 Z0=1.5 TICKS=12 GAP=150 VIEW=lat,lon   lockf ... bun wheeltrace.ts     SITE PROFILE
import { launch, sleep, load } from "./lib";
const [lat, lon] = (process.env.VIEW ?? "-35.9034,43.5937").split(",").map(Number), Z0 = Number(process.env.Z0 ?? 1.5), [cx, cy] = (process.env.CURSOR ?? "640,400").split(",").map(Number), TICKS = Number(process.env.TICKS ?? 12), GAP = Number(process.env.GAP ?? 150);
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, Z0);
  await idle(); await r.page.mouse.move(cx, cy); await sleep(500);
  await r.page.evaluate((px: number, py: number) => {
    const w = window as any, P = w.play, L = P.live, a = L.groundUnder(P.view, px, py); w.__A = a; w.__tr = []; const t0 = performance.now();
    const f = () => { const A = w.__A, v = P.view, la = L.debug.lattice(v), U = L.groundUnder(v, px, py), s = L.screenOf(v, A.x, A.z, A.y, A.geo), ad = P.camera.anchorDiag, sa = ad && L.screenOf(v, ad.A.x, ad.A.z, ad.A.y, ad.A.geo);
      const R = L.debug.look(v).radiusM, D = Math.PI / 180, dm = U ? Math.hypot((U.geo.lat - A.geo.lat) * D * R, (U.geo.lon - A.geo.lon) * D * R * Math.cos(A.geo.lat * D)) : null;
      w.__tr.push([Math.round(performance.now() - t0), +v.zoom.toFixed(2), +v.geo.lat.toFixed(4), +v.geo.lon.toFixed(4), +la.turn.toFixed(3), +la.sc.toFixed(4), +la.cover.toFixed(2), la.face, Math.round(L.stats.lift ?? 0), Math.round(Math.hypot(s[0] - px, s[1] - py)), ad ? Math.round(Math.hypot(sa[0] - px, sa[1] - py)) : -1, dm == null ? null : Math.round(dm), ad ? Math.round(ad.A.y) : null, Math.round(A.y)]); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }, cx, cy);
  for (let i = 0; i < TICKS; i++) { await r.page.mouse.wheel({ deltaY: -100 }); await sleep(GAP); }
  await sleep(1500);
  const tr: number[][] = await r.page.evaluate(() => (window as any).__tr);
  console.log("ms zoom lat lon turn sc cover face lift apiOldY anchorApi underFromA(m) anchorY pickY");
  for (let i = 0; i < tr.length; i += 6) console.log(tr[i].join(" "));
} finally { await r.close(); }
