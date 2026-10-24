import { sharp, shiftSearch, OUT } from "./lib.ts";
const [fa, fb] = process.argv.slice(2);
const prep = async (f: string) => { const b = await sharp(`${OUT}/${f}`).removeAlpha().greyscale().blur(6).raw().toBuffer(); const o = new Float32Array(b.length); for (let i = 0; i < o.length; i++) o[i] = b[i]; return { d: o, w: 1600, h: 1000 }; };
const A = await prep(fa), B = await prep(fb);
for (const [x0, y0] of [[690, 440], [200, 440], [1200, 440], [690, 150], [690, 750]]) { const s = shiftSearch(A, B, x0, y0, 220, 120, 260, undefined, 4); console.log(`block at (${x0 + 110 - 800},${y0 + 60 - 500}) from centre: ${fa} -> ${fb} moved (${s.best[0]},${s.best[1]}) cost ${s.cost}/${s.zero}`); }
