// Shared GLSL: noise, the paper, and the three buffers every object paints into (wash color, what it is, where it is).

export const NOISE = `
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.7;
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * gnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}
float fbm2(vec2 p) { return 0.5 * gnoise(p) + 0.25 * gnoise(p * 2.03 + vec2(17.1, 9.3)); }
// Cold-press tooth: lumps of a few pixels over a slower swell.
float paperH(vec2 p) {
  return clamp(0.5 + 0.26 * gnoise(p / 4.6) + 0.16 * gnoise(p / 2.1 + 7.0) + 0.13 * gnoise(p / 10.0 + 3.0), 0.0, 1.0);
}
`;

// Classes written into the info buffer; the paint passes treat each differently.
export const CLS = { sky: 0, water: 1, ground: 2, crown: 3, wood: 4, shrub: 5, rock: 6, blade: 7, tent: 8, person: 9, fire: 10, flower: 11 };

export const OUT = `
layout(location = 0) out vec4 oCol;
layout(location = 1) out vec4 oInfo;
layout(location = 2) out vec4 oAux;
uniform vec3 uAnchor, uLight;
// A wash of color c, with an integer id, view depth, class, and an ink amount the pen should trace here.
void emit(vec3 c, float id, float depth, float cls, float ink, vec3 wpos) {
  oCol = vec4(c, 1.0);
  // half floats end at 65504; the far sea would overflow them
  oInfo = vec4(id, min(depth, 60000.0), cls, ink);
  oAux = vec4(clamp(wpos - uAnchor, -60000.0, 60000.0), 0.0);
}
vec3 absorb(vec3 c) { return -log(max(c, vec3(0.02))); }
// Pigment glazed over a wash: transmittances multiply, so this is the wash seen through k layers of g.
vec3 over(vec3 c, vec3 g, float k) { return c * pow(max(g, vec3(0.02)), vec3(k)); }
// A hard, anti-aliased wash edge where v crosses zero.
float cut(float v) { return clamp(0.5 + v / max(fwidth(v), 1e-5), 0.0, 1.0); }
`;

// Display values straight from the hex (THREE.Color would linearize them; the paint works in display values).
export const hex3 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export const vec3 = (h) => `vec3(${hex3(h).map((v) => v.toFixed(4)).join(", ")})`;
