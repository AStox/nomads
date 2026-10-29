// frameseq.ts: while real input runs, per rAF: did the camera move, did the drawn canvas change (a 48x30 checksum). Reports the longest time the picture stood still while the camera moved,
// and how many camera-moving rAFs showed the same picture as the one before. Cases: steady drags (a move every 40 ms) and a wheel zoom.
//   lockf /tmp/nomads-gpu.lock bun frameseq.ts out.json   (env CASES=A0,A3,B1,H5,WZ  SITE)
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const CASES: Record<string, [string, number, number, number]> = { A0: ["drag", 4.35, -39.38, 0], A3: ["drag", 4.35, -39.38, 3], B1: ["drag", -35.9, 43.59, 1], H5: ["drag", 47.78, 38.63, 5], R2: ["drag", 12.02, 83.89, 2], E2: ["drag", 13.27, 45.0, -1], WZ: ["wheel", 4.35, -39.38, -4], WB: ["wheel", -35.9, 43.59, -3] };
const ONLY = (process.env.CASES ?? "A0,A3,B1,H5,R2,E2,WZ,WB").split(",");
const out: any[] = [];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 600);
  await page.evaluate(() => {
    const w = window as any, P = w.play; w.__s = { on: false, rows: [] };
    const cv = document.getElementById("view") as HTMLCanvasElement, c2 = document.createElement("canvas"); c2.width = 48; c2.height = 30; const x = c2.getContext("2d", { willReadFrequently: true })!;
    let pz = 0, pg = "";
    const loop = (t: number) => {
      if (w.__s.on) {
        const g = P.view.geo, gs = g.lat + "|" + g.lon + "|" + (g.hd ?? 0), moved = P.view.zoom !== pz || gs !== pg; pz = P.view.zoom; pg = gs;
        x.drawImage(cv, 0, 0, 48, 30); const d = x.getImageData(0, 0, 48, 30).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
        w.__s.rows.push([t, moved ? 1 : 0, h]);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  for (const name of ONLY) {
    const [kind, lat, lon, z] = CASES[name];
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle(); await sleep(500);
    await page.mouse.move(640, 400); await sleep(200);
    await page.evaluate(() => { (window as any).__s.rows = []; (window as any).__s.on = true; });
    if (kind === "drag") { await page.mouse.down(); for (let i = 0; i < 100; i++) { await page.mouse.move(640 + (i % 50) * 4 * (i < 50 ? 1 : -1), 400 + (i % 10)); await sleep(40); } await page.mouse.up(); }
    else { for (let i = 0; i < 50; i++) { await page.mouse.wheel({ deltaY: 100 }); await sleep(100); } for (let i = 0; i < 50; i++) { await page.mouse.wheel({ deltaY: -100 }); await sleep(100); } }
    const rows: number[][] = await page.evaluate(() => { (window as any).__s.on = false; return (window as any).__s.rows; });
    let movedN = 0, same = 0, run = 0, runMax = 0, lastChange = rows[0]?.[0] ?? 0, gapMax = 0, dtMax = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], p = rows[i - 1]; dtMax = Math.max(dtMax, r[0] - p[0]);
      if (r[2] !== p[2]) { gapMax = Math.max(gapMax, r[0] - lastChange); lastChange = r[0]; }
      if (r[1]) { movedN++; if (r[2] === p[2]) { same++; run++; runMax = Math.max(runMax, run); } else run = 0; } else run = 0;
    }
    const row = { name, kind, rafs: rows.length, moved: movedN, movedSamePicture: same, longestRunRafs: runMax, maxMsBetweenNewPictures: Math.round(gapMax), rafMaxMs: Math.round(dtMax) };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(process.argv[2] ?? "frameseq.json", JSON.stringify(out));
  }
});
