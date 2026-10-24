import { launch, sleep, take } from "./lib";
const site = process.argv[2];
const outs: any[] = [];
for (let run = 0; run < 4; run++) {
  const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await sleep(10000);
    const d = await take(r.page);
    const w = d.msgs.filter((m: any) => m[1] === "progress" && String(m[2]).startsWith("WHY{")).at(-1);
    const j = JSON.parse(String(w?.[2]).slice(3));
    const sp = await r.page.evaluate(() => (window as any).play.live.stats.counts?.sprites);
    outs.push({ ...j, sprites: sp });
  } finally { await r.close(); }
}
const keys = Object.keys(outs[0]);
for (const k of keys) { const vals = outs.map((o) => JSON.stringify(o[k]).slice(0, 20000)); const same = vals.every((v) => v === vals[0]); console.log(same ? "same  " : "DIFF  ", k, same ? vals[0].slice(0, 120) : vals.map((v) => v.slice(0, 400)).join("\n      ")); }
process.exit(0);
