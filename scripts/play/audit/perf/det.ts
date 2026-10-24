// two loads of the opening view with the clock held: pictures at 8, 14 and 24 s after ready, and their differences
import { launch, sleep } from "./lib";
import { sharp } from "./lib";
const site = process.argv[2] ?? "http://127.0.0.1:8231", tag = process.argv[3] ?? "det";
const times = (process.env.TIMES ?? "8,14,24").split(",").map(Number);
for (let run = 0; run < 2; run++) {
  const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
  try {
    await r.page.evaluateOnNewDocument(() => {});
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
    const t0 = Date.now();
    for (const t of times) {
      await sleep(Math.max(0, t * 1000 - (Date.now() - t0)));
      const st = await r.page.evaluate(() => { const P = (window as any).play; const w = P.live.stats.window; return { z: P.view.zoom, x: P.view.x, zz: P.view.z, objs: w?.objects, share: w?.share, blocks: w?.blocks, sprites: P.live.stats.counts?.sprites, pts: P.live.stats.counts?.points }; });
      console.log(`run ${run} t ${t}`, JSON.stringify(st));
      await sharp((await r.page.screenshot({ type: "png" })) as Buffer).resize(800, 500).png().toFile(`/tmp/globe-fix-lead2/out/${tag}-${run}-${t}.png`);
    }
  } finally { await r.close(); }
}
const diff = async (a: string, b: string) => { const A = await sharp(`/tmp/globe-fix-lead2/out/${a}.png`).raw().toBuffer(), B = await sharp(`/tmp/globe-fix-lead2/out/${b}.png`).raw().toBuffer(); let s = 0; for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]); return (s / A.length).toFixed(2); };
for (const t of times) console.log("between loads at", t, await diff(`${tag}-0-${t}`, `${tag}-1-${t}`));
for (let run = 0; run < 2; run++) console.log("within load", run, "8 vs 24", await diff(`${tag}-${run}-8`, `${tag}-${run}-24`));
process.exit(0);
