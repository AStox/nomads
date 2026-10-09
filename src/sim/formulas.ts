// The physics' own word on what a way of doing things comes to, computed rather than tried: for the ways whose outcome
// turns only on the materials and the place they're worked at, the decision the act itself comes to (physics.ts), asked
// of that place as it most plainly is, with the things in hand and nothing done; for the rest, the same formulas the
// acts run, given what decides them where and when it's done (Situation): how wet the tinder is, the wind, the spot,
// the weather ahead for what's done to the ground, the fish in reach. The answer key (scripts/truth.ts) computes every
// way by it.
import type { Act, World } from "./world";
import { THING_MATERIAL, depth, p } from "./materials";
import {
  DURATION, HAND, PIT_SOIL, SEED_SOIL, STILL, airy, arrowy, digPower, eating, emberCatches, forgeGain, frictionPer, heating, heldStrike, joining,
  knapPer, leatherOf, placing, rubbedOf, rubbing, shaping, shelterOf, sparkCatches, sparksPer, spotNear, splitDamage, stave, strikeDamage, throwDamage,
  throwsSparks, usual, wearing, wetting, type Decision, type Fields, type Fire,
} from "./physics";
import { advance, feed, kindle, lay, type Bed } from "./combustion";
import { BURNS, PHYS } from "./fuel";
import { rulingKey } from "./sim";
import { tinder } from "./wetness";
import { bedAt, nicheOf, seedlingFate, treeOf, type Ahead } from "./seedling";

// What a way comes to: whether it works, the kinds it gives, what it builds or does, where it says it was done (clay
// fired at a hearth) and, for what's done to the ground, the spot it went into, and the ticks it takes a hand practised
// at nothing, in full light.
export type Prediction = { ok: boolean; gives: string[]; builds?: string; effect?: string; at: string | null; ticks: number; spot?: readonly [number, number] };
// Where and when it's done, for what turns on more than the materials: how wet the tinder they'd light a fire with is
// (wetness.ts tinderOf; null for none), the wind at head height, the spot and, for what's done to the ground, the weather
// of the hours ahead there (seedling.ts ahead), and the fish swimming within reach of the water.
export type Situation = { tinder: number | null; wind: number; spot: { px: number; py: number; heading?: number }; ahead: Ahead; fish: number };

// The places a way is done at, as they most plainly are: a fire as fireKind tells them apart, staged as the usual lay lit
// and burning ten minutes in still air (physics.ts STILL), ringed by three stones for a hearth, heaped over as well for a
// kiln, and fed the charcoal a log smothers into for a forge (fire-constants sec. 29g) [design]; a pit, their own lean-to
// of four sticks, open water. A way done at none of them is done with nothing near. These stage the answer key.
const PLACES: Record<string, true> = { fire: true, hearth: true, kiln: true, forge: true, pit: true, home: true, water: true };
const RING = 3, LIT = 600;
let burning: Bed | undefined, forging: Bed | undefined;
function staged(at: string | null): Fire | null {
  if (at !== "fire" && at !== "hearth" && at !== "kiln" && at !== "forge") return null;
  burning ??= advance(kindle(lay(usual())!), LIT, STILL);
  const log = PHYS.log, coal = { ...PHYS.charcoal, d: log.d, mass: log.mass * BURNS.softwood.charYield };
  forging ??= advance(feed(burning, [{ phys: coal, n: 1, m: 0 }]), LIT, STILL);
  const ringed = at !== "fire", stone = PHYS.stone.d;
  return { kind: "fire", bed: at === "forge" ? forging : burning, contained: ringed, ...(ringed ? { walls: { tall: stone, width: RING * stone } } : {}), covered: at === "kiln", charcoal: at === "forge" ? 1 : 0 };
}
const LEAN_TO: Record<string, number> = { stick: 4 };

// fish: how many swim within reach of the water, none unless said.
export function predictMaterial(w: World, f: Fields, fish = 0): Prediction | { ask: string } | { why: string } {
  const unknown = [...f.inputs, f.tool].find((k) => k && !w.kinds[k]);
  if (unknown) return { why: `no ${unknown} has been made` };
  const at = f.at ?? null;
  if (at && !PLACES[at]) return { why: `there's no setting it up at a ${at}` };
  const held = true, items = f.inputs, ticks = DURATION[f.verb] ?? 4;
  // a fan they hold blows air into the fire while they heat things in it
  const fan = f.tool && airy(w.kinds[f.tool]) ? f.tool : undefined;
  const fire = staged(at);
  const predicted = (d: Decision): Prediction => ({ ok: d.ok, gives: d.fields.gives, builds: d.builds, effect: d.effect, at: d.fields.at ?? null, ticks });
  switch (f.verb) {
    case "join": case "heat": {
      const d = f.verb === "join" ? joining(w, items, { held }) : heating(w, items, { held, fire, fan });
      if (d !== "ask") return predicted(d);
      // what doAct makes of it (sim.ts): anything tied twice over already is no use, unasked; anything else, what a
      // ruling settles, kept in w.rulings under this key
      if (items.some((k) => depth(w.kinds, w.kinds[k]) >= 2)) return { ok: false, gives: [], at, ticks };
      return { ask: rulingKey({ verb: f.verb, items, tool: f.tool ?? null, shape: f.shape as Act["shape"], at, ...(f.target ? { target: { kind: f.target } } : {}) }) };
    }
    // one fish or two, a basket brings up fish
    case "wet": return predicted(wetting(w, items, { held, water: at === "water", fish: { basket: fish, line: fish }, skill: 0, draw: () => 1 }));
    case "shape": return predicted(shaping(w, items, f.shape, { held }));
    case "place": return predicted(placing(w, items, { held, fire, ring: fire?.contained ? RING : 0, pit: at === "pit", own: at === "home" ? { parts: LEAN_TO, shelter: shelterOf(w, LEAN_TO) } : null, empty: false }));
    case "wear": return predicted(wearing(w, items, { held }));
    case "eat": return predicted(eating(w, items[0], { held, sick: false }));
  }
  return { why: `the materials alone don't settle a ${f.verb}` };
}

// Every way, as its verb's formulas have it in a situation.
export function predict(w: World, f: Fields, s: Situation): Prediction | { ask: string } | { why: string } {
  const unknown = [...f.inputs, f.tool].find((k) => k && !w.kinds[k]);
  if (unknown) return { why: `no ${unknown} has been made` };
  const at = f.at ?? null, tool = f.tool ? w.kinds[f.tool] : HAND;
  const out = (ok: boolean, ticks: number, more: Partial<Prediction> = {}): Prediction => ({ ok, gives: [], at, ticks, ...more });
  switch (f.verb) {
    case "strike": {
      if (!f.target) return { why: "nothing to strike" };
      // something standing in the world or roaming it: blow after blow, each doing what the edge's force beats its
      // toughness by, until it's down, or barely a mark after five
      const mat = THING_MATERIAL[f.target];
      if (mat) {
        const dmg = strikeDamage(tool, mat.toughness);
        return dmg > 0.01 ? out(true, Math.ceil(mat.hp / dmg), { gives: Object.keys(mat.breaks) }) : out(false, 5);
      }
      const tk = w.kinds[f.target];
      if (!tk) return { why: `no ${f.target} has been made` };
      const rest = [...f.inputs];
      rest.splice(rest.indexOf(tk.id), 1);
      const over = rest[0];
      switch (heldStrike(tk, !!over)) {
        case "sparks": {
          if (!throwsSparks(tool, tk)) return out(false, 4);
          const blows = Math.ceil(1 / sparksPer(tool, tk));
          return tinder(w.kinds[over]) && sparkCatches(s.tinder ?? 0, s.wind) ? out(true, blows, { builds: "fire" }) : out(false, blows);
        }
        case "forge": {
          // only at a fire hot enough to keep it soft, a forge's; the edge drawn out blow by blow
          const cold = (tk.parts?.[0] && w.kinds[tk.parts[0]]) || tk, g = forgeGain(tool);
          if (at !== "forge") return out(false, 1, { at: "forge" });
          if (g < 0.02) return out(false, 6, { at: "forge" });
          let n = 0, sharp = p(cold, "sharp");
          while (sharp < 0.95 && n < 30) sharp = 1 - (1 - p(cold, "sharp")) * (1 - g) ** ++n;
          return out(true, n, { gives: [`forge:${cold.id}:${Math.round(sharp * 10)}`], at: "forge" });
        }
        case "dent": return out(false, 4, { effect: "dented" });
        case "knap": {
          const blows = Math.ceil(1 / knapPer(tool, tk));
          return blows <= 10 ? out(true, blows, { gives: Object.keys(tk.breaks ?? {}) }) : out(false, 10);
        }
        case "split": {
          const dmg = splitDamage(tool, tk);
          return dmg > 0 && tk.breaks ? out(true, Math.ceil(20 / dmg), { gives: Object.keys(tk.breaks) }) : out(false, 6);
        }
      }
      return out(false, 1);
    }
    case "rub": {
      // the first two rubbed together, the tinder after them, if they held any
      const A = w.kinds[f.inputs[0]], B = w.kinds[f.inputs[1] ?? f.inputs[0]];
      const r = rubbing(A, B);
      if (r.does === "leather") return out(true, r.ticks, { gives: [leatherOf(w.kinds, r.hide).id] });
      if (r.does === "friction") {
        const ticks = Math.ceil(1 / frictionPer(r.bow, 0));
        return s.tinder !== null && emberCatches(s.tinder) ? out(true, ticks, { builds: "fire" }) : out(false, ticks, { effect: "heat" });
      }
      if (r.does === "nothing") return out(false, r.ticks);
      return out(true, r.ticks, { gives: [rubbedOf(r)] });
    }
    case "dig": {
      const spot = spotNear(w, s.spot, PIT_SOIL, true);
      return spot ? out(true, Math.ceil(12 / digPower(tool)), { builds: "pit", spot }) : out(false, 1);
    }
    case "plant": case "pour": {
      // a seed pushed into the ground, or a young plant watered: whatever it comes up as, if it comes up in the hours
      // ahead (seedling.ts)
      const ticks = DURATION[f.verb];
      if (f.verb === "plant" && p(w.kinds[f.inputs[0]], "seed") < 0.4) return out(false, ticks, { effect: "buried" });
      const spot = f.verb === "plant" ? spotNear(w, s.spot, SEED_SOIL, false) : ([s.spot.px, s.spot.py] as const);
      if (!spot) return out(false, ticks);
      const seed = f.verb === "plant" ? { item: f.inputs[0] } : { item: "berry" }, niche = nicheOf(seed), tree = treeOf(seed);
      const up = seedlingFate(bedAt(w, spot[0], spot[1], niche), tree, s.ahead, f.verb === "pour" ? 0.5 : 0) !== null;
      return out(up, ticks, { spot, ...(up ? { builds: tree ? "tree" : niche === "grass" ? "grass" : "bush" } : {}) });
    }
    case "throw": {
      // thrown, or shot from a bow, every three ticks, six at most: down once what each does adds up to the animal
      const mat = THING_MATERIAL[f.target ?? ""], item = w.kinds[f.inputs[0]];
      if (!mat) return { why: `nothing to throw at` };
      const dmg = throwDamage(item, mat.toughness, !!f.tool && stave(w.kinds[f.tool]) && arrowy(item)), throws = dmg > 0 ? Math.ceil(mat.hp / dmg) : Infinity;
      return throws <= 6 ? out(true, 3 * throws, { gives: Object.keys(mat.breaks) }) : out(false, 18);
    }
  }
  return predictMaterial(w, f, s.fish);
}
