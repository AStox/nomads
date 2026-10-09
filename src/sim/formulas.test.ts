import { expect, test } from "bun:test";
import { newWorld, rng, type Agent, type Stack, type World } from "./world";
import { bedAir, fireOf, firstHeld, giveItems, giveStack, heat, join, layAt, place, removeThing, rubTick, strikeTick, type Fields } from "./physics";
import { advance } from "./combustion";
import { PHYS, pieceOf } from "./fuel";
import { airOn } from "./air";
import { tinder, tinderOf } from "./wetness";
import { predict, type Prediction, type Situation } from "./formulas";

// predict comes to what the acts come to (fire plan unit 10), as round five's check did for materials: across lays of the
// island's pieces as wet as anything gets, struck and rubbed in winds from still to a gale, and fires of every age fed
// and held things in. Each case is drawn from a seeded stream, so a disagreement names its draw.
const TWIG = pieceOf({ kind: "stick", size: 0.5 }, "stick")!, STICK = pieceOf({ kind: "bush", species: "hazel", size: 2 }, "stick")!;
const LOG = pieceOf({ kind: "tree", species: "oak", size: 15 }, "log")!;
const WATER = [0.04, 0.08, 0.1, 0.12, 0.2, 0.35, 0.8];
const WIND = [0, 1, 3, 5, 7, 9];

const setup = (): [World, Agent] => {
  const w = newWorld(11), a = w.agents[0];
  a.inv = [];
  a.heading = 0;
  return [w, a];
};
// The weather: the sky and the wind at head height; a new wind is a new tick.
const SKY: World["weather"]["sky"][] = ["clear", "clear", "cloudy", "rain", "storm"];
const blow = (w: World, u: number, r: () => number) => { Object.assign(w.weather, { sky: pick(r, SKY), speed: u }); w.t++; };
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
// A lay drawn: maybe tinder, maybe twigs, sticks and a log, each lot as wet as drawn, never more than a hand holds with
// two things more; in the order beliefs list them, as acts lay them.
function layOf(w: World, a: Agent, r: () => number, tinderToo = true): string[] {
  const items: string[] = [];
  const add = (k: string, n: number, piece: Partial<Stack>) => {
    const m = pick(r, WATER);
    for (let i = 0; i < n; i++) if (giveStack(w, a, { k, hp: 1, born: w.t, m, ...piece })) items.push(k);
  };
  if (tinderToo && r() < 0.85) add("fiber", 1, {});
  add("stick", pick(r, [0, 3, 10]), TWIG);
  add("stick", pick(r, [0, 0, 2]), STICK);
  if (r() < 0.3) add("log", 1, LOG);
  return items.sort();
}
const situation = (w: World, a: Agent, pieces: Stack[], tinder: number | null, fire: Situation["fire"] = null): Situation => ({
  tinder, wind: airOn(w, a).wind, spot: a, ahead: { soil: [], temp: [] }, fish: 0, pieces, air: fire ? bedAir(w, fire as never) : layAt(w, a).air, fire,
});
const said = (p: ReturnType<typeof predict>) => {
  if ("why" in p || "ask" in p) throw new Error(`predict couldn't say: ${JSON.stringify(p)}`);
  return p as Prediction;
};
// what anyone could tell of an outcome: whether it worked, what it built, what it gave and what it did
const told = (o: { ok: boolean; builds?: string; effect?: string; gives?: string[] }) => ({ ok: o.ok, builds: o.builds ?? null, effect: o.effect ?? null, gives: [...(o.gives ?? [])].sort() });
// fires lit or kept in one draw, gone before the next (through the world's own removal, which its index keeps up with)
const clear = (w: World) => { for (const t of w.things.filter((x) => x.kind === "fire")) removeThing(w, t); };

test("striking stone on stone over a lay comes to what predict says, across tinder and kindling as wet as anything gets, winds to a gale and rain", () => {
  const [w, a] = setup(), r = rng(1);
  for (let n = 0; n < 60; n++) {
    blow(w, pick(r, WIND), r);
    a.inv = [];
    giveItems(w, a, "stone", 2);
    const lay = layOf(w, a, r);
    if (!lay.length) continue;
    const pieces = firstHeld(a.inv)(lay)!, over = pieces.find((s) => tinder(w.kinds[s.k]));
    const f: Fields = { verb: "strike", inputs: ["stone", ...lay].sort(), tool: "stone", target: "stone", gives: [] };
    const p = said(predict(w, f, situation(w, a, pieces, over ? over.m ?? 0 : null)));
    const st = { progress: 0 };
    let out;
    do out = strikeTick(w, a, { verb: "strike", items: lay, tool: "stone", target: { kind: "stone" } }, st); while (!out.done);
    expect([n, told({ ...p, gives: [] })]).toEqual([n, told({ ...out.out!, gives: [] })]);
    clear(w);
  }
});

test("rubbing two sticks for an ember blown into a lay, or into what lies about their feet, comes to what predict says", () => {
  const [w, a] = setup(), r = rng(2);
  for (let n = 0; n < 40; n++) {
    blow(w, pick(r, WIND), r);
    a.inv = [];
    for (let i = 0; i < 2; i++) giveStack(w, a, { k: "stick", hp: 1, born: w.t, m: 0.12, size: STICK.size, species: "hazel" });
    const lay = layOf(w, a, r), items = ["stick", "stick", ...lay];
    const chosen = firstHeld(a.inv)(items)!, pieces = chosen.slice(2), own = pieces.find((s) => tinder(w.kinds[s.k]));
    const about = own ? null : tinderOf(w, a), m = own ? own.m ?? 0 : about && !about.kind ? about.m : null;
    const f: Fields = { verb: "rub", inputs: ["stick", "stick", ...[...lay].sort()], gives: [] };
    const p = said(predict(w, f, situation(w, a, pieces, m)));
    const st = { progress: 0 };
    let out;
    do out = rubTick(w, a, { verb: "rub", items }, st); while (!out.done);
    expect([n, told({ ...p, gives: [] })]).toEqual([n, told({ ...out.out!, gives: [] })]);
    clear(w);
  }
});

test("laying wood on a fire of any age comes to what predict says, and so does holding things in it, with air blown in or not", () => {
  const [w, a] = setup(), r = rng(3);
  giveItems(w, a, "fiber", 3);
  const fan = join(w, a, { verb: "join", items: ["fiber", "fiber", "fiber"] });
  if (fan === "ask") throw new Error();
  const bag = Object.keys(fan.gives)[0];
  for (let n = 0; n < 40; n++) {
    blow(w, pick(r, WIND.slice(0, 4)), r);
    clear(w);
    const fire = fireOf(w, a.px, a.py);
    fire.bed = advance(fire.bed!, 30 + r() * 100 * 60, bedAir(w, fire));
    a.inv = a.inv.filter((s) => s.k === bag);
    const lay = layOf(w, a, r, false);
    if (lay.length) {
      const pieces = firstHeld(a.inv)(lay)!, f: Fields = { verb: "place", inputs: [...lay].sort(), at: "fire", gives: [] };
      const p = said(predict(w, f, situation(w, a, pieces, null, fire)));
      const out = place(w, a, { verb: "place", items: lay });
      expect([n, "place", told(p)]).toEqual([n, "place", told({ ...out, gives: Object.keys(out.gives) })]);
    }
    for (const [k, tool] of [["meat"], ["clay"], ["ore"], ["ore", bag], ["stick"], ["hide"]] as [string, string?][]) {
      if (k === "stick") giveStack(w, a, { k, hp: 1, born: w.t, m: pick(r, WATER), size: STICK.size, species: "hazel" });
      else giveItems(w, a, k);
      const pieces = firstHeld(a.inv)([k])!, f: Fields = { verb: "heat", inputs: [k], at: "fire", gives: [], ...(tool ? { tool } : {}) };
      const p = said(predict(w, f, situation(w, a, pieces, null, fire)));
      const out = heat(w, a, { verb: "heat", items: [k], ...(tool ? { tool } : {}) });
      if (out === "ask") throw new Error("heat should settle it");
      expect([n, k, tool, told(p)]).toEqual([n, k, tool, told({ ...out, gives: Object.keys(out.gives) })]);
      a.inv = a.inv.filter((s) => s.k === bag);
    }
  }
});
