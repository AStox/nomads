// Pictures drawn a second (the worker's frameDone) while the input is active, on a page that is otherwise idle: a wheel zoom from orbit to the ground (5a), a drag at the ground (5b, four 900 ms drags with 700 ms between)
// and at zoom 0, a steady 4 s drag (a move every 40 ms), and the dive back in. Run on both sites in turn (SITE, PROFILE): the same count means the picture is posted on every rAF as the input asks.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/inputhz.ts      ONLY=5a,5b,5z,steady,dive, TAG, REC=1 (per rAF while the input runs: how many rAFs the zoom or the target moved in, and in how many of them the page posted no frame: it posts none for a frame that says what the last said, live.js HEARTBEAT_MS)
import { launch, load, take, sleep, summarize, drag } from "./lib";
const only = (process.env.ONLY ?? "").split(",").filter(Boolean), run = (k: string) => !only.length || only.includes(k);
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
const zs = () => r.page.evaluate(() => { const P = (window as any).play; return [P.view.zoom, P.live.mode]; });
const recOn = (on: boolean) => process.env.REC && r.page.evaluate((o: boolean) => { (window as any).__rec = { on: o, a: 0, b: 0, c: 0, d: 0 }; }, on);
const recOut = async () => (process.env.REC ? "rec(zoom moved & skipped, zoom moved, target moved & skipped, neither & skipped; rAFs) " + JSON.stringify(await r.page.evaluate(() => (window as any).__rec)) : "");
const st = async (tag: string) => { const d = await take(r.page); const s = summarize(d); console.log(process.env.TAG ?? "", tag, await recOut(), JSON.stringify({ zoom: (await zs())[0], doneHz: s.doneHz, sentHz: +(s.framesSent / s.seconds).toFixed(1), rafMax: s.rafDt.max, over33: s.rafOver33, gpuMean: s.gpuMs.mean, cpuMean: s.cpuMs.mean, skipped: await r.page.evaluate(() => (window as any).play.live.stats.skipped ?? 0) })); };
const place = async (lat: number, lon: number, z: number) => { await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z); await sleep(7000); };
const steady = async (n: number) => { await r.page.mouse.move(400, 400); await r.page.mouse.down(); await take(r.page); await recOn(true); for (let i = 0; i < n; i++) { await r.page.mouse.move(400 + i * 4, 400 + (i % 10)); await sleep(40); } await st(`steady drag ${n * 40} ms`); await r.page.mouse.up(); };
if (process.env.REC) await r.page.evaluateOnNewDocument(() => {
  const w = window as any; w.__rec = { on: false, a: 0, b: 0, c: 0, d: 0 }; let pz = 0, ps = 0, pg = "";
  const loop = () => { const P = w.play, R = w.__rec; if (P && R.on) { const z = P.view.zoom, sk = P.live.stats.skipped ?? 0, g = P.view.geo, gs = g.lat + "|" + g.lon + "|" + (g.hd ?? 0), zc = z !== pz, gc = gs !== pg, skd = sk > ps; if (zc && skd) R.a++; else if (zc) R.b++; else if (gc && skd) R.c++; else if (skd) R.d++; R.n = (R.n ?? 0) + 1; pz = z; ps = sk; pg = gs; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
try {
  await load(r, "?hour=13&warm=0"); await sleep(4000);
  await r.page.mouse.move(640, 400);
  if (run("5a") || run("dive")) {
    for (let i = 0; i < 45; i++) { await r.page.mouse.wheel({ deltaY: 100 }); await sleep(100); }
    await sleep(3000);
  }
  if (run("5a")) {
    await take(r.page); await recOn(true);
    for (let i = 0; i < 60; i++) { await r.page.mouse.wheel({ deltaY: -100 }); await sleep(100); }
    await st("5a wheel orbit to ground, 6 s of wheel"); await recOn(false);
    await sleep(6000); await st("5a settled");
  }
  if (run("5b")) {
    await take(r.page); await recOn(true);
    for (let k = 0; k < 4; k++) { await drag(r.page, 500 + k * 20, 400, 800 + k * 20, 380, 900); await sleep(700); }
    await st("5b drag x4 at ground");
  }
  if (run("5z")) {
    await place(4.35, -39.38, 0);
    await take(r.page);
    for (let k = 0; k < 4; k++) { await drag(r.page, 500 + k * 20, 400, 800 + k * 20, 380, 900); await sleep(700); }
    await st("5z drag x4 at zoom 0");
  }
  if (run("steady")) { await place(4.35, -39.38, 3); await steady(100); }
  if (run("dive")) {
    await take(r.page); await recOn(true);
    for (let i = 0; i < 40; i++) { await r.page.mouse.wheel({ deltaY: -100 }); await sleep(120); }
    await st("dive back in, 4.8 s of wheel");
  }
  console.log("errs", r.errs.slice(0, 5).map((e) => e.slice(0, 200)));
} finally { await r.close(); }
process.exit(0);
