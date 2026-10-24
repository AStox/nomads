import { launch, sleep, SITE, sharp, take } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  const t0 = performance.now();
  await r.page.goto(`${SITE}/play/`, { waitUntil: "domcontentloaded" });
  const times = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 14, 20];
  for (const t of times) {
    const wait = t * 1000 - (performance.now() - t0); if (wait > 0) await sleep(wait);
    const s = await r.page.evaluate(() => { const P = (window as any).__perf, pl = (window as any).play; return { ready: document.body.classList.contains("ready"), gpu: P.gpuVisible, mode: pl?.live?.mode, zoom: pl?.view?.zoom, geo: pl?.view?.geo, win: pl?.live?.stats?.window?.objects, tiles: pl?.live?.stats?.tiles }; });
    const png: Buffer = await r.page.screenshot({ type: "png" });
    await sharp(png).resize(800, 500).jpeg({ quality: 80 }).toFile(`/tmp/globe-fix-lead/out/load-${String(t).replace(".", "_")}.jpg`);
    console.log(t, JSON.stringify(s));
  }
  const d = await take(r.page);
  console.log(JSON.stringify(d.msgs.filter((m: any) => ["progress", "ground", "objects", "windowObjects"].includes(m[1])).map((m: any) => [Math.round(m[0]), m[1], m[2]])));
} finally { await r.close(); }
process.exit(0);
