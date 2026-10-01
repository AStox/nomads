// The one hard-coded layer: how materials respond to being struck, rubbed, joined, heated, wetted, shaped, and placed.
import { BASE, THING_MATERIAL, clamp01, compoundName, depth, ensure, noun, p, plural, type Kind, type Props } from "./materials";
import { CELL } from "../terrain/grid";
import { DAY, REACH, TILE_M, Tile, YEAR, groundOf, addThing, dryAt, dryNear, iceAt, level, log, meters, nearWater, reachOf, tileAt, wetAt, type Act, type Agent, type Shelter, type Thing, type World } from "./world";
import { anyAround, leave, liveThings, nearestThing, setKind, thingById, wake } from "./space";
import { clock, trace } from "./trace";
import { see } from "./beliefs";
import { enrich } from "./soil";
import { streamNow } from "./streams";

// Kinds of stuff the rules below care about, by what they're like rather than what they're called.
export const greasy = (k?: Kind) => !!k && p(k, "edible") >= 0.1 && p(k, "flammable") >= 0.7;
export const airy = (k?: Kind) => !!k && p(k, "flexible") >= 0.5 && p(k, "container") >= 0.5; // can pump or fan air
const skin = (k?: Kind) => !!k && !k.parts?.length && p(k, "flexible") >= 0.5 && p(k, "insulating") >= 0.5 && p(k, "fibrous") < 0.6;
const sticky = (k?: Kind) => !!k && p(k, "binding") >= 0.5 && p(k, "flammable") >= 0.6 && p(k, "fibrous") < 0.3 && p(k, "plastic") < 0.5;
const short = (k: Kind) => (k.parts ? (k.named ? k.name : noun(k)) : k.name);

// How hot a fire burns: a ring of stone holds heat in, charcoal burns far hotter than wood, air blown through a ring hotter still.
export function fireHeat(w: World, f: Thing) {
  if (f.kind !== "fire") return f.burning ? 1 : 0;
  const coal = (f.charcoal ?? 0) > 0 ? (f.contained ? BASE.charcoal.burns! : 1.1) : 1;
  return Math.round(((f.contained ? 1.3 : 1) * coal + ((f.air ?? 0) > w.t && f.contained ? 0.5 : 0)) * 100) / 100;
}
// What people would call the fire they're standing at, most specific first.
export const fireKind = (f: Thing) =>
  f.kind !== "fire" || !f.contained ? "fire" : (f.charcoal ?? 0) > 0 ? "forge" : f.covered ? "kiln" : "hearth";
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
export const carryOf = (a: Agent) => (young(a) ? 8 : CARRY);
export function giveItems(w: World, a: Agent, k: string, n = 1) {
  for (let i = 0; i < n; i++) {
    if (a.inv.length >= carryOf(a) && !makeRoom(w, a, k)) { dropPile(w, a.px, a.py, k, n - i); return i; }
    a.inv.push({ k, hp: 1, born: w.t });
  }
  return n;
}
// Hands full: set down one of whatever plain material they have most of, unless that's what they're picking up.
function makeRoom(w: World, a: Agent, incoming: string) {
  const c = counts(a);
  // Keep one of each thing; beyond that, shed the most plentiful non-food, non-tool thing.
  const food = (x: string) => p(w.kinds[x], "edible") >= 0.1;
  const spare = Object.keys(c).filter((x) => x !== incoming && !food(x) && (c[x] >= 2 || (!isToolish(w.kinds[x]) && w.kinds[x]?.parts?.length)))
    .sort((x, y) => c[y] - c[x])[0]
    // A hungry hand drops anything that isn't food before it drops food.
    ?? (food(incoming) ? Object.keys(c).filter((x) => !food(x)).sort((x, y) => Number(isToolish(w.kinds[x])) - Number(isToolish(w.kinds[y])))[0] : undefined);
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
const HAND: Kind = { id: "hands", name: "bare hands", props: { hard: 0.2, heavy: 0.1 } };
const nm = (w: World, id: string) => w.kinds[id]?.name ?? id.replaceAll("_", " ");
const list = (w: World, m: Record<string, number>) =>
  Object.entries(m).map(([k, n]) => (n > 1 ? `${n} ${plural(nm(w, k))}` : `a ${nm(w, k)}`)).join(" and ");
function made(w: World, a: Agent, k: Kind, isNew: boolean, out: string[]) {
  if (isNew) { k.made = { by: a.id, t: w.t }; out.push(k.id); newKinds.add(k.id); }
}
const outcome = (o: Partial<Outcome> & { text: string; fields: Fields }): Outcome => ({ ok: false, uses: {}, gives: {}, newKinds: [], ...o });

// ---------- strike ----------
export function force(tool: Kind, a?: Agent) {
  const skill = a ? level(a.skills.toolwork ?? 0) * 0.04 : 0;
  return (0.25 + p(tool, "heavy") * 0.8 + p(tool, "long") * 0.35) * (1 + skill) * (a && young(a) ? 0.5 : 1);
}
export const focus = (tool: Kind) => 0.3 + p(tool, "sharp") * 1.2;
// Damage per blow: force concentrated by an edge, minus what the target can shrug off.
export const strikeDamage = (tool: Kind, toughness: number, a?: Agent) => 5 * Math.max(0, force(tool, a) * focus(tool) - toughness * 0.3);

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
  // Striking something you hold: knapping or splitting.
  if (!act.target?.thing && !act.target?.animal) {
    const tk = kind(w, act.target?.kind);
    if (!tk || !count(a, tk.id)) return { done: true, damage: 0, out: outcome({ text: `There was no ${act.target?.kind} to strike.`, fields }) };
    fields.inputs = [tk.id];
    const broke = wear(w, a, act, p(tk, "hard"));
    // Hot, soft metal takes a shape under a heavy, hard striker; each blow at the fire draws the edge out and tightens it.
    if (tk.cools && p(tk, "plastic") >= 0.5) {
      const cold = kind(w, tk.parts?.[0]) ?? tk;
      const fire = nearFire(w, a);
      fields.at = "forge";
      if (!fire || fireHeat(w, fire) < 1.5) return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `Away from a hot enough fire, the ${tk.name} stiffened before it could be worked.`, fields }) };
      const g = 0.2 * p(tool, "heavy") * p(tool, "hard");
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
    if (p(tk, "metal") >= 0.8) {
      if (++st.progress < 4) return { done: false, broke: broke ?? undefined, damage: 0 };
      fields.effect = "dented";
      return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `Hammering the cold ${tk.name} only dented it.`, effect: "dented", fields }) };
    }
    if (tk.grain === "shatter" && tk.breaks) {
      // Only something as hard as the stone can flake it.
      const chance = p(tool, "hard") ** 2 * p(tk, "hard") * 0.4 * (1 + level(a.skills.stonework ?? 0) * 0.08);
      trace("physics", "knap", { tool: tool.id, target: tk.id, chance }, a.id);
      // Two very hard stones throw sparks, the harder the more; with fine dry tinder in hand, a spark can catch.
      const tinder = tinderOf(w, a);
      const spark = 0.12 * (1 + Math.max(0, Math.max(p(tool, "hard"), p(tk, "hard")) - 0.9) * 40);
      if (tinder && p(tool, "hard") >= 0.8 && p(tk, "hard") >= 0.8 && !(raining(w) && !sheltered(w, a)) && Math.random() < spark) {
        takeItems(a, tinder.id);
        mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: 50, maxHp: 400, born: w.t }));
        fields.inputs = [tk.id, tinder.id].sort(); fields.builds = "fire";
        return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ ok: true, text: `Striking the ${tk.name} with the ${tool.name} threw a spark into the ${tinder.name}, and it caught. A fire!`, uses: { [tinder.id]: 1 }, builds: "fire", fields }) };
      }
      if (Math.random() < chance) {
        takeItems(a, tk.id);
        const gives = { ...tk.breaks };
        for (const [k, n] of Object.entries(gives)) giveItems(w, a, k, n);
        fields.gives = Object.keys(gives);
        return { done: true, broke: broke ?? undefined, damage: 1, out: outcome({ ok: true, text: `Striking the ${tk.name} with ${tool.id === "hands" ? "bare hands" : `the ${tool.name}`} chipped off ${list(w, gives)}.`, uses: { [tk.id]: 1 }, gives, fields, numbers: { chance } }) };
      }
      if (++st.progress >= 10) return { done: true, broke: broke ?? undefined, damage: 0, out: outcome({ text: `They struck the ${tk.name} again and again. Sparks and grit, but nothing broke off.`, fields, numbers: { chance } }) };
      return { done: false, broke: broke ?? undefined, damage: 0 };
    }
    // Splitting along the grain needs a focused edge.
    const eff = force(tool, a) * focus(tool);
    const dmg = tk.grain === "split" && eff > p(tk, "toughness") * 0.8 ? 5 * (eff - p(tk, "toughness") * 0.5) : 0;
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
  // A sharp edge driven into a standing tree peels strips of bark, and the wound beads resin over the next days.
  if ("kind" in target && (target.kind === "tree" || target.kind === "stump") && dmg > 0) {
    target.scarred = w.t;
    if (p(tool, "sharp") >= 0.4 && (target.bark ?? 0) < 3 && Math.random() < 0.08 * p(tool, "sharp")) {
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

// ---------- rub ----------
const tinderOf = (w: World, a: Agent) => a.inv.map((s) => kind(w, s.k)!).find((k) => p(k, "fibrous") >= 0.8 && p(k, "flammable") >= 0.8);
export const isBow = (k?: Kind) => !!k && p(k, "flexible") >= 0.8 && p(k, "long") >= 0.5 && p(k, "binding") >= 0.5;
export function sheltered(w: World, a: Agent) {
  return !!anyAround(w, a.px, a.py, 4, ["structure"], (t) => (t.shelter?.tier ?? 0) >= 1);
}
const raining = (w: World) => w.weather.sky === "rain" || w.weather.sky === "storm";

// Rubbing: sharpens the softer thing on a much harder one, or builds friction heat between two woods.
export function rubTick(w: World, a: Agent, act: Act, st: { progress: number; heat?: number }): { done: boolean; out?: Outcome } {
  const [ia, ib] = act.items;
  const A = kind(w, ia), B = kind(w, ib);
  const fields: Fields = { verb: "rub", inputs: [ia, ib].filter(Boolean).sort(), gives: [] };
  if (!A || !B || count(a, ia) < 1 || count(a, ib) < (ia === ib ? 2 : 1)) return { done: true, out: outcome({ text: "They didn't have both things to rub together.", fields }) };
  st.progress++;
  // Fat worked into a raw hide softens and cures it.
  const fat = greasy(A) ? A : greasy(B) ? B : null, hide = skin(A) ? A : skin(B) ? B : null;
  if (fat && hide && fat !== hide) {
    if (st.progress < 10) return { done: false };
    const [k, isNew] = leather(w, hide);
    takeItems(a, fat.id); takeItems(a, hide.id);
    giveItems(w, a, k.id);
    const nk: string[] = [];
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    return { done: true, out: outcome({ ok: true, text: `Rubbing the ${fat.name} into the ${hide.name} softened it into ${k.name}.`, uses: { [fat.id]: 1, [hide.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk }) };
  }
  const soft = p(A, "hard") <= p(B, "hard") ? A : B, harder = soft === A ? B : A;
  if (p(harder, "hard") - p(soft, "hard") >= 0.35 && p(soft, "long") >= 0.5 && p(soft, "sharp") < 0.5 && soft.verb !== "rub") {
    if (st.progress < 10) return { done: false };
    const [k, isNew] = ensure(w.kinds, `rub:${soft.id}`, () => ({
      name: `pointed ${soft.name}`, props: { ...soft.props, sharp: clamp01(p(soft, "sharp") + 0.4), long: p(soft, "long") * 0.95 }, parts: [soft.id], verb: "rub", fuel: soft.fuel,
    }));
    takeItems(a, soft.id);
    giveItems(w, a, k.id);
    const nk: string[] = [];
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    return { done: true, out: outcome({ ok: true, text: `Rubbing the ${soft.name} on the ${harder.name} ground it to a point.`, uses: { [soft.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk }) };
  }
  // Friction needs something firm and long to spin or saw with; two limp fibers just slide.
  const firm = (k: Kind) => p(k, "hard") >= 0.25 && p(k, "long") >= 0.5;
  if (p(A, "hard") < 0.6 && p(B, "hard") < 0.6 && (p(A, "flammable") >= 0.5 || p(B, "flammable") >= 0.5) && (firm(A) || firm(B))) {
    const bow = isBow(A) || isBow(B);
    const wet = raining(w) && !sheltered(w, a);
    st.heat = Math.max(0, (st.heat ?? 0) + (bow ? 0.11 : 0.05) * (wet ? 0.5 : 1) * (1 + level(a.skills.firemaking ?? 0) * 0.1) - 0.015);
    trace("physics", "friction", { a: ia, b: ib, bow, wet, heat: st.heat }, a.id);
    const tinder = tinderOf(w, a);
    if (st.heat >= 1 && tinder && !wet) {
      takeItems(a, tinder.id);
      const fuel = [ia, ib].map((id) => kind(w, id)!).find((k) => !isBow(k) && p(k, "flammable") >= 0.5);
      if (fuel) takeItems(a, fuel.id);
      mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: 60 + (fuel?.fuel ?? 0), maxHp: 200, born: w.t }));
      fields.builds = "fire";
      fields.inputs = [...fields.inputs, tinder.id].sort();
      return { done: true, out: outcome({ ok: true, text: `Rubbing the ${A.name} against the ${B.name} got hot enough to catch the ${tinder.name}. A fire!`, uses: { [tinder.id]: 1, ...(fuel ? { [fuel.id]: 1 } : {}) }, builds: "fire", fields, numbers: { heat: st.heat } }) };
    }
    if (st.progress >= 60 || (st.heat >= 1 && (!tinder || wet))) {
      fields.effect = "heat";
      const why = wet ? " Everything was too damp to catch." : !tinder && st.heat >= 1 ? " It smoked, but there was nothing dry and fine to catch." : "";
      return { done: true, out: outcome({ text: `Rubbing the ${A.name} against the ${B.name} made them hot.${why}`, effect: "heat", fields, numbers: { heat: st.heat } }) };
    }
    return { done: false };
  }
  if (st.progress < 6) return { done: false };
  return { done: true, out: outcome({ text: `Rubbing the ${A.name} on the ${B.name} did nothing much.`, fields }) };
}

// ---------- join ----------
// Returns "ask" when the rules can't say whether these would hold together.
export function join(w: World, a: Agent, act: Act): Outcome | "ask" {
  const parts = act.items.map((id) => kind(w, id)!).filter(Boolean);
  const fields: Fields = { verb: "join", inputs: [...act.items].sort(), gives: [] };
  const need = act.items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  if (parts.length < 2 || Object.entries(need).some(([k, n]) => count(a, k) < n)) return outcome({ text: "They didn't have those things to hand.", fields });
  const id = `join:${fields.inputs.join("+")}`;
  const nk: string[] = [];
  let k: Kind, isNew: boolean, text = `Binding ${parts.map((x) => `the ${x.name}`).join(", ")} together made`;
  // Fat with a wick in something hard and hollow: a lamp that burns slow and steady.
  const hollow = parts.find((x) => p(x, "container") >= 0.6 && p(x, "hard") >= 0.5), fat = parts.find(greasy);
  const wick = parts.find((x) => x !== fat && x !== hollow && p(x, "fibrous") >= 0.6 && p(x, "flammable") >= 0.6);
  // Melted resin smeared over something soft and hollow seals it watertight.
  const glue = parts.find((x) => p(x, "binding") >= 0.9 && p(x, "fibrous") < 0.3 && p(x, "flammable") >= 0.5);
  const basket = parts.find((x) => x !== glue && p(x, "container") >= 0.4 && p(x, "hard") < 0.5);
  if (parts.length === 3 && hollow && fat && wick) {
    [k, isNew] = ensure(w.kinds, id, () => ({
      name: `${short(hollow)} filled with ${short(fat)} and a ${short(wick)} wick`,
      props: { container: p(hollow, "container"), hard: p(hollow, "hard"), heavy: p(hollow, "heavy"), flammable: 0.8, toughness: p(hollow, "toughness") },
      parts: fields.inputs, verb: "join",
    }));
    text = `Filling the ${hollow.name} with ${fat.name} and a ${wick.name} wick made`;
  } else if (parts.length === 2 && glue && basket) {
    [k, isNew] = ensure(w.kinds, id, () => ({
      name: `${short(basket)} sealed with ${short(glue)}`,
      props: { ...basket.props, container: 0.9, binding: 0, flammable: Math.max(p(basket, "flammable"), p(glue, "flammable")), toughness: clamp01(p(basket, "toughness") + 0.1) },
      parts: fields.inputs, verb: "join",
    }));
    text = `Smearing the ${glue.name} over the ${basket.name} sealed it tight. That made`;
  } else if (parts.some((x) => depth(w.kinds, x) >= 2)) {
    // ponytail: two levels of tying (fiber > cord > tool) covers every tool so far; lift when a real need shows up.
    return outcome({ text: `There was no way to tie anything more onto the ${parts.find((x) => depth(w.kinds, x) >= 2)!.name}.`, fields });
  } else if (parts.every((x) => p(x, "fibrous") >= 0.6 && !x.parts)) {
    const n = parts.length;
    [k, isNew] = ensure(w.kinds, id, () => n === 2
      ? { name: `twisted ${parts[0].name === parts[1].name ? parts[0].name : "fiber"} cord`, props: { binding: 0.85, flexible: 0.9, fibrous: 0.6, long: 0.5, flammable: 0.7, toughness: 0.3 }, parts: fields.inputs, verb: "join", fuel: 10 }
      : { name: `woven ${parts[0].name} mat`, props: { container: 0.5, insulating: 0.6, fibrous: 0.8, flexible: 0.7, flammable: 0.8, toughness: 0.2 }, parts: fields.inputs, verb: "join", fuel: 20 });
  } else {
    const binder = [...parts].sort((x, y) => p(y, "binding") - p(x, "binding"))[0];
    if (p(binder, "binding") < 0.6) return "ask";
    const rest = parts.filter((x) => x !== binder);
    const sheet = rest.length === 1 && p(rest[0], "flexible") >= 0.5 && p(rest[0], "long") < 0.5 && p(rest[0], "container") < 0.5 && p(rest[0], "fibrous") < 0.6 ? rest[0] : null;
    const headK = [...rest].sort((x, y) => p(y, "sharp") + p(y, "heavy") * 0.5 - p(x, "sharp") - p(x, "heavy") * 0.5)[0];
    const handle = rest.length > 1 ? [...rest].filter((x) => x !== headK).sort((x, y) => p(y, "long") - p(x, "long"))[0] : headK;
    [k, isNew] = ensure(w.kinds, id, () => {
      // A soft sheet gathered up and tied closes into a bag.
      if (sheet) return {
        name: `${short(sheet)} bag tied with ${short(binder)}`,
        props: { container: clamp01(0.45 + p(sheet, "flexible") * 0.3), flexible: p(sheet, "flexible"), insulating: p(sheet, "insulating") * 0.5, flammable: p(sheet, "flammable"), toughness: Math.min(p(sheet, "toughness") + 0.1, p(binder, "binding")) },
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
    });
  }
  for (const [kk, n] of Object.entries(need)) takeItems(a, kk, n);
  giveItems(w, a, k.id);
  made(w, a, k, isNew, nk);
  fields.gives = [k.id];
  trace("physics", "join", { parts: fields.inputs, made: k.id, props: k.props }, a.id);
  return outcome({ ok: true, text: `${text} a ${k.name}.`, uses: need, gives: { [k.id]: 1 }, fields, newKinds: nk });
}

// ---------- heat ----------
// Thresholds: cooking and melting resin 0.8, firing clay 1.2, softening metal 1.5, smelting ore 2.2. Wood only chars in a covered fire.
export function heat(w: World, a: Agent, act: Act): Outcome | "ask" {
  const parts = act.items.map((id) => kind(w, id)!).filter(Boolean);
  const fields: Fields = { verb: "heat", inputs: [...act.items].sort(), at: "fire", gives: [] };
  const need = act.items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  if (!parts.length || Object.entries(need).some(([k, n]) => count(a, k) < n)) return outcome({ text: "They didn't have those things to hand.", fields });
  const fire = nearFire(w, a);
  if (!fire) return outcome({ text: "The fire had gone out.", fields });
  // Something soft and hollow squeezed or flapped at the flames drives air into them.
  const fan = kind(w, act.tool);
  if (fan && airy(fan) && count(a, fan.id)) {
    fields.tool = fan.id;
    if (fire.kind === "fire") { fire.air = w.t + 12; fire.heat = fireHeat(w, fire); mark(w, fire); }
  }
  const level = fireHeat(w, fire);
  trace("physics", "heat", { items: act.items, fire: fireKind(fire), heat: level, fan: fields.tool }, a.id);
  const nk: string[] = [];
  const done = (k: Kind, isNew: boolean, text: string, keep: string[] = [], n = 1): Outcome => {
    for (const [kk, c] of Object.entries(need)) if (!keep.includes(kk)) takeItems(a, kk, c);
    giveItems(w, a, k.id, n);
    made(w, a, k, isNew, nk);
    fields.gives = [k.id];
    const uses = Object.fromEntries(Object.entries(need).filter(([kk]) => !keep.includes(kk)));
    return outcome({ ok: true, text, uses, gives: { [k.id]: n }, fields, newKinds: nk, numbers: { heat: level } });
  };
  // Not hot enough: remember where it was tried, so "a ringed fire isn't hot enough for this" is something people can learn.
  const cool = (text: string) => {
    fields.at = fireKind(fire);
    fields.effect = "too_cool";
    return outcome({ text, effect: "too_cool", fields, numbers: { heat: level } });
  };
  const pot = parts.find((x) => p(x, "container") >= 0.6 && p(x, "hard") >= 0.5);
  const foods = parts.filter((x) => p(x, "edible") > 0 && x !== pot);
  if (pot && foods.length >= 1) {
    const id = `stew:${foods.map((x) => x.id).sort().join("+")}`;
    const [k, isNew] = ensure(w.kinds, id, () => ({
      name: `${foods.length > 1 ? "mixed" : foods[0].name} stew`,
      props: { edible: clamp01(foods.reduce((t, x) => t + p(x, "edible"), 0) * 1.4), toxic: Math.min(...foods.map((x) => p(x, "toxic"))) * 0.1, medicinal: Math.max(...foods.map((x) => p(x, "medicinal"))) },
      parts: fields.inputs, verb: "heat", shelf: 3,
    }));
    return done(k, isNew, `Cooking ${foods.map((x) => `the ${x.name}`).join(" and ")} in the ${pot.name} made a ${k.name}.`, [pot.id]);
  }
  if (parts.length !== 1) return "ask";
  const x = parts[0];
  if (/^(cooked|fired|burning|hot|melt|forge):/.test(x.id)) return outcome({ text: `Heating the ${x.name} again did nothing more.`, fields });
  if (p(x, "edible") > 0) {
    const [k, isNew] = ensure(w.kinds, `cooked:${x.id}`, () => ({
      name: x.id === "meat" ? "roast meat" : `cooked ${x.name}`,
      props: { ...x.props, edible: clamp01(p(x, "edible") * 1.6 + 0.05), toxic: p(x, "toxic") * 0.15, seed: 0 },
      parts: [x.id], verb: "heat", shelf: (x.shelf ?? 1) * 2 + 1,
    }));
    return done(k, isNew, `Holding the ${x.name} over the fire cooked it.`);
  }
  if (sticky(x)) {
    const [k, isNew] = ensure(w.kinds, `melt:${x.id}`, () => ({
      name: `melted ${x.name}`, props: { binding: 0.95, flammable: p(x, "flammable"), plastic: 0.3, toughness: 0.1 }, parts: [x.id], verb: "heat", fuel: x.fuel,
    }));
    return done(k, isNew, `The ${x.name} softened in the heat and ran into a thick, sticky glue.`);
  }
  if (p(x, "plastic") >= 0.6) {
    if (level < 1.2) return cool(`The ${x.name} dried and cracked at the edges, but an open fire wasn't hot enough to harden it.`);
    fields.at = "hearth";
    const [k, isNew] = ensure(w.kinds, `fired:${x.id}`, () => ({
      name: x.id === "clay" ? "fired clay lump" : `fired ${x.name.replace(/^clay |^wet clay /, "clay ")}`,
      props: { ...x.props, plastic: 0, binding: 0, hard: 0.75, toughness: 0.45 },
      parts: [x.id], verb: "heat",
    }));
    return done(k, isNew, `The heat of the ringed fire baked the ${x.name} hard.`);
  }
  if (p(x, "metal") >= 0.8) {
    if (level < 1.5) return cool(`The ${x.name} got hot, but stayed as hard as ever.`);
    fields.at = "forge";
    const [k, isNew] = ensure(w.kinds, `hot:${x.id}`, () => ({ name: `glowing ${x.name}`, props: { ...x.props, plastic: 0.7 }, parts: [x.id], verb: "heat", cools: 36 }));
    return done(k, isNew, `The ${x.name} glowed orange in the charcoal and went soft enough to work.`);
  }
  if (p(x, "metal") >= 0.3) {
    if (level < 2.2) return level >= 1.9 ? cool(`The ${x.name} glowed and sweated, but the fire wasn't quite hot enough.`) : outcome({ text: `The ${x.name} got hot, then cooled. Nothing changed.`, fields });
    fields.at = "forge";
    const [k, isNew] = ensure(w.kinds, `smelt:${x.id}`, () => ({
      name: "metal lump", props: { hard: 0.8, heavy: 0.85, metal: 1, toughness: clamp01(p(x, "toughness") + 0.15) }, parts: [x.id], verb: "heat",
    }));
    return done(k, isNew, `In the roaring charcoal the ${x.name} bled bright metal, which cooled into a lump.`);
  }
  const woody = p(x, "flammable") >= 0.5 && p(x, "hard") >= 0.3 && x.verb !== "join";
  if (woody && fire.covered) {
    fields.at = "kiln";
    return done(w.kinds.charcoal, false, `Starved of air under the cover, the ${x.name} blackened into charcoal instead of burning away.`, [], Math.max(1, Math.round(p(x, "heavy") * 2.5)));
  }
  if (skin(x)) {
    if (!fire.covered) {
      fields.effect = "scorched";
      return outcome({ text: `The ${x.name} dried stiff and scorched at the edges.`, effect: "scorched", fields });
    }
    fields.at = "kiln";
    const [k, isNew] = leather(w, x);
    return done(k, isNew, `Held in the thick smoke, the ${x.name} cured into ${k.name}.`);
  }
  const lamp = p(x, "container") >= 0.5 && p(x, "hard") >= 0.4;
  if (p(x, "flammable") >= 0.6 && (p(x, "long") >= 0.5 || lamp)) {
    const [k, isNew] = ensure(w.kinds, `burning:${x.id}`, () => ({ name: `${lamp ? "lit" : "burning"} ${x.name}`, props: { ...x.props, flammable: 1 }, parts: [x.id], verb: "heat" }));
    return done(k, isNew, lamp ? `The wick of the ${x.name} caught and burned low and steady. They could carry the flame.` : `The end of the ${x.name} caught fire. They could carry the flame.`);
  }
  if (p(x, "flammable") >= 0.7) {
    takeItems(a, x.id);
    fields.effect = "burned";
    return outcome({ text: `The ${x.name} burned away to nothing.`, uses: { [x.id]: 1 }, effect: "burned", fields });
  }
  if (p(x, "hard") >= 0.5 && p(x, "flammable") < 0.2) return outcome({ text: `The ${x.name} got hot, then cooled. Nothing changed.`, fields });
  return "ask";
}
export function leather(w: World, hide: Kind) {
  return ensure(w.kinds, `leather:${hide.id}`, () => ({
    name: hide.id === "hide" ? "leather" : `${hide.name} leather`,
    props: { insulating: clamp01(p(hide, "insulating") + 0.05), flexible: clamp01(p(hide, "flexible") + 0.25), fibrous: p(hide, "fibrous") * 0.6, toughness: clamp01(p(hide, "toughness") + 0.3), flammable: p(hide, "flammable") * 0.6 },
    parts: [hide.id], verb: "heat",
  }));
}

// ---------- wet ----------
export function wet(w: World, a: Agent, act: Act): Outcome {
  const x = kind(w, act.items[0]);
  const fields: Fields = { verb: "wet", inputs: act.items.slice(0, 1), at: "water", gives: [] };
  if (!x || !count(a, x.id)) return outcome({ text: "They had nothing to dip.", fields });
  if (!openWater(w, a)) return outcome({ text: "The water was frozen solid.", fields: { ...fields, effect: "frozen" }, effect: "frozen" });
  if (x.id.startsWith("burning:")) {
    takeItems(a, x.id);
    giveItems(w, a, x.parts![0]);
    return outcome({ ok: true, text: `The water put out the ${x.name}.`, uses: { [x.id]: 1 }, gives: { [x.parts![0]]: 1 }, fields: { ...fields, gives: [x.parts![0]] } });
  }
  if (p(x, "long") >= 0.5 && p(x, "flexible") >= 0.8 && p(x, "binding") >= 0.5) {
    // Fish bite where fish are: something swimming within a stone's throw of the line.
    const fish = w.animals.find((m) => m.species === "fish" && meters(m, a) <= 40);
    const chance = (fish ? 0.3 : 0.06) + level(a.skills.fishing ?? 0) * 0.05;
    const s = a.inv.find((q) => q.k === x.id)!;
    s.hp -= 0.03;
    if (Math.random() < chance) {
      if (fish) w.animals = w.animals.filter((m) => m !== fish);
      giveItems(w, a, "fish");
      fields.gives = ["fish"];
      return outcome({ ok: true, text: `They dangled the ${x.name} in the water and something bit. A fish!`, gives: { fish: 1 }, fields, numbers: { chance } });
    }
    fields.effect = "nibble";
    return outcome({ text: `They dangled the ${x.name} in the water. Something tugged at it, then let go.`, effect: "nibble", fields, numbers: { chance } });
  }
  return outcome({ text: `The ${x.name} got wet. Nothing else happened.`, fields });
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
// Throwing trades leverage for range: only weight and edge count, and it can miss.
export function throwTick(w: World, a: Agent, act: Act, st: { progress: number; tries?: number }): { done: boolean; out?: Outcome } {
  const k = kind(w, act.items[0]);
  const fields: Fields = { verb: "throw", inputs: act.items.slice(0, 1), target: act.target?.kind, gives: [] };
  const prey = w.animals.find((m) => m.id === act.target?.animal);
  if (!k || !count(a, k.id)) return { done: true, out: outcome({ text: "They had nothing left to throw.", fields }) };
  if (!prey) return { done: true, out: outcome({ text: "The animal was gone.", fields }) };
  if (++st.progress % 3) return { done: false };
  const d = meters(a, prey);
  const chance = Math.max(0.05, Math.min(0.9, 0.35 + level(a.skills.throwing ?? 0) * 0.05 + p(k, "heavy") * 0.15 + p(k, "sharp") * 0.2 - d * 0.01));
  const mat = THING_MATERIAL[prey.species];
  takeItems(a, k.id);
  const hit = Math.random() < chance;
  const past = hit ? 0 : (1 + Math.random() * 3) / TILE_M, dir = Math.atan2(prey.py - a.py, prey.px - a.px);
  dropPile(w, prey.px + Math.cos(dir) * past, prey.py + Math.sin(dir) * past, k.id, 1);
  const dmg = hit ? 5 * Math.max(0, (0.25 + p(k, "heavy") * 0.8) * (0.3 + p(k, "sharp") * 1.2) * 2.2 - mat.toughness * 0.3) : 0;
  prey.hp -= dmg;
  if (prey.species === "deer") prey.state = "flee";
  else prey.target = a.id;
  trace("physics", "throw", { item: k.id, at: prey.species, dist: d, chance, hit, dmg, hp: prey.hp }, a.id);
  st.tries = (st.tries ?? 0) + 1;
  if (prey.hp <= 0) {
    w.animals = w.animals.filter((m) => m !== prey);
    const gives = { ...mat.breaks };
    for (const [kk, n] of Object.entries(gives)) giveItems(w, a, kk, n);
    fields.gives = Object.keys(gives);
    return { done: true, out: outcome({ ok: true, text: `A thrown ${k.name} brought down the ${prey.species}. They butchered it into ${list(w, gives)}.`, uses: { [k.id]: 1 }, gives, fields, numbers: { rate: dmg, chance } }) };
  }
  if (st.tries >= 6 || !count(a, k.id)) {
    fields.effect = dmg > 0 || st.progress > 3 ? "wounded" : undefined;
    return { done: true, out: outcome({ text: `They threw ${an(k.name)} at the ${prey.species}${dmg > 0 ? " and hit it, but it got away hurt" : ", but missed"}.`, effect: fields.effect, fields, numbers: { rate: dmg, chance } }) };
  }
  return { done: false };
}
const an = (s: string) => (/^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);

// ---------- dig ----------
// Meters of soil over the rock at a point (the generator's regolith).
export const soilAt = (w: World, px: number, py: number) => { const { isle, fine } = groundOf(w.seed); return fine.bilinear(isle.soil, (px * TILE_M) / CELL - 0.5, (py * TILE_M) / CELL - 0.5); };
// Soft ground, a spade's depth of soil or more, with nothing standing on it within a pace or two.
export function diggable(w: World, px: number, py: number) {
  return soilAt(w, px, py) >= 0.2 && dryAt(w, px, py) && !anyAround(w, px, py, 1.5, SOLID);
}
// What takes up the ground it stands on, so no one can dig or plant right there.
const SOLID = ["tree", "stump", "burnt_stump", "bush", "dead_bush", "sapling", "boulder", "fallen_log", "structure", "fire", "pit", "trap", "well", "grave"];
export function digTick(w: World, a: Agent, act: Act, st: { progress: number }): { done: boolean; out?: Outcome } {
  const tool = toolOf(w, act);
  const fields: Fields = { verb: "dig", inputs: [], tool: act.tool ?? null, gives: [] };
  const [px, py] = beside(w, a, 1);
  if (!diggable(w, px, py)) return { done: true, out: outcome({ text: "The ground here couldn't be dug.", fields }) };
  const power = 0.15 + p(tool, "hard") * 0.4 + p(tool, "sharp") * 0.3 + p(tool, "long") * 0.3;
  st.progress += power * (1 + level(a.skills.digging ?? 0) * 0.1);
  if (!act.tool) a.needs.health = Math.max(0, a.needs.health - 0.05);
  trace("physics", "dig", { tool: tool.id, power, progress: st.progress }, a.id);
  if (st.progress < 12) return { done: false };
  mark(w, addThing(w, "pit", px, py, { owner: a.id, born: w.t }));
  fields.builds = "pit";
  return { done: true, out: outcome({ ok: true, text: `Digging with ${act.tool ? `the ${tool.name}` : "bare hands"} made a deep pit.`, builds: "pit", fields }) };
}

// ---------- shape ----------
export function shape(w: World, a: Agent, act: Act): Outcome {
  const held = kind(w, act.items[0]);
  const fields: Fields = { verb: "shape", inputs: act.items.slice(0, 1), shape: act.shape, gives: [] };
  if (!held || !count(a, held.id)) return outcome({ text: "They had nothing to shape.", fields });
  // Reshaping works on the raw material underneath.
  const x = held.verb === "shape" ? kind(w, held.parts![0])! : held;
  if (p(x, "plastic") < 0.6) return outcome({ text: `The ${x.name} wouldn't take a shape.`, fields });
  const bowl = act.shape === "bowl";
  const [k, isNew] = ensure(w.kinds, `shape:${act.shape}:${x.id}`, () => ({
    name: `${x.id === "clay" ? "clay" : noun(x)} ${bowl ? "bowl" : "block"}`,
    props: bowl ? { ...x.props, container: 0.8, binding: 0, heavy: 0.35 } : { ...x.props, binding: 0.1, heavy: 0.6, hard: 0.2 },
    parts: [x.id], verb: "shape",
  }));
  if (k.id === held.id) return outcome({ text: `The ${held.name} was already that shape.`, fields });
  takeItems(a, held.id);
  giveItems(w, a, k.id);
  const nk: string[] = [];
  made(w, a, k, isNew, nk);
  fields.gives = [k.id];
  return outcome({ ok: true, text: `They pressed the ${held.name} into a ${bowl ? "hollow bowl" : "flat-sided block"}.`, uses: { [held.id]: 1 }, gives: { [k.id]: 1 }, fields, newKinds: nk });
}

// ---------- place: fires, hearths, shelters ----------
const STYLE: [string, (k: Kind) => boolean][] = [
  ["brick", (k) => k.id.startsWith("fired:shape:block")], ["planks", (k) => k.base === "plank"], ["logs", (k) => k.base === "log"],
  ["stone", (k) => k.base === "stone"], ["hide", (k) => k.base === "hide"], ["reeds", (k) => p(k, "fibrous") >= 0.6],
  ["clay", (k) => p(k, "plastic") > 0.5 || k.id.includes("clay")], ["sticks", (k) => p(k, "long") >= 0.5],
];
export function shelterOf(w: World, parts: Record<string, number>): Shelter {
  let cover = 0, insul = 0, sturdy = 0, flam = 0, n = 0;
  const byStyle: Record<string, number> = {};
  for (const [id, c] of Object.entries(parts)) {
    const k = w.kinds[id];
    if (!k) continue;
    n += c;
    const block = p(k, "heavy") >= 0.5 && p(k, "hard") >= 0.5 ? 0.5 : 0;
    cover += c * (p(k, "long") * 0.55 + p(k, "fibrous") * 0.3 + p(k, "insulating") * 0.4 + block);
    insul += c * (p(k, "insulating") + p(k, "fibrous") * 0.4 + p(k, "heavy") * 0.4);
    sturdy += c * p(k, "hard") * (0.5 + p(k, "toughness"));
    flam += c * p(k, "flammable");
    const style = STYLE.find(([, f]) => f(k))?.[0] ?? "mixed";
    byStyle[style] = (byStyle[style] ?? 0) + c;
  }
  const coverS = clamp01(cover / 6), insulS = n ? clamp01(insul / n) : 0, sturdyS = n ? clamp01(sturdy / n) : 0;
  const tier = coverS < 0.25 ? 0 : coverS >= 0.95 && sturdyS >= 0.45 && n >= 10 ? 3 : coverS >= 0.7 && sturdyS >= 0.3 ? 2 : 1;
  const style = Object.entries(byStyle).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "mixed";
  return { tier: tier as Shelter["tier"], style, cover: coverS, insul: insulS, sturdy: sturdyS, flam: n ? flam / n : 0 };
}
export const homeOf = (w: World, a: Agent) => { const h = thingById(w, a.home); return h?.kind === "structure" ? h : null; };
const TIER = ["a pile", "a lean-to", "a hut", "a cabin"];
const WIDTH = [1.2, 2.2, 3, 4.5]; // meters across, by tier
// Close enough to set something into it or take something out: within reach of its walls.
export const reaches = (a: { px: number; py: number }, t: Thing) => meters(a, t) <= reachOf(t) + 1;
// A stone ring is the structure around a fire, where the fire stands.
const ringOf = (w: World, fire: Thing) => nearestThing(w, fire.px, fire.py, ["structure"], () => true, 1);
// What people call a structure: a stones-round-a-fire ring, a pile, a lean-to, a hut or a cabin.
export const shelterName = (w: World, t: Thing) =>
  (t.shelter?.tier ?? 0) === 0 && nearestThing(w, t.px, t.py, ["fire"], () => true, 1) ? "fire ring" : ["pile", "lean-to", "hut", "cabin"][t.shelter?.tier ?? 0];

export function place(w: World, a: Agent, act: Act): Outcome {
  const parts = act.items.map((id) => kind(w, id)!).filter(Boolean);
  const need = act.items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const fields: Fields = { verb: "place", inputs: [...act.items].sort(), gives: [] };
  if (!parts.length || Object.entries(need).some(([k, n]) => count(a, k) < n)) return outcome({ text: "They didn't have those things to hand.", fields });
  const take = () => { for (const [k, n] of Object.entries(need)) takeItems(a, k, n); };
  const fire = nearestThing(w, a.px, a.py, ["fire"], (t) => reaches(a, t), 4);
  const flame = parts.find((k) => k.id.startsWith("burning:"));
  const fuels = parts.filter((k) => p(k, "flammable") >= 0.5 && k !== flame);
  if (flame && (fuels.length || fire)) {
    // A lamp lends its flame and keeps burning; a torch is used up.
    for (const [k, n] of Object.entries(need)) takeItems(a, k, k === flame.id && p(flame, "container") >= 0.5 ? n - 1 : n);
    const fuel = fuels.reduce((t, k) => t + (k.fuel ?? 20), 20);
    if (fire) { fire.hp = Math.min(400, (fire.hp ?? 0) + fuel); mark(w, fire); }
    else mark(w, addThing(w, "fire", ...beside(w, a, 0.8), { owner: a.id, hp: fuel, maxHp: 400, born: w.t, heat: 1 }));
    fields.builds = "fire";
    return outcome({ ok: true, text: `Setting the ${flame.name} into ${fuels.length ? fuels.map((k) => `the ${k.name}`).join(" and ") : "the fire"} started a campfire.`, uses: need, builds: "fire", fields });
  }
  if (fire && fuels.length === parts.length) {
    take();
    fire.hp = Math.min(400, (fire.hp ?? 0) + fuels.reduce((t, k) => t + (k.fuel ?? 20), 0));
    const coal = fuels.filter((k) => (k.burns ?? 1) > 1.2).reduce((t, k) => t + (k.fuel ?? 20), 0);
    fire.charcoal = (fire.charcoal ?? 0) + coal;
    fire.heat = fireHeat(w, fire);
    mark(w, fire);
    const forge = coal > 0 && !!fire.contained;
    fields.at = forge ? "hearth" : "fire"; fields.builds = forge ? "forge" : "fed_fire";
    return outcome({ ok: true, text: forge ? `The ${list(w, need)} caught inside the ring and glowed white-hot.` : `Feeding ${list(w, need)} to the fire built it up.`, uses: need, builds: fields.builds, fields, numbers: { heat: fire.heat } });
  }
  // Stone or clay set around a fire rings it in; heaped over a fire that's already ringed, it closes it off to smolder.
  if (fire && parts.every((k) => (p(k, "hard") >= 0.5 && p(k, "flammable") < 0.2) || p(k, "plastic") >= 0.6)) {
    take();
    let ring = ringOf(w, fire);
    if (!ring) ring = addThing(w, "structure", fire.px, fire.py, { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t, size: 1.6 });
    for (const [k, n] of Object.entries(need)) ring.parts![k] = (ring.parts![k] ?? 0) + n;
    ring.shelter = { ...shelterOf(w, ring.parts!), tier: 0 };
    const walls = Object.values(ring.parts!).reduce((t, n) => t + n, 0);
    const was = { contained: !!fire.contained, covered: !!fire.covered };
    fire.contained = walls >= 3;
    fire.covered = was.covered || (was.contained && (walls >= 6 || parts.some((k) => p(k, "plastic") >= 0.6)));
    fire.heat = fireHeat(w, fire);
    mark(w, ring); mark(w, fire);
    fields.at = was.contained ? "hearth" : "fire";
    fields.builds = fire.covered ? "kiln" : fire.contained ? "hearth" : "ring";
    const text = fire.covered && !was.covered ? `Heaping ${list(w, need)} over the ringed fire closed it in. It smoldered low and smoky under the cover.`
      : fire.contained && !was.contained ? `Ringing the fire with ${list(w, need)} closed it in. The flames stayed put and burned steady.` : `They set ${list(w, need)} beside the fire.`;
    return outcome({ ok: (fire.contained && !was.contained) || (fire.covered && !was.covered), text, uses: need, builds: fields.builds, fields, numbers: { heat: fire.heat } });
  }
  const pit = nearestThing(w, a.px, a.py, ["pit"], (t) => reaches(a, t), 4);
  const cover = parts.filter((k) => p(k, "long") >= 0.5 || p(k, "fibrous") >= 0.6);
  if (pit && cover.length >= 2 && cover.length === parts.length) {
    take();
    setKind(w, pit, "trap"); pit.owner = a.id;
    mark(w, pit);
    fields.at = "pit"; fields.builds = "trap";
    return outcome({ ok: true, text: `Laying ${list(w, need)} over the pit hid it from view.`, uses: need, builds: "trap", fields });
  }
  const abandoned = nearestThing(w, a.px, a.py, ["structure"], (t) => !t.owner && (t.shelter?.tier ?? 0) >= 1 && reaches(a, t), 6);
  if (abandoned && !homeOf(w, a)) {
    abandoned.owner = a.id;
    log(w, "claim", [a.id], abandoned, `${a.name} moved into an empty ${TIER[abandoned.shelter!.tier].replace(/^an? /, "")} and made it theirs.`);
  }
  const own = nearestThing(w, a.px, a.py, ["structure"], (t) => t.owner === a.id && reaches(a, t) && !nearestThing(w, t.px, t.py, ["fire"], () => true, 1), 6);
  // Food set down inside a home is kept, not built into the walls.
  if (own && (own.shelter?.tier ?? 0) >= 1 && parts.every((k) => p(k, "edible") >= 0.1)) {
    take();
    own.store ??= [];
    for (const [k, n] of Object.entries(need)) for (let i = 0; i < n; i++) own.store.push({ k, hp: 1, born: w.t });
    mark(w, own);
    fields.at = "home"; fields.builds = "stored";
    return outcome({ text: `They tucked ${list(w, need)} away inside their shelter.`, uses: need, builds: "stored", fields });
  }
  if (parts.some((k) => p(k, "edible") >= 0.1)) return outcome({ text: `Food makes a poor thing to build with. The ${parts.find((k) => p(k, "edible") >= 0.1)!.name} just rolled away.`, fields });
  take();
  const s = own ?? addThing(w, "structure", ...beside(w, a, 1.5), { owner: a.id, parts: {}, hp: 100, maxHp: 100, born: w.t });
  for (const [k, n] of Object.entries(need)) s.parts![k] = (s.parts![k] ?? 0) + n;
  const before = own?.shelter?.tier ?? 0;
  s.shelter = shelterOf(w, s.parts!);
  s.size = WIDTH[s.shelter.tier];
  s.hp = Math.min(s.maxHp!, (s.hp ?? 100) + 20);
  mark(w, s);
  const home = homeOf(w, a);
  if (s.shelter.tier >= 1 && (!home || home === s || (home.shelter?.tier ?? 0) < s.shelter.tier || ((home.shelter?.tier ?? 0) <= 1 && meters(home, s) > 60))) {
    // Moving into a better place leaves the old one empty for anyone to take.
    if (home && home !== s) { delete home.owner; mark(w, home); }
    a.home = s.id;
  }
  const grew = s.shelter.tier > before;
  fields.builds = s.shelter.tier >= 1 ? "shelter" : "pile";
  trace("physics", "place", { parts: s.parts, shelter: s.shelter }, a.id);
  const text = own
    ? grew ? `Adding ${list(w, need)} turned their ${TIER[before].slice(2)} into ${TIER[s.shelter.tier]}.` : `They added ${list(w, need)} to their ${TIER[s.shelter.tier].replace(/^an? /, "")}.`
    : s.shelter.tier >= 1 ? `Leaning and stacking ${list(w, need)} together made ${TIER[s.shelter.tier]} they could shelter in.` : `They stacked ${list(w, need)} into a small pile.`;
  return outcome({ ok: s.shelter.tier >= 1, text, uses: need, builds: fields.builds, fields, numbers: { cover: s.shelter.cover, insul: s.shelter.insul, tier: s.shelter.tier } });
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
    if (s.k !== k || got >= n || a.inv.length >= carryOf(a)) continue;
    home.store!.splice(home.store!.indexOf(s), 1);
    a.inv.push(s);
    got++;
  }
  if (got) mark(w, home);
  return got;
}
const isToolish = (k?: Kind) => !!k && (k.verb === "join" || k.verb === "rub" || p(k, "sharp") >= 0.5 || p(k, "container") >= 0.6);

// ---------- plant, eat, wear ----------
export function plant(w: World, a: Agent, act: Act): Outcome {
  const x = kind(w, act.items[0]);
  const fields: Fields = { verb: "plant", inputs: act.items.slice(0, 1), gives: [] };
  if (!x || !count(a, x.id)) return outcome({ text: "They had nothing to plant.", fields });
  const [px, py] = beside(w, a, 0.8);
  if (soilAt(w, px, py) < 0.05) return outcome({ text: "The ground was too hard here.", fields });
  takeItems(a, x.id);
  if (p(x, "seed") < 0.4 || !diggable(w, px, py)) {
    fields.effect = "buried";
    return outcome({ text: `They pushed the ${x.name} into the dirt.`, uses: { [x.id]: 1 }, effect: "buried", fields });
  }
  mark(w, addThing(w, "sapling", px, py, { owner: a.id, stage: 0, item: x.id, born: w.t, hp: 5, maxHp: 5 }));
  fields.effect = "buried";
  return outcome({ text: `They pushed the ${x.name} into the soft ground${nearWater(w, a.x, a.y, 1) ? " near the water" : ""}.`, uses: { [x.id]: 1 }, effect: "buried", fields });
}

export function eat(w: World, a: Agent, k: string): Outcome {
  const x = w.kinds[k];
  const fields: Fields = { verb: "eat", inputs: [k], gives: [] };
  if (!x || (p(x, "edible") < 0.03 && p(x, "medicinal") < 0.3)) return outcome({ text: `The ${x?.name ?? "thing"} isn't food.`, fields });
  if (!takeItems(a, k)) return outcome({ text: "Nothing to eat.", fields });
  a.needs.food = Math.min(100, a.needs.food + p(x, "edible") * 100);
  const sick = Math.random() < p(x, "toxic");
  if (p(x, "medicinal") >= 0.5 && a.sickness) {
    a.sickness.until -= DAY;
    a.needs.health = Math.min(100, a.needs.health + 8);
    fields.effect = "cure";
    return outcome({ ok: true, text: `Eating the ${x.name} eased their sickness.`, uses: { [k]: 1 }, effect: "cure", fields });
  }
  if (sick) {
    const sev = clamp01(p(x, "toxic") + 0.2);
    a.sickness = { until: w.t + Math.round(DAY * (0.5 + sev * 1.5)), severity: Math.max(sev, a.sickness?.severity ?? 0) };
    fields.effect = "sick";
    return outcome({ text: `Eating the ${x.name} made them sick.`, uses: { [k]: 1 }, effect: "sick", fields });
  }
  return outcome({ ok: true, text: `They ate the ${x.name}.`, uses: { [k]: 1 }, fields });
}

export function wearIt(w: World, a: Agent, act: Act): Outcome {
  const x = kind(w, act.items[0]);
  const fields: Fields = { verb: "wear", inputs: act.items.slice(0, 1), gives: [] };
  if (!x || !count(a, x.id)) return outcome({ text: "They had nothing to put on.", fields });
  if (p(x, "insulating") < 0.5 || p(x, "flexible") < 0.4) return outcome({ text: `The ${x.name} wouldn't stay on.`, fields });
  const s = a.inv.find((q) => q.k === x.id)!;
  a.inv.splice(a.inv.indexOf(s), 1);
  if (a.wearing) a.inv.push(a.wearing);
  a.wearing = s;
  fields.builds = "worn";
  return outcome({ ok: true, text: `They wrapped the ${x.name} around themselves. It kept the cold out.`, uses: { [x.id]: 1 }, builds: "worn", fields });
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
