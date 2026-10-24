import { launch, sleep } from "./lib";
import { sharp } from "./lib";
const [lat, lon] = [Number(process.argv[2]), Number(process.argv[3])];
const sites: [string, string][] = [["old", "http://127.0.0.1:8197"], ["new", "http://127.0.0.1:8239"]];
const zs = [1, -1, -2.5];
for (const [name, site] of sites) {
  const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=20.7&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
    for (const z of zs) {
      await r.page.evaluate((g: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz); }, [lat, lon], z);
      await r.page.evaluate(async () => { const L = (window as any).play.live, s = (t: number) => new Promise((r) => setTimeout(r, t)); const t0 = performance.now(); let q = 0; while (performance.now() - t0 < 30000 && q < 6) { await s(250); q = L.stats.tiles?.flying ? 0 : q + 1; } });
      await sleep(2500);
      await sharp((await r.page.screenshot({ type: "png" })) as Buffer).resize(800, 500).png().toFile(`/tmp/globe-fix-lead/out/lake-${name}-${z}.png`);
    }
  } finally { await r.close(); }
}
const rows = [];
for (const z of zs) { const a = await sharp(`/tmp/globe-fix-lead/out/lake-old-${z}.png`).toBuffer(), b = await sharp(`/tmp/globe-fix-lead/out/lake-new-${z}.png`).toBuffer(); rows.push(await sharp({ create: { width: 1608, height: 500, channels: 3, background: "#222" } }).composite([{ input: a, left: 0, top: 0 }, { input: b, left: 808, top: 0 }]).png().toBuffer()); }
for (let i = 0; i < zs.length; i++) await sharp(rows[i]).toFile(`/tmp/globe-fix-lead/out/lake-sbs-${zs[i]}.png`);
process.exit(0);
