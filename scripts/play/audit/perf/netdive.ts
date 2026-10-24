// OPFS: which tiles a second dive fetches again
import { launch, load, sleep, take, netlog, save, settleTo } from "./lib";
const r = await launch({ profile: "/tmp/globe-fix-lead2/chrome" });
try {
  await load(r, "?hour=13"); await netlog();
  const out: any[] = [];
  for (let k = 0; k < 3; k++) {
    await r.page.evaluate(() => { const P = (window as any).play; P.view.geo = { lat: 4.35, lon: -39.38 }; P.camera.setZoom(-5); });
    await sleep(3000); await netlog();
    await r.page.evaluate(() => { (window as any).play.camera.setZoom(6.5); });
    await sleep(7000);
    const net = await netlog();
    const tiles = net.filter((x) => /tile\.gz|\.gt\.gz/.test(x.p)).map((x) => x.p.replace(/.*planets\/[^/]+\//, ""));
    const tiers: Record<string, number> = {}; for (const t of tiles) { const m = /pyramid\/t(\d)/.exec(t); const key = m ? "t" + m[1] : /groundtiles/.test(t) ? "ground" : "?"; tiers[key] = (tiers[key] ?? 0) + 1; }
    const dup = tiles.length - new Set(tiles).size;
    out.push({ k, n: tiles.length, tiers, dupWithinDive: dup, sample: tiles.slice(0, 6) });
    console.log(k, tiles.length, JSON.stringify(tiers), "dup", dup, tiles.slice(0, 4).join(" "));
  }
  // OPFS cache state, if the worker offers it
  const st = await r.page.evaluate(async () => { try { const root = await navigator.storage.getDirectory(); let n = 0, bytes = 0; const walk = async (d: any) => { for await (const [name, h] of d.entries()) { if (h.kind === "directory") await walk(h); else { n++; try { bytes += (await h.getFile()).size; } catch {} } } }; await walk(root); const est = await navigator.storage.estimate(); return { files: n, bytes, quota: est.quota, usage: est.usage }; } catch (e) { return String(e); } });
  console.log("opfs", JSON.stringify(st));
  save("netdive", { out, st });
} finally { await r.close(); }
process.exit(0);
