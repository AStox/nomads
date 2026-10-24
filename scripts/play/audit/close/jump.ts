// feature displacement between zoom a and b at one camera: a is scaled about the centre to b's scale, then blocks shift-searched (low pass)
import { sharp, shiftSearch, OUT } from "./lib.ts";
const [tag, place, za, zb] = process.argv.slice(2), k = 2 ** (+zb - +za);
const prep = async (f: string, scale: number) => { const W = Math.round(1600 * scale), H = Math.round(1000 * scale); const b = await sharp(f).removeAlpha().greyscale().resize(W, H).extract({ left: Math.round((W - 1600) / 2), top: Math.round((H - 1000) / 2), width: 1600, height: 1000 }).blur(10).raw().toBuffer(); const o = new Float32Array(b.length); for (let i = 0; i < o.length; i++) o[i] = b[i]; return { d: o, w: 1600, h: 1000 }; };
const A = await prep(`${OUT}/${tag}-${place}-${za}.png`, k), B = await prep(`${OUT}/${tag}-${place}-${zb}.png`, 1);
const rows: string[] = [];
for (const y0 of [60, 330, 600]) { const r: string[] = []; for (const x0 of [60, 520, 1000]) { const s = shiftSearch(A, B, x0, y0, 420, 300, Number(process.env.R ?? 150), undefined, Number(process.env.STEP ?? 3)); r.push(`(${s.best[0]},${s.best[1]}) ${s.cost}/${s.zero}`); } rows.push(r.join("   ")); }
console.log(`${za} -> ${zb} (scale ${k.toFixed(3)}): shift of features after the scale, 3x3 blocks, (dx,dy) cost/cost at zero:\n` + rows.join("\n"));
