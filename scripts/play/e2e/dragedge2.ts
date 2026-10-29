// dragedge.ts: slow real drags across cube edges and corners; per mouse step the grabbed ground point's screen place against the mouse
//   lockf /tmp/nomads-gpu.lock bun dragedge.ts out.json   (env ONLY=EQ,PE,CO,CS  ZS=-2,0,1.5,3,4.5  STEPS=10)
import { writeFileSync } from "node:fs";
import { launch, sleep, idleWaiter } from "./lib.ts";
const SPOTS: [string, number, number, [number, number][]][] = [
  ["EQ", 17.35, 45.0, [[-20, 0], [20, 0], [20, 0], [-20, 0]]], ["PE", 45.0, 0.0, [[0, -20], [0, 20], [0, 20], [0, -20]]],
  ["CO", 35.26, 45.0, [[-20, -20], [20, 20], [20, 20], [-20, -20]]], ["CS", -35.26, 135.0, [[-20, 20], [20, -20], [20, -20], [-20, 20]]],
];
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean), ZS = (process.env.ZS ?? "-2,0,1.5,3,4.5").split(",").map(Number), STEPS = +(process.env.STEPS ?? 10);
const out: any[] = [];
await launch([1280, 800], "hour=13&warm=0", async (page) => {
  const idle = idleWaiter(page, 500);
  for (const [name, lat, lon, legs] of SPOTS.filter((s) => !ONLY.length || ONLY.includes(s[0]))) for (const z of ZS) {
    await page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, z);
    await idle();
    await page.evaluate(() => { const P = (window as any).play, A = P.live.groundUnder(P.view, 640, 400); (window as any).__A = A ? { x: A.x, z: A.z, y: A.y, geo: A.geo } : null; });
    if (!(await page.evaluate(() => !!(window as any).__A))) { out.push({ spot: name, z, nopick: true }); continue; }
    const sample = () => page.evaluate(() => { const P = (window as any).play, L = P.live, A = (window as any).__A; const s = L.screenOf(P.view, A.x, A.z, A.y, A.geo); const vg = P.view.geo; return { s: [s[0], s[1]], v: vg ? [vg.lat, vg.lon] : null, z: P.view.zoom }; });
    let px = 640, py = 400; await page.mouse.move(px, py); await sleep(100);
    const s0 = await sample(); await page.mouse.down();
    const rows: any[] = []; let prev = s0, step = 0;
    for (const [dx, dy] of legs) for (let i = 0; i < STEPS; i++) {
      px += dx; py += dy; await page.mouse.move(px, py); await sleep(70);
      const p = await sample(); step++;
      rows.push({ step, err: +Math.hypot(p.s[0] - px, p.s[1] - py).toFixed(1), jump: +Math.hypot(p.s[0] - prev.s[0] - dx, p.s[1] - prev.s[1] - dy).toFixed(1), view: p.v });
      prev = p;
    }
    await page.mouse.up(); await sleep(200);
    const worst = rows.reduce((a, b) => (b.jump > a.jump ? b : a));
    const row = { spot: name, z, maxJump: worst.jump, atStep: worst.step, atView: worst.view, finalErr: rows[rows.length - 1].err };
    out.push(row); console.log(JSON.stringify(row)); writeFileSync(process.argv[2] ?? "dragedge.json", JSON.stringify(out, null, 1));
  }
});
