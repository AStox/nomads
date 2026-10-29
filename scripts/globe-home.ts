// The page's start place, read from a bake's pyramid the way demo/styles/isopixel/ground-at.js playPlace reads it: the land cell of the pyramid's tier 0 (height over 0) with the most
// tree cover outside the polar caps (latitude 60 degrees or less), the first cell of that value in face, row, column order. Prints lat, lon, its tier-0 cell, height and tree share.
//   bun scripts/globe-home.ts <bake dir>
import { readFileSync } from "node:fs";
import { centre, latLon, tierGrid } from "../src/gpu/globe/grid";
import { readTile, tilePath } from "../src/gpu/globe/pyramid";

const dir = process.argv[2], g = tierGrid(0), N = g.fn;
let best = -1, bf = 0, bX = 0, bY = 0, bh = 0, blat = 0, blon = 0;
for (let f = 0; f < 6; f++) {
  const P = readTile(new Uint8Array(readFileSync(tilePath(dir, 0, f, 0, 0)))).planes;
  for (let Y = 0; Y < N; Y++) for (let X = 0; X < N; X++) {
    const c = Y * N + X, tree = P.tree[c];
    if (P.height[c] <= 0 || tree <= best) continue;
    const ll = latLon(centre(g, f, X, Y));
    if (Math.abs(ll.lat) > Math.PI / 3) continue;
    best = tree; bf = f; bX = X; bY = Y; bh = P.height[c] * 0.25; blat = (ll.lat * 180) / Math.PI; blon = (ll.lon * 180) / Math.PI;
  }
}
console.log(JSON.stringify({ lat: +blat.toFixed(4), lon: +blon.toFixed(4), face: bf, X: bX, Y: bY, heightM: bh, tree: +(best / 255).toFixed(3) }));
