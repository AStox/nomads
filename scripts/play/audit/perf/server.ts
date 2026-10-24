// static server for the frozen copy of the play site: no-store like scripts/play/serve.ts, logs every request (path, bytes, ms); GET /__net returns and clears the log; ?bw=<MB/s> and ?lat=<ms> throttle via /__throttle?bw=&lat=
import { join, normalize } from "node:path";
const PORT = Number(process.argv[2] ?? 8291), ROOT = process.argv[3] ?? "/tmp/globe-audit/perf/site";
let log: any[] = [], bw = 0, lat = 0;
const t0 = performance.now();
Bun.serve({ hostname: "127.0.0.1", port: PORT, idleTimeout: 30, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/__net") { const out = log; log = []; return Response.json(out); }
  if (url.pathname === "/__throttle") { bw = Number(url.searchParams.get("bw") ?? 0); lat = Number(url.searchParams.get("lat") ?? 0); return Response.json({ bw, lat }); }
  const s = performance.now();
  const path = normalize(decodeURIComponent(url.pathname));
  let file = Bun.file(join(ROOT, path));
  if (path.endsWith("/") || !(await file.exists())) {
    file = Bun.file(join(ROOT, path, "index.html"));
    if (!path.endsWith("/") && (await file.exists())) return new Response(null, { status: 301, headers: { Location: `${path}/${url.search}`, "Cache-Control": "no-store" } });
  }
  if (!(await file.exists())) { log.push({ p: path, st: 404, b: 0, at: s - t0 }); return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } }); }
  const size = file.size;
  if (lat) await Bun.sleep(lat);
  if (bw) await Bun.sleep((size / (bw * 1e6)) * 1000);
  log.push({ p: path, st: 200, b: size, at: s - t0, ms: performance.now() - s, range: req.headers.get("range") });
  return new Response(file, { headers: { "Cache-Control": "no-store" } });
} });
console.log(`perf site up ${PORT}`);
