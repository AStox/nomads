// real drag in many small steps; per step: expected shift at the cursor, measured shift at 3 regions, lowpass NCC at best shift
import { session, settle, setView, OUT, sleep, sharp, PLACES } from "./lib.ts";
import { luma, box, ncc } from "./img.ts";
import { writeFileSync, mkdirSync } from "node:fs";
const [place, zs, dxs, dys, nsteps, startx, starty] = process.argv.slice(2); const z = Number(zs === "zmin" ? -5.37 : zs), DX = Number(dxs), DY = Number(dys), N = Number(nsteps ?? 20);
const geo = PLACES[place] ?? (place.split(",").map(Number) as [number, number]);
const dir = `${OUT}/drag-${place.replace(",", "_")}-z${z}`; mkdirSync(dir, { recursive: true });
const sx = Number(startx ?? 800), sy = Number(starty ?? 500);
await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
  await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
  await setView(page, geo, z); await settle(page, 8000); await sleep(1200);
  const frames: any[] = []; let prev: any = null;
  const grab = async (i: number, step: [number, number]) => {
    const png: Buffer = await page.screenshot({ type: "png" }) as any; writeFileSync(`${dir}/${String(i).padStart(3, "0")}.png`, png);
    const L = box(await luma(png), 4); const g = await page.evaluate(() => { const P = (window as any).play; return { lat: P.view.geo.lat, lon: P.view.geo.lon }; });
    let row: any = { i, geo: [+g.lat.toFixed(3), +g.lon.toFixed(3)] };
    if (prev) {
      for (const [nm, reg] of [["L", [150, 250, 450, 700]], ["C", [650, 250, 950, 700]], ["R", [1150, 250, 1450, 700]]] as [string, [number, number, number, number]][]) {
        let best = { dx: 0, dy: 0, c: -2 }; const ex = Math.round(step[0]), ey = Math.round(step[1]);
        for (let dy = ey - 10; dy <= ey + 10; dy += 1) for (let dx = ex - 10; dx <= ex + 10; dx += 1) { const c = ncc(prev, L, reg, dx, dy); if (c > best.c) best = { dx, dy, c }; }
        row[nm] = [best.dx, best.dy, +best.c.toFixed(3)];
      }
    }
    prev = L; frames.push(row); return row;
  };
  await grab(0, [0, 0]);
  await page.mouse.move(sx, sy); await page.mouse.down();
  let lastx = sx, lasty = sy;
  for (let i = 1; i <= N; i++) { const nx = sx + DX * i / N, ny = sy + DY * i / N; await page.mouse.move(nx, ny, { steps: 3 }); await sleep(120); const r = await grab(i, [nx - lastx, ny - lasty]); console.log(i, JSON.stringify(r)); lastx = nx; lasty = ny; }
  await page.mouse.up();
  writeFileSync(`${dir}/rows.json`, JSON.stringify(frames));
});
