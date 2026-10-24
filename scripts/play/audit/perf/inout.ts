// the same view reached zooming in from orbit and zooming out from close: mean luma of each and their mean absolute difference, per zoom (3.1). PLACE="lat,lon", ZS="1.6,2.4,..."
import { launch, sleep, sharp } from "./lib";
const site = process.env.SITE ?? "http://127.0.0.1:8271";
const [la, lo] = (process.env.PLACE ?? "16.11,43.64").split(",").map(Number), zs = (process.env.ZS ?? "1.2,1.8,2.4,2.8,3.2,3.6").split(",").map(Number);
const luma = (b: Buffer) => { let s = 0; for (let i = 0; i < b.length; i += 3) s += 0.2126 * b[i] + 0.7152 * b[i + 1] + 0.0722 * b[i + 2]; return s / (b.length / 3); };
const go = (page: any, z: number, ms: number) => page.evaluate(async (zz: number, ms: number) => { (window as any).play.camera.setZoom(zz); await new Promise((r) => setTimeout(r, ms)); }, z, ms);
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate((la: number, lo: number) => { const P = (window as any).play; P.live.debug.hold(1000); P.view.geo = { lat: la, lon: lo }; }, la, lo);
  const st = () => r.page.evaluate(() => { const L = (window as any).play.live; return { mode: L.mode, lift: +(L.stats.lift ?? 0).toFixed(1), alpha: +(L.stats.ladderAlpha ?? 0).toFixed(2), canopy: L.stats.canopy ?? null, li: L.stats.liftInfo }; });
  const shot = async () => sharp((await r.page.screenshot({ type: "png" })) as Buffer).removeAlpha().raw().toBuffer();
  const ins: Record<number, [Buffer, any]> = {};
  await go(r.page, -4, 3000);
  for (const z of zs) { await go(r.page, z, 9000); ins[z] = [await shot(), await st()]; }
  await go(r.page, 7, 12000);
  for (const z of [...zs].reverse()) {
    await go(r.page, z, 9000);
    const b = await shot(), sb = await st(), [a, sa] = ins[z];
    let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    console.log(`z ${z}: luma in ${luma(a).toFixed(1)} out ${luma(b).toFixed(1)} diff ${(d / a.length).toFixed(2)} | in ${JSON.stringify(sa)} out ${JSON.stringify(sb)}`);
    await sharp(a, { raw: { width: 1600, height: 1000, channels: 3 } }).png().toFile(`/tmp/globe-fix-lead2/out/inout-${z}-in.png`);
    await sharp(b, { raw: { width: 1600, height: 1000, channels: 3 } }).png().toFile(`/tmp/globe-fix-lead2/out/inout-${z}-out.png`);
  }
} finally { await r.close(); }
process.exit(0);
