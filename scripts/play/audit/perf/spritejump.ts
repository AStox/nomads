// sprites drawn as the zoom crosses 2.8 to 3.4 in small steps, both ways: the largest change from one step to the next
import { launch, sleep } from "./lib";
const site = process.env.SITE ?? "http://127.0.0.1:8231";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: 4.35, lon: -39.38 }; P.camera.setZoom(3.5); });
  await sleep(9000);
  const run = (z0: number, z1: number) => r.page.evaluate(async (a: number, b: number) => {
    const P = (window as any).play, L = P.live, out: number[][] = [], s = (t: number) => new Promise((r) => setTimeout(r, t));
    const n = Math.round(Math.abs(b - a) / 0.02);
    for (let i = 0; i <= n; i++) { const z = a + ((b - a) * i) / n; P.camera.setZoom(z); await s(150); out.push([z, L.stats.counts?.sprites ?? 0, L.stats.counts?.points ?? 0, L.stats.ladderAlpha ?? 0]); }
    return out;
  }, z0, z1);
  for (const [a, b] of [[3.5, 2.7], [2.7, 3.5]]) {
    const rows = await run(a, b);
    let worst = 0, at = 0;
    for (let i = 1; i < rows.length; i++) { const d = Math.abs(rows[i][1] - rows[i - 1][1]); if (d > worst) { worst = d; at = rows[i][0]; } }
    console.log(`${a} -> ${b}: sprites ${Math.min(...rows.map((x) => x[1]))}..${Math.max(...rows.map((x) => x[1]))}, largest step ${worst} at z ${at.toFixed(2)}`);
  }
} finally { await r.close(); }
process.exit(0);
