// The camera: render supersampled into a float target, then one lens pass. A gathered bokeh from depth (thin-lens
// circle of confusion around the focus), a soft halation on bright bits, filmic tone, a warm studio grade,
// vignette and film grain.
import * as THREE from "three";

export async function render(scene, camera, { W, H, focus, dof, ss = 2, exposure = 1, grain = 0.035, warm = 1 }) {
  const canvas = document.getElementById("view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const rt = new THREE.WebGLRenderTarget(W * ss, H * ss, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  rt.depthTexture = new THREE.DepthTexture(W * ss, H * ss);
  rt.depthTexture.type = THREE.UnsignedIntType;
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const post = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, uRes: { value: new THREE.Vector2(W, H) },
      uNear: { value: camera.near }, uFar: { value: camera.far }, uFocus: { value: camera.position.distanceTo(focus) },
      uK: { value: dof.k }, uMax: { value: dof.max }, uExposure: { value: exposure }, uGrain: { value: grain }, uWarm: { value: warm },
    },
    vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }",
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uRes;
      uniform float uNear, uFar, uFocus, uK, uMax, uExposure, uGrain, uWarm;
      varying vec2 vUv;
      float depthAt( vec2 uv ) { float d = texture2D( tDepth, uv ).r; return ( uNear * uFar ) / ( uFar - d * ( uFar - uNear ) ); }
      float coc( float z ) { return min( uMax, uK * abs( 1.0 - uFocus / z ) ); }
      float rnd( vec2 p ) { return fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ); }
      vec3 tone( vec3 x ) { x = max( x, 0.0 ); return clamp( ( x * ( 2.51 * x + 0.03 ) ) / ( x * ( 2.43 * x + 0.59 ) + 0.14 ), 0.0, 1.0 ); }
      void main() {
        float cz = depthAt( vUv ), cs = coc( cz );
        vec3 col = texture2D( tColor, vUv ).rgb, glow = vec3( 0.0 );
        float tot = 1.0, r = 0.6, ang = rnd( vUv * uRes ) * 6.283;
        for ( int i = 0; i < 400; i ++ ) {
          if ( r >= max( uMax, 5.0 ) ) break;
          vec2 tc = vUv + vec2( cos( ang ), sin( ang ) ) * r / uRes;
          vec3 sc = texture2D( tColor, tc ).rgb;
          float sz = depthAt( tc ), ss = coc( sz );
          // A sharp thing in front must not bleed onto what is behind it; a blurred one in front may.
          if ( sz > cz ) ss = min( ss, cs * 2.0 );
          float m = smoothstep( r - 0.5, r + 0.5, ss );
          col += mix( col / tot, sc, m );
          tot += 1.0;
          glow += max( sc - 1.1, 0.0 ) * exp( - r * 0.35 );
          r += 0.7 / r;
          ang += 2.39996;
        }
        col /= tot;
        col += glow * 0.06;
        col = tone( col * uExposure );
        float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
        // Studio grade: shadows a touch cool, highlights warm, a little extra body in the mids.
        col = mix( col * vec3( 0.96, 0.99, 1.04 ), col * vec3( 1.05, 1.0, 0.93 ), smoothstep( 0.2, 0.8, l ) * uWarm );
        col = mix( vec3( l ), col, 1.08 );
        vec2 q = ( vUv - 0.5 ) * vec2( uRes.x / uRes.y, 1.0 );
        col *= mix( 1.0, 0.72, smoothstep( 0.45, 1.1, length( q ) ) );
        col = pow( max( col, 0.0 ), vec3( 1.0 / 2.2 ) );
        float g = rnd( vUv * uRes + 31.7 ) + rnd( vUv * uRes * 1.37 - 11.3 ) - 1.0;
        col += g * uGrain * ( 0.6 + 0.8 * l * ( 1.0 - l ) );
        gl_FragColor = vec4( col, 1.0 );
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
  const postScene = new THREE.Scene();
  postScene.add(quad);
  renderer.setRenderTarget(null);
  renderer.render(postScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
  renderer.getContext().finish();
  return renderer;
}
