// A wheel burst at a held cursor right after a drag is released (the e2e tester's burstinertia.ts with a per-frame record): the ground picked under the cursor when the burst starts, where it is drawn each frame against the
// cursor, with the zoom, the window's mode and cover and the target. DELAY (ms after the release, default 0), TICKS, GAP (ms between ticks), DIR (1 out, -1 in), ONLY=A,B,E2, REPS (each case that many times: a window arriving during the zoom makes it a race), TRACE=1 prints the frames.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/burst.ts      SITE, PROFILE, QUERY (added to the page's query)
import { launch, sleep, load } from "./lib";
const CASES: [string, number, number, number, number][] = [["A", 4.35, -39.38, 0.5, -1], ["E2", 13.27, 45, -1, -1], ["B", -35.9, 43.59, 1.8, 1]];
const only = (process.env.ONLY ?? "").split(",").filter(Boolean), DELAY = Number(process.env.DELAY ?? 0), TICKS = Number(process.env.TICKS ?? 6), GAP = Number(process.env.GAP ?? 60), TRACE = !!process.env.TRACE, REPS = Number(process.env.REPS ?? 1), SX = Number(process.env.STEPX ?? 40), SY = SX / 4;
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
let bad = 0;
try {
  await load(r, "?hour=13&warm=0" + (process.env.QUERY ?? ""));
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  await r.page.evaluate(() => {
    const w = window as any; w.__rec = null;
    const loop = (t: number) => {
      const R = w.__rec;
      if (R && R.A) {
        const P = w.play, A = R.A, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo), L = P.live.debug.lattice(P.view), g = P.view.geo;
        R.f.push({ t, s, z: P.view.zoom, mode: L.mode, cover: L.cover, turn: L.turn, holding: P.camera.holding, ay: P.camera.anchorDiag?.A.y, lat: g.lat, lon: g.lon, lift: P.live.stats.lift });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (const [name, lat, lon, z, dir] of CASES.flatMap((c) => Array.from({ length: REPS }, () => c))) {
    if (only.length && !only.includes(name)) continue;
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    await r.page.mouse.move(500, 400); await r.page.mouse.down();
    for (let i = 0; i < 8; i++) { await r.page.mouse.move(500 + (i + 1) * SX, 400 + (i + 1) * SY); await sleep(12); }
    await r.page.mouse.up();
    await sleep(DELAY);
    const cx = 500 + 8 * SX, cy = 400 + 8 * SY;
    const pick = await r.page.evaluate((x: number, y: number) => { const w = window as any, P = w.play, G = P.live.stats.ground, A = P.live.groundUnder(P.view, x, y), v = P.view, g = v.geo; w.__rec = { A: { x: A.x, z: A.z, y: A.y, geo: A.geo }, f: [], t0: performance.now() }; return { y: A.y, answer: G?.at?.map((q: number) => +q.toFixed(1)), sigNow: `${g.lat}|${g.lon}|${g.hd ?? 0}|${v.zoom}|${v.bearing ?? 0}|${v.up || 0}`, sig: G?.sig, lift: P.live.stats.lift }; }, cx, cy);
    if (process.env.PICK) console.log("pick", JSON.stringify(pick));
    for (let i = 0; i < TICKS; i++) { await r.page.mouse.wheel({ deltaY: dir * 100 }); await sleep(GAP); }
    await idle();
    const f: any[] = await r.page.evaluate(() => { const R = (window as any).__rec; (window as any).__rec = null; return R.f; });
    const d = f.map((e) => Math.hypot(e.s[0] - cx, e.s[1] - cy)), end = d[d.length - 1], worst = Math.max(...d);
    let step = 0;
    for (let i = 1; i < f.length; i++) step = Math.max(step, Math.hypot(f[i].s[0] - f[i - 1].s[0], f[i].s[1] - f[i - 1].s[1]));
    if (end > 2) bad++;
    console.log(`${end <= 2 ? "ok  " : "FAIL"} ${name.padEnd(3)} z${z} delay ${DELAY} ms: held ground off the cursor worst ${worst.toFixed(1)}, at the end ${end.toFixed(1)} px, worst frame step ${step.toFixed(1)}, zoom ${f[0].z.toFixed(2)} to ${f[f.length - 1].z.toFixed(2)}, mode ${f[0].mode} to ${f[f.length - 1].mode}, ${f.length} frames`);
    if (TRACE) for (let i = 0; i < f.length; i += Number(process.env.EVERY ?? 2)) console.log("  ", (f[i].t - f[0].t).toFixed(0).padStart(5), f[i].s.map((v: number) => v.toFixed(1)).join(","), "d", d[i].toFixed(1), "z", f[i].z.toFixed(3), f[i].mode, "cov", f[i].cover.toFixed(2), "turn", (f[i].turn * 180 / Math.PI).toFixed(2), "hold", f[i].holding ? 1 : 0, "ay", f[i].ay?.toFixed?.(0), "lift", f[i].lift?.toFixed?.(0), `${f[i].lat.toFixed(3)} ${f[i].lon.toFixed(3)}`);
  }
} finally { await r.close(); }
process.exit(bad ? 1 : 0);
