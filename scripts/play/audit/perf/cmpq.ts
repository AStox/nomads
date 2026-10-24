// the same stills on two builds with a query (QUERY, default the ladder's own ground), mean absolute difference per place; PLACES="name:lat,lon:zoom;..." overrides
import { launch, sleep, settleTo, sharp } from "./lib";
const sites = [process.argv[2], process.argv[3]];
const query = process.env.QUERY ?? "?hour=13&warm=0&pg=0";
const def = "D9:16.11,43.64:9.2;D7:16.11,43.64:7.5;D6:16.11,43.64:6;A6:4.35,-39.38:6.5;B4:-5.38,73.13:4.5;A3:4.35,-39.38:3.2";
const places = (process.env.PLACES ?? def).split(";").map((s) => { const [n, g, z] = s.split(":"); return [n, g.split(",").map(Number), +z] as [string, number[], number]; });
const shots: Record<string, Buffer[]> = {};
for (const site of sites) {
  const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
  try {
    await r.page.goto(`${site}/play/${query}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
    for (const [name, geo, z] of places) {
      await settleTo(r.page, geo, z, 30000);
      await sleep(3000);
      (shots[name] ??= []).push((await r.page.screenshot({ type: "png" })) as Buffer);
    }
  } finally { await r.close(); }
}
for (const [name] of places) {
  const [a, b] = shots[name];
  const A = await sharp(a).removeAlpha().raw().toBuffer(), Bm = await sharp(b).removeAlpha().raw().toBuffer();
  let d = 0, n = 0; for (let i = 0; i < A.length; i++) { const x = Math.abs(A[i] - Bm[i]); d += x; if (x > 8) n++; }
  console.log(name, "mean abs diff", (d / A.length).toFixed(3), "pixels>8:", ((100 * n) / A.length).toFixed(2) + "%");
}
process.exit(0);
