// The zoom sweep (plan R7): the play page's camera held at a place while its zoom runs from the whole planet to the close ground and back in small steps, each step settled
// (the window and its trees arrived, the planet's tiles loaded) and photographed; what is plotted against zoom is how much the picture changes from one step to the next, its mean
// colour and its detail. A smooth zoom changes the picture a little at every step; a mode switch is a spike. Spikes are listed, with the plot (plot.html) and the frames.
//   lockf /tmp/nomads-gpu.lock bun scripts/play/zoomsweep.ts <siteUrl> <outDir> [--place A|B|C|home] [--step 0.1] [--zmin -6] [--zmax 9.2] [--vp 1600x1000] [--profile /tmp/dir]
// Places are the harness's: A [4.35, -39.38], B [-5.38, 73.13], C [16.8, 84.38]; home is where the page starts. Run one place a command (a sweep is a few minutes).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// puppeteer-core and sharp are global installs, so their paths are known only at run time
const puppeteer = (await import(join(homedir(), ".bun/install/global/node_modules/puppeteer-core"))).default;
const sharp = (await import(join(homedir(), ".bun/install/global/node_modules/sharp/dist/index.cjs"))).default;

const args = process.argv.slice(2), at = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [SITE, OUT] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const PLACES: Record<string, [number, number] | null> = { A: [4.35, -39.38], B: [-5.38, 73.13], C: [16.8, 84.38], home: null };
const place = at("--place", "A"), STEP = Number(at("--step", "0.1")), ZMIN = at("--zmin", ""), ZMAX = Number(at("--zmax", "9.2")), [VW, VH] = at("--vp", "1600x1000").split("x").map(Number), PROFILE = at("--profile", "/tmp/globe-sweep-chrome");
if (!SITE || !OUT || !(place in PLACES)) { console.error("usage: zoomsweep.ts <siteUrl> <outDir> [--place A|B|C|home] [--step 0.1] [--zmin z] [--zmax 9.2] [--vp 1600x1000]"); process.exit(2); }
const sleep = Bun.sleep;
rmSync(PROFILE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--headless=new", "--enable-unsafe-webgpu", `--window-size=${VW},${VH + 143}`, `--user-data-dir=${PROFILE}`],
  defaultViewport: { width: VW, height: VH, deviceScaleFactor: 1 },
});

interface Sample { z: number; dir: "in" | "out"; diff: number; luma: number; detail: number; dLuma: number; dDetail: number; alpha: number; mode: string; settled: boolean; file: string }
const samples: Sample[] = [];
try {
  const page = await browser.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e: Error) => errs.push(e.message));
  page.on("console", (m: { text(): string }) => { if (/WEBGPU LOST/.test(m.text())) errs.push(m.text()); });
  await page.goto(`${SITE}/play/?zoom=island&hour=13&warm=0`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("body.ready", { timeout: 180000 });
  // a page with a game on it is paused so its weather and light hold; the world alone has no sim to pause
  await page.evaluate(() => { const s = (window as unknown as { play: { sim: { paused: boolean } | null } }).play.sim; if (s) s.paused = true; });
  await sleep(2000);
  const zmin = ZMIN ? Number(ZMIN) : await page.evaluate(() => (window as any).play.live.zmin as number);
  const geo = PLACES[place];
  if (geo) await page.evaluate((g: [number, number]) => { (window as any).play.view.geo = { lat: g[0], lon: g[1] }; }, geo);
  const zs: [number, "in" | "out"][] = [];
  for (let z = zmin; z <= ZMAX + 1e-9; z += STEP) zs.push([+z.toFixed(3), "in"]);
  for (let z = ZMAX - STEP; z >= zmin - 1e-9; z -= STEP) zs.push([+z.toFixed(3), "out"]);
  // one step: the zoom set, then waited on until nothing the page reports changes for 700 ms (the window, its trees, the alpha), at most 9 s
  const settle = (z: number) => page.evaluate(async (zz: number) => {
    const P = (window as any).play, L = P.live, sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
    L.debug.hold(false);
    P.camera.setZoom(zz);
    const key = () => { const w = L.stats.window; return `${L.mode}|${(L.stats.ladderAlpha ?? 0).toFixed(3)}|${w?.id}|${w?.objects}|${L.stats.tiles ?? ""}`; };
    const t0 = performance.now();
    let last = key(), since = performance.now();
    await sleepMs(350);
    while (performance.now() - t0 < 9000) {
      await sleepMs(100);
      const k = key();
      if (k !== last) { last = k; since = performance.now(); }
      else if (performance.now() - since > 700) break;
    }
    const settled = performance.now() - since > 700;
    L.debug.hold(true);
    await sleepMs(250);
    return { settled, alpha: +(L.stats.ladderAlpha ?? 0).toFixed(3), mode: String(L.mode) };
  }, z);
  let prev: Buffer | null = null, prevL = NaN, prevD = NaN;
  let n = 0;
  for (const [z, dir] of zs) {
    const st = await settle(z);
    const png: Buffer = await page.screenshot({ type: "png" });
    const small = await sharp(png).resize(320, 200, { fit: "fill" }).removeAlpha().raw().toBuffer();
    // the mean luma, and the detail as the mean absolute difference of horizontally and vertically adjacent pixels' luma
    const lum = new Float32Array(320 * 200);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * small[i * 3] + 0.587 * small[i * 3 + 1] + 0.114 * small[i * 3 + 2];
    let sum = 0, edge = 0;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) { const v = lum[y * 320 + x]; sum += v; if (x < 319) edge += Math.abs(lum[y * 320 + x + 1] - v); if (y < 199) edge += Math.abs(lum[(y + 1) * 320 + x] - v); }
    const luma = sum / lum.length, detail = edge / (lum.length * 2);
    let diff = NaN;
    if (prev) { let d = 0; for (let i = 0; i < small.length; i++) d += Math.abs(small[i] - prev[i]); diff = d / small.length; }
    const file = `frames/${String(n++).padStart(3, "0")}-${dir}-${z.toFixed(2)}.jpg`;
    await sharp(png).resize(400, 250).jpeg({ quality: 80 }).toFile(join(OUT, file));
    samples.push({ z, dir, diff, luma, detail, dLuma: Math.abs(luma - prevL), dDetail: Math.abs(detail - prevD), alpha: st.alpha, mode: st.mode, settled: st.settled, file });
    prev = small; prevL = luma; prevD = detail;
  }
  // spikes: a step whose change is over three times the median of the steps round it (and over a floor, so a still part of the sweep does not shout)
  const spikes: { z: number; dir: string; series: string; value: number; around: number }[] = [];
  const series: [keyof Sample, number][] = [["diff", 1.5], ["dLuma", 1.5], ["dDetail", 0.6]];
  for (const dir of ["in", "out"] as const) {
    const row = samples.filter((s) => s.dir === dir);
    for (const [key, floor] of series) {
      row.forEach((s, i) => {
        const v = s[key] as number;
        if (!Number.isFinite(v) || (i === 0 && dir === "in")) return;
        const near = row.slice(Math.max(0, i - 6), i + 7).filter((_, j) => j !== Math.min(i, 6)).map((q) => q[key] as number).filter(Number.isFinite).sort((a, b) => a - b);
        const med = near.length ? near[Math.floor(near.length / 2)] : 0;
        if (v > floor && v > 3 * med) spikes.push({ z: s.z, dir, series: key, value: +v.toFixed(2), around: +med.toFixed(2) });
      });
    }
  }
  writeFileSync(join(OUT, "data.json"), JSON.stringify({ site: SITE, place, step: STEP, vp: [VW, VH], errors: errs, spikes, samples }, null, 1));
  // the plot: three series against zoom, the way in and the way out, spikes ringed
  const W = 1100, Hh = 160, pad = 46, zs0 = samples[0].z, zs1 = ZMAX, X = (z: number) => pad + ((z - zs0) / (zs1 - zs0)) * (W - pad - 12);
  const plot = (key: keyof Sample, title: string) => {
    const vals = samples.map((s) => s[key] as number).filter(Number.isFinite), top = Math.max(...vals, 1e-6) * 1.08, Y = (v: number) => 16 + (1 - v / top) * (Hh - 34);
    const line = (dir: string, col: string) => `<polyline fill="none" stroke="${col}" stroke-width="1.4" points="${samples.filter((s) => s.dir === dir && Number.isFinite(s[key] as number)).map((s) => `${X(s.z).toFixed(1)},${Y(s[key] as number).toFixed(1)}`).join(" ")}"/>`;
    const rings = spikes.filter((p) => p.series === key).map((p) => `<circle cx="${X(p.z).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="6" fill="none" stroke="#d22"/><text x="${X(p.z).toFixed(1)}" y="${(Y(p.value) - 9).toFixed(1)}" font-size="10" text-anchor="middle" fill="#d22">${p.z}</text>`).join("");
    const ticks = Array.from({ length: Math.floor(zs1 - Math.ceil(zs0)) + 1 }, (_, i) => Math.ceil(zs0) + i).map((z) => `<line x1="${X(z)}" x2="${X(z)}" y1="${Hh - 18}" y2="${Hh - 14}" stroke="#666"/><text x="${X(z)}" y="${Hh - 4}" font-size="9" text-anchor="middle" fill="#666">${z}</text>`).join("");
    return `<svg width="${W}" height="${Hh}" style="background:#fafafa;margin:6px 0;border:1px solid #ddd"><text x="6" y="12" font-size="12">${title} (peak ${top.toFixed(2)})</text>${line("in", "#1565c0")}${line("out", "#ef6c00")}${rings}${ticks}</svg>`;
  };
  const alpha = `<svg width="${W}" height="60" style="background:#fafafa;margin:6px 0;border:1px solid #ddd"><text x="6" y="12" font-size="12">the ladder's alpha and mode (home/win drawn by the ladder; planet alone where alpha is 0)</text>${samples.filter((s) => s.dir === "in").map((s) => `<rect x="${X(s.z) - 3}" y="${48 - s.alpha * 30}" width="6" height="${s.alpha * 30 + 1}" fill="${s.mode === "win" ? "#2e7d32" : "#6a1b9a"}"/>`).join("")}</svg>`;
  const html = `<!doctype html><meta charset="utf-8"><title>zoom sweep ${place}</title><body style="font:13px sans-serif;margin:16px"><h2>Zoom sweep at ${place}, steps of ${STEP}, ${VW}x${VH}</h2><p>blue: zooming in, orange: zooming out. A smooth zoom shows a low, even line; a spike is a switch. ${spikes.length ? `<b style="color:#d22">${spikes.length} spikes</b>` : "<b style=\"color:#2e7d32\">no spikes</b>"}${errs.length ? ` <b style="color:#d22">errors: ${errs.join("; ")}</b>` : ""}</p>${plot("diff", "change from the step before (mean absolute difference, 0 to 255)")}${plot("luma", "mean luma")}${plot("detail", "detail (mean luma change between neighbouring pixels)")}${plot("dDetail", "change in detail from the step before")}${alpha}<h3>Spikes</h3><pre>${spikes.map((p) => `${p.dir} z ${p.z}: ${p.series} ${p.value} (neighbours ${p.around})`).join("\n") || "none"}</pre><h3>Frames at the spikes</h3>${[...new Set(spikes.map((p) => p.z))].slice(0, 12).map((z) => samples.filter((s) => s.z === z).map((s) => `<img src="${s.file}" title="${s.dir} ${z}"/>`).join("")).join("<br>")}</body>`;
  writeFileSync(join(OUT, "plot.html"), html);
  const unsettled = samples.filter((s) => !s.settled).map((s) => `${s.dir}${s.z}`);
  console.log(`${place}: ${samples.length} steps ${zs0} to ${ZMAX}, ${spikes.length} spikes${unsettled.length ? `, unsettled ${unsettled.join(" ")}` : ""}${errs.length ? `, ERRORS ${errs.join("; ")}` : ""}`);
  for (const p of spikes) console.log(`  ${p.dir} z ${p.z}: ${p.series} ${p.value} (neighbours ${p.around})`);
  console.log(`report: ${join(OUT, "plot.html")}`);
} finally {
  await browser.close();
}
process.exit(0);
