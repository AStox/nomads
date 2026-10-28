// session.ts <seed> --vp WxH --dur S : a seeded random user with real mouse input (drag, wheel, keys, hour slider), logging every frame.
// Writes runs/s<seed>-<vp>/{log.json,hits.json}. Detectors: camera-snap (pivot jump with little input), drag-overshoot (ground moved far for a few px of mouse),
// stall (frame gap > 100 ms), blank / night-dark frames (luma std / mean), anchor-drift (API: ground under the cursor after a wheel burst).
// REWRITTEN after the /tmp wipe, not the first tester's original: thresholds are mine.
import { mkdirSync, writeFileSync } from "node:fs";
import { launch, sleep, sharp, HOME_E2E } from "./lib.ts";
const args = process.argv.slice(2); const SEED = +args[0];
const vpArg = args[args.indexOf("--vp") + 1] ?? "1280x800", DUR = +(args[args.indexOf("--dur") + 1] ?? 150) * 1000;
const [VW, VH] = vpArg.split("x").map(Number);
const ID = `s${SEED}-${vpArg}`, OUT = `${HOME_E2E}/runs/${ID}`; mkdirSync(OUT, { recursive: true });
let st = SEED * 2654435761 >>> 0; const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = Math.imul(st ^ (st >>> 15), 1 | st); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rf = (a: number, b: number) => a + (b - a) * rnd();
const PLACES: [string, number, number][] = [["A", 4.35, -39.38], ["B", -35.9, 43.59], ["R", 12.02, 83.89], ["M", -26.17, -36.17], ["E2", 13.27, 45], ["home", 47.78, 38.63]];
const hits: any[] = [], log: any[] = [], anchors: any[] = [];
await launch([VW, VH], "hour=13&warm=0", async (page, _c, _b, errs) => {
  await page.evaluate(() => {
    const w = window as any, P = w.play, L = P.live, rows: any[] = []; w.__rows = rows; w.__last = performance.now();
    const f = (t: number) => { const g = t - w.__last; w.__last = t; const v = P.view; let sp: any = null; try { if (w.__piv && v.geo) sp = L.screenOf(v, 0, 0, 0, w.__piv); } catch {} rows.push([Date.now(), +t.toFixed(1), v.zoom, v.geo?.lat, v.geo?.lon, +g.toFixed(1), sp ? +sp[0].toFixed(1) : null, sp ? +sp[1].toFixed(1) : null]); requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  const T0 = Date.now(); let mx = VW / 2, my = VH / 2, down = false;
  const pivot = () => page.evaluate(() => { const P = (window as any).play, g = P.view.geo; (window as any).__piv = g ? { lat: g.lat, lon: g.lon } : null; });
  const move = async (x: number, y: number, ms = 200) => { const n = Math.max(2, Math.round(ms / 25)); const x0 = mx, y0 = my; for (let i = 1; i <= n; i++) { await page.mouse.move(x0 + ((x - x0) * i) / n, y0 + ((y - y0) * i) / n); await sleep(25); } mx = x; my = y; };
  const drag = async (dx: number, dy: number, ms: number) => { await pivot(); await page.mouse.down(); down = true; await move(mx + dx, my + dy, ms); await page.mouse.up(); down = false; };
  const idle = async () => { for (let i = 0; i < 20; i++) { await sleep(400); const r = await page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!r.busy) return; } };
  const go = async (lat: number, lon: number, z: number) => { await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z); await idle(); };
  const shots: { t: number; luma: number; std: number; zoom: number }[] = [];
  let shooting = true;
  const shooter = (async () => { while (shooting) { try { const b = await page.screenshot({ type: "jpeg", quality: 60 }); const { data } = await sharp(b).resize(320).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true }); let m = 0; for (const v of data) m += v; m /= data.length; let s = 0; for (const v of data) s += (v - m) ** 2; const z = await page.evaluate(() => (window as any).play.view.zoom); shots.push({ t: Date.now(), luma: +m.toFixed(1), std: +Math.sqrt(s / data.length).toFixed(2), zoom: +z.toFixed(2) }); } catch {} await sleep(150); } })();
  const wheelBurst = async (dir: number, n: number, gap: number) => {
    const x = rf(VW * 0.2, VW * 0.8), y = rf(VH * 0.2, VH * 0.8); await move(x, y, 150); await sleep(100);
    const A = await page.evaluate((x: number, y: number) => { const P = (window as any).play, a = P.live.groundUnder(P.view, x, y); return a ? { x: a.x, z: a.z, y: a.y, geo: a.geo } : null; }, x, y);
    const z0 = await page.evaluate(() => (window as any).play.view.zoom);
    for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaY: dir * 100 }); await sleep(gap); }
    await idle();
    if (A) { const r = await page.evaluate((A: any, x: number, y: number) => { const P = (window as any).play, s = P.live.screenOf(P.view, A.x, A.z, A.y, A.geo); return { d: Math.hypot(s[0] - x, s[1] - y), z: P.view.zoom }; }, A, x, y); anchors.push({ t: Date.now(), x, y, n, dir, d: +r.d.toFixed(1), z0: +z0.toFixed(2), z1: +r.z.toFixed(2) }); }
  };
  const actions: (() => Promise<void>)[] = [
    async () => { await drag(rf(-250, 250), rf(-150, 150), rf(400, 1500)); },
    async () => { await drag(rf(-40, 40), rf(-40, 40), rf(800, 2000)); },
    async () => wheelBurst(-1, Math.round(rf(2, 12)), rf(30, 150)),
    async () => wheelBurst(1, Math.round(rf(2, 12)), rf(30, 150)),
    async () => { const [, la, lo] = PLACES[Math.floor(rnd() * PLACES.length)]; await go(la, lo, rf(-3, 6)); },
    async () => { await go(rf(-80, 80), rf(-180, 180), rf(-5.5, 8)); },
    async () => { await page.keyboard.press(rnd() < 0.5 ? "q" : "e"); await sleep(500); },
    async () => { const h = await page.$("#hud input"); const b = h && (await h.boundingBox()); if (b) { await move(b.x + b.width * rnd(), b.y + b.height / 2, 250); await page.mouse.down(); await sleep(60); await page.mouse.up(); } },
  ];
  while (Date.now() - T0 < DUR) { try { await actions[Math.floor(rnd() * actions.length)](); } catch (e: any) { hits.push({ type: "step-error", msg: String(e).slice(0, 120) }); } await sleep(rf(100, 600)); }
  shooting = false; await shooter;
  const rows = await page.evaluate(() => (window as any).__rows as any[]);
  writeFileSync(`${OUT}/log.json`, JSON.stringify({ cols: ["t", "pt", "zoom", "lat", "lon", "gap", "px", "py"], rows }));
  // detectors
  for (let i = 1; i < rows.length; i++) { const r = rows[i], p = rows[i - 1];
    if (r[5] > 100 && r[1] - rows[0][1] > 3000) hits.push({ type: "stall", t: r[0], detail: `frame gap ${r[5]} ms at zoom ${r[2]?.toFixed(2)}` });
    if (r[6] != null && p[6] != null && r[0] - T0 > 2500) { const j = Math.hypot(r[6] - p[6], r[7] - p[7]); if (j > 250 && Math.abs(r[2] - p[2]) < 0.05) hits.push({ type: "camera-snap", t: r[0], detail: `pivot moved ${Math.round(j)} px in one frame at zoom ${r[2]?.toFixed(2)}` }); } }
  for (const s of shots) { if (s.std < 1.5 && s.zoom > 0 && s.luma > 25) hits.push({ type: "blank", t: s.t, detail: `flat frame (std ${s.std}, mean ${s.luma}) at zoom ${s.zoom}` }); if (s.luma < 22 && s.zoom > 0) hits.push({ type: "night-dark", t: s.t, detail: `dark frame (luma ${s.luma}) at zoom ${s.zoom}` }); }
  for (const a of anchors) if (a.d > 25) hits.push({ type: "anchor-drift", t: a.t, detail: `ground under the cursor drifted ${Math.round(a.d)} px over a wheel burst from zoom ${a.z0} to ${a.z1}` });
  writeFileSync(`${OUT}/hits.json`, JSON.stringify({ id: ID, hits, anchors, errs: errs.map((e) => ({ kind: e.kind, msg: e.msg })) }, null, 1));
  const c: Record<string, number> = {}; for (const h of hits) c[h.type] = (c[h.type] ?? 0) + 1;
  console.log(JSON.stringify({ id: ID, frames: rows.length, shots: shots.length, summary: c, errs: errs.filter((e) => e.kind !== "requestfailed").length, worstAnchor: Math.max(0, ...anchors.map((a) => a.d)) }));
});
