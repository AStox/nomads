import { sharp, shiftSearch, OUT } from "./lib.ts";
const [place, z, tag = "t5", offs = "0,0;1000,0;2000,0;0,1500;-2500,0;0,-2500", ppm = "0.48"] = process.argv.slice(2);
const big = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().greyscale().blur(12).raw().toBuffer({ resolveWithObject: true }); const o = new Float32Array(data.length); for (let i = 0; i < o.length; i++) o[i] = data[i]; return { d: o, w: info.width, h: info.height }; };
for (const o of offs.split(";")) {
  const [ox, oz] = o.split(",");
  const A = await big(`${OUT}/${tag}-${place}-${z}-pg0-${ox}_${oz}.png`), B = await big(`${OUT}/${tag}-${place}-${z}-pg1-${ox}_${oz}.png`);
  const row: string[] = [];
  for (const [x0, y0] of [[100, 100], [600, 100], [1000, 100], [100, 500], [600, 500], [1000, 500]]) { const r = shiftSearch(A, B, x0, y0, 400, 350, 180, undefined, 3); row.push(`(${r.best[0]},${r.best[1]}) ${r.cost}/${r.zero}`); }
  console.log(`offset ${o}:`, row.join("  |  "));
}
