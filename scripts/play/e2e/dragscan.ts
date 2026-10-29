// dragscan.ts: slow real drags (5 px per 25 ms) at places x zooms; per animation frame the grabbed ground point's screen place against the mouse.
//   VP=1920x1080 lockf /tmp/nomads-gpu.lock bun dragscan.ts out.json   (env ZS=-2,-1,0,1,2.5  PLACES=B,A  DIRS=E,W,N,S  STEPS=40)
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const PL: Record<string, [number, number]> = { B: [-35.9, 43.59], A: [4.35, -39.38], R: [12.02, 83.89], H: [47.78, 38.63], M: [-26.17, -36.17], E2: [13.27, 45.0], D: [-25.71, -40.51] };
const DIR: Record<string, [number, number]> = { E: [5, 0], W: [-5, 0], N: [0, -5], S: [0, 5], NE: [4, -4], SW: [-4, 4] };
if (process.env.CUSTOM) { const [a, b] = process.env.CUSTOM.split(",").map(Number); PL.X = [a, b]; }
const [VW, VH] = (process.env.VP ?? "1280x800").split("x").map(Number);
const ZS = (process.env.ZS ?? "-2,-1,0,1,2.5").split(",").map(Number), PLACES = (process.env.PLACES ?? "B,A,R,H,M").split(","), DIRS = (process.env.DIRS ?? "E,N").split(","), STEPS = +(process.env.STEPS ?? 40);
const hour = process.env.HOUR ?? "13";
const out: any[] = [];
await launch([VW, VH], `hour=${hour}&warm=0`, async (page) => {
  const idle = idleWaiter(page, 500);
  await page.evaluate(() => { const w = window as any; w.__m = [0, 0]; addEventListener("mousemove", (e) => { w.__m = [e.clientX, e.clientY]; }, true); });
  for (const pl of PLACES) for (const z of ZS) for (const d of DIRS) {
    const [lat, lon] = PL[pl], [dx0, dy0] = DIR[d], dx = dx0 * +(process.env.SPD ?? 1), dy = dy0 * +(process.env.SPD ?? 1);
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    const cx = Math.round(VW / 2), cy = Math.round(VH / 2);
    await page.mouse.move(cx, cy); await sleep(150);
    const ok = await page.evaluate((x: number, y: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, x, y); (window as any).__A = A ? { x: A.x, z: A.z, y: A.y, geo: A.geo } : null; return !!A; }, cx, cy);
    if (!ok) { out.push({ pl, z, d, nopick: true }); continue; }
    await page.evaluate(() => {
      const w = window as any, P = w.play, L = P.live; w.__fr = []; w.__on = true;
      const f = () => { if (!w.__on) return; const A = w.__A; let s: any = null; try { s = L.screenOf(P.view, A.x, A.z, A.y, A.geo); } catch {} w.__fr.push([performance.now(), w.__m[0], w.__m[1], s ? s[0] : null, s ? s[1] : null, P.view.zoom]); requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    await page.mouse.down(); let px = cx, py = cy;
    for (let i = 0; i < STEPS; i++) { px += dx; py += dy; await page.mouse.move(px, py); await sleep(25); }
    await sleep(+(process.env.HOLD ?? 300)); const cut: number = await page.evaluate(() => (window as any).__fr.length); await page.mouse.up(); await sleep(700);
    const all: any[] = await page.evaluate(() => { const w = window as any; w.__on = false; return w.__fr; });
    const fr = all.slice(0, cut), rel = all.slice(cut);
    // jump = how far the grabbed point moved on screen beyond the mouse's own move between two frames (held phase only)
    let worst = 0, wi = -1, big = 0, offmax = 0; const dts: number[] = [];
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1], b = fr[i]; if (a[3] == null || b[3] == null) continue;
      const j = Math.hypot(b[3] - a[3] - (b[1] - a[1]), b[4] - a[4] - (b[2] - a[2]));
      if (j > worst) { worst = j; wi = i; } if (j > 20) big++;
      offmax = Math.max(offmax, Math.hypot(b[3] - b[1], b[4] - b[2])); dts.push(b[0] - a[0]);
    }
    // after release: how far the picture glides (the grabbed point against where it was at release)
    const r0 = fr[fr.length - 1]; let glide = 0, glideT = 0;
    for (const f of rel) if (r0 && f[3] != null && r0[3] != null) { const g = Math.hypot(f[3] - r0[3], f[4] - r0[4]); if (g > glide) { glide = g; glideT = f[0] - rel[0][0]; } }
    const row = { pl, z, d, frames: fr.length, maxJump: +worst.toFixed(1), at: wi, bigJumps: big, maxOff: +offmax.toFixed(1), maxDt: +Math.max(0, ...dts).toFixed(0), glidePx: +glide.toFixed(1), glideAtMs: +glideT.toFixed(0) };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(process.argv[2] ?? "dragscan.json", JSON.stringify(out));
  }
});
