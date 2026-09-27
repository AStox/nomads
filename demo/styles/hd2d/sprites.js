// Billboards: every object is a flat pixel-art card standing upright and turned to the camera. Each card has an unseen
// twin turned to the sun that casts its shadow, so a card seen face-on still throws its full silhouette.
import * as THREE from "three";
import { Px } from "./pixels.js";

export function mirror(px) {
  const out = new Px(px.w, px.h);
  for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) { const a = (y * px.w + x) * 4, b = (y * px.w + (px.w - 1 - x)) * 4; for (let c = 0; c < 4; c++) out.d[b + c] = px.d[a + c]; }
  return out;
}
export function spriteTex(cv) {
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const SELF = "shadowWorldPosition = worldPosition + vec4( shadowWorldNormal * directionalLightShadows[ i ].shadowNormalBias, 0 );";
// Cards look up their shadow a little way toward the sun, past their own twin, so they are shaded only by others.
// The texels just inside the sunward outline catch a rim of light, the way HD-2D sprites glint against a low sun.
const RIM = `
  vec2 tx = uTexel;
  float open = max(max(1.0 - texture2D(map, vMapUv + vec2(-2.0, 0.0) * tx).a, 1.0 - texture2D(map, vMapUv + vec2(-2.0, 2.0) * tx).a), 1.0 - texture2D(map, vMapUv + vec2(0.0, 2.0) * tx).a);
  float inner = texture2D(map, vMapUv + vec2(-1.0, 0.0) * tx).a * texture2D(map, vMapUv + vec2(0.0, 1.0) * tx).a;
  diffuseColor.rgb *= 1.0 + open * inner * uRim;`;
function litMat(tex, sunDir, bias, rim) {
  const m = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5 });
  const img = tex.image;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uSunDir = { value: sunDir };
    sh.uniforms.uSelfBias = { value: bias };
    sh.uniforms.uTexel = { value: new THREE.Vector2(1 / img.width, 1 / img.height) };
    sh.uniforms.uRim = { value: rim };
    sh.vertexShader = "uniform vec3 uSunDir; uniform float uSelfBias;\n" + sh.vertexShader.replace("#include <shadowmap_vertex>", THREE.ShaderChunk.shadowmap_vertex.replace(SELF, "shadowWorldPosition = worldPosition + vec4( uSunDir * uSelfBias, 0.0 );"));
    sh.fragmentShader = "uniform vec2 uTexel; uniform float uRim;\n" + sh.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n" + RIM);
  };
  m.customProgramCacheKey = () => "hd2d-card";
  return m;
}

export class Cards {
  constructor(camYaw, sunDir, squash) {
    this.types = [];
    this.camQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), camYaw);
    this.sunQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(sunDir.x, sunDir.z));
    this.sunDir = sunDir;
    this.squash = squash;
    this.proxies = [];
    this.meshes = [];
    this.count = 0;
  }
  // texel: meters per texel; the height is stretched by `squash` so texels read square under the camera's downward look.
  type(px, texel, { cast = true, lit = true, color = null, sink = 1, rim = 0.4 } = {}) {
    const T = { tex: spriteTex(px.canvas()), w: px.w * texel, h: px.h * texel * this.squash, native: px.h, texel, cast, lit, color, sink, rim, items: [] };
    this.types.push(T);
    return T;
  }
  add(T, x, y, z, s = 1) { T.items.push(x, y - T.sink * T.texel * this.squash * s, z, s); }
  build(scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const nrm = geo.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const T of this.types) {
      const n = T.items.length / 4;
      if (!n) continue;
      const mat = T.lit ? litMat(T.tex, this.sunDir, T.w * 0.5 + 0.3, T.rim) : new THREE.MeshBasicMaterial({ map: T.tex, alphaTest: 0.5, color: T.color || 0xffffff });
      const card = new THREE.InstancedMesh(geo, mat, n);
      const twin = T.cast ? new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: T.tex, alphaTest: 0.5, side: THREE.DoubleSide }), n) : null;
      for (let i = 0; i < n; i++) {
        const k = i * 4, sc = T.items[k + 3];
        p.set(T.items[k], T.items[k + 1], T.items[k + 2]);
        s.set(T.w * sc, T.h * sc, 1);
        card.setMatrixAt(i, m.compose(p, this.camQ, s));
        if (twin) twin.setMatrixAt(i, m.compose(p, this.sunQ, s));
      }
      card.frustumCulled = false;
      card.receiveShadow = T.lit;
      scene.add(card);
      this.meshes.push(card);
      if (twin) { twin.castShadow = true; twin.frustumCulled = false; twin.visible = false; scene.add(twin); this.proxies.push(twin); }
      this.count += n;
    }
  }
  // Shadow pass: twins stand in for the cards.
  shadowPhase(on) { for (const t of this.proxies) t.visible = on; for (const c of this.meshes) c.visible = !on; }
}
