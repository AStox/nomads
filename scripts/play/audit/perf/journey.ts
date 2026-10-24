// dives, jumps, long pan: time to ground/trees, stalls on arrival. One load.
//   lockf /tmp/nomads-gpu.lock bun journey.ts --tag=j1 [--place=A] [--zoomTo=6.5] [--steps=dive,jump,pan]
import { launch, load, take, summarize, pageState, sleep, save, drag, wheel, procs, netlog, sharp, f } from "./lib";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const tag = args.tag ?? "j", place = args.place ?? "A", zTo = Number(args.zoomTo ?? 6.5), steps = (args.steps ?? "dive,jump,pan").split(",");
const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], BB: [-35.9034, 43.5937], D: [40.2, 10.5], E: [-20.5, -120.3] };
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
const out: any = { args, load: null, dives: [], jumps: [], pan: null };
const deadline = Date.now() + 238000;
const shot = async () => { const png: Buffer = await r.page.screenshot({ type: "png" }); return sharp(png).resize(240, 150, { fit: "fill" }).removeAlpha().raw().toBuffer() as Promise<Buffer>; };
const diff = (a: Buffer, b: Buffer) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
// after a view change at wall time tStart (page clock): poll the page for what the worker reports until it is idle, and take pictures; returns the times
async function arrival(tStart: number, maxMs = 14000) {
  const t0 = Date.now(), pics: { at: number; img: Buffer }[] = [], states: any[] = [];
  while (Date.now() - t0 < maxMs) {
    const s = await r.page.evaluate(async () => { const P = (window as any).play, L = P.live; const c = await L.debug.check({ op: "idle" }); const t = L.stats.tiles; return { now: performance.now(), zoom: P.view.zoom, mode: L.mode, alpha: L.stats.ladderAlpha ?? 0, busy: c?.busy, sprites: c?.sprites, asked: c?.asked, flying: t?.flying, held: t?.held, win: L.stats.window && { id: L.stats.window.id, objects: L.stats.window.objects, made: L.stats.window.made, blocks: L.stats.window.blocks } }; });
    states.push(s);
    pics.push({ at: s.now, img: await shot() });
    if (states.length > 6 && states.slice(-5).every((x) => !x.busy && !x.flying) && Date.now() - t0 > 3000 && pics.length > 8) { const last = pics.slice(-5); if (last.every((p) => diff(p.img, last.at(-1)!.img) < 0.15)) break; }
    await sleep(120);
  }
  const final = pics.at(-1)!.img;
  const diffs = pics.map((p) => ({ t: p.at - tStart, d: diff(p.img, final) }));
  // the first time after which every picture is within 1.0 (mean abs 0..255) of the final, and within 0.3
  const stableAt = (thr: number) => { for (let i = 0; i < diffs.length; i++) if (diffs.slice(i).every((x) => x.d < thr)) return Math.round(diffs[i].t); return null; };
  const idleAt = (() => { for (let i = 0; i < states.length; i++) if (states.slice(i).every((x) => !x.busy && !x.flying)) return Math.round(states[i].now - tStart); return null; })();
  const firstWin = states.find((s) => s.win?.id != null);
  const firstObj = states.find((s) => s.win?.objects > 0);
  return { pixelsStable1: stableAt(1.0), pixelsStable03: stableAt(0.3), pixelsStable01: stableAt(0.1), idleAt, firstWinAt: firstWin ? Math.round(firstWin.now - tStart) : null, firstObjAt: firstObj ? Math.round(firstObj.now - tStart) : null, diffs: diffs.filter((_, i) => i % 2 === 0).map((x) => [Math.round(x.t), +x.d.toFixed(2)]), last: states.at(-1) };
}
try {
  out.load = await load(r, "?zoom=island&hour=13");
  await sleep(1000);
  const st0 = await pageState(r.page); const zmin = st0.zmin;
  const setPlace = (p: string, z: number) => r.page.evaluate((g: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz); return performance.now(); }, PLACES[p], z);
  // ---- dives: from orbit to zTo by wheel, 3 times; the first is cold for the tiles ----
  if (steps.includes("dive")) for (let k = 0; k < 3 && Date.now() < deadline - 90000; k++) {
    await setPlace(place, zmin); await sleep(2500);
    const idle = await arrival(await r.page.evaluate(() => performance.now()), 9000).catch(() => null);
    await take(r.page); await netlog();
    const tStart = await r.page.evaluate(() => performance.now());
    // real wheel: clicks of 200 (0.8 zoom) every 70 ms until the goal reaches zTo; the cursor at the centre
    await r.page.mouse.move(800, 500);
    let clicks = 0, tEnd = 0;
    while (clicks < 80) { const goal = await r.page.evaluate(() => (window as any).play.camera.goal); if (goal >= zTo - 0.02) break; await r.page.mouse.wheel({ deltaY: -200 }); clicks++; await sleep(70); }
    tEnd = await r.page.evaluate(() => performance.now());
    const dd = await take(r.page);
    const dive = summarize(dd);
    const arr = await arrival(tStart);
    const net = await netlog();
    const d2 = await take(r.page);
    const row = { k, cold: k === 0, clicks, wheelMs: Math.round(tEnd - tStart), diveFrames: dive, arrival: arr, netReqs: net.length, netMB: +(net.reduce((a, x) => a + x.b, 0) / 1e6).toFixed(2), netByKind: net.reduce((m: any, x) => { const key = /\.gt\.gz/.test(x.p) ? "groundtile" : /pyramid/.test(x.p) ? "pyramid" : /\.js/.test(x.p) ? "js" : "other"; (m[key] ??= { n: 0, mb: 0 }); m[key].n++; m[key].mb += x.b / 1e6; return m; }, {}), after: summarize(d2), proc: procs(r.pid).by };
    out.dives.push(row);
    console.log(`dive ${k}: wheel ${row.wheelMs}ms, dive frames raf p95 ${dive.rafDt.p95} max ${dive.rafDt.max} gpu ${dive.gpuMs.mean}/${dive.gpuMs.p95}; arrival win ${arr.firstWinAt} obj ${arr.firstObjAt} idle ${arr.idleAt} px<1 ${arr.pixelsStable1} px<0.3 ${arr.pixelsStable03}; net ${row.netReqs} req ${row.netMB} MB ${JSON.stringify(row.netByKind)}`);
  }
  // ---- jumps: at zTo, to far places ----
  if (steps.includes("jump")) for (const p of ["B", "C", "BB", "D", place]) {
    if (Date.now() > deadline - 40000) break;
    await setPlace(p === place ? "E" : place, zTo); await sleep(500); // somewhere first, so the jump is a jump
    await arrival(0, 6000).catch(() => null);
    await take(r.page); await netlog();
    const tStart = await setPlace(p, zTo);
    const arr = await arrival(tStart);
    const d = await take(r.page), net = await netlog();
    const row = { to: p, frames: summarize(d), arrival: arr, netReqs: net.length, netMB: +(net.reduce((a, x) => a + x.b, 0) / 1e6).toFixed(2), msgs: d.msgs.filter((m: any) => !/^(progress)$/.test(m[1])).slice(0, 40).map((m: any) => [Math.round(m[0] - tStart), m[1], m[2]]), slow: d.wev.filter((e: any) => e.ms >= 8).slice(0, 20).map((e: any) => [Math.round(e.pt - tStart), e.kind, e.label ?? e.mb ?? "", Math.round(e.ms)]) };
    out.jumps.push(row);
    console.log(`jump ${p}: win ${arr.firstWinAt} obj ${arr.firstObjAt} idle ${arr.idleAt} px<1 ${arr.pixelsStable1} px<0.3 ${arr.pixelsStable03}; raf p95 ${row.frames.rafDt.p95} max ${row.frames.rafDt.max} gpu ${row.frames.gpuMs.mean}/${row.frames.gpuMs.p95} max ${row.frames.gpuMs.max}; net ${row.netReqs} ${row.netMB}MB`);
  }
  // ---- long pan: 20 s of real drags at about 1000 px/s ----
  if (steps.includes("pan") && Date.now() < deadline - 30000) {
    await setPlace(place, zTo); await arrival(0, 8000).catch(() => null);
    await take(r.page); await netlog();
    const s = Date.now(), t0 = await r.page.evaluate(() => performance.now());
    while (Date.now() - s < 20000) await drag(r.page, 1400, 500, 200, 500, 1200);
    const d = await take(r.page), net = await netlog();
    const sum = summarize(d);
    out.pan = { frames: sum, netReqs: net.length, netMB: +(net.reduce((a, x) => a + x.b, 0) / 1e6).toFixed(2), msgs: d.msgs.filter((m: any) => /ground|windowObjects/.test(m[1])).map((m: any) => [Math.round(m[0] - t0), m[1], m[2]]).slice(0, 40), slow: d.wev.filter((e: any) => e.ms >= 8).map((e: any) => [Math.round(e.pt - t0), e.kind, e.label ?? e.mb ?? "", Math.round(e.ms)]).slice(0, 30), longest: [...d.raf.slice(1).map((x: number, i: number) => x - d.raf[i])].sort((a, b) => b - a).slice(0, 8).map(Math.round), proc: procs(r.pid).by };
    console.log(`pan 20s: raf mean ${sum.rafDt.mean} p95 ${sum.rafDt.p95} max ${sum.rafDt.max}; >25ms ${sum.rafDt.n && 0}; >33: ${sum.rafOver33} >50: ${sum.rafOver50} >100: ${sum.rafOver100}; gpu ${sum.gpuMs.mean}/${sum.gpuMs.p95}; net ${out.pan.netReqs} ${out.pan.netMB}MB`);
  }
  const fin = await take(r.page);
  out.errors = r.errs; out.lost = fin.lost; out.lastWperf = fin.wperf.at(-1); out.labels = fin.labels?.slice(0, 25);
} catch (e) { out.crash = String(e); console.error("CRASH", e); }
finally { save(tag, out); await r.close(); }
console.log("errors", JSON.stringify(r.errs.slice(0, 6)));
process.exit(0);
