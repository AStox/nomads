// forest edge: ground-only stills (CN=0 or 1 loaded by ?cn=) and the drawn sprites' places, at a place re-centred on a screen point of zoom 4
import { withBrowser, go, shot, info, idle, PLACES, sleep, OUT } from "./lib.ts";
import { writeFileSync } from "node:fs";
const place = process.env.PLACE ?? "A", CN = process.env.CN ?? "1", zs = (process.env.ZS ?? "5,7").split(",").map(Number);
const [ex, ey] = (process.env.EDGE ?? "408,306").split(",").map(Number), tag = process.env.TAG ?? "t2";
await withBrowser(async (page) => {
  await go(page, PLACES[place], 4);
  if (process.env.PLANE) {
    const [px, pz] = process.env.PLANE.split(",").map(Number);
    await page.evaluate((x: number, z: number) => { const P = (window as any).play; P.view.x = x; P.view.z = z; }, px, pz);
    await sleep(1500);
  } else if (process.env.EDGE !== "none") {
    const g = await page.evaluate((sx: number, sy: number) => { const P = (window as any).play, L = P.live, q = L.groundUnder(P.view, sx, sy); P.view.x = q.x; P.view.z = q.z; return q; }, ex, ey);
    console.log("edge point", JSON.stringify(g));
    await sleep(1500);
  }
  const geo = await page.evaluate(() => (window as any).play.view.geo); console.log("geo", JSON.stringify(geo));
  const PAN = process.env.PAN ? process.env.PAN.split(",").map(Number) : null;
  const cap = async (z: number, k: string) => {
    await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(600);
    await shot(page, `${tag}-${place}-${z}${k}-cn${CN}-full`);
    const d = await page.evaluate(async () => {
      const P = (window as any).play, L = P.live, dr = await L.debug.check({ op: "drawn" }), c = L.debug.camera(P.view, L.levelFor(P.view.zoom).L, 0);
      return { cam: { dx: c.dx, dy: c.dy, s: c.s, gx0: c.gx0, gy0: c.gy0, AW: c.AW, AH: c.AH, L: c.L }, n: dr.length, d: dr.map((q: any) => [q.x, q.y, q.wx, q.wz, q.src ?? 0]) , ppm: L.ppm(P.view.zoom), geo: P.view.geo, view: { x: P.view.x, z: P.view.z } };
    });
    writeFileSync(`${OUT}/${tag}-${place}-${z}${k}-cn${CN}.json`, JSON.stringify(d));
    await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: ["*"] })); await sleep(1500);
    await shot(page, `${tag}-${place}-${z}${k}-cn${CN}-ground`);
    await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: [] })); await sleep(500);
    console.log(z, k, d.n, "sprites", JSON.stringify(d.cam), "ppm", d.ppm, JSON.stringify(d.geo));
  };
  for (const z of zs) {
    await page.evaluate((zz: number) => { const P = (window as any).play, L = P.live; L.debug.hold(false); P.camera.setZoom(zz); }, z);
    await idle(page, 30000);
    await cap(z, "p0");
    if (PAN) {
      await page.evaluate(() => (window as any).play.live.debug.hold(false));
      await page.mouse.move(800, 500); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(800 + PAN[0] * i / 12, 500 + PAN[1] * i / 12); await sleep(30); }
      await page.mouse.up(); await sleep(300); await idle(page, 20000);
      await cap(z, "p1");
      await page.mouse.move(800, 500); await page.mouse.down();
      for (let i = 1; i <= 12; i++) { await page.mouse.move(800 - PAN[0] * i / 12, 500 - PAN[1] * i / 12); await sleep(30); }
      await page.mouse.up(); await sleep(300); await idle(page, 20000);
    }
  }
}, { q: `zoom=island&hour=13&warm=0${CN === "auto" ? "" : "&cn=" + CN}` });
