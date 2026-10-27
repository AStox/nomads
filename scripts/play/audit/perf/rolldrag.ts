// Real drags at orbit (button held), per frame: view.geo.hd and the angle the compass north is drawn at from screen up (the roll the operator sees), the grabbed ground's distance from the cursor and its step
// beyond the mouse's. One line per start latitude and press point: max |hd|, max |roll|, the largest grab distance and the largest step. SITE, PROFILE, VW, VH, LATS, OFFS (press point as a share of the planet's
// radius, on the side the drag comes from, or with OUT=1 on the side it goes to, so the drag leaves the planet), ZS, STEP (px a mouse step), N (steps each way), BACK=0 (no steps back), TRACE=1 (a line every fourth frame), DIRS (degrees; the drag's direction), LON.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/rolldrag.ts
import { launch, sleep, load } from "./lib";
const num = (k: string, d: string) => (process.env[k] ?? d).split(",").map(Number);
const LATS = num("LATS", "0,20,42,58,75,85,89.96"), OFFS = num("OFFS", "0,0.5,0.9"), DIRS = num("DIRS", "0,90,180,270"), ZS = num("ZS", "-5.5"), STEP = Number(process.env.STEP ?? 20), N = Number(process.env.N ?? 6), LON = Number(process.env.LON ?? 4.5);
const VW = Number(process.env.VW ?? 800), VH = Number(process.env.VH ?? 1000), BUDGET = Number(process.env.BUDGET ?? 225) * 1000;
const r = await launch({ profile: process.env.PROFILE, vw: VW, vh: VH });
const t0 = Date.now();
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 6; i++) { await sleep(200); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) break; } };
  await r.page.evaluate(() => {
    const w = window as any; w.__rec = null; w.__mouse = [0, 0];
    addEventListener("pointermove", (e) => { w.__mouse = [e.clientX, e.clientY]; }, true);
    const loop = () => {
      const R = w.__rec;
      if (R) {
        const P = w.play, L = P.live, A = R.A, s = L.screenOf(P.view, A.x, A.z, A.y, A.geo), g = P.view.geo, d = Math.abs(g.lat) > 80 ? 0.02 : 0.3;
        const c = L.screenOf(P.view, 0, 0, 0, { lat: g.lat, lon: g.lon }), n = L.screenOf(P.view, 0, 0, 0, { lat: g.lat - d, lon: g.lon });
        // north is the way from the south step to the target; screen up is -y
        const roll = (Math.atan2(c[0] - n[0], -(c[1] - n[1])) * 180) / Math.PI;
        R.f.push([s[0], s[1], w.__mouse[0], w.__mouse[1], g.hd ?? 0, roll]);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  let worstHd = 0, worstRoll = 0;
  outer: for (const z of ZS) for (const lat of LATS) {
    for (const off of OFFS) {
      let hd = 0, roll = 0, err = 0, step = 0, runs = 0;
      for (const dir of DIRS) {
        if (Date.now() - t0 > BUDGET) break outer;
        await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, LON, z);
        await idle();
        const disk = await r.page.evaluate(() => { const P = (window as any).play, L = P.live, cx = innerWidth / 2, cy = innerHeight / 2; let lo = 0, hi = innerHeight; for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (L.groundUnder(P.view, cx, cy + m)) lo = m; else hi = m; } return { cx, cy, R: lo }; });
        const a = (dir * Math.PI) / 180;
        const sg = process.env.OUT ? 1 : -1;
        let x = disk.cx + sg * off * disk.R * Math.cos(a), y = disk.cy + sg * off * disk.R * Math.sin(a);
        const ok = await r.page.evaluate((px: number, py: number) => !!(window as any).play.live.groundUnder((window as any).play.view, px, py), x, y);
        if (!ok) continue;
        await r.page.mouse.move(x, y); await sleep(120);
        await r.page.evaluate((px: number, py: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, px, py); (window as any).__rec = { A: { x: A.x, z: A.z, y: A.y, geo: A.geo }, f: [] }; }, x, y);
        await r.page.mouse.down();
        const dx = STEP * Math.cos(a), dy = STEP * Math.sin(a);
        for (let i = 0; i < N; i++) { x += dx; y += dy; await r.page.mouse.move(x, y); await sleep(100); }
        if (process.env.BACK !== "0") for (let i = 0; i < N; i++) { x -= dx; y -= dy; await r.page.mouse.move(x, y); await sleep(100); }
        await sleep(250); await r.page.mouse.up(); await sleep(60);
        const f: number[][] = await r.page.evaluate(() => { const R = (window as any).__rec; (window as any).__rec = null; return R.f; });
        runs++;
        if (process.env.TRACE) for (let i = 0; i < f.length; i += 4) console.log(`   dir${dir} f${i} mouse ${f[i][2].toFixed(0)},${f[i][3].toFixed(0)} grab ${f[i][0].toFixed(0)},${f[i][1].toFixed(0)} hd ${((f[i][4] * 180) / Math.PI).toFixed(1)} roll ${f[i][5].toFixed(1)}`);
        for (let i = 1; i < f.length; i++) {
          const ms = Math.hypot(f[i][2] - f[i - 1][2], f[i][3] - f[i - 1][3]), pv = Math.hypot(f[i][0] - f[i - 1][0], f[i][1] - f[i - 1][1]);
          step = Math.max(step, pv - ms); err = Math.max(err, Math.hypot(f[i][0] - f[i][2], f[i][1] - f[i][3]));
        }
        for (const q of f) { hd = Math.max(hd, Math.abs(q[4])); const rr = Math.abs(q[5]); roll = Math.max(roll, rr); }
        // the roll after release: held 1.5 s more, it must not have moved
        await sleep(1500);
        const after = await r.page.evaluate(() => (window as any).play.view.geo.hd ?? 0);
        if (Math.abs(after - f[f.length - 1][4]) > 1e-6 && Math.abs(lat) < 80) console.log(`  glide after release at ${lat}N: hd ${f[f.length - 1][4].toFixed(4)} -> ${after.toFixed(4)}`);
        await r.page.mouse.move(disk.cx, disk.cy);
      }
      worstHd = Math.max(worstHd, (hd * 180) / Math.PI); worstRoll = Math.max(worstRoll, roll);
      console.log(`${VW}x${VH} z${z} ${String(lat).padStart(5)}N off${off}  runs ${runs}  max|hd| ${((hd * 180) / Math.PI).toFixed(2)} deg  max|roll| ${roll.toFixed(2)} deg  grab err max ${err.toFixed(2)} px  step over mouse max ${step.toFixed(1)} px`);
    }
  }
  console.log(`worst hd ${worstHd.toFixed(2)} deg, worst roll ${worstRoll.toFixed(2)} deg`);
} finally { await r.close(); }
process.exit(0);
