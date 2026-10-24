import { launch, load, take, summarize, pageState, sleep, save, procs, footprint, netlog } from "./lib";
const r = await launch();
try {
  await netlog();
  const info = await load(r, "?zoom=island&hour=13");
  console.log("load", JSON.stringify(info));
  const net = await netlog();
  console.log("net reqs", net.length, "bytes", net.reduce((a, x) => a + x.b, 0));
  await sleep(3000);
  await take(r.page);
  await sleep(5000);
  const d = await take(r.page);
  console.log(JSON.stringify(summarize(d), null, 1));
  console.log(JSON.stringify(await pageState(r.page)));
  console.log(JSON.stringify(procs(r.pid)));
  for (const p of procs(r.pid).pids) console.log(p.kind, p.pid, footprint(p.pid));
  console.log("errs", r.errs);
  console.log("last wperf", JSON.stringify(d.wperf.at(-1)));
  console.log("labels", JSON.stringify(d.labels?.slice(0, 12)));
} finally { await r.close(); }
process.exit(0);
