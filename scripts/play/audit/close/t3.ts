// does the planet pass's ground pan at the rate of the sprites? drag by (DX,DY); sprite shift from the drawn list (matched by world place), ground shift from ground-only stills (cn=0: no crown speckle)
import { withBrowser, go, shot, info, idle, PLACES, sleep, OUT, sharp, shiftSearch } from "./lib.ts";
import { join } from "node:path";
const place = process.env.PLACE ?? "A", zs = (process.env.ZS ?? "3.3,4,6.5,9").split(",").map(Number), DX = Number(process.env.DX ?? 60), DY = Number(process.env.DY ?? 30);
const grey = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().greyscale().blur(5).raw().toBuffer({ resolveWithObject: true }); const o = new Float32Array(data.length); for (let i = 0; i < o.length; i++) o[i] = data[i]; return { d: o, w: info.width, h: info.height }; };
const dump = (page: any) => page.evaluate(async () => {
  const P = (window as any).play, L = P.live, dr = await L.debug.check({ op: "drawn" }), c = L.debug.camera(P.view, L.levelFor(P.view.zoom).L, 0);
  return { s: c.s, dx: c.dx, dy: c.dy, d: dr.map((q: any) => [q.x, q.y, q.wx, q.wz]) };
});
await withBrowser(async (page) => {
  for (const z of zs) {
    await go(page, PLACES[place], z);
    const D0 = await dump(page);
    await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: ["*"] })); await sleep(1200);
    await shot(page, `t3-${place}-${z}-g0`);
    await page.evaluate(() => (window as any).play.live.debug.hold(false));
    await page.mouse.move(800, 500); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(800 + DX * i / 12, 500 + DY * i / 12); await sleep(30); }
    await page.mouse.up(); await sleep(300); await idle(page, 15000);
    await page.evaluate(() => (window as any).play.live.debug.hold(5000)); await sleep(500);
    await shot(page, `t3-${place}-${z}-g1`);
    await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: [] })); await sleep(1200);
    const D1 = await dump(page);
    const key = (q: number[]) => `${Math.round(q[2] * 10)},${Math.round(q[3] * 10)}`;
    const m0 = new Map(D0.d.map((q: number[]) => [key(q), q]));
    const dxs: number[] = [], dys: number[] = [];
    for (const q of D1.d) { const p = m0.get(key(q)); if (p) { dxs.push((D1.dx + q[0] * D1.s) - (D0.dx + p[0] * D0.s)); dys.push((D1.dy + q[1] * D1.s) - (D0.dy + p[1] * D0.s)); } }
    const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const A = await grey(join(OUT, `t3-${place}-${z}-g0.png`)), B = await grey(join(OUT, `t3-${place}-${z}-g1.png`));
    const gs = [[300, 250], [900, 250], [300, 650], [900, 650]].map(([bx, by]) => shiftSearch(A, B, bx, by, 300, 250, 100, undefined, 1).best.join(","));
    console.log(z, "sprites matched", dxs.length, "of", D0.d.length, "median shift", med(dxs), med(dys), "| ground blocks", gs.join(" "), "| drag", DX, DY);
  }
});
