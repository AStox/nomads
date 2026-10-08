import { describe, expect, test } from "bun:test";
import { advance, alight, feed, feeding, group, kindle, lay, lighting, lightsIn, expose, output, type Air, type Bed, type Laid } from "./combustion";
import { PHYS, WOODS, pieceOf, woodOf, type Wood } from "./fuel";
import { DURATION } from "./sim";
import { DAY } from "./world";

// The ladder of the fire plan's Unit 5, each case with its pieces, counts, wind and rain fixed from
// docs/research/fire-constants.md before combustion.ts was written:
// - the pieces are what the island's plants give by section 19's allometry, as fuel.ts cuts them: a handful of fibre for
//   tinder (sec. 27c), half-meter sticks off the ground for twigs, the stems of a 2 m hazel for finger-thick sticks, and a
//   meter of a felled oak's trunk at the oak's full height, 15 m, for a log;
// - "dry" is 10%, the most a struck spark catches in (sec. 10), soaked is a piece's most (sec. 5), damp 25%;
// - the air is the island's median, 10 C (sec. 25), around a bed on short grass (sec. 14a);
// - the wind is the land's median at head height, 4.2 m/s, and its gale 10 m/s (sec. 25), felt at each bed's own height;
// - a storm drops 7.8 mm an hour (secs. 13, 25).
// Restated on the operator's calls as the bed was revised (fire-constants sec. 28), to what the cited physics gives: a
// lighting lasts when everything laid with what the ember caught catches and burns through; storm rain barely slows a
// burning bed; the gale blows big slow flames off and leaves small fast ones; wet wood is slow to catch; and coals glow for
// minutes, not hours.
const piece = (t: { kind: string; species?: Wood; size: number }, item: string) => {
  const p = pieceOf(t, item)!;
  return woodOf(p.species ?? "generic", p.size.d, p.size.mass);
};
const TINDER = PHYS.fiber;
const TWIG = piece({ kind: "stick", size: 0.5 }, "stick");
const STICK = piece({ kind: "bush", species: "hazel", size: 2 }, "stick");
const LOG = piece({ kind: "tree", species: "oak", size: 15 }, "log");
const DRY = 0.1, DAMP = 0.25;
const SOAKED = (1.54 - WOODS.hazel.G) / (1.54 * WOODS.hazel.G);
const STILL: Air = { temp: 10, wind: 0, rain: 0, veg: 0.1 };
const BREEZE: Air = { ...STILL, wind: 4.2 };
const GALE: Air = { ...STILL, wind: 10 };
const STORM: Air = { ...STILL, rain: 7.8 };
// A feed begun on a bed is done this long after (sim.ts DURATION, five minutes a tick).
const AFTER = DURATION.place * (86400 / DAY);
const MIN = 60, HOUR = 3600;

const of = (phys: typeof TINDER, n: number, m = DRY): Laid => ({ phys, n, m });
const start = () => [of(TINDER, 1), of(TWIG, 10), of(STICK, 5)];
// what's left of pieces of a kind, kg, however the flame has split them; whether any of them burns; whether they've burnt
// at all, of so many laid
const left = (b: Bed, phys: typeof TINDER) => b.groups.reduce((t, g) => t + (g.phys === phys ? g.n * g.mass : 0), 0);
const lit = (b: Bed, phys: typeof TINDER) => b.groups.some((g) => g.phys === phys && g.lit);
const burnt = (b: Bed, phys: typeof TINDER, n: number) => left(b, phys) < n * phys.mass * (1 - 1e-9);
// all a bed holds, its pieces and its coals, kg
const mass = (b: Bed) => b.groups.reduce((t, g) => t + g.n * g.mass, 0) + b.coals.reduce((t, c) => t + c.kg, 0);
// The bed second by second for so long, and the tallest its flame stood.
function watch(bed: Bed, secs: number, air: Air) {
  let peak = 0;
  for (let t = 0; t < secs; t++) {
    bed = advance(bed, 1, air);
    peak = Math.max(peak, output(bed, air).flame);
  }
  return { bed, peak };
}
// A small fire two minutes on, and three oak logs laid on one half an hour on.
const small = (air = STILL) => advance(kindle(lay(start())!), 2 * MIN, air);
const logs = (n: number) => advance(feed(small(), [of(LOG, n)]), 30 * MIN, STILL);

describe("the ladder", () => {
  test("tinder alone flares and leaves no lasting bed", () => {
    expect(watch(kindle(lay([of(TINDER, 1)])!), 30, STILL).peak).toBeGreaterThan(0);
    expect(lighting([of(TINDER, 1)], STILL).lasts).toBe(false);
  });

  test("tinder with twigs and finger-thick sticks lasts: the twigs and sticks catch and burn through", () => {
    expect(lighting(start(), STILL).lasts).toBe(true);
  });

  test("a felled oak's log laid on a lone tinder flame doesn't light", () => {
    const { bed } = watch(kindle(lay([of(TINDER, 1), of(LOG, 1)])!), 10 * MIN, STILL);
    expect(burnt(bed, LOG, 1)).toBe(false);
  });

  test("three logs on burning sticks keep burning; one alone goes out once the sticks are spent", () => {
    const three = advance(logs(3), 30 * MIN, STILL), one = advance(logs(1), 30 * MIN, STILL);
    expect(burnt(three, STICK, 5) && burnt(one, STICK, 5)).toBe(true);
    expect(lit(three, LOG)).toBe(true);
    expect(burnt(one, LOG, 1)).toBe(true);
    expect(lit(one, LOG)).toBe(false);
  });

  test("kindling laid on the coals a log fire leaves when its flames are gone lights", () => {
    let bed = logs(3);
    for (let t = 0; t < 8 * HOUR && bed.groups.some((g) => g.lit); t += 5 * MIN) bed = advance(bed, 5 * MIN, STILL);
    expect(bed.groups.some((g) => g.lit)).toBe(false);
    expect(bed.coals.length).toBeGreaterThan(0);
    expect(feeding(bed, [of(TWIG, 10)], STILL, 5 * MIN).lights).toBe(true);
  });
});

describe("wind and rain", () => {
  test("the gale leaves a tinder-and-twigs flame its twigs and blows a log bed's flames off", () => {
    expect(burnt(advance(kindle(lay([of(TINDER, 1), of(TWIG, 10)])!), 2 * MIN, GALE), TWIG, 10)).toBe(true);
    const bed = logs(3);
    expect(output(advance(bed, MIN, STILL), STILL).flaming).toBeGreaterThan(0);
    expect(output(advance(bed, MIN, GALE), GALE).flaming).toBe(0);
  });

  test("storm rain slows a burning bed and doesn't put out a small fire", () => {
    expect(lighting(start(), STORM).lasts).toBe(true);
    const bed = logs(3);
    expect(mass(advance(bed, 10 * MIN, STORM))).toBeGreaterThan(mass(advance(bed, 10 * MIN, STILL)));
  });

  test("logs burn faster in the median wind than in still air", () => {
    const bed = logs(3);
    expect(mass(advance(bed, 10 * MIN, BREEZE))).toBeLessThan(mass(advance(bed, 10 * MIN, STILL)));
  });

  test("soaked sticks laid on a small fire catch, later than the same sticks dry", () => {
    const bed = small();
    const when = (m: number) => {
      for (let t = 5; t <= AFTER; t += 5) if (feeding(bed, [of(STICK, 5, m)], STILL, t).lights) return t;
      return Infinity;
    };
    expect(when(SOAKED)).toBeLessThan(Infinity);
    expect(when(SOAKED)).toBeGreaterThan(when(DRY));
  });
});

describe("pieces", () => {
  test("twigs at 35% carry no flame, at 10% they do", () => {
    const twigs = (m: number) => advance(kindle(lay([of(TINDER, 1), of(TWIG, 10, m)])!), 2 * MIN, STILL);
    expect(burnt(twigs(0.35), TWIG, 10)).toBe(false);
    expect(burnt(twigs(0.1), TWIG, 10)).toBe(true);
  });

  test("a damp log takes longer to light than a dry one", () => {
    const dry = lightsIn(group(LOG, 1, DRY), 40, STILL), damp = lightsIn(group(LOG, 1, DAMP), 40, STILL);
    expect(Number.isFinite(damp)).toBe(true);
    expect(damp).toBeGreaterThan(dry);
  });

  test("a piece warmed by one fire and then another lights sooner than one warmed by the second alone", () => {
    const warmed = expose(group(LOG, 1, DRY), 20, 5 * MIN, STILL);
    expect(warmed.lit).toBe(false);
    expect(lightsIn(warmed, 40, STILL)).toBeLessThan(lightsIn(group(LOG, 1, DRY), 40, STILL));
  });

  test("five minutes at once and a minute five times come to the same bed", () => {
    const once = advance(small(), 5 * MIN, STILL);
    let steps = small();
    for (let i = 0; i < 5; i++) steps = advance(steps, MIN, STILL);
    const kw = (b: Bed) => output(b, STILL).flaming + output(b, STILL).glowing;
    expect(kw(steps)).toBeCloseTo(kw(once), -1);
    for (const phys of new Set(once.groups.map((g) => g.phys))) {
      expect(lit(steps, phys)).toBe(lit(once, phys));
      expect(Math.abs(left(steps, phys) - left(once, phys))).toBeLessThan(0.02 * left(small(), phys));
    }
  });

  test("nothing laid is no bed; what isn't fuel isn't laid", () => {
    expect(lay([])).toBeUndefined();
    expect(lay([{ phys: undefined, n: 1, m: 0 }])).toBeUndefined();
    expect(lay([of({ ...TWIG, d: 0 }, 3)])).toBeUndefined();
    expect(lay([of(PHYS.stone, 1)])).toBeUndefined();
  });
});
