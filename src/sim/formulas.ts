// The physics' own word on what a way of doing things comes to, for the ways whose outcome turns only on the materials
// and the place they're worked at: the decision the act itself comes to (physics.ts), asked of that place as it most
// plainly is, with the things in hand and nothing done. The answer key (scripts/truth.ts) computes such ways by it rather
// than trying them.
import type { Act, World } from "./world";
import { depth } from "./materials";
import { BLOWN, airy, eating, heating, joining, placing, shaping, shelterOf, wearing, wetting, type Decision, type Fields, type Fire } from "./physics";
import { DURATION, rulingKey } from "./sim";

// What a way comes to: whether it works, the kinds it gives, what it builds or does, where it says it was done (clay
// fired at a hearth), and the ticks it takes a hand practised at nothing.
export type Prediction = { ok: boolean; gives: string[]; builds?: string; effect?: string; at: string | null; ticks: number };

// The places a way is done at, as they most plainly are: a fire as fireKind tells them apart (ringed by three stones for
// a hearth, heaped over as well for a kiln, with charcoal in the ring for a forge), a pit, their own lean-to of four
// sticks, open water. A way done at none of them is done with nothing near.
const PLACES: Record<string, true> = { fire: true, hearth: true, kiln: true, forge: true, pit: true, home: true, water: true };
const RING = 3;
const LEAN_TO: Record<string, number> = { stick: 4 };

// fish: how many swim within reach of the water, none unless said.
export function predictMaterial(w: World, f: Fields, fish = 0): Prediction | { ask: string } | { why: string } {
  const unknown = [...f.inputs, f.tool].find((k) => k && !w.kinds[k]);
  if (unknown) return { why: `no ${unknown} has been made` };
  const at = f.at ?? null;
  if (at && !PLACES[at]) return { why: `there's no setting it up at a ${at}` };
  const held = true, items = f.inputs, ticks = DURATION[f.verb] ?? 4;
  const ringed = at === "hearth" || at === "kiln" || at === "forge";
  // air blown into the fire, if what they hold to heat things with is a fan, burns it hotter while they do
  const fan = f.tool && airy(w.kinds[f.tool]) ? f.tool : undefined;
  const fire: Fire | null = at === "fire" || ringed ? { kind: "fire", contained: ringed, covered: at === "kiln", charcoal: at === "forge" ? 100 : 0, air: fan ? w.t + BLOWN : 0 } : null;
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
    case "place": return predicted(placing(w, items, { held, fire, ring: ringed ? RING : 0, pit: at === "pit", own: at === "home" ? { parts: LEAN_TO, shelter: shelterOf(w, LEAN_TO) } : null, empty: false }));
    case "wear": return predicted(wearing(w, items, { held }));
    case "eat": return predicted(eating(w, items[0], { held, sick: false }));
  }
  return { why: `the materials alone don't settle a ${f.verb}` };
}
