import { sharp, OUT } from "./lib.ts";
const [place, z, ex, ey, rr = "50"] = process.argv.slice(2);
const grey = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().greyscale().blur(5).raw().toBuffer({ resolveWithObject: true }); const o = new Float32Array(data.length); for (let i = 0; i < o.length; i++) o[i] = data[i]; return { d: o, w: info.width, h: info.height }; };
const A = await grey(`${OUT}/t3-${place}-${z}-g0.png`), B = await grey(`${OUT}/t3-${place}-${z}-g1.png`);
const out: string[] = [];
for (const [bx, by] of [[100, 150], [700, 150], [1100, 150], [100, 600], [700, 600], [1100, 600]]) {
  let best = [1e9, 0, 0];
  for (let dy = +ey - +rr; dy <= +ey + +rr; dy += 1) for (let dx = +ex - +rr; dx <= +ex + +rr; dx += 1) { let s = 0, n = 0; for (let y = by; y < by + 300; y += 3) for (let x = bx; x < bx + 350; x += 3) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= A.h || xx < 0 || xx >= A.w) continue; s += Math.abs(A.d[y * A.w + x] - B.d[yy * B.w + xx]); n++; } if (n < 500) continue; s /= n; if (s < best[0]) best = [s, dx, dy]; }
  out.push(`(${best[1]},${best[2]}) ${best[0].toFixed(2)}`);
}
console.log(place, z, "expected sprite shift", ex, ey, "-> ground shift per block:", out.join("  "));
