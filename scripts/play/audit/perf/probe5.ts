// At a view held still: the worker's exact pick under the cursor (the ground and height the picture shows there) against its probe of the planet's tiers at the same place (what the anchor's surfaceY refreshes the held ground to),
// for a row of cursor places. A big gap is a place where the picture draws heights the tiers do not hold (the fine pages), and an anchor picked there is moved by the gap when the probe answers.
//   HINT=0 (the anchor's held height: pick's own plus HINT metres; unset: none, the probe starts from the tiers' blend) VIEW=4.0597,-40.1546 ZOOM=0.5 XS=700,760,820,880 YS=480 lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/probe5.ts      SITE, PROFILE
import { launch, sleep, load } from "./lib";
const HINT = process.env.HINT === undefined ? null : Number(process.env.HINT);
const [lat, lon] = (process.env.VIEW ?? "4.0597,-40.1546").split(",").map(Number), Z = Number(process.env.ZOOM ?? 0.5);
const XS = (process.env.XS ?? "700,760,820,880").split(",").map(Number), YS = (process.env.YS ?? "480").split(",").map(Number);
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, Z);
  await idle();
  // the camera clears the probe every frame it holds no anchor: keep ours
  await r.page.evaluate(() => { const L = (window as any).play.live, o = L.setProbe; (window as any).__probe = (g: any, y?: number) => o(g, y); L.setProbe = (g: any, y?: number) => { if (g) o(g, y); }; });
  for (const y of YS) for (const x of XS) {
    await r.page.mouse.move(x, y); await sleep(400);
    const a = await r.page.evaluate((px: number, py: number, hint: number | null) => { const w = window as any, P = w.play, A = P.live.groundUnder(P.view, px, py); w.__probe(A.geo, hint === null ? undefined : A.y + hint); w.__A = A; return { y: A.y, geo: A.geo }; }, x, y, HINT);
    await sleep(500);
    const b = await r.page.evaluate(() => { const P = (window as any).play, G = P.live.stats.ground; return { probe: G?.probe?.y, at: G?.probe && [G.probe.lat, G.probe.lon] }; });
    console.log(`cursor ${x},${y}: pick y ${a.y?.toFixed(0)}, probe y ${b.probe?.toFixed?.(0)}, gap ${(a.y - b.probe).toFixed(0)} m, mode ${(await r.page.evaluate(() => (window as any).play.live.mode))}`);
  }
} finally { await r.close(); }
process.exit(0);
