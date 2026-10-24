// planet pass ablations on the scratch copy site-ab (port 8292): ?abl=<knobs>. One load per variant, a few zooms, idle gpu ms.
//   lockf /tmp/nomads-gpu.lock bun ablate.ts --variants=base,noplanet,n20 --zooms=1.5,4.5,9.2 --place=A --tag=abl1 [--vp=1600x1000]
import { launch, take, summarize, sleep, save, settleTo, SITE } from "./lib";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a)!; return [m[1], m[2] || "1"]; }));
const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], BB: [-35.9034, 43.5937] };
const variants = (args.variants ?? "base").split(";"), zooms = (args.zooms ?? "1.5,4.5,9.2").split(",").map(Number), geo = PLACES[args.place ?? "A"], vp = (args.vp ?? "1600x1000").split("x").map(Number), tag = args.tag ?? "abl", secs = Number(args.secs ?? 3) * 1000;
const out: any = { args, rows: [] };
const base = process.env.SITE_AB ?? "http://127.0.0.1:8292";
for (const v of variants) {
  const r = await launch({ vw: vp[0], vh: vp[1], profile: "/tmp/globe-fix-lead/chrome" });
  try {
    await r.page.goto(`${base}/play/?hour=13&abl=${v === "base" ? "" : v}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await r.page.waitForSelector("body.ready", { timeout: 120000 });
    const row: any = { v, z: {} };
    for (const z of zooms) {
      const st = await settleTo(r.page, geo, z, 25000);
      await take(r.page); await sleep(secs);
      const d = await take(r.page);
      const s = summarize(d);
      row.z[z] = { settle: st, lat: s.latMs, cpu: s.cpuMs, gpu: s.gpuMs, passes: Object.fromEntries(Object.entries(s.passes).map(([k, p]: any) => [k, p.mean])), raf: s.rafDt.mean, doneHz: s.doneHz };
      console.log(`${v} z ${z}: gpu ${s.gpuMs.mean} (p95 ${s.gpuMs.p95}) planet ${s.passes.planet?.mean ?? "-"} present ${s.passes.present?.mean ?? "-"} done ${s.doneHz}Hz lat ${s.latMs.mean} cpu ${s.cpuMs.mean} raf ${s.rafDt.mean}`);
    }
    out.rows.push(row);
  } catch (e) { console.error("CRASH", v, e); out.rows.push({ v, crash: String(e) }); } finally { await r.close(); }
}
save(tag, out);
process.exit(0);
