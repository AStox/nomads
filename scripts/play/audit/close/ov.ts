import { sharp, OUT } from "./lib.ts";
import { readFileSync } from "node:fs";
const [tag, place, z, k, cx, cy, cw = "320", ch = "240", sc = "3", foot = "0"] = process.argv.slice(2);
const X = +cx, Y = +cy, Wc = +cw, Hc = +ch, S = +sc;
const j = JSON.parse(readFileSync(`${OUT}/${tag}-${place}-${z}${k}-cn1.json`, "utf8"));
const ground = await sharp(`${OUT}/${tag}-${place}-${z}${k}-cn1-ground.png`).extract({ left: X, top: Y, width: Wc, height: Hc }).resize(Wc * S, Hc * S, { kernel: "nearest" }).toBuffer();
const full = await sharp(`${OUT}/${tag}-${place}-${z}${k}-cn1-full.png`).extract({ left: X, top: Y, width: Wc, height: Hc }).resize(Wc * S, Hc * S, { kernel: "nearest" }).toBuffer();
let dots = "";
for (const [x, y] of j.d) { const sx = j.cam.dx + x * j.cam.s - X, sy = j.cam.dy + (y + +foot) * j.cam.s - Y; if (sx >= 0 && sy >= 0 && sx < Wc && sy < Hc) dots += `<circle cx="${sx * S}" cy="${sy * S}" r="2.2" fill="#ff2020" stroke="#fff" stroke-width="0.5"/>`; }
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Wc * S}" height="${Hc * S}">${dots}</svg>`);
const gOv = await sharp(ground).composite([{ input: svg }]).toBuffer();
await sharp({ create: { width: Wc * S * 2, height: Hc * S, channels: 3, background: "#000" } }).composite([{ input: gOv, left: 0, top: 0 }, { input: full, left: Wc * S, top: 0 }]).jpeg({ quality: 88 }).toFile(`${OUT}/ov-${tag}-${place}-${z}${k}.jpg`);
