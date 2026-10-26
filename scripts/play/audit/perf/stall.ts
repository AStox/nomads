// Frame gaps after a teleport: the page's largest rAF gap and the worker's largest frameDone gap in the seconds after play.view.geo is set to a place, per place and zoom.
//   lockf /tmp/nomads-gpu.lock bun stall.ts --zooms=1.7,3 [--places=P1,P2,A,B,R,E2] [--secs=10] [--prof] [--query=?hour=13]
// SITE= picks the site (default the perf site's port), PROFILE= the browser's directory (kept between runs). --prof CPU-profiles the render worker for each teleport and prints the busy runs over 30 ms.
import { execSync } from "node:child_process";
import { launch, load, take, sleep, summarize, SITE } from "./lib";
// the machine's GPU busy share, read by ioreg: what other jobs leave to the page
const util = () => { try { return Number(/"Device Utilization %"=(\d+)/.exec(execSync("ioreg -r -d 1 -c IOAccelerator", { timeout: 4000 }).toString())?.[1]); } catch { return NaN; } };

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const ALL: Record<string, [number, number]> = { P1: [11.95, 83.99], P2: [-36.3, 44.5], A: [4.35, -39.38], B: [-35.9, 43.59], R: [12.02, 83.89], E2: [13.27, 45.0] };
const places = (args.places ?? "P1,P2,A,B,R,E2").split(","), zooms = (args.zooms ?? "1.7,3,4.2,5").split(",").map(Number), secs = Number(args.secs ?? 10), prof = !!args.prof;
const outFile = args.out, buf: string[] = [];
const log = (...a: unknown[]) => { const l = a.map(String).join(" "); console.log(l); buf.push(l); if (outFile) require("node:fs").writeFileSync(outFile, buf.join("\n") + "\n"); };
const query = args.query ?? "?hour=13";
const profile = process.env.PROFILE ?? "/tmp/globe-fix-lead3/stall-chrome";

function busyRuns(p: any, minMs: number) {
  const nodes = new Map<number, any>(); for (const n of p.nodes) nodes.set(n.id, n);
  const parent = new Map<number, number>(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n: any) => `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const idle = (n: any) => /^\((idle)\)/.test(n.callFrame.functionName);
  const runs: { ms: number; at: number; self: Map<string, number>; total: Map<string, number> }[] = [];
  let cur: any = null, t = 0;
  p.samples.forEach((id: number, i: number) => {
    const dt = (p.timeDeltas[i] ?? 0) / 1000; t += dt;
    const n = nodes.get(id)!;
    if (idle(n)) { if (cur) { runs.push(cur); cur = null; } return; }
    cur ??= { ms: 0, at: t, self: new Map(), total: new Map() };
    cur.ms += dt; cur.self.set(key(n), (cur.self.get(key(n)) ?? 0) + dt);
    const seen = new Set<string>(); let c: number | undefined = id;
    while (c !== undefined) { const k = key(nodes.get(c)!); if (!seen.has(k)) { seen.add(k); cur.total.set(k, (cur.total.get(k) ?? 0) + dt); } c = parent.get(c); }
  });
  if (cur) runs.push(cur);
  const top = (m: Map<string, number>, n: number) => [...m.entries()].filter(([k]) => !/^\((root|idle)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0)} ${k}`);
  return runs.filter((r) => r.ms >= minMs).map((r) => ({ ms: Math.round(r.ms), at: Math.round(r.at), self: top(r.self, 4), total: top(r.total, 8) }));
}

let lastPerf: any = null;
const r = await launch({ profile, keepProfile: true });
const rows: any[] = [];
try {
  const L = await load(r, query);
  log("loaded", Math.round(L.ready), "ms");
  await sleep(2000);
  const origin: number = await r.page.evaluate(() => performance.timeOrigin);
  const w = r.page.workers().find((x: any) => /worker\.js/.test(x.url()));
  const c = (w as any)?.client;
  if (prof) { await c.send("Profiler.enable"); await c.send("Profiler.setSamplingInterval", { interval: 300 }); }
  for (const z of zooms) {
    await r.page.evaluate((zz: number) => { (window as any).play.camera.setZoom(zz); }, z);
    await sleep(3000);
    for (const name of places) {
      const [lat, lon] = ALL[name];
      await take(r.page);
      const c0 = r.cons.length;
      if (prof) await c.send("Profiler.start");
      const t0 = await r.page.evaluate((la: number, lo: number) => { const P = (window as any).play; P.view.geo = { lat: la, lon: lo }; return performance.now(); }, lat, lon);
      await sleep((secs * 1000) / 2);
      const u1 = util();
      await sleep((secs * 1000) / 2 - 200);
      const u2 = util();
      const pr = prof ? (await c.send("Profiler.stop")).profile : null;
      const d = await take(r.page);
      const raf = d.raf.filter((t: number) => t >= t0), rg: [number, number][] = [];
      for (let i = 1; i < raf.length; i++) rg.push([raf[i] - raf[i - 1], raf[i] - t0]);
      const fr = d.frames.filter((x: any) => x[0] >= t0), fg: [number, number, any][] = [];
      for (let i = 1; i < fr.length; i++) fg.push([fr[i][0] - fr[i - 1][0], fr[i][0] - t0, fr[i]]);
      // the picture's delay: how long after the first frame the page sent since the last picture was drawn the next picture came (a gap with no frame sent is the page being still, not a stall)
      const sent = d.sent.filter((x: any) => x[0] >= t0 - 200), dl: [number, number][] = [];
      for (let i = 1; i < d.frames.length; i++) { const a = d.frames[i - 1][0], b = d.frames[i][0]; if (b < t0) continue; const s1 = sent.find((x: any) => x[0] > a); if (s1 && s1[0] < b) dl.push([b - s1[0], b - t0]); }
      const worst = (g: [number, number, ...any[]][]) => g.reduce((a, b) => (b[0] > a[0] ? b : a), [0, 0] as any);
      const wr = worst(rg), wf = worst(fg), wd = worst(dl);
      const lp = d.wperf.at(-1), up = lp && { wtMB: Math.round(((lp.wtBytes - (lastPerf?.wtBytes ?? 0)) / 1e6)), wtN: lp.wtN - (lastPerf?.wtN ?? 0), wbMB: Math.round((lp.wbBytes - (lastPerf?.wbBytes ?? 0)) / 1e6), wbN: lp.wbN - (lastPerf?.wbN ?? 0), subN: lp.subN - (lastPerf?.subN ?? 0) };
      if (lp) lastPerf = lp;
      const lags = d.wlag.filter((x: any) => x.pt >= t0).map((x: any) => Math.round(x.ms));
      const row = { name, z, rafMax: Math.round(wr[0]), rafAt: Math.round(wr[1]), frameMax: Math.round(wf[0]), frameAt: Math.round(wf[1]), delayMax: Math.round(wd[0]), delayAt: Math.round(wd[1]), delay60: dl.filter((g) => g[0] > 60).length, sent: sent.length, gap100: fg.filter((g) => g[0] > 100).length, gap50: fg.filter((g) => g[0] > 50).length, long: Math.round(Math.max(0, ...d.long.filter((x: any) => x[0] >= t0).map((x: any) => x[1]))), lagMax: Math.max(0, ...lags), frames: fr.length, errs: d.werr.length, gpuUtil: [u1, u2], up };
      rows.push(row);
      log(JSON.stringify(row));
      if (wf[0] > 60) { const x = wf[2]; log("  worst frame: gpu", x[2]?.toFixed?.(1), "cpu", x[3]?.toFixed?.(1), "apply", Math.round(x[4]), JSON.stringify(x[5])); }
      const rel = (txt: string) => txt.replace(/\b(\d{13}(?:\.\d+)?)\b/g, (_: string, e: string) => `@${Math.round(+e - origin - t0)}`);
      const marks = r.cons.slice(c0).filter((x) => /^STALL/.test(x[1])), ev = marks.filter((x) => /ev evict/.test(x[1]));
      for (const m of marks.filter((x) => !/ev evict/.test(x[1]))) log("  ", rel(m[1]));
      if (ev.length) log("   evicts:", ev.length, "first", rel(ev[0][1]), "last", rel(ev.at(-1)![1]));
      log("  lags>25:", d.wlag.filter((x: any) => x.pt >= t0 && x.ms >= 25).map((x: any) => `${Math.round(x.pt - t0)}:${Math.round(x.ms)}`).join(" "));
      log("  delays>50:", dl.filter((g) => g[0] > 50).map((g) => `${Math.round(g[1])}:${Math.round(g[0])}`).join(" "));
      for (const e of d.wev.filter((e: any) => e.pt >= t0 && (e.kind === "mapAsync" ? e.ms >= 40 : e.kind === "error" || e.kind === "big" ? true : (e.kind === "writeBuffer" || e.kind === "writeTexture") ? e.mb >= 3 : e.ms >= 4)).slice(0, 40)) log("  ev", Math.round(e.pt - t0), e.kind, e.ms, e.label ?? e.mb ?? e.n ?? e.kb ?? "", e.what ?? "", e.mb ?? "");
      if (pr) for (const b of busyRuns(pr, 25)) log("  busy", b.ms, "ms at", b.at, "self:", b.self.join(" | "), "\n     total:", b.total.join(" | "));
    }
  }
  log("MAX rafMax", Math.max(...rows.map((x) => x.rafMax)), "frameMax", Math.max(...rows.map((x) => x.frameMax)), "delayMax", Math.max(...rows.map((x) => x.delayMax)), "errs", r.errs.length, r.errs.slice(0, 3));
} finally { await r.close(); }
process.exit(0);
