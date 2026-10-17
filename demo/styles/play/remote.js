// The page's side of the sim, which runs in the render worker (isopixel/worker.js, play/sim.js) on the GPU device the
// island is drawn with, so the page thread keeps only the UI. This keeps the face the page and the renderer read (w,
// pos, alpha, inspect, journey, update and the rest) from what the worker posts: after the ticks of a frame, the people,
// animals, camps and weather and the things drawn every frame that changed; and whenever the page asks (want), the
// selection's inspector, path and heading, the world window's things and the population history, which come again
// after every frame's ticks.
// The ticks' timing stays here, as it was when the sim ran on this thread, so a frame between two ticks draws people and
// animals partway along their last step.

// The pace the world runs at unless the page asks otherwise, in sim seconds a wall second: a day each 144 wall seconds,
// the pace it has always had [design].
export const PACE = 600;
// Behind the clock by more than this when ticks come due (ticks slower than the pace), the clock slips back to this far
// behind and the rest of what is owed is let go [design: two 60 Hz frames].
const SLIP_MS = 2000 / 60;

// live: the renderer (isopixel/live.js), whose worker runs the sim. Resolves once the world is there, before it warms.
export function connectSim(live) {
  // the latest state and where each person and animal stood before the last tick; the selection's answer, the things
  // window's and the history as last asked for
  let S = null, ents = new Map(), acts = new Map(), opening = null, activities = {}, DAY = 0, TICK_S = 0, YEAR_DAYS = 0;
  const prev = new Map(), liveThings = new Map();
  let want = { sel: null, things: null, history: false }, about = null, things = null, history = null;
  // The page's clock: since, the wall ms its tick 0 fell at, at the wall ms a tick lasts at the pace when it was last
  // looked at (wallWas); base, the ticks the worker has run for it; asked, base when the ticks in hand were asked for;
  // the last ticks shown, shownK of them from tick shownFrom of the clock, drawn as far as alpha has come.
  let alpha = 0, since = null, wallWas = 0, pausedAt = null, base = 0, asked = 0, shownFrom = 0, shownK = 1, running = false, done = null;
  const sameSel = (a, b) => a === b || (!!a && !!b && typeof a === "object" && typeof b === "object" && a.px === b.px && a.py === b.py);
  const w = {
    get t() { return S.t; }, get agents() { return S.agents; }, get animals() { return S.animals; },
    get camps() { return S.camps; }, get weather() { return S.weather; },
  };
  const take = (state) => {
    S = state;
    ents = new Map(); acts = new Map();
    for (const a of S.agents) { ents.set(a.id, a); acts.set(a.id, a.act); }
    for (const a of S.animals) ents.set(a.id, a);
  };
  // the answers to what the page asked, kept only while they answer what it asks now
  const answers = (m) => {
    if ("about" in m && sameSel(m.sel, want.sel)) about = m.about;
    if (m.things) things = m.things;
    if (m.history) history = m.history;
  };
  const remember = () => {
    prev.clear();
    for (const a of S.agents) prev.set(a.id, [a.px, a.py]);
    for (const a of S.animals) prev.set(a.id, [a.px, a.py]);
  };

  const sim = {
    w,
    get alpha() { return alpha; },
    get tickMs() { return S.tickMs; },
    // the warm's ticks still to run (play/sim.js), and how many it has: all those left asked for at once while any are
    // left, the worker running as many as its frame's sim budget allows
    get warming() { return S?.warming ?? 0; },
    warmTicks: 0,
    // the sim's clock as the worker posts it: ticks a day, seconds a tick, days a year
    get day() { return DAY; },
    get tickS() { return TICK_S; },
    get yearDays() { return YEAR_DAYS; },
    // the wall ms the last ticks shown are drawn over at this pace, from where they stood to where they stand
    get stepMs() { return (shownK * TICK_S * 1000) / sim.speed; },
    // "relay" while people think with Jev, "random" otherwise
    get brain() { return S.brain; },
    // the things drawn every frame (fires, shelters, items and the like) as a client is sent them, by id
    liveThings,
    // who to open on (play/sim.js opening): { id, px, py }, or null
    get opening() { return opening; },
    // sim seconds a wall second
    speed: PACE,
    paused: false,
    // called when an answer to what the page asked comes in between ticks
    onAnswer: null,
    // Ask the worker about the selection (an id or a point of ground), the things window ({ open: kinds unfolded, px,
    // py: tiles to sort them by }) and the history; the answer comes at once and again after every tick.
    want(part) {
      const next = { ...want, ...part };
      if (sameSel(next.sel, want.sel) && JSON.stringify(next.things) === JSON.stringify(want.things) && next.history === want.history) return;
      if (!sameSel(next.sel, want.sel)) about = null;
      want = next;
      live.post({ type: "simWant", want });
    },
    // Current and previous float positions in tiles; things don't move, so theirs match (the selected thing's only).
    pos(id) {
      const e = ents.get(id) ?? (sameSel(id, want.sel) && about?.pos) ?? null;
      if (!e) return null;
      const p = prev.get(id);
      return { px: e.px, py: e.py, ppx: p ? p[0] : e.px, ppy: p ? p[1] : e.py };
    },
    // the inspector of the selection (inspect.ts), undefined while the worker is asked, null for one gone
    inspect: (id) => (sameSel(id, want.sel) && about ? about.data : undefined),
    inspectGround: (px, py) => sim.inspect({ px, py }),
    // a selected thing on the ground as the renderer holds it: { px, py, size, kind, species }
    mark: (id) => (sameSel(id, want.sel) && about?.mark) || null,
    // what a person is at (sim.ts Activity), and what each one means
    activity: (id) => acts.get(id) ?? null,
    get activities() { return activities; },
    // where the selected person is walking to, in tiles, or null
    heading: (id) => (sameSel(id, want.sel) && about?.heading) || null,
    // the selection's path (world.ts Journey): x, y, t the points they have passed, marks [{ px, py, t, kind, text }]
    journey: (id) => (sameSel(id, want.sel) && about?.journey) || null,
    // things on the ground by kind, { n, rows: [{ id, label, px, py }] }, as last asked for
    things: () => things,
    // population counts over time: t (ticks), people, and animals by species, all the same length, as last asked for
    history: () => history,
    // the hour the page is drawn at: null follows the sim, a number pins it there (?hour=, or from the console)
    hour: null,
    clock() {
      // the time drawn: within the last ticks shown, as far as alpha has come
      const ft = S.t + 1 - shownK + alpha * shownK, h = sim.hour ?? ((ft % DAY) / DAY) * 24;
      return { hour: h, day: Math.floor(ft / DAY) + 1, season: S.weather.season };
    },
    // The ticks due by the page's clock (floor of speed times the wall time since its start over a tick's seconds), asked
    // of the worker together, which runs them while the frame's sim budget lasts and hands back how many it ran. What
    // they changed is handed back by the first call after the worker says they ended, which may ask for the next; none
    // is asked for while some run. While the world warms, every warm tick left is asked for as soon as the last ran,
    // the worker running what its frame's sim budget allows, each drawn where it lands.
    update(now) {
      if (sim.paused) { pausedAt ??= now; return null; }
      if (pausedAt !== null) { if (since !== null) since += now - pausedAt; pausedAt = null; }
      const wall = (TICK_S * 1000) / sim.speed;
      if (since === null) { since = now - base * wall; wallWas = wall; return null; }
      // a new speed keeps the clock where it stands, in ticks
      if (wall !== wallWas) { since = now - ((now - since) / wallWas) * wall; wallWas = wall; }
      const ready = done;
      done = null;
      const at = (now - since) / wall;
      alpha = S.warming ? 1 : Math.min(1, Math.max(0, (at - shownFrom) / shownK));
      if (running) return ready;
      let n = S.warming ? S.warming : Math.floor(at) - base;
      if (n <= 0) return ready;
      // behind by more than two frames' worth, the clock slips back to two frames behind
      if (!S.warming && (at - base - 1) * wall > SLIP_MS) { since = now - (base + 1) * wall - SLIP_MS; n = Math.floor((now - since) / wall) - base; }
      remember();
      running = true; asked = base;
      live.post({ type: "simTick", n });
      return ready;
    },
  };

  return new Promise((ready, fail) => {
    live.onSim((m) => {
      if (m.type === "simProgress") sim.warmTicks = m.n;
      // the worker's sim failing after it was ready stops the page as any other error does
      else if (m.type === "simError") { const e = new Error(m.error); if (S) reportError(e); else fail(e); }
      else if (m.type === "simReady") {
        activities = m.activities; DAY = m.day; TICK_S = m.tickS; YEAR_DAYS = m.yearDays; opening = m.opening;
        take(m.state);
        sim.warmTicks = S.warming;
        for (const t of m.live) liveThings.set(t.id, t);
        remember();
        ready(sim);
      } else if (m.type === "simState") {
        const warmed = !!S?.warming;
        if (m.state) take(m.state);
        answers(m);
        if (m.ch) {
          for (const t of m.ch.live) liveThings.set(t.id, t);
          for (const id of m.ch.drop) liveThings.delete(id);
          done = m.ch; running = false;
          base += m.ran; shownFrom = asked + 1; shownK = m.ran;
          // the warm over, the clock starts with this tick shown whole and the next due a tick's wall time on
          if (warmed && !S.warming && since !== null) { since = performance.now() - base * wallWas; shownFrom = base - 1; shownK = 1; }
        } else sim.onAnswer?.();
      }
    });
  });
}
