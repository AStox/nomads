import { sharp } from "./lib.ts";
// usage: comp.ts tag x0 y0 w h dx dy scale -> tag-comp.png : A crop | B crop same screen place | B crop at ground-shifted place
const [tag, x0, y0, w, h, dx, dy, sc] = process.argv.slice(2); const X = +x0, Y = +y0, W = +w, H = +h, DX = +dx, DY = +dy, S = +(sc ?? 3);
const crop = (f: string, x: number, y: number) => sharp(f).extract({ left: x, top: y, width: W, height: H }).resize(W * S, H * S, { kernel: "nearest" }).png().toBuffer();
const a = await crop(`${tag}-A.png`, X, Y), b0 = await crop(`${tag}-B.png`, X, Y), b1 = await crop(`${tag}-B.png`, X + DX, Y + DY);
const g = 8, out = sharp({ create: { width: W * S * 3 + 2 * g, height: H * S, channels: 3, background: "#ffffff" } }).composite([{ input: a, left: 0, top: 0 }, { input: b0, left: W * S + g, top: 0 }, { input: b1, left: 2 * (W * S + g), top: 0 }]);
await out.png().toFile(`${tag}-comp.png`); console.log("ok");
