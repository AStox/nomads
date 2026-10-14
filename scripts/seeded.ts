// One seeded stream in place of Math.random for a whole headless run. The sim draws from Math.random in about eighty
// places (the weather, animals, people, physics, the offline brain), so without this no two runs of a seed are alike and
// a strange one can't be looked at again. Call it before the world is made: with the offline brain a run then replays
// exactly, and a baseline and a change run on the same seed share their draws. Jev's answers stay a source of chance.
import { rng } from "../src/sim/world";
import { releaseGpu, theGpu } from "../src/gpu/device";

export const seedRandom = (seed: number) => { Math.random = rng((seed ^ 0x2545f491) >>> 0); };

// A headless run's GPU: opened once before its world is made and held for the whole run, on the adapter NOMADS_GPU
// names (src/gpu/device.ts); the adapter's name, for what the run writes.
export const holdGpu = async () => (await theGpu()).adapter;
// The end of a headless run: the device let go, then the process.
export async function exit(code = 0): Promise<never> {
  await releaseGpu();
  process.exit(code);
}
