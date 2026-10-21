// What lies on the bedrock of a patch of the planet: the island's till (wgsl/terrain-upstream.ts `till` in its window format) on a square grid of any side. The ground the
// ice laid is clay till over soft rock and sandy till over the crystalline basement where the bed lies under the ground round it, none on a ridge (R530, TILL_MAX 5 m under
// the ground around to none 5 m over); "the ground round it" is the height blurred by six passes of nine-cell box means (the island's blur, edges repeated: the patch's halo
// keeps the edge out of the tile). Fields of F, S * S words each, heights in Q16 m: h, land, rock, till (the thickness the place's ice laid, Q16 m), t1, t2, ar, drift, dd.
import { FIXED } from "./fixed";
import { BARE, GRANITE, DOLERITE, TILL_CLAY, TILL_SAND } from "../../terrain/geology";

export const TF = ["h", "land", "rock", "till", "t1", "t2", "ar", "drift", "dd"] as const;
export const ZQ = 2 ** 16;
// A window's heights reach kilometres above and below the sea: the box's offset keeps a sea floor 8 km deep positive (terrain-upstream.ts BOFF for a window).
const BOFF = 8192 * ZQ;

export const terrainWgsl = (side: number) => /* wgsl */ `${FIXED}
const S = ${side}u;
const LEN = ${side * side}u;
${TF.map((n, k) => `const f_${n}: u32 = ${k * side * side}u;`).join("\n")}
const BOFF = ${BOFF}i;
const GRANITE = ${GRANITE}i; const DOLERITE = ${DOLERITE}i;
const BARE = ${BARE}i; const TILL_CLAY = ${TILL_CLAY}i; const TILL_SAND = ${TILL_SAND}i;
@group(0) @binding(0) var<storage, read_write> F: array<i32>;
fn touch() { _ = arrayLength(&F); }
fn gi(f: u32, i: u32) -> i32 { return F[f + i]; }
fn wi(f: u32, i: u32, v: i32) { F[f + i] = v; }
fn crystalline(r: i32) -> bool { return r == GRANITE || r == DOLERITE; }
fn umulsh(a: u32, b: u32, s: u32) -> u32 { let p = add64(mul64(a, b), vec2u(1u << (s - 1u), 0u)); return (p.x >> s) | (p.y << (32u - s)); }
// nine cells' mean along x or y with the edge repeated: the sum is kept as high and low 10-bit parts and divided exactly, as the island's blur does
fn blur(src: u32, dst: u32, i: u32, across: bool) {
  let x = i32(i % S); let y = i32(i / S);
  var shi = 0u; var slo = 0u;
  for (var k = -4i; k <= 4i; k++) {
    var xx = x; var yy = y;
    if (across) { xx = clamp(x + k, 0i, i32(S) - 1i); } else { yy = clamp(y + k, 0i, i32(S) - 1i); }
    let v = u32(gi(src, u32(yy) * S + u32(xx)) + BOFF);
    shi += v >> 10u; slo += v & 1023u;
  }
  let a = shi / 9u; let r = shi - a * 9u;
  wi(dst, i, i32((a << 10u) + (r * 1024u + slo + 4u) / 9u) - BOFF);
}
@compute @workgroup_size(256) fn blur0(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_h, f_t1, g.x, true); } }
@compute @workgroup_size(256) fn blur1(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_t1, f_t2, g.x, false); } }
@compute @workgroup_size(256) fn blur2(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_t2, f_t1, g.x, true); } }
@compute @workgroup_size(256) fn blur3(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_t1, f_t2, g.x, false); } }
@compute @workgroup_size(256) fn blur4(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_t2, f_t1, g.x, true); } }
@compute @workgroup_size(256) fn blur5(@builtin(global_invocation_id) g: vec3u) { touch(); if (g.x < LEN) { blur(f_t1, f_ar, g.x, false); } }
// TILL_MAX clamp(0.5 - (bed - around) / 10, 0, 1): 5 m under the ground around gives all of it, 5 m over none
@compute @workgroup_size(256)
fn till(@builtin(global_invocation_id) g: vec3u) {
  touch();
  let i = g.x;
  if (i >= LEN) { return; }
  if (gi(f_land, i) == 0i) { wi(f_drift, i, 0i); wi(f_dd, i, 0i); return; }
  let bed = gi(f_h, i); let thick0 = u32(gi(f_till, i));
  var kind = TILL_CLAY; var thick = i32(thick0);
  if (crystalline(gi(f_rock, i))) {
    let arg = clamp((1i << 23u) - (clamp(bed - gi(f_ar, i), ${-16 * ZQ}i, ${16 * ZQ}i) * ${(2 ** 24 * 5) / (10 * ZQ)}i) / 5i, 0i, 1i << 24u);
    thick = i32(umulsh(thick0, u32(arg), 24u));
    kind = select(BARE, TILL_SAND, thick > 0i);
  }
  wi(f_drift, i, kind); wi(f_dd, i, thick);
}
`;
