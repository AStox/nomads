// A drag with the button held keeps the ground it grabbed under the cursor: at places that broke it (a cube edge and corner, a window swap, a pole), the grabbed place's screen step per frame against the cursor's, and its
// distance from the cursor at the end. The place is the pick under the cursor before the button goes down, held by its planet place (live.groundUnder, screenOf). SITE, PROFILE, LIMIT (px at the end, default 8; a frame may step 8 times that), ONLY=EQ,PE
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/grab.ts
import { launch, sleep, load } from "./lib";
// name, lat, lon, zoom, legs of [dx, dy, steps] (20 px every 70 ms, a slow drag; the legs end where they began)
const CASES: [string, number, number, number, [number, number, number][]][] = [
  ["EQ -2", 13.27, 45, -2, [[-20, 0, 10], [20, 0, 20], [-20, 0, 10]]],
  ["EQ 1.5", 13.27, 45, 1.5, [[-20, 0, 10], [20, 0, 20], [-20, 0, 10]]],
  ["PE 0", 45, 0, 0, [[0, -20, 10], [0, 20, 20], [0, -20, 10]]],
  ["CO 0", 35.26, 45, 0, [[-20, -20, 10], [20, 20, 20], [-20, -20, 10]]],
  ["CS -2", -35.26, 135, -2, [[-20, 20, 10], [20, -20, 20], [-20, 20, 10]]],
  ["CS 1.5", -35.26, 135, 1.5, [[-20, 20, 10], [20, -20, 20], [-20, 20, 10]]],
  ["WS 2.76", 15.77, -7.44, 2.76, [[20, -10, 40]]],
  ["FS 2.46", 25.15, 29.98, 2.46, [[-20, 10, 40]]],
  ["CO 3", 35.26, 45, 3, [[-20, -20, 12]]],
  ["P83S -4", -83, 10, -4, [[0, -10, 8], [0, 10, 16], [0, -10, 8]]],
];
const LIMIT = Number(process.env.LIMIT ?? 8), only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
let bad = 0;
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(500); return; } } };
  await r.page.evaluate(() => {
    const w = window as any; w.__rec = null; w.__mouse = [0, 0];
    addEventListener("pointermove", (e) => { w.__mouse = [e.clientX, e.clientY]; }, true);
    const loop = () => {
      const R = w.__rec;
      if (R) { const P = w.play, A = R.A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo); R.f.push([s[0], s[1], w.__mouse[0], w.__mouse[1]]); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (const [name, lat, lon, z, legs] of CASES) {
    if (only.length && !only.includes(name.split(" ")[0])) continue;
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    let x = 640, y = 400;
    await r.page.mouse.move(x, y); await sleep(150);
    await r.page.evaluate((px: number, py: number) => { const P = (window as any).play, A = P.live.groundUnder(P.view, px, py); (window as any).__rec = { A: { x: A.x, z: A.z, y: A.y, geo: A.geo }, f: [] }; }, x, y);
    await r.page.mouse.down();
    for (const [dx, dy, n] of legs) for (let i = 0; i < n; i++) { x += dx; y += dy; await r.page.mouse.move(x, y); await sleep(70); }
    await sleep(300);
    await r.page.mouse.up();
    const f: number[][] = await r.page.evaluate(() => { const R = (window as any).__rec; (window as any).__rec = null; return R.f; });
    let jump = 0, err = 0;
    for (let i = 0; i < f.length; i++) {
      err = Math.max(err, Math.hypot(f[i][0] - f[i][2], f[i][1] - f[i][3]));
      if (i) jump = Math.max(jump, Math.hypot(f[i][0] - f[i - 1][0] - (f[i][2] - f[i - 1][2]), f[i][1] - f[i - 1][1] - (f[i][3] - f[i - 1][3])));
    }
    const end = f[f.length - 1], fin = Math.hypot(end[0] - end[2], end[1] - end[3]), ok = fin <= LIMIT && jump <= 8 * LIMIT;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(9)} frames ${f.length} worst step off the cursor ${jump.toFixed(1)} px, worst distance ${err.toFixed(1)} px, at the end ${fin.toFixed(1)} px`);
  }
} finally { await r.close(); }
process.exit(bad ? 1 : 0);
