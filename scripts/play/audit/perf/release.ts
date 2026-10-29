// After a drag is released nothing was asked, so the picture must be at rest: per frame for a window after the release, the ground the drag held (picked under the cursor before the button went down, then screenOf), and the
// camera terms that could still move it (the target, hd, the lattice's turn, scale and q, the lift and the pyr). Real mouse (CDP): button down, STEPS moves of DX, DY every GAP ms, button up.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/release.ts      SITE, PROFILE, ONLY=A,B,E2, FAST=0 (slow drag), SECS (2), LIMIT (px of the held ground's shift after the release, default 1)
import { launch, sleep, load } from "./lib";
// name, lat, lon, zoom (the e2e tester's burstinertia cases and the cube edge)
const CASES: [string, number, number, number][] = [["B", -35.9, 43.59, 1.8], ["A", 4.35, -39.38, 0.5], ["E2", 13.27, 45, -1], ["Bz-1", -35.9, 43.59, -1], ["P", 45, 0, 0.5]];
const only = (process.env.ONLY ?? "").split(",").filter(Boolean), fast = process.env.FAST !== "0", SECS = Number(process.env.SECS ?? 2), LIMIT = Number(process.env.LIMIT ?? 1), TRACE = !!process.env.TRACE;
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
let bad = 0;
try {
  await load(r, "?hour=13&warm=0" + (process.env.QUERY ?? ""));
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  await r.page.evaluate(() => {
    const w = window as any; w.__rec = null; w.__mouse = [0, 0];
    addEventListener("pointermove", (e) => { w.__mouse = [e.clientX, e.clientY]; }, true);
    const loop = (t: number) => {
      const R = w.__rec;
      if (R) {
        const P = w.play, A = R.A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo), L = P.live.debug.lattice(P.view), st = P.live.stats, g = P.view.geo, I = st.liftInfo;
        R.f.push({ t, s, m: w.__mouse, lat: g.lat, lon: g.lon, hd: g.hd ?? 0, z: P.view.zoom, turn: L.turn, sc: L.sc, q: L.q, cover: L.cover, lift: st.lift, pyr: I?.pyr, up: P.view.up });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (const [name, lat, lon, z] of CASES) {
    if (only.length && !only.includes(name)) continue;
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    await r.page.mouse.move(500, 400); await sleep(150);
    await r.page.evaluate(() => { const w = window as any, P = w.play, A = P.live.groundUnder(P.view, 500, 400); w.__rec = { A: { x: A.x, z: A.z, y: A.y, geo: A.geo }, f: [] }; });
    await r.page.mouse.down();
    let x = 500, y = 400;
    for (let i = 0; i < 8; i++) { x += fast ? 40 : 5; y += fast ? 10 : 1; await r.page.mouse.move(x, y); await sleep(fast ? 12 : 70); }
    await r.page.mouse.up();
    const tUp = await r.page.evaluate(() => performance.now());
    await sleep(SECS * 1000);
    const f: any[] = await r.page.evaluate(() => { const R = (window as any).__rec; (window as any).__rec = null; return R.f; });
    const post = f.filter((e) => e.t >= tUp - 1000 / 60);
    const at = (ms: number) => post.find((e) => e.t - tUp >= ms) ?? post[post.length - 1];
    const p0 = post[0], pe = post[post.length - 1];
    const shift = (e: any) => Math.hypot(e.s[0] - p0.s[0], e.s[1] - p0.s[1]);
    let stepMax = 0;
    for (let i = 1; i < post.length; i++) stepMax = Math.max(stepMax, Math.hypot(post[i].s[0] - post[i - 1].s[0], post[i].s[1] - post[i - 1].s[1]));
    const fin = shift(pe), ok = fin <= LIMIT;
    if (!ok) bad++;
    const d = (k: string, sc = 1) => +((pe[k] - p0[k]) * sc).toFixed(4);
    console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(5)} z${z} held ground after release: shift at 50 ms ${shift(at(50)).toFixed(1)}, 150 ${shift(at(150)).toFixed(1)}, 500 ${shift(at(500)).toFixed(1)}, end ${fin.toFixed(1)} px, worst frame step ${stepMax.toFixed(1)}; ` +
      `cursor off the held ground at release ${Math.hypot(p0.s[0] - p0.m[0], p0.s[1] - p0.m[1]).toFixed(1)}; lat-turn ${d("turn", 180 / Math.PI)} deg, sc ${d("sc")}, hd ${d("hd", 180 / Math.PI)} deg, cover ${p0.cover}->${pe.cover}, lift ${d("lift")} m, pyr ${d("pyr")} m, target ${((pe.lat - p0.lat) * 111).toFixed(2)} ${((pe.lon - p0.lon) * 111).toFixed(2)} km, zoom ${d("z")}`);
    if (TRACE) for (const e of post.slice(0, 60)) console.log("  ", ((e.t - tUp)).toFixed(0).padStart(5), e.s.map((v: number) => v.toFixed(1)).join(","), "turn", (e.turn * 180 / Math.PI).toFixed(3), "sc", e.sc.toFixed(5), "hd", (e.hd * 180 / Math.PI).toFixed(3), "cov", e.cover.toFixed(3), "lift", e.lift?.toFixed?.(1), "pyr", e.pyr?.toFixed?.(1));
  }
} finally { await r.close(); }
process.exit(bad ? 1 : 0);
