import { sharp, OUT } from "./lib.ts";
const [tag, place, z, k] = process.argv.slice(2);
const raw = async (f: string) => { const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { d: data, w: info.width, h: info.height }; };
const g1 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn1-ground.png`), g0 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn0-ground.png`), f0 = await raw(`${OUT}/${tag}-${place}-${z}${k}-cn0-full.png`);
const W = g1.w, H = g1.h, diff = (a: any, b: any, i: number) => a.d[i] !== b.d[i] || a.d[i + 1] !== b.d[i + 1] || a.d[i + 2] !== b.d[i + 2];
const bin = 40;
for (const y0 of [100, 300, 500, 700, 900]) {
  let m = "", s = "";
  for (let x0 = 0; x0 < W; x0 += bin) { let mc = 0, sc = 0, n = 0; for (let y = y0 - 25; y < y0 + 25; y++) for (let x = x0; x < x0 + bin; x++) { const i = (y * W + x) * 3; if (diff(g1, g0, i)) mc++; if (diff(f0, g0, i)) sc++; n++; } m += Math.round(9 * mc / n); s += Math.round(9 * sc / n); }
  console.log(`y${y0} cover  ${m}\n     trees  ${s}`);
}
