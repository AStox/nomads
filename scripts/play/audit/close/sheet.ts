// contact sheet of crops: bun sheet.ts out.jpg x y w h scale file1 file2 ...   (labels the file names)
import { sharp } from "./lib.ts";
const [out, X, Y, Wc, Hc, S, ...files] = process.argv.slice(2); const x = +X, y = +Y, w = +Wc, h = +Hc, s = +S, cols = Math.min(files.length, Math.max(1, Math.floor(3200 / (w * s))));
const tiles = await Promise.all(files.map(async (f) => sharp(f).extract({ left: x, top: y, width: w, height: h }).resize(w * s, h * s, { kernel: "nearest" }).toBuffer()));
const rows = Math.ceil(files.length / cols);
const labels = files.map((f, i) => `<text x="${(i % cols) * w * s + 6}" y="${Math.floor(i / cols) * h * s + 16}" font-size="14" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${f.split("/").pop()!.replace(".png", "")}</text>`).join("");
await sharp({ create: { width: cols * w * s, height: rows * h * s, channels: 3, background: "#000" } }).composite([...tiles.map((t, i) => ({ input: t, left: (i % cols) * w * s, top: Math.floor(i / cols) * h * s })), { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cols * w * s}" height="${rows * h * s}">${labels}</svg>`), left: 0, top: 0 }]).jpeg({ quality: 88 }).toFile(out);
