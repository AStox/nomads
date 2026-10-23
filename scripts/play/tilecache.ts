// Gate for demo/styles/isopixel/tilecache.js: 12 distinct ground tiles through fetchTileBytes cold (network), then warm (OPFS) after a
// reload of the page; prints ms and bytes each way, and checks the bytes equal (hash, and the file's own gunzip), the eviction order,
// and that a full disk (QuotaExceededError on every write) still loads.
//   bun scripts/play/tilecache.ts [siteDir] [chromeProfileDir]
// siteDir holds `planets/` (as scripts/demo.ts styles builds it) and `isopixel/tilecache.js`; default ~/.cache/nomads-play.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

// puppeteer-core is a global install, so its path is known only at run time
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
type State = { files: number; bytes: number; budget: number; names: string[] };
declare global {
  interface Window {
    tc: {
      fetchTileBytes(url: string): Promise<{ raw: Uint8Array; bytes: number }>;
      settleCache(): Promise<void>;
      cacheState(budget?: number): Promise<State>;
      clearCache(): Promise<void>;
    };
  }
}
const SITE = process.argv[2] ?? join(homedir(), ".cache/nomads-play"), PROFILE = process.argv[3] ?? "/tmp/globe-slice-a-chrome";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLANET = "link-1-7f6ff6c82cdd";
const TILES = [[0, 3, 3], [0, 4, 3], [0, 3, 4], [0, 4, 4], [1, 10, 12], [1, 11, 12], [1, 10, 13], [2, 5, 20], [2, 6, 20], [3, 15, 15], [4, 8, 8], [5, 25, 5]];
const tilePath = ([f, tx, ty]: number[]) => `groundtiles/f${f}/${ty}-${tx}.gt.gz`;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const file = Bun.file(join(SITE, decodeURIComponent(new URL(req.url).pathname)));
    return (await file.exists()) ? new Response(file, { headers: { "Cache-Control": "no-store" } }) : new Response("no", { status: 404 });
  },
});
const origin = `http://localhost:${server.port}`;
rmSync(PROFILE, { recursive: true, force: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [`--user-data-dir=${PROFILE}`, "--window-size=800,600"] });
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed = true; };

try {
  const page = await browser.newPage();
  page.on("pageerror", (e: Error) => console.log("pageerror", e.message));
  const go = async () => {
    await page.goto(`${origin}/planets/1.json`);
    await page.evaluate(`import("${origin}/isopixel/tilecache.js").then((m) => { window.tc = m; })`);
  };
  // each tile in turn: ms and bytes moved, and the sha-256 of what came back
  const run = (paths: string[]) => page.evaluate(async (urls: string[]) => {
    const out = [];
    for (const url of urls) {
      const t0 = performance.now(), { raw, bytes } = await window.tc.fetchTileBytes(url), ms = performance.now() - t0;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))].map((b) => b.toString(16).padStart(2, "0")).join("");
      out.push({ ms, bytes, hash });
    }
    return out;
  }, paths.map((p) => `${origin}/planets/${PLANET}/${p}`));

  await go();
  await page.evaluate(() => window.tc.clearCache());
  await go();
  const paths = TILES.map(tilePath);
  const cold = await run(paths);
  await page.evaluate(() => window.tc.settleCache());
  const state = await page.evaluate(() => window.tc.cacheState());
  await go();
  const warm = await run(paths);

  const truth = paths.map((p) => createHash("sha256").update(gunzipSync(readFileSync(join(SITE, "planets", PLANET, p)))).digest("hex"));
  const sum = (a: { ms: number; bytes: number }[], k: "ms" | "bytes") => a.reduce((x, r) => x + r[k], 0);
  console.log(`cold: ${sum(cold, "ms").toFixed(0)} ms, ${sum(cold, "bytes")} bytes; warm: ${sum(warm, "ms").toFixed(0)} ms, ${sum(warm, "bytes")} bytes (kept ${state.files} files, ${state.bytes} bytes)`);
  console.log("per tile ms cold:", cold.map((r) => r.ms.toFixed(0)).join(" "), "| warm:", warm.map((r) => r.ms.toFixed(0)).join(" "));
  check(cold.every((r, i) => r.hash === truth[i]), "cold bytes equal the file's own gunzip");
  check(warm.every((r, i) => r.hash === cold[i].hash), "warm bytes equal cold (hash)");
  check(sum(cold, "bytes") >= 3 * Math.max(1, sum(warm, "bytes")), `warm moved at least 3x fewer bytes (${sum(warm, "bytes")} vs ${sum(cold, "bytes")})`);
  check(sum(warm, "ms") <= sum(cold, "ms"), `warm not slower in ms (${sum(warm, "ms").toFixed(0)} vs ${sum(cold, "ms").toFixed(0)})`);

  // least lately used goes first: read 0 and 1 again, ask for a budget of 4 files, and the survivors are those read last
  const keep = [10, 11, 0, 1], room = keep.reduce((a, i) => a + cold[i].bytes, 0) + 1;
  await go();
  await run([paths[0], paths[1]]);
  const trimmed = await page.evaluate((b: number) => window.tc.cacheState(b), room);
  check(trimmed.files === 4 && trimmed.bytes <= room && trimmed.names.join() === keep.map((i) => paths[i].replaceAll("/", "~")).join(),
    `budget evicts least lately used first (${trimmed.files} files kept, ${(trimmed.bytes / 1e6).toFixed(1)} MB)`);

  // a full disk: every write throws, loads still return the right bytes
  await go();
  await page.evaluate(() => window.tc.clearCache());
  await go();
  await page.evaluate(() => { FileSystemFileHandle.prototype.createWritable = () => Promise.reject(new DOMException("full", "QuotaExceededError")); });
  const full = await run(paths.slice(0, 3));
  check(full.every((r, i) => r.hash === truth[i] && r.bytes > 0), "a full disk loads from the network with the right bytes");

  // a corrupt file is replaced from the network
  await go();
  await page.evaluate(() => window.tc.clearCache());
  await go();
  await run([paths[0]]);
  await page.evaluate(() => window.tc.settleCache());
  await page.evaluate(async (name: string) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("tilecache"), dir = await root.getDirectoryHandle("1-7f6ff6c82cdd");
    const w = await (await dir.getFileHandle(name)).createWritable();
    await w.write(new Uint8Array(1000).fill(7)); await w.close();
  }, paths[0].replaceAll("/", "~"));
  await go();
  const fixed = await run([paths[0]]);
  await page.evaluate(() => window.tc.settleCache());
  fixed.push(...(await run([paths[0]])));
  check(fixed[0].hash === truth[0] && fixed[0].bytes > 0 && fixed[1].bytes === 0, "a corrupt file is refetched, then kept again");

  // a 404 throws with its status and keeps nothing
  const miss = await page.evaluate(async (url: string) => window.tc.fetchTileBytes(url).then(() => 0, (e: { status: number }) => e.status), `${origin}/planets/${PLANET}/groundtiles/f0/nope.gt.gz`);
  check(miss === 404, "a missing file throws with status 404");
  await page.evaluate(() => window.tc.clearCache());
} finally {
  await browser.close();
  server.stop(true);
  rmSync(PROFILE, { recursive: true, force: true });
}
if (!existsSync(SITE)) process.exit(2);
process.exit(failed ? 1 : 0);
