// The close ground behind one interface: the play area's fields at a place of the planet, in the area's own metres (x east,
// z south of the place, north up, SIZE across). Everything that draws or walks on the close ground reads it through here, so
// its source can change without the callers noticing. Today the source is the island the generator makes (the planet has no
// 75 m ground yet), set down at the place the planet's first ranked landing names, the people's start; the planet's own 75 m
// tiles replace the island here and nowhere else.
import { generateIsland, fineGroundGpu, rng } from "../island.js";

// simB: the sim's bundle (world.ts keeps the island for its world), or null for a view with no sim; planet: worker.js
// openPlanet's, or null where no planet is baked. Returns { isle, fine, place }; place is null with no planet.
export async function closeGround(simB, seed, gpu, planet) {
  let isle, fine;
  if (simB) {
    await simB.islandOf(seed);
    ({ isle, fine } = simB.groundOf(seed));
  } else {
    isle = await generateIsland(rng(seed), gpu);
    fine = await fineGroundGpu(gpu, isle);
  }
  const l = planet?.view.meta.landings[0];
  if (!l) return { isle, fine, place: null };
  const c = planet.G.fromLatLon((l.latDeg * Math.PI) / 180, (l.lonDeg * Math.PI) / 180), [e, n] = planet.G.eastNorth(c);
  return { isle, fine, place: { lat: l.latDeg, lon: l.lonDeg, c, e, n, radiusM: planet.view.meta.radiusM ?? planet.G.RADIUS_M } };
}
