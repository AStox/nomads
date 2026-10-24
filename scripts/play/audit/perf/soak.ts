// soak: many jumps with pans and zooms; memory timeline (worker GPU counters, GPU process footprint, heaps), stalls, errors, device loss.
//   lockf /tmp/nomads-gpu.lock bun soak.ts --tag=soak1 [--secs=225] [--seed=1] [--bb=0.25] [--dwell=4500]
import { launch, load, take, summarize, pageState, sleep, save, drag, wheel, procs, footprint, workerHeap, pageHeap, settleTo } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const tag = args.tag ?? "soak", secs = Number(args.secs ?? 225), seed0 = Number(args.seed ?? 1), bbP = Number(args.bb ?? 0.25), dwell = Number(args.dwell ?? 4500), site = args.site;
let s = seed0 * 2654435761 >>> 0; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const BB = [-35.9034, 43.5937], KNOWN = [[4.35, -39.38], [-5.38, 73.13], [16.8, 84.38]];
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
const out: any = { args, jumps: [], series: [], events: [] };
const t0 = Date.now();
let lostSeen = 0;
try {
  if (site) { await r.page.goto(`${site}/play/?hour=13`, { waitUntil: "domcontentloaded" }); await r.page.waitForSelector("body.ready", { timeout: 120000 }); } else await load(r, "?hour=13");
  await sleep(500);
  const gp = () => procs(r.pid).pids.find((p) => p.kind === "gpu");
  let lastFoot = 0, foot: number | null = null;
  const sample = async () => {
    const d = await take(r.page);
    const w = d.wperf.at(-1);
    if (Date.now() - lastFoot > 2500) { const g = gp(); foot = g ? footprint(g.pid) : null; lastFoot = Date.now(); }
    return { d, w, foot };
  };
  // the stream of perf samples: keep all of them per jump
  const jumpOnce = async (k: number) => {
    const pick = rnd();
    let lat: number, lon: number, kind: string;
    if (pick < bbP) { lat = BB[0] + (rnd() - 0.5) * 2; lon = BB[1] + (rnd() - 0.5) * 2; kind = "BB"; }
    else if (pick < bbP + 0.15) { const p = KNOWN[Math.floor(rnd() * KNOWN.length)]; lat = p[0] + (rnd() - 0.5) * 1.5; lon = p[1] + (rnd() - 0.5) * 1.5; kind = "known"; }
    else { lat = (rnd() - 0.5) * 120; lon = (rnd() - 0.5) * 360; kind = "rand"; }
    const z = [3.2, 4.5, 6, 7.5, 9][Math.floor(rnd() * 5)];
    await take(r.page);
    const tj = await r.page.evaluate((g: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz); return performance.now(); }, [lat, lon], z);
    await sleep(dwell);
    const act = rnd();
    if (act < 0.4) { await drag(r.page, 1200, 500, 400, 500, 1000); await drag(r.page, 400, 500, 1200, 450, 1000); }
    else if (act < 0.7) { await wheel(r.page, 800, 500, -200, 2, 120); await sleep(800); await wheel(r.page, 800, 500, 200, 2, 120); }
    const { d, w, foot } = await sample();
    const sm = summarize(d);
    const st = await pageState(r.page).catch(() => null);
    const ev = d.wev.filter((e: any) => e.ms >= 30 && e.kind !== "mapAsync").map((e: any) => [Math.round(e.pt - tj), e.kind, e.label ?? e.mb ?? "", Math.round(e.ms)]);
    const maps = d.wev.filter((e: any) => e.kind === "mapAsync").map((e: any) => e.ms);
    const row = { k, kind, lat: +lat.toFixed(3), lon: +lon.toFixed(3), z, objects: st?.window?.objects, blocks: st?.window?.blocks, tMs: Date.now() - t0, gpu: sm.gpuMs, raf: sm.rafDt, rafOver50: sm.rafOver50, rafOver100: sm.rafOver100, dropped: sm.dropped, doneHz: sm.doneHz, wstall: sm.workerStallMax, maxMap: Math.max(0, ...maps), ev: ev.slice(0, 8), w: w && { bufMB: Math.round(w.bufLive / 1e6), texMB: Math.round(w.texLive / 1e6), bufPeakMB: Math.round(w.bufPeak / 1e6), texPeakMB: Math.round(w.texPeak / 1e6), nBuf: w.nBuf, nTex: w.nTex, destroyed: w.bufDestroyed, collected: w.bufCollected, wbMB: Math.round(w.wbBytes / 1e6), heapMB: w.heap }, foot, lost: d.lost.length, errs: d.werr.slice(0, 2).map((e: any) => e.msg ?? e.lost) };
    // the maximum of any worker sample in this jump, for the transient
    if (row.w) (row.w as any).bufMaxInJump = Math.round(Math.max(0, ...d.wperf.map((x: any) => x.bufLive)) / 1e6);
    (row as any).texMaxInJump = row.w && Math.round(Math.max(0, ...d.wperf.map((x: any) => x.texLive)) / 1e6);
    out.jumps.push(row);
    for (const x of d.wperf) out.series.push({ t: Math.round(x.at), buf: Math.round(x.bufLive / 1e6), tex: Math.round(x.texLive / 1e6), heap: x.heap });
    console.log(`#${k} ${kind} (${row.lat},${row.lon}) z${z} obj ${row.objects} gpu ${row.gpu.mean}/${row.gpu.p95} raf max ${row.raf.max} >50:${row.rafOver50} drop ${row.dropped} buf ${row.w?.bufMB}MB (max ${(row.w as any)?.bufMaxInJump}) tex ${row.w?.texMB}MB foot ${foot} maxMap ${row.maxMap}${row.lost ? " LOST!" : ""}${row.errs.length ? " ERR " + row.errs.join("|").slice(0, 120) : ""}`);
    return d.lost.length > 0;
  };
  let k = 0;
  while (Date.now() - t0 < secs * 1000) {
    const lost = await jumpOnce(k++);
    if (lost) { lostSeen++; out.events.push({ k, lost: true }); break; }
  }
  const fin = await take(r.page);
  out.final = { wh: await workerHeap(r.page), ph: await pageHeap(r.page), proc: procs(r.pid).by, foot, labels: fin.labels?.slice(0, 20), lastW: fin.wperf.at(-1) };
  out.errors = r.errs.slice(0, 20);
} catch (e) { out.crash = String(e); console.error("CRASH", e); }
finally { save(tag, out); await r.close(); }
console.log("errors", JSON.stringify(r.errs.slice(0, 6)), "lost", lostSeen);
process.exit(0);
