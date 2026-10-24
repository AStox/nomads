// a long real pan at A: frames over 16 ms of GPU with their passes, and the page's rAF worst
import { launch, load, take, sleep, drag, settleTo, summarize } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "?hour=13&warm=0");
  await settleTo(r.page, [4.35, -39.38], Number(process.argv[2] ?? 6.5), 25000); await sleep(1500);
  await take(r.page);
  const t0 = Date.now();
  for (let k = 0; Date.now() - t0 < 20000; k++) { const dir = k % 8 < 6 ? 1 : -1; await drag(r.page, 800 - dir * 300, 500, 800 + dir * 300, 520, 500); }
  const d = await take(r.page), s = summarize(d);
  console.log("pan: doneHz", s.doneHz, "gpu", JSON.stringify(s.gpuMs), "rafMax", s.rafDt.max, "gap>100", s.gapOver100, "stallMax", s.workerStallMax, "dropped", s.dropped);
  for (const f of d.frames.filter((x: any) => x[2] > 16).slice(0, 14)) console.log(Math.round(f[0]), "gpu", f[2].toFixed(1), "apply", Math.round(f[4]), JSON.stringify(f[5]));
  console.log("windows", d.msgs.filter((m: any) => m[1] === "ground").length, "errs", r.errs.length, d.werr.length);
} finally { await r.close(); }
process.exit(0);
