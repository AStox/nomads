// The page's side of the sim, which runs in the render worker (isopixel/worker.js, play/sim.js) on the GPU device the
// island is drawn with, so the page thread keeps only the UI. This keeps the face the page and the renderer read (w,
// pos, alpha, inspect, journey, update and the rest) from what the worker posts: after each tick, the people, animals,
// camps and weather and the things drawn every frame that changed; and whenever the page asks (want), the selection's
// inspector, path and heading, the world window's things and the population history, which come again after every tick.
// The ticks' timing stays here, as it was when the sim ran on this thread, so a frame between two ticks draws people and
// animals partway along their last step.
const BASE_MS = 500;

// live: the renderer (isopixel/live.js), whose worker runs the sim. Resolves once the world is warm.
export function connectSim(live, { onProgress } = {}) {
  // the latest state and where each person and animal stood before the last tick; the selection's answer, the things
  // window's and the history as last asked for
  let S = null, ents = new Map(), acts = new Map(), opening = null, activities = {}, DAY = 0;
  const prev = new Map(), liveThings = new Map();
  let want = { sel: null, things: null, history: false }, about = null, things = null, history = null;
  let alpha = 0, last = null, pausedAt = null, lastIv = 0, running = false, done = null;
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
    // "relay" while people think with Jev, "random" otherwise
    get brain() { return S.brain; },
    // the things drawn every frame (fires, shelters, items and the like) as a client is sent them, by id
    liveThings,
    // who to open on (play/sim.js opening): { id, px, py }, or null
    get opening() { return opening; },
    speed: 1,
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
      const ft = S.t + alpha, h = sim.hour ?? ((ft % DAY) / DAY) * 24;
      return { hour: h, day: Math.floor(ft / DAY) + 1, season: S.weather.season };
    },
    // At most one tick per call: each is the worker's, and the server never bursts to catch up either. What a tick
    // changed is handed back by the first call after the worker says it ended, which may start the next; none starts
    // while one runs.
    update(now) {
      if (sim.paused) { pausedAt ??= now; return null; }
      if (pausedAt !== null) { if (last !== null) last += now - pausedAt; pausedAt = null; }
      const iv = BASE_MS / sim.speed;
      if (last === null) { last = now; lastIv = iv; return null; }
      if (iv !== lastIv) { last = now - alpha * iv; lastIv = iv; }
      const ready = done;
      done = null;
      if (running || now - last < iv) { alpha = Math.min(1, Math.max(0, (now - last) / iv)); return ready; }
      last = now - last < 2 * iv ? last + iv : now;
      alpha = Math.min(1, (now - last) / iv);
      remember();
      running = true;
      live.post({ type: "simTick" });
      return ready;
    },
  };

  return new Promise((ready, fail) => {
    live.onSim((m) => {
      if (m.type === "simProgress") onProgress?.(m.d, m.n);
      // the worker's sim failing after it was ready stops the page as any other error does
      else if (m.type === "simError") { const e = new Error(m.error); if (S) reportError(e); else fail(e); }
      else if (m.type === "simReady") {
        activities = m.activities; DAY = m.day; opening = m.opening;
        take(m.state);
        for (const t of m.live) liveThings.set(t.id, t);
        remember();
        ready(sim);
      } else if (m.type === "simState") {
        if (m.state) take(m.state);
        answers(m);
        if (m.ch) {
          for (const t of m.ch.live) liveThings.set(t.id, t);
          for (const id of m.ch.drop) liveThings.delete(id);
          done = m.ch; running = false;
        } else sim.onAnswer?.();
      }
    });
  });
}
