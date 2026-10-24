// window growth: leaks (cap.keys) and frame cost while resizing; bufLive / footprint per step
import { launch, load, sleep, take, summarize, settleTo, procs, footprint, save } from "./lib";
const r = await launch({ vw: 1000, vh: 700, profile: "/tmp/globe-fix-lead/chrome" });
const rows: any[] = [];
try {
  await load(r, "?hour=13");
  await settleTo(r.page, [4.35, -39.38], 6, 20000);
  const sizes: [number, number][] = [[1000, 700], [1200, 800], [1400, 900], [1600, 1000], [1800, 1100], [2000, 1200], [2200, 1300], [2400, 1400], [2000, 1200], [1000, 700], [2400, 1400], [2500, 1500]];
  for (const [w, h] of sizes) {
    await take(r.page);
    await r.page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await sleep(2500);
    const d = await take(r.page); const s = summarize(d); const wl = d.wperf.at(-1);
    const gp = procs(r.pid).pids.find((p) => p.kind === "gpu");
    rows.push({ w, h, buf: Math.round(wl.bufLive / 1e6), tex: Math.round(wl.texLive / 1e6), nBuf: wl.nBuf, nTex: wl.nTex, destroyed: wl.bufDestroyed, texDestroyed: wl.texDestroyed, gpu: s.gpuMs.mean, raf: s.rafDt, foot: gp ? footprint(gp.pid) : null });
    console.log(w, h, "buf", rows.at(-1).buf, "tex", rows.at(-1).tex, "nBuf", wl.nBuf, "gpu", s.gpuMs.mean, "rafMax", s.rafDt.max, "foot", rows.at(-1).foot);
  }
  save("resize", rows);
} finally { await r.close(); }
process.exit(0);
