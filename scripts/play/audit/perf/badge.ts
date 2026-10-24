// does a use-after-destroy validation error flip the page's WEBGPU LOST badge while the device is alive?
import { launch, load, take, sleep, save } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await load(r, "?hour=13"); await sleep(500);
  const state = () => r.page.evaluate(() => { const L = (window as any).play.live, el = document.getElementById("render"); return { renderer: L.renderer(), badge: el && !el.hidden ? el.textContent : null, badgeTitle: el?.title ?? null }; });
  console.log("before", JSON.stringify(await state()));
  const FAR = [[49, 75], [17, 164], [-39.4, 39.8]];
  for (let c = 0; c < 12; c++) {
    const g = c % 2 === 0 ? [-5.38 + (Math.random() - 0.5) * 1.5, 73.13 + (Math.random() - 0.5) * 1.5] : FAR[c % 3];
    await r.page.evaluate((gg: number[]) => { const P = (window as any).play; P.view.geo = { lat: gg[0], lon: gg[1] }; P.camera.setZoom(3.2); }, g);
    await sleep(1500);
    const d = await take(r.page), s = await state();
    const bad = d.msgs.filter((m: any) => m[1] === "gpuerror" || m[1] === "lost").length;
    console.log(c, "gpuerror/lost msgs", bad, "device.lost entries", d.lost.length, "renderer", JSON.stringify(s.renderer).slice(0, 160), "badge", s.badge);
    if (s.renderer.why) break;
  }
  // after the badge, is the device alive? a render still completes
  await sleep(1000); const d2 = await take(r.page);
  console.log("frames after:", d2.frames.length, "last gpuMs", d2.frames.at(-1)?.[2]);
} finally { await r.close(); }
process.exit(0);
