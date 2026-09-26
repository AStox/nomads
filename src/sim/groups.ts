// Camps notice themselves from who lives near whom. Their customs are only what they actually did the last time.
import {
  DAY, H, RESPONSES, Tile, W, clock, dist, log, stageOf, tileAt,
  type Agent, type Camp, type Custom, type Incident, type Precedent, type Response, type Thing, type World,
} from "./world";
import { p } from "./materials";
import { changed, count, giveItems, homeOf, nearFire, stash, takeItems, unstash } from "./physics";
import { describeRel, judge, nameCamp } from "./brain";
import { trace } from "./trace";

const LINK = 8; // homes this close, between people who don't dislike each other, make neighbors
const WATCH = DAY * 3; // how long people are watched to see whether they go along with a ruling
const EXILE = DAY * 10;
const HARM: Record<string, true> = { take: true, steal: true, raid: true, attack: true, insult: true, lie: true, refused_food: true, burned_home: true, trapped: true, last_deer: true, took_from_store: true };
const HOSTILE: Record<string, true> = { take: true, steal: true, raid: true, attack: true, insult: true };

export const groupsChanged = { now: true };
const agentOf = (w: World, id?: string) => (id ? w.agents.find((a) => a.id === id) : undefined);
const nameOf = (w: World, id?: string) => (id ? w.people[id]?.name ?? id : "someone");
const names = (w: World, ids: string[]) => ids.map((id) => nameOf(w, id));
const listed = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const r2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
export const liveCamps = (w: World) => w.camps.filter((c) => !c.gone);
export const campOf = (w: World, id: string) => w.camps.find((c) => !c.gone && c.members.includes(id)) ?? null;

// ---------- camps ----------
export function cluster(w: World) {
  const homes = new Map<string, Thing>();
  for (const a of w.agents) { const h = homeOf(w, a); if (h) homes.set(a.id, h); }
  const ids = [...homes.keys()];
  const root = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => { const r = root.get(x)!; if (r === x) return x; const top = find(r); root.set(x, top); return top; };
  const barred = (x: string, y: string) => liveCamps(w).some((c) => ((c.exiled[x]?.until ?? 0) > w.t && c.members.includes(y)) || ((c.exiled[y]?.until ?? 0) > w.t && c.members.includes(x)));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = agentOf(w, ids[i])!, b = agentOf(w, ids[j])!;
      if (dist(homes.get(a.id)!, homes.get(b.id)!) > LINK) continue;
      if ((a.rel[b.id]?.affinity ?? 0) <= 0.1 || (b.rel[a.id]?.affinity ?? 0) <= 0.1 || barred(a.id, b.id)) continue;
      root.set(find(a.id), find(b.id));
    }
  const byRoot = new Map<string, string[]>();
  for (const id of ids) (byRoot.get(find(id)) ?? byRoot.set(find(id), []).get(find(id))!).push(id);
  const comps = [...byRoot.values()].filter((c) => c.length >= 3);
  // A camp keeps its identity through whoever is still in it: the biggest overlap keeps the name.
  const old = liveCamps(w);
  const pairs = comps.flatMap((c, ci) => old.map((camp) => ({ ci, camp, n: c.filter((id) => camp.members.includes(id)).length }))).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
  const taken = new Map<number, Camp>(), used = new Set<Camp>();
  for (const pr of pairs) if (!taken.has(pr.ci) && !used.has(pr.camp)) { taken.set(pr.ci, pr.camp); used.add(pr.camp); }
  trace("group", "cluster", { housed: ids.length, clusters: comps, kept: [...taken.entries()].map(([ci, c]) => [ci, c.id]) });
  comps.forEach((members, ci) => {
    const camp = taken.get(ci);
    if (camp) regroup(w, camp, members, homes);
    else found(w, members, homes, pairs.find((x) => x.ci === ci)?.camp);
  });
  for (const camp of old) {
    if (used.has(camp)) continue;
    const into = [...taken.values()].find((c) => camp.members.some((id) => c.members.includes(id)));
    camp.gone = w.t;
    groupsChanged.now = true;
    if (into) {
      camp.mergedInto = into.id;
      into.precedents = [...into.precedents, ...camp.precedents].sort((x, y) => x.t - y.t).slice(-80);
      for (const c of camp.customs) if (!c.faded && !into.customs.some((d) => !d.faded && d.key === c.key)) into.customs.push(c);
      log(w, "camp_change", into.members, into, `${camp.name} and ${into.name} have grown into one camp, ${into.name}.`);
    } else log(w, "camp_change", camp.members.filter((id) => agentOf(w, id)), camp, `${camp.name} broke up. Its people no longer live close enough, or get along well enough, to call it a camp.`);
    trace("group", "gone", { camp: camp.id, into: into?.id });
  }
  for (const camp of liveCamps(w)) {
    for (const [id, ex] of Object.entries(camp.exiled)) {
      if (ex.until <= w.t) { delete camp.exiled[id]; continue; }
      // Someone driven out can't keep a home inside the camp.
      const a = agentOf(w, id), h = a && homeOf(w, a);
      if (!a || !h || !camp.members.some((m) => homes.get(m) && dist(homes.get(m)!, h) <= LINK)) continue;
      delete h.owner; a.home = null; changed.add(h.id);
      log(w, "driven_out", [a.id], h, `${a.name} tried to keep a home too close to ${camp.name}, and it was taken from them.`, `${a.name} lost their home`);
      const p = camp.precedents.find((x) => x.id === ex.precedent);
      if (p && !p.defied.includes(a.id)) { p.defied.push(a.id); trace("group", "defy", { precedent: p.id, who: a.id, how: "kept a home inside" }, a.id); }
    }
    for (const [id, s] of Object.entries(camp.shunned)) if (s.until <= w.t) delete camp.shunned[id];
    leaders(w, camp);
    if (!camp.named && w.t - camp.founded >= DAY * 10) void christen(w, camp);
  }
}

function centerOf(members: string[], homes: Map<string, Thing>) {
  const hs = members.map((id) => homes.get(id)!).filter(Boolean);
  return { x: Math.round(hs.reduce((t, h) => t + h.x, 0) / hs.length), y: Math.round(hs.reduce((t, h) => t + h.y, 0) / hs.length) };
}
function regroup(w: World, camp: Camp, members: string[], homes: Map<string, Thing>) {
  const joined = members.filter((id) => !camp.members.includes(id)), left = camp.members.filter((id) => !members.includes(id));
  Object.assign(camp, { members, ...centerOf(members, homes) });
  if (joined.length) log(w, "camp_change", [...joined, ...members], camp, `${listed(names(w, joined))} ${joined.length > 1 ? "are" : "is"} part of ${camp.name} now.`);
  if (left.length) log(w, "camp_change", left.filter((id) => agentOf(w, id)), camp, `${listed(names(w, left))} no longer ${left.length > 1 ? "live" : "lives"} as part of ${camp.name}.`);
  if (joined.length || left.length) { groupsChanged.now = true; trace("group", "regroup", { camp: camp.id, joined, left }); }
}
function found(w: World, members: string[], homes: Map<string, Thing>, parent?: Camp) {
  // Whoever settled here first gives the camp its first name.
  const founder = [...members].sort((x, y) => (homes.get(x)!.born ?? 0) - (homes.get(y)!.born ?? 0)).find((id) => stageOf(w, agentOf(w, id)!) !== "child") ?? members[0];
  const at = centerOf(members, homes);
  const camp: Camp = {
    id: `C${w.nextId++}`, name: `${nameOf(w, founder)}'s camp ${landmark(w, at.x, at.y)}`, named: false, founder, founded: w.t, members, ...at,
    leader: null, precedents: parent ? structuredClone(parent.precedents) : [], customs: [], shunned: {}, exiled: {}, from: parent?.id,
  };
  w.camps.push(camp);
  groupsChanged.now = true;
  const who = listed(names(w, members));
  log(w, "camp", members, at, parent
    ? `${who} split off from ${parent.name} and settled apart. People call it ${camp.name}.`
    : `${who} have settled close together. People have started calling it ${camp.name}.`, parent ? "a camp split off" : "a camp formed");
  trace("group", "found", { camp: camp.id, name: camp.name, members, founder, from: parent?.id });
}
function landmark(w: World, x: number, y: number) {
  let water = 0, rock = 0, wood = 0;
  for (let dy = -6; dy <= 6; dy++)
    for (let dx = -6; dx <= 6; dx++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const t = tileAt(w, tx, ty);
      if (t === Tile.Water) water++; else if (t === Tile.Rock) rock++; else if (t === Tile.Forest) wood++;
    }
  return water > 25 ? "by the lake" : water > 0 ? "by the water" : rock > 12 ? "under the crags" : wood > 40 ? "in the woods" : wood > 10 ? "at the wood's edge" : "on the open meadow";
}
const naming = new Set<string>();
// After a season, people settle on a lasting name for the place.
async function christen(w: World, camp: Camp) {
  const speaker = agentOf(w, camp.leader ?? camp.founder) ?? agentOf(w, camp.members[0]);
  if (!speaker || naming.has(camp.id)) return;
  naming.add(camp.id);
  try {
    const word = await nameCamp(w, speaker, {
      place: { called_for_now: camp.name, where: landmark(w, camp.x, camp.y).replace(/^\w+ the /, ""), people: names(w, camp.members) },
      what_happened_there: [
        ...camp.customs.filter((c) => !c.faded).map((c) => c.text),
        ...w.events.filter((e) => ["camp", "custom", "leader", "driven_out", "died", "born", "burned"].includes(e.kind) && dist(e, camp) <= 10).slice(-6).map((e) => e.text),
      ],
    });
    camp.named = true;
    if (!word) return;
    const title = word.split(" ").map((x) => x[0].toUpperCase() + x.slice(1)).join(" ");
    const name = w.camps.some((c) => c !== camp && c.name.endsWith(title)) ? `${nameOf(w, camp.founder)}'s ${title}` : `the ${title}`;
    log(w, "camp_named", camp.members, camp, `The people of ${camp.name} have taken to calling the place ${name}.`, name);
    trace("group", "named", { camp: camp.id, from: camp.name, to: name });
    camp.name = name;
    groupsChanged.now = true;
  } catch (e) {
    trace("group", "error", { camp: camp.id, error: String(e) });
  } finally {
    naming.delete(camp.id);
  }
}

// ---------- incidents ----------
export type Deed = { act: string; by: Agent; against?: Agent | null; at: { x: number; y: number }; text: string; value: number; seenBy: (Agent | undefined)[]; items?: string[] };
const kinOf = (a: Agent, b: Agent) =>
  a.parents.includes(b.id) || b.parents.includes(a.id) || a.parents.some((x) => b.parents.includes(x)) || a.rel[b.id]?.label === "kin";
const needOf = (a: Agent) => Math.max(0, (45 - a.needs.food) / 45, (45 - a.needs.warmth) / 45);
const scarcity = (w: World) => (w.agents.reduce((t, a) => t + Math.max(0, 1 - a.needs.food / 70), 0) / Math.max(1, w.agents.length)) + (w.weather.season === "winter" ? 0.15 : 0);

// Something one person did that landed on another. Code records what it was like; the camp decides what it meant.
export function incident(w: World, d: Deed): Incident | null {
  const seen = [...new Set(d.seenBy.filter((b): b is Agent => !!b && b.id !== d.by.id).map((b) => b.id))];
  watchDeed(w, d);
  const camps = [d.against && campOf(w, d.against.id), campOf(w, d.by.id), ...seen.map((id) => campOf(w, id))];
  const camp = camps.find((c): c is Camp => !!c && seen.some((id) => c.members.includes(id))) ?? null;
  if (!camp) { trace("group", "unseen", { act: d.act, by: d.by.id, against: d.against?.id, seen }, d.by.id); return null; }
  const inc: Incident = {
    id: `I${w.nextId++}`, t: w.t, act: d.act, by: d.by.id, against: d.against?.id, x: d.at.x, y: d.at.y, text: d.text, items: d.items,
    features: {
      against_member: !!d.against && camp.members.includes(d.against.id), against_kin: !!d.against && kinOf(d.by, d.against),
      against_child: !!d.against && stageOf(w, d.against) === "child", value: r2(d.value), need: r2(needOf(d.by)),
      season: w.weather.season, scarcity: r2(scarcity(w)), repeat: w.incidents.filter((i) => i.by === d.by.id && i.act === d.act).length, seenBy: seen,
    },
  };
  w.incidents.push(inc);
  if (w.incidents.length > 400) w.incidents.splice(0, w.incidents.length - 400);
  trace("group", "incident", { id: inc.id, act: inc.act, by: inc.by, against: inc.against, camp: camp.id, features: inc.features, text: inc.text }, d.by.id);
  judgeLater(w, camp, inc);
  return inc;
}

const pending = new Map<string, number>();
const judgedIn = new Map<number, number>();
function judgeLater(w: World, camp: Camp, inc: Incident) {
  const who = decider(w, camp, inc);
  const hour = Math.floor(w.t / 12);
  const skip = (why: string) => trace("group", "unjudged", { id: inc.id, camp: camp.id, why }, inc.by);
  if (!who) return skip("no one to decide");
  // The same thing between the same two people moments ago: that answer covers this one too.
  if (w.incidents.some((i) => i !== inc && i.group === camp.id && i.act === inc.act && i.by === inc.by && i.against === inc.against && inc.t - i.t < 24)) return skip("just answered");
  if ((judgedIn.get(hour) ?? 0) >= 4 || (pending.get(camp.id) ?? 0) >= 2) return skip("busy");
  judgedIn.set(hour, (judgedIn.get(hour) ?? 0) + 1);
  for (const h of judgedIn.keys()) if (h < hour - 2) judgedIn.delete(h);
  pending.set(camp.id, (pending.get(camp.id) ?? 0) + 1);
  inc.group = camp.id;
  judge(w, who, nameOf(w, inc.by), judgeState(w, camp, inc, who))
    .then((r) => ruled(w, camp, inc, who, r))
    .catch((e) => trace("group", "error", { id: inc.id, error: String(e) }, who.id))
    .finally(() => pending.set(camp.id, (pending.get(camp.id) ?? 1) - 1));
}
// The person hurt, or the one people bring grievances to, or whoever saw it and carries the most weight.
function decider(w: World, camp: Camp, inc: Incident): Agent | null {
  const able = (a?: Agent) => !!a && a.id !== inc.by && a.down <= w.t && stageOf(w, a) !== "child" && camp.members.includes(a.id);
  const leader = agentOf(w, camp.leader ?? undefined);
  if (leader && able(leader)) return leader;
  const victim = agentOf(w, inc.against);
  if (HARM[inc.act] && victim) {
    if (able(victim)) return victim;
    const parent = victim.parents.map((id) => agentOf(w, id)).find(able);
    if (parent) return parent;
  }
  const seen = inc.features.seenBy.map((id) => agentOf(w, id)).filter((a): a is Agent => able(a));
  return seen.sort((x, y) => standing(camp, y.id).score - standing(camp, x.id).score)[0] ?? (victim && able(victim) ? victim : null);
}

const COST = ["almost nothing", "a little", "a fair amount", "a lot", "everything they had"];
function judgeState(w: World, camp: Camp, inc: Incident, who: Agent) {
  const f = inc.features, doer = nameOf(w, inc.by), them = inc.against && nameOf(w, inc.against);
  const s = (id?: string) => { if (!id) return undefined; const x = standing(camp, id); return x.followed + x.defied ? `people went along with ${nameOf(w, id)}'s rulings ${x.followed} times and against them ${x.defied} times` : undefined; };
  const feel = (id?: string) => { const a = agentOf(w, id); if (!a || a === who) return undefined; const r = describeRel(w, who, a); return { relationship: r.relationship, feeling: r.feeling, trust: r.trust, bonds: r.bonds }; };
  const pats = patterns(camp).slice(0, 6).map(patternText);
  const customs = knownCustoms(w, who);
  return {
    camp: `${camp.name}: ${listed(names(w, camp.members))}`,
    what_happened: inc.text,
    details: {
      who_did_it: `${doer}${camp.members.includes(inc.by) ? ", who lives in the camp" : ", an outsider"}${f.need >= 0.6 ? ", and was desperate from hunger or cold" : f.need >= 0.3 ? ", and was hungry or cold" : ""}`,
      who_it_happened_to: them ? `${them}${f.against_kin ? `, ${doer}'s own kin` : ""}${f.against_child ? ", a child" : ""}${f.against_member ? ", who lives in the camp" : ", an outsider"}` : undefined,
      what_it_cost_them: HARM[inc.act] ? COST[Math.round(f.value * 4)] : undefined,
      season: f.season,
      times_are: f.scarcity >= 0.5 ? "hard for everyone" : f.scarcity >= 0.25 ? "lean" : "good",
      done_before: f.repeat ? `${doer} has been seen doing this ${f.repeat === 1 ? "once" : `${f.repeat} times`} before` : `nobody has seen ${doer} do this before`,
      seen_by: names(w, f.seenBy),
    },
    deciding: { name: who.name, bio: who.bio, traits: Object.keys(who.traits), about_the_one_who_did_it: feel(inc.by), about_the_one_it_happened_to: feel(inc.against) },
    standing: Object.fromEntries([inc.by, inc.against, who.id].filter((id): id is string => !!id && !!s(id)).map((id) => [nameOf(w, id), s(id)])),
    similar_cases_here: similar(camp, inc).map((q) => precedentLine(w, q)),
    what_happens_around_here: pats.length ? pats : undefined,
    spoken_customs: customs.length ? customs : undefined,
  };
}

function ruled(w: World, campAtAsk: Camp, inc: Incident, who: Agent, r: { response: Response; odds: Record<string, number>; comply: number }) {
  const camp = campAtAsk.gone ? w.camps.find((c) => c.id === campAtAsk.mergedInto && !c.gone) : campAtAsk;
  if (!camp) return;
  const doer = agentOf(w, inc.by), victim = agentOf(w, inc.against);
  const p: Precedent = { id: `P${w.nextId++}`, group: camp.id, incident: inc, response: r.response, decidedBy: who.id, t: w.t, followed: [], defied: [] };
  camp.precedents.push(p);
  if (camp.precedents.length > 80) camp.precedents.splice(0, camp.precedents.length - 80);
  const dn = doer?.name ?? nameOf(w, inc.by);
  let what = "let it go";
  if (r.response === "let_go" && victim && HARM[inc.act] && camp.members.includes(victim.id)) p.open = w.t + WATCH;
  if (r.response === "scold") {
    what = `scolded ${dn} in front of everyone`;
    if (doer) { doer.needs.social = Math.max(0, doer.needs.social - 10); p.open = w.t + WATCH; }
  }
  if (r.response === "repay") {
    what = `told ${dn} to make it right`;
    if (doer) {
      const ok = Math.random() < r.comply && repay(w, inc, doer, victim ?? who);
      (ok ? p.followed : p.defied).push(doer.id);
      what += ok ? `, and ${dn} did` : `, but ${dn} wouldn't`;
    }
  }
  if (r.response === "shun") {
    what = `had the camp shun ${dn} for a few days`;
    if (doer) { camp.shunned[doer.id] = { until: w.t + WATCH, precedent: p.id }; doer.needs.social = Math.max(0, doer.needs.social - 15); p.open = w.t + WATCH; }
  }
  if (r.response === "drive_out") {
    what = `drove ${dn} out of ${camp.name}`;
    if (doer) exile(w, camp, doer, p);
  }
  const verdict = `${who.name} ${what}.`;
  // Kindness that nobody objects to isn't news.
  if (r.response !== "let_go" || HARM[inc.act])
    log(w, r.response === "drive_out" ? "driven_out" : "judged", [...new Set([who.id, inc.by, ...(inc.against ? [inc.against] : [])])], inc, `${inc.text} ${verdict}`, r.response === "drive_out" ? `${dn} driven out` : undefined);
  trace("group", "judged", { precedent: p.id, incident: inc.id, act: inc.act, response: r.response, odds: r.odds, comply: r.comply, decidedBy: who.id, camp: camp.id }, who.id);
  customsAfter(w, camp, p);
  leaders(w, camp);
  groupsChanged.now = true;
}
// Give back what was taken, twice over if they have it; failing that, something of their own.
function repay(w: World, inc: Incident, doer: Agent, to: Agent) {
  const [from, dest] = HARM[inc.act] ? [doer, to] : [to, doer];
  let moved = 0;
  for (const k of inc.items ?? []) for (let i = 0; i < 2 && count(from, k) > 0; i++) { takeItems(from, k); giveItems(w, dest, k); moved++; }
  if (!moved && HARM[inc.act]) {
    const k = [...new Set(from.inv.map((s) => s.k))].sort((x, y) => p(w.kinds[y], "edible") - p(w.kinds[x], "edible"))[0];
    if (k) { takeItems(from, k); giveItems(w, dest, k); moved++; }
  }
  return moved > 0;
}
function exile(w: World, camp: Camp, doer: Agent, p: Precedent) {
  camp.members = camp.members.filter((id) => id !== doer.id);
  camp.exiled[doer.id] = { until: w.t + EXILE, precedent: p.id };
  delete camp.shunned[doer.id];
  if (camp.leader === doer.id) camp.leader = null;
  const home = homeOf(w, doer);
  if (home && dist(home, camp) <= LINK + 2) { delete home.owner; doer.home = null; changed.add(home.id); }
  doer.needs.social = Math.max(0, doer.needs.social - 25);
  doer.goal = null; doer.plan = [];
  p.open = w.t + WATCH;
}

// ---------- going along with it, or not ----------
function mark(w: World, camp: Camp, p: Precedent, id: string, how: "follow" | "defy", why: string) {
  if (p.defied.includes(id) || (how === "follow" && p.followed.includes(id))) return;
  if (how === "defy") { p.followed = p.followed.filter((x) => x !== id); p.defied.push(id); } else p.followed.push(id);
  trace("group", how, { precedent: p.id, who: id, why, camp: camp.id }, id);
  leaders(w, camp);
  groupsChanged.now = true;
}
function watchDeed(w: World, d: Deed) {
  for (const camp of liveCamps(w))
    for (const p of camp.precedents) {
      if (!p.open || p.open <= w.t) continue;
      const inc = p.incident;
      if (p.response === "scold" && d.by.id === inc.by && d.act === inc.act) mark(w, camp, p, d.by.id, "defy", "did it again");
      if (p.response === "let_go" && HOSTILE[d.act] && d.by.id === inc.against && d.against?.id === inc.by) mark(w, camp, p, d.by.id, "defy", "took revenge");
    }
}
const banOn = (w: World, camp: Camp, id: string) => { const b = camp.shunned[id] ?? camp.exiled[id]; return b && b.until > w.t ? camp.precedents.find((q) => q.id === b.precedent && q.open) : undefined; };
// Being friendly with someone the camp is shunning, or has driven out, goes against that ruling.
export function friendly(w: World, x: Agent, y: Agent) {
  for (const camp of liveCamps(w))
    for (const [a, b] of [[x, y], [y, x]]) {
      const p = camp.members.includes(a.id) && banOn(w, camp, b.id);
      if (p) mark(w, camp, p, a.id, "defy", `stayed friendly with ${b.name}`);
    }
}
// Turning away someone the camp is shunning goes along with it.
export function snubbed(w: World, member: Agent, outcast: Agent) {
  for (const camp of liveCamps(w)) {
    const p = camp.members.includes(member.id) && banOn(w, camp, outcast.id);
    if (p) mark(w, camp, p, member.id, "follow", `turned ${outcast.name} away`);
  }
}
function closeWatches(w: World) {
  for (const camp of liveCamps(w))
    for (const p of camp.precedents) {
      if (!p.open || p.open > w.t) continue;
      delete p.open;
      const inc = p.incident;
      const add = (id: string) => { if (agentOf(w, id) && !p.defied.includes(id) && !p.followed.includes(id)) p.followed.push(id); };
      if (p.response === "scold") add(inc.by);
      if (p.response === "let_go" && inc.against) add(inc.against);
      // Everyone who was around the one being shunned and kept their distance went along with it.
      if (p.response === "shun" || p.response === "drive_out") for (const id of camp.members) if (id !== inc.by && (agentOf(w, id)?.seen[inc.by] ?? -1) >= p.t) add(id);
      trace("group", "closed", { precedent: p.id, response: p.response, followed: p.followed, defied: p.defied, camp: camp.id });
      leaders(w, camp);
      groupsChanged.now = true;
    }
}

// ---------- standing and leaders ----------
// The share of someone's recent rulings that others went along with, counting every person who did or didn't.
export function standing(camp: Camp, id: string) {
  let followed = 0, defied = 0, decided = 0;
  for (const p of camp.precedents.filter((q) => q.decidedBy === id).slice(-12)) { followed += p.followed.length; defied += p.defied.length; decided++; }
  const n = followed + defied;
  return { decided, followed, defied, share: n ? followed / n : null, score: n ? (followed * followed) / n : 0 };
}
function leaders(w: World, camp: Camp) {
  const cur = camp.leader;
  const best = camp.members.filter((id) => { const a = agentOf(w, id); return a && stageOf(w, a) !== "child"; })
    .map((id) => ({ id, ...standing(camp, id) })).filter((x) => x.score >= 2 && (x.share ?? 0) >= 0.6).sort((x, y) => y.score - x.score)[0];
  const now = cur && camp.members.includes(cur) ? standing(camp, cur) : null;
  let next = cur;
  // Standing shifts slowly: one good week doesn't unseat someone people have long listened to.
  const settled = cur && w.t - (camp.leaderSince ?? 0) < DAY * 5;
  if (!now || ((now.share ?? 1) < 0.4 && (!settled || (now.share ?? 1) < 0.25))) next = best?.id ?? null;
  else if (!settled && best && best.id !== cur && (now.share ?? 1) < 0.6 && best.score > now.score * 2 + 1) next = best.id;
  if (next === cur) return;
  camp.leader = next;
  camp.leaderSince = w.t;
  const s = next ? standing(camp, next) : null;
  const text = next
    ? `People in ${camp.name} now bring their grievances to ${nameOf(w, next)}, whose word has been followed ${s!.followed} times out of ${s!.followed + s!.defied}.${cur ? ` ${nameOf(w, cur)}'s word no longer carries the camp.` : ""}`
    : `${nameOf(w, cur!)}'s word no longer carries ${camp.name}. Too many went against it.`;
  log(w, "leader", [next, cur].filter((x): x is string => !!x && !!agentOf(w, x)), camp, text, next ? `${nameOf(w, next)} leads` : "no one leads");
  trace("group", "leader", { camp: camp.id, from: cur, to: next, standing: s });
  groupsChanged.now = true;
}

// ---------- precedents, patterns, customs ----------
type Victim = "kin" | "child" | "member" | "outsider" | "none";
const victimOf = (inc: Incident): Victim => (!inc.against ? "none" : inc.features.against_kin ? "kin" : inc.features.against_child ? "child" : inc.features.against_member ? "member" : "outsider");
const VICTIM: Record<Victim, string> = { kin: "their own kin", child: "a child", member: "a neighbor", outsider: "an outsider", none: "" };
export const patternKey = (inc: Incident) => `${inc.act}|${victimOf(inc)}|${inc.features.need >= 0.5 ? "needy" : ""}`;
// [-ing phrase, "anyone who ..." phrase]
const ACTS: Record<string, (v: string) => [string, string]> = {
  take: (v) => [`Taking things from ${v}`, `takes things from ${v}`],
  steal: (v) => [`Stealing from ${v}`, `steals from ${v}`],
  raid: (v) => [`Raiding the home of ${v}`, `raids the home of ${v}`],
  attack: (v) => [`Attacking ${v}`, `attacks ${v}`],
  insult: (v) => [`Insulting ${v}`, `insults ${v}`],
  lie: (v) => [`Lying about ${v}`, `lies about ${v}`],
  refused_food: (v) => [`Refusing food to ${v}`, `refuses food to ${v}`],
  give: (v) => [`Giving things to ${v}`, `gives things to ${v}`],
  share: (v) => (v ? [`Sharing with ${v}`, `shares with ${v}`] : ["Putting food by for everyone", "puts food by for everyone"]),
  tend: (v) => [`Tending ${v}`, `tends ${v}`],
  teach: (v) => [`Teaching ${v}`, `teaches ${v}`],
  burned_home: (v) => [`Letting a fire burn down the home of ${v}`, `lets a fire burn down the home of ${v}`],
  trapped: (v) => [`Catching ${v} in a hidden pit`, `catches ${v} in a hidden pit`],
  last_deer: () => ["Killing the last deer nearby", "kills the last deer nearby"],
  took_from_store: () => ["Taking from the shared store", "takes from the shared store"],
};
const DONE: Record<Response, [string, string]> = {
  let_go: ["let go", "is let be"], scold: ["scolded", "gets a scolding"], repay: ["made to pay it back", "has to pay it back"], shun: ["shunned", "is shunned"], drive_out: ["driven out", "is driven out"],
};
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
type Pattern = { key: string; act: string; victim: Victim; needy: boolean; counts: Partial<Record<Response, number>>; n: number; last: number };
export function patterns(camp: Camp): Pattern[] {
  const m = new Map<string, Pattern>();
  for (const p of camp.precedents) {
    const key = patternKey(p.incident);
    const x = m.get(key) ?? m.set(key, { key, act: p.incident.act, victim: victimOf(p.incident), needy: p.incident.features.need >= 0.5, counts: {}, n: 0, last: 0 }).get(key)!;
    x.counts[p.response] = (x.counts[p.response] ?? 0) + 1;
    x.n++;
    x.last = Math.max(x.last, p.t);
  }
  return [...m.values()].sort((x, y) => y.n - x.n || y.last - x.last);
}
const doing = (x: { act: string; victim: Victim; needy: boolean }, i: 0 | 1) => (ACTS[x.act]?.(VICTIM[x.victim]) ?? [x.act, x.act])[i] + (x.needy ? " when desperate" : "");
export const patternText = (x: Pattern) =>
  `${doing(x, 0)}: ${Object.entries(x.counts).sort((a, b) => b[1]! - a[1]!).map(([r, n]) => `${DONE[r as Response][0]} ${times(n!)}`).join(", ")}.`;
const precedentLine = (w: World, q: Precedent) => {
  const how = q.followed.length + q.defied.length ? ` ${q.followed.length} went along with it, ${q.defied.length} didn't.` : q.open ? " People are still deciding whether to go along with it." : "";
  return `${clock(q.t)}: ${q.incident.text} ${nameOf(w, q.decidedBy)} said: ${RESPONSES[q.response].split(":")[0].toLowerCase()}.${how}`;
};
// The camp's earlier cases most like this one: same act, same kind of victim, similar need and cost.
function similar(camp: Camp, inc: Incident) {
  const f = inc.features, v = victimOf(inc);
  const score = (q: Precedent) => {
    const g = q.incident.features;
    return (q.incident.act === inc.act ? 4 : 0) + (victimOf(q.incident) === v ? 2 : 0) + (Math.abs(g.need - f.need) <= 0.25 ? 1 : 0) + (Math.abs(g.value - f.value) <= 0.25 ? 1 : 0) + (g.season === f.season ? 0.5 : 0);
  };
  return camp.precedents.map((q) => [q, score(q)] as const).filter(([, s]) => s >= 4).sort((x, y) => y[1] - x[1] || y[0].t - x[0].t).slice(0, 4).map(([q]) => q);
}
function customsAfter(w: World, camp: Camp, p: Precedent) {
  const key = patternKey(p.incident);
  for (const c of camp.customs) {
    if (c.faded || c.key !== key) continue;
    if (c.response === p.response) c.held++; else c.broken++;
    if (c.broken >= 2 && c.broken > c.held) {
      c.faded = w.t;
      log(w, "custom_faded", camp.members, camp, `In ${camp.name}, people no longer hold that "${c.text}" Too many cases went the other way.`);
      trace("group", "custom_faded", { camp: camp.id, custom: c.id, held: c.held, broken: c.broken });
    }
  }
}
// In the evening, someone by the fire may put a pattern that has always gone the same way into words.
function speak(w: World) {
  const h = ((w.t % DAY) / DAY) * 24;
  if (h < 18 || h >= 22) return;
  for (const camp of liveCamps(w)) {
    // Leaving kindness alone goes without saying; only a response worth remarking on becomes a custom.
    const pat = patterns(camp).find((x) => x.n >= 3 && Object.keys(x.counts).length === 1 && (HARM[x.act] || !x.counts.let_go) && !camp.customs.some((c) => !c.faded && c.key === x.key));
    if (!pat || Math.random() > 0.5) continue;
    const members = camp.members.map((id) => agentOf(w, id)).filter((a): a is Agent => !!a && a.down <= w.t && stageOf(w, a) !== "child");
    const company = (a: Agent, r: number) => members.filter((b) => b !== a && dist(a, b) <= r).length;
    const speakers = members.filter((a) => (nearFire(w, a, 3) && company(a, 4) >= 1) || company(a, 3) >= 2);
    const s = speakers.sort((x, y) => standing(camp, y.id).score - standing(camp, x.id).score)[0];
    if (!s) continue;
    const response = Object.keys(pat.counts)[0] as Response;
    const c: Custom = { id: `K${w.nextId++}`, key: pat.key, text: `Here, anyone who ${doing(pat, 1)} ${DONE[response][1]}.`, response, spokenBy: s.id, t: w.t, held: pat.n, broken: 0 };
    camp.customs.push(c);
    for (const b of w.agents) if (dist(b, s) <= 5) b.customs[c.id] = w.t;
    log(w, "custom", [s.id, ...camp.members.filter((id) => id !== s.id)], s, `${s.name} said${nearFire(w, s, 3) ? " by the fire" : ""}: "${c.text}" It has become a custom of ${camp.name}.`, `${doing(pat, 0)}: ${DONE[response][0]}`);
    trace("group", "custom", { camp: camp.id, custom: c, by: s.id }, s.id);
    groupsChanged.now = true;
  }
}
// Spoken customs pass along with talk and teaching.
export function spread(w: World, from: Agent, to: Agent) {
  const heard = Object.keys(from.customs).filter((id) => !to.customs[id]);
  for (const id of heard) to.customs[id] = w.t;
  if (heard.length) trace("group", "heard", { from: from.id, customs: heard }, to.id);
}
const allCustoms = (w: World) => w.camps.flatMap((c) => c.customs.map((k) => ({ camp: c, k })));
export const knownCustoms = (w: World, a: Agent) =>
  allCustoms(w).filter(({ k }) => a.customs[k.id] && !k.faded).map(({ camp, k }) => `${k.text.replace(/^Here/, `In ${camp.name}`)}`);

// ---------- the shared store ----------
export function sharedStore(w: World, a: Agent) {
  const c = campOf(w, a.id);
  return (c?.store && w.things.find((t) => t.id === c.store && t.kind === "structure" && t.shared === c.id)) || null;
}
// Setting food or goods into a shelter as the camp's makes it the camp's store.
export function share(w: World, a: Agent) {
  const camp = campOf(w, a.id);
  const store = sharedStore(w, a), home = homeOf(w, a);
  const at = store && dist(a, store) <= 1 ? store : home && dist(a, home) <= 1 ? home : null;
  if (!camp || !at) return 0;
  const n = stash(w, a, 2, at);
  if (!n) return 0;
  at.shared = camp.id; camp.store = at.id;
  at.given ??= {};
  at.given[a.id] = (at.given[a.id] ?? 0) + n;
  groupsChanged.now = true;
  const text = `${a.name} set ${n} things into ${at.owner === a.id ? "their home" : `${nameOf(w, at.owner)}'s home`} for all of ${camp.name} to share.`;
  log(w, "shared_store", [a.id], at, text);
  incident(w, { act: "share", by: a, at, text, value: Math.min(1, n / 8), seenBy: w.agents.filter((b) => dist(b, a) <= 6) });
  return n;
}
export function takeShared(w: World, a: Agent, k: string) {
  const store = sharedStore(w, a);
  if (!store || dist(a, store) > 1) return 0;
  const before = store.store?.length ?? 0;
  const got = unstash(w, a, store, k, 3);
  if (!got) return 0;
  store.given ??= {};
  const net = (store.given[a.id] ?? 0) - got;
  store.given[a.id] = net;
  const text = `${a.name} took ${got} ${w.kinds[k]?.name ?? k} from the camp's store${net < 0 ? `, having put in less than they took` : ""}.`;
  incident(w, { act: "took_from_store", by: a, against: agentOf(w, store.owner) ?? null, at: store, text, value: got / Math.max(1, before), seenBy: w.agents.filter((b) => b !== a && dist(b, a) <= 6), items: Array(got).fill(k) });
  return got;
}

// ---------- what people know, and what the debug view shows ----------
export function campView(w: World, a: Agent) {
  const out: Record<string, unknown> = {};
  const camp = campOf(w, a.id);
  if (camp) {
    out.camp = `${a.name} lives in ${camp.name}, with ${listed(names(w, camp.members.filter((id) => id !== a.id)))}`;
    if (camp.leader) out.who_leads = camp.leader === a.id ? `People bring their grievances to ${a.name}, and their word is usually followed` : `People bring their grievances to ${nameOf(w, camp.leader)}`;
    const s = standing(camp, a.id);
    if (s.followed + s.defied) out.their_word = `Others went along with ${a.name}'s rulings ${times(s.followed)} and went against them ${times(s.defied)}`;
    const pats = patterns(camp).slice(0, 6).map(patternText);
    if (pats.length) out.what_happens_around_here = pats;
    const bans = [...Object.entries(camp.shunned).map(([id, b]) => [id, b, "shunned"] as const), ...Object.entries(camp.exiled).map(([id, b]) => [id, b, "driven out"] as const)]
      .filter(([id, b]) => b.until > w.t && id !== a.id).map(([id, b, how]) => `${nameOf(w, id)}, ${how} until ${clock(b.until)}`);
    if (bans.length) out.the_camp_is_keeping_away_from = bans;
  }
  const mine = liveCamps(w).flatMap((c) => [
    (c.shunned[a.id]?.until ?? 0) > w.t ? `${a.name} is being shunned by ${c.name} until ${clock(c.shunned[a.id].until)}` : null,
    (c.exiled[a.id]?.until ?? 0) > w.t ? `${a.name} was driven out of ${c.name} and may not keep a home there until ${clock(c.exiled[a.id].until)}` : null,
  ]).filter(Boolean);
  if (mine.length) out.how_others_treat_them = mine;
  const customs = knownCustoms(w, a);
  if (customs.length) out.customs_they_know = customs;
  return out;
}
// How `a`'s camp stands with `b`, in a few words, for the list of people they see.
export function campTag(w: World, a: Agent, b: Agent) {
  const mine = campOf(w, a.id), theirs = campOf(w, b.id);
  const ban = mine && ((mine.shunned[b.id]?.until ?? 0) > w.t ? "shunned by your camp" : (mine.exiled[b.id]?.until ?? 0) > w.t ? "driven out of your camp" : null);
  return ban ?? (theirs && theirs === mine ? "lives in your camp" : theirs ? `lives in ${theirs.name}` : undefined);
}
export function campSummary(w: World) {
  return liveCamps(w).map((c) => ({
    id: c.id, name: c.name, members: c.members, leader: c.leader, x: c.x, y: c.y, store: c.store,
    homes: c.members.map((id) => { const a = agentOf(w, id), h = a && homeOf(w, a); return h ? [h.x, h.y] : null; }).filter(Boolean),
  }));
}
export function groupsDetail(w: World) {
  const view = (c: Camp) => {
    const store = c.store ? w.things.find((t) => t.id === c.store) : undefined;
    const items: Record<string, number> = {};
    for (const s of store?.store ?? []) items[s.k] = (items[s.k] ?? 0) + 1;
    return {
      ...c,
      standing: Object.fromEntries([...new Set([...c.members, ...c.precedents.map((p) => p.decidedBy)])].map((id) => [id, standing(c, id)])),
      patterns: patterns(c).map((x) => ({ ...x, text: patternText(x) })),
      precedents: c.precedents.map((q) => ({ ...q, victim: victimOf(q.incident) })),
      store: store ? { id: store.id, x: store.x, y: store.y, owner: store.owner, items, given: store.given ?? {} } : null,
    };
  };
  return { camps: w.camps.map(view), incidents: w.incidents.slice(-80) };
}

export function groups(w: World) {
  if (w.t % DAY === Math.round(DAY * 0.25)) cluster(w);
  if (w.t % 12 === 0) { closeWatches(w); speak(w); }
}
