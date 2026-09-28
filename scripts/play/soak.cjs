// 30 minute soak: tours every bearing and zoom with real keyboard, wheel and drag input, sampling this browser's own
// process tree RSS every 30 s. Run: node scripts/play/soak.cjs [minutes] [url]
const { chromium } = require("/root/tools/pw/node_modules/playwright");
const { execSync } = require("child_process");
const fs = require("fs");
const mins = Number(process.argv[2] || 30), url = process.argv[3] || "https://goldclaw.duckdns.org/nomads-styles/play/";
const tree = (pid) => { const out = [pid]; for (let k = 0; k < out.length; k++) { try { out.push(...execSync(`pgrep -P ${out[k]}`).toString().trim().split(/\s+/).filter(Boolean).map(Number)); } catch {} } return out; };
const rssMB = (pid) => tree(pid).reduce((a, p) => { try { return a + Number(execSync(`ps -o rss= -p ${p}`).toString().trim() || 0); } catch { return a; } }, 0) / 1024;
(async () => {
  let browser;
  process.once("SIGTERM", async () => { try { await browser?.close(); } catch {} process.exit(143); });
  const mark = `--soak-mark-${process.pid}`;
  browser = await chromium.launch({ args: ["--no-sandbox", "--enable-precise-memory-info", mark] });
  const pid = Number(execSync(`pgrep -f -- ${mark} | head -1`).toString().trim()), rows = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => window.play?.metrics?.revealMs > 0 || document.body.classList.contains("failed"), null, { timeout: 240000 });
    const t0 = Date.now(), end = t0 + mins * 60e3;
    let nextSample = t0, step = 0;
    while (Date.now() < end) {
      if (Date.now() >= nextSample) {
        const s = await page.evaluate(() => ({ heap: Math.round(performance.memory.usedJSHeapSize / 1e6), cache: play.live.stats.cacheMB ?? 0, chunks: play.live.cache.size, fps: Math.round(play.live.stats.fps) }));
        rows.push({ min: +((Date.now() - t0) / 60e3).toFixed(1), rssMB: Math.round(rssMB(pid)), ...s });
        console.log(JSON.stringify(rows.at(-1)));
        nextSample += 30e3;
      }
      // one action every 3 s: turn, zoom about a random point, or drag
      const r = step++ % 5, x = 200 + Math.random() * 880, y = 150 + Math.random() * 420;
      if (r === 0) await page.keyboard.press(Math.random() < 0.5 ? "q" : "e");
      else if (r === 1 || r === 3) { await page.mouse.move(x, y); for (let k = 0; k < 6; k++) { await page.mouse.wheel(0, (Math.random() < 0.5 ? -1 : 1) * 120); await page.waitForTimeout(60); } }
      else { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + (Math.random() - 0.5) * 500, y + (Math.random() - 0.5) * 300, { steps: 12 }); await page.mouse.up(); }
      await page.waitForTimeout(3000);
    }
    fs.writeFileSync("/tmp/nomads-soak-rss.json", JSON.stringify({ rows, errors: errs.slice(0, 10) }));
    console.log("errors", errs.length);
  } finally { try { await browser?.close(); } catch {} }
})().catch((e) => { console.error(e); process.exit(1); });
