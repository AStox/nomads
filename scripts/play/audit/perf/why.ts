import { launch, load, take, sleep } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await load(r, "?hour=13&warm=0"); await sleep(5000);
  for (const z of (process.argv[2] ?? "6,3.2").split(",").map(Number)) {
    await r.page.evaluate((zz: number) => (window as any).play.camera.setZoom(zz), z);
    await sleep(4500); await take(r.page);
    await sleep(4000);
    const d = await take(r.page);
    const w = d.msgs.filter((m: any) => m[1] === "progress" && String(m[2]).startsWith("WHY")).at(-1);
    console.log("z", z, String(w?.[2]).slice(0, 600));
  }
} finally { await r.close(); }
process.exit(0);
