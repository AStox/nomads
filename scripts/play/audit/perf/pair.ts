import { sharp } from "./lib";
const a: Buffer = await sharp("shots/still0.jpg").extract({ left: 0, top: 0, width: 400, height: 250 }).toBuffer();
const b: Buffer = await sharp("shots/still4.jpg").extract({ left: 0, top: 0, width: 400, height: 250 }).toBuffer();
await sharp({ create: { width: 800, height: 250, channels: 3, background: "#000" } }).composite([{ input: a, left: 0, top: 0 }, { input: b, left: 400, top: 0 }]).jpeg().toFile("shots/pair.jpg");
