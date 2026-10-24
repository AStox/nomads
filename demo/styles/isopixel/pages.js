// The ground read through a page table instead of one window texture: the fine, light-grid and stream-mask fields of the window's 4 by 4 pages of 64 cells, each page in a slot
// of an atlas (a 2d-array texture per field, 16 slots a 4 by 4 tile of each of a group's layers; the stream masks one 2d texture, 4 slots across). The island's fields (75 m cells, 256 a side, 15 layers) stay one window texture: read a page at
// a time they cost the painter 0.3 ms of GPU (one page lookup for each of the fifty cells a pixel reads), read as the window's they cost nothing. The text is shared by the painter's group (ground.wgsl.js, the words in gGradT) and
// the object passes (wgsl/objects.js, the words in the looks' table), each of which defines two functions before it:
//   pgOn() -> bool            pages are on (the window's own textures are read when not)
//   pgTab(k: u32) -> i32      the table's entry k = y * 4 + x: a slot, or -(2 + n) for a page not resident, held to the nearest resident page n (y * 4 + x)
// A position is the window's own: a fine vertex (x east, y south, 1,021 a side), a grid node (1,537), a mask texel (4,096). The fine vertex x of a page is
// x + 2 - 256 * (x + 2) / 256 (the page's lattice starts two vertices before the window's crop), the rows turned as the window's are, so the read of a vertex and the next stays in
// the page (257 vertices, the edge shared); a grid page has 385 nodes (the edge shared) and a mask page 1,024 texels.

export const PAGE_SLOTS = 16; // slots in a group: a 4 by 4 tile of pages in each layer of the atlas
export const PAGE_TEX = { fine: 257 * 4, grid: 385 * 4, river: 1024 * 8 };
export const PAGE_MAX_SLOTS = 64; // the stream masks are one 2d texture, 8 slots across (slot s at column s & 7, row s >> 3), and a texture is 8,192 texels at most
export const PAGE_LAYERS = { fine: 10, grid: 8 };

// a page's words in the atlas buffers demo/tile.ts pageAtlas makes (terrain-window.ts PAGE_FINE_WORDS, PAGE_GRID_WORDS, PAGE_MASK_WORDS) and their rows' bytes, which scripts/play/groundpages-live.ts checks against it
export const PAGE_WORDS = { fine: 10 * 257 * 320, grid: 5 * 385 * 448, mask: (1024 * 1024) / 4 };
export const PAGE_ROW = { fine: 1280, grid: 1792, mask: 1024 };
// the window's cells (75 m, 256 across) in each field's own lattice: fine vertices a cell is 4 apart from the first cell's centre (1,021 of them), grid nodes 6 a cell from the window's edge (1,537), mask texels 16 a cell
// from the edge (4,096), the largest position a bilinear read starts from each in a field's own units, and the cells to a page and across a window
export const PAGE_GEOM = { fine: 4, grid: 6, mask: 16, fineMax: 1019.999, gridMax: 1535.999, pageCells: 64, cells: 256, cellM: 75 };
export function pageWGSL({ fine = PAGE_LAYERS.fine, grid = PAGE_LAYERS.grid } = {}) {
  return /* wgsl */ `
// the slot a page (0 to 3 each way) is read from, and the page whose range a position is held to (the page itself when it is resident)
fn pgOf(p: vec2u) -> vec3i {
  let pi = vec2i(p);
  let v = pgTab(u32(pi.y * 4 + pi.x));
  if (v >= 0) { return vec3i(v, pi.x, pi.y); }
  let l = vec2i((-v - 2) & 3, (-v - 2) >> 2u);
  return vec3i(max(pgTab(u32(l.y * 4 + l.x)), 0), l.x, l.y);
}
fn pgTile(s: i32, n: i32) -> vec2i { return vec2i(s & 3, (s >> 2u) & 3) * n; }
// where the window's fine vertex i lies in the atlas: the texel (x, y) of the page's first layer and the group's first layer; any layer's four texels from it
fn pgFineAt(i: vec2i) -> vec3i {
  let w = i + vec2i(2);
  let s = pgOf(min(vec2u(w) >> vec2u(8u), vec2u(3u)));
  let c = clamp(w - 256 * s.yz, vec2i(0), vec2i(255));
  let o = pgTile(s.x, 257) + c;
  return vec3i(o.x, o.y, (s.x >> 4u) * ${fine});
}
// the fine layer L at that vertex and the three after it (right, down, both)
fn pgFineLd(t: texture_2d_array<f32>, a: vec3i, L: i32) -> vec4f {
  let o = a.xy;
  let z = a.z + L;
  return vec4f(textureLoad(t, o, z, 0).x, textureLoad(t, o + vec2i(1, 0), z, 0).x, textureLoad(t, o + vec2i(0, 1), z, 0).x, textureLoad(t, o + vec2i(1, 1), z, 0).x);
}
fn pgFineQ(t: texture_2d_array<f32>, L: i32, i: vec2i) -> vec4f { return pgFineLd(t, pgFineAt(i), L); }
// the grid layer L (0 to 4 are the pages', the window's own layers 5 and 6 are not read here) at the window's node i and the next each way, held to the last node
fn pgGridQ(t: texture_2d_array<f32>, L: i32, i: vec2i) -> vec4f {
  let s = pgOf(min(vec2u(i) / vec2u(384u), vec2u(3u)));
  let c = clamp(i - 384 * s.yz, vec2i(0), vec2i(384));
  let c1 = min(c + vec2i(1), vec2i(384));
  let o = pgTile(s.x, 385);
  let z = (s.x >> 4u) * ${grid} + L;
  return vec4f(textureLoad(t, o + c, z, 0).x, textureLoad(t, o + vec2i(c1.x, c.y), z, 0).x, textureLoad(t, o + vec2i(c.x, c1.y), z, 0).x, textureLoad(t, o + c1, z, 0).x);
}
fn pgGridAt(t: texture_2d_array<f32>, L: i32, i: vec2i) -> f32 { return pgGridQ(t, L, i).x; }
// the stream mask at texels (x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1), each coordinate held to 0 to 4,095, as bytes: one page lookup when the four lie in one page
fn pgRiverQ(t: texture_2d<u32>, i0: vec2i) -> vec4f {
  let i = clamp(i0, vec2i(0), vec2i(4095));
  let j = clamp(i0 + vec2i(1), vec2i(0), vec2i(4095));
  if ((i.x >> 10u) == (j.x >> 10u) && (i.y >> 10u) == (j.y >> 10u)) {
    let s = pgOf(vec2u(i) >> vec2u(10u));
    let o = vec2i(s.x & 7, s.x >> 3u) * 1024 + (i & vec2i(1023));
    let d = j - i;
    return vec4f(f32(textureLoad(t, o, 0).x), f32(textureLoad(t, o + vec2i(d.x, 0), 0).x), f32(textureLoad(t, o + vec2i(0, d.y), 0).x), f32(textureLoad(t, o + d, 0).x)) / 255.0;
  }
  return vec4f(f32(pgRiver(t, i)), f32(pgRiver(t, vec2i(j.x, i.y))), f32(pgRiver(t, vec2i(i.x, j.y))), f32(pgRiver(t, j))) / 255.0;
}
// the stream mask at a texel (0 to 4,095 each way)
fn pgRiver(t: texture_2d<u32>, i: vec2i) -> u32 {
  let s = pgOf(min(vec2u(i) >> vec2u(10u), vec2u(3u)));
  let c = clamp(i - 1024 * s.yz, vec2i(0), vec2i(1023));
  return textureLoad(t, vec2i(s.x & 7, s.x >> 3u) * 1024 + c, 0).x;
}
// the four texels of a quad read between, as the bilinear of ground.wgsl.js g_fineAt and wgsl/objects.js bilin does
fn pgBil(q: vec4f, a: f32, b: f32) -> f32 { return (q.x * (1.0 - a) + q.y * a) * (1.0 - b) + (q.z * (1.0 - a) + q.w * a) * b; }
`;
}
