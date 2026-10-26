// Real drags at orbit (zoom -5.3 to -5.7) from high latitudes: per frame, where the grabbed ground is drawn against the mouse, and how far the target moved. A step is the pivot's screen step beyond the mouse's
// (px; a ground held under the cursor steps by what the cursor does, more is a jump); a hop is the target's move in degrees of arc against what the mouse step asks (its px over the planet's px a degree). SITE, PROFILE, VW, VH, LATS, LONS, STEPS (px, per 100 ms), DIRS (degrees), OFFS
// (the press point's distance from the planet's centre as a share of its radius, on the side the drag comes from, or with OUT=1 on the side it goes to, so the cursor leaves the planet), ZS (zoom), N (mouse steps each way). Prints one line per drag and the worst at the end.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/orbitdrag.ts
import { writeFileSync } from "node:fs";
import { launch, sleep, load } from "./lib";
const num = (k: string, d: string) => (process.env[k] ?? d).split(",").map(Number);
const LATS = num("LATS", "42,58,75,85,89.96"), LONS = num("LONS", "-20,4.5,82"), STEPS = num("STEPS", "3,8,20"), DIRS = num("DIRS", "0,90,180,270"), OFFS = num("OFFS", "0,0.5,0.9"), ZS = num("ZS", "-5.5"), N = Number(process.env.N ?? 10);
const VW = Number(process.env.VW ?? 800), VH = Number(process.env.VH ?? 1000), BUDGET = Number(process.env.BUDGET ?? 225) * 1000;
const r = await launch({ profile: process.env.PROFILE, vw: VW, vh: VH });
const t0 = Date.now();
let worst = { step: 0, hop: 0, what: "" }, runs = 0;
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 6; i++) { await sleep(200); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) break; } };
  await r.page.evaluate(() => {
    const w = window as any; w.__rec = null; w.__mouse = [0, 0];
    addEventListener("pointermove", (e) => { w.__mouse = [e.clientX, e.clientY]; }, true);
    const loop = () => {
      const R = w.__rec;
      if (R) { const P = w.play, A = R.A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo), g = P.view.geo, c = P.live.screenOf(P.view, 0, 0, 0, R.C); R.f.push([s[0], s[1], w.__mouse[0], w.__mouse[1], g.lat, g.lon, performance.now(), c[0], c[1]]); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  outer: for (const z of ZS) for (const lat of LATS) for (const lon of LONS) {
    for (const off of OFFS) for (const dir of DIRS) for (const step of STEPS) {
      if (Date.now() - t0 > BUDGET) break outer;
      await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
      await idle();
      // the planet's centre and radius on the canvas: the pick under the centre, and the farthest pixel along the row that still picks
      const disk = await r.page.evaluate(() => { const P = (window as any).play, L = P.live, cx = L.stats.w ?? innerWidth / 2, cy = innerHeight / 2; let lo = 0, hi = innerHeight; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (L.groundUnder(P.view, innerWidth / 2, innerHeight / 2 + m)) lo = m; else hi = m; } return { cx: innerWidth / 2, cy: innerHeight / 2, R: lo }; });
      const a = (dir * Math.PI) / 180, sg = process.env.OUT ? 1 : -1, ox = sg * off * disk.R * Math.cos(a), oy = sg * off * disk.R * Math.sin(a);
      let x = disk.cx + ox, y = disk.cy + oy;
      const ok = await r.page.evaluate((px: number, py: number) => { const P = (window as any).play; const A = P.live.groundUnder(P.view, px, py); return !!A; }, x, y);
      if (!ok) continue;
      await r.page.mouse.move(x, y); await sleep(120);
      await r.page.evaluate((px: number, py: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, px, py); (window as any).__rec = { A: { x: A.x, z: A.z, y: A.y, geo: A.geo }, C: { lat: P.view.geo.lat, lon: P.view.geo.lon }, f: [] }; }, x, y);
      await r.page.mouse.down();
      const dx = step * Math.cos(a), dy = step * Math.sin(a);
      for (let i = 0; i < N; i++) { x += dx; y += dy; await r.page.mouse.move(x, y); await sleep(100); }
      for (let i = 0; i < N; i++) { x -= dx; y -= dy; await r.page.mouse.move(x, y); await sleep(100); }
      await sleep(250); await r.page.mouse.up(); await sleep(60);
      const f: number[][] = await r.page.evaluate(() => { const R = (window as any).__rec; (window as any).__rec = null; return R.f; });
      // degrees of arc the planet shows a px: the disk's radius is 90 degrees at the limb (a nadir view, so an arc a is R sin a px from the centre; at the centre a px is 1 / R rad)
      const degPx = (180 / Math.PI) / disk.R;
      let stepMax = 0, hopMax = 0, errMax = 0, at = 0, cMax = 0, cAt = 0;
      for (let i = 1; i < f.length; i++) {
        const ms = Math.hypot(f[i][2] - f[i - 1][2], f[i][3] - f[i - 1][3]), pv = Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]), js = Math.max(0, pv - ms);
        const la1 = (f[i - 1][4] * Math.PI) / 180, la2 = (f[i][4] * Math.PI) / 180, dl = ((f[i][5] - f[i - 1][5]) * Math.PI) / 180;
        const arc = (Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(dl))) * 180) / Math.PI;
        const hop = Math.max(0, arc - ms * degPx * 1.5 - 0.02);
        const cs = f[i][7] > -1e8 && f[i - 1][7] > -1e8 ? Math.hypot(f[i][7] - f[i - 1][7], f[i][8] - f[i - 1][8]) : 0;
        if (cs > cMax) { cMax = cs; cAt = i; }
        if (js > stepMax) { stepMax = js; at = i; }
        hopMax = Math.max(hopMax, hop);
        errMax = Math.max(errMax, Math.hypot(f[i][0] - f[i][2], f[i][1] - f[i][3]));
      }
      const end = f[f.length - 1], fin = Math.hypot(end[0] - end[2], end[1] - end[3]);
      runs++;
      if (process.env.RAW) writeFileSync(`${process.env.RAW}-${lat}-${lon}-${off}-${dir}-${step}.json`, JSON.stringify({ disk, f }));
      const what = `z${z} ${lat}N ${lon}E off${off} dir${dir} step${step}`;
      if (cMax > worst.step) worst = { ...worst, step: cMax, what };
      console.log(`${what.padEnd(34)} frames ${f.length} worst ground step over the mouse's ${stepMax.toFixed(1)} px (frame ${at}, view ${f[at][4].toFixed(2)} ${f[at][5].toFixed(1)}), worst hop ${hopMax.toFixed(2)} deg, worst distance ${errMax.toFixed(0)} px, the first target's place stepped ${cMax.toFixed(0)} px for the mouse's ${Math.hypot(f[Math.max(1, cAt)][2] - f[Math.max(1, cAt) - 1][2], f[Math.max(1, cAt)][3] - f[Math.max(1, cAt) - 1][3]).toFixed(0)}, end ${fin.toFixed(1)} px`);
      await r.page.mouse.move(disk.cx, disk.cy);
    }
  }
} finally { await r.close(); }
console.log(`runs ${runs}, largest step of the first target's place ${worst.step.toFixed(1)} px at ${worst.what}`);
process.exit(0);
