// The physics' own word on what a way of doing things comes to, computed rather than tried: for the ways whose outcome
// turns only on the materials and the place they're worked at, the decision the act itself comes to (physics.ts), asked
// of that place as it most plainly is, with the things in hand and nothing done; for the rest, the same formulas the
// acts run, given what decides them where and when it's done (Situation): how wet the tinder is, the wind, the spot,
// the weather ahead for what's done to the ground, the fish in reach, and for what's done with fire the pieces laid, the
// air a fire stands in and the fire itself. The answer key (scripts/truth.ts) computes every way by it.
import type { Act, Stack, Thing, World } from "./world";
import { THING_MATERIAL, depth, p } from "./materials";
import {
  DURATION, EMBER_GIVE_UP, HAND, PIT_SOIL, SEED_SOIL, STILL, STRUCK, airy, arrowy, breaking, breaksOf, cutting, digPower, eating, emberCatches, emberTime, forging as drawing, heating,
  RED, TYPICAL, heldStrike, holdOf, joining, laidOf, leatherOf, placing, rubbedOf, rubbing, shaping, shelterOf, sparkCatches, spotNear, stemOf, stave, strikeDamage,
  throwDamage, throwsSparks, usual, wearing, wetting, yieldOf, type Decision, type Fields, type Fire,
} from "./physics";
import { advance, feed, kindle, lay, lighting, setIn, type Air, type Bed } from "./combustion";
import { BURNS, PHYS, physOf } from "./fuel";
import { BLOWS, DAY_WORK, GROWN, SPARKS_TO_CATCH, TICK_S, blowEnergy, flakeEnergy, isBlade, splitEnergy } from "./mechanics";
import { rulingKey } from "./sim";
import { tinder } from "./wetness";
import { bedAt, nicheOf, seedlingFate, treeOf, type Ahead } from "./seedling";

// What a way comes to: whether it works, the kinds it gives, what it builds or does, where it says it was done (clay
// fired at a hearth) and, for what's done to the ground, the spot it went into, and the ticks it takes a hand practised
// at nothing, in full light.
export type Prediction = { ok: boolean; gives: string[]; builds?: string; effect?: string; at: string | null; ticks: number; spot?: readonly [number, number] };
// Where and when it's done, for what turns on more than the materials: how wet the tinder they'd light a fire with is
// (wetness.ts tinderOf; null for none), the wind at head height, the spot and, for what's done to the ground, the weather
// of the hours ahead there (seedling.ts ahead), and the fish swimming within reach of the water. For what's done with
// fire (fire-constants sec. 32): the pieces they'd lay or hold as they hold them (for a rub, those after the two rubbed),
// the air a fire stands in there (the one they're at, or one they'd light, physics.ts layAt), and the fire they're at as
// it burns then, with its setup (none for none).
export type Situation = {
  tinder: number | null; wind: number; spot: { px: number; py: number; heading?: number }; ahead: Ahead; fish: number;
  pieces: Stack[]; air: Air; fire: Fire | null;
  rubbed?: Stack[]; // for a rub, the two rubbed together as held (as their kinds are, if not said)
};
// Where a way that turns on a fire is done, if not at a place as it most plainly is: the fire, the air it burns in and the
// pieces as held.
type Here = { fire: Fire | null; air: Air; stacks: Stack[] };

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
// The stones round a fire, by how much stone stands round it.
const rings = (f: Fire | null) => Math.round((f?.walls?.width ?? 0) / PHYS.stone.d);

// fish: how many swim within reach of the water, none unless said; here: the fire it's done at, if not a staged one.
export function predictMaterial(w: World, f: Fields, fish = 0, here?: Here): Prediction | { ask: string } | { why: string } {
  const unknown = [...f.inputs, f.tool].find((k) => k && !w.kinds[k]);
  if (unknown) return { why: `no ${unknown} has been made` };
  const at = f.at ?? null;
  if (at && !PLACES[at]) return { why: `there's no setting it up at a ${at}` };
  const held = true, items = f.inputs, ticks = DURATION[f.verb] ?? 4;
  // a fan they hold blows air into the fire while they heat things in it
  const fan = f.tool && airy(w.kinds[f.tool]) ? f.tool : undefined;
  const fire = here ? here.fire : staged(at), air = here?.air, stacks = here?.stacks;
  const predicted = (d: Decision): Prediction => ({ ok: d.ok, gives: d.fields.gives, builds: d.builds, effect: d.effect, at: d.fields.at ?? null, ticks });
  switch (f.verb) {
    case "join": case "heat": {
      const d = f.verb === "join" ? joining(w, items, { held }) : heating(w, items, { held, fire, fan, air, stacks });
      if (d !== "ask") return predicted(d);
      // what doAct makes of it (sim.ts): anything tied twice over already is no use, unasked; anything else, what a
      // ruling settles, kept in w.rulings under this key
      if (items.some((k) => depth(w.kinds, w.kinds[k]) >= 2)) return { ok: false, gives: [], at, ticks };
      return { ask: rulingKey({ verb: f.verb, items, tool: f.tool ?? null, shape: f.shape as Act["shape"], at, ...(f.target ? { target: { kind: f.target } } : {}) }) };
    }
    // one fish or two, a basket brings up fish
    case "wet": return predicted(wetting(w, items, { held, water: at === "water", fish: { basket: fish, line: fish }, skill: 0, draw: () => 1 }));
    case "shape": return predicted(shaping(w, items, f.shape, { held }));
    case "place": return predicted(placing(w, items, { held, fire, ring: rings(fire), pit: at === "pit", own: at === "home" ? { parts: LEAN_TO, shelter: shelterOf(w, LEAN_TO) } : null, empty: false, stacks, air }));
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
      const hold = holdOf(w, f.tool ? tool : null);
      // something standing or lying in the world, one of the size most are: the blows a grown body takes to cut it
      // through or break a stone off it, unless more than a day's work
      if (STRUCK.includes(f.target)) {
        const t = { kind: f.target as Thing["kind"], size: TYPICAL[f.target], px: s.spot.px, py: s.spot.py };
        if (f.target === "boulder") {
          const b = breaking(t, hold, GROWN);
          return b.per <= DAY_WORK ? out(true, Math.ceil(b.per / BLOWS), { gives: Object.keys(breaksOf("boulder")) }) : out(false, 1);
        }
        const c = cutting(stemOf(w, t)!, hold, GROWN);
        return c.blows <= DAY_WORK ? out(true, Math.ceil(c.blows / BLOWS), { gives: Object.keys(yieldOf(t)).filter((k) => yieldOf(t)[k] > 0) }) : out(false, 1);
      }
      // an animal or reeds, by the old reckoning: blow after blow until it's down, or barely a mark after five
      const mat = THING_MATERIAL[f.target];
      if (mat?.hp) {
        const dmg = strikeDamage(tool, mat.toughness ?? 0);
        return dmg > 0.01 ? out(true, Math.ceil(mat.hp / dmg), { gives: Object.keys(mat.breaks) }) : out(false, 5);
      }
      const tk = w.kinds[f.target];
      if (!tk) return { why: `no ${f.target} has been made` };
      const rest = [...f.inputs];
      rest.splice(rest.indexOf(tk.id), 1);
      const over = rest.find((k) => tinder(w.kinds[k])) ?? rest[0];
      const how = heldStrike(w, tk, !!over);
      if (how === "sparks") {
        if (!throwsSparks(w, tool, tk)) return out(false, 1);
        // a spark caught in the lay's tinder, and the lay followed where the fire would stand (combustion.ts lighting)
        const ticks = Math.ceil(SPARKS_TO_CATCH / BLOWS);
        if (!tinder(w.kinds[over]) || !sparkCatches(s.tinder ?? 0, s.wind)) return out(false, ticks);
        return lighting(laidOf(w, s.pieces), s.air).lasts ? out(true, ticks, { builds: "fire" }) : out(false, ticks);
      }
      if (hold.soft || how === "nothing") return out(false, 1);
      const x = physOf(w.kinds, tk)!, E = blowEnergy(hold.swung);
      if (how === "forge") {
        // red hot at a fire that holds the metal so where it sits, or cold; drawn out a tick's blows' worth
        const cold = (tk.cools && tk.parts?.[0] && w.kinds[tk.parts[0]]) || tk, hot = !!tk.cools && !!s.fire?.bed && setIn(s.fire.bed, s.air, x.d) >= RED;
        const fg = drawing(x, E, hot), e0 = x.edge ? Math.log(x.d / (2 * x.edge.r)) : 0;
        if (fg.strain <= e0 + 1e-9) return out(false, 1, { at: hot ? "forge" : null });
        return out(true, 1, { gives: [`forge:${cold.id.replace(/^forge:([^:]+):\d+$/, "$1")}:${Math.round(fg.edge * 1e6)}`], at: hot ? "forge" : null });
      }
      if (how === "knap") {
        const fk = Object.keys(tk.breaks!)[0], flake = physOf(w.kinds, w.kinds[fk])!;
        return x.mass >= flake.mass && E >= flakeEnergy(flake) ? out(true, 1, { gives: [fk] }) : out(false, 1);
      }
      // splitting: only a blade drives it
      if (!isBlade(hold.edge)) return out(false, 1);
      const n = Object.values(tk.breaks!).reduce((t, v) => t + v, 0), blows = splitEnergy(x.d, x.mass / ((x.rho * Math.PI * x.d * x.d) / 4), n, hold.edge.angle) / E;
      return blows <= DAY_WORK ? out(true, Math.ceil(blows / BLOWS), { gives: Object.keys(tk.breaks!) }) : out(false, 1);
    }
    case "rub": {
      // the first two rubbed together, the tinder after them, if they held any
      const A = w.kinds[f.inputs[0]], B = w.kinds[f.inputs[1] ?? f.inputs[0]];
      const r = rubbing(A, B, w.kinds);
      if (r.does === "leather") return out(true, r.ticks, { gives: [leatherOf(w.kinds, r.hide).id] });
      if (r.does === "friction") {
        // rubbed until the dust lights (or given up as past a day's work); the ember goes into the lay's tinder, or what
        // lies about their feet, a handful of fine blades; then the lay is followed where the fire would stand, as a
        // spark's is
        const spindle = s.rubbed?.[[A, B].indexOf(r.spindle)], secs = emberTime(w, spindle, r.spindle, r.bow, s.air.temp);
        const ticks = secs > EMBER_GIVE_UP ? 1 : Math.max(1, Math.ceil(secs / TICK_S));
        if (secs > EMBER_GIVE_UP || s.tinder === null || !emberCatches(s.tinder)) return out(false, ticks, { effect: "heat" });
        const own = s.pieces.some((x) => tinder(w.kinds[x.k])), laid = laidOf(w, s.pieces);
        return lighting(own ? laid : [{ phys: PHYS.fiber, n: 1, m: s.tinder }, ...laid], s.air).lasts ? out(true, ticks, { builds: "fire" }) : out(false, ticks);
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
      const up = seedlingFate(bedAt(w, spot[0], spot[1], niche), s.ahead, f.verb === "pour" ? 0.5 : 0) !== null;
      return out(up, ticks, { spot, ...(up ? { builds: tree ? "tree" : niche === "grass" ? "grass" : "bush" } : {}) });
    }
    case "throw": {
      // thrown, or shot from a bow, every three ticks, six at most: down once what each does adds up to the animal
      const mat = THING_MATERIAL[f.target ?? ""], item = w.kinds[f.inputs[0]];
      if (!mat?.hp) return { why: `nothing to throw at` };
      const dmg = throwDamage(item, mat.toughness ?? 0, !!f.tool && stave(w.kinds[f.tool]) && arrowy(item)), throws = dmg > 0 ? Math.ceil(mat.hp / dmg) : Infinity;
      return throws <= 6 ? out(true, 3 * throws, { gives: Object.keys(mat.breaks) }) : out(false, 18);
    }
  }
  return predictMaterial(w, f, s.fish, { fire: s.fire, air: s.air, stacks: s.pieces });
}
