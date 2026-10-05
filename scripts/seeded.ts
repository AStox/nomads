// One seeded stream in place of Math.random for a whole headless run. The sim draws from Math.random in about eighty
// places (the weather, animals, people, physics, the offline brain), so without this no two runs of a seed are alike and
// a strange one can't be looked at again. Call it before the world is made: with the offline brain a run then replays
// exactly, and a baseline and a change run on the same seed share their draws. Jev's answers stay a source of chance.
import { rng } from "../src/sim/world";

export const seedRandom = (seed: number) => { Math.random = rng((seed ^ 0x2545f491) >>> 0); };
