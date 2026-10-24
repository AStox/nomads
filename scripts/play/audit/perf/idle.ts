// still camera: how many frames are drawn against skipped, and whether the picture stays
import { launch, load, take, sleep, summarize } from "./lib";
import { createHash } from "node:crypto";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "?hour=13&warm=0"); await sleep(5000);
  const hash = async () => createHash("md5").update(await r.page.screenshot({ type: "jpeg", quality: 60 })).digest("hex").slice(0, 8);
  const zooms = (process.argv[2] ?? "8.3,6,4,3.2,-1,-5").split(",").map(Number);
  for (const z of zooms) {
    await r.page.evaluate((zz: number) => (window as any).play.camera.setZoom(zz), z);
    await sleep(4500); await take(r.page);
    const h0 = await hash(); await sleep(3000);
    const d = await take(r.page), fr = d.frames, drawn = fr.filter((x: any) => x[2] > 0).length, h1 = await hash();
    const s = summarize(d);
    console.log(`z ${z}: frames ${fr.length} drawn ${drawn} skipped ${fr.length - drawn} gpuMs mean ${s.gpuMs.mean} picture ${h0 === h1 ? "same" : "CHANGED"} ${h0} ${h1}`);
  }
  console.log("errs", r.errs.slice(0, 5));
} finally { await r.close(); }
process.exit(0);
