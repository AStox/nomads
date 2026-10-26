// a steady drag at planet zooms: the target's step per frame against the median step (a lurch is a frame that moves the ground many times as far as the mouse did). SITE, ZS, BEARINGS
import { launch, sleep, drag } from "./lib";
const site = process.env.SITE ?? "http://127.0.0.1:8271";
const zs = (process.env.ZS ?? "-2.5,-1.5,-0.1,0.49,1.5,2.4").split(",").map(Number), bears = (process.env.BEARINGS ?? "0,1").split(",").map(Number);
const places: [number, number][] = (process.env.PLACES ?? "0,65;20,40;-30,-40").split(";").map((s) => s.split(",").map(Number) as [number, number]);
const r = await launch({ profile: process.env.PROFILE ?? "/tmp/globe-fix-lead2/chrome", vw: 1280, vh: 800 });
try {
  await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  await r.page.evaluate(() => {
    const w = window as any; w.__g = [];
    const loop = () => { const v = w.play.view; if (v.geo) w.__g.push([performance.now(), v.geo.lat, v.geo.lon]); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const deg = (a: number[], b: number[]) => { const R = Math.PI / 180, c = Math.sin(a[1] * R) * Math.sin(b[1] * R) + Math.cos(a[1] * R) * Math.cos(b[1] * R) * Math.cos((a[2] - b[2]) * R); return Math.acos(Math.min(1, c)) / R; };
  for (const b of bears) for (const [la, lo] of places) for (const z of zs) {
    await r.page.evaluate((la: number, lo: number, z: number, b: number) => { const P = (window as any).play; P.view.bearing = b; P.view.geo = { lat: la, lon: lo }; P.camera.setZoom(z); }, la, lo, z, b);
    await sleep(2500);
    await r.page.evaluate(() => { (window as any).__g.length = 0; });
    await drag(r.page, 900, 405, 300, 405, 800);
    await sleep(300);
    const g: number[][] = await r.page.evaluate(() => (window as any).__g);
    const st: number[] = []; for (let i = 1; i < g.length; i++) st.push(deg(g[i - 1], g[i]));
    const moving = st.filter((x) => x > 1e-4).sort((a, b) => a - b), med = moving[Math.floor(moving.length / 2)] ?? 0, mx = Math.max(0, ...st);
    if (process.env.STEPS && mx / Math.max(med, 1e-9) > 2) console.log(st.map((x) => x.toFixed(2)).join(" "));
    console.log(`b ${b} (${la},${lo}) z ${z}: frames ${g.length} median step ${med.toFixed(3)} deg max ${mx.toFixed(3)} deg ratio ${(mx / Math.max(med, 1e-9)).toFixed(1)}`);
  }
} finally { await r.close(); }
process.exit(0);
