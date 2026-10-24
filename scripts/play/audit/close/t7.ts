// does the sprite field jump against the ground when the window changes? pan east at SPEED m/s at zoom Z; each 300 ms the drawn sprites (by id) and the camera; per step the median screen shift of sprites matched by id against the shift of the target geo (ground) through the planet camera
import { withBrowser, go, idle, PLACES, sleep, OUT } from "./lib.ts";
import { writeFileSync } from "node:fs";
const place = process.env.PLACE ?? "A", z = Number(process.env.Z ?? 4), speed = Number(process.env.SPEED ?? 900), secs = Number(process.env.SECS ?? 40);
await withBrowser(async (page) => {
  await go(page, PLACES[place], z);
  await page.evaluate(() => (window as any).play.live.debug.hold(false));
  const log: any[] = await page.evaluate(async (speed: number, secs: number) => {
    const P = (window as any).play, L = P.live, V = P.view, D = 180 / (Math.PI * 391100), out: any[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lon = V.geo.lon, lat = V.geo.lat, last = performance.now(); const t0 = last;
    let stop = false;
    const mover = () => { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; lon += speed * dt * D / Math.cos(lat * Math.PI / 180); V.geo = { lat, lon }; if (!stop) requestAnimationFrame(mover); };
    requestAnimationFrame(mover);
    while (performance.now() - t0 < secs * 1000) {
      await sleep(300);
      const dr = await L.debug.check({ op: "drawn" }), c = L.debug.camera(V, L.levelFor(V.zoom).L, 0);
      const sel = dr.filter((_: any, i: number) => i % 20 === 0).slice(0, 2500).map((q: any) => [c.dx + q.x * c.s, c.dy + q.y * c.s, q.wx, q.wz]);
      out.push({ t: Math.round(performance.now() - t0), win: L.stats.window?.id, vx: V.x, vz: V.z, lon: V.geo.lon, lat: V.geo.lat, n: dr.length, sp: sel, ppm: L.ppm(V.zoom) });
    }
    stop = true; return out;
  }, speed, secs);
  writeFileSync(`${OUT}/t7-${place}-${z}.json`, JSON.stringify(log));
  let prev: any = null;
  const vote = (A: number[][], B: number[][]) => { const h = new Map<string, number>(); const sub = (a: number[][]) => a.slice(0, 600); for (const p of sub(A)) for (const q of sub(B)) { const dx = Math.round((q[0] - p[0]) / 3) * 3, dy = Math.round((q[1] - p[1]) / 3) * 3; if (Math.abs(dx) > 600 || Math.abs(dy) > 600) continue; const k = dx + "," + dy; h.set(k, (h.get(k) ?? 0) + 1); } let best = ["", 0] as [string, number]; for (const e of h) if (e[1] > best[1]) best = e; return best; };
  for (const s of log) {
    if (prev && s.sp.length > 50 && prev.sp.length > 50) {
      const v = vote(prev.sp, s.sp), dlon = s.lon - prev.lon, eastM = dlon * 391100 * Math.PI / 180 * Math.cos(s.lat * Math.PI / 180), dt = (s.t - prev.t) / 1000;
      console.log(`t${s.t} win ${s.win}${s.win !== prev.win ? " SWITCH" : ""} n ${s.n} sprite shift vote ${v[0]} (${v[1]} votes) | true east ${eastM.toFixed(0)} m = ${(eastM * s.ppm).toFixed(0)} px if the sprites kept the ground; view plane x ${prev.vx.toFixed(0)} -> ${s.vx.toFixed(0)}`);
    }
    prev = s;
  }
});
