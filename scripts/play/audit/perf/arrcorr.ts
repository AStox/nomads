// Arrival after a far jump (e2e rounds 25 and 26): per place and zoom, a jump from 60 S 170 E, a screenshot of the middle of the page every ~120 ms, each correlated (3x3 Laplacian, as the tester's
// arrsettle.ts) with the last one, and what the page's worker did meanwhile (the `arr` check: pyramid tiles asked and held with their fetch, decode and put ms, the planet pass's level and fine share per draw,
// the window's want, build, ground message, switch, blocks).
//   lockf /tmp/nomads-gpu.lock bun arrcorr.ts [--seq=tester | --seq=A:2,A:3 | --places=A,B,R --zooms=2,3,4] [--secs=6] [--quiet] [--prof] [--reload [--cold] [--warm]] [--bw=MB/s --lat=ms]
//     [--shots=DIR] [--out=FILE] [--tag=name] [--notrace]
// SITE= picks the site (default http://127.0.0.1:8470/base), PROFILE= the browser's directory (default under ~/.cache/nomads-scratch/lead3; a fresh one each run unless --keep). The places are the tester's.
//   --seq=tester   the tester's twelve cases in his order, in one page: what an earlier case left resident and drawn stays, as it does for a player who jumps about.
//   --reload       the page is loaded anew for each case (nothing resident but the browser's file store); with --cold that store is emptied first, with --warm each case is run twice, cold then warm.
//   --quiet        no screenshots (they slow the page): the timeline only, and the idle check polled (busy, sprites, the ladder's alpha). --prof adds the page's and the worker's CPU profile by 0.5 s.
//   --bw --lat     slow the file server (perf/server.ts) after the page has loaded, as a tunnel does. --notrace: the site has no `arr` check (the published one); the tile and window timeline is then empty.
// Per case one JSON line: firstFrame (ms from the jump to the first picture drawn for it), firstCorr, t50 and t90 (first screenshot at or over that correlation with the last), popLuma and popDiff (the largest
// change of the frame's mean luma and of its mean absolute pixel difference between two screenshots from 150 ms on, and where), tiers (per pyramid tier: tiles, first and last arrival, fetch, decode and put ms,
// kB), cap (ms the planet pass's level first reached each whole level; a negative time is before the jump's first frame), fine (ms the fine share first reached 0.5 and 1), the window's wantAt, builtAt, postedAt,
// applyAt, appliedAt and the block's blockAt, frames (done: ms, gpu ms, cpu ms), sentT and raf (ms the page sent and drew a frame in the first 2 s), corr (every 3rd screenshot).
import { homedir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
export const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
export const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const SITE = process.env.SITE ?? "http://127.0.0.1:8470/base";
const PROFILE = process.env.PROFILE ?? join(homedir(), ".cache/nomads-scratch/lead3/arrive2-chrome");
// the e2e tester's places (arrsettle.ts): name -> lat, lon, hour
const ALL: Record<string, [number, number, number]> = { A: [4.35, -39.38, 13], B: [-35.9, 43.59, 13], R: [12.02, 83.89, 13], R2: [8.32, 88.3, 13], M: [-26.17, -36.17, 13], E2: [13.27, 45.0, 13], H: [47.78, 38.63, 13], S1: [25, 15, 13], S2: [15.02, -71.76, 20.5] };
const SEQ = "S1:2,S1:3,S2:2,S2:4,A:2,A:3,A:4,B:3,H:3,R:4,E2:2,M:3";
// the cases: --seq=A:2,A:3 (in that order, in one page: what an earlier case left resident and drawn stays), or --places x --zooms; --reload loads the page anew for each (nothing resident), --cold with it clears the browser's tile file store too
const cases: [string, number][] = args.seq ? (args.seq === "tester" ? SEQ : args.seq).split(",").map((c) => [c.split(":")[0], Number(c.split(":")[1])] as [string, number]) : (args.places ?? "A,B,R").split(",").flatMap((n) => (args.zooms ?? "2,3,4").split(",").map((z) => [n, Number(z)] as [string, number]));
const reload = !!args.reload, cold = !!args.cold, secs = Number(args.secs ?? 6), warm = !!args.warm, tag = args.tag ?? "arr";
const shotsDir = args.shots, outFile = args.out, buf: string[] = [];
const log = (...a: unknown[]) => { const l = a.map(String).join(" "); console.log(l); buf.push(l); if (outFile) writeFileSync(outFile, buf.join("\n") + "\n"); };
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const util = () => { try { return Number(/"Device Utilization %"=(\d+)/.exec(execSync("ioreg -r -d 1 -c IOAccelerator", { timeout: 4000 }).toString())?.[1]); } catch { return NaN; } };

const INIT = () => {
  const P: any = ((window as any).__arrp = { sent: [], done: [], msgs: [], raf: [] });
  const loop = (t: number) => { P.raf.push(t); if (P.raf.length > 20000) P.raf.splice(0, 10000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const OW = window.Worker;
  (window as any).Worker = class extends OW {
    constructor(u: any, o: any) {
      super(u, o);
      const pm = this.postMessage.bind(this);
      (this as any).postMessage = (m: any, t: any) => { if (m && m.type === "frame") P.sent.push([performance.now(), m.id, m.planet ? [m.planet.lift ?? null, m.planet.liftOrtho ?? null, m.planet.liftM ?? null, m.planet.ortho ?? null] : null]); return pm(m, t); };
      this.addEventListener("message", (e: MessageEvent) => {
        const m = e.data, now = performance.now();
        if (!m || typeof m !== "object") return;
        if (m.type === "frameDone") P.done.push([now, m.id, m.liftInfo?.tier ?? null, m.lift ?? null, m.liftInfo?.pyr ?? null, m.gpuMs ?? 0, m.cpuMs ?? 0]);
        else if (m.type === "ground" || m.type === "windowObjects") P.msgs.push([now, m.type, m.mode ?? m.id ?? m.gid ?? "", m.objects ?? 0]);
      });
    }
  };
};

const hp = (d: Buffer, W = 600, H = 400) => { const o = new Float32Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) o[y * W + x] = d[y * W + x] * 4 - d[y * W + x - 1] - d[y * W + x + 1] - d[(y - 1) * W + x] - d[(y + 1) * W + x]; return o; };
const corr = (a: Float32Array, b: Float32Array) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i += 2) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return s / Math.sqrt(na * nb + 1e-9); };
const mean = (d: Buffer) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i]; return s / d.length; };
const mad = (a: Buffer, b: Buffer) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// the self time of a CPU profile by function in [from, to) ms of the profile, and the busy share
function topSelf(p: any, from: number, to: number, n = 8) {
  const nodes = new Map<number, any>(); for (const x of p.nodes) nodes.set(x.id, x);
  const self = new Map<string, number>(); let t = 0, busy = 0, total = 0;
  p.samples.forEach((id: number, i: number) => {
    const dt = (p.timeDeltas[i] ?? 0) / 1000; t += dt;
    if (t < from || t >= to) return;
    const nd = nodes.get(id), fn = nd.callFrame.functionName || "(anon)"; total += dt;
    if (/^\((idle|root)\)/.test(fn)) return;
    busy += dt; const k = `${fn} ${String(nd.callFrame.url).split("/").pop()}:${nd.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + dt);
  });
  return { busyMs: Math.round(busy), of: Math.round(total), top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${Math.round(v)} ${k}`) };
}
const tierOf = (i: number) => { let t = 0; while (i >= (6 * (4 ** (t + 1) - 1)) / 3) t++; return t; };

mkdirSync(PROFILE, { recursive: true });
if (!args.keep) rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, protocolTimeout: 60000,
  args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1280,943", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
});
const bye = async () => { try { await browser.close(); } catch {} try { browser.process()?.kill("SIGKILL"); } catch {} process.exit(130); };
process.once("SIGINT", bye); process.once("SIGTERM", bye);
const errs: string[] = [];
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e: Error) => errs.push("pageerror " + e.message.slice(0, 200)));
  page.on("console", (m: any) => { const t = m.text(); if (/WEBGPU|WebGPU|lost|rror/.test(t)) errs.push("console " + t.slice(0, 200)); });
  await page.evaluateOnNewDocument(INIT);
  const t00 = Date.now();
  await page.goto(`${SITE}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("body.ready", { timeout: 120000 });
  log(`ready after ${Date.now() - t00} ms, site ${SITE}, gpu util ${util()}`);
  const throttle = (bw: number, lat: number) => fetch(`${new URL(SITE).origin}/__throttle?bw=${bw}&lat=${lat}`).catch(() => {});
  if (args.bw || args.lat) await throttle(Number(args.bw ?? 0), Number(args.lat ?? 0));
  const cdp = await page.createCDPSession();
  const check = (q: any) => page.evaluate((qq: any) => (window as any).play.live.debug.check(qq), q);
  const settle = async (maxMs = 14000) => {
    let quiet = 0; const t = Date.now();
    while (Date.now() - t < maxMs && quiet < 3) {
      await sleep(300);
      const r = await page.evaluate(async () => { const L = (window as any).play.live; const c = await L.debug.check({ op: "idle" }); return { busy: c.busy, flying: L.stats.tiles?.flying ?? 0 }; }).catch(() => ({ busy: true, flying: 1 }));
      quiet = !r.busy && !r.flying ? quiet + 1 : 0;
    }
    return Date.now() - t;
  };
  const shoot = async () => { const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88, clip: { x: 100, y: 100, width: 600, height: 400, scale: 1 } }); return Buffer.from(r.data, "base64"); };
  for (const [name, z] of cases) {
    const [lat, lon, hour] = ALL[name];
    for (let pass = 0; pass < (warm ? 2 : 1); pass++) {
      if (reload) {
        if (cold && pass === 0) await page.evaluate(async () => { const r = await navigator.storage.getDirectory(); try { await r.removeEntry("tilecache", { recursive: true }); } catch {} });
        await page.goto(`${SITE}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
        await page.waitForSelector("body.ready", { timeout: 120000 });
      }
      await page.evaluate((h: number) => { const el = document.querySelector("#hud input") as HTMLInputElement | null; if (el) { el.value = String(h); el.dispatchEvent(new Event("input", { bubbles: true })); } }, hour);
      await page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: -60, lon: 170 }; P.camera.setZoom(1); });
      await settle();
      if (!args.notrace) await check({ op: "arr" });
      await page.evaluate(() => { const p = (window as any).__arrp; p.sent.length = p.done.length = p.msgs.length = p.raf.length = 0; });
      const u0 = util();
      const wk = page.workers().find((x: any) => /worker\.js/.test(x.url())), wc = (wk as any)?.client;
      if (args.prof) { await cdp.send("Profiler.enable"); await wc.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await wc.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start"); await wc.send("Profiler.start"); }
      const t0: number = await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); return performance.now(); }, lat, lon, z);
      const shots: { t: number; d: Buffer; jpg?: Buffer }[] = [];
      const wall0 = Date.now();
      const poll: number[][] = [];
      while (args.quiet && Date.now() - wall0 < secs * 1000) {
        const r = await page.evaluate(async () => { const L = (window as any).play.live, c = await L.debug.check({ op: "idle" }); return [performance.now(), c.busy ? 1 : 0, c.sprites, c.asked, +(L.stats.ladderAlpha ?? -1).toFixed(2), L.stats.tiles?.flying ?? -1]; });
        poll.push([Math.round(r[0] - t0), ...r.slice(1)]);
        await sleep(50);
      }
      while (!args.quiet && Date.now() - wall0 < secs * 1000) {
        const ta = await page.evaluate(() => performance.now()), jpg = await shoot(), tb = await page.evaluate(() => performance.now());
        const d = await sharp(jpg).removeAlpha().greyscale().raw().toBuffer();
        shots.push({ t: (ta + tb) / 2 - t0, d, jpg: shotsDir ? jpg : undefined });
        await sleep(60);
      }
      const u1 = util();
      let prof: any = null;
      if (args.prof) { const pp = (await cdp.send("Profiler.stop")).profile, wp = (await wc.send("Profiler.stop")).profile; prof = { page: [[0, 1000], [1000, 2000]].map(([a, b]) => topSelf(pp, a, b)), worker: [[0, 500], [500, 1000], [1000, 2000]].map(([a, b]) => topSelf(wp, a, b)) }; }
      await settle(8000);
      const fin = await sharp(await shoot()).removeAlpha().greyscale().raw().toBuffer();
      const A = await page.evaluate(() => (window as any).__arrp), tr = args.notrace ? { origin: 0, ev: [] } : await check({ op: "arr" });
      const fh = hp(fin);
      if (args.quiet) shots.push({ t: 0, d: fin });
      const c = shots.map((s) => [Math.round(s.t), +corr(hp(s.d), fh).toFixed(2)] as [number, number]);
      const t50 = c.find((x) => x[1] >= 0.5), t90 = c.find((x) => x[1] >= 0.9);
      let popL = 0, popLAt = 0, popD = 0, popDAt = 0;
      for (let i = 1; i < shots.length; i++) { if (shots[i - 1].t < 150) continue; const dl = Math.abs(mean(shots[i].d) - mean(shots[i - 1].d)), dd = mad(shots[i].d, shots[i - 1].d); if (dl > popL) { popL = dl; popLAt = shots[i].t; } if (dd > popD) { popD = dd; popDAt = shots[i].t; } }
      // the worker's clock to the page's: both are performance.now() of their own start
      const off = (tr.origin || (await page.evaluate(() => performance.timeOrigin))) - (await page.evaluate(() => performance.timeOrigin)), W = (x: number) => x + off - t0;
      const ev: any[] = tr.ev.map((e: any[]) => [W(e[0]), ...e.slice(1)]);
      const firstSent = A.sent.find((s: number[]) => s[0] >= t0), firstDone = firstSent && A.done.find((d: number[]) => d[1] >= firstSent[1]);
      const tilesEv = ev.filter((e) => e[1] === "tile"), asks = ev.filter((e) => e[1] === "ask"), draws = ev.filter((e) => e[1] === "draw");
      const tiers: Record<number, any> = {};
      for (const e of tilesEv) { const t = e[3], o = (tiers[t] ??= { n: 0, last: 0, first: 1e9, ms: 0, fetchMs: 0, decMs: 0, putMs: 0, bytes: 0 }); o.n++; o.last = Math.max(o.last, e[0]); o.first = Math.min(o.first, e[0]); o.fetchMs += e[8]; o.decMs += e[9]; o.putMs += e[10]; o.bytes += e[7]; }
      for (const o of Object.values(tiers)) { o.first = Math.round(o.first); o.last = Math.round(o.last); o.fetchMs = Math.round(o.fetchMs); o.decMs = Math.round(o.decMs); o.putMs = Math.round(o.putMs); o.bytes = Math.round(o.bytes / 1024); }
      const capAt: Record<number, number> = {}, fineAt: Record<string, number> = {};
      for (const e of draws) { for (let k = 1; k <= 5; k++) if (e[2] >= k - 1e-3 && capAt[k] === undefined) capAt[k] = Math.round(e[0]); if (e[4] >= 0.5 && fineAt["0.5"] === undefined) fineAt["0.5"] = Math.round(e[0]); if (e[4] >= 0.999 && fineAt["1"] === undefined) fineAt["1"] = Math.round(e[0]); }
      const first = (n: string) => { const e = ev.find((x) => x[1] === n); return e ? Math.round(e[0]) : null; };
      const msgAt = (ty: string) => { const m = A.msgs.find((x: any[]) => x[1] === ty && x[0] >= t0); return m ? Math.round(m[0] - t0) : null; };
      const row = {
        sentLift: A.sent.filter((d: any[]) => d[0] >= t0).filter((_: unknown, i: number) => i % 6 === 0).slice(0, 24).map((d: any[]) => [Math.round(d[0] - t0), ...(d[2] ?? []).map((v: number | null) => (v === null ? null : Math.round(v * 100) / 100))]),
        drawT: draws.filter((e) => e[0] < 1400).filter((_, i) => i % 3 === 0).map((e) => [Math.round(e[0]), e[2], e[3], e[4], e[9], e[10]]),
        fineT: draws.filter((e, i) => i === 0 || e[4] !== draws[i - 1][4] || Math.abs(e[3] - draws[i - 1][3]) > 0.2).slice(0, 40).map((e) => [Math.round(e[0]), e[2], e[3], e[4]]),
        events: ev.filter((e) => !["draw", "tile", "ask"].includes(e[1])).map((e) => [Math.round(e[0]), ...e.slice(1)]),
        prof, poll,
        raf: A.raf.filter((t: number) => t >= t0 && t < t0 + 2000).map((t: number) => Math.round(t - t0)),
        sentT: A.sent.filter((d: number[]) => d[0] >= t0 && d[0] < t0 + 2000).map((d: number[]) => Math.round(d[0] - t0)),
        frames: A.done.filter((d: number[]) => d[0] >= t0 && d[0] < t0 + 3000).map((d: number[]) => [Math.round(d[0] - t0), Math.round(d[5] * 10) / 10, Math.round(d[6] * 10) / 10]),
        lift: A.done.filter((d: number[]) => d[0] >= t0).filter((_: unknown, i: number) => i % 6 === 0).slice(0, 40).map((d: number[]) => [Math.round(d[0] - t0), +(d[2] ?? 0).toFixed(2), Math.round(d[3] ?? 0), Math.round(d[4] ?? 0)]),
        name: `${name} z${z}`, pass, util: [u0, u1], firstFrame: firstDone ? Math.round(firstDone[0] - t0) : null, firstCap: firstDone?.[2] ?? null, firstCorr: c[0][1], t50: t50?.[0] ?? null, t90: t90?.[0] ?? null,
        popLuma: [+popL.toFixed(2), Math.round(popLAt)], popDiff: [+popD.toFixed(2), Math.round(popDAt)], shots: shots.length,
        tiers, cap: capAt, fine: fineAt, askN: asks.length, tileN: tilesEv.length, ground: msgAt("ground"), objects: msgAt("windowObjects"), wantAt: first("want"), builtAt: first("built"), postedAt: first("posted"), applyAt: first("apply"), blockAt: first("block") ?? first("blockw"), stageAt: first("stage"), blocksDoneAt: first("blocksDone"), attachAt: first("attach"), attachedAt: first("attached"), appliedAt: first("applied"),
        corr: c.filter((_, i) => i % 3 === 0),
      };
      log(JSON.stringify({ ...row, mode: reload ? (cold && pass === 0 ? "cold" : "warm") : "seq" }));
      if (shotsDir) shots.forEach((s, i) => writeFileSync(join(shotsDir, `${tag}-${name}-z${z}-${String(i).padStart(2, "0")}-${Math.round(s.t)}.jpg`), s.jpg!));
    }
  }
  log("errors", errs.length, errs.slice(0, 3));
} finally {
  if (args.bw || args.lat) await fetch(`${new URL(SITE).origin}/__throttle?bw=0&lat=0`).catch(() => {});
  try { await browser.close(); } catch {}
  try { browser.process()?.kill("SIGKILL"); } catch {}
}
process.exit(0);
