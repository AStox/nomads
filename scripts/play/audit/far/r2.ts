import { session, settle, setView, shot, OUT, sleep, sharp } from "./lib.ts";
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  const zmin = await page.evaluate(() => (window as any).play.live.zmin);
  const tiles: Buffer[] = [];
  const cases: [string, [number, number], number][] = [["Npole-zmin", [89.9, 10], zmin], ["Spole-zmin", [-89.9, 120], zmin], ["corner-zmin", [35.26, 45], zmin], ["Npole-z-3", [89.5, 10], -3], ["Spole-z-3", [-89.5, 120], -3], ["corner-z-3", [35.26, 45], -3], ["edge-z-3", [0, 45], -3], ["corner-z-1", [35.26, 45], -1], ["Npole-z0", [89.9, 10], 0], ["corner-z0", [35.26, 45], 0], ["corner-z2", [35.26, 45], 2]];
  for (const [nm, g, z] of cases) {
    await setView(page, g, z); const st = await settle(page, 6000); await sleep(500);
    const r = await shot(page, `r2-${nm}`); tiles.push(await sharp(r.png).resize(520).png().toBuffer()); console.log(nm, st.settled ? "" : "UNSETTLED", r.f);
  }
  const h = (await sharp(tiles[0]).metadata()).height!;
  await sharp({ create: { width: 3 * 524, height: Math.ceil(tiles.length / 3) * (h + 4), channels: 3, background: "#fff" } }).composite(tiles.map((t, i) => ({ input: t, left: (i % 3) * 524, top: Math.floor(i / 3) * (h + 4) }))).png().toFile(`${OUT}/r2-montage.png`);
  // pole drags: lat after each small drag
  const drag = async (label: string, g: [number, number], z: number, dx: number, dy: number, n: number) => {
    await setView(page, g, z); await settle(page, 5000); await sleep(300);
    await page.mouse.move(800, 500); await page.mouse.down(); const out: string[] = [];
    for (let i = 1; i <= n; i++) { await page.mouse.move(800 + dx * i / n, 500 + dy * i / n, { steps: 2 }); await sleep(120); const v = await page.evaluate(() => { const P = (window as any).play.view.geo; return [P.lat, P.lon]; }); out.push(`${v[0].toFixed(2)},${v[1].toFixed(2)}`); }
    await page.mouse.up(); console.log(label, "start", g.join(","), "z", z, "drag", dx, dy, "->", out.join(" | "));
  };
  await drag("pole-up", [80, 10], -3, 0, 200, 8);
  await drag("pole-down", [80, 10], -3, 0, -200, 8);
  await drag("pole-side", [85, 10], -3, 200, 0, 8);
  await drag("pole-diag", [85, 10], -3, 150, 150, 8);
  await drag("pole-near-side", [88.5, 10], -1, -300, 0, 8);
  await drag("zmin-lon-wrap", [0, 170], zmin, -300, 0, 8);
});
