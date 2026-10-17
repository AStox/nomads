import { expect, test } from "bun:test";
import { JOHNSON, airAbsorption, earshot, sightRange } from "./senses";

// ISO 9613-1's own table: 4.98 dB/km at 1 kHz in air at 20 C and 70% humidity, 3.7 at 10 C (people-constants sec. 12b).
test("the air takes speech's 1 kHz as ISO 9613-1 tables it", () => {
  const h = (T: number, rh: number) => (rh * 10 ** (-6.8346 * (273.16 / T) ** 1.261 + 4.6151));
  expect(airAbsorption(1000, 293.15, h(293.15, 70)) * 1000).toBeCloseTo(4.98, 2);
  expect(airAbsorption(1000, 283.15, h(283.15, 70)) * 1000).toBeCloseTo(3.7, 1);
});

// A detail is made out farther the bigger the task leaves it and the brighter the ground, and a person is noticed by day
// farther than the old 300 m and recognised nearer (people-constants sec. 12a's table).
test("sight reaches farther in more light and for coarser tasks, and by day a person is noticed past 300 m", () => {
  const person = 0.68;
  let last = Infinity;
  for (const lux of [10000, 100, 3, 0.1]) {
    const r = (task: keyof typeof JOHNSON) => sightRange(person / (2 * JOHNSON[task]), lux, "clear");
    expect(r("notice")).toBeGreaterThan(r("recognise"));
    expect(r("recognise")).toBeGreaterThan(r("identify"));
    expect(r("notice")).toBeLessThan(last);
    last = r("notice");
  }
  expect(sightRange(person / 2, 10000, "clear")).toBeGreaterThan(300);
  expect(sightRange(person / 2, 10000, "storm")).toBeLessThan(sightRange(person / 2, 10000, "clear"));
});

test("a normal voice is followed some tens of metres off in open air, a raised one twice as far", () => {
  expect(earshot("normal")).toBeGreaterThan(20);
  expect(earshot("normal")).toBeLessThan(80);
  expect(earshot("raised") / earshot("normal")).toBeCloseTo(10 ** ((68.34 - 62.35) / 20), 5);
});
