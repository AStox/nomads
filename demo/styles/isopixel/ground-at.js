// The close ground behind one interface: the play area's fields at a place of the planet, in the area's own metres (x east, z south of
// the place, north up, SIZE across). Everything that draws or walks on the close ground reads it through here, so its source can
// change without the callers noticing. Today the source is the island the generator makes, set down at a place of the planet, so the
// sim's ground and the planet's own 75 m ground disagree there (a different coast, relief and cover: the play area is a stamp with a
// faded edge); the planet's own tiles replace the island here and nowhere else.
import { generateIsland, fineGroundGpu, rng } from "../island.js";

// Where the people start: the land cell of the pyramid's tier 0 with the most tree cover outside the polar caps [design: a forest, as
// the island is, in a latitude people live in], read from the tiles that are held. G: the globe.js bundle (tierGrid, centre, latLon).
export function playPlace(pyramid, G, faces) {
  const g = G.tierGrid(0), N = g.fn;
  let best = null, bv = -1;
  for (const f of faces) {
    const P = pyramid.planes0(f);
    if (!P) continue;
    for (let Y = 0; Y < N; Y++)
      for (let X = 0; X < N; X++) {
        const c = Y * N + X, tree = P.tree[c];
        if (P.height[c] <= 0 || tree <= bv) continue;
        const ll = G.latLon(G.centre(g, f, X, Y));
        if (Math.abs(ll.lat) > Math.PI / 3) continue;
        bv = tree; best = ll;
      }
  }
  return best && { lat: (best.lat * 180) / Math.PI, lon: (best.lon * 180) / Math.PI };
}

// simB: the sim's bundle (world.ts keeps the island for its world), or null for a view with no sim; planet: worker.js openPlanet's with
// its pyramid, or null where no planet is baked. Returns { isle, fine, place }; place is null with no planet.
export async function closeGround(simB, seed, gpu, planet) {
  let isle, fine;
  if (simB) {
    await simB.islandOf(seed);
    ({ isle, fine } = simB.groundOf(seed));
  } else {
    isle = await generateIsland(rng(seed), gpu);
    fine = await fineGroundGpu(gpu, isle);
  }
  const at = planet && playPlace(planet.pyramid, planet.G, planet.manifest.faces);
  if (!at) return { isle, fine, place: null };
  const c = planet.G.fromLatLon((at.lat * Math.PI) / 180, (at.lon * Math.PI) / 180), [e, n] = planet.G.eastNorth(c);
  return { isle, fine, place: { lat: at.lat, lon: at.lon, c, e, n, radiusM: planet.radiusM } };
}
