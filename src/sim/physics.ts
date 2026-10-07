// The one hard-coded layer: how materials respond to being struck, rubbed, joined, heated, wetted, shaped, and placed.
import { BASE, THING_MATERIAL, clamp01, compoundName, depth, ensure, noun, p, plural, type Kind, type Props } from "./materials";
import { CELL } from "../terrain/grid";
import { DAY, REACH, TILE_M, YEAR, groundOf, addThing, dryAt, dryNear, iceAt, isNight, level, log, meters, nearWater, perWorld, reachOf, wetAt, type Act, type Agent, type Shelter, type Thing, type World } from "./world";
import { anyAround, leave, liveThings, nearestThing, setKind, thingById, wake } from "./space";
import { clock, trace } from "./trace";
import { see } from "./beliefs";
import { enrich } from "./soil";
import { streamNow } from "./streams";
import { airOn } from "./air";
import { DARK, lightOn } from "./light";
import { DAMP, SOAKED, raining, sheltered, tinder, tinderOf } from "./wetness";
import { GROUND, SIZE, groundClass } from "../terrain/flora";

// Kinds of stuff the rules below care about, by what they're like rather than what they're called.
export const greasy = (k?: Kind) => !!k && p(k, "edible") >= 0.1 && p(k, "flammable") >= 0.7;
export const airy = (k?: Kind) => !!k && p(k, "flexible") >= 0.5 && p(k, "container") >= 0.5; // can pump or fan air
const skin = (k?: Kind) => !!k && !k.parts?.length && p(k, "flexible") >= 0.5 && p(k, "insulating") >= 0.5 && p(k, "fibrous") < 0.6;
const sticky = (k?: Kind) => !!k && p(k, "binding") >= 0.5 && p(k, "flammable") >= 0.6 && p(k, "fibrous") < 0.3 && p(k, "plastic") < 0.5;
const short = (k: Kind) => (k.parts ? (k.named ? k.name : noun(k)) : k.name);

// A fire as what it burns at turns on: what it is (a campfire, or something else alight), and whether it's ringed in,
// heaped over, fed charcoal or has air blown into it.
export type Fire = Pick<Thing, "kind" | "burning" | "contained" | "covered" | "charcoal" | "air">;
// Ticks air blown into a fire keeps it burning hotter.
export const BLOWN = 12;
// How hot a fire burns: a ring of stone holds heat in, charcoal burns far hotter than wood, air blown through a ring hotter still.
export function fireHeat(w: World, f: Fire) {
  if (f.kind !== "fire") return f.burning ? 1 : 0;
  const coal = (f.charcoal ?? 0) > 0 ? (f.contained ? BASE.charcoal.burns! : 1.1) : 1;
  return Math.round(((f.contained ? 1.3 : 1) * coal + ((f.air ?? 0) > w.t && f.contained ? 0.5 : 0)) * 100) / 100;
}
// What people would call the fire they're standing at, most specific first.
export const fireKind = (f: Fire) =>
  f.kind !== "fire" || !f.contained ? "fire" : (f.charcoal ?? 0) > 0 ? "forge" : f.covered ? "kiln" : "hearth";
// How many hours a fire has left in it, as anyone by it can judge from what's burning: an open fire eats its wood
// fastest, a ringed one half as fast, one heaped over to smolder slower still (ecology.ts fire).
export const fireHours = (t: Thing) => (t.hp ?? 0) / (t.covered ? 0.3 : t.contained ? 0.5 : 1) / 12;
// Hours until the night ends, if it's night: how long a fire has to last to see them through it.
export function hoursToDawn(t: number) {
  let h = 0;
  while (isNight(t + h * 12) && h < 18) h += 0.5;
  return h;
}
// The hottest fire within r meters: a campfire, or anything burning well enough to cook over.
export function nearFire(w: World, a: { px: number; py: number }, r = 3) {
  let best: Thing | null = null, bh = 0;
  for (const t of liveThings(w)) {
    if ((t.kind !== "fire" && (t.burning ?? 0) <= 0.3) || meters(a, t) > r) continue;
    const h = fireHeat(w, t);
    if (h > bh) { bh = h; best = t; }
  }
  return best;
}
// A point m meters in front of someone (or off to a random side of anything without a heading), on ground they could
// stand on; where they set things down, light fires and build.
export function beside(w: World, e: { px: number; py: number; heading?: number }, m: number): [number, number] {
  const a = e.heading ?? Math.random() * Math.PI * 2;
  for (const turn of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
    const px = e.px + (Math.cos(a + turn) * m) / TILE_M, py = e.py + (Math.sin(a + turn) * m) / TILE_M;
    if (dryAt(w, px, py)) return [px, py];
  }
  return dryNear(w, e.px, e.py) ?? [e.px, e.py];
}

export const CARRY = 16;
export type Fields = { verb: string; inputs: string[]; tool?: string | null; target?: string; at?: string | null; gives: string[]; builds?: string; effect?: string; shape?: string };
export type Outcome = {
  ok: boolean; text: string;
  uses: Record<string, number>; gives: Record<string, number>;
  builds?: string; effect?: string;
  fields: Fields; // the general rule this attempt showed
  numbers?: Record<string, number>;
  newKinds: string[];
  ruled?: boolean; // decided by a Jev ruling, not the physics rules
  later?: string; // a thing whose result is still to come: a seed now in the ground, a seedling just watered
};

// ---------- inventory ----------
export const count = (a: Agent, k: string) => a.inv.reduce((n, s) => n + (s.k === k ? 1 : 0), 0);
export const counts = (a: Agent) => a.inv.reduce<Record<string, number>>((m, s) => ((m[s.k] = (m[s.k] ?? 0) + 1), m), {});
export function takeItems(a: Agent, k: string, n = 1) {
  for (let i = 0; i < n; i++) {
    const idx = a.inv.findIndex((s) => s.k === k);
    if (idx < 0) return false;
    a.inv.splice(idx, 1);
  }
  return true;
}
const young = (a: Agent) => clock.t - a.born < YEAR;
// What someone can carry: a child half what a grown body can, and anyone more with a bag or basket to put things in,
// the roomier the more (the best one counts; a second only weighs them down).
export const carryOf = (w: World, a: Agent) =>
  (young(a) ? 8 : CARRY) + Math.max(0, ...a.inv.map((s) => { const k = w.kinds[s.k]; return p(k, "container") >= 0.6 && p(k, "flexible") >= 0.4 ? Math.round(p(k, "container") * 10) : 0; }));
// wet: how wet what comes into their hands is (wetness.ts), kept for tinder: what they pick up off the ground is as wet
// as the ground
export function giveItems(w: World, a: Agent, k: string, n = 1, wet = 0) {
  const soaked = wet >= 0.005 && tinder(w.kinds[k]);
  for (let i = 0; i < n; i++) {
    if (a.inv.length >= carryOf(w, a) && !makeRoom(w, a, k)) { dropPile(w, a.px, a.py, k, n - i); return i; }
    a.inv.push(soaked ? { k, hp: 1, born: w.t, wet } : { k, hp: 1, born: w.t });
  }
  return n;
}
// Hands full: set down one of whatever plain material they have most of, unless that's what they're picking up.
function makeRoom(w: World, a: Agent, incoming: string) {
  const c = counts(a);
  // Keep one of each thing; beyond that, shed the most plentiful non-food, non-tool thing, and failing that, food they
  // have more than one of.
  const food = (x: string) => p(w.kinds[x], "edible") >= 0.1;
  const surplus = (ok: (x: string) => boolean) => Object.keys(c).filter((x) => x !== incoming && ok(x) && (c[x] >= 2 || (!isToolish(w.kinds[x]) && w.kinds[x]?.parts?.length)))
    .sort((x, y) => c[y] - c[x])[0];
  const spare = surplus((x) => !food(x))
    // A hungry hand drops anything that isn't food before it drops food.
    ?? (food(incoming) ? Object.keys(c).filter((x) => !food(x)).sort((x, y) => Number(isToolish(w.kinds[x])) - Number(isToolish(w.kinds[y])))[0] : surplus(food));
  if (!spare) return false;
  takeItems(a, spare);
  dropPile(w, a.px, a.py, spare, 1);
  return true;
}
// Set things down at a point: on a pile of the same within a meter, or as a new pile close by.
export function dropPile(w: World, px: number, py: number, k: string, n: number): Thing {
  const pile = nearestThing(w, px, py, ["item"], (t) => t.item === k, 1);
  if (pile) { pile.n = (pile.n ?? 1) + n; mark(w, pile); return pile; }
  const t = addThing(w, "item", ...beside(w, { px, py }, 0.2 + Math.random() * 0.5), { item: k, n, born: w.t });
  mark(w, t);
  return t;
}
// Things touched this tick, so the server can send deltas.
export const changed = new Set<string>(), removed = new Set<string>(), newKinds = new Set<string>();
// Something about this thing changed: tell the watchers, and keep the world looking at it.
export function mark(w: World, t: Thing) { changed.add(t.id); wake(w, t); }
export function removeThing(w: World, t: Thing) {
  leave(w, t);
  removed.add(t.id);
}
const kind = (w: World, id?: string | null) => (id ? w.kinds[id] : undefined);
export const HAND: Kind = { id: "hands", name: "bare hands", props: { hard: 0.2, heavy: 0.1 } };
const nm = (w: World, id: string) => w.kinds[id]?.name ?? id.replaceAll("_", " ");
const list = (w: World, m: Record<string, number>) =>
  Object.entries(m).map(([k, n]) => (n > 1 ? `${n} ${plural(nm(w, k))}` : `a ${nm(w, k)}`)).join(" and ");
function made(w: World, a: Agent, k: Kind, isNew: boolean, out: string[]) {
  if (isNew) { k.made = { by: a.id, t: w.t }; out.push(k.id); newKinds.add(k.id); }
}
const outcome = (o: Partial<Outcome> & { text: string; fields: Fields }): Outcome => ({ ok: false, uses: {}, gives: {}, newKinds: [], ...o });

// ---------- deciding, then doing ----------
// What doing something comes to, worked out before a hand moves: the outcome it will be and, for a kind it makes, the
// kind's id and how to make it the first time. Each act asks its decision and then does what it says, so the answer key
// (formulas.ts) can ask the very same decision without anything being done.
export type Decision = Omit<Outcome, "newKinds"> & { make?: Make };
// A kind a decision makes. quiet: making it is nothing anyone would remark on (a pot dipped full is still the pot).
export type Make = { id: string; make: () => Omit<Kind, "id">; quiet?: boolean };
const decided = (o: Partial<Decision> & { text: string; fields: Fields }): Decision => ({ ok: false, uses: {}, gives: {}, ...o });
// The name a made kind goes by: what it's called already, or what it will be called once it's made.
const nameOf = (w: World, m: Make) => w.kinds[m.id]?.name ?? m.make().name;
// How many of each thing, by kind, in the order they're named.
const tally = (items: string[]) => items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
// Whether they have these things to hand, as many of each as are named (and anything is).
const holding = (a: Agent, items: string[]) => items.length > 0 && Object.entries(tally(items)).every(([k, n]) => count(a, k) >= n);
// Doing what was decided: the kind it makes registered (theirs to have made first, if it's new and anything to remark
// on), what it uses taken from their hands, what it gives put in them.
function enact(w: World, a: Agent, d: Decision): Outcome {
  const { make, ...o } = d;
  const nk: string[] = [];
  const k = make && ensure(w.kinds, make.id, make.make);
  for (const [id, n] of Object.entries(o.uses)) takeItems(a, id, n);
  for (const [id, n] of Object.entries(o.gives)) giveItems(w, a, id, n);
  if (k && !make.quiet) made(w, a, k[0], k[1], nk);
  return outcome({ ...o, newKinds: nk });
}

// ---------- strike ----------
export function force(tool: Kind, a?: Agent) {
  const skill = a ? level(a.skills.toolwork ?? 0) * 0.04 : 0;
  return (0.25 + p(tool, "heavy") * 0.8 + p(tool, "long") * 0.35) * (1 + skill) * (a && young(a) ? 0.5 : 1);
}
export const focus = (tool: Kind) => 0.3 + p(tool, "sharp") * 1.2;
// How far toward a flake each blow takes a stone that flakes (knapping): the striker's hardness and the stone's, and a
// practised hand; a flake comes away once the blows add up to 1, or never within ten.
export const knapPer = (tool: Kind, tk: Kind, skill = 0) => p(tool, "hard") ** 2 * p(tk, "hard") * 0.4 * (1 + level(skill) * 0.08);
// What each blow along the grain does to splitting it, from 20: nothing unless the edge's force beats its toughness.
export function splitDamage(tool: Kind, tk: Kind, a?: Agent) {
  const eff = force(tool, a) * focus(tool);
  return tk.grain === "split" && eff > p(tk, "toughness") * 0.8 ? 5 * (eff - p(tk, "toughness") * 0.5) : 0;
}
// How much each blow at a hot enough fire tightens hot metal's edge toward a blade: a heavy, hard striker's.
export const forgeGain = (tool: Kind) => 0.2 * p(tool, "heavy") * p(tool, "hard");
// Damage per blow: force concentrated by an edge, minus what the target can shrug off.
export const strikeDamage = (tool: Kind, toughness: number, a?: Agent) => 5 * Math.max(0, force(tool, a) * focus(tool) - toughness * 0.3);
// What striking something held comes to, by what it is: sparks thrown into the tinder held under the blow (over), hot
// soft metal drawn out under the blows, cold metal only dented, stone that flakes knapped, anything else split along
// its grain if it splits at all.
export const heldStrike = (tk: Kind, over: boolean) =>
  over ? "sparks" : tk.cools && p(tk, "plastic") >= 0.5 ? "forge" : p(tk, "metal") >= 0.8 ? "dent" : tk.grain === "shatter" && tk.breaks ? "knap" : "split";

const toolOf = (w: World, act: Act) => kind(w, act.tool) ?? HAND;
function wear(w: World, a: Agent, act: Act, hardness: number): string | null {
  if (!act.tool) {
    a.needs.health = Math.max(0, a.needs.health - hardness * 0.35);
    return null;
  }
  const s = a.inv.find((x) => x.k === act.tool);
  const t = kind(w, act.tool)!;
  if (!s) return null;
  const binding = t.parts ? Math.min(...t.parts.map((id) => p(kind(w, id), "binding")).filter((b) => b > 0), 1) : 1;
  s.hp -= (0.004 + hardness * 0.012) * (1.5 - binding * 0.6) * (1.1 - p(t, "toughness") * 0.6);
  if (s.hp > 0) return null;
  a.inv.splice(a.inv.indexOf(s), 1);
  const parts = (t.parts ?? []).filter((id) => p(kind(w, id), "binding") < 0.6);
  for (const id of parts) giveItems(w, a, id);
  return parts.length ? `The ${t.name} broke apart into ${parts.map((id) => nm(w, id)).join(" and ")}.` : `The ${t.name} broke.`;
}

// One blow. The runner calls this every tick until it reports done.
export function strikeTick(w: World, a: Agent, act: Act, st: { progress: number; tries?: number }): { done: boolean; out?: Outcome; broke?: string; damage: number } {
  const tool = toolOf(w, act);
  const fields: Fields = { verb: "strike", inputs: [], tool: act.tool ?? null, target: act.target?.kind, gives: [] };
  // Striking something you hold: knapping or splitting, or over tinder, for sparks.
  if (!act.target?.thing && !act.target?.animal) {
    const tk = kind(w, act.target?.kind);
    if (!tk || !count(a, tk.id)) return { done: true, damage: 0, out: outcome({ text: `There was no ${act.target?.kind} to strike.`, fields }) };
    fields.inputs = [tk.id];
    const broke = wear(w, a, act, p(tk, "hard"));
    const how = heldStrike(tk, act.items.length > 0);
    if (how === "sparks") return { ...sparkTick(w, a, act, tool, tk, st, fields), broke: broke ?? undefined, damage: 0 };
    // Hot, soft metal takes a shape under a heavy, hard striker; each blow at the fire draws the edge out and tightens it.
    if (how === "forge") {
      const cold = kind(w, tk.parts?.[0]) ?? tk;
      const fire = nearFire(w, a);
      fields.at = "forge";
      if (!fire || fireHeat(w, fire) < 1.5) return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `The ${tk.name} stiffened before it could be worked.`, fields }) };
      const g = forgeGain(tool);
      st.progress++;
      const sharp = 1 - (1 - p(cold, "sharp")) * (1 - g) ** st.progress;
      trace("physics", "forge", { tool: tool.id, target: tk.id, g, blows: st.progress, sharp }, a.id);
      if (g < 0.02) return st.progress < 6 ? { done: false, damage: 0 } : { done: true, damage: 0, out: outcome({ text: `Tapping the ${tk.name} with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} barely moved it.`, fields }) };
      if (sharp < 0.95 && st.progress < 30) return { done: false, broke: broke ?? undefined, damage: 1 };
      const [k, isNew] = ensure(w.kinds, `forge:${cold.id}:${Math.round(sharp * 10)}`, () => ({
        name: sharp >= 0.8 ? "metal blade" : sharp >= 0.5 ? "rough metal blade" : "hammered metal",
        props: { ...cold.props, plastic: 0, sharp, heavy: p(cold, "heavy") * 0.7, toughness: 1 - (1 - p(cold, "toughness")) * (1 - g) ** st.progress },
        parts: [cold.id], verb: "strike",
      }));
      takeItems(a, tk.id);
      giveItems(w, a, k.id);
      const nk: string[] = [];
      made(w, a, k, isNew, nk);
      fields.gives = [k.id];
      return { done: true, broke: broke ?? undefined, damage: 1, out: outcome({ ok: true, text: `Hammering the ${tk.name} with the ${tool.name} at the fire drew it out into a ${k.name}.`, uses: { [tk.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk, numbers: { blows: st.progress, sharp } }) };
    }
    if (how === "dent") {
      if (++st.progress < 4) return { done: false, broke: broke ?? undefined, damage: 0 };
      fields.effect = "dented";
      return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `Hammering the ${tk.name} only dented it.`, effect: "dented", fields }) };
    }
    if (how === "knap") {
      // Only something as hard as the stone can flake it: each blow does what the striker's hardness and the stone's
      // give it to do, and a flake comes away once the blows add up to it. A striker too soft never gets there.
      const per = knapPer(tool, tk, a.skills.stonework ?? 0);
      st.progress++;
      trace("physics", "knap", { tool: tool.id, target: tk.id, per, blows: st.progress }, a.id);
      if (st.progress * per >= 1) {
        takeItems(a, tk.id);
        const gives = { ...tk.breaks };
        for (const [k, n] of Object.entries(gives)) giveItems(w, a, k, n);
        fields.gives = Object.keys(gives);
        return { done: true, broke: broke ?? undefined, damage: 1, out: outcome({ ok: true, text: `Striking the ${tk.name} with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} chipped off ${list(w, gives)}.`, uses: { [tk.id]: 1 }, gives, fields, numbers: { blows: st.progress } }) };
      }
      if (st.progress >= 10) return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `They struck the ${tk.name} again and again. Grit, and nothing broke off.`, fields, numbers: { blows: st.progress } }) };
      return { done: false, broke: broke ?? undefined, damage: 0 };
    }
    // Splitting along the grain needs a focused edge.
    const eff = force(tool, a) * focus(tool), dmg = splitDamage(tool, tk, a);
    st.progress += dmg;
    trace("physics", "split", { tool: tool.id, target: tk.id, eff, dmg, progress: st.progress }, a.id);
    if (dmg === 0 || !tk.breaks) {
      st.tries = (st.tries ?? 0) + 1;
      if (st.tries >= 6) return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `The ${tk.name} barely marked. Nothing came of striking it with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`}.`, fields, numbers: { eff } }) };
      return { done: false, broke: broke ?? undefined, damage: 0 };
    }
    if (st.progress < 20) return { done: false, broke: broke ?? undefined, damage: dmg };
    takeItems(a, tk.id);
    for (const [k, n] of Object.entries(tk.breaks)) giveItems(w, a, k, n);
    fields.gives = Object.keys(tk.breaks);
    return { done: true, broke: broke ?? undefined, damage: dmg, out: outcome({ ok: true, text: `Striking along its grain split the ${tk.name} into ${list(w, tk.breaks)}.`, uses: { [tk.id]: 1 }, gives: { ...tk.breaks }, fields, numbers: { eff } }) };
  }
  // Striking something in the world: a tree, a boulder, an animal.
  const target = act.target.thing ? thingById(w, act.target.thing) : w.animals.find((x) => x.id === act.target!.animal);
  const mat = THING_MATERIAL[act.target.kind ?? ""];
  if (!target || !mat) return { done: true, damage: 0, out: outcome({ text: "The target was gone.", fields }) };
  const long = p(tool, "long") >= 0.6 ? 1 : 0;
  const far = "alt" in target ? target.alt > 2 || meters(a, target) > REACH + 0.5 + long : meters(a, target) > reachOf(target) + long;
  if (far) return { done: false, damage: 0 };
  const dmg = strikeDamage(tool, mat.toughness, a);
  const broke = wear(w, a, act, mat.toughness);
  target.hp = (target.hp ?? mat.hp) - dmg;
  if ("maxHp" in target && target.maxHp === undefined) target.maxHp = mat.hp;
  if ("kind" in target) mark(w, target);
  // A sharp edge driven into a standing tree peels strips of bark, one every so many blows, the sharper the fewer, and
  // the wound beads resin over the next days.
  if ("kind" in target && (target.kind === "tree" || target.kind === "stump") && dmg > 0) {
    target.scarred = w.t;
    const peel = 0.08 * p(tool, "sharp"), blow = st.progress + 1;
    if (p(tool, "sharp") >= 0.4 && (target.bark ?? 0) < 3 && Math.floor(blow * peel) > Math.floor((blow - 1) * peel)) {
      target.bark = (target.bark ?? 0) + 1;
      dropPile(w, target.px, target.py, "bark", 1);
      see(w, target, "bark", "A sharp edge struck into a tree peels off strips of bark.", 60);
    }
  }
  st.progress++;
  trace("physics", "strike", { tool: tool.id, target: act.target.kind, force: force(tool, a), focus: focus(tool), dmg, hp: target.hp }, a.id);
  const rate = dmg, ticksNeeded = rate > 0 ? Math.ceil(mat.hp / rate) : Infinity;
  if (target.hp! > 0) {
    if (dmg <= 0.01 && st.progress >= 5)
      return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `Striking the ${act.target.kind} with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} barely left a mark.`, fields, numbers: { rate: 0 } }) };
    return { done: false, broke: broke ?? undefined, damage: dmg };
  }
  const gives = { ...mat.breaks };
  for (const [k, n] of Object.entries(("inside" in target && target.inside) || {})) gives[k] = (gives[k] ?? 0) + n;
  fields.gives = Object.keys(gives);
  if ("alt" in target) {
    w.animals = w.animals.filter((x) => x !== target);
    for (const [k, n] of Object.entries(gives)) giveItems(w, a, k, n);
    return { done: true, damage: dmg, broke: broke ?? undefined, out: outcome({ ok: true, text: `They killed the ${target.species} and butchered it into ${list(w, gives)}.`, gives, fields, numbers: { rate, ticksNeeded } }) };
  }
  const t = target as Thing;
  // a felled tree's wood is carried off, and what it took from the soil with it
  if (t.kind === "tree") { setKind(w, t, "stump"); t.hp = 40; t.maxHp = 40; t.size = 0.6; t.until = w.t + DAY * 6; mark(w, t); enrich(w, t.px, t.py, -0.02); }
  else removeThing(w, t);
  for (const [k, n] of Object.entries(gives)) giveItems(w, a, k, n);
  const verb = act.target.kind === "tree" ? "brought the tree down" : `broke up the ${act.target.kind}`;
  return { done: true, damage: dmg, broke: broke ?? undefined, out: outcome({ ok: true, text: `Striking it with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} ${verb}, leaving ${list(w, gives)}.`, gives, fields, numbers: { rate, ticksNeeded } }) };
}

// Striking one stone on another over tinder held under the blow: glancing blows that throw sparks into it rather than
// break anything off. Only two very hard stones of the kind that flakes throw sparks, the harder the more (sparksPer:
// how much of the way to catching each blow's sparks take it); the tinder catches once enough have fallen into it, if it
// is tinder at all, drier than DAMP (wetness.ts), and the wind where they are doesn't carry the sparks off first (GALE).
export const throwsSparks = (tool: Kind, tk: Kind) => p(tool, "hard") >= 0.8 && p(tk, "hard") >= 0.8 && tk.grain === "shatter";
export const sparksPer = (tool: Kind, tk: Kind) => 0.12 * (1 + Math.max(0, Math.max(p(tool, "hard"), p(tk, "hard")) - 0.9) * 40);
// A wind at head height stronger than this, in m/s, carries a spark off before it lands: the strong wind anyone can feel
// (sim.ts CONDITIONS wind).
export const GALE = 8;
export const sparkCatches = (wet: number, wind: number) => wet < DAMP && wind <= GALE;
function sparkTick(w: World, a: Agent, act: Act, tool: Kind, tk: Kind, st: { progress: number }, fields: Fields): { done: boolean; out?: Outcome } {
  const over = kind(w, act.items[0]);
  fields.inputs = [tk.id, act.items[0]].sort();
  if (!over || !count(a, over.id)) return { done: true, out: outcome({ text: `They had no ${nm(w, act.items[0])} to strike over.`, fields }) };
  st.progress++;
  const how = `Striking the ${tk.name} with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} over the ${over.name}`;
  if (!throwsSparks(tool, tk)) {
    if (st.progress < 4) return { done: false };
    return { done: true, out: outcome({ text: `${how} threw no sparks.`, fields }) };
  }
  const per = sparksPer(tool, tk);
  trace("physics", "sparks", { tool: tool.id, target: tk.id, over: over.id, per, blows: st.progress }, a.id);
  if (st.progress * per < 1) return { done: false };
  const numbers = { blows: st.progress };
  if (!tinder(over) || !sparkCatches(tinderOf(w, a, over.id)?.wet ?? 0, airOn(w, a).wind)) return { done: true, out: outcome({ text: `${how} threw sparks into it, but it wouldn't catch.`, fields, numbers }) };
  takeItems(a, over.id);
  mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: 50, maxHp: 400, born: w.t }));
  fields.builds = "fire";
  return { done: true, out: outcome({ ok: true, text: `${how} threw a spark into it, and it caught. A fire!`, uses: { [over.id]: 1 }, builds: "fire", fields, numbers }) };
}

// ---------- rub ----------
export const isBow = (k?: Kind) => !!k && p(k, "flexible") >= 0.8 && p(k, "long") >= 0.5 && p(k, "binding") >= 0.5;
// The weather and light anyone can see they're working in (sim.ts CONDITIONS gives them words).
export const WEATHER_NOW: Record<string, (w: World, a: Agent) => boolean> = {
  rain: (w, a) => raining(w) && !sheltered(w, a),
  dark: (w, a) => lightOn(w, a).bright < DARK,
  cold: (w, a) => airOn(w, a).feels < 0,
  wind: (w, a) => airOn(w, a).wind > GALE,
};
// Friction heat: what a tick's rubbing adds, for a bow drawn round one stick or for two sawn or spun together, and the
// more for a practised hand, less what the wood loses to the air meanwhile. An ember catches in tinder short of SOAKED
// (wetness.ts).
export const frictionPer = (bow: boolean, skill: number) => (bow ? 0.11 : 0.05) * (1 + level(skill) * 0.1) - 0.015;
export const emberCatches = (wet: number) => wet < SOAKED;

// What rubbing two things together comes to, by what they're like: fat worked into a raw hide softens and cures it;
// small hard seeds ground between a stone and something harder still crush to a meal that cooks into far better food;
// the softer, if long, ground to a point on something much harder; or, wood worked against wood, two firm long pieces
// one spun or sawn against the other or a cord drawn back and forth round one, friction heat (a limp handful of fiber
// against a stick just slides); or nothing much. ticks: how long each takes to come to it (friction: until hot enough).
export type Rubbing =
  | { does: "leather"; fat: Kind; hide: Kind; ticks: number }
  | { does: "grind" | "point"; soft: Kind; harder: Kind; ticks: number }
  | { does: "friction"; bow: boolean }
  | { does: "nothing"; ticks: number };
export function rubbing(A: Kind, B: Kind): Rubbing {
  const fat = greasy(A) ? A : greasy(B) ? B : null, hide = skin(A) ? A : skin(B) ? B : null;
  if (fat && hide && fat !== hide) return { does: "leather", fat, hide, ticks: 10 };
  const soft = p(A, "hard") <= p(B, "hard") ? A : B, harder = soft === A ? B : A;
  if (p(soft, "seed") >= 0.5 && p(soft, "hard") >= 0.25 && p(soft, "edible") > 0 && p(soft, "long") < 0.3 && p(harder, "hard") >= 0.8 && soft !== harder) return { does: "grind", soft, harder, ticks: 12 };
  if (p(harder, "hard") - p(soft, "hard") >= 0.35 && p(soft, "long") >= 0.5 && p(soft, "sharp") < 0.5 && soft.verb !== "rub") return { does: "point", soft, harder, ticks: 10 };
  const firm = (k: Kind) => p(k, "hard") >= 0.25 && p(k, "long") >= 0.5;
  const bow = (isBow(A) && firm(B)) || (isBow(B) && firm(A));
  if (p(A, "hard") < 0.6 && p(B, "hard") < 0.6 && (p(A, "flammable") >= 0.5 || p(B, "flammable") >= 0.5) && ((firm(A) && firm(B)) || bow)) return { does: "friction", bow };
  return { does: "nothing", ticks: 6 };
}
// What rubbing makes of the softer of two: ground to a meal, or to a point.
export const rubbedOf = (r: { does: "grind" | "point"; soft: Kind }) => `rub:${r.soft.id}`;
// Rubbing: sharpens the softer thing on a much harder one, or builds friction heat between two woods.
export function rubTick(w: World, a: Agent, act: Act, st: { progress: number; heat?: number }): { done: boolean; out?: Outcome } {
  const [ia, ib] = act.items;
  const A = kind(w, ia), B = kind(w, ib);
  const fields: Fields = { verb: "rub", inputs: [ia, ib].filter(Boolean).sort(), gives: [] };
  if (!A || !B || count(a, ia) < 1 || count(a, ib) < (ia === ib ? 2 : 1)) return { done: true, out: outcome({ text: "They didn't have both things to rub together.", fields }) };
  st.progress++;
  const r = rubbing(A, B);
  if (r.does === "leather") {
    const { fat, hide } = r;
    if (st.progress < r.ticks) return { done: false };
    const [k, isNew] = leather(w, hide);
    takeItems(a, fat.id); takeItems(a, hide.id);
    giveItems(w, a, k.id);
    const nk: string[] = [];
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    return { done: true, out: outcome({ ok: true, text: `Rubbing the ${fat.name} into the ${hide.name} softened it into ${k.name}.`, uses: { [fat.id]: 1, [hide.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk }) };
  }
  if (r.does === "grind") {
    const { soft, harder } = r;
    if (st.progress < r.ticks) return { done: false };
    const [k, isNew] = ensure(w.kinds, rubbedOf(r), () => ({
      name: `ground ${soft.name}`, props: { edible: clamp01(p(soft, "edible") * 1.4), toughness: 0.01 }, parts: [soft.id], verb: "rub", shelf: Math.round((soft.shelf ?? 10) / 2),
    }));
    takeItems(a, soft.id);
    giveItems(w, a, k.id);
    const nk: string[] = [];
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    return { done: true, out: outcome({ ok: true, text: `Grinding the ${soft.name} on the ${harder.name} crushed it to a coarse meal.`, uses: { [soft.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk }) };
  }
  if (r.does === "point") {
    const { soft, harder } = r;
    if (st.progress < r.ticks) return { done: false };
    const [k, isNew] = ensure(w.kinds, rubbedOf(r), () => ({
      name: `pointed ${soft.name}`, props: { ...soft.props, sharp: clamp01(p(soft, "sharp") + 0.4), long: p(soft, "long") * 0.95 }, parts: [soft.id], verb: "rub", fuel: soft.fuel,
    }));
    takeItems(a, soft.id);
    giveItems(w, a, k.id);
    const nk: string[] = [];
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    return { done: true, out: outcome({ ok: true, text: `Rubbing the ${soft.name} on the ${harder.name} ground it to a point.`, uses: { [soft.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk }) };
  }
  if (r.does === "friction") {
    const { bow } = r;
    st.heat = Math.max(0, (st.heat ?? 0) + frictionPer(bow, a.skills.firemaking ?? 0));
    trace("physics", "friction", { a: ia, b: ib, bow, heat: st.heat }, a.id);
    const into = tinderOf(w, a);
    if (st.heat >= 1 && into && emberCatches(into.wet)) {
      if (into.kind) takeItems(a, into.kind.id);
      const fuel = [ia, ib].map((id) => kind(w, id)!).find((k) => !isBow(k) && p(k, "flammable") >= 0.5);
      if (fuel) takeItems(a, fuel.id);
      mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: 60 + (fuel?.fuel ?? 0), maxHp: 200, born: w.t }));
      fields.builds = "fire";
      // the two rubbed together first, then the tinder: a belief replays the first two as the rub
      if (into.kind) fields.inputs = [...fields.inputs, into.kind.id];
      return { done: true, out: outcome({ ok: true, text: `Rubbing the ${A.name} against the ${B.name} got hot enough to catch the ${into.name}. A fire!`, uses: { ...(into.kind ? { [into.kind.id]: 1 } : {}), ...(fuel ? { [fuel.id]: 1 } : {}) }, builds: "fire", fields, numbers: { heat: st.heat } }) };
    }
    if (st.progress >= 60 || st.heat >= 1) {
      fields.effect = "heat";
      return { done: true, out: outcome({ text: `Rubbing the ${A.name} against the ${B.name} made them hot.`, effect: "heat", fields, numbers: { heat: st.heat } }) };
    }
    return { done: false };
  }
  if (st.progress < r.ticks) return { done: false };
  return { done: true, out: outcome({ text: `Rubbing the ${A.name} on the ${B.name} did nothing much.`, fields }) };
}

// ---------- join ----------
// What binding these together comes to: "ask" when the rules can't say whether they would hold together.
export function joining(w: World, items: string[], c: { held: boolean }): Decision | "ask" {
  const parts = items.map((id) => kind(w, id)!).filter(Boolean);
  const fields: Fields = { verb: "join", inputs: [...items].sort(), gives: [] };
  const need = tally(items);
  if (parts.length < 2 || !c.held) return decided({ text: "They didn't have those things to hand.", fields });
  const id = `join:${fields.inputs.join("+")}`;
  let make: Make, text = `Binding ${parts.map((x) => `the ${x.name}`).join(", ")} together made`;
  // Fat with a wick in something hard and hollow: a lamp that burns slow and steady.
  const hollow = parts.find((x) => p(x, "container") >= 0.6 && p(x, "hard") >= 0.5), fat = parts.find(greasy);
  const wick = parts.find((x) => x !== fat && x !== hollow && p(x, "fibrous") >= 0.6 && p(x, "flammable") >= 0.6);
  // Melted resin smeared over something soft and hollow seals it watertight.
  const glue = parts.find((x) => p(x, "binding") >= 0.9 && p(x, "fibrous") < 0.3 && p(x, "flammable") >= 0.5);
  const basket = parts.find((x) => x !== glue && p(x, "container") >= 0.4 && p(x, "hard") < 0.5);
  if (parts.length === 3 && hollow && fat && wick) {
    make = { id, make: () => ({
      name: `${short(hollow)} filled with ${short(fat)} and a ${short(wick)} wick`,
      props: { container: p(hollow, "container"), hard: p(hollow, "hard"), heavy: p(hollow, "heavy"), flammable: 0.8, toughness: p(hollow, "toughness") },
      parts: fields.inputs, verb: "join",
    }) };
    text = `Filling the ${hollow.name} with ${fat.name} and a ${wick.name} wick made`;
  } else if (parts.length === 2 && glue && basket) {
    make = { id, make: () => ({
      name: `${short(basket)} sealed with ${short(glue)}`,
      props: { ...basket.props, container: 0.9, binding: 0, flammable: Math.max(p(basket, "flammable"), p(glue, "flammable")), toughness: clamp01(p(basket, "toughness") + 0.1) },
      parts: fields.inputs, verb: "join",
    }) };
    text = `Smearing the ${glue.name} over the ${basket.name} sealed it tight. That made`;
  } else if (parts.some((x) => depth(w.kinds, x) >= 2)) {
    // ponytail: two levels of tying (fiber > cord > tool) covers every tool so far; lift when a real need shows up.
    return decided({ text: `Nothing more would stay tied onto the ${parts.find((x) => depth(w.kinds, x) >= 2)!.name}.`, fields });
  } else if (parts.every((x) => p(x, "fibrous") >= 0.6 && !x.parts)) {
    const n = parts.length;
    make = { id, make: () => n === 2
      ? { name: `twisted ${parts[0].name === parts[1].name ? parts[0].name : "fiber"} cord`, props: { binding: 0.85, flexible: 0.9, fibrous: 0.6, long: 0.5, flammable: 0.7, toughness: 0.3 }, parts: fields.inputs, verb: "join", fuel: 10 }
      : { name: `woven ${parts[0].name} mat`, props: { container: 0.5, insulating: 0.6, fibrous: 0.8, flexible: 0.7, flammable: 0.8, toughness: 0.2 }, parts: fields.inputs, verb: "join", fuel: 20 } };
  } else {
    const binder = [...parts].sort((x, y) => p(y, "binding") - p(x, "binding"))[0];
    if (p(binder, "binding") < 0.6) return "ask";
    const rest = parts.filter((x) => x !== binder);
    // A soft sheet: a hide, leather, fern fronds, or a mat already woven of reeds, but not a loose handful of fiber or
    // something that is a bag already.
    const soft = (x: Kind) => p(x, "flexible") >= 0.5 && p(x, "long") < 0.5 && p(x, "container") < 0.6 && !(p(x, "fibrous") >= 0.6 && !x.parts?.length);
    const sheet = rest.length === 1 && soft(rest[0]) ? rest[0] : null, sheets = rest.length >= 2 && rest.every(soft) ? rest : null;
    const headK = [...rest].sort((x, y) => p(y, "sharp") + p(y, "heavy") * 0.5 - p(x, "sharp") - p(x, "heavy") * 0.5)[0];
    const handle = rest.length > 1 ? [...rest].filter((x) => x !== headK).sort((x, y) => p(y, "long") - p(x, "long"))[0] : headK;
    make = { id, make: () => {
      // A soft sheet gathered up and tied closes into a bag; a woven mat tied up so is a basket, loose enough to let
      // water through.
      if (sheet) return {
        name: `${short(sheet)} bag tied with ${short(binder)}`,
        props: { container: clamp01(0.45 + p(sheet, "flexible") * 0.3), flexible: p(sheet, "flexible"), fibrous: p(sheet, "fibrous"), insulating: p(sheet, "insulating") * 0.5, flammable: p(sheet, "flammable"), toughness: Math.min(p(sheet, "toughness") + 0.1, p(binder, "binding")) },
        parts: fields.inputs, verb: "join",
      };
      // Two or more laced together at the edges: a wrap big enough to go round a body, warmer than any one of them.
      if (sheets) return {
        name: `${short(sheets[0])} wrap laced with ${short(binder)}`,
        props: {
          insulating: clamp01(Math.max(...sheets.map((x) => p(x, "insulating"))) + 0.08 * sheets.length), flexible: Math.min(...sheets.map((x) => p(x, "flexible"))),
          fibrous: Math.max(...sheets.map((x) => p(x, "fibrous"))), flammable: Math.max(...sheets.map((x) => p(x, "flammable"))),
          toughness: Math.min(Math.min(...sheets.map((x) => p(x, "toughness"))) + 0.1, p(binder, "binding")),
        },
        parts: fields.inputs, verb: "join",
      };
      const props: Props = {
        sharp: p(headK, "sharp"), hard: p(headK, "hard"),
        heavy: clamp01(rest.reduce((t, x) => t + p(x, "heavy"), 0) * 0.9),
        long: Math.max(...parts.map((x) => p(x, "long"))),
        flexible: Math.max(p(handle, "flexible"), rest.length === 1 ? p(binder, "flexible") : 0),
        binding: p(binder, "binding"),
        flammable: parts.reduce((t, x) => t + p(x, "flammable"), 0) / parts.length,
        toughness: Math.min(p(headK, "toughness"), p(handle, "toughness") + 0.2, p(binder, "binding")),
        container: Math.max(...parts.map((x) => p(x, "container"))),
        metal: p(headK, "metal"),
      };
      return { name: compoundName(w.kinds, parts), props, parts: fields.inputs, verb: "join" };
    } };
  }
  fields.gives = [id];
  return decided({ ok: true, text: `${text} a ${nameOf(w, make)}.`, uses: need, gives: { [id]: 1 }, fields, make });
}
export function join(w: World, a: Agent, act: Act): Outcome | "ask" {
  const d = joining(w, act.items, { held: holding(a, act.items) });
  if (d === "ask") return d;
  const out = enact(w, a, d);
  if (d.make) trace("physics", "join", { parts: d.fields.inputs, made: d.make.id, props: w.kinds[d.make.id].props }, a.id);
  return out;
}

// ---------- heat ----------
// What there is to heat things at: the fire they hold them in, as it burns now (fanned already, if they're fanning it),
// and the fan they blow air into it with, if they hold one.
export type HeatSetting = { held: boolean; fire: Fire | null; fan?: string };
// What heating these comes to: "ask" when the rules can't say.
// Thresholds: cooking and melting resin 0.8, firing clay 1.2, softening metal 1.5, smelting ore 2.2. Wood only chars in a covered fire.
export function heating(w: World, items: string[], c: HeatSetting): Decision | "ask" {
  const parts = items.map((id) => kind(w, id)!).filter(Boolean);
  const fields: Fields = { verb: "heat", inputs: [...items].sort(), at: "fire", gives: [] };
  const need = tally(items);
  if (!parts.length || !c.held) return decided({ text: "They didn't have those things to hand.", fields });
  const fire = c.fire;
  if (!fire) return decided({ text: "The fire had gone out.", fields });
  if (c.fan) fields.tool = c.fan;
  const level = fireHeat(w, fire);
  const done = (make: Make, text: string, keep: string[] = []): Decision => {
    fields.gives = [make.id];
    const uses = Object.fromEntries(Object.entries(need).filter(([kk]) => !keep.includes(kk)));
    return decided({ ok: true, text, uses, gives: { [make.id]: 1 }, fields, numbers: { heat: level }, make });
  };
  // Not hot enough: remember where it was tried, so "a ringed fire isn't hot enough for this" is something people can learn.
  const cool = (text: string) => {
    fields.at = fireKind(fire);
    fields.effect = "too_cool";
    return decided({ text, effect: "too_cool", fields, numbers: { heat: level } });
  };
  const pot = parts.find((x) => p(x, "container") >= 0.6 && p(x, "hard") >= 0.5);
  const foods = parts.filter((x) => p(x, "edible") > 0 && x !== pot);
  if (pot && foods.length >= 1) {
    const stew: Make = { id: `stew:${foods.map((x) => x.id).sort().join("+")}`, make: () => ({
      name: `${foods.length > 1 ? "mixed" : foods[0].name} stew`,
      props: { edible: clamp01(foods.reduce((t, x) => t + p(x, "edible"), 0) * 1.4), toxic: Math.min(...foods.map((x) => p(x, "toxic"))) * 0.1, medicinal: Math.max(...foods.map((x) => p(x, "medicinal"))) },
      parts: fields.inputs, verb: "heat", shelf: 3,
    }) };
    return done(stew, `Cooking ${foods.map((x) => `the ${x.name}`).join(" and ")} in the ${pot.name} made a ${nameOf(w, stew)}.`, [pot.id]);
  }
  if (parts.length !== 1) return "ask";
  const x = parts[0];
  if (/^(cooked|smoked|fired|burning|hot|melt|forge):/.test(x.id)) return decided({ text: `Heating the ${x.name} again did nothing more.`, fields });
  // Hung in the thick smoke of a fire closed over to smolder, food dries out and keeps for weeks instead of days.
  if (p(x, "edible") > 0 && fire.covered) {
    fields.at = "kiln";
    return done({ id: `smoked:${x.id}`, make: () => ({
      name: `smoked ${x.name}`,
      props: { ...x.props, edible: clamp01(p(x, "edible") * 1.3 + 0.03), toxic: p(x, "toxic") * 0.1, seed: 0 },
      parts: [x.id], verb: "heat", shelf: (x.shelf ?? 1) * 8 + 6,
    }) }, `Hung in the smoke under the cover, the ${x.name} dried dark and hard. It would keep.`);
  }
  if (p(x, "edible") > 0) {
    // a soft dough bakes firm into bread
    const dough = p(x, "plastic") >= 0.5;
    return done({ id: `cooked:${x.id}`, make: () => ({
      name: x.id === "meat" ? "roast meat" : dough ? "bread" : `cooked ${x.name}`,
      props: { ...x.props, edible: clamp01(p(x, "edible") * 1.6 + 0.05), toxic: p(x, "toxic") * 0.15, seed: 0, ...(dough ? { plastic: 0, hard: 0.2 } : {}) },
      parts: [x.id], verb: "heat", shelf: dough ? 5 : (x.shelf ?? 1) * 2 + 1,
    }) }, dough ? `The ${x.name} baked firm into bread over the fire.` : `Holding the ${x.name} over the fire cooked it.`);
  }
  if (sticky(x)) {
    return done({ id: `melt:${x.id}`, make: () => ({
      name: `melted ${x.name}`, props: { binding: 0.95, flammable: p(x, "flammable"), plastic: 0.3, toughness: 0.1 }, parts: [x.id], verb: "heat", fuel: x.fuel,
    }) }, `The ${x.name} softened in the heat and ran into a thick, sticky glue.`);
  }
  if (p(x, "plastic") >= 0.6) {
    if (level < 1.2) return cool(`The ${x.name} dried and cracked at the edges, but didn't harden.`);
    fields.at = "hearth";
    return done({ id: `fired:${x.id}`, make: () => ({
      name: x.id === "clay" ? "fired clay lump" : `fired ${x.name.replace(/^clay |^wet clay /, "clay ")}`,
      props: { ...x.props, plastic: 0, binding: 0, hard: 0.75, toughness: 0.45 },
      parts: [x.id], verb: "heat",
    }) }, `The heat of the ringed fire baked the ${x.name} hard.`);
  }
  if (p(x, "metal") >= 0.8) {
    if (level < 1.5) return cool(`The ${x.name} got hot, but stayed as hard as ever.`);
    fields.at = "forge";
    return done({ id: `hot:${x.id}`, make: () => ({ name: `glowing ${x.name}`, props: { ...x.props, plastic: 0.7 }, parts: [x.id], verb: "heat", cools: 36 }) },
      `The ${x.name} glowed orange in the charcoal and went soft enough to work.`);
  }
  if (p(x, "metal") >= 0.3) {
    if (level < 2.2) return level >= 1.9 ? cool(`The ${x.name} glowed and sweated, but nothing came of it.`) : decided({ text: `The ${x.name} got hot, then cooled. Nothing changed.`, fields });
    fields.at = "forge";
    return done({ id: `smelt:${x.id}`, make: () => ({
      name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: clamp01(p(x, "toughness") + 0.15) }, parts: [x.id], verb: "heat",
    }) }, `In the roaring charcoal the ${x.name} bled bright metal, which cooled into a lump.`);
  }
  const woody = p(x, "flammable") >= 0.5 && p(x, "hard") >= 0.3 && x.verb !== "join";
  if (woody && fire.covered) {
    fields.at = "kiln";
    fields.gives = ["charcoal"];
    return decided({ ok: true, text: `Starved of air under the cover, the ${x.name} blackened into charcoal instead of burning away.`, uses: need, gives: { charcoal: Math.max(1, Math.round(p(x, "heavy") * 2.5)) }, fields, numbers: { heat: level } });
  }
  if (skin(x)) {
    if (!fire.covered) {
      fields.effect = "scorched";
      return decided({ text: `The ${x.name} dried stiff and scorched at the edges.`, effect: "scorched", fields });
    }
    fields.at = "kiln";
    const cured = leatherOf(x);
    return done(cured, `Held in the thick smoke, the ${x.name} cured into ${nameOf(w, cured)}.`);
  }
  const lamp = p(x, "container") >= 0.5 && p(x, "hard") >= 0.4;
  if (p(x, "flammable") >= 0.6 && (p(x, "long") >= 0.5 || lamp)) {
    return done({ id: `burning:${x.id}`, make: () => ({ name: `${lamp ? "lit" : "burning"} ${x.name}`, props: { ...x.props, flammable: 1 }, parts: [x.id], verb: "heat" }) },
      lamp ? `The wick of the ${x.name} caught and burned low and steady. They could carry the flame.` : `The end of the ${x.name} caught fire. They could carry the flame.`);
  }
  if (p(x, "flammable") >= 0.7) {
    fields.effect = "burned";
    return decided({ text: `The ${x.name} burned away to nothing.`, uses: { [x.id]: 1 }, effect: "burned", fields });
  }
  if (p(x, "hard") >= 0.5 && p(x, "flammable") < 0.2) return decided({ text: `The ${x.name} got hot, then cooled. Nothing changed.`, fields });
  return "ask";
}
export function heat(w: World, a: Agent, act: Act): Outcome | "ask" {
  const held = holding(a, act.items), fire = held ? nearFire(w, a) : null;
  // Something soft and hollow squeezed or flapped at the flames drives air into them.
  const tool = kind(w, act.tool), fan = fire && tool && airy(tool) && count(a, tool.id) ? tool.id : undefined;
  if (fire && fan && fire.kind === "fire") { fire.air = w.t + BLOWN; fire.heat = fireHeat(w, fire); mark(w, fire); }
  const d = heating(w, act.items, { held, fire, fan });
  if (fire) trace("physics", "heat", { items: act.items, fire: fireKind(fire), heat: fireHeat(w, fire), fan }, a.id);
  return d === "ask" ? d : enact(w, a, d);
}
// Hide cured into leather, in thick smoke (heating) or with fat rubbed into it (rubTick).
export const leatherOf = (hide: Kind): Make => ({ id: `leather:${hide.id}`, make: () => ({
  name: hide.id === "hide" ? "leather" : `${hide.name} leather`,
  props: { insulating: clamp01(p(hide, "insulating") + 0.05), flexible: clamp01(p(hide, "flexible") + 0.25), fibrous: p(hide, "fibrous") * 0.6, toughness: clamp01(p(hide, "toughness") + 0.3), flammable: p(hide, "flammable") * 0.6 },
  parts: [hide.id], verb: "heat",
}) });
export function leather(w: World, hide: Kind) {
  const { id, make } = leatherOf(hide);
  return ensure(w.kinds, id, make);
}

// ---------- wet ----------
// How far from where they stand a fish is in reach: of a basket swept through the water, and of a line dangled in it,
// which a fish swims to from farther off. A try that comes to nothing had no fish close by (sim.ts CONDITIONS nofish).
export const FISH_REACH: Record<"basket" | "line", number> = { basket: 15, line: 40 };
// Who last lifted a fish out of the water, and when: the fish they caught was close by, though it swims there no more.
const landed = perWorld(() => new Map<string, number>());
// Whether a fish swims within reach of what they dip (a basket's, unless a line's) or they just lifted one out.
export const fishClose = (w: World, a: Agent, at: { px: number; py: number } = a, reach = FISH_REACH.basket) =>
  landed(w).get(a.id) === w.t || w.animals.some((m) => m.species === "fish" && meters(m, at) <= reach);
// A line to dangle in the water: long, limp and strong.
export const lineLike = (k?: Kind) => p(k, "long") >= 0.5 && p(k, "flexible") >= 0.8 && p(k, "binding") >= 0.5;
// What there is to dip something into where they stand: open water (not frozen over), how many fish swim within a
// basket's and a line's reach (FISH_REACH), how practised a hand at fishing they are, and a draw of chance, taken only
// when a basket might bring up two.
export type WetSetting = { held: boolean; water: boolean; fish: Record<keyof typeof FISH_REACH, number>; skill: number; draw: () => number };
// fishing: what it fishes with, when it does: the basket or line wears in the water, and what it brings up comes out of
// the water from within its reach.
export type Wetting = Decision & { fishing?: keyof typeof FISH_REACH };
export function wetting(w: World, items: string[], c: WetSetting): Wetting {
  const x = kind(w, items[0]);
  const fields: Fields = { verb: "wet", inputs: items.slice(0, 1), at: "water", gives: [] };
  if (!x || !c.held) return decided({ text: "They had nothing to dip.", fields });
  if (!c.water) return decided({ text: "The water was frozen solid.", fields: { ...fields, effect: "frozen" }, effect: "frozen" });
  if (x.id.startsWith("burning:")) return decided({ ok: true, text: `The water put out the ${x.name}.`, uses: { [x.id]: 1 }, gives: { [x.parts![0]]: 1 }, fields: { ...fields, gives: [x.parts![0]] } });
  // A meal ground from seed takes up water into a sticky dough.
  if (x.verb === "rub" && p(x, "edible") >= 0.1) {
    const id = `wet:${x.id}`;
    fields.gives = [id];
    return decided({ ok: true, text: `The ${x.name} soaked up the water into a sticky dough.`, uses: { [x.id]: 1 }, gives: { [id]: 1 }, fields, make: { id, make: () => ({
      name: "dough", props: { edible: p(x, "edible"), plastic: 0.7, toughness: 0.02 }, parts: [x.id], verb: "wet", shelf: 1,
    }) } });
  }
  // A vessel that holds water, which a woven basket doesn't, comes up full.
  if (p(x, "container") >= 0.6 && p(x, "fibrous") < 0.5 && !x.id.startsWith("full:")) {
    const id = `full:${x.id}`;
    fields.gives = [id];
    return decided({ ok: true, text: `They dipped the ${x.name} in the water and lifted it out full.`, uses: { [x.id]: 1 }, gives: { [id]: 1 }, fields, make: {
      id, make: () => ({ name: `${short(x)} of water`, props: { ...x.props, heavy: Math.min(1, p(x, "heavy") + 0.3) }, parts: [x.id], verb: "wet" }), quiet: true,
    } });
  }
  // A basket woven loose enough to let the water through, swept along where fish are swimming, scoops one or two up.
  if (p(x, "container") >= 0.6 && p(x, "container") < 0.85 && p(x, "fibrous") >= 0.6) {
    if (!c.fish.basket) return { ok: false, text: `They swept the ${x.name} through the water, and it came up empty.`, uses: {}, gives: {}, fields, fishing: "basket" };
    // how many it brings up is chance: two now and then where two or more are swimming, more often for a practised hand
    const n = c.fish.basket >= 2 && c.draw() < 0.4 + c.skill * 0.05 ? 2 : 1;
    fields.gives = ["fish"];
    return { ok: true, text: `They swept the ${x.name} through the water and lifted it out with ${n > 1 ? "two fish" : "a fish"} flapping in it.`, uses: {}, gives: { fish: n }, fields, fishing: "basket" };
  }
  if (lineLike(x)) {
    // A fish swimming within a stone's throw of the line comes to it and bites.
    if (!c.fish.line) return { ok: false, text: `They dangled the ${x.name} in the water, and nothing bit.`, uses: {}, gives: {}, fields, fishing: "line" };
    fields.gives = ["fish"];
    return { ok: true, text: `They dangled the ${x.name} in the water and something bit. A fish!`, uses: {}, gives: { fish: 1 }, fields, fishing: "line" };
  }
  return decided({ text: `The ${x.name} got wet. Nothing else happened.`, fields });
}
export function wet(w: World, a: Agent, act: Act): Outcome {
  // the fish swimming within a line's reach, and of those, the ones within a basket's
  const line = w.animals.filter((m) => m.species === "fish" && meters(m, a) <= FISH_REACH.line);
  const basket = line.filter((m) => meters(m, a) <= FISH_REACH.basket);
  const { fishing, ...d } = wetting(w, act.items, {
    held: count(a, act.items[0]) > 0, water: openWater(w, a), fish: { basket: basket.length, line: line.length },
    skill: level(a.skills.fishing ?? 0), draw: () => Math.random(),
  });
  if (fishing) {
    a.inv.find((q) => q.k === act.items[0])!.hp -= 0.03;
    const caught = new Set((fishing === "basket" ? basket : line).slice(0, d.gives.fish ?? 0));
    if (caught.size) {
      w.animals = w.animals.filter((m) => !caught.has(m));
      landed(w).set(a.id, w.t);
    }
  }
  return enact(w, a, d);
}

// ---------- pour ----------
// Water carried in a vessel, poured over a young plant within reach or out on the ground. The ground round the plant stays
// wet a day or two (ecology.ts seedlings); what that does for it shows only as it grows, or doesn't.
export function pour(w: World, a: Agent, act: Act): Outcome {
  const x = kind(w, act.items[0]);
  const fields: Fields = { verb: "pour", inputs: act.items.slice(0, 1), target: act.target?.kind, gives: [] };
  if (!x?.id.startsWith("full:") || !count(a, x.id)) return outcome({ text: "They had no water to pour.", fields });
  takeItems(a, x.id);
  giveItems(w, a, x.parts![0]);
  const t = act.target?.thing ? thingById(w, act.target.thing) : null;
  if (!t || meters(a, t) > reachOf(t) + 1) {
    delete fields.target;
    return outcome({ text: `They poured the water out of the ${short(kind(w, x.parts![0])!)}. It soaked into the ground.`, uses: { [x.id]: 1 }, fields });
  }
  t.water = Math.min(1, (t.water ?? 0) + 0.5);
  mark(w, t);
  fields.effect = "watered";
  return outcome({ ok: true, text: `They poured the water over the ${t.kind === "sapling" ? "young plant" : t.kind.replaceAll("_", " ")}. The ground round it darkened.`, uses: { [x.id]: 1 }, effect: "watered", fields, later: t.kind === "sapling" ? t.id : undefined });
}

// Water they could dip something in from where they stand: open water within a couple of paces, or a well.
export function openWater(w: World, a: { px: number; py: number }) {
  for (let k = -1; k < 8; k++) {
    const r = k < 0 ? 0 : 3 / TILE_M, x = a.px + Math.cos((k * Math.PI) / 4) * r, y = a.py + Math.sin((k * Math.PI) / 4) * r;
    if ((wetAt(w, x, y) && !iceAt(w, Math.floor(x), Math.floor(y))) || streamNow(w, x, y)?.flowing) return true;
  }
  return !!anyAround(w, a.px, a.py, 3, ["well"]);
}

// ---------- throw ----------
// A shaft light enough to fly off a bowstring: long, light and pointed.
export const arrowy = (k?: Kind) => !!k && p(k, "long") >= 0.5 && p(k, "heavy") <= 0.3 && p(k, "sharp") >= 0.3;
// A bow to shoot with: a stiff, springy stave strung tight. A loose cord turns a fire drill, but throws nothing.
export const stave = (k?: Kind) => isBow(k) && p(k, "hard") >= 0.2;
// Whether this throw is a shot: an arrow-like thing loosed from a bow they are holding.
export const shooting = (w: World, a: Agent, act: Act) => !!act.tool && stave(kind(w, act.tool)) && count(a, act.tool) > 0 && arrowy(kind(w, act.items[0]));
// How far a throw flies true, and as close as anyone stalks an animal before throwing at it (sim.ts doAct): a bow
// carries twice as far as an arm.
export const throwReach = (w: World, a: Agent, act: Act) => (shooting(w, a, act) ? 40 : 20);
// What a throw that hits does, a shot from a bow far more: weight and edge driven home, less what the animal shrugs off.
export const throwDamage = (k: Kind, toughness: number, shot: boolean) => 5 * Math.max(0, (0.25 + p(k, "heavy") * 0.8) * (0.3 + p(k, "sharp") * 1.2) * (shot ? 5.5 : 2.2) - toughness * 0.3);
// Throwing trades leverage for range: only weight and edge count. Whatever is within the throw's reach is hit; what is
// farther off, it falls short of.
export function throwTick(w: World, a: Agent, act: Act, st: { progress: number; tries?: number }): { done: boolean; out?: Outcome } {
  const k = kind(w, act.items[0]);
  const fields: Fields = { verb: "throw", inputs: act.items.slice(0, 1), target: act.target?.kind, gives: [] };
  const prey = w.animals.find((m) => m.id === act.target?.animal);
  if (!k || !count(a, k.id)) return { done: true, out: outcome({ text: "They had nothing left to throw.", fields }) };
  if (!prey) return { done: true, out: outcome({ text: "The animal was gone.", fields }) };
  if (++st.progress % 3) return { done: false };
  const d = meters(a, prey);
  // Shot from a bow, a light, sharp shaft flies far straighter and hits far harder than a hand could throw it.
  const shot = shooting(w, a, act);
  if (shot) fields.tool = act.tool;
  const hit = d <= throwReach(w, a, act);
  const mat = THING_MATERIAL[prey.species];
  takeItems(a, k.id);
  // where a throw that falls short lands, a pace or more short of the animal, is chance
  const fall = hit ? 0 : (1 + Math.random() * 3) / TILE_M, dir = Math.atan2(prey.py - a.py, prey.px - a.px);
  dropPile(w, prey.px - Math.cos(dir) * fall, prey.py - Math.sin(dir) * fall, k.id, 1);
  const dmg = hit ? throwDamage(k, mat.toughness, shot) : 0;
  prey.hp -= dmg;
  if (prey.species === "deer") prey.state = "flee";
  else prey.target = a.id;
  trace("physics", "throw", { item: k.id, at: prey.species, dist: d, hit, dmg, hp: prey.hp }, a.id);
  st.tries = (st.tries ?? 0) + 1;
  if (prey.hp <= 0) {
    w.animals = w.animals.filter((m) => m !== prey);
    const gives = { ...mat.breaks };
    for (const [kk, n] of Object.entries(gives)) giveItems(w, a, kk, n);
    fields.gives = Object.keys(gives);
    return { done: true, out: outcome({ ok: true, text: `A ${shot ? "shot" : "thrown"} ${k.name} brought down the ${prey.species}. They butchered it into ${list(w, gives)}.`, uses: { [k.id]: 1 }, gives, fields, numbers: { rate: dmg } }) };
  }
  if (st.tries >= 6 || !count(a, k.id)) {
    fields.effect = dmg > 0 || st.progress > 3 ? "wounded" : undefined;
    const how = !hit ? `, but the ${k.name} fell short` : dmg > 0 ? " and hit it, but it got away hurt" : `, but the ${k.name} glanced off it`;
    return { done: true, out: outcome({ text: `They ${shot ? "shot" : "threw"} ${an(k.name)} at the ${prey.species}${how}.`, effect: fields.effect, fields, numbers: { rate: dmg } }) };
  }
  return { done: false };
}
const an = (s: string) => (/^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);

// ---------- the ground ----------
// Meters of soil over the rock at a point (the generator's regolith).
export const soilAt = (w: World, px: number, py: number) => { const { isle, fine } = groundOf(w.seed); return fine.bilinear(isle.soil, (px * TILE_M) / CELL - 0.5, (py * TILE_M) / CELL - 0.5); };
// The ground at a point as anyone standing on it would call it, by the rule the map is drawn with (terrain/flora.ts). It
// never changes, and planters ask it of the same points round them at every thought (sim.ts groundsNear), so each point's
// word is kept (let go of when the points pile up past a few thousand).
const groundWords = perWorld(() => new Map<number, Map<number, string>>());
export function groundWord(w: World, px: number, py: number) {
  const xs = groundWords(w);
  let ys = xs.get(px);
  const kept = ys?.get(py);
  if (kept !== undefined) return kept;
  const { isle, fine } = groundOf(w.seed);
  const word = GROUND[groundClass(isle, fine, px * TILE_M - SIZE / 2, py * TILE_M - SIZE / 2).cls] || "water";
  if (!ys) {
    if (xs.size >= 4096) xs.clear();
    xs.set(px, (ys = new Map()));
  }
  ys.set(py, word);
  return word;
}
// What can stand on a spot, and how far its own footprint reaches: a trunk, a bush's stems, a stone, a wall, a fire, a
// hole. Anything else (another plant's leaves, its roots, its shade) is no bar to pushing a seed in beside it.
const SOLID = ["tree", "stump", "burnt_stump", "bush", "dead_bush", "sapling", "boulder", "fallen_log", "structure", "fire", "pit", "trap", "well", "grave"];
const FOOT: Record<string, number> = { tree: 0.5, stump: 0.4, burnt_stump: 0.4, sapling: 0.15, fallen_log: 0.5, fire: 0.8, pit: 0.8, trap: 0.8, well: 0.8 };
export const occupied = (w: World, px: number, py: number) => !!anyAround(w, px, py, 6, SOLID, (t) => meters({ px, py }, t) < (FOOT[t.kind] ?? t.size / 2));
// A pit goes into a spade's depth of soil or more, on dry ground nothing stands on, clear of a tree's roots.
export function diggable(w: World, px: number, py: number) {
  return soilAt(w, px, py) >= PIT_SOIL && dryAt(w, px, py) && !occupied(w, px, py) && !anyAround(w, px, py, 1.5, ["tree", "stump", "burnt_stump"]);
}
// The first spot a pace to three off, turning round, where the ground takes what they're doing (and that looks right
// to them, by `ok`, if any does): dry land with soil this deep, nothing standing on it, and for a pit no roots of a tree
// or stump within a pace and a half. None, if nowhere within reach does.
export function spotNear(w: World, a: { px: number; py: number; heading?: number }, soil: number, roots: boolean, ok?: (px: number, py: number) => boolean): [number, number] | null {
  let first: [number, number] | null = null;
  for (const m of [1, 2, 3])
    for (let k = 0; k < 8; k++) {
      const ang = (a.heading ?? 0) + (k * Math.PI) / 4, px = a.px + (Math.cos(ang) * m) / TILE_M, py = a.py + (Math.sin(ang) * m) / TILE_M;
      if (!dryAt(w, px, py) || soilAt(w, px, py) < soil || occupied(w, px, py) || (roots && anyAround(w, px, py, 1.5, ["tree", "stump", "burnt_stump"]))) continue;
      if (!ok || ok(px, py)) return [px, py];
      first ??= [px, py];
    }
  return first;
}
// How deep the soil has to be: a spade's depth for a pit, and a little for a seed.
export const PIT_SOIL = 0.2, SEED_SOIL = 0.03;
// How much of a pit a tick's digging makes, with a tool or bare hands, before a practised hand's share: a pit is done at 12.
export const digPower = (tool: Kind) => 0.15 + p(tool, "hard") * 0.4 + p(tool, "sharp") * 0.3 + p(tool, "long") * 0.3;

// ---------- dig ----------
export function digTick(w: World, a: Agent, act: Act, st: { progress: number; at?: [number, number] }): { done: boolean; out?: Outcome } {
  const tool = toolOf(w, act);
  const fields: Fields = { verb: "dig", inputs: [], tool: act.tool ?? null, gives: [] };
  // ground a pit can go into a pace or two off, the first they find turning round
  const where = st.at ?? spotNear(w, a, PIT_SOIL, true);
  if (!where) return { done: true, out: outcome({ text: "They looked all round for somewhere to dig, and found nowhere.", fields }) };
  const [px, py] = (st.at = where);
  const power = digPower(tool);
  st.progress += power * (1 + level(a.skills.digging ?? 0) * 0.1);
  if (!act.tool) a.needs.health = Math.max(0, a.needs.health - 0.05);
  trace("physics", "dig", { tool: tool.id, power, progress: st.progress }, a.id);
  if (st.progress < 12) return { done: false };
  mark(w, addThing(w, "pit", px, py, { owner: a.id, born: w.t }));
  fields.builds = "pit";
  return { done: true, out: outcome({ ok: true, text: `Digging with ${act.tool ? `the ${tool.name}` : "bare hands"} made a deep pit.`, builds: "pit", fields }) };
}

// ---------- shape ----------
// What pressing it into a bowl or a block comes to.
export function shaping(w: World, items: string[], form: string | undefined, c: { held: boolean }): Decision {
  const held = kind(w, items[0]);
  const fields: Fields = { verb: "shape", inputs: items.slice(0, 1), shape: form, gives: [] };
  if (!held || !c.held) return decided({ text: "They had nothing to shape.", fields });
  // Reshaping works on the raw material underneath.
  const x = held.verb === "shape" ? kind(w, held.parts![0])! : held;
  if (p(x, "plastic") < 0.6) return decided({ text: `The ${x.name} wouldn't take a shape.`, fields });
  const bowl = form === "bowl", id = `shape:${form}:${x.id}`;
  if (id === held.id) return decided({ text: `The ${held.name} was already that shape.`, fields });
  fields.gives = [id];
  return decided({ ok: true, text: `They pressed the ${held.name} into a ${bowl ? "hollow bowl" : "flat-sided block"}.`, uses: { [held.id]: 1 }, gives: { [id]: 1 }, fields, make: { id, make: () => ({
    name: `${x.id === "clay" ? "clay" : noun(x)} ${bowl ? "bowl" : "block"}`,
    props: bowl ? { ...x.props, container: 0.8, binding: 0, heavy: 0.35 } : { ...x.props, binding: 0.1, heavy: 0.6, hard: 0.2 },
    parts: [x.id], verb: "shape",
  }) } });
}
export function shape(w: World, a: Agent, act: Act): Outcome {
  return enact(w, a, shaping(w, act.items, act.shape, { held: count(a, act.items[0]) > 0 }));
}

// ---------- place: fires, hearths, shelters ----------
const STYLE: [string, (k: Kind) => boolean][] = [
  ["brick", (k) => k.id.startsWith("fired:shape:block")], ["planks", (k) => k.base === "plank"], ["logs", (k) => k.base === "log"],
  ["stone", (k) => k.base === "stone"], ["hide", (k) => k.base === "hide"], ["reeds", (k) => p(k, "fibrous") >= 0.6],
  ["clay", (k) => p(k, "plastic") > 0.5 || k.id.includes("clay")], ["sticks", (k) => p(k, "long") >= 0.5],
];
// Anything you can shelter in stands on a frame: three or more long, stiff pieces leaned together, or walls of ten or
// more solid stones, logs, planks or blocks. Short of that, whatever is heaped up is only a pile, however much it
// covers. A hut wants six frame pieces or a dozen solid ones; a cabin both, and sixteen pieces in all.
const framing = (k: Kind) => p(k, "long") >= 0.5 && p(k, "hard") >= 0.25;
const walling = (k: Kind) => p(k, "heavy") >= 0.4 && p(k, "hard") >= 0.5;
export function shelterOf(w: World, parts: Record<string, number>): Shelter {
  let cover = 0, insul = 0, sturdy = 0, flam = 0, n = 0, frame = 0, walls = 0;
  const byStyle: Record<string, number> = {};
  for (const [id, c] of Object.entries(parts)) {
    const k = w.kinds[id];
    if (!k) continue;
    n += c;
    const block = walling(k) ? 0.5 : 0;
    if (framing(k)) frame += c;
    if (walling(k)) walls += c;
    cover += c * (p(k, "long") * 0.55 + p(k, "fibrous") * 0.3 + p(k, "insulating") * 0.4 + block);
    insul += c * (p(k, "insulating") + p(k, "fibrous") * 0.4 + p(k, "heavy") * 0.4);
    sturdy += c * p(k, "hard") * (0.5 + p(k, "toughness"));
    flam += c * p(k, "flammable");
    const style = STYLE.find(([, f]) => f(k))?.[0] ?? "mixed";
    byStyle[style] = (byStyle[style] ?? 0) + c;
  }
  const coverS = clamp01(cover / 6), insulS = n ? clamp01(insul / n) : 0, sturdyS = n ? clamp01(sturdy / n) : 0;
  const stands = frame >= 3 || walls >= 10;
  const tier = coverS < 0.25 || !stands ? 0
    : coverS >= 0.95 && sturdyS >= 0.45 && n >= 16 && frame >= 6 && walls >= 12 ? 3
      : coverS >= 0.7 && sturdyS >= 0.3 && (frame >= 6 || walls >= 12) ? 2 : 1;
  const style = Object.entries(byStyle).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "mixed";
  // How many it sleeps: the more that goes into it, the more floor it closes in. A lean-to's one slope covers two at
  // most and a round hut's poles span four; only a framed and walled lodge can be drawn out longer for as many again.
  const room = tier === 0 ? 0 : tier === 1 ? Math.min(2, 1 + Math.floor(n / 10)) : tier === 2 ? Math.min(4, 2 + Math.floor(Math.max(0, n - 12) / 8)) : 3 + Math.floor(Math.max(0, n - 16) / 8);
  return { tier: tier as Shelter["tier"], style, cover: coverS, insul: insulS, sturdy: sturdyS, flam: n ? flam / n : 0, room };
}
export const homeOf = (w: World, a: Agent) => { const h = thingById(w, a.home); return h?.kind === "structure" ? h : null; };
const TIER = ["a pile", "a lean-to", "a hut", "a cabin"];
const GAIN_WORDS: Record<"sturdy" | "insul" | "cover", string> = { sturdy: "sturdier", insul: "warmer", cover: "better at keeping the rain off" };
const WIDTH = [1.2, 2.2, 3, 4.5]; // meters across, by tier
// Close enough to set something into it or take something out: within reach of its walls.
export const reaches = (a: { px: number; py: number }, t: Thing) => meters(a, t) <= reachOf(t) + 1;
// A stone ring is the structure around a fire, where the fire stands.
const ringOf = (w: World, fire: Thing) => nearestThing(w, fire.px, fire.py, ["structure"], () => true, 1);
// What people call a structure: a stones-round-a-fire ring, a pile, a lean-to, a hut or a cabin.
export const shelterName = (w: World, t: Thing) =>
  (t.shelter?.tier ?? 0) === 0 && nearestThing(w, t.px, t.py, ["fire"], () => true, 1) ? "fire ring"
    : (t.shelter?.tier ?? 0) === 3 && (t.shelter?.room ?? 0) >= 6 ? "longhouse" : ["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0];

// What there is to place things at, within reach: the fire (and how many pieces already ring it in), a pit, the shelter
// they'd build onto (their own, one they live in, or an empty one they'd move into), and whether there's an empty one to
// move into, they having no home of their own.
export type PlaceSetting = { held: boolean; fire: Fire | null; ring: number; pit: boolean; own: Pick<Thing, "parts" | "shelter"> | null; empty: boolean };
// What placing them does besides taking them from their hands: lights a fire (or lends its flame to the one there, a lamp
// keeping its own), feeds the fire, rings it in, hides the pit, stores them at home, or builds a shelter or a pile.
type PlaceWork =
  | { does: "light"; fuel: number; keep?: string }
  | { does: "feed"; fuel: number; charcoal: number; heat: number }
  | { does: "ring"; contained: boolean; covered: boolean; heat: number }
  | { does: "trap" | "store" }
  | { does: "build"; shelter: Shelter; better: boolean; roomier: boolean };
// claims: they move into the empty shelter within reach, and make it theirs.
export type Placing = Decision & { claims?: boolean; work?: PlaceWork };
export function placing(w: World, items: string[], c: PlaceSetting): Placing {
  const parts = items.map((id) => kind(w, id)!).filter(Boolean);
  const need = tally(items);
  const fields: Fields = { verb: "place", inputs: [...items].sort(), gives: [] };
  if (!parts.length || !c.held) return decided({ text: "They didn't have those things to hand.", fields });
  const fire = c.fire;
  const flame = parts.find((k) => k.id.startsWith("burning:"));
  const fuels = parts.filter((k) => p(k, "flammable") >= 0.5 && k !== flame);
  if (flame && (fuels.length || fire)) {
    fields.builds = "fire";
    return {
      ok: true, text: `Setting the ${flame.name} into ${fuels.length ? fuels.map((k) => `the ${k.name}`).join(" and ") : "the fire"} started a campfire.`, uses: need, gives: {}, builds: "fire", fields,
      work: { does: "light", fuel: fuels.reduce((t, k) => t + (k.fuel ?? 20), 20), keep: p(flame, "container") >= 0.5 ? flame.id : undefined },
    };
  }
  if (fire && fuels.length === parts.length) {
    const fuel = fuels.reduce((t, k) => t + (k.fuel ?? 20), 0);
    const coal = fuels.filter((k) => (k.burns ?? 1) > 1.2).reduce((t, k) => t + (k.fuel ?? 20), 0);
    const heat = fireHeat(w, { ...fire, charcoal: (fire.charcoal ?? 0) + coal });
    const forge = coal > 0 && !!fire.contained;
    fields.at = forge ? "hearth" : "fire"; fields.builds = forge ? "forge" : "fed_fire";
    return {
      ok: true, text: forge ? `The ${list(w, need)} caught inside the ring and glowed white-hot.` : `Feeding ${list(w, need)} to the fire built it up.`, uses: need, gives: {}, builds: fields.builds, fields, numbers: { heat },
      work: { does: "feed", fuel, charcoal: coal, heat },
    };
  }
  // Stone or clay set around a fire rings it in; heaped over a fire that's already ringed, it closes it off to smolder.
  if (fire && parts.every((k) => (p(k, "hard") >= 0.5 && p(k, "flammable") < 0.2) || p(k, "plastic") >= 0.6)) {
    const walls = c.ring + items.length;
    const was = { contained: !!fire.contained, covered: !!fire.covered };
    const contained = walls >= 3, covered = was.covered || (was.contained && (walls >= 6 || parts.some((k) => p(k, "plastic") >= 0.6)));
    const heat = fireHeat(w, { ...fire, contained, covered });
    fields.at = was.contained ? "hearth" : "fire";
    fields.builds = covered ? "kiln" : contained ? "hearth" : "ring";
    const text = covered && !was.covered ? `Heaping ${list(w, need)} over the ringed fire closed it in. It smoldered low and smoky under the cover.`
      : contained && !was.contained ? `Ringing the fire with ${list(w, need)} closed it in. The flames stayed put and burned steady.` : `They set ${list(w, need)} beside the fire.`;
    return { ok: (contained && !was.contained) || (covered && !was.covered), text, uses: need, gives: {}, builds: fields.builds, fields, numbers: { heat }, work: { does: "ring", contained, covered, heat } };
  }
  const cover = parts.filter((k) => p(k, "long") >= 0.5 || p(k, "fibrous") >= 0.6);
  if (c.pit && cover.length >= 2 && cover.length === parts.length) {
    fields.at = "pit"; fields.builds = "trap";
    return { ok: true, text: `Laying ${list(w, need)} over the pit hid it from view.`, uses: need, gives: {}, builds: "trap", fields, work: { does: "trap" } };
  }
  const own = c.own, claims = c.empty;
  // Food set down inside a home is kept, not built into the walls, and so is a pot or basket to keep it in.
  if (own && (own.shelter?.tier ?? 0) >= 1 && parts.every((k) => p(k, "edible") >= 0.1 || p(k, "container") >= 0.6)) {
    fields.at = "home"; fields.builds = "stored";
    return { ok: false, text: `They tucked ${list(w, need)} away inside their shelter.`, uses: need, gives: {}, builds: "stored", fields, claims, work: { does: "store" } };
  }
  if (parts.some((k) => p(k, "edible") >= 0.1)) return { ok: false, text: `The ${parts.find((k) => p(k, "edible") >= 0.1)!.name} just rolled away.`, uses: {}, gives: {}, fields, claims };
  const built: Record<string, number> = { ...own?.parts };
  for (const [k, n] of Object.entries(need)) built[k] = (built[k] ?? 0) + n;
  const was = own?.shelter, before = was?.tier ?? 0, roomBefore = was?.room ?? 0;
  const sh = shelterOf(w, built);
  const grew = sh.tier > before, roomier = sh.room > roomBefore;
  // what else its builders can tell got better: it stands firmer, keeps the cold out, or keeps the rain off
  const gain = was && (["sturdy", "insul", "cover"] as const).find((q) => sh[q] > was[q] + 0.03);
  fields.builds = sh.tier >= 1 ? "shelter" : "pile";
  // Built onto the shelter they have, what they learn is about building it up: three stones that made a lean-to sturdier
  // are no shelter on their own.
  if (own) fields.at = "home";
  const named = TIER[sh.tier].replace(/^an? /, "");
  const text = own
    ? grew ? `Adding ${list(w, need)} turned their ${TIER[before].slice(2)} into ${TIER[sh.tier]}.`
      : roomier ? `Adding ${list(w, need)} made their ${named} big enough for ${sh.room}.`
        : gain ? `Adding ${list(w, need)} made their ${named} ${GAIN_WORDS[gain]}.` : `They added ${list(w, need)} to their ${named}.`
    : sh.tier >= 1 ? `Leaning and stacking ${list(w, need)} together made ${TIER[sh.tier]} they could shelter in.` : `They stacked ${list(w, need)} into a small pile.`;
  return {
    ok: sh.tier >= 1, text, uses: need, gives: {}, builds: fields.builds, fields, numbers: { cover: sh.cover, insul: sh.insul, tier: sh.tier, room: sh.room },
    claims, work: { does: "build", shelter: sh, better: grew || !!gain, roomier },
  };
}
export function place(w: World, a: Agent, act: Act): Outcome {
  const fire = nearestThing(w, a.px, a.py, ["fire"], (t) => reaches(a, t), 4), ring = fire && ringOf(w, fire);
  const pit = nearestThing(w, a.px, a.py, ["pit"], (t) => reaches(a, t), 4);
  const empty = homeOf(w, a) ? null : nearestThing(w, a.px, a.py, ["structure"], (t) => !t.owner && (t.shelter?.tier ?? 0) >= 1 && reaches(a, t), 6);
  // their own shelter, or the one they live in with others, within reach: or the empty one they'd move into
  const own = nearestThing(w, a.px, a.py, ["structure"], (t) => (t.owner === a.id || a.home === t.id || t === empty) && reaches(a, t) && !nearestThing(w, t.px, t.py, ["fire"], () => true, 1), 6);
  const { claims, work, ...d } = placing(w, act.items, {
    held: holding(a, act.items), fire, ring: ring ? Object.values(ring.parts!).reduce((t, n) => t + n, 0) : 0, pit: !!pit, own, empty: !!empty,
  });
  if (claims && empty) {
    empty.owner = a.id;
    log(w, "claim", [a.id], empty, `${a.name} moved into an empty ${TIER[empty.shelter!.tier].replace(/^an? /, "")} and made it theirs.`);
  }
  if (!work) return outcome(d);
  // A lamp lends its flame and keeps burning; a torch is used up.
  for (const [k, n] of Object.entries(d.uses)) takeItems(a, k, work.does === "light" && k === work.keep ? n - 1 : n);
  switch (work.does) {
    case "light":
      if (fire) { fire.hp = Math.min(400, (fire.hp ?? 0) + work.fuel); mark(w, fire); }
      else mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: work.fuel, maxHp: 400, born: w.t, heat: 1 }));
      break;
    case "feed": {
      const f = fire!;
      f.hp = Math.min(400, (f.hp ?? 0) + work.fuel);
      f.charcoal = (f.charcoal ?? 0) + work.charcoal;
      f.heat = work.heat;
      mark(w, f);
      break;
    }
    case "ring": {
      const f = fire!, r = ring ?? addThing(w, "structure", f.px, f.py, { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t, size: 1.6 });
      for (const [k, n] of Object.entries(d.uses)) r.parts![k] = (r.parts![k] ?? 0) + n;
      r.shelter = { ...shelterOf(w, r.parts!), tier: 0 };
      f.contained = work.contained;
      f.covered = work.covered;
      f.heat = work.heat;
      mark(w, r); mark(w, f);
      break;
    }
    case "trap":
      setKind(w, pit!, "trap"); pit!.owner = a.id;
      mark(w, pit!);
      break;
    case "store": {
      const home = own!;
      home.store ??= [];
      for (const [k, n] of Object.entries(d.uses)) for (let i = 0; i < n; i++) home.store.push({ k, hp: 1, born: w.t });
      mark(w, home);
      break;
    }
    case "build": {
      const s = own ?? addThing(w, "structure", ...beside(w, a, 1.5), { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t });
      for (const [k, n] of Object.entries(d.uses)) s.parts![k] = (s.parts![k] ?? 0) + n;
      const roomBefore = own?.shelter?.room ?? 0;
      s.shelter = work.shelter;
      s.size = sizeOf(work.shelter);
      s.hp = Math.min(s.maxHp!, (s.hp ?? 100) + 20);
      // Another load that made it neither a better shelter nor room for someone who needed it is something its builders
      // notice: more space than the people in it is no gain.
      if (own) s.stale = work.better || (work.roomier && residentsOf(w, s).length >= roomBefore) ? 0 : (s.stale ?? 0) + 1;
      mark(w, s);
      const home = homeOf(w, a);
      // A better shelter, or any shelter at all when the old home is more than half a day's walk away, is home now.
      const far = home && meters(home, s) > ((home.shelter?.tier ?? 0) <= 1 ? 60 : 150);
      if (work.shelter.tier >= 1 && (!home || home === s || (home.shelter?.tier ?? 0) < work.shelter.tier || far)) {
        if (home && home !== s) leaveHome(w, a, home);
        a.home = s.id;
      }
      trace("physics", "place", { parts: s.parts, shelter: s.shelter }, a.id);
    }
  }
  return outcome(d);
}
// Footprint in meters, by tier, and for a lodge drawn out longer, a pace and a half for each more it sleeps.
export const sizeOf = (sh: Shelter) => WIDTH[sh.tier] + (sh.tier === 3 ? 1.6 * Math.max(0, sh.room - 3) : 0);
// Who lives in a shelter: whoever calls it home.
export const residentsOf = (w: World, t: Thing) => w.agents.filter((x) => x.home === t.id);
// Someone moving out leaves the place to whoever still lives there, or empty for anyone to take.
export function leaveHome(w: World, a: Agent, home: Thing) {
  if (a.home === home.id) a.home = null;
  if (home.owner !== a.id) return;
  const next = residentsOf(w, home)[0];
  if (next) home.owner = next.id; else delete home.owner;
  mark(w, home);
}

// Putting things away inside a home keeps them out of your hands and out of the weather.
export function stash(w: World, a: Agent, keepFood = 3, home = homeOf(w, a)) {
  if (!home || !reaches(a, home)) return 0;
  home.store ??= [];
  let food = 0, moved = 0;
  for (const s of [...a.inv]) {
    const k = w.kinds[s.k];
    if (isToolish(k)) continue;
    if (p(k, "edible") >= 0.1 && food++ < keepFood) continue;
    a.inv.splice(a.inv.indexOf(s), 1);
    home.store.push(s);
    moved++;
  }
  if (moved) mark(w, home);
  return moved;
}
export function unstash(w: World, a: Agent, home: Thing, k: string, n: number) {
  let got = 0;
  for (const s of [...(home.store ?? [])]) {
    if (s.k !== k || got >= n || a.inv.length >= carryOf(w, a)) continue;
    home.store!.splice(home.store!.indexOf(s), 1);
    a.inv.push(s);
    got++;
  }
  if (got) mark(w, home);
  return got;
}
const isToolish = (k?: Kind) => !!k && (k.verb === "join" || k.verb === "rub" || p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6);

// ---------- plant, eat, wear ----------
// ok: whether a spot looks right to them for it (their theories of where seed won't come up)
export function plant(w: World, a: Agent, act: Act, ok?: (px: number, py: number) => boolean): Outcome {
  const x = kind(w, act.items[0]);
  const fields: Fields = { verb: "plant", inputs: act.items.slice(0, 1), gives: [] };
  if (!x || !count(a, x.id)) return outcome({ text: "They had nothing to plant.", fields });
  // any soil a pace or two off that nothing stands on, the first they find turning round that looks right to them, or
  // failing that the first: a seed goes in beside a bush or under a tree as well as anywhere, and whether it comes up
  // is up to what it finds there
  const spot = spotNear(w, a, SEED_SOIL, false, ok);
  if (!spot) return outcome({ text: `They looked all round for somewhere to push the ${x.name} in, and found nowhere.`, fields });
  const [px, py] = spot;
  takeItems(a, x.id);
  const ground = INTO[groundWord(w, px, py)] ?? "the ground";
  if (p(x, "seed") < 0.4) {
    fields.effect = "buried";
    return outcome({ text: `They pushed the ${x.name} into ${ground}.`, uses: { [x.id]: 1 }, effect: "buried", fields });
  }
  const t = addThing(w, "sapling", px, py, { owner: a.id, stage: 0, item: x.id, born: w.t, hp: 5, maxHp: 5 });
  mark(w, t);
  fields.effect = "buried";
  // done as well as it can be: whether it comes up is up to the ground and the days, and shows only then
  return outcome({ ok: true, text: `They pushed the ${x.name} into ${ground}${nearWater(w, a.x, a.y, 1) ? " near the water" : ""}.`, uses: { [x.id]: 1 }, effect: "buried", fields, later: t.id });
}
// The ground a seed goes into, as they'd put it.
const INTO: Record<string, string> = {
  grassland: "the grassy soil", "forest floor": "the leaf litter of the forest floor", scrub: "the scrubby ground", marsh: "the marsh mud",
  "bare ground": "the bare ground", sand: "the sand", "grass with outcrops": "the thin soil among the rocks", "bare rock": "a crack in the rock",
  stream: "the wet ground by the stream", lake: "the wet ground by the lake", sea: "the wet ground by the sea",
};

// Food rank enough to taste it, raw meat or anything gone rotten, makes whoever eats it sick, every time; food milder
// than that (raw fish, a mushroom, anything cooked) never does. How badly, and for how long, is chance.
const RANK = 0.25;
// What eating it comes to, for someone sick or not. How sick rank food makes them is chance, drawn as they eat it (eat).
export function eating(w: World, k: string, c: { held: boolean; sick: boolean }): Decision {
  const x = w.kinds[k];
  const fields: Fields = { verb: "eat", inputs: [k], gives: [] };
  if (!x || (p(x, "edible") < 0.03 && p(x, "medicinal") < 0.3)) return decided({ text: `They couldn't eat the ${x?.name ?? "thing"}.`, fields });
  if (!c.held) return decided({ text: "Nothing to eat.", fields });
  if (p(x, "medicinal") >= 0.5 && c.sick) {
    fields.effect = "cure";
    return decided({ ok: true, text: `Eating the ${x.name} eased their sickness.`, uses: { [k]: 1 }, effect: "cure", fields });
  }
  if (p(x, "toxic") >= RANK) {
    fields.effect = "sick";
    return decided({ text: `The ${x.name} tasted rank, and eating it made them sick.`, uses: { [k]: 1 }, effect: "sick", fields });
  }
  return decided({ ok: true, text: `They ate the ${x.name}.`, uses: { [k]: 1 }, fields });
}
export function eat(w: World, a: Agent, k: string): Outcome {
  const d = eating(w, k, { held: count(a, k) > 0, sick: !!a.sickness });
  const out = enact(w, a, d), x = w.kinds[k];
  if (!d.uses[k]) return out;
  a.needs.food = Math.min(100, a.needs.food + p(x, "edible") * 100);
  if (d.effect === "cure" && a.sickness) {
    a.sickness.until -= DAY;
    a.needs.health = Math.min(100, a.needs.health + 8);
  }
  if (d.effect === "sick") {
    const sev = clamp01(p(x, "toxic") + 0.1 + Math.random() * 0.2);
    a.sickness = { until: w.t + Math.round(DAY * (0.5 + sev * 1.5)), severity: Math.max(sev, a.sickness?.severity ?? 0) };
  }
  return out;
}

// What putting it on comes to.
export function wearing(w: World, items: string[], c: { held: boolean }): Decision {
  const x = kind(w, items[0]);
  const fields: Fields = { verb: "wear", inputs: items.slice(0, 1), gives: [] };
  if (!x || !c.held) return decided({ text: "They had nothing to put on.", fields });
  if (p(x, "insulating") < 0.5 || p(x, "flexible") < 0.4) return decided({ text: `The ${x.name} wouldn't stay on.`, fields });
  fields.builds = "worn";
  return decided({ ok: true, text: `They wrapped the ${x.name} around themselves. It kept the cold out.`, uses: { [x.id]: 1 }, builds: "worn", fields });
}
export function wearIt(w: World, a: Agent, act: Act): Outcome {
  const d = wearing(w, act.items, { held: count(a, act.items[0]) > 0 });
  if (d.ok) {
    const s = a.inv.find((q) => q.k === act.items[0])!;
    a.inv.splice(a.inv.indexOf(s), 1);
    if (a.wearing) a.inv.push(a.wearing);
    a.wearing = s;
  }
  return outcome(d);
}

// A Jev ruling, once made, is a law: apply it the same way every time.
export type Ruling = { useful: boolean; name: string; props: Props };
export function applyRuling(w: World, a: Agent, act: Act, key: string, r: Ruling): Outcome {
  const need = act.items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const fields: Fields = { verb: act.verb, inputs: [...act.items].sort(), at: act.at ?? null, gives: [] };
  const names = act.items.map((id) => nm(w, id));
  if (!r.useful) return outcome({ ruled: true, text: act.verb === "join" ? `The ${names.join(" and ")} wouldn't hold together.` : `Nothing came of ${act.verb === "heat" ? "heating" : "working"} the ${names.join(" and ")}.`, fields });
  if (Object.entries(need).some(([k, n]) => count(a, k) < n)) return outcome({ text: "They didn't have those things to hand.", fields });
  // Two different things shouldn't share a name.
  const taken = (n: string) => Object.values(w.kinds).some((x) => x.name === n && x.id !== `law:${key}`);
  const name = taken(r.name) ? (taken(`big ${r.name}`) ? `heavy ${r.name}` : `big ${r.name}`) : r.name;
  const [k, isNew] = ensure(w.kinds, `law:${key}`, () => ({ name, props: r.props, parts: fields.inputs, verb: act.verb }));
  for (const [kk, n] of Object.entries(need)) takeItems(a, kk, n);
  giveItems(w, a, k.id);
  const nk: string[] = [];
  made(w, a, k, isNew, nk);
  fields.gives = [k.id];
  return outcome({ ok: true, ruled: true, text: `${act.verb === "join" ? "Pressing" : "Working"} the ${names.join(" and ")} together made a ${k.name}.`, uses: need, gives: { [k.id]: 1 }, fields, newKinds: nk });
}

export { BASE };
