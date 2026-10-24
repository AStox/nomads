// the window's edge in view: A, zoom Z, camera moved east by DX m inside the window; luma profile along a row through the edge
import { launch, load, take, sleep, settleTo } from "./lib";
import { sharp } from "./lib";
const Z = Number(process.argv[2] ?? 3.2), DX = Number(process.argv[3] ?? 3000);
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "?hour=13&warm=0");
  await settleTo(r.page, [4.35, -39.38], Z, 30000); await sleep(1500);
  const info = await r.page.evaluate((dx: number) => { const P = (window as any).play, L = P.live; const w = L.stats.window; const b = { x: P.view.x, z: P.view.z, id: w?.id }; P.view.x += dx; return b; }, DX);
  await sleep(2500);
  const info2 = await r.page.evaluate(() => { const P = (window as any).play; return { x: P.view.x, z: P.view.z, id: P.live.stats.window?.id, ppm: P.live.debug?.ppm }; });
  console.log(JSON.stringify(info), JSON.stringify(info2));
  const png: Buffer = await r.page.screenshot({ type: "png" });
  await sharp(png).toFile(`/tmp/globe-fix-lead/out/edge-${Z}-${DX}.png`);
  const { data, info: im } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = im.width, strip = 20; const prof: number[] = [];
  for (let x0 = 0; x0 + strip <= W; x0 += strip) { let s = 0, n = 0; for (let y = 400; y < 600; y++) for (let x = x0; x < x0 + strip; x++) { s += data[y * W + x]; n++; } prof.push(+(s / n).toFixed(1)); }
  console.log("row luma by 20px:", prof.join(" "));
} finally { await r.close(); }
process.exit(0);
