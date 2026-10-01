// Camera torture test: minutes of random real input on the play page, each step checked against where the renderer
// actually draws things (live.debug.camera + the level's own ground), not against the camera's own math.
//   node torture.cjs --url http://127.0.0.1:8197/play/ --secs 600 --seed 7 --out result.json
const { chromium } = require("/root/tools/pw/node_modules/playwright");
const fs = require("fs");
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const URL0 = arg("url", "http://127.0.0.1:8197/play/"), SECS = Number(arg("secs", 600)), SEED = Number(arg("seed", 7));
const OUT = arg("out", "/tmp/nomads-torture.json"), IDLE = Number(arg("idle", 60)), W = 1280, H = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rs = SEED >>> 0;
const rnd = () => { rs = (rs + 0x6d2b79f5) >>> 0; let t = rs; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pickW = (ws) => { const tot = ws.reduce((a, [, w]) => a + w, 0); let r = rnd() * tot; for (const [k, w] of ws) { if ((r -= w) < 0) return k; } return ws[0][0]; };

// ---------- in-page probe ----------
function probe() {
  const { live } = play, D = live.debug, mod8 = (b) => ((Math.round(b) % 8) + 8) % 8;
  if (!D) throw new Error("needs ?check=1");
  // ?check=1 ships per-pixel debug arrays with every chunk, outside the cache budget; this test never reads them
  for (const wk of live.pool) { const f = wk.onmessage; wk.onmessage = (e) => { if (e.data && e.data.dbg) e.data.dbg = null; f(e); }; }
  for (const ch of live.cache.values()) ch.dbg = null;
  const P = (window.__probe = { cur: [0, 0], task: null, inv: { frames: 0, nan: 0, bounds: 0, bearing: 0, zoom: 0, first: null }, frameErr: null });
  addEventListener("pointermove", (e) => { P.cur = [e.clientX, e.clientY]; }, true);
  addEventListener("pointerdown", (e) => { P.cur = [e.clientX, e.clientY]; }, true);
  const cv = document.getElementById("view");
  P.intB = (v) => Math.abs(v.bearing - Math.round(v.bearing)) < 1e-9;
  // the camera the frame drew its main slot with
  P.cam = (v) => { const lf = live.level; if (!lf || !P.intB(v)) return null; return D.camera(v, lf.L, mod8(v.bearing)); };
  P.scr = (cam, x, z, y) => { const md = cam.md, [u, v] = md.uv(x, z), gx = (u - v) * md.H, gy = (u + v) * md.hb - (y / md.levelM) * md.lp; return [cam.dx + (gx - cam.gx0) * cam.s, cam.dy + (gy - cam.gy0) * cam.s]; };
  // ray-march the level's drawn surface under a canvas point, front-most hit
  P.ground = (cam, sx, sy) => {
    const md = cam.md, gx = cam.gx0 + (sx - cam.dx) / cam.s, gy = cam.gy0 + (sy - cam.dy) / cam.s, a = gx / md.H;
    const f = (lev) => { const b = (gy + lev * md.lp) / md.hb; return md.ground((a + b) / 2, (b - a) / 2) - lev; };
    const step = 0.2;
    for (let lev = (md.maxLev ?? 400) + 3; lev > -20; lev -= step) {
      if (f(lev - step) < 0) continue;
      let lo = lev - step, hi = lev;
      for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (f(m) >= 0) lo = m; else hi = m; }
      const L = (lo + hi) / 2, b = (gy + L * md.lp) / md.hb, u = (a + b) / 2, v = (b - a) / 2, [x, z] = md.world(u, v);
      return { x, z, y: L * md.levelM, u, v };
    }
    return null;
  };
  // local drawn slope (rise over run) and height at a ground point of a level
  P.slope = (md, u, v) => { const g = (du, dv) => md.ground(u + du, v + dv) * md.levelM; return Math.hypot(g(1, 0) - g(-1, 0), g(0, 1) - g(0, -1)) / (2 * md.tileM); };
  const movers = (id) => typeof id === "string" && (play.sim.w.agents.some((a) => a.id === id) || play.sim.w.animals.some((a) => a.id === id));
  P.following = () => movers(play.view.selected);
  // where the renderer draws a followed entity: between its ticks, on the level's ground, a bird lifted by its alt
  P.entity = (cam, id) => {
    const sim = play.sim, q = sim.pos(id);
    if (!q) return null;
    const al = Math.min(1, Math.max(0, sim.alpha ?? 1)), tm = live.tileM, half = live.size / 2, x = q.ppx * tm - half + (q.px - q.ppx) * tm * al, z = q.ppy * tm - half + (q.py - q.ppy) * tm * al;
    const p = D.project(cam.md, x, z), an = sim.w.animals.find((a) => a.id === id), pv = cam.md.k * 0.866 * cam.md.treeK, lift = an ? Math.round((an.alt || 0) * pv) : 0;
    return [cam.dx + (p.gx - cam.gx0) * cam.s, cam.dy + (p.gy - lift - cam.gy0) * cam.s];
  };
  P.state = () => { const v = play.view; return { x: v.x, z: v.z, zoom: v.zoom, bearing: v.bearing, up: v.up ?? 0 }; };
  const centre = () => [cv.width / 2, cv.height / 2];
  // a canvas point: random, or the steepest drawn ground on a coarse scan
  P.steep = (avoid) => {
    const v = play.view, cam = P.cam(v);
    if (!cam) return null;
    let best = null, bs = -1;
    for (let gy = 60; gy < cv.height - 40; gy += 50)
      for (let gx = 40; gx < cv.width - 40; gx += 60) {
        if (avoid && gx < avoid[0] && gy < avoid[1]) continue;
        const g = P.ground(cam, gx, gy);
        if (!g) continue;
        const s = P.slope(cam.md, g.u, g.v) + g.y / 2000;
        if (s > bs) { bs = s; best = [gx, gy, +s.toFixed(3), Math.round(g.y)]; }
      }
    return best;
  };
  P.begin = (kind, o = {}) => {
    const v = play.view, cam = P.cam(v), t = { kind, n: 0, worst: 0, errs: [], skip: 0, s0: P.state(), t0: performance.now(), ...o };
    if (kind === "zoom" || kind === "pan" || kind === "pinch") {
      if (!cam) return (P.task = null), { skip: "bearing" };
      t.A = P.ground(cam, ...t.at);
      if (!t.A) return (P.task = null), { skip: "noground" };
      t.startS = P.scr(cam, t.A.x, t.A.z, t.A.y);
      t.cur0 = [...t.at];
      t.follow0 = P.following();
      const c = P.ground(cam, ...centre());
      t.terrain = c ? { slope: +P.slope(cam.md, c.u, c.v).toFixed(3), y: Math.round(c.y) } : null;
      t.slopeA = +P.slope(cam.md, t.A.u, t.A.v).toFixed(3);
      t.L0 = live.level.L;
    }
    if (kind === "still" || kind === "idle" || kind === "orbit" || kind === "turn") {
      const c = cam && P.ground(cam, ...centre());
      t.C = c; t.cS = c && P.scr(cam, c.x, c.z, c.y);
    }
    P.task = t;
    return { ok: true, A: t.A, terrain: t.terrain, slopeA: t.slopeA };
  };
  P.end = () => {
    const t = P.task;
    P.task = null;
    if (!t) return null;
    const out = { kind: t.kind, n: t.n, worst: +t.worst.toFixed(3), clamped: !!t.clamped, skip: t.skip, terrain: t.terrain, slopeA: t.slopeA, follow0: t.follow0, levels: t.levels ? [...t.levels] : undefined, s0: t.s0, s1: P.state() };
    if (t.kind === "idle" || t.kind === "still" || t.kind === "orbit" || t.kind === "turn") {
      const v = play.view, cam = P.cam(v);
      if (t.C && cam) { const s = P.scr(cam, t.C.x, t.C.z, t.C.y); out.drift = +Math.hypot(s[0] - t.cS[0], s[1] - t.cS[1]).toFixed(4); }
      const a = t.s0, b = out.s1, ppm = live.ppm(v.zoom);
      out.moveTarget = +(Math.hypot(a.x - b.x, a.z - b.z) * ppm).toFixed(4);
    }
    if (t.kind === "follow") out.far = t.far;
    return out;
  };
  const orig = live.frame;
  live.frame = (view, sim) => {
    const r = orig(view, sim);
    try { onFrame(view); } catch (e) { P.frameErr = String(e && e.stack || e); }
    return r;
  };
  function onFrame(v) {
    const I = P.inv;
    I.frames++;
    const bad = (k, why) => { I[k]++; if (!I.first) I.first = { k, why, state: P.state(), task: P.task?.kind }; };
    const fin = [v.x, v.z, v.zoom, v.bearing, v.up ?? 0].every(Number.isFinite);
    if (!fin) bad("nan", "non-finite");
    if (Math.abs(v.x) > live.size / 2 || Math.abs(v.z) > live.size / 2) bad("bounds", "xz");
    if (!(v.zoom >= -1e-9 && v.zoom <= live.zmax + 1e-9)) bad("zoom", "range");
    if (!(v.bearing >= 0 && v.bearing < 8)) bad("bearing", "not in [0,8)");
    const t = P.task;
    if (!t) return;
    if (Math.abs(v.x) >= live.size / 2 - 100 - 1e-6 || Math.abs(v.z) >= live.size / 2 - 100 - 1e-6) t.clamped = true;
    const cam = P.cam(v);
    if (t.kind === "zoom" || t.kind === "pinch" || t.kind === "pan") {
      if (!cam) { t.skip++; return; }
      (t.levels ??= new Set()).add(live.level.L);
      const s = P.scr(cam, t.A.x, t.A.z, t.A.y);
      let want;
      if (t.kind === "pan") {
        const d = [P.cur[0] - t.cur0[0], P.cur[1] - t.cur0[1]];
        if (Math.abs(d[0]) + Math.abs(d[1]) <= 8) return;
        want = [t.startS[0] + d[0], t.startS[1] + d[1]];
      } else want = t.kind === "pinch" ? (t.mid ?? t.at) : t.at;
      const e = Math.hypot(s[0] - want[0], s[1] - want[1]);
      t.n++; if (e > t.worst) t.worst = e;
      if (e > 1 && t.errs.length < 6) t.errs.push([+e.toFixed(2), live.level.L, +v.zoom.toFixed(3)]);
    } else if (t.kind === "follow") {
      if (!cam) { t.skip++; return; }
      const id = v.selected;
      if (id !== t.id) { t.skip++; return; }
      const p = P.entity(cam, id);
      if (!p) { t.skip++; return; }
      const e = Math.max(Math.abs(p[0] - cv.width / 2) / cv.width, Math.abs(p[1] - cv.height / 2) / cv.height);
      if (!t.measure) { if (e < 0.35) t.far = t.far ?? 0; else t.far = (t.far ?? 0) + 1; return; }
      t.n++; if (e > t.worst) t.worst = e;
      if (e > 0.03 && t.errs.length < 6) t.errs.push([+e.toFixed(4), live.level.L]);
    } else if (t.kind === "still" || t.kind === "idle" || t.kind === "orbit" || t.kind === "turn") {
      const a = t.s0, ppm = live.ppm(v.zoom), m = Math.hypot(a.x - v.x, a.z - v.z) * ppm;
      t.n++; if (m > t.worst) t.worst = m;
    }
  }
  P.set = (o) => Object.assign(P.task ?? {}, o);
  P.info = () => ({ state: P.state(), sel: play.view.selected, following: P.following(), L: live.level?.L, zmax: live.zmax, insp: !document.getElementById("inspector").hidden, err: P.frameErr });
  return { ok: true, zmax: live.zmax, camHeight: live.stats.camHeight ?? null };
}

if (process.argv.includes("--resum")) {
  const r = JSON.parse(fs.readFileSync(OUT, "utf8"));
  summarise(r);
  fs.writeFileSync(OUT, JSON.stringify(r, null, 1));
  process.exit(0);
}
(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const res = { url: URL0, seed: SEED, secs: SECS, steps: [], errors: [], started: new Date().toISOString() };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  try {
    const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: true });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => res.errors.length < 30 && res.errors.push(String(e).slice(0, 300)));
    p.on("console", (m) => { if (m.type() === "error" && res.errors.length < 30) res.errors.push("console: " + m.text().slice(0, 300)); });
    const u = URL0 + (URL0.includes("?") ? "&" : "?") + "check=1";
    await p.goto(u, { waitUntil: "load", timeout: 120000 });
    await p.waitForFunction(() => document.body.classList.contains("ready"), null, { timeout: 300000, polling: 250 });
    res.boot = await p.evaluate(probe);
    const cdp = await ctx.newCDPSession(p);
    const ev = (fn, a) => p.evaluate(fn, a);
    const info = () => ev(() => __probe.info());
    const waitFor = async (fn, ms, a) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(fn, a)) return true; await sleep(60); } return false; };
    const intBearing = () => waitFor(() => Math.abs(play.view.bearing - Math.round(play.view.bearing)) < 1e-9, 7000);
    const zoomSettled = async () => {
      let last = null, same = 0; const t0 = Date.now();
      while (Date.now() - t0 < 4000) { const z = await ev(() => play.view.zoom); if (z === last) { if (++same >= 4) return true; } else same = 0; last = z; await sleep(50); }
      return false;
    };
    const inspBox = async () => ((await info()).insp ? [400, 500] : null);
    const randPt = async () => {
      const box = await inspBox();
      for (;;) { const x = ri(30, W - 30), y = ri(30, H - 30); if (box && x < box[0] && y < box[1]) continue; return [x, y]; }
    };
    const finish = async (step, extra = {}) => { const r = await ev(() => __probe.end()); const s = { step, ...extra, ...(r || {}), at: +(((Date.now() - T0) / 1000).toFixed(1)) }; res.steps.push(s); return s; };
    const followCheck = async (step, extra = {}) => {
      const i0 = await info();
      if (!i0.following) return finish(step, { ...extra, skipped: "not following" }).then(() => null);
      await ev((id) => __probe.begin("follow", { id }), i0.sel);
      // a far jump bakes first, then cuts; then the target must hold near centre
      await sleep(3500);
      await ev(() => __probe.set({ measure: true }));
      await sleep(2500);
      return finish(step, extra);
    };
    const T0 = Date.now();
    let idleDone = 0, nStep = 0;
    const idle = async (label) => {
      await p.keyboard.press("Escape");
      await sleep(1500);
      await intBearing();
      await ev(() => __probe.begin("idle"));
      await sleep(IDLE * 1000);
      await finish("idle", { label });
    };
    while ((Date.now() - T0) / 1000 < SECS) {
      nStep++;
      if (!idleDone && (Date.now() - T0) / 1000 > SECS / 2) { idleDone = 1; await idle("mid"); continue; }
      const st = await info();
      const kind = pickW([["wheel", 22], ["pan", 18], ["panMountain", 5], ["orbit", 8], ["qe", 8], ["tab", 7], ["click", 10], ["clickEntity", 9], ["esc", 5], ["dbl", 5], ["plusminus", 4], ["pinch", 4], ["pinchDegenerate", 1], ["speed", 3]]);
      try {
        if (kind === "wheel") {
          await intBearing();
          let pt = await randPt();
          if (rnd() < 0.35) { const s = await ev((a) => __probe.steep(a), await inspBox()); if (s) pt = [s[0], s[1]]; }
          await p.mouse.move(...pt);
          await sleep(40);
          const z = st.state.zoom, zmax = st.zmax, dir = z > zmax - 0.6 ? 1 : z < 0.6 ? -1 : rnd() < 0.5 ? 1 : -1;
          const beg = await ev((at) => __probe.begin("zoom", { at }), pt);
          const n = ri(1, 5);
          for (let k = 0; k < n; k++) { await p.mouse.wheel(0, dir * ri(40, 200)); await sleep(ri(20, 140)); }
          await zoomSettled();
          await finish("wheel", { pt, beginSkip: beg.skip, dir, n, following: st.following });
        } else if (kind === "pan" || kind === "panMountain") {
          await intBearing();
          let from = await randPt(), to = null;
          if (kind === "panMountain") {
            const s = await ev((a) => __probe.steep(a), await inspBox());
            if (s) { from = [s[0], s[1]]; to = [W / 2 + ri(-40, 40), H / 2 + ri(-40, 40)]; }
          }
          await p.mouse.move(...from);
          await sleep(30);
          const beg = await ev((at) => __probe.begin("pan", { at }), from);
          await p.mouse.down();
          let cur = from;
          const segs = to ? [to] : Array.from({ length: ri(1, 4) }, () => [Math.max(10, Math.min(W - 10, cur[0] + ri(-320, 320))), Math.max(10, Math.min(H - 10, cur[1] + ri(-220, 220)))]);
          for (const sg of segs) { await p.mouse.move(sg[0], sg[1], { steps: ri(4, 24) }); cur = sg; await sleep(ri(0, 120)); }
          await sleep(60);
          await p.mouse.up();
          await sleep(80);
          await finish(kind, { from, segs: segs.length, beginSkip: beg.skip, following: st.following, steepAt: to ? true : undefined });
        } else if (kind === "orbit") {
          const pt = await randPt();
          await p.mouse.move(...pt);
          await ev(() => __probe.begin("orbit"));
          await p.mouse.down({ button: "right" });
          const dx = ri(-450, 450) || 30;
          await p.mouse.move(Math.max(5, Math.min(W - 5, pt[0] + dx)), pt[1] + ri(-20, 20), { steps: ri(5, 30) });
          await p.mouse.up({ button: "right" });
          const ok = await intBearing();
          await sleep(100);
          await finish("orbit", { dx, settled: ok, following: st.following });
        } else if (kind === "qe") {
          await intBearing();
          const b0 = (await info()).state.bearing, key = rnd() < 0.5 ? "q" : "e";
          await ev(() => __probe.begin("turn"));
          await p.keyboard.press(key);
          // the turn waits for the next bearing to bake, then runs; done once it rests on a new whole bearing
          const ok = await waitFor((b0) => { const b = play.view.bearing; return Math.abs(b - Math.round(b)) < 1e-9 && Math.abs(b - b0) > 1e-9; }, 9000, b0);
          await sleep(150);
          const b1 = (await info()).state.bearing, want = (((b0 + (key === "e" ? 1 : -1)) % 8) + 8) % 8;
          await finish("qe", { key, b0, b1, turned: Math.abs(b1 - want) < 1e-9, settled: ok, following: st.following });
        } else if (kind === "tab") {
          await p.keyboard.press(rnd() < 0.3 ? "Shift+Tab" : "Tab");
          await sleep(100);
          await followCheck("tab");
        } else if (kind === "click" || kind === "clickEntity") {
          await intBearing();
          let pt = await randPt(), want = null;
          if (kind === "clickEntity") {
            const box = await inspBox();
            const e = await ev((box) => {
              const v = play.view, cam = __probe.cam(v);
              if (!cam) return null;
              const ok = (x, y) => x > 20 && y > 20 && x < innerWidth - 20 && y < innerHeight - 20 && !(box && x < box[0] && y < box[1]);
              // a pixel where the frame drew a live sprite, so the click lands on what the player sees
              const pc = play.live.debug.pickCam?.(), slot = pc?.[2];
              if (slot?.owners && pc[1] === 0) {
                const [c] = pc, hits = [];
                for (let y = 0; y < c.AH; y++) for (let x = 0; x < c.AW; x++) {
                  const o = slot.owners[slot.id[y * c.AW + x]], X = c.dx + (x + 0.5) * c.s, Y = c.dy + (y + 0.5) * c.s;
                  if (o && ok(X, Y)) hits.push({ id: o.id, kind: o.kind, x: X, y: Y });
                }
                return hits.length ? hits[Math.floor(Math.random() * hits.length)] : null;
              }
              const ps = play.live.picks().map((q) => ({ ...q, x: cam.dx + q.sx * cam.s, y: cam.dy + q.sy * cam.s })).filter((q) => ok(q.x, q.y));
              return ps.length ? ps[Math.floor(Math.random() * ps.length)] : null;
            }, box);
            if (e) { pt = [Math.round(e.x), Math.round(e.y)]; want = { id: e.id, kind: e.kind }; }
          }
          await p.mouse.move(...pt);
          await sleep(30);
          const s0 = await ev(() => __probe.state()), selBefore = (await info()).sel, pickAt = await ev((q) => play.live.pick(q[0], q[1], play.view), pt);
          await p.mouse.click(...pt);
          // a click commits once it cannot be the first half of a double-click
          await sleep(450);
          const i1 = await info(), ins1 = await ev(() => play.inspected());
          // clicking what is already selected lets it go
          const again = !!want && selBefore === want.id, hit = want ? (again ? i1.sel == null : i1.sel === want.id) : undefined;
          const sel = i1.sel, selKind = sel == null ? "none" : typeof sel === "object" ? "ground" : i1.following ? "mover" : "thing";
          if (selKind === "mover") {
            await followCheck("clickFollow", { pt, want, hit, selKind, inspShown: i1.insp });
          } else {
            await ev(() => __probe.begin("still"));
            const a = await ev(() => play.inspected());
            await sleep(1300);
            const b2 = await ev(() => play.inspected());
            await finish("click", { pt, want, hit, selKind, selBefore, pickAt, wasFollowing: st.following, inspShown: i1.insp, inspSame: JSON.stringify(a) === JSON.stringify(b2), movedOnClick: +Math.hypot(s0.x - i1.state.x, s0.z - i1.state.z).toFixed(4) });
          }
        } else if (kind === "esc") {
          await p.keyboard.press("Escape");
          await sleep(50);
          await ev(() => __probe.begin("still"));
          await sleep(1200);
          await finish("esc", { wasFollowing: st.following });
        } else if (kind === "dbl") {
          await intBearing();
          const pt = await randPt();
          await p.mouse.move(...pt);
          await sleep(30);
          const sel0 = JSON.stringify((await info()).sel ?? null);
          const beg = await ev((at) => __probe.begin("zoom", { at }), pt);
          await p.mouse.dblclick(...pt);
          await sleep(60);
          const i1 = await info();
          await zoomSettled();
          await sleep(400);
          const sel1 = JSON.stringify((await info()).sel ?? null);
          await finish("dbl", { pt, beginSkip: beg.skip, followingAfter: i1.following, keptSelection: sel0 === sel1, sel0, sel1 });
        } else if (kind === "plusminus") {
          await intBearing();
          const z = st.state.zoom, key = z > st.zmax - 1 ? "-" : z < 1 ? "+" : rnd() < 0.5 ? "+" : "-";
          const beg = await ev((at) => __probe.begin("zoom", { at }), [W / 2, H / 2]);
          await p.keyboard.press(key === "+" ? "Equal" : "Minus");
          await sleep(60);
          await zoomSettled();
          await finish("plusminus", { key, beginSkip: beg.skip, following: st.following });
        } else if (kind === "pinch" || kind === "pinchDegenerate") {
          await intBearing();
          const tp = (r, a, m) => [{ x: m[0] - Math.cos(a) * r, y: m[1] - Math.sin(a) * r, id: 1 }, { x: m[0] + Math.cos(a) * r, y: m[1] + Math.sin(a) * r, id: 2 }];
          const box = await inspBox(), onCanvas = (q) => q.x > 15 && q.y > 15 && q.x < W - 15 && q.y < H - 15 && !(box && q.x < box[0] && q.y < box[1]);
          let c, twist, r0, r1, a0, a1;
          // both fingers stay on the view canvas the whole way, or the gesture is a one-finger drag
          for (let k = 0; k < 200; k++) {
            c = await randPt(); twist = kind === "pinch" && rnd() < 0.4; r0 = kind === "pinchDegenerate" ? 0 : ri(40, 120); r1 = kind === "pinchDegenerate" ? 0 : Math.max(10, r0 + ri(-60, 140));
            a0 = rnd() * Math.PI; a1 = a0 + (twist ? (rnd() - 0.5) * 1.6 : 0);
            if ([0, 0.5, 1].every((f) => tp(r0 + (r1 - r0) * f, a0 + (a1 - a0) * f, c).every(onCanvas))) break;
          }
          const beg = await ev((at) => __probe.begin("pinch", { at }), c);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(r0, a0, c) });
          const N = ri(6, 20);
          for (let k = 1; k <= N; k++) {
            const f = k / N, m = kind === "pinchDegenerate" ? c : c, pts = tp(r0 + (r1 - r0) * f, a0 + (a1 - a0) * f, m);
            await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts });
            await sleep(16);
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await sleep(60);
          await intBearing();
          await zoomSettled();
          await finish(kind, { c, r0, r1, twist, beginSkip: beg.skip, following: st.following });
        } else if (kind === "speed") {
          const key = rnd() < 0.5 ? "BracketRight" : "BracketLeft";
          await p.keyboard.press(key);
          if (rnd() < 0.3) { await p.keyboard.press("Space"); await sleep(400); await p.keyboard.press("Space"); }
          res.steps.push({ step: "speed", key, at: +(((Date.now() - T0) / 1000).toFixed(1)) });
        }
      } catch (e) {
        res.steps.push({ step: kind, error: String(e).slice(0, 300) });
        await ev(() => (__probe.task = null)).catch(() => {});
      }
      if (nStep % 10 === 0) save();
    }
    await idle("end");
    res.inv = await ev(() => __probe.inv);
    res.frameErr = await ev(() => __probe.frameErr);
    res.metrics = await ev(() => play.metrics);
  } catch (e) {
    res.fatal = String(e && e.stack || e);
  } finally {
    res.ended = new Date().toISOString();
    summarise(res);
    save();
    await b.close();
  }
})();

// pass rules: anchor and pan within 1 px, follow within 3% of the canvas, still and idle with zero camera motion
function summarise(res) {
  const S = {};
  const add = (k, pass, worst, extra) => { const s = (S[k] ??= { pass: 0, fail: 0, skip: 0, worst: 0 }); if (pass === null) s.skip++; else if (pass) s.pass++; else s.fail++; if (worst != null && worst > s.worst) s.worst = +worst.toFixed(4); if (extra) (s.fails ??= []).length < 5 && !pass && s.fails.push(extra); };
  for (const s of res.steps) {
    if (s.error) { add("errors", false, null, s); continue; }
    if (s.step === "speed") continue;
    if (s.step === "wheel" || s.step === "dbl" || s.step === "plusminus" || s.step === "pinch" || s.step === "pinchDegenerate") {
      const followed = (s.follow0 || s.followingAfter) && !s.step.startsWith("pinch");
      if (s.beginSkip || !s.n) add(s.step + ":anchor", null);
      else if (followed || (s.step.startsWith("pinch") && s.follow0)) add(s.step + ":anchor(following)", null);
      else if (s.clamped) add(s.step + ":anchor(at bounds)", null);
      else if (s.step === "pinch" && s.twist) add("pinch:twist", s.s1 && Number.isFinite(s.s1.zoom), null);
      else add((s.step === "pinch" || s.step === "pinchDegenerate" ? s.step : "zoom") + ":anchor" + (s.slopeA > 0.12 ? "@mountain" : "@flat"), s.worst <= 1, s.worst, { at: s.at, worst: s.worst, levels: s.levels, s0: s.s0 });
      if (s.step === "dbl") add("dbl:keepsSelection", s.keptSelection, null, { at: s.at, sel0: s.sel0, sel1: s.sel1 });
      if (s.step === "pinchDegenerate") add("pinchDegenerate:finite", s.s1 && [s.s1.x, s.s1.z, s.s1.zoom, s.s1.bearing].every(Number.isFinite), null);
    } else if (s.step === "pan" || s.step === "panMountain") {
      if (s.beginSkip || !s.n) { add("pan", null); continue; }
      // a follow keeps moving the camera until the drag takes over; at the island's edge the target is clamped
      if (s.follow0) { add("pan(following)", null); continue; }
      if (s.clamped) { add("pan(at bounds)", null); continue; }
      const mtn = s.terrain && (s.terrain.slope > 0.12 || s.terrain.y > 150);
      add("pan@" + (mtn ? "mountain" : "flat"), s.worst <= 1, s.worst, { at: s.at, worst: s.worst, terrain: s.terrain, s0: s.s0 });
    } else if (s.step === "tab" || s.step === "clickFollow") {
      if (s.skipped || !s.n) { add("follow", null); continue; }
      add("follow", s.worst <= 0.03, s.worst, { at: s.at, worst: s.worst, far: s.far, s1: s.s1 });
      if (s.step === "clickFollow") add("select:hit", s.hit !== false, null, { at: s.at, want: s.want });
    } else if (s.step === "click") {
      // a follow running when the click lands keeps moving the camera until the click commits
      if (s.wasFollowing) add("select:still(was following)", null);
      else add("select:still", s.worst <= 0.01 && s.movedOnClick <= 0.01, Math.max(s.worst, s.movedOnClick), { at: s.at, worst: s.worst, moved: s.movedOnClick, sel: s.selKind });
      if (s.want) add("select:hit", s.hit, null, { at: s.at, want: s.want, sel: s.selKind });
      if (s.selKind !== "none") add("inspector:shown", s.inspShown, null, { at: s.at });
    } else if (s.step === "esc") add("esc:still", s.worst <= 0.01, s.worst, { at: s.at, worst: s.worst, wasFollowing: s.wasFollowing });
    else if (s.step === "orbit") {
      if (s.following) { add("orbit(following)", null); continue; }
      add("orbit:aboutTarget", s.moveTarget <= 0.01 && s.worst <= 0.01, Math.max(s.worst, s.moveTarget), { at: s.at, worst: s.worst, moveTarget: s.moveTarget });
      add("orbit:settles", s.settled && Number.isInteger(s.s1.bearing) && s.s1.bearing >= 0 && s.s1.bearing < 8, null, { at: s.at, s1: s.s1 });
    } else if (s.step === "qe") {
      add("qe:turns", s.turned && s.settled, null, { at: s.at, b0: s.b0, b1: s.b1 });
      if (!s.following) add("qe:aboutTarget", s.moveTarget <= 0.01, s.moveTarget, { at: s.at, moveTarget: s.moveTarget });
    } else if (s.step === "idle") add("idle:drift", s.worst <= 0.01 && (s.drift ?? 0) <= 0.01, Math.max(s.worst, s.drift ?? 0), { label: s.label, worst: s.worst, drift: s.drift, s0: s.s0, s1: s.s1 });
  }
  if (res.inv) for (const k of ["nan", "bounds", "zoom", "bearing"]) S["frames:" + k] = { bad: res.inv[k], of: res.inv.frames };
  res.summary = S;
  res.inv && (res.summary.firstBad = res.inv.first);
}
