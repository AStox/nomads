import { launch, load, take, summarize, pageState, sleep, workerHeap, pageHeap, footprint, procs } from "./lib";
const r = await launch();
try {
  await load(r, "?zoom=island&hour=13");
  await sleep(1000);
  console.log(JSON.stringify(await workerHeap(r.page)), JSON.stringify(await pageHeap(r.page)));
  console.log(JSON.stringify(r.page.workers().map((w: any) => w.url())));
  for (const p of procs(r.pid).pids) if (p.kind === "gpu") console.log("gpu footprint", footprint(p.pid));
} finally { await r.close(); }
process.exit(0);
