// The game's simulation, bundled for the browser so a page can run a live world with the random brain.
export { DAY, H, TILE_M, Tile, W, YEAR_DAYS, clock, colorIndex, dayOfYear, dryAt, isNight, newWorld, seasonOf, spriteSeed, wetAt } from "../src/sim/world";
export { changedKinds, summary, tick } from "../src/sim/sim";
export { changed, newKinds, removed } from "../src/sim/physics";
export { iceChanged, pathChanges, trailChanges, trails } from "../src/sim/ecology";
export { campSummary, groupsChanged } from "../src/sim/groups";
export { inspect, inspectGround } from "../src/sim/inspect";
export { objects, thingById } from "../src/sim/space";
export { GROUND, groundClass, waterAt } from "../src/terrain/flora";

// newWorld packs the terrain with Node's Buffer.from(buf, offset, length).toString("base64"), the only Buffer use in src.
const g = globalThis as { Buffer?: unknown };
g.Buffer ??= {
  from: (buf: ArrayBuffer, offset: number, length: number) => ({
    toString() {
      const bytes = new Uint8Array(buf, offset, length);
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
  }),
};
