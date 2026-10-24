// the readout, the badge and the hour slider at several window widths: any pair of the page's HUD boxes that overlap (e2e 7). SITE, WIDTHS
import { launch, sleep } from "./lib";
const site = process.env.SITE ?? "http://127.0.0.1:8271";
const widths = (process.env.WIDTHS ?? "500,640,800,1000,1100,1280,1600").split(",").map(Number);
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome", vw: 1600, vh: 1000 });
try {
  await r.page.goto(site + "/play/?hour=13&warm=0", { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  for (const w of widths) {
    await r.page.setViewport({ width: w, height: 1000, deviceScaleFactor: 1 });
    await sleep(1500);
    const out = await r.page.evaluate(() => {
      const box = (s: string) => { const e = document.querySelector(s) as HTMLElement | null; if (!e || e.hidden || getComputedStyle(e).display === "none") return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const items: Record<string, any> = { hud: box("#hud"), badge: box("canvas#render"), clock: box("canvas#clock"), hint: box("#hint"), pad: box("#pad"), slider: box("#hud input") };
      const names = Object.keys(items).filter((k) => items[k] && k !== "slider"), hits: string[] = [];
      for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) { const a = items[names[i]], b = items[names[j]]; if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) hits.push(names[i] + "+" + names[j]); }
      return { hits, hud: items.hud, badge: items.badge };
    });
    console.log(w, out.hits.length ? "OVERLAP " + out.hits.join(",") : "clear", JSON.stringify(out.hud), JSON.stringify(out.badge));
  }
} finally { await r.close(); }
process.exit(0);
