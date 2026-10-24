// Perf audit harness (scratch). Headless Chrome + puppeteer-core against the frozen site on :8231.
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

export const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
export const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const SITE = process.env.SITE ?? "http://127.0.0.1:8231";
export const PLACES: Record<string, [number, number] | null> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], BB: [-35.9034, 43.5937], home: null };

const INIT = () => {
  const P: any = (window as any).__perf = { raf: [], frames: [], sent: [], msgs: [], long: [], loaf: [], wperf: [], wev: [], wlag: [], werr: [], labels: null, lost: [], t0: performance.now(), firstDone: 0, gpuVisible: 0, readyAt: 0, tiles: null, console: [] };
  const OW = window.Worker;
  (window as any).Worker = class extends OW {
    constructor(u: any, o: any) {
      super(u, o);
      const url = String(u);
      const pm = this.postMessage.bind(this);
      (this as any).postMessage = (m: any, t: any) => { if (m && m.type === "frame") P.sent.push([performance.now(), m.id]); return pm(m, t);} ;
      this.addEventListener("message", (e: MessageEvent) => {
        const m = e.data, now = performance.now();
        if (!m || typeof m !== "object") return;
        if (m.type === "frameDone") {
          if (!P.firstDone) P.firstDone = now;
          P.frames.push([now, m.id, m.gpuMs, m.cpuMs, m.applyMs ?? 0, m.passes ?? null, m.at ?? 0]);
          if (m.tiles) P.tiles = m.tiles;
          if (P.frames.length > 60000) P.frames.splice(0, 30000);
        } else if (m.type === "__perf") {
          if (m.lost) { P.lost.push({ at: now, ...m.lost }); return; }
          const { ev, lag, errors, ...rest } = m; const off = m.origin - performance.timeOrigin;
          P.wperf.push({ at: now, ...rest });
          for (const x of ev) P.wev.push({ at: now, pt: x.t + off, ...x });
          for (const x of lag) P.wlag.push({ at: now, pt: x.t + off, ...x });
          for (const x of errors) P.werr.push({ at: now, pt: (x.t ?? 0) + off, ...x });
        } else if (m.type === "__perfLabels") P.labels = m.labels;
        else if (m.type === "lost" || m.type === "gpuerror" || m.type === "windowError" || m.type === "error") P.msgs.push([now, m.type, String(m.why ?? m.error ?? "").slice(0, 300)]);
        else P.msgs.push([now, m.type, m.type === "progress" ? m.what : m.type === "ground" ? (m.id ?? m.gid ?? "") : m.type === "windowObjects" ? `${m.objects}|${m.ms}` : ""]);
        if (P.msgs.length > 20000) P.msgs.splice(0, 10000);
      });
    }
  };
  const loop = (t: number) => { P.raf.push(t); if (P.raf.length > 60000) P.raf.splice(0, 30000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) P.loaf.push([e.startTime, e.duration, e.blockingDuration, (e.scripts ?? []).map((s: any) => `${s.invoker || s.type}:${(s.sourceURL || "").split("/").pop()}:${Math.round(s.duration)}`).slice(0, 3)]); }).observe({ type: "long-animation-frame", buffered: true } as any); } catch {}
  new MutationObserver(() => {
    const g = document.getElementById("gpu");
    if (g && !P.gpuVisible && g.style.visibility !== "hidden") P.gpuVisible = performance.now();
    if (!P.readyAt && document.body.classList.contains("ready")) P.readyAt = performance.now();
  }).observe(document, { subtree: true, attributes: true, childList: true });
  (P as any).take = () => { const o = { raf: P.raf, frames: P.frames, sent: P.sent, msgs: P.msgs, long: P.long, loaf: P.loaf, wperf: P.wperf, wev: P.wev, wlag: P.wlag, werr: P.werr, lost: P.lost.slice(), tiles: P.tiles, labels: P.labels, heap: (performance as any).memory?.usedJSHeapSize ?? 0, now: performance.now() }; P.raf = []; P.frames = []; P.sent = []; P.msgs = []; P.long = []; P.loaf = []; P.wperf = []; P.wev = []; P.wlag = []; P.werr = []; return o; };
};

export interface Run { browser: any; page: any; pid: number; errs: string[]; cons: [number, string][]; close: () => Promise<void>; t0: number }

export async function launch(opts: { vw?: number; vh?: number; dpr?: number; profile?: string; keepProfile?: boolean } = {}): Promise<Run> {
  const vw = opts.vw ?? 1600, vh = opts.vh ?? 1000, dpr = opts.dpr ?? 1, profile = opts.profile ?? "/tmp/globe-fix-lead/chrome";
  if (!opts.keepProfile) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000,
    args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${vw},${vh + 143}`, `--user-data-dir=${profile}`, "--enable-precise-memory-info", "--no-first-run", "--no-default-browser-check"],
    defaultViewport: { width: vw, height: vh, deviceScaleFactor: dpr },
  });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await browser.close(); } catch {} try { browser.process()?.kill("SIGKILL"); } catch {} };
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, async () => { await close(); process.exit(130); });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errs: string[] = [], cons: [number, string][] = [];
  const t0 = Date.now();
  page.on("pageerror", (e: Error) => errs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s pageerror ${e.message}`));
  page.on("console", (m: any) => { const t = m.text(); cons.push([Date.now() - t0, t.slice(0, 300)]); if (/WEBGPU|WebGPU|lost|error|Error/.test(t)) errs.push(`${((Date.now() - t0) / 1000).toFixed(1)}s console ${t.slice(0, 300)}`); });
  await page.evaluateOnNewDocument(INIT);
  return { browser, page, pid: browser.process()!.pid!, errs, cons, close, t0 };
}

export async function load(r: Run, query = "?zoom=island&hour=13", wait = 150000) {
  const t = performance.now();
  await r.page.goto(`${SITE}/play/${query}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const tGoto = performance.now() - t;
  await r.page.waitForSelector("body.ready", { timeout: wait });
  const ready = performance.now() - t;
  const info = await r.page.evaluate(() => { const P = (window as any).__perf; const nav = performance.getEntriesByType("navigation")[0] as any; return { firstDone: P.firstDone, gpuVisible: P.gpuVisible, readyAt: P.readyAt, revealMs: (window as any).play?.metrics?.revealMs, readyMs: (window as any).play?.metrics?.readyMs, domContentLoaded: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd, dataset: { ...document.body.dataset }, t0: P.t0 }; });
  return { tGoto, ready, ...info };
}

// ---- statistics ----
export const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };
export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
export const f = (x: number, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);
export function stat(xs: number[], d = 2) { return { n: xs.length, mean: f(mean(xs), d), p50: f(pct(xs, 0.5), d), p95: f(pct(xs, 0.95), d), p99: f(pct(xs, 0.99), d), max: f(xs.length ? Math.max(...xs) : NaN, d) }; }

export function summarize(d: any, t0 = 0, t1 = Infinity) {
  const inR = (t: number) => t >= t0 && t <= t1;
  const raf = d.raf.filter(inR), dt: number[] = [];
  for (let i = 1; i < raf.length; i++) dt.push(raf[i] - raf[i - 1]);
  const fr = d.frames.filter((x: any) => inR(x[0])), gpu = fr.map((x: any) => x[2]).filter((x: number) => x > 0), cpu = fr.map((x: any) => x[3]);
  const gap: number[] = []; for (let i = 1; i < fr.length; i++) gap.push(fr[i][0] - fr[i - 1][0]);
  const sent = d.sent.filter((x: any) => inR(x[0])), sentAt = new Map(d.sent.map((x: any) => [x[1], x[0]]));
  const lat = fr.map((x: any) => (sentAt.has(x[1]) ? x[0] - (sentAt.get(x[1]) as number) : NaN)).filter(Number.isFinite);
  const passes: Record<string, number[]> = {};
  for (const x of fr) if (x[5]) for (const [k, v] of Object.entries(x[5])) (passes[k] ??= []).push(v as number);
  const long = d.long.filter((x: any) => inR(x[0])).map((x: any) => x[1]);
  const loaf = d.loaf.filter((x: any) => inR(x[0]));
  const dur = (t1 === Infinity ? (raf.at(-1) ?? 0) : t1) - (t0 || raf[0] || 0);
  return {
    seconds: f(dur / 1000, 1),
    rafHz: f((raf.length - 1) / (dur / 1000), 1),
    rafDt: stat(dt, 1), rafOver20: dt.filter((x) => x > 20).length, rafOver33: dt.filter((x) => x > 33.5).length, rafOver50: dt.filter((x) => x > 50).length, rafOver100: dt.filter((x) => x > 100).length,
    framesDone: fr.length, framesSent: sent.length, dropped: Math.max(0, sent.length - fr.length), doneHz: f(fr.length / (dur / 1000), 1),
    gapMs: stat(gap, 1), gapOver33: gap.filter((x) => x > 33.5).length, gapOver100: gap.filter((x) => x > 100).length,
    gpuMs: stat(gpu), cpuMs: stat(cpu), latMs: stat(lat, 1),
    passes: Object.fromEntries(Object.entries(passes).map(([k, v]) => [k, { mean: f(mean(v)), p95: f(pct(v, 0.95)) }])),
    longTasks: { n: long.length, sum: Math.round(long.reduce((a: number, b: number) => a + b, 0)), max: Math.round(Math.max(0, ...long)) },
    loaf: { n: loaf.length, maxDur: Math.round(Math.max(0, ...loaf.map((x: any) => x[1]))), blockMax: Math.round(Math.max(0, ...loaf.map((x: any) => x[2]))) },
    workerStalls: d.wlag.filter((x: any) => inR(x.pt)).length, workerStallMax: Math.max(0, ...d.wlag.filter((x: any) => inR(x.pt)).map((x: any) => x.ms)),
  };
}

// ---- input ----
export async function drag(page: any, x0: number, y0: number, x1: number, y1: number, ms: number, button: "left" | "right" = "left") {
  await page.mouse.move(x0, y0);
  await page.mouse.down({ button });
  const n = Math.max(2, Math.round(ms / 16)), s = performance.now();
  for (let i = 1; i <= n; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); const wait = s + (i * ms) / n - performance.now(); if (wait > 0) await sleep(wait); }
  await page.mouse.up({ button });
}
export async function wheel(page: any, x: number, y: number, dy: number, times: number, gap = 50) { await page.mouse.move(x, y); for (let i = 0; i < times; i++) { await page.mouse.wheel({ deltaY: dy }); await sleep(gap); } }

export async function pageState(page: any) {
  return page.evaluate(() => { const P = (window as any).play, L = P.live; const w = L.stats.window; return { zoom: P.view.zoom, goal: P.camera.goal, mode: L.mode, geo: P.view.geo && { lat: P.view.geo.lat, lon: P.view.geo.lon }, alpha: L.stats.ladderAlpha, window: w && { id: w.id, objects: w.objects, share: w.share, objectsMs: w.objectsMs, blocks: w.blocks, made: w.made }, tiles: L.stats.tiles, counts: L.stats.counts, zmin: L.zmin, zmax: L.zmax, gpuMs: L.stats.gpuMs, renderer: L.renderer() }; });
}
export const take = (page: any) => page.evaluate(() => (window as any).__perf.take());
export const netlog = async (clear = true) => { const r = await fetch(`${SITE}/__net`); return (await r.json()) as any[]; };

export function procs(pid: number) {
  const out = execSync("ps -A -o pid=,ppid=,rss=,command=", { maxBuffer: 1 << 26 }).toString().split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m![1], ppid: +m![2], rssMB: +m![3] / 1024, cmd: m![4] }));
  const set = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const p of out) if (!set.has(p.pid) && set.has(p.ppid)) { set.add(p.pid); grew = true; } }
  const mine = out.filter((p) => set.has(p.pid));
  const kind = (c: string) => (/--type=gpu-process/.test(c) ? "gpu" : /--type=renderer/.test(c) ? "renderer" : /--type=utility/.test(c) ? "utility" : /--type=/.test(c) ? "other" : "browser");
  const by: Record<string, number> = {};
  for (const p of mine) by[kind(p.cmd)] = (by[kind(p.cmd)] ?? 0) + p.rssMB;
  return { by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v)])), total: Math.round(mine.reduce((a, p) => a + p.rssMB, 0)), pids: mine.map((p) => ({ pid: p.pid, kind: kind(p.cmd), rss: Math.round(p.rssMB) })) };
}
export function footprint(pid: number): number | null {
  try { const s = execSync(`footprint -p ${pid} 2>/dev/null | grep -i "phys_footprint:" | head -1`, { timeout: 8000 }).toString(); const m = /phys_footprint:\s*([\d.]+)\s*(\w+)/i.exec(s); if (!m) return null; const v = +m[1]; return m[2].startsWith("G") ? v * 1024 : m[2].startsWith("K") ? v / 1024 : v; } catch { return null; }
}
export const save = (name: string, obj: any) => writeFileSync(`/tmp/globe-fix-lead/out/${name}.json`, JSON.stringify(obj, null, 1));
mkdirSync("/tmp/globe-fix-lead/out", { recursive: true });

export async function workerHeap(page: any): Promise<{ used: number; total: number }[]> {
  const out: any[] = [];
  for (const w of page.workers()) { try { const c = (w as any).client; const h = await c.send("Runtime.getHeapUsage"); out.push({ url: String(w.url()).split("/").pop(), used: Math.round(h.usedSize / 1e6), total: Math.round(h.totalSize / 1e6) }); } catch (e) { out.push({ url: String(w.url()).split("/").pop(), err: String(e).slice(0, 80) }); } }
  return out;
}
export async function pageHeap(page: any) { const m = await page.metrics(); return { jsHeapMB: Math.round(m.JSHeapUsedSize / 1e6), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents }; }

export async function settleTo(page: any, geo: number[] | null, z: number, maxMs = 25000) {
  return page.evaluate(async (zz: number, g: number[] | null, maxMs: number) => {
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
  }, z, geo, maxMs);
}
