// repro: heavy loads at place B (harness B [-5.38, 73.13]) at a wide-ish zoom, jumping between B's neighbours and elsewhere with short dwells: peak GPU buffers, errors, device loss
//   lockf /tmp/nomads-gpu.lock bun bloss.ts --tag=bloss1 [--z=3.2] [--dwell=1800] [--cycles=14] [--place=B]
import { launch, load, take, summarize, sleep, save, procs, footprint } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const tag = args.tag ?? "bloss", z = Number(args.z ?? 3.2), dwell = Number(args.dwell ?? 1800), cycles = Number(args.cycles ?? 14);
const P: Record<string, number[]> = { B: [-5.38, 73.13], BB: [-35.9034, 43.5937], A: [4.35, -39.38] };
const home = P[args.place ?? "B"], FAR = [[26.8, 15.1], [49.0, 75.0], [-45, -93], [17, 164], [30, 108], [-39.4, 39.8]];
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
const out: any = { args, cycles: [], bigs: [], maxSizes: null };
const t0 = Date.now();
try {
  await load(r, "?hour=13"); await sleep(500);
  let maxBuf = 0, maxSizes: any = null;
  const hold = async (ms: number, tj: number, tag2: string) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { await sleep(250); }
  };
  for (let c = 0; c < cycles && Date.now() - t0 < 215000; c++) {
    const at = c % 2 === 0 ? [home[0] + (Math.random() - 0.5) * 1.6, home[1] + (Math.random() - 0.5) * 1.6] : FAR[c % FAR.length];
    await take(r.page);
    const tj = await r.page.evaluate((g: number[], zz: number) => { const Pp = (window as any).play; Pp.view.geo = { lat: g[0], lon: g[1] }; Pp.camera.setZoom(zz); return performance.now(); }, at, z);
    await sleep(dwell);
    const d = await take(r.page);
    const s = summarize(d);
    const mx = Math.max(0, ...d.wperf.map((x: any) => x.bufLive)), best = d.wperf.find((x: any) => x.bufLive === mx);
    if (mx > maxBuf) { maxBuf = mx; maxSizes = best?.sizes; }
    for (const e of d.wev.filter((e: any) => e.kind === "big")) out.bigs.push({ c, t: Math.round(e.pt - tj), mb: e.mb, label: e.label, st: e.st });
    const row = { c, at: at.map((x) => +x.toFixed(2)), isB: c % 2 === 0, maxBufMB: Math.round(mx / 1e6), sizes: best?.sizes, gpu: s.gpuMs, rafMax: s.rafDt.max, rafOver100: s.rafOver100, doneHz: s.doneHz, lost: d.lost.length, errs: d.werr.slice(0, 2).map((e: any) => (e.msg ?? e.lost ?? "").slice(0, 120)), maxMap: Math.max(0, ...d.wev.filter((e: any) => e.kind === "mapAsync").map((e: any) => e.ms)) };
    out.cycles.push(row);
    console.log(`c${c} ${row.isB ? "B" : "far"} (${row.at}) maxBuf ${row.maxBufMB}MB gpu ${s.gpuMs.mean}/${s.gpuMs.max} rafMax ${s.rafDt.max} doneHz ${s.doneHz} maxMap ${row.maxMap.toFixed(0)} ${row.errs.length ? "ERR " + row.errs[0] : ""}${row.lost ? " LOST " + JSON.stringify(d.lost) : ""}`);
    if (d.lost.length) break;
  }
  out.maxBufMB = Math.round(maxBuf / 1e6); out.maxSizes = maxSizes;
  const g = procs(r.pid).pids.find((p) => p.kind === "gpu"); out.foot = g ? footprint(g.pid) : null;
  out.errors = r.errs.slice(0, 10);
} catch (e) { out.crash = String(e); console.error("CRASH", e); }
finally { save(tag, out); await r.close(); }
console.log("maxBufMB", out.maxBufMB, "sizes", JSON.stringify(out.maxSizes), "errors", r.errs.length);
process.exit(0);
