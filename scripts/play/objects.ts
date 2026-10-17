// The play page's objects as the render worker draws them straight from the GPU buffers (plan Unit 14), checked over the
// Chrome DevTools protocol against the buffers themselves:
//   1. anchors: at a few zooms, a sample of the stems drawn in view 0 stands where live.debug.project puts the place its
//      buffer holds (worker.js check "where", read back from the GPU), to within a pixel, and the cull read that place;
//   2. far lists: at every level the view draws exactly as many sprites and specks walking the far lists as walking the
//      whole spatial index (webgpu.js farBuild; the closer levels walk the index either way), and at a level with front
//      lists every pixel shows what the far lists' drawing shows (webgpu.js frontFrame);
//   3. cross-fades: a level presented from the art it was last drawn into shows what drawing it again shows;
//   4. a kill: a drawn stem removed from the sim (check "kill") is gone from the next frame drawn.
// Headless Chrome with WebGPU on the machine's GPU; the page served from a built site (scripts/demo.ts styles):
//   bun scripts/play/objects.ts [--url http://127.0.0.1:8197/play/] [--chrome <path>] [--n 300] [--warm 7]   (warm: sim days, the page's ?warm)
// Exits 1 on any failure, printing what failed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL0 = arg("url", "http://127.0.0.1:8197/play/"), N = Number(arg("n", "300")), WARM = arg("warm", "");
const CHROME = arg("chrome", process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const sleep = (ms: number) => Bun.sleep(ms);

// ---------- a page over CDP ----------
const dir = mkdtempSync(join(tmpdir(), "nomads-objects-"));
const chrome = Bun.spawn([CHROME, "--headless=new", "--enable-unsafe-webgpu", "--window-size=1600,1143", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | null = null;
function done(code: number): never {
  ws?.close();
  chrome.kill();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => done(130));
process.on("SIGTERM", () => done(143));
// the page's warnings (the render worker's errors come as these), printed when something fails
const warnings: string[] = [];
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.log(`FAIL ${String(e)}`); for (const w of warnings.slice(-8)) console.log(`  page: ${w}`); done(1); });

let port = 0;
for (let i = 0; i < 300 && !port; i++) {
  await sleep(100);
  try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { port = 0; }
}
if (!port) { console.log("chrome did not start"); done(1); }
// a loaded machine's Chrome may list its page a while after it opens the port
type Target = { type: string; webSocketDebuggerUrl: string };
let pages: Target[] = [];
for (let i = 0; i < 300 && !pages.some((p) => p.type === "page"); i++) { await sleep(200); pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json() as Promise<Target[]>).catch(() => []); }
const target = pages.find((p) => p.type === "page");
if (!target) { console.log("chrome opened no page"); done(1); }
ws = new WebSocket(target.webSocketDebuggerUrl);
const opened = Promise.withResolvers<unknown>();
ws.onopen = opened.resolve;
await opened.promise;
type Reply = { result?: { result?: { value: unknown }; exceptionDetails?: { exception?: { description?: string } } }; error?: { message: string } };
let seq = 0;
const waiting = new Map<number, (m: Reply) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.method === "Runtime.consoleAPICalled" && /warn|error/.test(m.params.type)) warnings.push(m.params.args.map((a: { value?: unknown; description?: string }) => String(a.value ?? a.description ?? "")).join(" ").slice(0, 600));
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
};
function send(method: string, params: object = {}): Promise<Reply> {
  const id = ++seq, { promise, resolve } = Promise.withResolvers<Reply>();
  waiting.set(id, resolve);
  ws!.send(JSON.stringify({ id, method, params }));
  return promise;
}
// an expression evaluated in the page, awaited, its value returned (JSON-able)
async function page<T>(expr: string): Promise<T> {
  const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (m.error) throw new Error(m.error.message);
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? "page exception");
  return m.result?.result?.value as T;
}

const fails: string[] = [];
function fail(s: string) { fails.push(s); console.log(`FAIL ${s}`); }

// ---------- load ----------
const url = new URL(URL0);
url.searchParams.set("seed", "1");
url.searchParams.set("bench", "none");
if (WARM) url.searchParams.set("warm", WARM);
await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: String(url) });
const t0 = performance.now();
for (;;) {
  await sleep(1500);
  const s = await page<{ rev: number; failed: boolean } | null>("globalThis.play ? { rev: play.metrics.revealMs ?? 0, failed: document.body.classList.contains('failed') } : null").catch(() => null);
  if (s?.failed) { console.log("the page failed to load"); done(1); }
  if (s?.rev) break;
  if (performance.now() - t0 > 600_000) { console.log("no first view in 600 s"); done(1); }
}
console.log(`first view after ${((performance.now() - t0) / 1000).toFixed(0)} s`);
await page("(play.sim.paused = true, play.view.selected = null, 0)");

// ---------- 1. anchors ----------
// What view 0 drew, a sample of the stems among it with the place their buffer holds, and where live.js puts that place.
const ANCHORS = `(async (n) => {
  const { live, view } = play, D = live.debug, L = live.level.L, b = ((Math.round(view.bearing) % 8) + 8) % 8;
  const cam = D.camera(view, L, b), drawn = (await D.check({ op: "drawn" })).filter((d) => d.id && /^t\\d+$/.test(d.id));
  const pick = [], step = Math.max(1, Math.floor(drawn.length / n));
  for (let i = 0; i < drawn.length && pick.length < n; i += step) pick.push(drawn[i]);
  const at = await D.check({ op: "where", ids: pick.map((d) => d.id) });
  // a stem the sim let die between the frame and the read back is drawn no more in the next frame; one still drawn is
  // drawn dead
  const next = at.some((w) => w && !w.alive) ? new Set((await D.check({ op: "drawn" })).map((d) => d.id)) : null;
  return { level: live.levels[L].name, drawn: drawn.length, rows: pick.map((d, i) => {
    const w = at[i], p = w && D.project(cam.md, w.x, w.z);
    return { x: d.x, y: d.y, wx: d.wx, wz: d.wz, bx: w?.x, bz: w?.z, alive: !!w?.alive || !next?.has(d.id), died: !w?.alive, px: p ? Math.round(p.gx - cam.gx0) : null, py: p ? Math.round(p.gy - cam.gy0) : null };
  }) };
})`;
type Row = { x: number; y: number; wx: number; wz: number; bx: number; bz: number; alive: boolean; died: boolean; px: number | null; py: number | null };
const zooms = await page<Record<string, number>>("({ default: play.view.zoom, ...Object.fromEntries(['valley', 'region', 'isle100', 'island'].filter((k) => play.live.named[k] != null).map((k) => [k, play.live.named[k]])) })");
for (const [name, z] of Object.entries(zooms)) {
  await page(`(play.camera.setZoom(${z}), 0)`);
  await sleep(2000);
  const r = await page<{ level: string; drawn: number; rows: Row[] }>(`${ANCHORS}(${N})`);
  let off = 0, moved = 0, dead = 0, worst = 0;
  for (const q of r.rows) {
    if (!q.alive) { dead++; continue; }
    if (q.died) continue;
    if (Math.abs(q.wx - q.bx) > 1e-3 || Math.abs(q.wz - q.bz) > 1e-3) moved++;
    const d = q.px === null || q.py === null ? Infinity : Math.max(Math.abs(q.x - q.px), Math.abs(q.y - q.py));
    worst = Math.max(worst, d);
    if (d > 1) off++;
  }
  console.log(`${name.padEnd(8)} ${r.level.padEnd(8)} ${r.drawn} stems drawn, ${r.rows.length} sampled: ${off} anchors more than 1 px from live.debug.project (worst ${worst}), ${moved} read elsewhere than their buffer, ${dead} dead`);
  if (!r.rows.length) fail(`${name}: no stems drawn`);
  if (off || moved || dead) fail(`${name}: ${off} anchors off, ${moved} places differ, ${dead} drawn dead`);
}

// ---------- 2. far lists and their front lists ----------
// With the front lists off the far lists draw exactly what the whole index draws. With them on, a front level's view
// draws fewer specks (those behind another in their pixel are left out), so what it shows is compared instead: view 0's
// G-buffer (every pixel's kind, colour and flags, and whose it is) drawn from the front lists against the same view
// drawn from the far lists, beside two drawings from the far lists (specks of one pixel at one depth fall either way).
// FRONT_TOL of the pixels may differ past that [design: under one pixel in ten thousand, a float's rounding at half a
// pixel between the island's view and the shown one].
const FRONT_TOL = 1e-4;
const checkIn = (m: string, ms = 60000) => `Promise.race([play.live.debug.check(${m}), new Promise((_, no) => setTimeout(() => no(new Error("no answer to check")), ${ms}))])`;
const levelZooms = await page<number[]>("play.live.levels.map((l) => l.zoom)");
// The far lists as the world stands now it is paused: a page shown before its world warms runs warm ticks until the
// pause, and the deadwood's logs change by the hour, within the day a far list is built for
await page(checkIn("{ op: 'front', on: false }"));
await page(checkIn("{ op: 'far', on: true, rebuild: true }"));
await sleep(5000);
for (const z of levelZooms) {
  await page(`(play.camera.setZoom(${z}), 0)`);
  await sleep(1200);
  const name = await page<string>("play.live.levels[play.live.level.L].name");
  const on = await page<{ sprites: number; points: number }>(checkIn("{ op: 'count' }"));
  await page(checkIn("{ op: 'far', on: false }"));
  await sleep(300);
  const off = await page<{ sprites: number; points: number }>(checkIn("{ op: 'count' }"));
  await page(checkIn("{ op: 'far', on: true }"));
  console.log(`far ${name.padEnd(8)} ${on.sprites}/${on.points} sprites/specks with the far lists, ${off.sprites}/${off.points} without`);
  if (on.sprites !== off.sprites || on.points !== off.points) fail(`far lists at ${name} draw ${on.sprites}/${on.points}, the whole index ${off.sprites}/${off.points}`);
}
type Diff = { moved?: boolean; pixels: number; shows: number; owner: number };
const bearing = await page<number>("((Math.round(play.view.bearing) % 8) + 8) % 8");
for (const [L, z] of levelZooms.entries()) {
  await page(`(play.camera.setZoom(${z}), 0)`);
  await page(checkIn("{ op: 'front', on: true }"));
  // the front lists of this level and bearing, built a slice a frame once a view asks for them
  let built = false;
  for (let i = 0; i < 120 && !built; i++) {
    await sleep(500);
    const c = await page<{ front: Record<string, number> | null }>(checkIn("{ op: 'count' }"));
    built = Object.keys(c.front ?? {}).some((k) => k.endsWith(`|${L}|${bearing}`));
  }
  if (!built) continue;
  const name = await page<string>("play.live.levels[play.live.level.L].name");
  const counted = async () => page<{ sprites: number; points: number }>(checkIn("{ op: 'count' }"));
  const withFront = await counted();
  await page(checkIn("{ op: 'front', on: false }"));
  await sleep(300);
  const without = await counted();
  await page(checkIn("{ op: 'gsnap' }"));
  const noise = await page<Diff>(checkIn("{ op: 'gdiff' }"));
  await page(checkIn("{ op: 'front', on: true }"));
  await sleep(300);
  const d = await page<Diff>(checkIn("{ op: 'gdiff' }"));
  console.log(`front ${name.padEnd(8)} ${withFront.sprites}/${withFront.points} sprites/specks with its front lists, ${without.sprites}/${without.points} from its far lists; of ${d.pixels} px, ${d.shows} show otherwise and ${d.owner} another's (two drawings from the far lists: ${noise.shows} and ${noise.owner})`);
  if (d.moved || noise.moved) fail(`front ${name}: the view moved between the drawings compared`);
  else if (d.shows + d.owner > noise.shows + noise.owner + FRONT_TOL * d.pixels) fail(`front ${name}: ${d.shows + d.owner} of ${d.pixels} px differ from the far lists' drawing`);
}

// ---------- 3. cross-fades ----------
// In a cross-fade the renderer draws one level a frame and presents the other from the art it last drew it into: that
// kept art against the same view drawn again in the same frame, with the page's clock held (the water's and the fires'
// motion) and the haze band where the kept art has it (it is tied to the canvas), at rest and while zooming. At rest
// they may differ only as two drawings of one view do (specks of one pixel at one depth fall either way: FRONT_TOL);
// zooming, the kept art was drawn for a smaller or larger canvas, and FADE_TOL of the pixels may differ [design: one
// pixel in fifty, the depths' scale and the tile window following the canvas].
const FADE_TOL = 0.02;
type Fade = { level: number; pixels: number; differ: number; most: number; moved: number[] };
await page("(play.live.debug.hold(true), 0)");
for (let L = 0; L + 1 < levelZooms.length; L++) {
  const z = levelZooms[L] + 0.8 * (levelZooms[L + 1] - levelZooms[L]);
  await page(`(play.camera.setZoom(${z}), 0)`);
  await sleep(1500);
  const name = await page<string>(`play.live.levels[${L}].name`);
  // the best of three: a frame between the kept one and its check may land a change of the world (a tick in flight
  // when the sim was paused, a sprite made late), which the next keeps
  let rest = await page<Fade>(checkIn("{ op: 'fadecheck' }", 20000));
  for (let i = 0; i < 2 && rest.differ; i++) { const r = await page<Fade>(checkIn("{ op: 'fadecheck' }", 20000)); if (r.differ < rest.differ) rest = r; }
  // zooming out and in across the fade (t from 0.65 to 0.95), a little each frame, while the check takes the next frame
  // that keeps a view
  const lo = levelZooms[L] + 0.65 * (levelZooms[L + 1] - levelZooms[L]), hi = levelZooms[L] + 0.95 * (levelZooms[L + 1] - levelZooms[L]);
  await page(`(globalThis.__zoomer = (() => { let z = ${z}, d = -0.004; const step = () => { z += d; if (z < ${lo} || z > ${hi}) d = -d; play.camera.setZoom(z); if (globalThis.__zoomer) requestAnimationFrame(step); }; requestAnimationFrame(step); return true; })(), 0)`);
  await sleep(200);
  const moving = await page<Fade>(checkIn("{ op: 'fadecheck' }", 20000));
  await page("(globalThis.__zoomer = null, 0)");
  console.log(`fade ${name.padEnd(8)} at rest ${rest.differ} of ${rest.pixels} px differ; zooming (kept art ${moving.moved.join(", ")} art px off) ${moving.differ} of ${moving.pixels} px (most ${moving.most} of 255 in a channel)`);
  if (rest.differ > FRONT_TOL * rest.pixels) fail(`fade ${name}: the kept art differs from a new drawing at rest in ${rest.differ} of ${rest.pixels} px`);
  if (moving.differ > FADE_TOL * moving.pixels) fail(`fade ${name}: the kept art differs from a new drawing in ${moving.differ} of ${moving.pixels} px while zooming`);
}
await page("(play.live.debug.hold(false), 0)");

// ---------- 4. a kill ----------
await page(`(play.camera.setZoom(${zooms.default}), 0)`);
await sleep(2000);
const KILL = `(async () => {
  // a check the worker never answers (it posts an error instead) fails here rather than hanging the run
  const D = play.live.debug, C = (m) => Promise.race([D.check(m), new Promise((_, no) => setTimeout(() => no(new Error("no answer to check " + m.op)), 20000))]);
  const before = (await C({ op: "drawn" })).filter((d) => d.id && /^t\\d+$/.test(d.id));
  if (!before.length) return { id: null };
  const id = before[before.length >> 1].id, ok = await C({ op: "kill", id });
  // a few frames: the page sends one, the worker draws it with the kill applied
  await new Promise((r) => setTimeout(r, 300));
  const after = await C({ op: "drawn" }), w = (await C({ op: "where", ids: [id] }))[0];
  return { id, ok, still: after.some((d) => d.id === id), drawnAfter: after.length, alive: w?.alive ?? null };
})()`;
const k = await page<{ id: string | null; ok: boolean; still: boolean; drawnAfter: number; alive: boolean | null }>(KILL);
console.log(`kill ${k.id}: removed ${k.ok}, drawn in the next frame ${k.still} (of ${k.drawnAfter}), buffer alive ${k.alive}`);
if (!k.id || !k.ok || k.still) fail(`kill of ${k.id}: removed ${k.ok}, still drawn ${k.still}`);

console.log(fails.length ? `${fails.length} failed` : "all passed");
done(fails.length ? 1 : 0);
