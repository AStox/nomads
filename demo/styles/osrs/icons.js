// Small pixel sprites for the interface: items, side tabs and map icons. Drawn with canvas shapes, then hardened to
// one-bit alpha and given the client's black outline.
const col = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

export function sprite(w, h, draw, { outline = "#000000", shadow = null } = {}) {
  const cv = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = cv.getContext("2d");
  draw(g);
  const img = g.getImageData(0, 0, w, h), d = img.data, solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { solid[i] = d[i * 4 + 3] > 110 ? 1 : 0; d[i * 4 + 3] = solid[i] * 255; }
  const paint = (hex, dx0) => {
    const [r, gg, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    const mark = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (solid[y * w + x]) continue;
      const near = dx0.some(([dx, dy]) => { const X = x + dx, Y = y + dy; return X >= 0 && Y >= 0 && X < w && Y < h && solid[Y * w + X]; });
      if (near) mark[y * w + x] = 1;
    }
    for (let i = 0; i < w * h; i++) if (mark[i]) { d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
    for (let i = 0; i < w * h; i++) if (mark[i]) solid[i] = 2;
  };
  if (outline) paint(outline, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
  if (shadow) paint(shadow, [[-1, -1]]);
  g.putImageData(img, 0, 0);
  return cv;
}

const poly = (g, pts, fill) => { g.fillStyle = fill; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
const rect = (g, x, y, w, h, fill) => { if (!fill) return g.clearRect(x, y, w, h); g.fillStyle = fill; g.fillRect(x, y, w, h); };
const disc = (g, x, y, r, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); };
const ell = (g, x, y, rx, ry, rot, fill) => { g.fillStyle = fill; g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, 6.2832); g.fill(); };

// ---------- items (36 x 32) ----------
function log(g, x, y, len, ang, bark, end) {
  g.save(); g.translate(x, y); g.rotate(ang);
  rect(g, -len / 2, -4, len, 8, bark);
  rect(g, -len / 2, -4, len, 2, col(30, 35, 38));
  rect(g, -len / 2 + 3, 0, len - 8, 1, col(25, 40, 16));
  ell(g, len / 2, 0, 2.5, 4, 0, end);
  disc(g, len / 2, 0, 1.2, col(35, 45, 40));
  g.restore();
}
export const ITEMS = {
  logs: () => sprite(36, 32, (g) => { log(g, 16, 20, 20, -0.5, col(26, 45, 26), col(40, 55, 62)); log(g, 20, 13, 20, -0.5, col(26, 45, 28), col(40, 55, 64)); }),
  oak: () => sprite(36, 32, (g) => { log(g, 16, 19, 20, -0.5, col(34, 40, 34), col(42, 55, 66)); log(g, 20, 12, 20, -0.5, col(34, 40, 36), col(42, 55, 68)); }),
  axe: () => sprite(36, 32, (g) => {
    g.save(); g.translate(18, 16); g.rotate(-0.75);
    rect(g, -2, -12, 3, 26, col(28, 50, 30)); rect(g, -2, -12, 1, 26, col(30, 45, 42));
    poly(g, [[-1, -12], [9, -15], [10, -6], [-1, -7]], col(28, 60, 40)); poly(g, [[1, -12], [8, -14], [8, -12], [1, -10]], col(34, 70, 58));
    g.restore();
  }),
  tinderbox: () => sprite(36, 32, (g) => {
    poly(g, [[7, 17], [22, 11], [30, 16], [15, 23]], col(28, 45, 34));
    poly(g, [[7, 17], [15, 23], [15, 27], [7, 21]], col(26, 45, 22)); poly(g, [[15, 23], [30, 16], [30, 20], [15, 27]], col(27, 45, 28));
    poly(g, [[12, 16], [22, 12], [26, 14], [16, 18]], col(40, 8, 60));
  }),
  shrimps: (cooked = false) => sprite(36, 32, (g) => {
    const body = cooked ? col(18, 70, 52) : col(350, 30, 66), dark = cooked ? col(14, 70, 38) : col(350, 25, 50);
    for (const [x, y, r] of [[13, 18, 0.4], [21, 14, -0.2]]) {
      g.save(); g.translate(x, y); g.rotate(r);
      g.strokeStyle = body; g.lineWidth = 4.5; g.beginPath(); g.arc(0, 0, 6, 0.3, 3.9); g.stroke();
      g.strokeStyle = dark; g.lineWidth = 1.2; g.beginPath(); g.arc(0, 0, 4.2, 0.6, 3.6); g.stroke();
      poly(g, [[5, 3], [10, 4], [8, 7]], dark);
      g.restore();
    }
  }),
  net: () => sprite(36, 32, (g) => {
    g.strokeStyle = col(40, 20, 72); g.lineWidth = 1;
    for (let k = -2; k <= 3; k++) { g.beginPath(); g.moveTo(9 + k * 4, 8); g.lineTo(11 + k * 3, 24); g.stroke(); g.beginPath(); g.moveTo(5, 10 + k * 3); g.lineTo(26, 10 + k * 3); g.stroke(); }
    g.strokeStyle = col(28, 45, 30); g.lineWidth = 2.2; g.beginPath(); g.ellipse(16, 14, 11, 7, 0, 0, 6.28); g.stroke();
    rect(g, 26, 16, 7, 3, col(28, 50, 30));
  }, { outline: null }),
  coins: () => sprite(36, 32, (g) => { for (let k = 0; k < 4; k++) { ell(g, 16 + (k % 2) * 3, 22 - k * 3, 8, 3.5, 0, col(46, 85, 40)); ell(g, 16 + (k % 2) * 3, 21 - k * 3, 7, 2.5, 0, col(50, 95, 58)); } }),
  knife: () => sprite(36, 32, (g) => { g.save(); g.translate(18, 16); g.rotate(-0.8); rect(g, -2, 1, 4, 10, col(28, 45, 28)); poly(g, [[-2, 1], [2, 1], [1, -13], [-2, -8]], col(210, 6, 72)); g.restore(); }),
  bread: () => sprite(36, 32, (g) => { ell(g, 17, 18, 12, 7, -0.2, col(32, 60, 38)); ell(g, 17, 16, 10, 5, -0.2, col(36, 65, 52)); }),
};

// ---------- side tabs (26 x 26) ----------
export const TABS = {
  combat: () => sprite(26, 26, (g) => { for (const s of [-1, 1]) { g.save(); g.translate(13, 13); g.rotate(s * 0.78); rect(g, -1.5, -11, 3, 15, col(210, 8, 75)); rect(g, -5, 4, 10, 2, col(40, 60, 45)); rect(g, -1.5, 6, 3, 5, col(28, 45, 30)); g.restore(); } }),
  stats: () => sprite(26, 26, (g) => { rect(g, 4, 14, 4, 8, col(120, 55, 40)); rect(g, 11, 8, 4, 14, col(50, 80, 50)); rect(g, 18, 4, 4, 18, col(0, 65, 45)); }),
  quest: () => sprite(26, 26, (g) => { rect(g, 6, 5, 14, 16, col(42, 50, 78)); rect(g, 4, 3, 18, 3, col(36, 45, 60)); rect(g, 4, 20, 18, 3, col(36, 45, 60)); for (let k = 0; k < 4; k++) rect(g, 8, 8 + k * 3, 10, 1, col(30, 30, 35)); }),
  inventory: () => sprite(26, 26, (g) => { poly(g, [[6, 9], [20, 9], [21, 23], [5, 23]], col(28, 50, 32)); rect(g, 8, 4, 10, 6, col(28, 45, 26)); rect(g, 10, 6, 6, 3, null); rect(g, 6, 14, 14, 2, col(28, 40, 22)); rect(g, 11, 13, 4, 4, col(45, 70, 50)); }),
  equipment: () => sprite(26, 26, (g) => { poly(g, [[6, 6], [20, 6], [22, 12], [18, 22], [8, 22], [4, 12]], col(210, 8, 58)); rect(g, 11, 6, 4, 16, col(210, 8, 70)); rect(g, 7, 12, 12, 2, col(210, 8, 45)); }),
  prayer: () => sprite(26, 26, (g) => { poly(g, [[13, 2], [15.5, 10.5], [24, 13], [15.5, 15.5], [13, 24], [10.5, 15.5], [2, 13], [10.5, 10.5]], col(55, 20, 92)); disc(g, 13, 13, 3, col(50, 90, 60)); }),
  magic: () => sprite(26, 26, (g) => { rect(g, 5, 5, 16, 17, col(250, 45, 42)); rect(g, 7, 6, 13, 14, col(250, 40, 52)); rect(g, 5, 19, 16, 3, col(40, 10, 85)); disc(g, 13, 12, 3, col(190, 80, 65)); }),
  clan: () => sprite(26, 26, (g) => { poly(g, [[13, 3], [22, 7], [22, 17], [13, 23], [4, 17], [4, 7]], col(0, 55, 38)); poly(g, [[13, 7], [18, 10], [18, 16], [13, 19], [8, 16], [8, 10]], col(45, 80, 55)); }),
  friends: () => sprite(26, 26, (g) => { disc(g, 13, 13, 9, col(50, 90, 55)); disc(g, 10, 10, 1.4, "#222"); disc(g, 16, 10, 1.4, "#222"); g.strokeStyle = "#222"; g.lineWidth = 1.6; g.beginPath(); g.arc(13, 13, 5, 0.4, 2.7); g.stroke(); }),
  account: () => sprite(26, 26, (g) => { disc(g, 13, 8, 4.5, col(30, 30, 70)); poly(g, [[5, 23], [7, 15], [19, 15], [21, 23]], col(210, 30, 50)); }),
  logout: () => sprite(26, 26, (g) => { rect(g, 7, 3, 12, 20, col(28, 45, 30)); rect(g, 9, 5, 8, 16, col(28, 45, 40)); disc(g, 15, 13, 1.2, col(45, 80, 60)); }),
  settings: () => sprite(26, 26, (g) => { g.save(); g.translate(13, 13); g.rotate(0.78); rect(g, -2, -3, 4, 14, col(210, 6, 62)); disc(g, 0, -6, 5, col(210, 6, 62)); rect(g, -1.5, -12, 3, 6, null); g.restore(); }),
  emotes: () => sprite(26, 26, (g) => { disc(g, 13, 13, 9, col(48, 90, 52)); disc(g, 10, 10, 1.4, "#222"); disc(g, 16, 10, 1.4, "#222"); ell(g, 13, 16, 4, 2.5, 0, "#6b1a10"); }),
  music: () => sprite(26, 26, (g) => { rect(g, 9, 5, 2, 14, col(0, 0, 90)); rect(g, 17, 3, 2, 14, col(0, 0, 90)); rect(g, 9, 3, 10, 3, col(0, 0, 90)); ell(g, 8, 19, 3, 2.3, -0.4, col(0, 0, 90)); ell(g, 16, 17, 3, 2.3, -0.4, col(0, 0, 90)); }),
};

// ---------- skill icons for experience drops (16 x 16) ----------
export const SKILLS = {
  woodcutting: () => sprite(16, 16, (g) => { disc(g, 10, 5, 4, col(110, 55, 32)); rect(g, 9, 8, 2, 6, col(28, 50, 26)); g.save(); g.translate(6, 9); g.rotate(-0.7); rect(g, -1, -5, 2, 11, col(30, 50, 34)); rect(g, -1, -5, 5, 3, col(210, 6, 70)); g.restore(); }),
  firemaking: () => sprite(16, 16, (g) => { poly(g, [[8, 1], [13, 9], [11, 14], [5, 14], [3, 9], [6, 6]], col(22, 95, 52)); poly(g, [[8, 6], [10.5, 10], [9, 14], [7, 14], [5.5, 10]], col(50, 100, 60)); }),
};

// ---------- map function icons (15 x 15) ----------
function badge(g, ring, fill) { disc(g, 7.5, 7.5, 7.4, ring); disc(g, 7.5, 7.5, 6, fill); }
export const MAPICONS = {
  fishing: () => sprite(15, 15, (g) => { badge(g, "#0c1f3a", col(205, 70, 55)); poly(g, [[3, 7.5], [7, 5], [10, 7.5], [7, 10]], col(210, 30, 92)); poly(g, [[9.5, 7.5], [12.5, 5], [12.5, 10]], col(210, 30, 92)); }, { outline: null }),
  water: () => sprite(15, 15, (g) => { badge(g, "#10223a", col(200, 20, 75)); poly(g, [[7.5, 2.5], [11, 8.5], [7.5, 12], [4, 8.5]], col(210, 80, 50)); disc(g, 7.5, 8.8, 3.3, col(210, 80, 50)); rect(g, 6, 7, 1, 2, col(200, 80, 85)); }, { outline: null }),
  fire: () => sprite(15, 15, (g) => { badge(g, "#2a1206", col(20, 25, 28)); poly(g, [[7.5, 2], [11, 8], [10, 12], [5, 12], [4, 8], [6, 6]], col(22, 95, 52)); poly(g, [[7.5, 6], [9.5, 9.5], [8.5, 12], [6.5, 12], [5.5, 9.5]], col(50, 100, 60)); rect(g, 4, 12, 7, 1.5, col(28, 50, 28)); }, { outline: null }),
  tree: () => sprite(15, 15, (g) => { badge(g, "#0e2410", col(95, 35, 55)); disc(g, 7.5, 6, 4, col(110, 60, 28)); disc(g, 5.5, 7.5, 2.6, col(110, 60, 30)); disc(g, 9.5, 7.5, 2.6, col(110, 60, 30)); rect(g, 6.8, 9, 1.6, 4, col(28, 50, 25)); }, { outline: null }),
  rocks: () => sprite(15, 15, (g) => { badge(g, "#1c1a16", col(35, 15, 50)); poly(g, [[3, 11], [5, 6], [8, 4], [11, 6], [12, 11]], col(30, 8, 35)); rect(g, 6, 7, 2, 2, col(24, 70, 45)); rect(g, 9, 8, 1.5, 1.5, col(24, 70, 45)); }, { outline: null }),
};

// Tiny tree / rock pictures that the minimap and world map draw straight into the ground.
export const MAPSCENE = {
  tree: () => sprite(5, 6, (g) => { disc(g, 2.5, 2.2, 2.3, col(105, 55, 22)); rect(g, 2, 4, 1, 2, col(28, 50, 20)); }, { outline: null }),
  pine: () => sprite(5, 6, (g) => { poly(g, [[2.5, 0], [5, 5], [0, 5]], col(135, 45, 18)); rect(g, 2, 5, 1, 1, col(28, 50, 20)); }, { outline: null }),
  dead: () => sprite(5, 6, (g) => { rect(g, 2, 1, 1, 5, col(30, 15, 30)); rect(g, 0, 1, 2, 1, col(30, 15, 30)); rect(g, 3, 2, 2, 1, col(30, 15, 30)); }, { outline: null }),
  rock: () => sprite(4, 3, (g) => { rect(g, 0, 1, 4, 2, col(35, 6, 40)); rect(g, 1, 0, 2, 1, col(35, 6, 55)); }, { outline: null }),
};
