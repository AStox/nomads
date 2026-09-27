// Paper: the palette, a fiber grain, and one Lambert material patched for card. Wrapped light (paper scatters),
// light through thin sheets, a baked shadow of the sheets above, and grain in model millimeters.
import * as THREE from "three";

export const PAPER = {
  forest: "#2d6a45", meadow: "#a9bb5c", heath: "#b48fd0", rock: "#aaa296", sand: "#f0dfb0", marsh: "#8aa46c",
  water: "#4d8fca", deep: "#2f5f9a", shallow: "#7db7d8", foam: "#eef5f4", spacer: "#4a4540",
  pine: "#23594a", oak: "#3f7c39", ash: "#6f9d3a", aspen: "#a9b447", gold: "#d9a33a", rust: "#c9683a",
  trunk: "#7a5134", kraft: "#b48a5e", mat: "#2c3a37", desk: "#4e3424",
};

function canvas(w, h = w) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

// Paper fiber: short light and dark fibers over a soft mottle, in the red channel; soft tiling noise in g, b, a
// for cut wobble.
export function grainTexture(rand) {
  const S = 512, f = canvas(S), fg = f.getContext("2d", { willReadFrequently: true });
  fg.fillStyle = "rgb(128,128,128)";
  fg.fillRect(0, 0, S, S);
  fg.lineCap = "round";
  for (let k = 0; k < 9000; k++) {
    const x = rand() * S, y = rand() * S, a = rand() * Math.PI, l = 3 + rand() * 14, light = rand() < 0.55;
    fg.strokeStyle = light ? `rgba(255,255,255,${0.25 + rand() * 0.3})` : `rgba(0,0,0,${0.18 + rand() * 0.25})`;
    fg.lineWidth = 0.9 + rand() * 1.4;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox < -20 || x + ox > S + 20 || y + oy < -20 || y + oy > S + 20) continue;
      fg.beginPath();
      fg.moveTo(x + ox, y + oy);
      fg.quadraticCurveTo(x + ox + Math.cos(a + 0.5) * l * 0.5, y + oy + Math.sin(a + 0.5) * l * 0.5, x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
      fg.stroke();
    }
  }
  const fib = fg.getImageData(0, 0, S, S).data;
  const d = new Uint8ClampedArray(S * S * 4);
  const mottle = tileNoise(S, 8, rand), n1 = tileNoise(S, 4, rand), n2 = tileNoise(S, 16, rand), n3 = tileNoise(S, 32, rand);
  for (let i = 0; i < S * S; i++) {
    d[i * 4] = 128 + mottle[i] * 70 + n2[i] * 25 + (rand() - 0.5) * 24 + (fib[i * 4] - 128) * 0.8;
    d[i * 4 + 1] = 128 + n1[i] * 120;
    d[i * 4 + 2] = 128 + n2[i] * 120;
    d[i * 4 + 3] = 128 + n3[i] * 120;
  }
  // A data texture, not a canvas: a canvas premultiplies alpha and would crush the noise kept in that channel.
  const t = new THREE.DataTexture(new Uint8Array(d.buffer), S, S, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

// Tiling value noise, roughly -1..1, with `cells` lattice cells across.
function tileNoise(S, cells, rand) {
  const lat = new Float32Array(cells * cells).map(() => rand() * 2 - 1), out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = (x / S) * cells, fy = (y / S) * cells, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const L = (i, j) => lat[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)];
    out[y * S + x] = (L(ix, iy) * (1 - sx) + L(ix + 1, iy) * sx) * (1 - sy) + (L(ix, iy + 1) * (1 - sx) + L(ix + 1, iy + 1) * sx) * sy;
  }
  return out;
}

export const shared = {
  tGrain: { value: null }, uGrainScale: { value: 1 }, tBake: { value: null }, uRegion: { value: new THREE.Vector4() },
  tCls1: { value: null }, tCls2: { value: null }, uWobble: { value: new THREE.Vector2(1, 0.1) }, uEdge: { value: 1 },
  tSheets: { value: null }, uSheetPx: { value: 1 }, uCont: { value: 2.6 }, uGuide: { value: 5 }, uPatch: { value: 0.01 },
};

const PRELUDE = /* glsl */ `
uniform sampler2D tGrain; uniform float uGrainScale; uniform sampler2D tBake; uniform vec4 uRegion;
uniform float uWrap; uniform float uTrans; uniform float uGrainAmt; uniform float uObjAO; uniform float uEdge;
uniform sampler2D tSheets; uniform float uSheetPx; uniform float uCont; uniform float uGuide; uniform float uPatch;
float gCont = 0.0;
float sheetAt( vec2 uv ) { return texture2D( tSheets, uv ).r * 255.0; }
// Cut edges seen from above: a pale rim where a sheet ends (rim) and the dark foot of the sheet above (contact),
// the contact taken at three reaches so it fades out softly.
vec2 sheetEdges( vec2 uv ) {
  float s0 = sheetAt( uv ), lo = s0, hi = 0.0;
  for ( int k = 0; k < 6; k ++ ) {
    float a = float( k ) * 1.0472;
    vec2 d = vec2( cos( a ), sin( a ) ) * uSheetPx;
    lo = min( lo, sheetAt( uv + d * 1.4 ) );
    for ( int r = 1; r <= 3; r ++ ) hi = max( hi, clamp( sheetAt( uv + d * uCont * float( r ) / 3.0 ) - s0, 0.0, 1.0 ) * ( 1.0 - float( r - 1 ) * 0.33 ) );
  }
  return vec2( clamp( s0 - lo, 0.0, 1.0 ), hi );
}
// The pencil line the maker traced before cutting: a faint wandering, broken band just outside the next sheet up.
float pencilGuide( vec2 uv, vec2 xz ) {
  float s0 = sheetAt( uv ), r = uGuide * uSheetPx * ( 1.0 + 0.6 * ( texture2D( tGrain, xz * uGrainScale * 0.02 ).b - 0.5 ) );
  float outer = 0.0, inner = 0.0;
  for ( int k = 0; k < 8; k ++ ) {
    vec2 d = vec2( cos( float( k ) * 0.7854 ), sin( float( k ) * 0.7854 ) );
    outer = max( outer, step( s0 + 0.5, sheetAt( uv + d * r ) ) );
    inner = max( inner, step( s0 + 0.5, sheetAt( uv + d * r * 0.7 ) ) );
  }
  return outer * ( 1.0 - inner ) * step( 0.42, texture2D( tGrain, xz * uGrainScale * 0.05 ).a );
}
// Collage: the sheet is pieced from torn patches of slightly different paper. Returns (tone 0..1, border 0..1).
vec2 collage( vec2 xz ) {
  vec2 p = xz * uPatch;
  p += ( texture2D( tGrain, p * 0.21 ).gb - 0.5 ) * 0.7;
  vec2 c = floor( p );
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for ( int j = -1; j <= 1; j ++ ) for ( int i = -1; i <= 1; i ++ ) {
    vec2 g = c + vec2( float( i ), float( j ) );
    vec2 h = fract( sin( vec2( dot( g, vec2( 127.1, 311.7 ) ), dot( g, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
    float d = length( g + h - p );
    if ( d < d1 ) { d2 = d1; d1 = d; id = h.x; } else if ( d < d2 ) d2 = d;
  }
  float e = d2 - d1;
  return vec2( id, 1.0 - smoothstep( 0.0, 1.8, e / max( fwidth( e ), 1e-5 ) ) );
}
varying vec3 vW; varying float vLocalY;
float gSun = 1.0;
float gUntint = 0.0;
vec2 planUv(vec2 xz) { return (xz - uRegion.xy) * uRegion.zw; }
float paperGrain(vec3 p) {
  vec3 n = abs(normalize(cross(dFdx(p), dFdy(p))));
  n = n / (n.x + n.y + n.z);
  float s = uGrainScale;
  float g = texture2D(tGrain, p.xz * s).r * n.y + texture2D(tGrain, p.xy * s).r * n.z + texture2D(tGrain, p.zy * s).r * n.x;
  return 1.0 + (g - 0.5) * uGrainAmt;
}
`;

const LAMBERT_PARS = /* glsl */ `
varying vec3 vViewPosition;
struct LambertMaterial { vec3 diffuseColor; float specularStrength; };
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float d = dot( geometryNormal, directLight.direction );
  float lit = saturate( ( d + uWrap ) / ( 1.0 + uWrap ) ) + saturate( - d ) * uTrans;
  reflectedLight.directDiffuse += lit * directLight.color * BRDF_Lambert( material.diffuseColor );
}
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}
#define RE_Direct RE_Direct_Lambert
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
`;

// A paper material. `color` code runs where the map would be sampled and may set diffuseColor; `light` code runs
// before the lights are summed and may set gSun (0..1) and `ao`.
export function paperMaterial({ color = "", light = "", decl = "", vdecl = "", vcode = "", wrap = 0.35, trans = 0.25, grain = 0.25, objH = 1, ...opts } = {}) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, { uWrap: { value: wrap }, uTrans: { value: trans }, uGrainAmt: { value: grain }, uObjAO: { value: objH } });
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vW; varying float vLocalY; uniform float uObjAO;\n${vdecl}`)
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 pw = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          pw = instanceMatrix * pw;
        #endif
        vW = ( modelMatrix * pw ).xyz;
        vLocalY = transformed.y / uObjAO;
        ${vcode}`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${PRELUDE}\n${decl}`)
      .replace("#include <lights_lambert_pars_fragment>", LAMBERT_PARS)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${color}\ndiffuseColor.rgb *= paperGrain( vW );`)
      .replace("#include <color_fragment>", "#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n diffuseColor.rgb *= mix( vColor.rgb, vec3( 1.0 ), gUntint );\n#endif")
      .replace("#include <lights_fragment_begin>", `float ao = 1.0;\n${light}\n` + THREE.ShaderChunk.lights_fragment_begin.replace("getDirectionalLightInfo( directionalLight, directLight );", "getDirectionalLightInfo( directionalLight, directLight ); directLight.color *= gSun;"))
      .replace("#include <aomap_fragment>", "reflectedLight.indirectDiffuse *= ao;");
  };
  m.customProgramCacheKey = () => color + light + decl + vcode;
  return m;
}

// Baked light for things standing on the sheets: the sheets' shadow where they stand and a darker foot.
export const OBJECT_LIGHT = /* glsl */ `
  vec4 bk = texture2D( tBake, planUv( vW.xz ) );
  gSun = bk.r;
  ao = mix( 0.55, 1.0, smoothstep( 0.0, 0.6, vLocalY ) ) * mix( 0.75, 1.0, bk.g );
`;

// Soft PCF: the stock five taps turn to visible dither at a wide radius, so take sixteen.
export function softerShadows() {
  const re = /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \)[\s\S]*?\) \* 0\.2;/;
  const src = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (!re.test(src)) return;
  THREE.ShaderChunk.shadowmap_pars_fragment = src.replace(re, `shadow = 0.0;
    for ( int k = 0; k < 16; k ++ ) shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( k, 16, phi ) * radius, shadowCoord.z ) );
    shadow *= 0.0625;`);
}

export { canvas };
