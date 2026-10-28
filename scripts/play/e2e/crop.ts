import { sharp } from "./lib.ts";
const [i, o, w, h, x, y] = process.argv.slice(2);
await sharp(i).extract({ left: +x, top: +y, width: +w, height: +h }).jpeg({ quality: 90 }).toFile(o);
