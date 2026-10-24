// zoom grid: for each zoom: settle, idle, pan (real drag), rotate (right drag), wheel zoom. One load.
//   lockf /tmp/nomads-gpu.lock bun grid.ts --zooms=-4,0,3,5,7,9 --place=A --vp=1600x1000 --dpr=1 --tag=run1 [--secs=4] [--query=...]
import { launch, load, take, summarize, pageState, sleep, save, drag, wheel, procs, pct, mean, f, footprint, workerHeap, pageHeap } from "./lib";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const place = args.place ?? "A", vp = (args.vp ?? "1600x1000").split("x").map(Number), dpr = Number(args.dpr ?? 1), tag = args.tag ?? "grid", secs = Number(args.secs ?? 4) * 1000;
const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], BB: [-35.9034, 43.5937], DEF: [47.805848, 38.630365] };
const r = await launch({ vw: vp[0], vh: vp[1], dpr, profile: "/tmp/globe-fix-lead2/chrome" });
const out: any = { args, place, vp, dpr, zooms: [] };
const deadline = Date.now() + 235000;
try {
  const li = await load(r, args.query ?? "?zoom=island&hour=13");
  out.load = li;
  await sleep(1500);
  const st0 = await pageState(r.page);
  out.zmin = st0.zmin; out.zmax = st0.zmax;
  const zooms = (args.zooms ?? "-4,0,3,5,7,9").split(",").map(Number);
  const geo = PLACES[place];
  const cx = vp[0] / 2, cy = vp[1] / 2;
  const settle = async (z: number, maxMs = 25000) => {
    return r.page.evaluate(async (zz: number, g: number[], maxMs: number) => {
      const P = (window as any).play, L = P.live, S = (ms: number) => new Promise((r) => setTimeout(r, ms));
      if (g) P.view.geo = { lat: g[0], lon: g[1] };
      const t0 = performance.now();
      P.camera.setZoom(zz);
      let firstWin = 0, firstObj = 0, lastBusy = t0;
      while (performance.now() - t0 < maxMs) {
        await S(100);
        const c = await L.debug.check({ op: "idle" }), t = L.stats.tiles, w = L.stats.window;
        if (!firstWin && w?.id != null) firstWin = performance.now() - t0;
        if (!firstObj && w?.objects > 0) firstObj = performance.now() - t0;
        if (c?.busy || t?.flying) lastBusy = performance.now();
        if (performance.now() - lastBusy > 1200 && performance.now() - t0 > 1500) break;
      }
      return { idleMs: Math.round(lastBusy - t0), firstWinMs: Math.round(firstWin), firstObjMs: Math.round(firstObj), timeout: performance.now() - t0 >= maxMs };
    }, z, geo as number[], maxMs);
  };
  for (const z of zooms) {
    if (Date.now() > deadline) { out.truncatedAt = z; break; }
    const row: any = { z };
    row.settle = await settle(z);
    row.state = await pageState(r.page);
    const scen = async (name: string, fn: () => Promise<void>) => {
      await take(r.page); const t0 = Date.now();
      await fn();
      const d = await take(r.page);
      row[name] = summarize(d);
      row[name].stalls = stallsOf(d);
      row[name].wallMs = Date.now() - t0;
    };
    await scen("idle", () => sleep(secs));
    await scen("pan", async () => { const s = Date.now(); let k = 0; while (Date.now() - s < secs) { const dir = k++ % 2 ? -1 : 1; await drag(r.page, cx - dir * 250, cy, cx + dir * 250, cy + 40 * dir, 600); } });
    await settle(z, 6000);
    await scen("rotate", async () => { const s = Date.now(); let k = 0; while (Date.now() - s < secs) { const dir = k++ % 2 ? -1 : 1; await drag(r.page, cx - dir * 200, cy, cx + dir * 200, cy, 900, "right"); } });
    await settle(z, 6000);
    await scen("wheel", async () => { await wheel(r.page, cx, cy, -200, 3, 120); await sleep(1200); await wheel(r.page, cx, cy, 200, 3, 120); await sleep(1200); });
    const pr = procs(r.pid); row.proc = pr.by; const gp = pr.pids.find((p) => p.kind === 'gpu'); row.gpuFootprintMB = gp ? footprint(gp.pid) : null; row.workerHeap = await workerHeap(r.page); row.pageHeap = await pageHeap(r.page);
    out.zooms.push(row);
    const g = row.idle.gpuMs, p = row.pan.gpuMs;
    console.log(`z ${z}: settle idle ${row.settle.idleMs} win ${row.settle.firstWinMs} obj ${row.settle.firstObjMs} idle gpu ${g.mean}/${g.p95} raf ${row.idle.rafDt.mean}/${row.idle.rafDt.p95} | pan gpu ${p.mean}/${p.p95} raf ${row.pan.rafDt.mean}/${row.pan.rafDt.p95} >33:${row.pan.rafOver33} | rot gpu ${row.rotate.gpuMs.mean}/${row.rotate.gpuMs.p95} | wheel gpu ${row.wheel.gpuMs.mean}/${row.wheel.gpuMs.p95} raf p95 ${row.wheel.rafDt.p95} max ${row.wheel.rafDt.max}`);
  }
  const fin = await take(r.page);
  out.errors = r.errs; out.lost = fin.lost; out.labels = fin.labels?.slice(0, 20); out.lastWperf = fin.wperf.at(-1);
} catch (e) { out.crash = String(e); console.error("CRASH", e); }
finally { save(tag, out); await r.close(); }
console.log("errors", JSON.stringify(r.errs.slice(0, 5)));
process.exit(0);

function stallsOf(d: any) {
  // the worst rAF gaps with what the worker and page were doing within them
  const raf: number[] = d.raf, gaps: [number, number][] = [];
  for (let i = 1; i < raf.length; i++) gaps.push([raf[i] - raf[i - 1], raf[i]]);
  return gaps.filter((g) => g[0] > 40).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([dt, at]) => {
    const lo = at - dt - 30, hi = at + 30;
    return { dt: Math.round(dt), at: Math.round(at), wev: d.wev.filter((e: any) => e.pt >= lo - 100 && e.pt <= hi && e.ms >= 4).map((e: any) => `${e.kind}:${e.label ?? e.mb ?? e.kb ?? ''}:${Math.round(e.ms)}`).slice(0, 6), long: d.long.filter((x: any) => x[0] >= lo - 50 && x[0] <= hi).map((x: any) => Math.round(x[1])), loaf: d.loaf.filter((x: any) => x[0] >= lo - 50 && x[0] <= hi).map((x: any) => [Math.round(x[1]), x[3]]).slice(0, 2), msgs: d.msgs.filter((m: any) => m[0] >= lo && m[0] <= hi).map((m: any) => `${m[1]}${m[2] ? ":" + m[2] : ""}`).slice(0, 6), wlag: d.wlag.filter((x: any) => x.pt >= lo - 100 && x.pt <= hi).map((x: any) => Math.round(x.ms)).slice(0, 4) };
  });
}
