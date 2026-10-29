// One wheel tick at a held cursor: where the ground that was under the cursor is drawn afterwards, by the API (the pick before the tick, screenOf after) and by the picture (a patch of the first still found again in the
// second, scaled by the tick's zoom step). The two must agree: the page holds the ground the worker's pick names, and the picture is what the planet pass marched (e2e OPEN item 2: B at zoom 1.5 moved 72 to 96 px by
// the picture while the API said 0.1 to 13).
//   lockf /tmp/nomads-gpu.lock bun scripts/play/audit/perf/tick.ts      SITE, PROFILE, VIEW=-35.9034,43.5937 ZOOM=1.5 DIR=-1 (wheel deltaY sign: -1 in) XS, YS (cursors), PATCH (px, 64), REACH (search px, 140)
import { launch, sleep, load, sharp } from "./lib";
const [lat, lon] = (process.env.VIEW ?? "-35.9034,43.5937").split(",").map(Number), Z = Number(process.env.ZOOM ?? 1.5), DIR = Number(process.env.DIR ?? -1);
const XS = (process.env.XS ?? "400,640,880").split(",").map(Number), YS = (process.env.YS ?? "300,480").split(",").map(Number), PATCH = Number(process.env.PATCH ?? 64), REACH = Number(process.env.REACH ?? 140);
const grey = async (png: Buffer) => { const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true }); return { d: data as Uint8Array, w: info.width as number, h: info.height as number }; };
// the offset of the patch (a window of a, centred on (cx, cy), scaled by s) in b, by normalised correlation on every 2nd px, then refined at full resolution
async function find(a: Buffer, b: Buffer, cx: number, cy: number, s: number) {
  const A = await grey(a), B = await grey(b), half = PATCH / 2;
  const { data: pd, info: pi } = await sharp(a).extract({ left: Math.round(cx - half), top: Math.round(cy - half), width: PATCH, height: PATCH }).resize(Math.round(PATCH * s), Math.round(PATCH * s), { kernel: "lanczos3" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const pw = pi.width, ph = pi.height;
  const ncc = (ox: number, oy: number, st: number) => {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < ph; y += st) for (let x = 0; x < pw; x += st) {
      const u = pd[y * pw + x], v = B.d[(oy + y) * B.w + ox + x];
      n++; sa += u; sb += v; saa += u * u; sbb += v * v; sab += u * v;
    }
    const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    return va > 1 && vb > 1 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1;
  };
  let best = { x: 0, y: 0, c: -2 };
  // the patch's own middle stands at the cursor if nothing moved: its corner at cx - pw / 2
  for (let dy = -REACH; dy <= REACH; dy += 2) for (let dx = -REACH; dx <= REACH; dx += 2) {
    const ox = Math.round(cx - pw / 2 + dx), oy = Math.round(cy - ph / 2 + dy);
    if (ox < 0 || oy < 0 || ox + pw > B.w || oy + ph > B.h) continue;
    const c = ncc(ox, oy, 2);
    if (c > best.c) best = { x: dx, y: dy, c };
  }
  const c0 = { ...best };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const ox = Math.round(cx - pw / 2 + c0.x + dx), oy = Math.round(cy - ph / 2 + c0.y + dy);
    if (ox < 0 || oy < 0 || ox + pw > B.w || oy + ph > B.h) continue;
    const c = ncc(ox, oy, 1);
    if (c > best.c || (dx === -2 && dy === -2)) best = { x: c0.x + dx, y: c0.y + dy, c };
  }
  void A;
  return best;
}
const r = await launch({ profile: process.env.PROFILE, vw: 1280, vh: 800 });
try {
  await load(r, "?hour=13&warm=0");
  const idle = async () => { for (let i = 0; i < 60; i++) { await sleep(450); const q = await r.page.evaluate(() => (window as any).play.live.debug.check({ op: "idle" })).catch(() => ({ busy: true })); if (!q.busy) { await sleep(700); return; } } };
  for (const y of YS) for (const x of XS) {
    await r.page.evaluate((a: number, b: number, zz: number) => { const P = (window as any).play; P.view.bearing = 0; P.view.geo = { lat: a, lon: b }; P.camera.setZoom(zz); }, lat, lon, Z);
    await idle();
    await r.page.mouse.move(x, y); await sleep(500);
    const s0 = (await r.page.screenshot({ type: "png" })) as Buffer;
    const A = await r.page.evaluate((px: number, py: number) => { const w = window as any, P = w.play, a = P.live.groundUnder(P.view, px, py); w.__A = a && { x: a.x, z: a.z, y: a.y, geo: a.geo }; const G = P.live.stats.ground; return w.__A && { y: a.y, z: P.view.zoom, exact: !!G && G.y === a.y, exactY: G?.y }; }, x, y);
    if (!A) { console.log(`cursor ${x},${y}: no ground`); continue; }
    await r.page.mouse.wheel({ deltaY: DIR * 100 });
    await idle();
    const s1 = (await r.page.screenshot({ type: "png" })) as Buffer;
    const e = await r.page.evaluate((px: number, py: number) => { const w = window as any, P = w.play, s = P.live.screenOf(P.view, w.__A.x, w.__A.z, w.__A.y, w.__A.geo); return { z: P.view.zoom, d: Math.hypot(s[0] - px, s[1] - py) }; }, x, y);
    if (process.env.DUMP) { const half = 160, sc = 2 ** (e.z - A.z); await sharp(s0).extract({ left: Math.max(0, x - half), top: Math.max(0, y - half), width: Math.min(2 * half, 1280 - Math.max(0, x - half)), height: Math.min(2 * half, 800 - Math.max(0, y - half)) }).toFile(`${process.env.DUMP}-${x}-${y}-a.png`); await sharp(s1).extract({ left: Math.max(0, x - half), top: Math.max(0, y - half), width: Math.min(2 * half, 1280 - Math.max(0, x - half)), height: Math.min(2 * half, 800 - Math.max(0, y - half)) }).toFile(`${process.env.DUMP}-${x}-${y}-b.png`); void sc; }
    const m = await find(s0, s1, x, y, 2 ** (e.z - A.z));
    console.log(`cursor ${x},${y}: zoom ${A.z.toFixed(2)} to ${e.z.toFixed(2)}, API shift ${e.d.toFixed(1)} px, picture shift ${Math.hypot(m.x, m.y).toFixed(1)} px (${m.x},${m.y}, correlation ${m.c.toFixed(2)}), pick y ${A.y.toFixed(0)}${A.exact ? " (exact)" : ` (relief grid; exact ${A.exactY?.toFixed?.(0)})`}`);
  }
} finally { await r.close(); }
process.exit(0);
