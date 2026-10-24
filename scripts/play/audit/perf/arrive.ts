// what a jump costs, in 250 ms buckets: frames done, gpu ms, worker events and stalls. zoom 3.2 vs 6 to an ocean place and a forest place.
//   lockf ... bun arrive.ts --tag=arr1
import { launch, load, take, sleep, save, SITE } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const tag = args.tag ?? "arr";
const CASES: [string, number[], number][] = [["ocean z3.2", [25.77, -45.48], 3.2], ["ocean z6", [34.06, 10.52], 6], ["forest A z3.2", [4.35, -39.38], 3.2], ["forest A z6", [4.8, -39.0], 6], ["B z3.2", [-5.38, 73.13], 3.2], ["ocean z3.2 again", [-48.77, 145.55], 3.2]];
const r = await launch({ profile: "/tmp/globe-fix-lead/chrome" });
const out: any = { cases: [] };
try {
  await load(r, "?hour=13"); await sleep(1000);
  for (const [name, g, z] of CASES) {
    // park somewhere far and idle first
    await r.page.evaluate((zz: number) => { const P = (window as any).play; P.view.geo = { lat: 10, lon: 10 }; P.camera.setZoom(zz); }, 1);
    await sleep(2500); await take(r.page);
    const tj = await r.page.evaluate((gg: number[], zz: number) => { const P = (window as any).play; P.view.geo = { lat: gg[0], lon: gg[1] }; P.camera.setZoom(zz); return performance.now(); }, g, z);
    await sleep(6000);
    const d = await take(r.page);
    const B = 250, nb = 24, buckets: any[] = [];
    for (let i = 0; i < nb; i++) {
      const lo = tj + i * B, hi = lo + B;
      const fr = d.frames.filter((x: any) => x[0] >= lo && x[0] < hi), sent = d.sent.filter((x: any) => x[0] >= lo && x[0] < hi);
      const evs = d.wev.filter((e: any) => e.pt >= lo && e.pt < hi && e.ms >= 5 && e.kind !== "mapAsync").map((e: any) => `${e.kind}${e.label ? ":" + e.label : ""}:${Math.round(e.ms)}`);
      const lag = d.wlag.filter((e: any) => e.pt >= lo && e.pt < hi).map((e: any) => Math.round(e.ms));
      const msgs = d.msgs.filter((m: any) => m[0] >= lo && m[0] < hi && m[1] !== "check").map((m: any) => m[1] + (m[2] ? ":" + m[2] : ""));
      buckets.push({ t: i * B, done: fr.length, sent: sent.length, gpu: fr.length ? +(fr.reduce((a: number, x: any) => a + (x[2] || 0), 0) / fr.length).toFixed(1) : null, cpu: fr.length ? +(Math.max(...fr.map((x: any) => x[3]))).toFixed(1) : null, lag, evs: evs.slice(0, 5), msgs });
    }
    out.cases.push({ name, buckets });
    console.log(`== ${name}: frames done per 250ms: ${buckets.map((b) => b.done).join(" ")}`);
    console.log(`   worker stalls ms: ${buckets.map((b) => b.lag.join("+") || ".").join(" ")}`);
    console.log(`   gpu ms mean: ${buckets.map((b) => b.gpu ?? "-").join(" ")}`);
  }
} finally { save(tag, out); await r.close(); }
process.exit(0);
