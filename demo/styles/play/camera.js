// The play camera: { x, z, zoom, bearing, up } in world meters, moved only through the renderer's exact projection.
import { SIZE } from "../island.js";

const TURN_MS = 380, SETTLE_MS = 220, ZOOM_TAU = 90, FOLLOW_TAU = 60, BOUND = SIZE / 2 - 100, UP_MAX = 2000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
export const norm8 = (b) => { const r = ((b % 8) + 8) % 8; return r >= 8 ? 0 : r; };
// the signed turn from a to b, the short way round, in [-4, 4)
const wrap8 = (d) => ((((d % 8) + 12) % 8) - 4);
const finite = (...v) => v.every(Number.isFinite);

export function createCamera({ live, view, canvas, onTurn }) {
  view.up ??= 0;
  let goal = view.zoom, zoomSet = view.zoom, anchor = null, turn = null, pinch = null, good = snapshot();
  function snapshot() { return { x: view.x, z: view.z, zoom: view.zoom, bearing: view.bearing, up: view.up }; }
  const half = () => [canvas.width / 2, canvas.height / 2];
  // move the target so world point A shows at canvas point (sx, sy) in state st; false, and nothing moved, if it cannot
  function hold(A, sx, sy, st = view) {
    const [cx, cy] = half(), T = live.solveTarget(st, A.x, A.z, A.y, sx - cx, sy - cy);
    if (!T || !finite(T.x, T.z)) return false;
    view.x = T.x; view.z = T.z;
    return true;
  }

  const cam = {
    get goal() { return goal; },
    get turning() { return !!turn; },
    // the drawn ground under the cursor is picked once per gesture, which ends when the zoom settles
    zoomTo(g, sx, sy) {
      if (!Number.isFinite(g)) return;
      goal = clamp(g, 0, live.zmax);
      if (sx == null) { anchor = null; return; }
      if (!anchor || Math.hypot(sx - anchor.at[0], sy - anchor.at[1]) > 2) {
        const A = live.groundUnder(view, sx, sy);
        anchor = A && finite(A.x, A.z, A.y) ? { A, at: [sx, sy] } : null;
      }
    },
    // where a zoom under way will stand: its goal, with the ground under the cursor still where it is now; null at rest
    goalView() {
      if (view.zoom === goal) return null;
      const st = { ...view, zoom: goal };
      if (anchor) {
        const s = live.screenOf(view, anchor.A.x, anchor.A.z, anchor.A.y), [cx, cy] = half(), T = live.solveTarget(st, anchor.A.x, anchor.A.z, anchor.A.y, s[0] - cx, s[1] - cy);
        if (T && finite(T.x, T.z)) { st.x = T.x; st.z = T.z; }
      }
      return st;
    },
    setZoom(z) { if (Number.isFinite(z)) { goal = zoomSet = view.zoom = clamp(z, 0, live.zmax); anchor = null; } },
    // the mid-screen target point is held at centre + (dx, dy), so the image moves exactly with the cursor
    panBy(dx, dy) {
      if (!finite(dx, dy) || (!dx && !dy && !view.up)) return;
      const A = { x: view.x, z: view.z, y: live.camH(view.x, view.z) + view.up }, [cx, cy] = half();
      if (!hold(A, cx + dx, cy + dy, { ...view, up: 0 })) return;
      view.up = 0;
      if (anchor) anchor.at = [anchor.at[0] + dx, anchor.at[1] + dy];
    },
    // a turn ends a zoom gesture: its anchor would drag the target round with it
    orbitBy(db) { if (Number.isFinite(db) && db) { view.bearing = norm8(view.bearing + db); anchor = null; } },
    // Q and E turn at once and at a steady pace; a bearing still baking is drawn from its baked neighbour, turned into place
    turnBy(d) {
      const target = (turn && !turn.drag ? turn.target : Math.round(view.bearing)) + d;
      turn = begin(target, false);
      view.turnTo = norm8(target);
    },
    // after a free turn, ease to the nearest whole bearing
    settle() { turn = begin(Math.round(view.bearing), true); view.turnTo = null; },
    stopTurn() { turn = null; view.turnTo = null; },
    // Two fingers: the ground under their midpoint stays under it while they spread, pinch and twist.
    pinchStart(mx, my, d, ang) {
      cam.stopTurn();
      anchor = null;
      pinch = { A: live.groundUnder(view, mx, my), d, ang, zoom: view.zoom };
    },
    pinchMove(mx, my, d, ang) {
      if (!pinch) return;
      // fingers too close together give no scale to measure a pinch against, so start measuring once they part
      if (!(pinch.d > 4)) { pinch.d = d; pinch.zoom = view.zoom; }
      let da = ang - pinch.ang;
      if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      pinch.ang = ang;
      if (Number.isFinite(da)) view.bearing = norm8(view.bearing - da / (Math.PI / 4));
      const z = pinch.d > 4 && d > 0 ? clamp(pinch.zoom + Math.log2(d / pinch.d), 0, live.zmax) : view.zoom;
      if (!Number.isFinite(z)) return;
      if (pinch.A) hold(pinch.A, mx, my, { ...view, zoom: z });
      goal = zoomSet = view.zoom = z;
    },
    pinchEnd() { if (pinch) { pinch = null; cam.settle(); } },
    // Put world point (x, z) at y terrain meters mid-screen, the target standing on it.
    lookAt(p) {
      if (!finite(p.x, p.z, p.y)) return;
      view.x = p.x; view.z = p.z; view.up = p.y - live.camH(p.x, p.z); anchor = null;
    },
    // eased toward a followed point, led by its velocity (m per ms) times the time constant so a steady walk leaves no lag
    follow(p, dt, vx = 0, vz = 0) {
      if (!finite(p.x, p.z, p.y, vx, vz)) return;
      anchor = null;
      const k = 1 - Math.exp(-dt / FOLLOW_TAU), x = p.x + vx * FOLLOW_TAU, z = p.z + vz * FOLLOW_TAU, up = p.y - live.camH(p.x, p.z);
      view.x += (x - view.x) * k; view.z += (z - view.z) * k; view.up += (up - view.up) * k;
    },
    // how far from mid-screen a world point is drawn now, in canvas px
    offCentre(p) { const s = live.screenOf(view, p.x, p.z, p.y), [cx, cy] = half(); return Math.hypot(s[0] - cx, s[1] - cy); },
    step(dt, now) {
      // a zoom set from outside (a script, the bench) is taken as the new goal
      if (view.zoom !== zoomSet) { goal = zoomSet = view.zoom; anchor = null; }
      turnStep(dt, now);
      if (view.zoom === goal) { anchor = null; return; }
      let z = view.zoom + (goal - view.zoom) * (1 - Math.exp(-dt / ZOOM_TAU));
      if (Math.abs(goal - z) < 1e-4) z = goal;
      if (anchor) {
        const s = live.screenOf(view, anchor.A.x, anchor.A.z, anchor.A.y);
        if (!hold(anchor.A, s[0], s[1], { ...view, zoom: z })) anchor = null;
      }
      view.zoom = zoomSet = z;
      if (z === goal) anchor = null;
    },
    // No NaN or Infinity survives a frame: the last good state comes back. Then everything is clamped to the island.
    guard() {
      if (!finite(view.x, view.z, view.zoom, view.bearing, view.up)) {
        Object.assign(view, good);
        goal = zoomSet = view.zoom; anchor = null; pinch = null; cam.stopTurn();
        return false;
      }
      view.x = clamp(view.x, -BOUND, BOUND); view.z = clamp(view.z, -BOUND, BOUND);
      view.zoom = zoomSet = clamp(view.zoom, 0, live.zmax); view.bearing = norm8(view.bearing); view.up = clamp(view.up, -UP_MAX, UP_MAX);
      if (!Number.isFinite(goal)) goal = view.zoom;
      good = snapshot();
      return true;
    },
  };
  function begin(target, drag) {
    const from = view.bearing;
    return { target, drag, from, to: from + wrap8(target - from), phase: 0, asked: performance.now(), startMs: null };
  }
  function turnStep(dt, now) {
    if (!turn) return;
    anchor = null;
    const T = turn, phase = Math.min(1, T.phase + dt / (T.drag ? SETTLE_MS : TURN_MS)), b = T.from + (T.to - T.from) * ease(phase);
    if (T.startMs == null && b !== T.from) T.startMs = now - T.asked;
    T.phase = phase;
    view.bearing = norm8(phase >= 1 ? Math.round(T.to) : b);
    if (phase >= 1) {
      if (!T.drag) onTurn?.({ start: T.startMs ?? 0, total: now - T.asked });
      view.turnTo = null; turn = null;
    }
  }
  return cam;
}
