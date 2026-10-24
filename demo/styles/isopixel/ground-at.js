// The close ground behind one interface: the play area's fields at a place of the planet, in the area's own metres (x east, z south of
// the place, north up, SIZE across). Everything that draws or walks on the close ground reads it through here, so its source can
// change without the callers noticing. Today the source is the island the generator makes, set down at a place of the planet, so the
// sim's ground and the planet's own 75 m ground disagree there (a different coast, relief and cover: the play area is a stamp with a
// faded edge); the planet's own tiles replace the island here and nowhere else.
import { generateIsland, fineGroundGpu, rng, M, N, RM } from "../island.js";
import { packGround } from "./ground.wgsl.js";

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

// A page with no game, where windows of the planet are made, draws its ground from the windows alone: the island of the generator (1.3 s of load, 40 MB of fine ground) is never drawn, so the renderer is
// given a ground of the island's sizes that holds nothing (no fine layers, no light grid: the textures start empty, a window's pages fill them), and the page's camera heights of the island are zero until
// the first window arrives. quick: the island's runoff by season (seed 1), the fallback for a window whose tiles hold none of their own.
export function emptyGround(quick = [0.7744, 0, 0.249, 2.9766]) {
  const z = () => new Float32Array(N * N), isle = { height: z(), water: z(), windShare: z(), rock: z(), table: z(), peat: z(), soil: z(), silt: z(), fog: z(), seasons: [0, 1, 2, 3].map(() => ({ precip: z(), pet: z(), snowpack: z() })), quick };
  const fine = { h: new Float32Array(M * M), rivers: [] };
  const pack = packGround(isle, fine, { fine: null, grid: null, mask: null, top: 0, finePitch: 0, fineLayerWords: 0, gridPitch: 0, gridLayerWords: 0 });
  pack.river = new Uint8Array(1);
  return { isle, fine, pack };
}

// simB: the sim's bundle (world.ts keeps the island for its world), or null for a view with no sim; planet: worker.js openPlanet's with
// its pyramid, or null where no planet is baked, or the promise of either (the island is made while it loads). Returns { isle, fine, place, pack? }; place is null with no planet;
// pack is given for an empty ground (no sim, and windows).
export async function closeGround(simB, seed, gpu, planetIn) {
  let isle, fine, pack;
  const planet = await planetIn;
  if (simB) {
    await simB.islandOf(seed);
    ({ isle, fine } = simB.groundOf(seed));
  } else if (planet?.T) {
    ({ isle, fine, pack } = emptyGround());
  } else {
    isle = await generateIsland(rng(seed), gpu);
    fine = await fineGroundGpu(gpu, isle);
  }
  const at = planet && playPlace(planet.pyramid, planet.G, planet.manifest.faces);
  if (!at) return { isle, fine, pack, place: null };
  const c = planet.G.fromLatLon((at.lat * Math.PI) / 180, (at.lon * Math.PI) / 180), [e, n] = planet.G.eastNorth(c);
  return { isle, fine, pack, place: { lat: at.lat, lon: at.lon, c, e, n, radiusM: planet.radiusM } };
}
