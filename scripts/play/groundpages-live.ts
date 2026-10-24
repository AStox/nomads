// Live-page gate for the painter reading the ground from pages (demo/styles/isopixel/pages.js, webgpu.js setGroundPages): stills at three places and three zooms and at the cube edge with the
// painter on the window's own textures, on the window's 16 pages (demo/tile.ts groundPages, slots shuffled) and on the window's again, compared to the pixel; a roll of the pages (a permutation
// of the table) against the unrolled; the painter's GPU ms by the window's textures and by pages in alternation; no WEBGPU LOST.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/groundpages-live.ts <siteDir> <stillsDir> [profileDir]
// It drives the worker's check op "pages" ({ on }), which builds the drawn window's pages (T.pageAtlas, pageSource, groundPages) and calls R.setGroundPages / R.setGroundPagesOn.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAGE_FINE_WORDS, PAGE_GRID_WORDS, PAGE_MASK_WORDS, PAGE_FINE_PITCH, PAGE_GRID_PITCH } from "../../src/gpu/wgsl/terrain-window";
import { PAGE_ROW, PAGE_WORDS } from "../../demo/styles/isopixel/pages.js";

const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;
const [DIR, STILLS, PROFILE = "/tmp/globe-slice-c-chrome"] = process.argv.slice(2);
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed = true; };

// the painter's copy path takes its page sizes from pages.js; the producer's own are the truth
check(PAGE_WORDS.fine === PAGE_FINE_WORDS && PAGE_WORDS.grid === PAGE_GRID_WORDS && PAGE_WORDS.mask === PAGE_MASK_WORDS && PAGE_ROW.fine === PAGE_FINE_PITCH * 4 && PAGE_ROW.grid === PAGE_GRID_PITCH * 4, "pages.js sizes equal terrain-window.ts's");

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname), file = Bun.file(join(DIR, path.endsWith("/") ? `${path}index.html` : path));
    if (!(await file.exists())) return new Response("no", { status: 404 });
    return new Response(file, { headers: { "Cache-Control": "no-store" } });
  },
});
const SITE = `http://localhost:${server.port}`;
const CAP = readFileSync("/tmp/globe-seamless/cap.js", "utf8");
const PLACES: Record<string, [number, number]> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], E: [13.27, 45.0] };
const ZOOMS: Record<string, number[]> = { A: [4, 6.5, 9.2], B: [4, 6.5, 9.2], C: [4, 6.5, 9.2], E: [6.5] };
const sleep = Bun.sleep;
const EXACT = !!process.env.EXACT, PROBE_ONLY = !!process.env.PROBE_ONLY;

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(STILLS, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--headless=new", "--enable-unsafe-webgpu", "--window-size=1600,1143", `--user-data-dir=${PROFILE}`],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});

// pixels that differ, the largest channel difference, and the box they lie in
async function diff(a: string, b: string) {
  const reg: Record<string, number> = { TL: 0, TR: 0, BL: 0, BR: 0, C: 0 };
  const A = await sharp(a).raw().toBuffer({ resolveWithObject: true }), B = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = A.info;
  let n = 0, max = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i * ch + c] - B.data[i * ch + c]));
    if (d > 0) {
      const x = i % w, y = (i / w) | 0, R = 320, Hh = 250;
      if (x < R && y < Hh) reg.TL++; else if (x >= w - R && y < Hh) reg.TR++; else if (x < R && y >= h - Hh) reg.BL++; else if (x >= w - R && y >= h - Hh) reg.BR++;
      if (Math.abs(x - w / 2) < R / 2 && Math.abs(y - h / 2) < Hh / 2) reg.C++;
    }
    if (d > 0) { n++; max = Math.max(max, d); const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { n, of: w * h, max, box: n ? [x0, y0, x1, y1] : null, reg };
}

try {
  const page = await browser.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e: Error) => errs.push(e.message));
  page.on("console", (m: any) => { if (/WEBGPU LOST|Error|error/.test(m.text()) && !/favicon/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  await page.goto(`${SITE}/play/?zoom=island&hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("body.ready", { timeout: 120000 });
  await page.evaluate(() => { (window as any).play.sim.paused = true; });
  await sleep(3000);
  const bad = await page.evaluate(() => document.body.dataset.error ?? "");
  check(!bad, `body.ready${bad ? ` with error ${bad}` : ""}`);
  await page.evaluate(`window.__cap = ${CAP}`);

  const op = (q: object) => page.evaluate((q: object) => (window as any).play.live.debug.check(q), q);
  const settle = async (ms = 1500) => { await sleep(ms); };
  const shot = async (name: string) => { const path = join(STILLS, `${name}.png`); await page.screenshot({ path }); return path; };
  const goto = async (geo: [number, number], z: number, fresh: boolean) => {
    await page.evaluate((o: object) => (window as any).__cap(o), { geo, z, fresh });
    await page.waitForFunction(() => (window as any).__capr, { timeout: 120000 });
    const r = await page.evaluate(() => (window as any).__capr);
    await page.evaluate(() => { (window as any).__capr = null; });
    return r;
  };

  for (const [name, geo] of Object.entries(PROBE_ONLY ? {} : PLACES)) {
    let fresh = true;
    for (const z of ZOOMS[name]) {
      const r = await goto(geo, z, fresh);
      fresh = false;
      if (r.mode !== "win") { console.log(`${name} ${z}: the page draws the ${r.mode}, not a window: skipped`); continue; }
      await op({ op: "pages", on: false });
      await settle();
      const w1 = await shot(`${name}-${z}-window`);
      const on = await op({ op: "pages", on: true, exact: EXACT });
      await settle();
      const p1 = await shot(`${name}-${z}-pages`);
      await op({ op: "pages", on: false });
      await settle();
      const w2 = await shot(`${name}-${z}-window2`);
      const noise = await diff(w1, w2), d = await diff(w1, p1);
      console.log(`${name} zoom ${z}: pages built in ${on?.ms?.toFixed?.(0) ?? "?"} ms; pages vs window ${d.n} of ${d.of} pixels differ (max ${d.max}${d.box ? `, box ${d.box.join(",")}` : ""}); window vs window ${noise.n}`);
      check(d.n <= noise.n, `${name} zoom ${z}: stills on pages equal the window's (${d.n} differ, run-to-run ${noise.n})`);
      // a roll of the pages is a permutation of the table, so the frame drawn after it is the frame drawn before
      if (name === "A" && z === 9.2) {
        await op({ op: "pages", on: true, exact: EXACT });
        await settle();
        const before = await shot(`${name}-${z}-pages-before-roll`);
        await op({ op: "roll", kx: 64, ky: -128 });
        await settle();
        const after = await shot(`${name}-${z}-pages-rolled`);
        const rd = await diff(before, after);
        console.log(`roll (64, -128): ${rd.n} of ${rd.of} pixels differ (max ${rd.max})`);
        check(rd.n === 0, "a roll of the pages changes no pixel");
        await op({ op: "pages", on: false });
      }
    }
  }


  // R6: a window 2560 by 1000, the four corners and the centre of the screen on the same level of ground as the rest, and a page missing under the view never drawn as a patch
  await page.setViewport({ width: 2560, height: 1000, deviceScaleFactor: 1 });
  await sleep(2500);
  const regs = (d: { reg: Record<string, number> }) => Object.entries(d.reg).map(([k, v]) => `${k} ${v}`).join(", ");
  let wideFresh = true;
  for (const [name, z] of (PROBE_ONLY ? [] : [["A", 9.2], ["A", 6.5], ["E", 6.5]]) as [string, number][]) {
    if (name === "E") wideFresh = true;
    const r = await goto(PLACES[name], z, wideFresh);
    wideFresh = false;
    if (r.mode !== "win") { console.log(`wide ${name} ${z}: not a window: skipped`); continue; }
    await op({ op: "pages", on: false });
    await settle();
    const w1 = await shot(`wide-${name}-${z}-window`);
    const full = await op({ op: "pages", on: true, exact: EXACT });
    await settle();
    const p1 = await shot(`wide-${name}-${z}-pages`);
    const d = await diff(w1, p1);
    console.log(`wide ${name} zoom ${z}: pages on ${full.on}; ${d.n} of ${d.of} pixels differ (max ${d.max}); corners and centre: ${regs(d)}`);
    check(full.on && d.n === 0, `wide ${name} zoom ${z}: pages equal the window's over the whole screen`);
    if (name === "A" && z === 9.2) {
      // a page missing under the view: the pages stay off and the screen is the window's, whole
      await op({ op: "pages", on: false });
      const miss = await op({ op: "pages", on: true, drop: [5] });
      await settle();
      const m1 = await shot("wide-A-9.2-missing-under-view");
      const dm = await diff(w1, m1);
      check(!miss.on && miss.missing.length === 1 && dm.n === 0, `a page missing under the view leaves pages off (${JSON.stringify(miss.missing)}) and the screen the window's (${dm.n} differ)`);
      // a page missing far outside the view: the pages are on and the screen is as with all of them
      const far = await op({ op: "pages", on: true, drop: [0], need: { x0: -3000, z0: -3000, x1: 3000, z1: 3000 } });
      await settle();
      const f1 = await shot("wide-A-9.2-missing-far");
      const df = await diff(p1, f1);
      check(far.on && df.n === 0, `a page missing outside the view leaves pages on (${far.on}) and the screen as with all of them (${df.n} differ)`);
      await op({ op: "pages", on: false });
    }
  }
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });

  // the painter's GPU ms: the mean of 240 frames after the dive, window textures then pages, twice in alternation
  await goto(PLACES.A, 9.2, true);
  await page.evaluate(() => (window as any).play.live.debug.hold(false));
  const probe = async () => {
    await page.evaluate(() => (window as any).play.live.frameTimes());
    const r = await page.evaluate(async () => {
      const L = (window as any).play.live, got: number[] = [], per: Record<string, number> = {};
      const t0 = performance.now();
      while (got.length < 240 && performance.now() - t0 < 90000) { await new Promise((r) => setTimeout(r, 100)); for (const f of L.frameTimes()) if (f.gpu != null) { got.push(f.gpu); for (const [k, v] of Object.entries(f.passes ?? {})) per[k] = (per[k] ?? 0) + (v as number); } }
      return { got: got.slice(0, 240), per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +(v / Math.max(1, got.length)).toFixed(2)])) };
    });
    return { n: r.got.length, mean: r.got.reduce((a: number, b: number) => a + b, 0) / Math.max(1, r.got.length), per: r.per };
  };
  const ms: Record<string, number[]> = { window: [], pages: [] };
  for (let k = 0; k < 2; k++) {
    for (const mode of ["window", "pages"]) {
      await op({ op: "pages", on: mode === "pages", exact: EXACT });
      await sleep(2500);
      const r = await probe();
      ms[mode].push(r.mean);
      console.log(`passProbe ${mode} round ${k}: ${r.mean.toFixed(2)} ms over ${r.n} frames; passes ${JSON.stringify(r.per)}`);
    }
  }
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  check(mean(ms.pages) - mean(ms.window) <= 0.3, `painter GPU ms on pages ${mean(ms.pages).toFixed(2)} within 0.3 of the window's ${mean(ms.window).toFixed(2)}`);
  check(errs.length === 0, `no page errors or WEBGPU LOST${errs.length ? `: ${errs[0]}` : ""}`);
} finally {
  await browser.close();
  server.stop(true);
  rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
