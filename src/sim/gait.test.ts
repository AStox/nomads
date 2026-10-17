import { expect, test } from "bun:test";
import { REACH, armFor, darkPace, froude, pandolf, runCost, runSpeed, slowing, snowEta, tobler } from "./gait";
import { grown } from "./body";

// people-constants sec. 6: the laws as cited, and what they come to.
test("a grown walker goes at Tobler's 5.04 km/h on the level, and a child as the Froude number has it", () => {
  expect(tobler(0) * 3.6).toBeCloseTo(5.04, 2);
  expect(froude(grown(99).m)).toBeCloseTo(1, 6);
  // a five-year-old's legs are 0.64 of a grown body's
  expect(froude(grown(5).m)).toBeCloseTo(Math.sqrt(grown(5).m / grown(99).m), 6);
  expect(froude(grown(5).m)).toBeLessThan(0.85);
});

test("uphill and rough ground slow a walker; walking costs Pandolf's watts", () => {
  expect(tobler(0.1)).toBeLessThan(tobler(0));
  expect(tobler(-0.05)).toBeGreaterThan(tobler(0));
  expect(slowing(70, 0, 2.1)).toBeLessThan(slowing(70, 0, 1.2));
  // Pandolf: standing 1.5 W/kg; 70 kg at 1.34 m/s on a treadmill, 1.5 W + 1.5 V^2 W = 293.5 W
  expect(pandolf(70, 0, 0, 0, 1)).toBeCloseTo(105, 6);
  expect(pandolf(70, 0, 1.34, 0, 1)).toBeCloseTo(105 + 70 * 1.5 * 1.34 * 1.34, 6);
  // Santee's downhill correction keeps the cost above standing still
  expect(pandolf(70, 0, 1.34, -10, 1)).toBeGreaterThan(105);
});

test("snow deepens the terrain coefficient by its footprint's depth", () => {
  expect(snowEta(0, 0.3)).toBeCloseTo(1.2604, 4);
  expect(snowEta(0.2, 0.3)).toBeGreaterThan(snowEta(0.1, 0.3));
  // denser snow takes the foot less deep
  expect(snowEta(0.2, 0.5)).toBeLessThan(snowEta(0.2, 0.3));
});

test("running costs Minetti's 3.6 J/kg/m on the level, and aerobic power sets its speed", () => {
  expect(runCost(0)).toBeCloseTo(3.6, 6);
  expect(runSpeed(62, 0, 25, 0, 1)).toBeGreaterThan(tobler(0));
  expect(runSpeed(62, 0, 70, 0, 1)).toBeLessThan(runSpeed(62, 0, 25, 0, 1));
  expect(runSpeed(62, 20, 25, 0, 1)).toBeLessThan(runSpeed(62, 0, 25, 0, 1));
});

test("the dark slows walking by Kesler's 14.3% at most; reach grows with the body", () => {
  expect(darkPace(1000)).toBe(1);
  expect(darkPace(0.1)).toBeCloseTo(1 / 1.143, 6);
  expect(REACH).toBeCloseTo(armFor(1.6964), 9);
  expect(armFor(grown(5).m)).toBeLessThan(REACH);
});
