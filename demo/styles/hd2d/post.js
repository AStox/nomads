// The modern half of HD-2D: a thin-lens depth of field with round bokeh (the tilt-shift band), bloom, bokeh motes drawn
// after the blur, then lens fringing, vignette and a warm grade before tone mapping.
import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const COC = /* glsl */ `
uniform sampler2D tDepth; uniform float uNear, uFar, uFocus, uK, uBand, uMax, uTilt, uFocusY;
float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
float cocOf(float z, float sy) {
  float c = uK * abs(1.0 - uFocus / z);
  c = max(c, uTilt * smoothstep(0.18, 0.62, abs(sy - uFocusY)));
  return clamp(c - uBand, 0.0, uMax);
}`;
const VERT = "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";

export function makePost(renderer, W, H, lens) {
  const hdr = { type: THREE.HalfFloatType };
  const rtScene = new THREE.WebGLRenderTarget(W, H, { ...hdr, depthTexture: new THREE.DepthTexture(W, H), samples: 0 });
  rtScene.depthTexture.type = THREE.UnsignedIntType;
  const hw = Math.ceil(W / 2), hh = Math.ceil(H / 2);
  const rtHalf = new THREE.WebGLRenderTarget(hw, hh, hdr), rtA = new THREE.WebGLRenderTarget(W, H, hdr), rtB = new THREE.WebGLRenderTarget(W, H, hdr);
  rtHalf.texture.minFilter = rtHalf.texture.magFilter = THREE.LinearFilter;
  const quad = new FullScreenQuad();
  const lensU = () => ({
    tDepth: { value: rtScene.depthTexture }, uNear: { value: lens.near }, uFar: { value: lens.far }, uFocus: { value: lens.focus },
    uK: { value: lens.k }, uBand: { value: lens.band }, uMax: { value: lens.max }, uTilt: { value: lens.tilt }, uFocusY: { value: lens.focusY },
  });
  // Scatter-as-gather on a golden-angle spiral at half resolution: a sample counts where its own blur circle reaches us.
  const gather = new THREE.ShaderMaterial({
    uniforms: { ...lensU(), tColor: { value: rtScene.texture }, uPx: { value: new THREE.Vector2(1 / hw, 1 / hh) } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uPx;
      ${COC}
      void main() {
        float cz = linZ(texture2D(tDepth, vUv).x), cs = cocOf(cz, vUv.y) * 0.5;
        vec3 acc = texture2D(tColor, vUv).rgb; float tot = 1.0;
        float r = 0.7, ang = 0.0;
        for (int n = 0; n < 260; n++) {
          if (r > uMax * 0.5) break;
          vec2 tc = vUv + vec2(cos(ang), sin(ang)) * uPx * r;
          vec3 sc = texture2D(tColor, tc).rgb;
          float sz = linZ(texture2D(tDepth, tc).x), ss = cocOf(sz, tc.y) * 0.5;
          if (sz > cz) ss = min(ss, cs * 2.0);
          float m = smoothstep(r - 0.6, r + 0.6, ss);
          float wgt = m * (1.0 + 7.0 * max(0.0, dot(sc, vec3(0.3, 0.55, 0.15)) - 0.5));
          acc += sc * wgt; tot += wgt;
          ang += 2.39996323; r += 0.7 / r;
        }
        gl_FragColor = vec4(acc / tot, cs);
      }`,
  });
  const merge = new THREE.ShaderMaterial({
    uniforms: { ...lensU(), tColor: { value: rtScene.texture }, tBlur: { value: rtHalf.texture } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor, tBlur;
      ${COC}
      void main() {
        float c = cocOf(linZ(texture2D(tDepth, vUv).x), vUv.y);
        vec4 b = texture2D(tBlur, vUv);
        float t = smoothstep(0.5, 2.2, max(c, b.a * 1.6));
        gl_FragColor = vec4(mix(texture2D(tColor, vUv).rgb, b.rgb, t), 1.0);
      }`,
  });
  const grade = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: rtA.texture }, uSun: { value: new THREE.Vector2(lens.sunX, lens.sunY) }, uAspect: { value: W / H }, uHaze: { value: new THREE.Color(...lens.haze) }, uCA: { value: lens.ca } },
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uSun; uniform float uAspect, uCA; uniform vec3 uHaze;
      void main() {
        vec2 d = vUv - 0.5; float r2 = dot(d * vec2(uAspect, 1.0), d * vec2(uAspect, 1.0));
        vec2 off = d * uCA * (0.4 + r2);
        vec3 c = vec3(texture2D(tColor, vUv + off).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - off).b);
        // warm light pouring in from the sun's corner
        float s = length((vUv - uSun) * vec2(uAspect, 1.0));
        c += uHaze * (exp(-s * 1.6) * 0.55 + exp(-s * 5.0) * 0.4);
        // split tone: cool shadows, warm highlights
        float l = dot(c, vec3(0.3, 0.55, 0.15));
        c = mix(c * vec3(0.9, 0.98, 1.12), c * vec3(1.06, 1.0, 0.9), smoothstep(0.05, 0.6, l));
        c = mix(vec3(l), c, 1.18);
        c *= mix(1.0, 0.42, smoothstep(0.18, 1.05, r2));
        gl_FragColor = vec4(max(c, 0.0), 1.0);
      }`,
  });
  const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), lens.bloom[0], lens.bloom[1], lens.bloom[2]);
  const output = new OutputPass();
  output.renderToScreen = true;
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.clear(); quad.render(renderer); };

  return {
    rtScene,
    render(scene, camera, overlay) {
      renderer.setRenderTarget(rtScene);
      renderer.clear();
      renderer.render(scene, camera);
      pass(gather, rtHalf);
      pass(merge, rtA);
      if (overlay) { renderer.setRenderTarget(rtA); const ac = renderer.autoClear; renderer.autoClear = false; renderer.render(overlay, camera); renderer.autoClear = ac; }
      bloom.render(renderer, null, rtA, 0, false);
      pass(grade, rtB);
      output.render(renderer, null, rtB);
    },
    lensUniforms: lensU,
  };
}
