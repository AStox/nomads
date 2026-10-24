// window sizes and DPR: idle gpu ms at A z6 and z3, canvas size, one load each
import { launch, load, take, summarize, sleep, save, settleTo, sharp } from "./lib";
const SIZES: [number, number, number][] = [[1280, 720, 1], [1600, 1000, 1], [1920, 1080, 1], [2560, 1440, 1], [1440, 900, 2], [800, 600, 1]];
const out: any[] = [];
const deadline = Date.now() + 230000;
for (const [w, h, dpr] of SIZES) {
  if (Date.now() > deadline) break;
  const r = await launch({ vw: w, vh: h, dpr, profile: "/tmp/globe-fix-lead/chrome" });
  try {
    await load(r, "?hour=13");
    const row: any = { w, h, dpr, z: {} };
    for (const z of [3, 6, 9]) {
      await settleTo(r.page, [4.35, -39.38], z, 20000);
      await take(r.page); await sleep(3000);
      const d = await take(r.page); const s = summarize(d);
      row.z[z] = { gpu: s.gpuMs, passes: Object.fromEntries(Object.entries(s.passes).map(([k, p]: any) => [k, p.mean])), rafMean: s.rafDt.mean, doneHz: s.doneHz, dropped: s.dropped };
      if (z === 6) { const png: Buffer = await r.page.screenshot({ type: "png" }); row.shot = [(await sharp(png).metadata()).width, (await sharp(png).metadata()).height]; if (dpr === 2) await sharp(png).extract({ left: 300, top: 200, width: 400, height: 250 }).png().toFile("/tmp/globe-fix-lead/out/dpr2-crop.png"); }
    }
    row.canvas = await r.page.evaluate(() => { const c = document.getElementById("view") as HTMLCanvasElement, g = document.getElementById("gpu") as HTMLCanvasElement; return { view: [c.width, c.height], gpu: g && [g.width, g.height], dpr: devicePixelRatio, inner: [innerWidth, innerHeight] }; });
    out.push(row);
    console.log(w, h, dpr, JSON.stringify(row.canvas), Object.entries(row.z).map(([z, v]: any) => `z${z} gpu ${v.gpu.mean}/${v.gpu.p95} planet-ish present ${v.passes.present} hz ${v.doneHz}`).join(" | "));
  } catch (e) { console.error("CRASH", w, e); } finally { await r.close(); }
}
save("sizes", out);
process.exit(0);
