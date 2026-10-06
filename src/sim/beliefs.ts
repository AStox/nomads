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
  // for what's done to the ground, the ground, shade, dry ground and crowding): every try and every win, however long ago
  // (noteTry; an old save's faded counts aren't whole)
  tally?: Count;
  when?: Record<string, Count>;
  // and in each mix of what held when they did it, the conditions joined by "+" ("" for none of them): the weather, and
  // for what's done to the ground the spot too. What lets them tell the dark from the rain that falls mostly at night
  // (apart), and what was different the time it worked where they thought it wouldn't (differed).
  mix?: Record<string, Count>;
  // their own theories of why it fails: each a condition they think it won't work in, or several joined by "+" that
  // together keep it from working, "!" before one for an exception ("rain+!wind": not in the rain, unless the wind is up)
  unless?: string[];
};
type Count = { tries: number; wins: number };
// A condition, as a theory names it: the weather and light anyone can see, and the ground underfoot and round about.
const WORDS: Record<string, string> = {
  rain: "in the rain", dark: "in the dark", cold: "in freezing cold", wind: "in a strong wind", nofish: "with no fish close by",
  shade: "in the shade of trees", dry: "on dry ground", crowded: "crowded in among bushes and trees",
};
const ON_GROUND: Record<string, string> = { marsh: "in a marsh", scrub: "in scrub", "forest floor": "on the forest floor", stream: "by a stream", lake: "by a lake", sea: "by the sea" };
export const groundKey = (word: string) => `ground:${word.replaceAll(" ", "_")}`;
export const groundOfKey = (c: string) => (c.startsWith("ground:") ? c.slice(7).replaceAll("_", " ") : null);
// What a lack reads as, after "unless" in a theory.
const UNLESS: Record<string, string> = {
  rain: "it's raining", dark: "it's dark", cold: "it's freezing", wind: "a strong wind is blowing", nofish: "there are no fish close by",
  shade: "it's in the shade of trees", dry: "the ground is dry", crowded: "bushes or trees grow close round it",
};
const oneWord = (c: string) => {
  const g = groundOfKey(c);
  return WORDS[c] ?? (g ? ON_GROUND[g] ?? `on ${g}` : c);
};
// A theory in words: the conditions it won't work in, together, and its exceptions ("in the rain, unless a strong wind
// is blowing").
export const conditionWords = (t: string) => {
  const parts = t.split("+"), lacks = parts.filter((c) => c.startsWith("!")).map((c) => c.slice(1));
  const unless = lacks.map((c) => UNLESS[c] ?? `it's ${oneWord(c)}`).join(" or ");
  return [parts.filter((c) => !c.startsWith("!")).map(oneWord).join(" and "), unless && `unless ${unless}`].filter(Boolean).join(", ");
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
// Whether a theory holds in conditions like these (now): every condition it names holds, and every lack it names (a
// condition with "!" before it) does. A theory that names one condition holds wherever that one does.
export const holds = (t: string, now: string[]) => t.split("+").every((c) => (c.startsWith("!") ? !now.includes(c.slice(1)) : now.includes(c)));
// Whether their theories of a way rule it out in conditions like these: one of them holds.
export const ruledOut = (b: Belief, now: string[]) => !!b.unless?.some((t) => holds(t, now));
// The conditions a theory names, whether as ones it won't work in or as exceptions.
export const partsOf = (t: string) => t.split("+").map((c) => c.replace(/^!/, ""));
// Whether a theory is about the spot: what they'd keep clear of when choosing where to do something to the ground.
export const ofSpot = (t: string) => partsOf(t).some(ofPlace);
// A theory from its parts, each once, in one order whichever way it was come to.
const theoryOf = (parts: string[]) => [...new Set(parts)].sort().join("+");
// The mix of the weather in what they could see (now): its conditions, joined by "+".
export const mixOf = (now: string[]) => now.filter((c) => !ofPlace(c)).sort().join("+");
// The conditions of a mix in their record, back from its key.
const condsOf = (k: string) => (k ? k.split("+") : []);
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
// What a try adds to their record of a way: all told, in each condition they did it in (now), and in the mix of all of
// them. Every try stays, however long ago: what it did a hundred tries back counts as much as what it did last time, so a
// failure isn't forgotten because it has since worked, nor a success because it has since failed, and what changes their
// mind is the whole of what they've seen. A record kept before it had mixes (an old save) starts them from what it holds;
// one kept while tries faded goes on from what it had come to; and one of what's done to the ground whose mixes held
// only the weather starts them again, since nobody can say now what spots those tries were in.
export function noteTry(b: Belief, worked: boolean, now: string[]) {
  const tally = (b.tally ??= { tries: 0, wins: 0 }), when = (b.when ??= {}), mix = (b.mix ??= mixesOf(tally, when));
  if (now.some((c) => c.startsWith("ground:"))) for (const k of Object.keys(mix)) if (!k.includes("ground:")) delete mix[k];
  for (const s of [tally, ...now.map((c) => (when[c] ??= { tries: 0, wins: 0 })), (mix[[...now].sort().join("+")] ??= { tries: 0, wins: 0 })]) {
    s.tries++;
    if (worked) s.wins++;
  }
}
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
// until tries apart tell them which. Tries where a theory of theirs about something else holds are set aside: to someone
// who blames the rain, a spark dying in the rain at night says nothing about the dark. most: the mix of the other
// weather, seen both ways, that tells the most; mixes: their record by the weather, as it was weighed. For the spot, all
// told.
export function apart(b: Belief, c: string): { diff: number; se: number; tries: number; wins: number; most?: string; mixes?: Record<string, Count> } {
  if (ofPlace(c) || !b.mix) return allTold(b, c);
  // their record by the mix of the weather alone, whatever the spot
  const mix: Record<string, Count> = {};
  for (const [k, s] of Object.entries(b.mix)) {
    const now = condsOf(k);
    if (b.unless?.some((t) => !partsOf(t).includes(c) && holds(t, now))) continue;
    const m = (mix[mixOf(now)] ??= { tries: 0, wins: 0 });
    m.tries += s.tries;
    m.wins += s.wins;
  }
  const inn = { tries: 0, wins: 0 }, out = { tries: 0, wins: 0 };
  for (const [k, s] of Object.entries(mix)) {
    const t = condsOf(k).includes(c) ? inn : out;
    t.tries += s.tries;
    t.wins += s.wins;
  }
  if (!inn.tries || !out.tries) return told(inn, { tries: inn.tries + out.tries, wins: inn.wins + out.wins });
  let weight = 0, diff = 0, v = 0, most: string | undefined, best = 0;
  for (const [k, s] of Object.entries(mix)) {
    const conds = condsOf(k);
    if (!conds.includes(c) || !s.tries) continue;
    const others = conds.filter((x) => x !== c).join("+"), o = mix[others];
    const n0 = (o?.tries ?? 0) + THIN, w0 = (o?.wins ?? 0) + (THIN * out.wins) / out.tries;
    const wt = (s.tries * n0) / (s.tries + n0), q = (s.wins + w0 + 1) / (s.tries + n0 + 2);
    weight += wt;
    diff += wt * (w0 / n0 - s.wins / s.tries);
    v += wt * q * (1 - q);
    if (o?.tries && wt > best) { best = wt; most = others; }
  }
  return { diff: diff / weight, se: Math.sqrt(v) / weight, tries: inn.tries, wins: inn.wins, most, mixes: mix };
}
// Whether it has done worse for them in a condition than out of it by more than chance would make it: it has failed
// them there more than once (a hair more, so an old save's faded counts that sum to one failure and a rounding error
// aren't two), and by more than a standard error of the difference, from their own counts (apart). A few failures in
// the dark among many plantings aren't that.
export function worseIn(b: Belief, c: string) {
  const d = apart(b, c);
  return d.tries - d.wins > 1 + 1e-9 && d.diff > d.se;
}
// The conditions a failure in these (now) sets them suspecting, of those they don't blame yet, alone or as part of a
// theory that holds here (to someone who thinks it won't work in the rain unless the wind is up, a spark dying in the
// calm rain is the rain's): what it has done worse in for them than chance would make it (worseIn), or what they saw of
// the failure points at (points: the tinder too damp to catch) where it has done no better than without it, like for
// like, unless a theory of theirs about the weather holds here, which like for like sets aside: then all told, this try
// with it.
export function suspected(b: Belief, now: string[], points: (c: string) => boolean) {
  const here = b.unless?.filter((t) => holds(t, now)) ?? [], aside = here.some((t) => !ofSpot(t));
  const blames = (c: string) => !!b.unless?.includes(c) || here.some((t) => t.split("+").includes(c));
  return now.filter((c) => !blames(c) && (worseIn(b, c) || (points(c) && (aside ? allTold(b, c) : apart(b, c)).diff >= 0)));
}
// How much worse it has done for them where a theory holds than where it doesn't: for one condition, like for like
// (apart); for a theory of several parts, all told, the tries where another theory of theirs holds set aside.
function bears(b: Belief, t: string) {
  if (!t.includes("+") && !t.startsWith("!")) return apart(b, t);
  const others = b.unless?.filter((o) => o !== t) ?? [], inn = { tries: 0, wins: 0 }, all = { tries: 0, wins: 0 };
  for (const [k, s] of Object.entries(b.mix ?? {})) {
    const now = condsOf(k);
    if (others.some((o) => holds(o, now))) continue;
    for (const x of holds(t, now) ? [inn, all] : [all]) {
      x.tries += s.tries;
      x.wins += s.wins;
    }
  }
  return told(inn, all);
}
// How much a theory rests on, for which of theirs they'd put to the test and how readily: the tries where it holds by
// how much worse it has done there than where it doesn't (bears).
export function restsOn(b: Belief, t: string) {
  const d = bears(b, t);
  return d.tries * Math.max(0, d.diff);
}
// Whether their record has come to tell against a theory: over three or more tries where it holds it has worked at
// least once, and about as often as where it doesn't (within 10 points), like for like where it can be (bears). A spark
// that never once caught in the rain says the theory is right, however rarely it catches anywhere. (An old save's faded
// counts go by what they round to: 2.5 tries is three.)
export function fades(b: Belief, t: string) {
  const d = bears(b, t);
  return d.tries >= 2.5 && d.wins >= 0.5 && d.diff <= 0.1;
}
// The mixes of their record a theory holds in, each with what held: the failures there it rests on, only where no
// other theory of theirs holds (a spark dying in the rain at night is the rain's, to someone who blames it, not the
// dark's), and every try there that worked, which tells against it however many others hold too.
function under(b: Belief, t: string) {
  const others = b.unless?.filter((o) => o !== t) ?? [];
  return Object.entries(b.mix ?? {}).flatMap(([k, s]) => {
    const now = condsOf(k);
    return holds(t, now) ? [{ now, fails: others.some((o) => holds(o, now)) ? 0 : s.tries - s.wins, wins: s.wins }] : [];
  });
}
// How a theory stands with their record: the failures it rests on, and the tries that worked where it holds.
export function weighs(b: Belief, t: string) {
  const xs = under(b, t);
  return { fails: xs.reduce((s, x) => s + x.fails, 0), wins: xs.reduce((s, x) => s + x.wins, 0) };
}
// What set a try that worked (in now) apart from the failures a theory rests on, as narrower theories that wouldn't
// hold where it worked: the theory unless something that held this time ("rain+!wind": not in the rain, unless the wind
// is up), or only with something this time lacked ("dark+rain": only in the rain at night). Each with the share of the
// tries under the theory it calls right (failures where it would hold, the rest where it wouldn't); those that call at
// least three in four right, best first.
export function differed(b: Belief, t: string, now: string[]) {
  const xs = under(b, t), all = xs.reduce((s, x) => s + x.fails + x.wins, 0), named = partsOf(t);
  const conds = [...new Set([...now, ...xs.flatMap((x) => x.now)])].filter((c) => !named.includes(c));
  return conds.map((c) => {
    const part = now.includes(c) ? `!${c}` : c;
    const right = xs.reduce((s, x) => s + (holds(part, x.now) ? x.fails : x.wins), 0);
    return { theory: theoryOf([...t.split("+"), part]), part, agree: all ? right / all : 0 };
  }).filter((x) => x.agree >= 0.75).sort((x, y) => y.agree - x.agree);
}
// What a failure in these conditions (now) tells against, where no theory of theirs holds: a part of a theory but for
// which it would hold here, when where the rest of it holds and that part doesn't their record has failed at least as
// often as it worked (this failure among them), and the rest still names something it won't work in. Each as the
// theory, and what it becomes without that part.
export function refuted(b: Belief, now: string[]) {
  if (ruledOut(b, now)) return [];
  return (b.unless ?? []).flatMap((t) => {
    const parts = t.split("+"), off = parts.filter((p) => !holds(p, now)), rest = parts.filter((p) => !off.includes(p));
    if (off.length !== 1 || !rest.some((p) => !p.startsWith("!"))) return [];
    const base = rest.join("+"), others = b.unless!.filter((o) => o !== t);
    const xs = Object.entries(b.mix ?? {}).map(([k, s]) => ({ now: condsOf(k), ...s })).filter((x) => holds(base, x.now) && !holds(off[0], x.now) && !others.some((o) => holds(o, x.now)));
    const fails = xs.reduce((s, x) => s + x.tries - x.wins, 0), wins = xs.reduce((s, x) => s + x.wins, 0);
    return fails >= wins ? [{ theory: t, to: theoryOf(rest) }] : [];
  });
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
  // how long it takes them: the average of their tries, the latest counting most once there are twenty or so, so one try
  // that dragged on doesn't make it look slow for good, and as they get handier it comes to look quicker
  b.ticks = b.tries === 1 ? ticks : b.ticks + (ticks - b.ticks) / Math.min(b.tries, 20);
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

// Everyone nearby sees what happened and slowly picks it up. now: the conditions it was done in. Returns, for those who
// already knew how, the theories of theirs it was seen to work in spite of (sim.ts weighs them as it does a try of
// their own); what only shows later (a seed going into the sand) shows nothing yet, and theories never had or known from
// the start aren't weighed.
export function watchers(w: World, doer: Agent, out: Outcome, ticks: number, now: string[] = []) {
  const seen: { who: Agent; b: Belief; theories: string[] }[] = [];
  if (!useful(out)) return seen;
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
      const theories = RULES.learning === "seen" && out.ok && !out.later ? mine.unless?.filter((t) => holds(t, now)) ?? [] : [];
      if (theories.length) seen.push({ who: b, b: mine, theories });
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
  return seen;
}
// A theory they've narrowed to an exception, or widened back: the new one in place of the old, unless they hold it
// already.
export function refine(b: Belief, from: string, to: string) {
  b.unless = [...new Set((b.unless ?? []).map((t) => (t === from ? to : t)))];
}

// A theory they've given up: the conditions it named, struck off. Their record stays as it was: the failures it was
// formed on are still there, set against everything that has come since.
export function rethink(b: Belief, conds: string[]) {
  b.unless = b.unless?.filter((c) => !conds.includes(c));
  if (!b.unless?.length) delete b.unless;
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
