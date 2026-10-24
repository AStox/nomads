import { sharp } from "./lib.ts";
const [f, x, y, w, h, s, out] = process.argv.slice(2);
await sharp(f).extract({ left: +x, top: +y, width: +w, height: +h }).resize(+w * +s, +h * +s, { kernel: "nearest" }).png().toFile(out);
