// The game's simulation, bundled for the browser so a page can run a live world: with the random brain, or with Jev
// through a relay that holds the key (useBrain).
export { DAY, H, TILE_M, Tile, W, YEAR_DAYS, clock, colorIndex, dayOfYear, dryAt, isNight, newWorld, seasonOf, spriteSeed, wetAt } from "../src/sim/world";
export { ACTIVITY, activity, changedKinds, heading, summary, tick } from "../src/sim/sim";
export { brainKind, useBrain } from "../src/sim/brain";
export { changed, newKinds, removeThing, removed } from "../src/sim/physics";
export { iceChanged, pathChanges, trailChanges, trails } from "../src/sim/ecology";
export { campSummary, groupsChanged } from "../src/sim/groups";
export { blazeOf, inspect, inspectGround, thingView } from "../src/sim/inspect";
export { deadwoodOf, floraOf, resident, thingById } from "../src/sim/space";
export { stemDriver } from "../src/sim/plants";
export { seedDriver } from "../src/sim/seeds";
export { census } from "../src/sim/animals";
export { FLORA, GROUND, SPECIES, groundClass, waterAt } from "../src/terrain/flora";
export { useGpu } from "../src/gpu/device";
// for the render worker, which draws the animals and the deadwood straight from their GPU buffers (isopixel/worker.js)
export { idOf } from "../src/gpu/store";
export { FIXED } from "../src/gpu/wgsl/fixed";
export { RAND } from "../src/gpu/wgsl/rand";
export { drvAccess } from "../src/gpu/wgsl/drivers";
export { LOG_STATE, STICK_MEMBER, clastBody, common as deadCommon } from "../src/gpu/wgsl/deadwood";
export { SP as ANIMAL_SP } from "../src/gpu/wgsl/animals";
export { STICK_LEN } from "../src/gpu/deadwood";

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
