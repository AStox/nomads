// What each agent thinks happens when they do something, and the laws of the world those beliefs come from.
import type { Fields, Outcome } from "./physics";
import { DAY, log, meters, stageOf, type Agent, type World } from "./world";
import { canSee } from "./light";
import { trace } from "./trace";
import { RULES } from "./rules";

export type Belief = {
  key: string;
  fields: Fields;
  uses: Record<string, number>; // what it used up
  out: Record<string, number>; // what it produced
  ticks: number; // how long it tends to take to do
  later?: number; // how long after doing it the result shows, once they've seen it come: a seed takes days to come up
  rate?: number; // damage per blow, for strikes
  tries: number;
  wins: number;
  how: "discovered" | "watched" | "taught" | "seen";
  from?: string;
  t: number;
  spurious?: string; // a kind they wrongly think they need to hold
  law?: string;
  // how it has gone for them, all told and in each condition anyone can see they did it in (rain, dark, cold, wind, and
  // for what's done to the ground, the ground, shade, dry ground and crowding): tries and wins, the latest counting most
  // (noteTry), so these are rarely whole numbers
  tally?: Count;
  when?: Record<string, Count>;
  // and in each mix of the weather they did it in, its conditions joined by "+" ("" for none of them): what lets them
  // tell the dark from the rain that falls mostly at night (apart)
  mix?: Record<string, Count>;
  unless?: string[]; // conditions they've come to think it won't work in: their own theories of why it failed
};
type Count = { tries: number; wins: number };
// A condition, as a theory names it: the weather and light anyone can see, and the ground underfoot and round about.
const WORDS: Record<string, string> = {
  rain: "in the rain", dark: "in the dark", cold: "in freezing cold", wind: "in a strong wind",
  shade: "in the shade of trees", dry: "on dry ground", crowded: "crowded in among bushes and trees",
};
const ON_GROUND: Record<string, string> = { marsh: "in a marsh", scrub: "in scrub", "forest floor": "on the forest floor", stream: "by a stream", lake: "by a lake", sea: "by the sea" };
export const groundKey = (word: string) => `ground:${word.replaceAll(" ", "_")}`;
export const groundOfKey = (c: string) => (c.startsWith("ground:") ? c.slice(7).replaceAll("_", " ") : null);
export const conditionWords = (c: string) => {
  const g = groundOfKey(c);
  return WORDS[c] ?? (g ? ON_GROUND[g] ?? `on ${g}` : c);
};
// A goal of putting a theory to the test, test:<condition>@<belief key>, as its condition and belief.
export const testOf = (type: string): [string, string] => { const rest = type.slice(5), at = rest.indexOf("@"); return [rest.slice(0, at), rest.slice(at + 1)]; };
// The rule a belief key names, back from the key: what's done, with what, to what, where.
export function fieldsOf(key: string): Fields {
  const [verb, inputs, tool, target, at, shape] = key.split("|");
  return { verb, inputs: inputs ? inputs.split("+") : [], tool: tool === "-" ? null : tool, target: target === "-" ? undefined : target, at: at === "-" ? null : at, shape: shape === "-" ? undefined : shape, gives: [] };
}
// Conditions of the spot itself rather than the hour or the weather: somewhere else, they don't hold.
export const ofPlace = (c: string) => c.startsWith("ground:") || c === "shade" || c === "dry" || c === "crowded";
// Each try they make of a way counts for a little less with every try after it (FADE of what it was each time), so
// their record of it is mostly the last twenty or so: what it used to do is forgotten once it does otherwise. All told
// and in each condition, that's the last twenty tries of it; in each mix of the weather, the last twenty in weather like
// that, however long ago, since rain by day or a still night may come only now and then. Its tries and wins all told
// (b.tries, b.wins) stay whole: what they've done in their life.
export const FADE = 0.95;
// The mix of the weather in what they could see (now): its conditions, joined by "+".
export const mixOf = (now: string[]) => now.filter((c) => !ofPlace(c)).sort().join("+");
// The mixes of the weather a record kept before it had them (an old save) stands for: each condition it holds on its
// own, and the rest of its tries in none of them. One that holds nothing of the weather has nothing of it to keep, and
// starts them empty, as a new record does.
function mixesOf(tally: Count, when: Record<string, Count>) {
  const weather = Object.entries(when).filter(([c]) => !ofPlace(c));
  if (!weather.length) return {};
  const rest = weather.reduce((r, [, s]) => ({ tries: Math.max(0, r.tries - s.tries), wins: Math.max(0, r.wins - s.wins) }), { ...tally });
  const cells: [string, Count][] = [...weather.map(([c, s]): [string, Count] => [c, { ...s }]), ["", rest]];
  return Object.fromEntries(cells.filter(([, s]) => s.tries > 0));
}
// What a try adds to their record of a way: all told, in each condition they did it in (now), and in the mix of the
// weather it was done in. A record kept before it had mixes (an old save) starts them from what it holds.
export function noteTry(b: Belief, worked: boolean, now: string[]) {
  const tally = (b.tally ??= { tries: 0, wins: 0 }), when = (b.when ??= {}), mix = (b.mix ??= mixesOf(tally, when));
  const cell = (mix[mixOf(now)] ??= { tries: 0, wins: 0 });
  for (const s of [tally, ...Object.values(when), cell]) { s.tries *= FADE; s.wins *= FADE; }
  for (const s of [tally, ...now.map((c) => (when[c] ??= { tries: 0, wins: 0 })), cell]) {
    s.tries++;
    if (worked) s.wins++;
  }
}
// How it has gone for them in conditions like these (now), for a condition they blame: for the weather, in this very
// mix of it; for the spot, wherever it held.
export const likeNow = (b: Belief, c: string, now: string[]) => (ofPlace(c) ? b.when?.[c] : b.mix?.[mixOf(now)]) ?? { tries: 0, wins: 0 };
// The odds of it working, by what they've seen: all told, and in a condition they did it in (null for all told).
export function odds(b: Belief, c: string | null) {
  const all = b.tally ?? { tries: b.tries, wins: b.wins };
  if (c === null) return (all.wins + 1) / (all.tries + 2);
  const s = b.when?.[c] ?? { tries: 0, wins: 0 };
  return (s.wins + 1) / (s.tries + 2);
}
// How much worse a record in a condition (inn) has done than all told (all) less it: the difference in how often each
// worked, each smoothed as if it had worked once and failed once besides, give or take what chance alone would make of
// the counts (se), pooled.
function told(inn: Count, all: Count) {
  const p = (all.wins + 1) / (all.tries + 2), out = { tries: Math.max(0, all.tries - inn.tries), wins: Math.max(0, all.wins - inn.wins) };
  return { diff: (out.wins + 1) / (out.tries + 2) - (inn.wins + 1) / (inn.tries + 2), se: Math.sqrt(p * (1 - p) * (1 / (inn.tries + 1) + 1 / (out.tries + 1))), tries: inn.tries, wins: inn.wins };
}
// How it has done in a condition against without it, all told: every try in it, whatever else was about.
const allTold = (b: Belief, c: string) => told(b.when?.[c] ?? { tries: 0, wins: 0 }, b.tally ?? { tries: b.tries, wins: b.wins });
// How many tries of their record without a condition all told stand in for a thin record of a mix without it (apart).
const THIN = 4;
// How much worse it has done for them in a condition than out of it (diff, in how often it worked), give or take what
// chance alone would make of their counts (se), and the tries and wins in the condition that rests on. For the weather
// it goes like for like: each mix of the weather with the condition in it set against the same mix without it, pooled by
// how much each can tell (Mantel and Haenszel's weights), so the dark takes no blame for the rain that falls mostly at
// night once it has been seen dark and dry. Where the mix without the condition is thin, or has never come, it's made up
// from their record without the condition all told, as if it held THIN tries of that: what it would have done there
// without the condition, as far as they can say, so a condition never seen apart from another is suspected along with it
// until tries apart tell them which. Tries in weather they already blame for something else are set aside: to someone
// who blames the rain, a spark dying in the rain at night says nothing about the dark. most: the mix of the other
// weather, seen both ways, that tells the most. For the spot, all told.
export function apart(b: Belief, c: string): { diff: number; se: number; tries: number; wins: number; most?: string } {
  if (ofPlace(c) || !b.mix) return allTold(b, c);
  const mixes = Object.entries(b.mix).filter(([k]) => !k.split("+").some((x) => x !== c && b.unless?.includes(x)));
  const inn = { tries: 0, wins: 0 }, out = { tries: 0, wins: 0 };
  for (const [k, s] of mixes) {
    const t = k.split("+").includes(c) ? inn : out;
    t.tries += s.tries;
    t.wins += s.wins;
  }
  if (!inn.tries || !out.tries) return told(inn, { tries: inn.tries + out.tries, wins: inn.wins + out.wins });
  let weight = 0, diff = 0, v = 0, most: string | undefined, best = 0;
  for (const [k, s] of mixes) {
    const conds = k.split("+");
    if (!conds.includes(c) || !s.tries) continue;
    const others = conds.filter((x) => x !== c).join("+"), o = b.mix[others];
    const n0 = (o?.tries ?? 0) + THIN, w0 = (o?.wins ?? 0) + (THIN * out.wins) / out.tries;
    const wt = (s.tries * n0) / (s.tries + n0), q = (s.wins + w0 + 1) / (s.tries + n0 + 2);
    weight += wt;
    diff += wt * (w0 / n0 - s.wins / s.tries);
    v += wt * q * (1 - q);
    if (o?.tries && wt > best) { best = wt; most = others; }
  }
  return { diff: diff / weight, se: Math.sqrt(v) / weight, tries: inn.tries, wins: inn.wins, most };
}
// Whether it has done worse for them in a condition than out of it by more than chance would make it: it has failed
// them there more than once (a hair more, so faded counts that sum to one failure and a rounding error aren't two), and
// by more than a standard error of the difference, from their own counts (apart). A few failures in the dark among many
// plantings aren't that.
export function worseIn(b: Belief, c: string) {
  const d = apart(b, c);
  return d.tries - d.wins > 1 + 1e-9 && d.diff > d.se;
}
// The conditions a failure in these (now) sets them suspecting, of those they don't blame yet: what it has done worse in
// for them than chance would make it (worseIn), or what they saw of the failure points at (points: the tinder too damp
// to catch) where it has done no better than without it, like for like, unless the try was in weather they blame for
// something else, which like for like sets aside: then all told, this try with it.
export function suspected(b: Belief, now: string[], points: (c: string) => boolean) {
  const aside = mixOf(now).split("+").some((x) => b.unless?.includes(x));
  return now.filter((c) => !b.unless?.includes(c) && (worseIn(b, c) || (points(c) && (aside ? allTold(b, c) : apart(b, c)).diff >= 0)));
}
// How much a theory that it won't work in a condition rests on, for which of theirs they'd put to the test and how
// readily: the tries there by how much worse it has done there than without it, like for like (apart).
export function restsOn(b: Belief, c: string) {
  const d = apart(b, c);
  return d.tries * Math.max(0, d.diff);
}
// Whether their record has come to tell against a theory that it won't work in a condition: over three or more tries
// there it has worked at least once, and about as often as out of it (within 10 points), like for like where it can
// be (apart). A spark that never once caught in the rain says the theory is right, however rarely it catches anywhere.
// (Counts that have faded go by what they round to: 2.5 tries is three.)
export function fades(b: Belief, c: string) {
  const d = apart(b, c);
  return d.tries >= 2.5 && d.wins >= 0.5 && d.diff <= 0.1;
}
// How likely it is to work for them now, by their own record: its odds all told (or, for what's done to the ground, on
// the ground they'd do it on), or in a condition they're in, if it has done worse for them there than chance would make
// it (worseIn: a few unlucky tries in the dark don't make one way look worse than another), whichever is worst; and some
// hope besides for what they've hardly tried (all told, or on that ground), which is what gets it tried, and new ground
// tried for it.
export function chance(b: Belief, now: string[] = [], ground?: string) {
  let p = odds(b, ground ?? null);
  for (const c of now) if (c !== ground && worseIn(b, c)) p = Math.min(p, odds(b, c));
  const tries = ground ? b.when?.[ground]?.tries ?? 0 : b.tally?.tries ?? b.tries;
  return Math.min(1, p + 0.3 / Math.sqrt(tries + 1));
}

// Whether what was meant to come of doing it came of it: what it builds, if it builds anything, and what it gives, if it
// gives anything. A strike that only chips the stone has lit no fire, whatever else it did.
export const cameOff = (b: Belief, out: Outcome) =>
  out.ok && (!b.fields.builds || out.fields.builds === b.fields.builds) && (!Object.keys(b.out).length || Object.keys(b.out).some((k) => (out.gives[k] ?? 0) > 0));

export const beliefKey = (f: Fields) =>
  [f.verb, f.inputs.join("+"), f.tool ?? "-", f.target ?? "-", f.at ?? "-", f.shape ?? "-"].join("|");

const nm = (w: World, id: string) => w.kinds[id]?.name ?? id.replaceAll("_", " ");
const an = (s: string) => (s.includes("'s ") ? s : /^[aeiou]/.test(s) ? `an ${s}` : `a ${s}`);
const with_ = (w: World, tool?: string | null) => (tool ? `with ${an(nm(w, tool))}` : "with bare hands");
const gives = (w: World, f: Fields) => f.gives.map((k) => nm(w, k)).join(" and ");

// How long after, in words: a seed takes days to come up.
const laterWords = (t: number) => (t < DAY / 2 ? "some hours later" : t < DAY * 1.5 ? "about a day later" : `about ${Math.round(t / DAY)} days later`);
const THING_WORD: Record<string, string> = { sapling: "young plant" };
// later: how long after the result shows, for what they've seen come of it in time
export function sentence(w: World, f: Fields, ticks?: number, later?: number): string {
  const time = ticks && ticks > 12 ? ` (about ${Math.max(1, Math.round((ticks * 5) / 60))} hours)` : "";
  const ins = f.inputs.map((k) => nm(w, k));
  const fireWord = ({ hearth: "a ringed fire", kiln: "a ringed fire heaped over with stone", forge: "a ringed charcoal fire" } as Record<string, string>)[f.at ?? ""] ?? "a fire";
  switch (f.verb) {
    case "strike":
      if (f.builds === "fire") return `Striking ${an(nm(w, f.target ?? "stone"))} ${with_(w, f.tool)} over dry tinder can throw a spark that lights a fire.`;
      if (f.effect === "dented") return `Hammering cold ${ins[0]} only dents it.`;
      if (f.at === "forge" && f.gives.length) return `Hammering ${an(ins[0])} ${with_(w, f.tool)} at ${fireWord} draws it out into ${an(gives(w, f))}.`;
      if (f.target && !f.inputs.length)
        return f.gives.length ? `Striking ${an(f.target)} ${with_(w, f.tool)} breaks it into ${gives(w, f)}${time}.` : `Striking ${an(f.target)} ${with_(w, f.tool)} barely marks it.`;
      return f.gives.length ? `Striking ${an(ins[0])} ${with_(w, f.tool)} can break off ${gives(w, f)}.` : `Striking ${an(ins[0])} ${with_(w, f.tool)} does nothing much.`;
    case "rub":
      if (f.builds === "fire") return `Rubbing ${ins.filter((x, i) => i < 2).map(an).join(" against ")} gets hot enough to light ${ins[2] ? `the ${ins[2]}` : "tinder"}. Fire.`;
      if (f.effect === "heat") return `Rubbing ${an(ins[0])} against ${an(ins[1] ?? ins[0])} makes them hot.`;
      return f.gives.length ? `Rubbing ${an(ins[0])} on ${an(ins[1] ?? ins[0])} makes ${an(gives(w, f))}.` : `Rubbing ${ins.join(" on ")} does nothing much.`;
    case "join":
      return f.gives.length ? `Binding ${ins.join(", ")} together makes ${an(gives(w, f))}.` : `${ins.join(" and ")} won't hold together.`;
    case "heat":
      if (f.effect === "burned") return `${ins[0][0].toUpperCase() + ins[0].slice(1)} burns away in a fire.`;
      if (f.effect === "too_cool") return `${fireWord[0].toUpperCase() + fireWord.slice(1)} isn't hot enough to change ${ins.join(" or ")}.`;
      if (f.effect === "scorched") return `An open fire only scorches ${ins[0]}.`;
      return f.gives.length ? `Holding ${ins.join(" and ")} in ${fireWord}${f.tool ? `, blowing air at it with ${an(nm(w, f.tool))},` : ""} makes ${an(gives(w, f))}.` : `Fire doesn't change ${ins.join(" or ")}.`;
    case "wet":
      if (f.effect === "nibble") return `Something in the water tugs at ${an(ins[0])} dangled in it.`;
      if (f.gives[0]?.startsWith("full:")) return `Dipping ${an(ins[0])} in the water fills it.`;
      return f.gives.length ? `Dipping ${an(ins[0])} in the water ${f.gives.includes("fish") ? "can catch a fish" : `gives ${gives(w, f)}`}.` : `Water does nothing to ${ins[0]}.`;
    case "pour": {
      if (!f.target) return `Pouring out ${an(ins[0])} soaks the ground.`;
      const onto = an(THING_WORD[f.target] ?? f.target.replaceAll("_", " "));
      return later ? `Pouring ${an(ins[0])} over ${onto} helps it grow.` : `Pouring ${an(ins[0])} over ${onto} soaks the ground round it.`;
    }
    case "shape":
      return `Pressing ${ins[0]} into a ${f.shape} makes ${an(gives(w, f))}.`;
    case "place":
      if (f.builds === "fire") {
        // the flame by what it is, whatever people have come to call it
        const flame = f.inputs.find((k) => k.startsWith("burning:")) ?? f.inputs[0];
        return `Setting ${an(nm(w, flame))} into ${f.inputs.filter((k) => k !== flame).map((k) => nm(w, k)).join(" and ") || "a fire"} starts a campfire.`;
      }
      if (f.builds === "fed_fire") return `Feeding ${ins.join(" and ")} to a fire keeps it going.`;
      if (f.builds === "hearth") return `Ringing a fire with ${ins.join(" and ")} keeps it contained and burning steady.`;
      if (f.builds === "kiln") return `Heaping ${ins.join(" and ")} over a ringed fire closes it in to smolder.`;
      if (f.builds === "forge") return `Feeding ${ins.join(" and ")} to a ringed fire makes it burn white-hot.`;
      if (f.builds === "shelter") return f.at === "home" ? `Building ${ins.join(", ")} into the shelter they have makes it bigger or better.` : `Leaning and stacking ${ins.join(", ")} makes a shelter.`;
      return `Stacking ${ins.join(", ")} makes a pile.`;
    case "plant":
      return f.builds ? `${an(ins[0])[0].toUpperCase() + an(ins[0]).slice(1)} pushed into the ground grows into ${f.builds === "grass" ? "grass that bears grain" : `a ${f.builds}`}${later ? `, ${laterWords(later)}` : ""}.` : `They pushed ${an(ins[0])} into the ground.`;
    case "eat":
      if (f.effect === "sick") return `Eating ${ins[0]} can make you sick.`;
      if (f.effect === "cure") return `Eating ${ins[0]} helps when you're sick.`;
      return `${ins[0]} is good to eat.`;
    case "wear":
      return `Wearing ${ins[0]} keeps the cold out.`;
    case "dig":
      return `Digging ${with_(w, f.tool)} makes a deep pit.`;
    case "throw": {
      const how = f.tool ? `Shooting ${an(ins[0])} from ${an(nm(w, f.tool))}` : `Throwing ${an(ins[0])}`;
      return f.gives.length ? `${how} at ${an(f.target ?? "animal")} can bring it down.` : `${how} at ${an(f.target ?? "animal")} can wound it.`;
    }
  }
  return `${f.verb} ${ins.join(", ")}`;
}
export const beliefText = (w: World, b: Belief) =>
  sentence(w, b.fields, b.ticks, b.later) + (b.spurious ? ` They're convinced it only works if they hold ${an(nm(w, b.spurious))}.` : "")
  + (b.unless?.length ? ` They think it won't work ${b.unless.map(conditionWords).join(" or ")}.` : "");

// Useful enough to remember: it made something, built something, or had a clear effect.
const useful = (o: Outcome) => o.ok || !!o.effect || !!o.fields.gives.length || (!!o.fields.builds && o.fields.builds !== "pile" && o.fields.builds !== "ring");

const BUILT: Record<string, string> = { bush: "planting", worn: "clothing", cured: "a cure", pile: "", ring: "", stored: "", fed_fire: "" };
// What a new law was about, in a word or two: what it built, else what it gave.
const lawTag = (w: World, f: Fields) => (f.builds ? BUILT[f.builds] ?? f.builds.replaceAll("_", " ") : "") || (f.gives[0] ? nm(w, f.gives[0]) : undefined);
// A law of the world, the first time anyone sees it hold. later: for what only shows in time, how long it took.
export function found(w: World, a: Agent, f: Fields, ticks: number, ruled = false, newKinds: string[] = [], later?: number) {
  const key = beliefKey(f);
  const law = (w.laws[key] = { id: `L${Object.keys(w.laws).length + 1}`, key, text: sentence(w, f, ticks, later), verb: f.verb, source: ruled ? "jev" : "physics", by: a.id, t: w.t, result: { gives: f.gives, builds: f.builds, effect: f.effect, target: f.target } });
  // An invention already has its own milestone, and a second way to make the same thing isn't a new one.
  const tag = newKinds.length ? undefined : lawTag(w, f);
  log(w, "law", [a.id], a, `${a.name} found out something new about the world: ${law.text}`, tag && !w.events.some((e) => e.kind === "law" && e.tag === tag) ? tag : undefined);
  return law;
}

export function record(w: World, a: Agent, out: Outcome, ticks: number, how: Belief["how"] = "discovered", from?: Agent) {
  const f = out.fields;
  const key = beliefKey(f);
  if (!useful(out)) {
    a.tried[key] = (a.tried[key] ?? 0) + 1;
    trace("belief", "nothing", { key, text: out.text }, a.id);
    return null;
  }
  // Watchers learn from the same outcome, but only the maker made it first.
  if (how === "discovered") for (const k of out.newKinds) log(w, "invent", [a.id], a, `${a.name} made the first ${nm(w, k)} anyone has ever made.`, nm(w, k));
  // Done, with what comes of it still to show (a seed in the ground, a seedling watered): it counts as tried now, and as
  // working or not when the result shows (sim.ts came), not before.
  const pending = !!out.later;
  let law = w.laws[key];
  if (!law && out.ok && !pending) law = found(w, a, f, ticks, out.ruled, out.newKinds);
  let b = a.beliefs[key];
  const isNew = !b;
  b ??= a.beliefs[key] = { key, fields: f, uses: out.uses, out: out.gives, ticks, tries: 0, wins: 0, how, from: from?.id, t: w.t };
  // known from the start (the ceiling a world is measured against): what truly hurts it comes with it
  if (isNew && RULES.learning === "known" && RULES.truth[key]?.length) b.unless = [...RULES.truth[key]];
  // An attempt that showed nothing new doesn't unlearn what it was seen to give or build before: a seed pushed into the
  // ground today grows into a bush days from now, as one did last time.
  b.fields = { ...f, gives: f.gives.length ? f.gives : b.fields.gives, builds: f.builds ?? b.fields.builds };
  if (Object.keys(out.gives).length) b.out = out.gives;
  if (out.ok) b.uses = out.uses;
  b.tries++;
  if (out.ok && !pending) b.wins++;
  // how long it takes them: the average of their tries, the latest counting most once there are twenty or so (as with
  // their record of how it went, noteTry), so one try that dragged on doesn't make it look slow for good
  b.ticks = b.tries === 1 ? ticks : b.ticks + (ticks - b.ticks) / Math.min(b.tries, 1 / (1 - FADE));
  if (out.numbers?.rate) b.rate = out.numbers.rate;
  if (law) b.law = law.id;
  if (isNew && how === "discovered" && law && law.by !== a.id) log(w, "discover", [a.id], a, `${a.name} worked out on their own: ${sentence(w, f, ticks)}`);
  if (isNew && !pending) superstition(w, a, b);
  trace("belief", isNew ? "learned" : "reinforced", { key, how, tries: b.tries, wins: b.wins, spurious: b.spurious }, a.id);
  return b;
}

// Superstitious minds tie a success to whatever else was in their hands.
function superstition(w: World, a: Agent, b: Belief) {
  const s = a.traits.superstitious ?? 0;
  if (!s || Math.random() > s * 0.5) return;
  const used = new Set([...b.fields.inputs, b.fields.tool ?? ""]);
  const other = a.inv.find((x) => !used.has(x.k));
  if (!other) return;
  b.spurious = other.k;
  log(w, "mistaken", [a.id], a, `${a.name} is convinced it only worked because they were holding ${an(nm(w, other.k))}.`);
}

// Everyone nearby sees what happened and slowly picks it up. now: the conditions it was done in.
export function watchers(w: World, doer: Agent, out: Outcome, ticks: number, now: string[] = []) {
  if (!useful(out)) return;
  const key = beliefKey(out.fields);
  for (const b of w.agents) {
    if (b === doer || b.down > w.t || !canSee(w, b, doer, 25)) continue;
    const mine = b.beliefs[key];
    if (mine) {
      // A skeptic who sees it work without the charm drops the charm.
      if (mine.spurious && !doer.inv.some((s) => s.k === mine.spurious) && (b.traits.skeptical ?? 0) + (b.traits.observant ?? 0) > 0.3) {
        log(w, "learn", [b.id], b, `${b.name} watched ${doer.name} do it without ${an(nm(w, mine.spurious))} and realized it was never needed.`);
        delete mine.spurious;
      }
      // Whoever thinks it can't be done in the rain, and watches it done in the rain, thinks again; what only shows
      // later (a seed going into the sand) shows nothing yet. (Unless theories are never had, or known from the start.)
      const wrong = RULES.learning === "seen" && out.ok && !out.later ? mine.unless?.filter((c) => now.includes(c)) ?? [] : [];
      if (wrong.length) {
        log(w, "theory", [b.id], b, `${b.name} watched ${doer.name} do it ${wrong.map(conditionWords).join(" and ")}, and stopped thinking it couldn't be done: ${sentence(w, mine.fields)}`);
        trace("theory", "dropped", { key, conds: wrong, how: "watched" }, b.id);
        rethink(mine, wrong);
      }
      continue;
    }
    // Children soak up what the grown-ups around them do.
    const k = 0.6 * (1 + (b.traits.observant ?? 0) + (b.traits.clever ?? 0) * 0.5 + (b.traits.curious ?? 0) * 0.5) * (stageOf(w, b) === "child" ? 2 : 1);
    b.watching[key] = (b.watching[key] ?? 0) + k;
    trace("belief", "watching", { key, progress: b.watching[key], doer: doer.id }, b.id);
    if (b.watching[key] < 1) continue;
    delete b.watching[key];
    const got = record(w, b, out, ticks, "watched", doer);
    if (got) log(w, "learn", [b.id, doer.id], b, `${b.name} learned by watching ${doer.name}: ${sentence(w, out.fields, ticks)}`);
  }
}

// A theory they've given up: the conditions it named, struck off, and for the weather, what they'd counted against it
// there put down to something else: their record in each mix of the weather it was part of starts again (apart), so the
// failures it was formed on don't bring it straight back, unless the mix holds weather they still blame, which explains
// those failures and keeps its record (dropping the dark leaves the rain theory its record of dark and raining).
export function rethink(b: Belief, conds: string[]) {
  b.unless = b.unless?.filter((c) => !conds.includes(c));
  if (!b.unless?.length) delete b.unless;
  const mix = b.mix ?? {};
  for (const k of Object.keys(mix)) {
    const ks = k.split("+");
    if (ks.some((c) => conds.includes(c)) && !ks.some((c) => b.unless?.includes(c))) delete mix[k];
  }
}

export function teach(w: World, teacher: Agent, learner: Agent, key: string) {
  const b = teacher.beliefs[key];
  if (!b) return;
  // the teacher's theories of when it fails come with it, and how long it takes to show; their record of trying it doesn't:
  // untried, it looks to them as any way they've yet to try does
  learner.beliefs[key] = { ...b, fields: { ...b.fields }, unless: b.unless && [...b.unless], how: "taught", from: teacher.id, t: w.t, tries: 0, wins: Math.min(1, b.wins), tally: { tries: 0, wins: 0 }, when: undefined, mix: undefined };
  trace("belief", "taught", { key, from: teacher.id, spurious: b.spurious }, learner.id);
  if (b.unless?.length) trace("theory", "taught", { key, conds: b.unless }, learner.id);
}

// Things seen about the world that aren't someone's action: what trees break into, which berries grow. radius in meters.
export function see(w: World, center: { px: number; py: number }, key: string, text: string, radius = 70) {
  for (const a of w.agents) {
    if (a.down > w.t || meters(a, center) > radius || a.facts[key]) continue;
    a.facts[key] = text;
    trace("belief", "saw", { key, text }, a.id);
  }
}
