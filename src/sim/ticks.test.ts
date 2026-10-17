import { expect, test } from "bun:test";
import { DAY, HOUR, TICK_S, YEAR, YEAR_DAYS, chance, clockOf, every, rate, ticksOf } from "./ticks";
import { rng } from "./world";

// The clock's hours, days and years nest, at the old 5-minute tick and at the world's 1 s one.
test("an hour is a day's 24th and a year is YEAR_DAYS days, at 300 s and at 1 s", () => {
  for (const c of [clockOf(300), clockOf(1)]) {
    expect(c.HOUR * 24).toBe(c.DAY);
    expect(c.DAY * YEAR_DAYS).toBe(c.YEAR);
    expect(c.ticksOf(3600)).toBe(c.HOUR);
  }
  expect(TICK_S).toBe(1);
  expect(HOUR * 24).toBe(DAY);
  expect(DAY * YEAR_DAYS).toBe(YEAR);
  expect(() => clockOf(7)).toThrow();
});

// At a tick as long as a chance's or an amount's span it comes back as the very number it was, so what was written per
// 5-minute tick ran unchanged at that tick when it was stated through the clock.
test("chance and rate over 300 s give back the number itself at a 300 s tick", () => {
  const old = clockOf(300);
  for (const p of [0, 0.002, 0.003 * 0.4, 0.02, 0.3, 0.35, 0.9, 1, 0.1 + 0.2]) {
    expect(old.chance(p, 300)).toBe(p);
    expect(old.rate(p, 300)).toBe(p);
    expect(chance(p, 1)).toBe(p);
    expect(rate(p, 1)).toBe(p);
  }
  for (const x of [6, 0.05, 0.06 * 0.8, 0.0005 * 0.4, 4 / 3, 15]) expect(old.rate(x, 300)).toBe(x);
  expect(old.ticksOf(1200)).toBe(4);
  expect(old.ticksOf(18000)).toBe(60);
  expect(ticksOf(1200)).toBe(1200);
});

// A chance over a span, taken each second of it, comes out to the same chance over the whole span; an amount over a span,
// a second's share each second, adds up to the amount.
test("at a 1 s tick a chance compounds, and an amount adds up, to its own over its span", () => {
  const one = clockOf(1);
  for (const [p, over] of [[0.02, 300], [0.003, 300], [0.3, 300], [0.5, 3600], [0.12, 3600]]) {
    expect(Math.abs(1 - (1 - one.chance(p, over)) ** over - p)).toBeLessThan(1e-12);
    expect(Math.abs(one.rate(p, over) * over - p)).toBeLessThan(1e-12);
  }
});

test("every falls on its period's ticks, and on every tick for a period no longer than a tick", () => {
  for (let t = 0; t < 3 * DAY; t += 7) {
    expect(every(t, 3600)).toBe(t % HOUR === 0);
    expect(every(t, 86400)).toBe(t % DAY === 0);
    expect(every(t, 300)).toBe(t % 300 === 0);
    expect(every(t, 1)).toBe(true);
  }
  const old = clockOf(300);
  for (let t = 0; t < 3 * old.DAY; t++) {
    expect(old.every(t, 300)).toBe(true);
    expect(old.every(t, 10)).toBe(true);
  }
  const ten = clockOf(10);
  for (let t = 0; t < 2 * ten.HOUR; t++) {
    expect(ten.every(t, 60)).toBe(t % 6 === 0);
    expect(ten.every(t, 3600)).toBe(t % ten.HOUR === 0);
  }
});

// The sickness's contagion (ecology.ts disease: 0.003 a 5 minutes at its severity), drawn over an hour of ticks
// 10^5 times: the share caught is the same at 300 s and at 10 s within the draws' error, and both match the hour's own
// chance, 1 - (1 - p)^12.
test("a contagion chance over an hour is the same at a 300 s tick and a 10 s one", () => {
  const p = 0.003 * 1, trials = 1e5, hour = 1 - (1 - p) ** (3600 / 300);
  const caught = (tickS: number, seed: number) => {
    const c = clockOf(tickS), q = c.chance(p, 300), r = rng(seed);
    let n = 0;
    for (let i = 0; i < trials; i++) for (let t = 0; t < c.HOUR; t++) if (r() < q) { n++; break; }
    return n / trials;
  };
  const at300 = caught(300, 1), at10 = caught(10, 2), sd = Math.sqrt((hour * (1 - hour)) / trials);
  expect(Math.abs(at300 - hour)).toBeLessThan(4.5 * sd);
  expect(Math.abs(at10 - hour)).toBeLessThan(4.5 * sd);
  expect(Math.abs(at300 - at10)).toBeLessThan(4.5 * Math.SQRT2 * sd);
});
