// The share of the ground's tree cover that no drawn tree covers at a zoom: what the ground paints as crown colour (PaintCtx.canopy, 0 to 1) so the picture's mean colour holds
// as the trees go. It is the complement of what the object passes still draw (wgsl/objects.js cullEval): a tree is a sprite from 1 art px tall, a hashed one-pixel speck below it
// down to TREE_FADE_MIN art px (more of them the nearer 1, in proportion to its area, hpx squared), and nothing under that; and a wood held at the share 2^-e (the blocks'
// exponent word) shows 2^-e of its trees. Pure, so the planet pass and the shader use one set of thresholds.

// the least height, in art px, a tree is drawn at (as a speck): the cull's and the survey's floor
export const TREE_FADE_MIN = 0.3;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// the share of trees of hpx art px drawn at all: the speck's area share (hpx squared) taken to none by treeFade, 1 from a pixel up (wgsl/objects.js treeShare)
export const treeFade = (hpx) => smoothstep(TREE_FADE_MIN, 1, hpx);
export const treeShare = (hpx) => Math.min(hpx * hpx, 1) * treeFade(hpx);

// a tree's height in art px per metre of height and per screen px per metre: the ladder's tree scale (live.js: pv = k * 0.866 * treeK, treeK about 1.2 across the levels) over
// the screen px an art px covers (the planet pass draws at art = 2, the ladder's levels at 2 to 4)
export const TREE_K = 0.866 * 1.2;

// ppm: screen px per metre at the zoom; e: the exponent of the share the blocks hold (0: every tree); hk: the height in metres of the tree whose share is asked (the wood's mean
// height, grid layer 5), 12 m by default; art: screen px per art px
export function canopyShare(ppm, e = 0, hk = 12, art = 2) {
  const hpx = (hk * ppm * TREE_K) / art;
  return 1 - 2 ** -Math.max(0, e) * treeShare(hpx);
}

// The drawn trees' silhouettes cover the ground's tree cover only once they are big: a tree of hpx art px has a crown a fraction of that wide, so over a few art px the sprites are
// thin marks on a lawn and the cover's colour is still wanted from the ground, falling away as their area grows (the square of their height) until their crowns meet, at COVER_PX art
// px tall [design: the value at which the sweep's mean colour holds through the join]. The share the ground paints as crowns beside canopyShare's, which counts a tree drawn as covering.
export const COVER_PX = 5;
export function canopyHold(ppm, e = 0, hk = 12, art = 2) {
  const hpx = (hk * ppm * TREE_K) / art;
  return 1 - 2 ** -Math.max(0, e) * Math.min(1, (hpx / COVER_PX) ** 2) * treeFade(hpx);
}
