import { launch, load, sleep, save } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "");
  const rows: any[] = [];
  for (let i = 0; i < 20; i++) { rows.push(await r.page.evaluate(() => { const P = (window as any).play; return { t: Math.round(performance.now()), x: P.view.x, z: P.view.z, geo: P.view.geo && [P.view.geo.lat, P.view.geo.lon], zoom: P.view.zoom, bearing: P.view.bearing }; })); await sleep(1000); }
  console.log(JSON.stringify(rows.filter((_, i) => i % 3 === 0)));
  save("drift", rows);
} finally { await r.close(); }
process.exit(0);
