// stills of places at zooms (PG=0 the ladder's ground, 1 the planet pass's; SKIP hides sprites): bun t4.ts  PL=M,K ZS=4,6.5,9
import { withBrowser, go, shot, info, PLACES, sleep } from "./lib.ts";
const pls = (process.env.PL ?? "A").split(","), zs = (process.env.ZS ?? "4,6.5,9").split(",").map(Number), tag = process.env.TAG ?? "t4", pg = process.env.PG ?? "";
await withBrowser(async (page) => {
  for (const p of pls) for (const z of zs) {
    await go(page, PLACES[p], z);
    if (process.env.SKIP) { await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: ["*"] })); await sleep(1500); }
    await shot(page, `${tag}-${p}-${z}${pg ? "-pg" + pg : ""}${process.env.SKIP ? "-skip" : ""}`);
    const i = await info(page); console.log(p, z, i.mode, i.win, "q", JSON.stringify(i.q?.map((v: number) => +v.toFixed(3))), "canopy", i.canopy?.toFixed(2), "share", i.share?.toFixed(3));
    if (process.env.SKIP) { await page.evaluate(() => (window as any).play.live.debug.check({ op: "skip", names: [] })); }
  }
}, { q: `zoom=island&hour=13&warm=0${process.env.PG ? "&pg=" + process.env.PG : ""}${process.env.CN ? "&cn=" + process.env.CN : ""}` });
