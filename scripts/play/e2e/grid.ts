// grid.ts out.jpg tileWidth cols img1 img2 ... : contact sheet in a grid
import { sharp } from "./lib.ts";
const [out, tw, cols, ...imgs] = process.argv.slice(2); const W = +tw, C = +cols;
const tiles = await Promise.all(imgs.map(async (f) => sharp(f).resize(W).jpeg({ quality: 85 }).toBuffer()));
const h = (await sharp(tiles[0]).metadata()).height!; const rows = Math.ceil(tiles.length / C);
await sharp({ create: { width: (W + 6) * C, height: (h + 6) * rows, channels: 3, background: "#f0f" } }).composite(tiles.map((t, i) => ({ input: t, left: (i % C) * (W + 6), top: Math.floor(i / C) * (h + 6) }))).jpeg({ quality: 85 }).toFile(out);
