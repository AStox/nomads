// The play page's objects as the render worker draws them straight from the GPU buffers (plan Unit 14), checked over the
// Chrome DevTools protocol against the buffers themselves:
//   1. anchors: at a few zooms, a sample of the stems drawn in view 0 stands where live.debug.project puts the place its
//      buffer holds (worker.js check "where", read back from the GPU), to within a pixel, and the cull read that place;
//   2. far lists: at every level the view draws exactly as many sprites and specks walking the far lists as walking the
//      whole spatial index (webgpu.js farBuild; the closer levels walk the index either way);
//   3. a kill: a drawn stem removed from the sim (check "kill") is gone from the next frame drawn.
// Headless Chrome with WebGPU on the machine's GPU; the page served from a built site (scripts/demo.ts styles):
//   bun scripts/play/objects.ts [--url http://127.0.0.1:8197/play/] [--chrome <path>] [--n 300] [--warm 2016]
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
// the page's warnings (the render worker's errors come as these), printed when something fails
const warnings: string[] = [];
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => { console.log(`FAIL ${String(e)}`); for (const w of warnings.slice(-8)) console.log(`  page: ${w}`); done(1); });

let port = 0;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try { port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { port = 0; }
}
if (!port) { console.log("chrome did not start"); done(1); }
const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
ws = new WebSocket(pages.find((p) => p.type === "page")!.webSocketDebuggerUrl);
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

// ---------- 2. far lists ----------
for (const z of await page<number[]>("play.live.levels.map((l) => l.zoom)")) {
  await page(`(play.camera.setZoom(${z}), 0)`);
  await sleep(1200);
  const name = await page<string>("play.live.levels[play.live.level.L].name");
  const on = await page<{ sprites: number; points: number }>("play.live.debug.check({ op: 'count' })");
  await page("play.live.debug.check({ op: 'far', on: false })");
  await sleep(300);
  const off = await page<{ sprites: number; points: number }>("play.live.debug.check({ op: 'count' })");
  await page("play.live.debug.check({ op: 'far', on: true })");
  console.log(`far ${name.padEnd(8)} ${on.sprites}/${on.points} sprites/specks with the far lists, ${off.sprites}/${off.points} without`);
  if (on.sprites !== off.sprites || on.points !== off.points) fail(`far lists at ${name} draw ${on.sprites}/${on.points}, the whole index ${off.sprites}/${off.points}`);
}

// ---------- 3. a kill ----------
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
