// Consistency check for the play page: every sampled sim object is drawn at every ladder level and 2 bearings where it
// is at least 1 art px (and never below), at its projected position, with no drawn id the sim does not hold; and the
// ground class drawn at sampled world points matches the world's own class at the drawn point.
// Run: node scripts/play/consistency.cjs [url]  (one browser at a time, under a 2.2 GB memory cap)
const { chromium } = require("/root/tools/pw/node_modules/playwright");
const url = process.argv[2] || "https://goldclaw.duckdns.org/nomads-styles/play/?check=1&warm=0";
const inPage = async () => {
  const { live, view, sim } = play, D = live.debug, wait = (ms) => new Promise((r) => setTimeout(r, ms)), CS = D.CS;
  play.select(null); sim.paused = true;
  let seed = 12345; const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  while (!D.bins()) await wait(200);
  const B = D.bins(), shown = (s) => (s < 1 ? s ** 0.55 : s), LIVE = new Set(["fire", "structure", "item", "trap", "pit", "ash", "well", "grave"]);
  const spots = [["lake shore", -2738, -1838], ["peak flank", 2900, -1100], ["meadow", -2640, 0], ["forest", -1500, -1300]];
  const R = 28, PER = 50, obj = { pass: 0, occluded: 0, absentOk: 0, missing: 0, tooSmall: 0, moved: 0, stray: 0, unbaked: 0, fails: [] }, gr = { pass: 0, fail: 0, wall: 0, path: 0, samePoint: 0, total: 0, fails: [] };
  const byLevel = {};
  let sampled = 0;
  for (const [spotName, X, Z] of spots) {
    const tx = Math.floor((X + 4800) / 150), tz = Math.floor((Z + 4800) / 150), cand = [];
    B.each(tx - 1, tz - 1, tx + 1, tz + 1, (ki, si, px, py, size, sd, id) => {
      const K = B.kinds[ki], x = px * 150 - 4800, z = py * 150 - 4800;
      if (!LIVE.has(K) && Math.hypot(x - X, z - Z) < R) cand.push({ id, K, x, z, size });
    });
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    const objs = cand.slice(0, PER);
    sampled += objs.length;
    const pts = Array.from({ length: 50 }, () => { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * R; return [X + Math.cos(a) * d, Z + Math.sin(a) * d]; });
    for (let L = 0; L < live.levels.length; L++)
      for (const b of [0, 2]) {
        view.zoom = live.levels[L].zoom + 0.01; view.bearing = b;
        for (let i = 0; i < 300; i++) { Object.assign(view, live.centreOn(X, Z, view)); await wait(100); if (live.levelFor(view.zoom).L === L && live.readiness(view).ready) break; }
        await wait(300);
        const md = D.maps.get(D.mk(L, b)), pv = D.pv(md), pw = D.pw(md), lv = (byLevel[live.levels[L].name] ??= { pass: 0, fail: 0 });
        const chunkAt = (gx, gy) => { const cx = Math.floor(gx / CS), cy = Math.floor(gy / CS); return [live.cache.get(D.keyOf(L, b, cx, cy)), cx, cy]; };
        const seen = new Set();
        for (const o of objs) {
          const hpx = o.K === "grass" ? o.size * pw : shown(o.size) * pv, expect = hpx >= 1;
          const p = D.project(md, o.x, o.z), gx = Math.round(p.gx), gy = Math.round(p.gy), [ch, cx, cy] = chunkAt(gx, gy);
          if (!ch?.dbg) { obj.unbaked++; continue; }
          seen.add(ch);
          const lx = gx - cx * CS, ly = gy - cy * CS, e = ch.dbg.drawn.find((d) => d[0] === o.id);
          let px = 0;
          for (let y = Math.max(0, ly - 90); y < Math.min(CS, ly + 12); y++) for (let x = Math.max(0, lx - 40); x < Math.min(CS, lx + 40); x++) if (ch.dbg.oid[y * CS + x] === o.id) px++;
          const bad = (why) => { obj[why]++; lv.fail++; if (obj.fails.length < 25) obj.fails.push({ why, spot: spotName, level: live.levels[L].name, b, id: o.id, kind: o.K, size: +o.size.toFixed(2), hpx: +hpx.toFixed(2), at: e ? [e[1], e[2]] : null, proj: [lx, ly] }); };
          if (expect && !e) bad("missing");
          else if (!expect && (e || px)) bad("tooSmall");
          else if (e && (Math.abs(e[1] - lx) > 1 || Math.abs(e[2] - ly) > 1)) bad("moved");
          else { lv.pass++; if (!expect) obj.absentOk++; else if (px) obj.pass++; else obj.occluded++; }
        }
        // nothing drawn that the sim does not hold
        for (const ch of seen) {
          const ids = new Set(ch.dbg.oid);
          ids.delete(0);
          for (const id of ids) if (!B.get(id) || !sim.pos("t" + id)) { obj.stray++; lv.fail++; if (obj.fails.length < 25) obj.fails.push({ why: "stray", level: live.levels[L].name, id }); }
        }
        // ground: the class drawn where each point projects, against the world's class at the point drawn there
        const hits = [];
        for (const [x, z] of pts) {
          const p = D.project(md, x, z), gx = Math.round(p.gx), gy = Math.round(p.gy), [ch, cx, cy] = chunkAt(gx, gy);
          if (!ch?.dbg) continue;
          const q = (gy - cy * CS) * CS + gx - cx * CS;
          if (ch.dbg.oid[q]) continue; // an object stands in front
          hits.push({ cls: ch.dbg.cls[q], wx: ch.dbg.wx[q], wz: ch.dbg.wz[q], x, z });
        }
        const ref = await D.classify(Float64Array.from(hits.flatMap((h) => [h.wx, h.wz]))), mpp = 1 / md.k;
        hits.forEach((h, k) => {
          gr.total++;
          if (Math.hypot(h.wx - h.x, h.wz - h.z) <= Math.max(1.5, mpp * 1.5)) gr.samePoint++;
          if (h.cls === 254) { gr.wall++; return; }
          if (h.cls === 255) { gr.path++; return; }
          if (h.cls === ref[k]) { gr.pass++; lv.pass++; } else { gr.fail++; lv.fail++; if (gr.fails.length < 25) gr.fails.push({ spot: spotName, level: live.levels[L].name, b, drawn: h.cls, world: ref[k], at: [+h.wx.toFixed(1), +h.wz.toFixed(1)] }); }
        });
      }
  }
  obj.sampled = sampled; gr.sampled = spots.length * 50;
  return JSON.stringify({ objects: obj, ground: gr, byLevel });
};
(async () => {
  let browser;
  process.once("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(143); });
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("pageerror", (e) => console.log("pageerror", e.stack || e.message));
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.play?.metrics?.revealMs > 0 || document.body.classList.contains("failed"), null, { timeout: 240000 });
    const t0 = Date.now();
    console.log(await page.evaluate(`(${inPage})()`));
    console.log("seconds", Math.round((Date.now() - t0) / 1000));
  } finally { try { await browser?.close(); } catch {} }
})().catch((e) => { console.error(e); process.exit(1); });
