// CPU-profile the render worker while panning at z3 (and a jump), to name the 1 s JS blocks
//   lockf ... bun profpan.ts --z=3 --what=pan
import { launch, load, take, sleep, save, drag, settleTo, summarize } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const z = Number(args.z ?? 3), what = args.what ?? "pan";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "?hour=13");
  if (what === "ocean") { await settleTo(r.page, [10, 10], 1, 8000); await sleep(1000); } else { await settleTo(r.page, [4.35, -39.38], z, 25000); await sleep(1500); }
  const w = r.page.workers().find((x: any) => /worker\.js/.test(x.url()));
  const c = (w as any).client;
  await c.send("Profiler.enable"); await c.send("Profiler.setSamplingInterval", { interval: 500 });
  await take(r.page);
  await c.send("Profiler.start");
  const t0 = Date.now();
  if (what === "pan") { for (let k = 0; Date.now() - t0 < 5000; k++) { const dir = k % 2 ? -1 : 1; await drag(r.page, 800 - dir * 250, 500, 800 + dir * 250, 540, 600); } }
  else if (what === "ocean") { await r.page.evaluate((zz: number) => { const P = (window as any).play; P.view.geo = { lat: 25.77, lon: -45.48 }; P.camera.setZoom(zz); }, z); await sleep(6000); const fin = await r.page.evaluate(async () => { const L = (window as any).play.live; const c = await L.debug.check({ op: "idle" }); return { busy: c?.busy, win: L.stats.window?.id, mode: L.mode, alpha: L.stats.ladderAlpha }; }); console.log("after 6 s", JSON.stringify(fin)); await sleep(8000); const fin2 = await r.page.evaluate(() => { const L = (window as any).play.live; return { win: L.stats.window?.id, mode: L.mode }; }); console.log("after 14 s", JSON.stringify(fin2)); }
  else { await r.page.evaluate(() => { (window as any).play.view.geo = { lat: -5.38, lon: 73.13 }; }); await sleep(5000); }
  const { profile } = await c.send("Profiler.stop");
  const d = await take(r.page); const s = summarize(d);
  console.log("frames", s.doneHz, "Hz; worker stall max", s.workerStallMax, "lag count", d.wlag.length, "top lag", d.wlag.map((x: any) => Math.round(x.ms)).sort((a: number, b: number) => b - a).slice(0, 8));
  // aggregate
  const nodes = new Map<number, any>(); for (const n of profile.nodes) nodes.set(n.id, n);
  const self = new Map<string, number>(); const total = new Map<string, number>();
  const parent = new Map<number, number>(); for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
  const key = (n: any) => `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").pop()}:${n.callFrame.lineNumber + 1}`;
  const dt = profile.timeDeltas as number[]; let tot = 0;
  profile.samples.forEach((id: number, i: number) => {
    const t = dt[i] ?? 0; tot += t;
    const n = nodes.get(id)!; self.set(key(n), (self.get(key(n)) ?? 0) + t);
    const seen = new Set<string>(); let cur: number | undefined = id;
    while (cur !== undefined) { const k = key(nodes.get(cur)!); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + t); } cur = parent.get(cur); }
  });
  const idle = self.get("(idle) :1") ?? 0;
  console.log(`profile ${(tot / 1000).toFixed(0)} ms total, idle ${(idle / 1000).toFixed(0)} ms`);
  const top = (m: Map<string, number>, n: number) => [...m.entries()].filter(([k]) => !/^\((idle|program|root)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v / 1000).toFixed(0)} ms  ${k}`);
  console.log("SELF\n" + top(self, 22).join("\n")); console.log("INCLUSIVE\n" + top(total, 30).join("\n"));
  save(`prof-${what}-${z}`, { self: top(self, 40), total: top(total, 60), lag: d.wlag, wev: d.wev.filter((e: any) => e.ms >= 20).slice(0, 40) });
} finally { await r.close(); }
process.exit(0);
