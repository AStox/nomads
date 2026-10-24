import { launch, load, take, sleep } from "../perf/lib";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await load(r, "?hour=13&warm=0"); await sleep(3000);
  await r.page.mouse.move(800, 500);
  for (let i = 0; i < 30; i++) { await r.page.mouse.wheel({ deltaY: 100 }); await sleep(170); }
  await sleep(2000);
  const d = await take(r.page);
  for (const m of d.msgs) if (m[1] === "gpuerror" || m[1] === "lost") console.log(Math.round(m[0]), m[1], m[2].slice(0,300));
} finally { await r.close(); }
process.exit(0);
