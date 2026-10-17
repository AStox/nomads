import { expect, test } from "bun:test";
import { jevMeter, judge, useBrain } from "./brain";
import { HOUR } from "./ticks";
import type { Agent, World } from "./world";

// The meter (brain.ts jevMeter) with the random brain: only the clock and the bill of a world are read, so a world of
// those alone stands in for one.
const worldAt = (t: number) => ({ t, jev: { calls: 0, tokens: 0, rulings: 0 } }) as unknown as World;
const me = { id: "p1", name: "Ash" } as unknown as Agent;

test("the meter counts every question put to the brain, a sim hour on average, in the last sim hour and in the last wall minute", async () => {
  useBrain({ kind: "random" });
  const w = worldAt(1000);
  // four calls an hour for three hours
  for (let h = 0; h < 3; h++)
    for (let k = 0; k < 4; k++) {
      w.t = 1000 + h * HOUR + k;
      await judge(w, me, "Birch", {}, true);
    }
  w.t = 1000 + 3 * HOUR;
  const m = jevMeter(w);
  expect(m.calls).toBe(12);
  expect(m.tokens).toBe(0);
  expect(m.perSimHour).toBe(4);
  expect(jevMeter(Object.assign(w, { t: 1000 + 4 * HOUR })).simHour.calls).toBe(0);
  expect(m.wallMinute.calls).toBe(12);
  expect(m.inflight).toBe(0);
  // half an hour back, the last hour's four are in the sim hour; a wall minute on, none are in the wall minute
  w.t = 1000 + 2 * HOUR + HOUR / 2;
  expect(jevMeter(w).simHour.calls).toBe(4);
  expect(jevMeter(w, performance.now() + 61_000).wallMinute.calls).toBe(0);
  expect(jevMeter(w).p50).not.toBeNull();
});

test("a world nobody has asked about shows an empty meter", () => {
  const m = jevMeter(worldAt(5));
  expect(m).toMatchObject({ calls: 0, tokens: 0, perSimHour: null, simHour: { calls: 0, tokens: 0 }, wallMinute: { calls: 0, tokens: 0 }, p50: null, p90: null });
});
