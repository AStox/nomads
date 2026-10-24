// the same view drawn from the tier cells (before a window) and from the fine pages (after one), water masks compared
import { session, settle, setView, shot, OUT, sleep, sharp, PLACES } from "./lib.ts";
const places: Record<string, [number, number]> = JSON.parse(process.argv[2]); const zs = (process.argv[3] ?? "2.5,2.0,1.5").split(",").map(Number);
const mask = async (png: Buffer) => { const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }); const m = new Uint8Array(info.width * info.height); for (let i = 0; i < m.length; i++) { const R = data[i * 3], G = data[i * 3 + 1], B = data[i * 3 + 2]; m[i] = B > R + 25 && B > 50 && B >= G ? 1 : 0; } return { m, W: info.width, H: info.height }; };
for (const [name, geo] of Object.entries(places)) for (const z of zs) {
  await session([1600, 1000], "zoom=island&hour=13&warm=0", async (page) => {
    await page.evaluate(() => { const s = (window as any).play.sim; if (s) s.paused = true; });
    await setView(page, geo, z); await settle(page, 7000); await sleep(4000); await settle(page, 5000);
    const a = await shot(page, `cc-${name}-z${z}-tier`);
    await setView(page, null, 3.6); await settle(page, 12000); await sleep(5000); await settle(page, 8000);
    await setView(page, null, z); await settle(page, 8000); await sleep(3000);
    const b = await shot(page, `cc-${name}-z${z}-fine`);
    const A = await mask(a.png), B = await mask(b.png); const W = A.W, H = A.H;
    let best = { dx: 0, dy: 0, iou: -1 };
    for (let dy = -14; dy <= 14; dy++) for (let dx = -14; dx <= 14; dx++) { let i = 0, u = 0; for (let y = 80; y < H - 120; y += 2) for (let x = 80; x < W - 80; x += 2) { const p = A.m[y * W + x], q = B.m[(y + dy) * W + x + dx]; if (p && q) i++; if (p || q) u++; } const iou = u ? i / u : 0; if (iou > best.iou) best = { dx, dy, iou }; }
    let i0 = 0, u0 = 0, wa = 0, wb = 0; for (let y = 80; y < H - 120; y += 2) for (let x = 80; x < W - 80; x += 2) { const p = A.m[y * W + x], q = B.m[y * W + x]; wa += p; wb += q; if (p && q) i0++; if (p || q) u0++; }
    console.log(JSON.stringify({ name, z, waterTierPct: +(wa / ((H - 200) / 2 * (W - 160) / 2) * 100).toFixed(1), waterFinePct: +(wb / ((H - 200) / 2 * (W - 160) / 2) * 100).toFixed(1), iouAtZero: +(i0 / Math.max(1, u0)).toFixed(3), bestShift: best }));
  });
}
