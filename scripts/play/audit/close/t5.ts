// ground registration against the window plane: PG=0 (ladder's ground, in the window's cells) and PG=1 (planet pass) stills, sprites hidden, at plane offsets from the window's centre
import { withBrowser, go, shot, info, idle, PLACES, sleep } from "./lib.ts";
const place = process.env.PLACE ?? "A", z = Number(process.env.Z ?? 4), pg = process.env.PG ?? "1", tag = process.env.TAG ?? "t5";
const offs = (process.env.OFFS ?? "0,0;1000,0;2000,0;0,1500;-2500,0;0,-2500").split(";").map((s) => s.split(",").map(Number));
await withBrowser(async (page) => {
  await go(page, PLACES[place], z);
  const w0 = (await info(page)).win;
  for (const [ox, oz] of offs) {
    await page.evaluate((x: number, zz: number) => { const P = (window as any).play, L = P.live; L.debug.hold(false); P.view.x = x; P.view.z = zz; }, ox, oz);
    await sleep(800); await idle(page, 25000);
    await page.evaluate(() => { const L = (window as any).play.live; L.debug.hold(5000); L.debug.check({ op: "skip", names: ["*"] }); }); await sleep(1800);
    await shot(page, `${tag}-${place}-${z}-pg${pg}-${ox}_${oz}`);
    const i = await info(page); const v = await page.evaluate(() => { const P = (window as any).play; return [P.view.x, P.view.z, P.view.geo]; });
    console.log(ox, oz, "win", i.win, "start win", w0, "view", JSON.stringify(v.slice(0, 2).map((n: number) => +n.toFixed(0))), JSON.stringify(v[2]));
    await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: [] }));
  }
}, { q: `zoom=island&hour=13&warm=0&pg=${pg}&cn=0` });
