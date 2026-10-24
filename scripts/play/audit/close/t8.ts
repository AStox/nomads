// same camera geo, two windows: the sprites' screen shift between a window whose centre is far from the camera and one whose centre is near it, and the ground's (should be 0)
import { withBrowser, go, shot, idle, info, PLACES, sleep, OUT, hp, shiftSearch } from "./lib.ts";
const place = process.env.PLACE ?? "A", z = Number(process.env.Z ?? 4), FAR = Number(process.env.FAR ?? 2800), MOVE = Number(process.env.MOVE ?? 3800);
const snap = async (page: any, name: string) => {
  const d = await page.evaluate(async () => { const P = (window as any).play, L = P.live, dr = await L.debug.check({ op: "drawn" }), c = L.debug.camera(P.view, L.levelFor(P.view.zoom).L, 0); return { win: L.stats.window?.id, x: P.view.x, z: P.view.z, geo: P.view.geo, sp: dr.map((q: any) => [c.dx + q.x * c.s, c.dy + q.y * c.s]) }; });
  await shot(page, name);
  await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: ["*"] })); await sleep(1500);
  await shot(page, name + "-g");
  await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: [] })); await sleep(600);
  return d;
};
await withBrowser(async (page) => {
  await go(page, PLACES[place], z);
  await page.evaluate((x: number) => { const P = (window as any).play; P.live.debug.hold(false); P.view.x = x; P.view.z = 0; }, FAR);
  await sleep(1000); console.log("idle", await idle(page, 60000), await page.evaluate(() => (window as any).play.live.stats.window?.id)); await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
  const a = await snap(page, `t8-${place}-${z}-far`); console.log("far", a.win, "plane", a.x.toFixed(0), a.z.toFixed(0), JSON.stringify(a.geo));
  await page.evaluate((x: number) => { const P = (window as any).play; P.live.debug.hold(false); P.view.x = x; }, MOVE);
  for (let i = 0; i < 40; i++) { await sleep(700); const w = (await info(page)).win; if (w !== a.win) { console.log("switched to", w); break; } }
  await idle(page, 25000);
  await page.evaluate((g: any) => { const P = (window as any).play; P.view.geo = g; }, a.geo);
  await sleep(1000); await idle(page, 25000); await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
  const b = await snap(page, `t8-${place}-${z}-near`); console.log("near", b.win, "plane", b.x.toFixed(0), b.z.toFixed(0), JSON.stringify(b.geo));
  // vote the sprites' shift on the centre region
  const sel = (s: number[][]) => s.filter((p) => p[0] > 300 && p[0] < 1300 && p[1] > 200 && p[1] < 800);
  const A = sel(a.sp), B = sel(b.sp), h = new Map<string, number>();
  for (const p of A.slice(0, 4000)) for (const q of B.slice(0, 4000)) { const dx = Math.round(q[0] - p[0]), dy = Math.round(q[1] - p[1]); if (Math.abs(dx) > 500 || Math.abs(dy) > 500) continue; const k = dx + "," + dy; h.set(k, (h.get(k) ?? 0) + 1); }
  const top = [...h].sort((p, q) => q[1] - p[1]).slice(0, 4);
  console.log("sprite centre-region counts", A.length, B.length, "top shifts (px: votes)", JSON.stringify(top));
  const G0 = await hp(`${OUT}/t8-${place}-${z}-far-g.png`, 6), G1 = await hp(`${OUT}/t8-${place}-${z}-near-g.png`, 6);
  const gs = [[300, 200], [900, 200], [300, 550], [900, 550]].map(([x, y]) => shiftSearch(G0, G1, x, y, 300, 250, 40, undefined, 1).best.join(","));
  console.log("ground shift per block (px)", gs.join("  "), "ppm", (await info(page)).ppm);
});
