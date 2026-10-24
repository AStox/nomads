import { readFileSync } from "fs"; import { gunzipSync } from "zlib";
const dir = process.env.HOME + "/.cache/nomads-play/planets/link-1-7f6ff6c82cdd/pyramid";
const raw = gunzipSync(readFileSync(`${dir}/t3/f0/3-3.tile.gz`)); const hl = raw.readUInt32LE(0); const meta = JSON.parse(raw.subarray(4, 4 + hl).toString());
console.log(JSON.stringify(meta).slice(0, 1500));
