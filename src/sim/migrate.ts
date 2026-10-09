// A world saved before fire was a bed of pieces (docs/research/fire-constants.md sections 28 to 32), read into the new
// physics once as it loads, with no new VERSION. The old save held a campfire as hit points burnt down a tick at a time
// and anything else alight as how well it burned; the heat flames beside a thing had put into it as scorch toward
// catching; the tinder people held as wet from 0 to 1; and the ways people lit fires as tinder alone, the spark or the
// ember lighting a fire by itself. Each becomes the closest the new physics has to it, and what has been read is gone,
// so a second migration finds nothing to do. The save as it was is kept beside it first (migrateSave), so the change can
// be rolled back.
import { copyFileSync, existsSync } from "node:fs";
import { DAY, meters, type Stack, type Thing, type World } from "./world";
import { advance, alight, expose, kindle, lasts, lay, lightsIn, output, type Bed, type Coals, type Ring } from "./combustion";
import { STILL, bedAir, isBow, mark, rubbing, usual, type Fields } from "./physics";
import { PHYS, physOf, stackPhys } from "./fuel";
import { BASE, p } from "./materials";
import { WIDEST, airFor, bedOf, blazeOf, fluxOn, partsOf, reach, warmed } from "./spread";
import { DAMP, SOAKED, tinder } from "./wetness";
import { nearestThing } from "./space";
import { beliefKey, fieldsOf, sentence, testOf, type Belief } from "./beliefs";

// What an old save keeps that the new world doesn't: a fire's heat level, how well anything else burned, scorch toward
// catching, the wetness of a held thing, and the litter's.
type Old = Thing & { burning?: number; scorch?: number; heat?: number };
type OldStack = Stack & { wet?: number };
type OldWeather = World["weather"] & { litter?: number };

const TICK_S = 86400 / DAY, HOUR = 3600;
// An old fire's hours left are matched to within a tick, the world's own step: it burnt down a tick at a time, and how
// long a bed has left can't be told apart any finer than the world looks at it.
const WITHIN = TICK_S / HOUR;

// ---------- fires ----------
// The hours an old fire had left (physics.ts fireHours before this change): its hit points, burnt 1 a tick in the open,
// 0.5 ringed and 0.3 heaped over, twelve ticks to the hour.
const oldHours = (f: Thing) => (f.hp ?? 0) / (f.covered ? 0.3 : f.contained ? 0.5 : 1) / (HOUR / TICK_S);

// The usual lay (physics.ts usual) kindled and followed a tick at a time in still air (physics.ts STILL) until it goes
// out: a fire as anyone finds one, at every age it lives to. How many sticks and logs it holds hardly changes how long it
// has left (combustion.ts lasts: the longest any one burning piece or lot of coals takes, and its logs are already its
// thickest pieces), so how far it has burnt is what comes closest to the hours an old fire had left.
let ages: Bed[] | undefined;
function aged() {
  if (ages) return ages;
  ages = [];
  let b = kindle(lay(usual())!);
  for (let t = 0; t < DAY; t++) {
    b = advance(b, TICK_S, STILL);
    if (!alight(b)) break;
    ages.push(b);
  }
  return ages;
}

// The charcoal still in an old fire, burnt down with it (each piece fed counted its fuel, materials.ts BASE): so many of
// fuel.ts's charcoal pieces, glowing as coals at the heart of the bed.
function charcoalIn(f: Thing, b: Bed): Coals | undefined {
  const n = (f.charcoal ?? 0) / (BASE.charcoal.fuel ?? Infinity), c = PHYS.charcoal;
  if (!(n > 0)) return undefined;
  return { ring: Math.min(0, ...b.groups.map((g) => g.ring), ...b.coals.map((x) => x.ring)) - 1, kg: n * c.mass, d: c.d, rho: c.rho };
}
// The bed for an old fire: of the usual lay at every age, with its charcoal, the one whose hours left where the fire
// stands, as it's set up (as physics.ts fireHours reads them), come closest to the old fire's.
function bedFor(w: World, f: Thing, hours: number) {
  const air = bedAir(w, f);
  let best: { bed: Bed; hours: number } | undefined;
  for (const b of aged()) {
    const coal = charcoalIn(f, b), bed = coal ? { ...b, coals: [...b.coals, coal] } : b, h = lasts(bed, air) / HOUR;
    if (!best || Math.abs(h - hours) < Math.abs(best.hours - hours)) best = { bed, hours: h };
  }
  // the fire's own copy: the ages are shared by every old fire
  return best && { bed: { ...best.bed, groups: best.bed.groups.map((g) => ({ ...g })), coals: best.bed.coals.map((c) => ({ ...c })) }, hours: best.hours };
}

// The stone round an old fire, read as placing reads stone set round one (physics.ts): of the structure standing at the
// fire, what is hard and doesn't burn, or is clay, each as thick as its piece or its record, laid side by side, and as
// tall as the thickest.
function wallsOf(w: World, f: Thing): Ring | undefined {
  const r = nearestThing(w, f.px, f.py, ["structure"], () => true, 1);
  if (!r) return undefined;
  const rings = (k: string) => { const x = w.kinds[k]; return !!x && ((p(x, "hard") >= 0.5 && p(x, "flammable") < 0.2) || p(x, "plastic") >= 0.6); };
  const ds: number[] = [];
  for (const s of r.pieces ?? []) if (rings(s.k)) ds.push(stackPhys(w.kinds, s)?.d ?? 0);
  for (const [k, n] of Object.entries(r.parts ?? {})) {
    if (!rings(k)) continue;
    const d = physOf(w.kinds, w.kinds[k])?.d ?? 0;
    for (let i = (r.pieces ?? []).filter((s) => s.k === k).length; i < n; i++) ds.push(d);
  }
  const width = ds.reduce((t, d) => t + d, 0);
  return width > 0 ? { tall: Math.max(...ds), width } : undefined;
}

// Each old fire, its hit points and no bed, becomes a bed walled by the stone round it; its heat level and hit points go.
function fires(w: World, out: string[]) {
  let laid = 0;
  for (const f of w.things.filter((t) => t.kind === "fire")) {
    const o = f as Old;
    if (o.hp !== undefined && !f.bed) {
      const hours = oldHours(f), walls = wallsOf(w, f);
      if (walls) f.walls = walls;
      else if (f.contained) out.push(`fire ${f.id} was ringed, but no stone stands at it to wall it`);
      const best = bedFor(w, f, hours);
      if (best) {
        f.bed = best.bed;
        laid++;
      }
      if (!best || Math.abs(best.hours - hours) > WITHIN) {
        const set = f.covered ? "heaped over" : f.contained ? "ringed" : "open";
        out.push(`fire ${f.id} (${set}) had ${hours.toFixed(2)} h left by its hit points; the closest bed of the usual lay has ${best ? best.hours.toFixed(2) : "no"} h`);
      }
    }
    if (o.hp === undefined && o.maxHp === undefined && o.heat === undefined) continue;
    delete o.hp;
    delete o.maxHp;
    delete o.heat;
    mark(w, f);
  }
  if (laid) out.push(`${laid} fire${laid === 1 ? "" : "s"} laid as beds of the usual lay, as far burnt as their hours left`);
}

// ---------- things alight, and scorch ----------
// Anything else that was burning burns as a bed of its own pieces (spread.ts), all of them alight: the bed then keeps a
// flame in what can hold one. What has no pieces that burn in the new physics stops burning.
function burning(w: World, out: string[]) {
  const lit: Record<string, number> = {}, not: Record<string, number> = {};
  for (const t of w.things.filter((x) => (x as Old).burning !== undefined)) {
    const o = t as Old, was = o.burning ?? 0;
    delete o.burning;
    mark(w, t);
    if (!(was > 0) || t.bed || t.kind === "fire") continue;
    const parts = partsOf(w, t), bed = bedOf(parts, warmed(t, parts).map((g) => ({ ...g, lit: true })));
    const tally = bed ? lit : not;
    tally[t.kind] = (tally[t.kind] ?? 0) + 1;
    if (!bed) continue;
    t.bed = bed;
    delete t.absorbed;
  }
  for (const [n, words] of [[lit, "burning, now beds alight"], [not, "burning, with nothing in them that burns now, put out"]] as const) {
    if (Object.keys(n).length) out.push(`${words}: ${Object.entries(n).map(([k, c]) => `${c} ${k}`).join(", ")}`);
  }
}
// Old scorch was the share of the way to catching a thing had come, beside flames whose heat it took a tick at a time. It
// is read as the heat each of its parts would have taken toward lighting (spread.ts absorbed) over that share of the time
// the fires near it now would take to light it, as ecology.ts fire heats it (combustion.ts lightsIn and expose). A thing
// nothing near heats now would have cooled, as the new physics has things cool, and keeps none.
function scorched(w: World, out: string[]) {
  const things = w.things.filter((x) => (x as Old).scorch !== undefined);
  if (!things.length) return;
  const blazes = w.things.filter((s) => s.bed && alight(s.bed) && !s.covered).map((s) => {
    const air = bedAir(w, s);
    return { s, b: blazeOf(w, s, output(s.bed!, air), air) };
  });
  let kept = 0, cooled = 0;
  for (const x of things) {
    const o = x as Old, share = Math.min(1, Math.max(0, o.scorch ?? 0));
    delete o.scorch;
    mark(w, x);
    if (x.bed || x.absorbed) continue;
    const parts = partsOf(w, x), flux = parts.map(() => 0);
    for (const { s, b } of blazes) if (s !== x && meters(s, x) <= reach(b).heat + WIDEST) fluxOn(b, x, parts).forEach((v, i) => (flux[i] += v));
    const heat = warmed(x, parts).map((g, i) => {
      const air = airFor(w, x, parts[i]), t = lightsIn(g, flux[i], air);
      return Number.isFinite(t) ? expose(g, flux[i], share * t, air).heat : 0;
    });
    if (heat.some((v) => v > 0)) {
      x.absorbed = heat;
      kept++;
    } else cooled++;
  }
  out.push(`scorch: ${kept} kept as heat toward lighting from the fires near them, ${cooled} with nothing near to heat them dropped`);
}

// ---------- wetness ----------
// The old wetness of held tinder (wetness.ts before this change: 0 bone dry to 1 soaked through, a spark catching under
// 0.3 and an ember under 0.6) on the new physical cuts (sec. 10): linear between them, dry to DAMP, DAMP to SOAKED, and
// SOAKED to all the stuff holds, its soaking through (wetness.ts). The old cuts let through only what was drier than them
// and the new ones what is no wetter, so wetness on an old cut lands just past the new one.
const OLD_DAMP = 0.3, OLD_SOAKED = 0.6;
const past = (cut: number) => cut + Number.EPSILON;
function moistureOfWet(wet: number, mmax: number) {
  const v = Math.min(1, Math.max(0, wet)), top = Math.max(SOAKED, mmax);
  const along = (x0: number, y0: number, x1: number, y1: number) => y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
  if (v < OLD_DAMP) return along(0, 0, OLD_DAMP, DAMP);
  if (v < OLD_SOAKED) return Math.max(past(DAMP), along(OLD_DAMP, DAMP, OLD_SOAKED, SOAKED));
  return Math.max(past(SOAKED), along(OLD_SOAKED, SOAKED, 1, top));
}
// Every held, worn, stored or laid thing with the old wetness holds water by it, unless it already holds water by the new
// physics (a save made after wetness.ts began keeping it), whose own reading stands.
function wetness(w: World, out: string[]) {
  let read = 0, kept = 0;
  const each = (s: Stack) => {
    const o = s as OldStack;
    if (o.wet === undefined) return;
    if (s.m === undefined) {
      const m = moistureOfWet(o.wet, stackPhys(w.kinds, s)?.mmax ?? 0);
      if (m > 0) s.m = m;
      read++;
    } else kept++;
    delete o.wet;
  };
  for (const a of w.agents) {
    a.inv.forEach(each);
    if (a.wearing) each(a.wearing);
  }
  for (const t of w.things) {
    t.store?.forEach(each);
    t.pieces?.forEach(each);
  }
  if (read || kept) out.push(`wet: ${read} held things given water by it${kept ? `, ${kept} already holding water by the new physics kept it` : ""}`);
  const weather = w.weather as OldWeather;
  if (weather.litter === undefined) return;
  delete weather.litter;
  out.push("the old litter wetness dropped: dead stuff lying about holds the island's weather now (weather.dead)");
}

// ---------- kinds ----------
// Kinds read their physical records by base or by parts (fuel.ts physOf), a saved world's as well as a new one's: there is
// nothing to add, only which, if any, it can't read.
function kinds(w: World, out: string[]) {
  const blind = Object.values(w.kinds).filter((k) => !physOf(w.kinds, k)).map((k) => k.id);
  if (blind.length) out.push(`no physical record by base or parts for: ${blind.join(", ")}`);
}

// ---------- the ways people light fires ----------
// The usual lay's twigs, as fuel.ts pieces are kept: sticks.
const TWIGS = Array<string>(usual()[1].n).fill("stick");
// What a way of lighting lays (physics.ts sparkTick and rubTick): a strike's things besides the one struck, a rub's after
// the two rubbed.
const layOf = (f: Fields) => (f.verb === "strike" ? f.inputs.filter((_, i) => i !== f.inputs.indexOf(f.target ?? f.inputs[0])) : f.inputs.slice(2));
// A way of lighting that lit a fire in the old physics, where the spark or ember lit one by itself, but can't in the new,
// where tinder alone flares and dies (fire-constants sec. 32): a strike over tinder alone, and a rub whose ember went into
// tinder alone or into what lay about. Each becomes a lay, its key in the new order: the strike's tinder with the usual
// lay's twigs; the rub's two rubbed, then a lay of its tinder (fiber if it named none) and the sticks it rubbed, which the
// old rub burnt as its fuel. None for a key that is no such way.
function relaid(w: World, key: string): string | undefined {
  const f = fieldsOf(key), held = layOf(f), tinderOnly = held.every((k) => tinder(w.kinds[k]));
  if (f.verb === "strike") return held.length && tinderOnly ? beliefKey({ ...f, inputs: [...f.inputs, ...TWIGS].sort() }) : undefined;
  if (f.verb !== "rub") return undefined;
  const [a, b] = f.inputs, A = w.kinds[a], B = w.kinds[b];
  if (!A || !B || rubbing(A, B).does !== "friction" || !tinderOnly) return undefined;
  const fuel = [a, b].filter((k) => !isBow(w.kinds[k]));
  return beliefKey({ ...f, inputs: [a, b].sort().concat([...(held.length ? held : ["fiber"]), ...fuel].sort()) });
}
// What lighting a lay uses up: the whole lay.
function usesOf(key: string) {
  const n: Record<string, number> = {};
  for (const k of layOf(fieldsOf(key))) n[k] = (n[k] ?? 0) + 1;
  return n;
}
// A way's record, kept under the old physics, says nothing of the new: it is cleared as beliefs.ts teach clears a way
// taught, and its theories of when it fails are kept.
function cleared(b: Belief, key: string, law: string | undefined): Belief {
  const nb: Belief = { ...b, key, fields: { ...b.fields, inputs: fieldsOf(key).inputs }, uses: usesOf(key), tries: 0, wins: Math.min(1, b.wins), tally: { tries: 0, wins: 0 } };
  delete nb.when;
  delete nb.mix;
  if (law) nb.law = law;
  return nb;
}

// Every fire-lighting way that lit fires (a law or a belief that built one) becomes its lay: the world's laws, each
// person's beliefs, and every plan step, test, wait and bit of watching that names it.
function lighting(w: World, out: string[]) {
  const moved = new Map<string, string>(), what = new Map<string, Record<string, number>>();
  const note = (k: string, thing: string) => { const n = what.get(k) ?? {}; n[thing] = (n[thing] ?? 0) + 1; what.set(k, n); };
  for (const [k, law] of Object.entries(w.laws)) {
    const nk = law.result?.builds === "fire" ? relaid(w, k) : undefined;
    if (!nk) continue;
    moved.set(k, nk);
    delete w.laws[k];
    w.laws[nk] ??= { ...law, key: nk, text: sentence(w, { ...fieldsOf(nk), gives: law.result?.gives ?? [], builds: "fire" }) };
    note(k, "law");
  }
  for (const a of w.agents) {
    const mine = new Map<string, string>();
    for (const [k, b] of Object.entries(a.beliefs)) {
      const nk = b.fields.builds === "fire" ? relaid(w, k) : undefined;
      if (!nk) continue;
      mine.set(k, nk);
      moved.set(k, nk);
      delete a.beliefs[k];
      note(k, "belief");
      // two old ways can come to the same lay: their theories join
      const had = a.beliefs[nk];
      if (had) had.unless = [...new Set([...(had.unless ?? []), ...(b.unless ?? [])])];
      else a.beliefs[nk] = cleared(b, nk, w.laws[nk]?.id);
    }
    for (const s of a.plan) {
      const k = s.key ?? "", nk = mine.get(k);
      if (!nk) continue;
      if (s.arg === k) s.arg = nk;
      s.key = nk;
      // what they'd do is read afresh from the way as it is now (sim.ts act)
      delete s.act;
      note(k, "plan step");
    }
    if (a.goal?.type.startsWith("test:")) {
      const [c, k] = testOf(a.goal.type), nk = mine.get(k);
      if (nk) {
        a.goal.type = `test:${c}@${nk}`;
        note(k, "test");
      }
    }
    for (const e of a.waiting ?? []) {
      const nk = mine.get(e.key);
      if (!nk) continue;
      note(e.key, "wait");
      e.key = nk;
    }
  }
  for (const a of w.agents) {
    for (const [k, v] of Object.entries(a.watching)) {
      const nk = moved.get(k);
      if (!nk) continue;
      a.watching[nk] = Math.max(a.watching[nk] ?? 0, v);
      delete a.watching[k];
      note(k, "watching");
    }
  }
  for (const [k, n] of what) out.push(`${k} is now ${moved.get(k)}: ${Object.entries(n).map(([x, c]) => `${c} ${x}${c === 1 ? "" : "s"}`).join(", ")}`);
}

// Reads an old save's world into the new physics, in place; what it changed, and what it couldn't match, for the log.
export function migrate(w: World): string[] {
  const out: string[] = [];
  fires(w, out);
  burning(w, out);
  scorched(w, out);
  wetness(w, out);
  kinds(w, out);
  lighting(w, out);
  return out;
}

// The name the save as it was before its first migration is kept under, beside it.
export const BACKUP = ".pre-fire-physics.bak";
// Loading a save: the save as it is, copied beside it before anything is migrated or saved over it, once and never
// again, so the change can be rolled back by putting it back; then the world read from it, migrated.
export function migrateSave(save: string, w: World): string[] {
  if (!existsSync(save + BACKUP)) copyFileSync(save, save + BACKUP);
  return migrate(w);
}
