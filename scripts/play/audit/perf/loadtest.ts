// load timeline of the default URL: cold OPFS (fresh profile) and warm (same profile). Screenshot polling for time to a settled picture.
//   lockf /tmp/nomads-gpu.lock bun loadtest.ts --tag=load1 [--n=2] [--query=]
import { launch, take, summarize, sleep, save, netlog, sharp, procs, footprint, workerHeap, pageHeap, SITE } from "./lib";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const tag = args.tag ?? "load", N = Number(args.n ?? 2), query = args.query ?? "";
const out: any = { runs: [] };
const deadline = Date.now() + 238000;
const profile = "/tmp/globe-fix-lead2/chrome";
for (const mode of ["cold", "warm", "cold", "warm"].slice(0, N * 2)) {
  if (Date.now() > deadline - 45000) break;
  const r = await launch({ profile, keepProfile: mode === "warm" });
  try {
    await netlog();
    const shots: { t: number; img: Buffer }[] = [];
    const t0 = performance.now();
    const nav = r.page.goto(`${SITE}/play/${query}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    let ready = 0, firstDoneSeen = 0;
    const shot = async () => { const png: Buffer = await r.page.screenshot({ type: "png" }); return sharp(png).resize(160, 100, { fit: "fill" }).removeAlpha().raw().toBuffer() as Promise<Buffer>; };
    await nav;
    const prog: [number, string][] = [];
    while (performance.now() - t0 < 60000) {
      const s = await r.page.evaluate(() => { const P = (window as any).__perf; return { ready: document.body.classList.contains("ready"), failed: document.body.classList.contains("failed"), gpu: P.gpuVisible, first: P.firstDone, now: performance.now() }; }).catch(() => null);
      if (!s) { await sleep(100); continue; }
      if (s.ready && !ready) ready = performance.now() - t0;
      shots.push({ t: performance.now() - t0, img: await shot() });
      if (s.failed) break;
      const settledN = shots.length > 12 && shots.slice(-8).every((x) => { let d = 0; const a = x.img, b = shots.at(-1)!.img; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length < 0.05; });
      if (ready && settledN && performance.now() - t0 > 6000) break;
      await sleep(100);
    }
    const d = await take(r.page);
    const final = shots.at(-1)!.img;
    const diffs = shots.map((s) => { let x = 0; for (let i = 0; i < final.length; i++) x += Math.abs(s.img[i] - final[i]); return { t: s.t, d: x / final.length }; });
    const stableAt = (thr: number) => { for (let i = 0; i < diffs.length; i++) if (diffs.slice(i).every((x) => x.d < thr)) return Math.round(diffs[i].t); return null; };
    const info = await r.page.evaluate(() => { const P = (window as any).__perf, pl = (window as any).play; return { gpuVisible: P.gpuVisible, firstDone: P.firstDone, readyAt: P.readyAt, reveal: pl?.metrics?.revealMs, mode: pl?.live?.mode, stats: pl?.live?.stats?.readyMs }; });
    const net = await netlog();
    const byKind: Record<string, { n: number; mb: number }> = {};
    for (const x of net) { const k = /\.gt\.gz/.test(x.p) ? "groundtile" : /\.tile\.gz/.test(x.p) ? "pyramid" : /\.js$/.test(x.p) ? "js" : /\.json/.test(x.p) ? "json" : "other"; (byKind[k] ??= { n: 0, mb: 0 }); byKind[k].n++; byKind[k].mb += x.b / 1e6; }
    const jsSizes = net.filter((x) => /\.js$/.test(x.p)).map((x) => [x.p.split("/").slice(-2).join("/"), Math.round(x.b / 1024), Math.round(x.at)]).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8);
    const lastW = d.wperf.at(-1);
    const msgs = d.msgs.filter((m: any) => ["progress", "ground", "objects", "windowObjects", "lost", "gpuerror", "windowError", "error"].includes(m[1])).map((m: any) => [Math.round(m[0]), m[1], m[2]]).slice(0, 40);
    const wev = d.wev.filter((e: any) => e.ms >= 20).map((e: any) => [Math.round(e.pt), e.kind, e.label ?? e.mb ?? "", Math.round(e.ms)]).slice(0, 40);
    const row = { mode, readyMs: Math.round(ready), gpuVisible: Math.round(info.gpuVisible), firstDone: Math.round(info.firstDone), pixelsStable1: stableAt(1), pixelsStable03: stableAt(0.3), pixelsStable01: stableAt(0.1), pageMode: info.mode, netReqs: net.length, netMB: +(net.reduce((a, x) => a + x.b, 0) / 1e6).toFixed(2), byKind, jsSizes, msgs, wev, perf: lastW && { smN: lastW.smN, smMs: lastW.smMs, pipeN: lastW.pipeN, pipeMs: lastW.pipeMs, bufLive: Math.round(lastW.bufLive / 1e6), texLive: Math.round(lastW.texLive / 1e6), bufPeak: Math.round(lastW.bufPeak / 1e6), texPeak: Math.round(lastW.texPeak / 1e6) }, frames: summarize(d), workerHeap: await workerHeap(r.page), pageHeap: await pageHeap(r.page), proc: procs(r.pid).by, errs: r.errs.slice(0, 5) };
    const gp = procs(r.pid).pids.find((p) => p.kind === "gpu"); (row as any).gpuFootprintMB = gp ? footprint(gp.pid) : null;
    out.runs.push(row);
    console.log(`${mode}: ready ${row.readyMs} gpuVisible ${row.gpuVisible} firstDone ${row.firstDone} pixels<1 ${row.pixelsStable1} <0.3 ${row.pixelsStable03} <0.1 ${row.pixelsStable01} mode ${row.pageMode}; net ${row.netReqs} req ${row.netMB} MB ${JSON.stringify(byKind)}; gpu foot ${(row as any).gpuFootprintMB}; frames raf max ${row.frames.rafDt.max} over100 ${row.frames.rafOver100}`);
  } catch (e) { console.error("CRASH", e); out.crash = String(e); } finally { await r.close(); }
  await sleep(1500);
}
save(tag, out);
process.exit(0);
