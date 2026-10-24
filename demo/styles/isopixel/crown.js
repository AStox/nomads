// The colours of the forest as its trees are drawn, for the ground to show where they are not: a histogram over the palette of the painted pixels of every tree sprite the atlas holds (a tree
// family's key begins "t|", atlas.js Looks.key), each palette index counted once for each pixel it paints, so the big crowns that cover the ground weigh most, and the trunk and the lit and
// dark sides are in it as the sprites draw them. The ground's tree cover already is the share of its area the crowns' opaque pixels cover, so no coverage is applied again; the painter
// (ground.wgsl.js g_paint) paints that share of the cover the drawn trees do not cover with palette indices drawn from this histogram, which the same light tables then light as they light the sprites.
export class CrownMean {
  // rgb: the palette's colours (pal.js RGB), fallback: the colour until a tree sprite is made
  constructor(rgb, fallback = [38, 68, 44]) {
    this.rgb = rgb; this.fallback = fallback;
    this.count = new Float64Array(rgb.length);
    this.total = 0;
  }
  // a made sprite (its painted pixels' palette indices s.p, 255 where nothing is painted) of the family `key`; whether it was a tree's
  add(key, s) {
    if (!s || !key.startsWith("t|")) return false;
    for (let i = 0; i < s.p.length; i++) { const v = s.p[i]; if (v !== 255) { this.count[v]++; this.total++; } }
    return true;
  }
  // the cumulative share of the painted pixels at each palette index (the last is 1), which ground.wgsl.js g_crownIdx draws a palette index from; empty until a tree sprite is made
  cdf() {
    const out = new Float32Array(this.count.length);
    if (!this.total) return out;
    let acc = 0;
    for (let i = 0; i < out.length; i++) { acc += this.count[i]; out[i] = acc / this.total; }
    out[out.length - 1] = 1;
    return out;
  }
  mean() {
    if (!this.total) return this.fallback;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < this.count.length; i++) { const n = this.count[i]; if (n) { r += n * this.rgb[i][0]; g += n * this.rgb[i][1]; b += n * this.rgb[i][2]; } }
    return [r / this.total, g / this.total, b / this.total];
  }
}
