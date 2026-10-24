import { sharp } from "./lib.ts";
const [a, b, out, w] = process.argv.slice(2); const W = +(w ?? 800);
const A = await sharp(a).resize(W).png().toBuffer(), B = await sharp(b).resize(W).png().toBuffer(); const h = (await sharp(A).metadata()).height!;
await sharp({ create: { width: W * 2 + 8, height: h, channels: 3, background: "#fff" } }).composite([{ input: A, left: 0, top: 0 }, { input: B, left: W + 8, top: 0 }]).png().toFile(out);
