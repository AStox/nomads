// GLSL for the g-buffer pass. Every visible surface writes (gray light, class, object id, distance) and
// (normal, outline flags); the dither and the ink lines happen later, on the CPU, from those two buffers.

const NOISE = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return s; }
`;

const SKY = /* glsl */ `
uniform vec3 sunDir; uniform vec2 windDir; uniform float skyTop, skyHorizon, cloudCover;
float skyGray(vec3 d) {
  float h = max(d.y, 0.0);
  float g = mix(skyHorizon, skyTop, pow(h, 0.5));
  // Long banks of cloud laid along the wind, pale on top and dark underneath.
  vec2 p = d.xz / (h + 0.05);
  p = vec2(dot(p, windDir), dot(p, vec2(-windDir.y, windDir.x)));
  float c = fbm(p * vec2(0.16, 0.7) + vec2(5.3, 1.7));
  float cov = smoothstep(cloudCover, cloudCover + 0.12, c) * smoothstep(0.0, 0.08, h);
  float sd = dot(d, sunDir);
  float body = smoothstep(cloudCover + 0.04, cloudCover + 0.3, c);
  g = mix(g, mix(0.86, 0.34, body) + 0.35 * pow(max(sd, 0.0), 5.0), cov);
  g += 0.22 * pow(max(sd, 0.0), 14.0) + 0.7 * pow(max(sd, 0.0), 300.0);
  if (sd > 0.99965) g = 3.0;
  return g;
}
`;

const SHADOW = /* glsl */ `
uniform sampler2D shadowMap; uniform mat4 shM0, shM1; uniform vec2 shTexel, shOff, shBias;
float pcf(vec2 uv, float z) {
  float s = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += step(z, texture(shadowMap, uv + vec2(float(x), float(y)) * shTexel).r);
  return s / 9.0;
}
float shadowAt(vec3 p, vec3 n) {
  vec4 a = shM0 * vec4(p + n * shOff.x, 1.0);
  if (a.x > 0.003 && a.x < 0.997 && a.y > 0.003 && a.y < 0.997 && a.z < 1.0) return pcf(vec2(a.x * 0.5, a.y), a.z - shBias.x);
  vec4 b = shM1 * vec4(p + n * shOff.y, 1.0);
  if (b.x < 0.0 || b.x > 1.0 || b.y < 0.0 || b.y > 1.0 || b.z > 1.0) return 1.0;
  return pcf(vec2(0.5 + clamp(b.x, 0.003, 0.997) * 0.5, b.y), b.z - shBias.y);
}
`;

const LIGHT = /* glsl */ `
uniform vec3 camPos, firePos; uniform float sunI, ambI, fogDist, fogGray, fogLow, fireI, fireR, logC;
float light(vec3 p, vec3 n, float alb, float ao, float hard) {
  float ndl = dot(n, sunDir);
  float sh = ndl > 0.0 ? shadowAt(p, n) : 0.0;
  // Hard light snaps the sun to two tones, a lit side and a shade side, the way a crown reads in one bit.
  float d = max(ndl, 0.0) * sh;
  d = mix(d, step(0.2, d) * 0.75, hard);
  float L = alb * (ambI * ao * (0.5 + 0.5 * n.y) * (1.0 - 0.5 * hard) + sunI * d);
  vec3 fd = firePos - p; float f2 = dot(fd, fd);
  L += alb * fireI * max(dot(n, fd * inversesqrt(f2 + 1e-4)) * 0.75 + 0.25, 0.0) / (1.0 + f2 / (fireR * fireR));
  return L;
}
float fog(float L, float dist, float y) {
  float a = 1.0 - exp(-(dist / fogDist) * (1.0 + fogLow * exp(-max(y, 0.0) / 35.0)));
  return mix(L, fogGray, a);
}
`;

const OUT = /* glsl */ `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
`;

export const solidVS = /* glsl */ `
attribute float aAlb; attribute float aCls; attribute float aMask; attribute float aAO;
#ifdef USE_INSTANCING
attribute float iTint; attribute float iId;
#endif
uniform float pxScale, silPx, crPx, uUnit, uTintAmt;
out vec3 vW; out float vAlb; out float vAO; flat out float vCls; flat out float vId; flat out float vFlags; out float vLogZ;
void main() {
  mat4 m = modelMatrix; float tint = 0.5, id = 0.0, size = uUnit;
#ifdef USE_INSTANCING
  m = m * instanceMatrix; tint = iTint; id = iId; size *= length(instanceMatrix[1].xyz);
#endif
  vec4 wp = m * vec4(position, 1.0);
  vW = wp.xyz; vAO = aAO; vId = id;
#ifdef TERRAIN
  vAlb = aAlb; vCls = 1.0;
#else
  vAlb = aAlb * (1.0 + aMask * (tint - 0.5) * uTintAmt); vCls = aCls;
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
  float px = size / max(gl_Position.w, 0.001) * pxScale;
  vFlags = (px > silPx ? 1.0 : 0.0) + (px > crPx ? 2.0 : 0.0);
#ifdef TERRAIN
  vFlags = 1.0 + (px > crPx ? 2.0 : 0.0);
#endif
  vLogZ = 1.0 + gl_Position.w;
}
`;

export const solidFS = /* glsl */ `
precision highp float;
${NOISE}${SKY}${SHADOW}${LIGHT}${OUT}
uniform float uFlat, uHard;
in vec3 vW; in float vAlb; in float vAO; flat in float vCls; flat in float vId; flat in float vFlags; in float vLogZ;
void main() {
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  vec3 V = camPos - vW; float dist = length(V); V /= dist;
  if (dot(n, V) < 0.0) n = -n;
  bool fire = abs(vCls - 5.0) < 0.5;
  // Things too small to show their facets are lit as the ground they stand on, so they don't dither into static.
  float L = fire ? 3.0 : light(vW, normalize(mix(n, vec3(0.0, 1.0, 0.0), uFlat)), vAlb, vAO, uHard);
  o0 = vec4(fire ? L : fog(L, dist, vW.y), vCls, vId, dist);
  o1 = vec4(n, vFlags);
  gl_FragDepth = log2(vLogZ) * logC * 0.5;
}
`;

export const plainVS = /* glsl */ `
out vec3 vW; out float vLogZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  vLogZ = 1.0 + gl_Position.w;
}
`;

export const waterFS = /* glsl */ `
precision highp float;
${NOISE}${SKY}${SHADOW}${LIGHT}${OUT}
uniform sampler2D heightTex; uniform vec3 hGrid; uniform float pxScale, isoLines;
in vec3 vW; in float vLogZ;
vec2 ground(vec2 p) {
  vec2 f = clamp((p - hGrid.x) / hGrid.y, vec2(0.0), vec2(hGrid.z - 1.001));
  vec2 i = floor(f), t = f - i; ivec2 k = ivec2(i);
  vec2 a = texelFetch(heightTex, k, 0).rg, b = texelFetch(heightTex, k + ivec2(1, 0), 0).rg;
  vec2 c = texelFetch(heightTex, k + ivec2(0, 1), 0).rg, d = texelFetch(heightTex, k + ivec2(1, 1), 0).rg;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
// Slope of wind-driven chop: crests long across the wind, each octave fading out before it is too fine for a pixel.
vec2 waves(vec2 p, float dist) {
  vec2 wd = windDir, wp = vec2(-windDir.y, windDir.x), q = vec2(dot(p, wd), dot(p, wp)), g = vec2(0.0);
  float wl = 26.0, amp = 0.11;
  for (int k = 0; k < 5; k++) {
    float fade = smoothstep(2.5, 7.0, wl * pxScale / dist), e = 0.03;
    vec2 s = q / wl * vec2(1.0, 0.28) + float(k) * 7.13;
    float h0 = vnoise(s);
    vec2 d = vec2(vnoise(s + vec2(e, 0.0)) - h0, vnoise(s + vec2(0.0, e)) - h0) / e * vec2(1.0, 0.28);
    g += (wd * d.x + wp * d.y) * amp * fade;
    wl *= 0.55; amp *= 0.85;
  }
  return g;
}
void main() {
  vec3 V = camPos - vW; float dist = length(V); V /= dist;
  vec2 g = waves(vW.xz, dist);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 R = reflect(-V, n); R.y = abs(R.y);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec2 gr = ground(vW.xz);
  vec2 lo = vec2(hGrid.x), hi = vec2(hGrid.x + hGrid.y * (hGrid.z - 1.0));
  gr.y += length(vW.xz - clamp(vW.xz, lo, hi));
  float depth = vW.y - gr.x;
  float sh = shadowAt(vW, vec3(0.0, 1.0, 0.0));
  float body = 0.1 + 0.34 * exp(-max(depth, 0.0) / 2.5);
  float L = body * (ambI + sunI * sunDir.y * sh);
  L = mix(L, skyGray(R) * (0.45 + 0.55 * sh), fres);
  L += 5.0 * pow(max(dot(R, sunDir), 0.0), 500.0) * sh;
  float foam = 1.0 - smoothstep(0.15, 0.7, depth + 0.35 * vnoise(vW.xz * 0.25));
  L = mix(L, 1.25, foam);
  // Water-lining, as on an engraved chart: lines following the coast out to sea, wider apart as they go.
  float cls = 4.0;
  if (isoLines > 0.5 && gr.y > 90.0 && gr.y < 1700.0) {
    float v = sqrt(gr.y / 42.0), fw = fwidth(v);
    if (abs(fract(v + 0.5) - 0.5) < fw * 0.55) cls = 6.0;
  }
  o0 = vec4(fog(L, dist, vW.y), cls, 0.0, dist);
  o1 = vec4(0.0, 1.0, 0.0, 1.0);
  gl_FragDepth = log2(vLogZ) * logC * 0.5;
}
`;

export const lineFS = /* glsl */ `
precision highp float;
${OUT}
uniform vec3 camPos; uniform float logC;
in vec3 vW; in float vLogZ;
void main() {
  o0 = vec4(0.0, 6.0, 0.0, length(camPos - vW));
  o1 = vec4(0.0, 1.0, 0.0, 1.0);
  gl_FragDepth = log2(vLogZ) * logC * 0.5;
}
`;

export const skyVS = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}
`;

export const skyFS = /* glsl */ `
precision highp float;
${NOISE}${SKY}${OUT}
in vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  o0 = vec4(skyGray(d), 0.0, 0.0, 1e7);
  o1 = vec4(-d, 0.0);
  gl_FragDepth = 1.0;
}
`;

export const shadowVS = /* glsl */ `
void main() {
  mat4 m = modelMatrix;
#ifdef USE_INSTANCING
  m = m * instanceMatrix;
#endif
  gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
}
`;

export const shadowFS = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o;
void main() { o = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); }
`;
