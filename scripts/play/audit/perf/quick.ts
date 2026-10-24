import { launch, load, sleep } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
try { await load(r, "?hour=13&warm=0"); await sleep(500); for (const [t, m] of r.cons) if (/QUICKV/.test(m)) console.log(m); } finally { await r.close(); }
process.exit(0);
