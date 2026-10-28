// sheet.ts out.jpg tileWidth img1 img2 ... : contact sheet in a row
import { sharp } from "./lib.ts";
const [out, tw, ...imgs] = process.argv.slice(2); const W = +tw;
const tiles = await Promise.all(imgs.map(async (f) => sharp(f).resize(W).jpeg({ quality: 85 }).toBuffer()));
const h = (await sharp(tiles[0]).metadata()).height!;
await sharp({ create: { width: (W + 6) * tiles.length, height: h, channels: 3, background: "#f0f" } }).composite(tiles.map((t, i) => ({ input: t, left: i * (W + 6), top: 0 }))).jpeg({ quality: 85 }).toFile(out);
