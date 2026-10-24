// the largest ladder grid a view asked for (tilesMax) and the views cut to fit the tile map (tilesCut), over a zoom ladder at each place and a wheel sweep
import { launch, sleep } from "./lib";
const places: [string, number[]][] = [["A", [4.35, -39.38]], ["B", [-5.38, 73.13]], ["C", [16.8, 84.38]], ["M", [-26.17, -36.17]], ["R", [12.02, 83.89]], ["E2", [13.27, 45.0]], ["D", [16.11, 43.64]], ["home", [47.806, 38.63]]];
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await r.page.goto(`${process.env.SITE ?? "http://127.0.0.1:8231"}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await r.page.waitForSelector("body.ready", { timeout: 120000 });
  const read = () => r.page.evaluate(() => { const S = (window as any).play.live.stats; return [S.tilesMax ?? 0, S.tilesCut ?? 0, S.tiles ?? 0]; });
  for (const [name, geo] of places) {
    let top = 0, cut = 0, atZ = 0;
    for (let z = 9.2; z >= 2.8; z -= 0.6) {
      await r.page.evaluate((g: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: g[0], lon: g[1] }; P.camera.setZoom(zz); }, geo, z);
      await sleep(1800);
      const [mx, c] = await read(); if (mx > top) { top = mx; atZ = z; } cut = c;
    }
    console.log(`${name}: largest grid asked ${top} (at z ${atZ.toFixed(1)}), views cut so far ${cut}, limit 1048576`);
  }
  await r.page.mouse.move(800, 500);
  for (let i = 0; i < 40; i++) { await r.page.mouse.wheel({ deltaY: 100 }); await sleep(120); }
  for (let i = 0; i < 40; i++) { await r.page.mouse.wheel({ deltaY: -100 }); await sleep(120); }
  await sleep(2000);
  const [mx, c] = await read(); console.log(`after the wheel sweep: largest grid ${mx}, cut ${c}`);
} finally { await r.close(); }
process.exit(0);
