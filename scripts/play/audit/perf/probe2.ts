import { launch, sleep, take } from "./lib";
const site = process.argv[2];
for (let run = 0; run < 3; run++) {
  const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
  try {
    await r.page.goto(`${site}/play/?hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    await sleep(9000);
    const d = await take(r.page);
    console.log("run", run, d.msgs.filter((m: any) => m[1] === "progress" && String(m[2]).startsWith("WHY")).map((m: any) => String(m[2]).slice(3, 200)).join(" | "));
  } finally { await r.close(); }
}
process.exit(0);
