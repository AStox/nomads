// How big a tree is drawn, as one function of the camera's scale, so the two levels of a cross-fade draw it the same size and no level boundary steps it.
//
// A tree of height h metres stands 1.2247 * treeK(mpp) * h / mpp screen px tall (0.866 for the ladder's tilt, sqrt 2 for its tile diagonal), mpp the metres a screen px spans.
// The law is the island bake's (main.js `V.treeK = 1.15 * (W / 2 / tileM / 0.8533) ** -0.15`: sprites grow a little slower than the world as you zoom in, 1.15 at the valley
// level, whose W / 2 / tileM is 0.8533), which the ladder evaluated at each level's own scale, so every level boundary stepped the trees by 6 to 10 percent. W / 2 / tileM is a
// level's screen px per metre (1 / mpp) over the screen px per art px it is drawn at; that factor runs from 2 to 4 and varies by level, so the one law takes its geometric mean,
// S_REF, over the ladder's zoom range (each level weighted by its log range, the factor at a level's mid taken as 2 * sqrt(ratio)): the mean of log treeK across the ladder is
// then the old law's [design: derived from the ladder in live.js LADDER, 2.7734 for the page's ladder].
// treeK(mpp) = 1.15 * (1 / (mpp * S_REF * 0.8533)) ** -0.15 = TK_A * mpp ** TK_EXP.
const S_REF = 2.7734;
export const TK_EXP = 0.15;
export const TK_A = 1.15 * (S_REF * 0.8533) ** TK_EXP;

// the sprite scale at a camera that sees mpp metres a screen px
export const treeK = (mpp) => TK_A * mpp ** TK_EXP;

// the same law for a shader: fn treeK(mpp: f32) -> f32, the one TK_A and TK_EXP
export const TREEK_WGSL = `fn treeK(mpp: f32) -> f32 { return ${TK_A.toPrecision(9)} * pow(mpp, ${TK_EXP}); }`;
