import { launch, load, take, sleep } from "../perf/lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try {
  await load(r, "?hour=13&warm=0"); await sleep(3000);
  await r.page.mouse.move(800, 500);
  let all: any = { werr: [], msgs: [], big: [] };
  for (let i = 0; i < 30; i++) { await r.page.mouse.wheel({ deltaY: 100 }); await sleep(170); }
  await sleep(2000);
  const d = await take(r.page);
  console.log("werr", d.werr.length, JSON.stringify(d.werr.slice(0, 5)).slice(0, 800));
  const types: any = {}; for (const m of d.msgs) types[m[1]] = (types[m[1]] ?? 0) + 1; console.log(JSON.stringify(types));
  console.log("big", JSON.stringify(d.wev.filter((e: any) => e.kind === "big").slice(0, 10)));
  console.log("errs", r.errs.slice(0, 10));
  console.log("renderer", JSON.stringify(await r.page.evaluate(() => (window as any).play.live.renderer())).slice(0, 300));
} finally { await r.close(); }
process.exit(0);
