// The client's own bitmap fonts (RuneStar's dumps of the cache fonts), drawn pixel by pixel.
const BASE = "https://cdn.jsdelivr.net/gh/RuneStar/fonts@master/data/RuneScape/";

export async function loadFonts() {
  const names = { plain: "RuneScape-Plain-12", small: "RuneScape-Plain-11", bold: "RuneScape-Bold-12", quill: "RuneScape-Quill-8" };
  const out = {};
  await Promise.all(Object.entries(names).map(async ([k, file]) => {
    const r = await fetch(BASE + file + ".json");
    if (!r.ok) throw new Error(`font ${file}: ${r.status}`);
    const j = await r.json();
    out[k] = { ascent: j.ascent, glyphs: new Map(j.glyphs.map((g) => [g.codePoint, g])) };
  }));
  return out;
}

const glyph = (f, ch) => f.glyphs.get(ch.codePointAt(0)) || f.glyphs.get(63);
export const width = (f, s) => [...s].reduce((w, ch) => w + glyph(f, ch).advance, 0);

// Segments are [text, color] pairs; y is the top of the line; the shadow sits one pixel down and right, as in the client.
export function text(g, f, segs, x, y, shadow = "#000") {
  if (typeof segs === "string") segs = [[segs, "#fff"]];
  for (const [s, color] of segs)
    for (const ch of s) {
      const gl = glyph(f, ch);
      for (const [dx, col] of shadow ? [[1, shadow], [0, color]] : [[0, color]]) {
        g.fillStyle = col;
        for (let j = 0; j < gl.height; j++)
          for (let i = 0; i < gl.width; i++)
            if (gl.pixels[j * gl.width + i]) g.fillRect(x + gl.leftBearing + i + dx, y + gl.topBearing + j + dx, 1, 1);
      }
      x += gl.advance;
    }
  return x;
}

export function centered(g, f, segs, cx, y, shadow = "#000") {
  const w = (typeof segs === "string" ? [[segs]] : segs).reduce((a, [s]) => a + width(f, s), 0);
  return text(g, f, segs, Math.round(cx - w / 2), y, shadow);
}
