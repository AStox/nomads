// load, wheel out from the opening view to orbit and back in; report errors, the badge and the frame rate at the ends
import { launch, load, take, sleep, summarize } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  const L = await load(r, "?hour=13&warm=0");
  console.log("ready", Math.round(L.ready), "firstDone", Math.round(L.firstDone), "gpuVisible", Math.round(L.gpuVisible), "readyAt", Math.round(L.readyAt));
  await sleep(4000);
  const st = async (tag: string) => { const d = await take(r.page); const s = summarize(d); const z = await r.page.evaluate(() => { const P = (window as any).play; return [P.view.zoom, P.live.renderer().gpu, P.live.mode]; }); console.log(tag, "zoom", (z[0] as number).toFixed(2), "gpu", z[1], z[2], "doneHz", s.doneHz, "gpuMs", s.gpuMs.mean, "max", s.gpuMs.max, "rafMax", s.rafDt.max, "werr", d.werr.length); };
  await st("home");
  await r.page.mouse.move(800, 500);
  for (let i = 0; i < 40; i++) { await r.page.mouse.wheel({ deltaY: 100 }); await sleep(120); }
  await sleep(2500); await st("orbit");
  for (let i = 0; i < 40; i++) { await r.page.mouse.wheel({ deltaY: -100 }); await sleep(120); }
  await sleep(6000); await st("back in");
  console.log("errs", r.errs.slice(0, 6).map((e) => e.slice(0, 200)));
} finally { await r.close(); }
process.exit(0);
