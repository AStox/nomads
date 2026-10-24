import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
const vp = (process.argv[2] ?? "1600x1000").split("x").map(Number) as [number, number];
const places: Record<string, [number, number]> = JSON.parse(process.argv[3]);
const zs = (process.argv[4] ?? "zmin,-3,-1.5,0,1.5,2.5").split(",");
const hour = process.argv[5] ?? "13";
await session(vp, `zoom=island&hour=${hour}&warm=0`, async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  for (const [name, geo] of Object.entries(places)) {
    const tiles: Buffer[] = [];
    for (const zz of zs) {
      const z = zz === "zmin" ? zmin : Number(zz);
      await setView(page, geo, z); const st = await settle(page, 6000); await sleep(400);
      const r = await shot(page, `tour-${name}-${vp[0]}x${vp[1]}-z${z.toFixed(2)}`);
      tiles.push(await sharp(r.png).resize(520).png().toBuffer());
      console.log(name, z.toFixed(2), st.settled ? "" : "UNSETTLED", r.f);
    }
    const cols = 3, rows = Math.ceil(tiles.length / cols), h = (await sharp(tiles[0]).metadata()).height!;
    await sharp({ create: { width: cols * 524, height: rows * (h + 4), channels: 3, background: "#fff" } }).composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 524, top: Math.floor(i / cols) * (h + 4) }))).png().toFile(`${OUT}/montage-${name}-${vp[0]}x${vp[1]}.png`);
  }
});
