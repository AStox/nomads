// the same stills on two builds: mean absolute difference per place
import { launch, sleep, settleTo } from "./lib";
import { sharp } from "./lib";
const sites = [process.argv[2], process.argv[3]];
const places: [string, number[] | null, number][] = [["home", null, 8.3], ["A6", [4.35, -39.38], 6.5], ["B4", [-5.38, 73.13], 4.5], ["A3", [4.35, -39.38], 3.2], ["A-2", [4.35, -39.38], -2]];
const shots: Record<string, Buffer[]> = {};
for (const site of sites) {
  const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await r.page.evaluate(() => (window as any).play.live.debug.hold(1000));
    for (const [name, geo, z] of places) {
      if (geo) await settleTo(r.page, geo, z, 30000); else { await r.page.evaluate((zz: number) => (window as any).play.camera.setZoom(zz), z); await sleep(6000); }
      await sleep(2500);
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
