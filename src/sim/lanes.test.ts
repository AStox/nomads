import { expect, test } from "bun:test";
import { BODY_S, FAST_S, FIRE_S, LAND_S, SENSES_S, lanesOf } from "./lanes";
import { clockOf } from "./ticks";

// How often each lane runs over a day of a clock, and the seconds it is handed in all.
function day(tickS: number) {
  const c = clockOf(tickS), l = lanesOf(c), out: Record<string, { runs: number; secs: number; hours: number; days: number }> = {};
  for (const [name, period] of Object.entries({ fast: FAST_S, fire: FIRE_S, senses: SENSES_S, body: BODY_S, landing: LAND_S })) {
    let runs = 0, hours = 0, days = 0;
    for (let t = 1; t <= c.DAY; t++) {
      if (!l.due(t, period)) continue;
      runs++;
      // the hourly and daily laws (store.ts Law due), on the runs of this lane
      if (t % c.HOUR === 0) hours++;
      if (t % c.DAY === 0) days++;
    }
    out[name] = { runs, secs: runs * l.secs(period), hours, days };
  }
  return out;
}

test("at a tick of 300 s every lane runs every tick with 300 s, as the tick ran before there were lanes", () => {
  const l = lanesOf(clockOf(300)), d = day(300);
  for (const period of [FAST_S, FIRE_S, SENSES_S, BODY_S, LAND_S]) expect(l.secs(period)).toBe(300);
  for (const lane of Object.values(d)) expect(lane).toEqual({ runs: 288, secs: 86400, hours: 24, days: 1 });
  expect(l.landing).toBe(1);
});

test("at a tick of 1 s each lane runs on its own period and is handed a day's seconds over the day; the hourly and daily laws fall on landings", () => {
  const d = day(1);
  expect(d.fast.runs).toBe(86400);
  expect(d.fire.runs).toBe(8640);
  expect(d.senses.runs).toBe(8640);
  expect(d.body.runs).toBe(1440);
  expect(d.landing.runs).toBe(1440);
  for (const lane of Object.values(d)) expect(lane.secs).toBe(86400);
  expect(d.landing.hours).toBe(24);
  expect(d.landing.days).toBe(1);
  expect(lanesOf(clockOf(1)).landing).toBe(60);
});

test("at a tick of 1 s a landing tick is a fire tick, so the looks gathered since the last landing go with it", () => {
  const l = lanesOf(clockOf(1));
  for (let t = 1; t <= 3600; t++) if (l.due(t, LAND_S)) expect(l.due(t, FIRE_S)).toBe(true);
});

test("a threat that comes between two runs of the senses lane is met by the glance on the tick it comes, at a tick of 1 s", () => {
  // the glance runs on the fast lane (sim.ts agentTick), the full look about on the senses lane
  const l = lanesOf(clockOf(1));
  for (let comes = 1; comes <= 30; comes++) {
    let glanced = -1, noticed = -1;
    for (let t = comes; glanced < 0 || noticed < 0; t++) {
      if (glanced < 0 && l.due(t, FAST_S)) glanced = t;
      if (noticed < 0 && l.due(t, SENSES_S)) noticed = t;
    }
    expect(glanced).toBe(comes);
    expect(noticed - comes).toBeLessThan(SENSES_S);
  }
});
