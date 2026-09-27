// Plasticine: the palette, a tiling sculpt texture (thumbprints, loop-tool combs, finger smears, pits, lumps and
// specks) and one Lambert material patched into clay: wrapped light with a saturated terminator (the light that
// scatters inside the clay), a soft waxy highlight and the sculpt texture in its normals.
import * as THREE from "three";

export const CLAY = {
  forest: "#3f6d2c", meadow: "#86b33f", heath: "#b8963c", marsh: "#77803a", rock: "#8e8b83", sand: "#e3c37e", soil: "#9c6b3a",
  sea: "#2a66b8", deep: "#214c94", shallow: "#3a86c8", lake: "#3a86c6", foam: "#f1ede2",
  oak: ["#3f7f2f", "#4e8c2a", "#35702f"], ash: ["#7aa93a", "#8db53c", "#6c9e36"], aspen: ["#b7c248", "#d6b43e", "#a9bd4a"],
  pine: ["#1f5a4a", "#255f3f", "#1b4f45"], trunk: "#6e4a2e", birch: "#d9d2bf", shrub: "#5d8a33", heather: "#8e5a86",
  stone: ["#8f8d88", "#7c7a76", "#a19d95", "#6f6c6a"], wood: "#8a5a33", woodEnd: "#c4955a", char: "#2b2522",
  skin: ["#f0b98f", "#c98b5e", "#8d5a3b", "#e8a67c", "#b87650"], hair: ["#3b2618", "#1e1a18", "#a4532a", "#d8b060", "#6b4a30"],
  flame: ["#ff5a1a", "#ff9a1e", "#ffd84a"], ember: "#ff6a1a", smoke: "#d8d4cc",
};

export const lin = (hex) => new THREE.Color(hex);
export const glsl = (hex) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// Tiling value noise, about -1..1, with `cells` lattice cells across the S x S tile.
function tileNoise(S, cells, rand) {
  const L = new Float32Array(cells * cells).map(() => rand() * 2 - 1), out = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * cells, fy = (y / S) * cells, i = Math.floor(fx), j = Math.floor(fy);
      let u = fx - i, v = fy - j;
      u = u * u * u * (u * (u * 6 - 15) + 10);
      v = v * v * v * (v * (v * 6 - 15) + 10);
      const a = L[(j % cells) * cells + (i % cells)], b = L[(j % cells) * cells + ((i + 1) % cells)];
      const c = L[((j + 1) % cells) * cells + (i % cells)], d = L[((j + 1) % cells) * cells + ((i + 1) % cells)];
      out[y * S + x] = (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    }
  return out;
}

// The sculpt texture: height in r, its slope across and along in g and b, mottle and specks in a.
export function sculptTexture(rand, S = 1024) {
  const H = new Float32Array(S * S), A = new Float32Array(S * S);
  const wrap = (v) => ((Math.round(v) % S) + S) % S;
  const add = (x, y, v) => { H[wrap(y) * S + wrap(x)] += v; };
  const n1 = tileNoise(S, 10, rand), n2 = tileNoise(S, 22, rand), n3 = tileNoise(S, 48, rand), warp = tileNoise(S, 64, rand);
  for (let i = 0; i < S * S; i++) { H[i] = 0.16 * n1[i] + 0.08 * n2[i] + 0.03 * n3[i]; A[i] = 0.5 + 0.22 * n1[(i * 7) % (S * S)] + 0.1 * n2[i]; }
  const warpAt = (x, y) => warp[wrap(Math.round(y)) * S + wrap(Math.round(x))];

  // Thumb strokes: the whole surface was pushed smooth by thumbs, each leaving a shallow oval scoop with clay
  // rolled up along the far side of the push.
  for (let n = 0; n < 40; n++) {
    const cx = rand() * S, cy = rand() * S, a = 45 + rand() * 90, ecc = 0.55 + rand() * 0.3, th = rand() * Math.PI * 2, depth = 0.12 + rand() * 0.18;
    const cs = Math.cos(th), sn = Math.sin(th), R = Math.ceil(a * 1.3);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const u = (dx * cs + dy * sn) / a, v = (-dx * sn + dy * cs) / (a * ecc), r = Math.hypot(u, v);
        if (r > 1.3) continue;
        const scoop = r < 1 ? -((1 - r * r) ** 1.5) : 0, lip = Math.exp(-(((r - 1.05) / 0.14) ** 2)) * sm(-0.6, 0.8, u);
        add(cx + dx, cy + dy, depth * (scoop + 0.55 * lip));
      }
  }

  // Thumb and finger prints: a shallow oval press with raised ridges in whorls, loops or arches, coarse enough that
  // a still at 1280 x 720 shows the rings.
  for (let n = 0; n < 28; n++) {
    const cx = rand() * S, cy = rand() * S, a = 90 + rand() * 70, ecc = 0.62 + rand() * 0.18, th = rand() * Math.PI * 2;
    const spacing = a / (4.5 + rand() * 1.5), type = rand(), spin = rand() < 0.5 ? 1 : -1, press = 0.2 + rand() * 0.1, ridgeAmp = 0.3 + rand() * 0.1;
    const cs = Math.cos(th), sn = Math.sin(th), R = Math.ceil(a * 1.05);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const u = (dx * cs + dy * sn) / a, v = (-dx * sn + dy * cs) / (a * ecc), r = Math.hypot(u, v);
        if (r > 1.02) continue;
        const mask = sm(1.02, 0.5, r), wv = warpAt(cx + dx, cy + dy);
        let ph;
        if (type < 0.45) ph = (r * a) / spacing + (spin * Math.atan2(v, u)) / (Math.PI * 2);
        else if (type < 0.8) { const lv = v + 0.35 - 0.9 * u * u; ph = (Math.hypot(u * 0.6, lv) * a) / spacing; }
        else ph = ((v + 0.6 * (1 - u * u)) * a * ecc) / spacing;
        ph += wv * 0.35;
        const ridge = Math.pow(0.5 + 0.5 * Math.cos(ph * Math.PI * 2), 2.2) - 0.3;
        // A press flattens whatever was under it, so overlapping prints show the last one's rings, not a moire.
        const k = wrap(cy + dy) * S + wrap(cx + dx);
        H[k] = H[k] * (1 - 0.85 * mask) + mask * (-press * (1 - r * r) + ridgeAmp * ridge * (wv > -0.55 ? 1 : 0.2));
      }
  }
  // Loop-tool combs (parallel grooves) and scoops (a smooth channel with raised lips).
  for (let n = 0; n < 16; n++) {
    const x0 = rand() * S, y0 = rand() * S, th = rand() * Math.PI * 2, L = 150 + rand() * 270, W = 22 + rand() * 38, bend = (rand() - 0.5) * 0.5;
    const comb = rand() < 0.6, k = 3 + Math.floor(rand() * 3), depth = 0.2 + rand() * 0.2, cs = Math.cos(th), sn = Math.sin(th);
    const R = Math.ceil(L + W * 2);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const al = dx * cs + dy * sn, t = al / L;
        if (t < -0.05 || t > 1.05) continue;
        const ac = -dx * sn + dy * cs - bend * t * t * L, s = ac / (W / 2);
        if (Math.abs(s) > 1.5) continue;
        const fade = sm(-0.05, 0.12, t) * sm(1.05, 0.82, t);
        let p;
        if (comb) p = Math.abs(s) < 1 ? -depth * 0.6 * (0.5 + 0.5 * Math.cos(Math.PI * s * k)) * (1 - s * s * 0.3) : 0;
        else p = Math.abs(s) < 1 ? -depth * (1 - s * s) : depth * 0.45 * Math.exp(-(((Math.abs(s) - 1.12) / 0.16) ** 2));
        add(x0 + dx, y0 + dy, p * fade);
      }
  }
  // Finger smears: a broad drag that piles clay up where it stops.
  for (let n = 0; n < 14; n++) {
    const x0 = rand() * S, y0 = rand() * S, th = rand() * Math.PI * 2, L = 120 + rand() * 220, W = 30 + rand() * 40, cs = Math.cos(th), sn = Math.sin(th);
    const R = Math.ceil(L + W);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const t = (dx * cs + dy * sn) / L, s = (-dx * sn + dy * cs) / (W / 2);
        if (t < -0.1 || t > 1.15 || Math.abs(s) > 1) continue;
        const across = 1 - s * s, grow = sm(-0.1, 0.9, t);
        add(x0 + dx, y0 + dy, across * (-0.14 * grow * sm(1.08, 0.95, t) + 0.3 * Math.exp(-(((t - 1.02) / 0.06) ** 2))));
      }
  }
  // Pits and nicks.
  for (let n = 0; n < 420; n++) {
    const cx = rand() * S, cy = rand() * S, r = 1.5 + rand() * rand() * 6, R = Math.ceil(r * 1.6);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / r;
        add(cx + dx, cy + dy, d < 1 ? -0.22 * (1 - d * d) : 0.05 * Math.exp(-(((d - 1.2) / 0.2) ** 2)));
      }
  }
  // Specks: lint and crumbs of other clay pressed in.
  for (let n = 0; n < 900; n++) {
    const cx = Math.floor(rand() * S), cy = Math.floor(rand() * S), v = rand() < 0.75 ? 0 : 1, r = rand() < 0.8 ? 1 : 2;
    for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) A[wrap(cy + dy) * S + wrap(cx + dx)] = v;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  // Slopes are stored squashed (x / (1 + |x|)) so broad thumb scoops still tilt the normal while fine ridges saturate.
  const d = new Uint8Array(S * S * 4), G = 100, sq = (g) => { const x = g * G; return x / (1 + Math.abs(x)); };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x, gx = (H[y * S + wrap(x + 1)] - H[y * S + wrap(x - 1)]) * 0.5, gy = (H[wrap(y + 1) * S + x] - H[wrap(y - 1) * S + x]) * 0.5;
      d[i * 4] = ((H[i] - lo) / (hi - lo)) * 255;
      d[i * 4 + 1] = Math.max(0, Math.min(255, 128 + sq(gx) * 127));
      d[i * 4 + 2] = Math.max(0, Math.min(255, 128 + sq(gy) * 127));
      d[i * 4 + 3] = Math.max(0, Math.min(255, A[i] * 255));
    }
  return dataTex(d, S, true);
}

// Soft tiling noise in four octaves, one per channel, for wobbling and marbling borders.
export function noiseTexture(rand, S = 256) {
  const o = [4, 8, 16, 32].map((c) => tileNoise(S, c, rand)), d = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 4; c++) d[i * 4 + c] = Math.max(0, Math.min(255, 128 + o[c][i] * 150));
  return dataTex(d, S, true);
}

export function dataTex(data, w, h = w, repeat = false) {
  if (typeof h === "boolean") { repeat = h; h = w; }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export const shared = { tSculpt: { value: null }, tNoise: { value: null } };

const PRELUDE = /* glsl */ `
uniform sampler2D tSculpt; uniform sampler2D tNoise;
uniform float uDetail, uBump, uSpec, uShine, uWrap, uScatter, uFoot, uObjH, uRim, uMottle, uCavity;
varying vec3 vW; varying vec3 vWN; varying float vObjY;
float gSpec = 0.0, gShine = 20.0, gAO = 1.0, gH = 0.5, gBump = 1.0;
vec3 gWN = vec3( 0.0, 1.0, 0.0 ), gExtra = vec3( 0.0 );
vec4 gSculpt = vec4( 0.5 );
// The sculpt texture over the surface, projected three ways and blended by the normal: a height, a world-space
// slope to tilt the normal by, and the mottle channel.
vec4 sculpt( vec3 p, vec3 n, float scale, out vec3 slope ) {
  vec3 b = abs( n ); b = b * b; b = b * b; b /= b.x + b.y + b.z;
  vec4 t = vec4( 0.0 ); slope = vec3( 0.0 );
  if ( b.x > 0.02 ) { vec4 c = texture2D( tSculpt, p.zy * scale + 0.13 ); vec2 g = c.gb * 2.0 - 1.0; t += c * b.x; slope += b.x * vec3( 0.0, g.y, g.x ); }
  if ( b.y > 0.02 ) { vec4 c = texture2D( tSculpt, p.xz * scale + 0.41 ); vec2 g = c.gb * 2.0 - 1.0; t += c * b.y; slope += b.y * vec3( g.x, 0.0, g.y ); }
  if ( b.z > 0.02 ) { vec4 c = texture2D( tSculpt, p.xy * scale + 0.77 ); vec2 g = c.gb * 2.0 - 1.0; t += c * b.z; slope += b.z * vec3( g.x, g.y, 0.0 ); }
  return t;
}
// World-space slope of a height computed in the fragment, for a ground that faces up: from its screen derivatives.
vec2 groundSlope( float r ) {
  vec2 px = dFdx( vW.xz ), py = dFdy( vW.xz );
  float rx = dFdx( r ), ry = dFdy( r ), det = px.x * py.y - px.y * py.x;
  return abs( det ) < 1e-12 ? vec2( 0.0 ) : vec2( rx * py.y - ry * px.y, ry * px.x - rx * py.x ) / det;
}
`;

const CLAY_PARS = /* glsl */ `
varying vec3 vViewPosition;
struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
void RE_Direct_Clay( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float d = dot( geometryNormal, directLight.direction );
  float lit = saturate( ( d + uWrap ) / ( 1.0 + uWrap ) );
  // Light that enters the clay comes back out past the terminator, deeper and more saturated than the surface.
  float band = saturate( 1.0 - abs( d - 0.02 ) * 2.4 ) * uScatter;
  vec3 dc = material.diffuseColor;
  reflectedLight.directDiffuse += directLight.color * ( lit * lit * ( 1.6 - 0.6 * lit ) * dc + band * dc * dc * 1.8 ) * RECIPROCAL_PI;
  vec3 h = normalize( directLight.direction + geometryViewDir );
  float nh = saturate( dot( geometryNormal, h ) ), nv = saturate( dot( geometryNormal, geometryViewDir ) );
  float s = pow( nh, gShine ) + 0.18 * pow( nh, gShine * 0.15 );
  s *= gSpec * saturate( d * 3.0 + 0.05 ) * ( 0.8 + 1.2 * pow( 1.0 - nv, 4.0 ) );
  reflectedLight.directSpecular += directLight.color * s * RECIPROCAL_PI;
}
void RE_IndirectDiffuse_Clay( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Clay
#define RE_IndirectDiffuse RE_IndirectDiffuse_Clay
`;

// A clay material. `color` runs before the sculpt normal is applied and may change diffuseColor, gSpec, gShine,
// gAO, gBump and gExtra (an extra world-space slope); by default objects get a darker foot (vObjY over uObjH).
// With `tint`, only the vertices marked by aTint take the instance color.
export function clayMaterial({ detail = 1, bump = 1, spec = 0.22, shine = 24, wrap = 0.45, scatter = 0.5, foot = 0.55, objH = 1, rim = 0.05, mottle = 0.12, cavity = 0.35, color = "", decl = "", vdecl = "", vcode = "", emissive = 0x000000, side = THREE.FrontSide, tint = false, key = "" } = {}) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, emissive, side });
  const own = {
    uDetail: { value: detail }, uBump: { value: bump }, uSpec: { value: spec }, uShine: { value: shine }, uWrap: { value: wrap },
    uScatter: { value: scatter }, uFoot: { value: foot }, uObjH: { value: objH }, uRim: { value: rim }, uMottle: { value: mottle }, uCavity: { value: cavity },
  };
  m.userData.uniforms = own;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, own);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vW; varying vec3 vWN; varying float vObjY; uniform float uObjH;\n${tint ? "attribute float aTint;" : ""}\n${vdecl}`)
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 pw = vec4( transformed, 1.0 ); vec3 nw = objectNormal;
        #ifdef USE_INSTANCING
          pw = instanceMatrix * pw; nw = mat3( instanceMatrix ) * nw;
        #endif
        vW = ( modelMatrix * pw ).xyz;
        vWN = normalize( mat3( modelMatrix ) * nw );
        vObjY = transformed.y / uObjH;
        ${tint ? "#if defined( USE_INSTANCING_COLOR ) && defined( USE_COLOR )\n vColor.rgb = mix( color.rgb, color.rgb * instanceColor.rgb, aTint );\n#endif" : ""}
        ${vcode}`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${PRELUDE}\n${decl}`)
      .replace("#include <lights_lambert_pars_fragment>", CLAY_PARS)
      .replace("#include <normal_fragment_maps>", `
        gWN = normalize( vWN ) * faceDirection;
        vec3 slope;
        gSculpt = sculpt( vW, gWN, uDetail, slope );
        gH = gSculpt.r;
        gSpec = uSpec; gShine = uShine;
        gAO = mix( uFoot, 1.0, smoothstep( 0.0, 0.35, vObjY ) );
        ${color}
        vec3 nW = normalize( gWN - slope * uBump * gBump - gExtra );
        normal = normalize( ( viewMatrix * vec4( nW, 0.0 ) ).xyz );
        diffuseColor.rgb *= ( 1.0 - uCavity * 0.5 ) + uCavity * gH;
        diffuseColor.rgb *= 1.0 + ( gSculpt.a - 0.5 ) * uMottle * 2.0;
        diffuseColor.rgb *= gSculpt.a < 0.04 ? 0.45 : 1.0;
        diffuseColor.rgb = gSculpt.a > 0.97 ? mix( diffuseColor.rgb, vec3( 0.85, 0.78, 0.66 ), 0.55 ) : diffuseColor.rgb;
        gSpec *= 0.55 + 0.9 * gH;`)
      .replace("#include <aomap_fragment>", "reflectedLight.indirectDiffuse *= gAO; reflectedLight.directDiffuse *= mix( 1.0, gAO, 0.5 );")
      .replace(
        "vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;",
        `float nvR = saturate( dot( normal, normalize( vViewPosition ) ) );
         vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular * gAO + totalEmissiveRadiance
           + uRim * pow( 1.0 - nvR, 3.0 ) * gAO * vec3( 0.9, 0.95, 1.0 );`,
      );
  };
  m.customProgramCacheKey = () => key + tint + color + decl + vcode + vdecl;
  return m;
}

// Soft PCF: the stock five taps turn to dither at a wide radius, so take more.
export function softerShadows(taps = 12) {
  const re = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/;
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!re.test(src)) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = src.replace(re, `shadow = 0.0;
    for ( int k = 0; k < ${taps}; k ++ ) shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( k, ${taps}, phi ) * radius, shadowCoord.z ) );
    shadow /= ${taps}.0;`);
}
