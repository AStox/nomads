// The planet as a base layer: the seed's baked planet (scripts/globe-bake.ts) drawn in the island's art (wgsl/globe.js)
// into any target, from the whole sphere down to an isometric view tens of km across, for the render worker to put under
// the ladder's tiles. One call records two passes: the planet and its rivers (lines of art pixels that the relief hides) made
// at an art pixel of `art` device pixels, then a blit of that onto the target by whole pixels. The camera is planet-cam.js's.
import { dqBuild } from "./ground.wgsl.js";
import { planetField } from "./planet-cam.js";
import { fineWgsl, globeWgsl, RIVER_SUB } from "./wgsl/globe.js";

// the fine height map's samples a cell (the relief march reads one filtered texel instead of the spline's sixteen)
const SS = 4;
const DEPTH = "depth32float", ART_FORMAT = "rgba8unorm";
const RING = 4;
const sm = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// G: the globe.js bundle's namespace; viewBytes: the inflated view file (G.viewFromBytes); pal: pal.js's namespace;
// radiusM: the planet's radius in metres (G.RADIUS_M unless the view says otherwise), which every metre in here follows;
// the cameras (planetCam's radiusM) must be of the same radius.
// -> { meta, landings, hmax, heightAt(lat, lon) -> m, draw(enc, targetView, cam, opts) }
// draw: cam from planetCam; opts { w, h (target px), art (device px an art pixel, 2), sun (unit vector, the light that
// shades the sphere), relief (the light's exaggeration of slopes, 2.5), exag (the ground's lift, 1.5 as the ladder's),
// riverCut (m3/s), clearRGB (0 to 255), timestampWrites }. A draw's uniforms are one of RING buffers in turn, so up to
// RING draws may be recorded before one submit.
export async function createPlanet({ device, format, G, viewBytes, pal, radiusM }) {
  const V = G.viewFromBytes(viewBytes), R = radiusM ?? G.RADIUS_M, g = G.tierGrid(0);
  const { FN, APRON, SIDE, ids, hTex, heightAt } = planetField(G, V);
  const T = SIDE * SIDE;
  let hmax = 0;
  for (const h of V.height) if (h > hmax) hmax = h;

  // ---------- the fields as face textures (heights above, then the climate) ----------
  const cTex = new Uint8Array(6 * T * 4);
  for (let o = 0; o < 6 * T; o++) {
    const id = ids[o];
    // climTexel: the air in half degrees from -64 C, the rain as 16 log2(1 + mm), the ice as 4 sqrt(m), the rock's class
    cTex[4 * o] = V.temp[id] + 128;
    cTex[4 * o + 1] = Math.min(255, Math.round(16 * Math.log2(1 + V.rain[id])));
    cTex[4 * o + 2] = Math.min(255, Math.round(4 * Math.sqrt(V.ice[id])));
    cTex[4 * o + 3] = V.rock[id];
  }
  // the rivers' segments, cell centre to receiver's centre (cut where the height crosses the sea), strongest first
  const nSeg = V.segments.length / 2, flow = new Float32Array(nSeg), order = new Uint32Array(nSeg);
  const centreOf = (id) => { const f = Math.floor(id / (FN * FN)), r = id % (FN * FN); return G.centre(g, f, r % FN, Math.floor(r / FN)); };
  for (let k = 0; k < nSeg; k++) { flow[k] = 2 ** (V.river[V.segments[2 * k]] / 16) - 1; order[k] = k; }
  order.sort((a, b) => flow[b] - flow[a]);
  const segData = new Float32Array(nSeg * 8), segQ = new Float32Array(nSeg);
  for (let n = 0; n < nSeg; n++) {
    const k = order[n], from = V.segments[2 * k], to = V.segments[2 * k + 1], a = centreOf(from), b = centreOf(to), hf = V.height[from], ht = V.height[to];
    const t = ht < 0 && hf > 0 ? hf / (hf - ht) : 1;
    segData.set([a[0], a[1], a[2], flow[k], ...[0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t), 0], 8 * n);
    segQ[n] = flow[k];
  }
  // how many segments carry at least `cut`
  const carrying = (cut) => { let lo = 0, hi = nSeg; while (lo < hi) { const m = (lo + hi) >> 1; if (segQ[m] >= cut) lo = m + 1; else hi = m; } return lo; };

  // ---------- WebGPU ----------
  const { P, RGB, NCOL, HAZE, SHADOW, TONE, TONE_S } = pal;
  const tex = (fmt, data, bpt) => {
    const t = device.createTexture({ size: [SIDE, SIDE, 6], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data, { bytesPerRow: SIDE * bpt, rowsPerImage: SIDE }, [SIDE, SIDE, 6]);
    return t;
  };
  const store = (data) => {
    const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const heightTex = tex("r32float", hTex, 4);
  const fineN = SS * SIDE;
  const fine = device.createTexture({ size: [fineN, fineN, 6], format: "rgba16float", usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
  const view2d = (t) => t.createView({ dimension: "2d-array" });
  {
    const mod = device.createShaderModule({ code: fineWgsl({ FN, APRON, SS }) });
    const pipe = await device.createComputePipelineAsync({ layout: "auto", compute: { module: mod, entryPoint: "main" } });
    const bind = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: view2d(heightTex) }, { binding: 1, resource: view2d(fine) }] });
    const enc = device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(Math.ceil(fineN / 8), Math.ceil(fineN / 8), 6); pass.end();
    device.queue.submit([enc.finish()]);
  }
  // HAZE and SHADOW, then TONE's rows, one palette index a word (wgsl/globe.js T_SHADOW, T_TONE)
  const tables = new Uint32Array(NCOL * (2 + TONE_S.length));
  tables.set(HAZE, 0); tables.set(SHADOW, NCOL); tables.set(TONE, 2 * NCOL);
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, F = GPUShaderStage.FRAGMENT;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: VF, buffer: { type: "uniform" } },
      { binding: 1, visibility: F, texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
      { binding: 2, visibility: F, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 3, visibility: VF, sampler: { type: "filtering" } },
      { binding: 4, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: F, buffer: { type: "read-only-storage" } },
      { binding: 6, visibility: VF, texture: { sampleType: "float", viewDimension: "2d-array" } },
      { binding: 7, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const blitBgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: F, buffer: { type: "uniform" } },
      { binding: 8, visibility: F, texture: { sampleType: "float", viewDimension: "2d" } },
    ],
  });
  const module = device.createShaderModule({ code: globeWgsl({ FRAMES: G.FRAMES, FN, APRON, P, RGB, NCOL, TONE_S }) });
  const artTarget = [{ format: ART_FORMAT }];
  const [planetPipe, riverPipe, blitPipe] = await Promise.all([
    device.createRenderPipelineAsync({ layout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: artTarget }, primitive: { topology: "triangle-list" }, depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: "always" } }),
    device.createRenderPipelineAsync({ layout, vertex: { module, entryPoint: "rvs" }, fragment: { module, entryPoint: "rfs", targets: artTarget }, primitive: { topology: "triangle-list" }, depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" } }),
    device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [blitBgl] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "bfs", targets: [{ format }] }, primitive: { topology: "triangle-list" } }),
  ]);
  const shared = [
    { binding: 1, resource: view2d(heightTex) },
    { binding: 2, resource: view2d(tex("rgba8unorm", cTex, 4)) },
    { binding: 3, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
    { binding: 4, resource: { buffer: store(tables) } },
    { binding: 5, resource: { buffer: store(dqBuild()) } },
    { binding: 6, resource: view2d(fine) },
    { binding: 7, resource: { buffer: store(segData) } },
  ];
  const ring = Array.from({ length: RING }, () => {
    const buffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return { buffer, bind: device.createBindGroup({ layout: bgl, entries: [{ binding: 0, resource: { buffer } }, ...shared] }), blit: null };
  });
  // the picture is made at an art pixel (a quarter of the pixels at 2) and shown by whole pixels in a second pass
  let slot = 0, art = null;
  const u = new Float32Array(36);
  function artFor(aw, ah) {
    if (art && art.w === aw && art.h === ah) return art;
    art?.color.destroy(); art?.depth.destroy();
    const color = device.createTexture({ size: [aw, ah], format: ART_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    const depth = device.createTexture({ size: [aw, ah], format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    art = { w: aw, h: ah, color, depth, colorView: color.createView(), depthView: depth.createView() };
    for (const r of ring) r.blit = device.createBindGroup({ layout: blitBgl, entries: [{ binding: 0, resource: { buffer: r.buffer } }, { binding: 8, resource: art.colorView }] });
    return art;
  }

  function draw(enc, targetView, cam, opts) {
    const w = opts.w, h = opts.h, artPx = opts.art ?? 2, exag = opts.exag ?? 1.5, sun = opts.sun ?? [0.6, 0.5, 0.62], clear = opts.clearRGB ?? [0, 0, 0];
    const a = artFor(Math.ceil(w / artPx), Math.ceil(h / artPx));
    const hmaxR = (exag * hmax) / R, oLen = Math.hypot(cam.o[0], cam.o[1], cam.o[2]), cut = opts.riverCut ?? 20;
    u.set([...cam.o, cam.tanH, ...cam.fwd, cam.aspect, ...cam.right, opts.relief ?? 2.5, ...cam.up, exag, ...sun, R, ...cam.T, hmaxR, ...cam.off, artPx,
      w, h, Math.max(1e-6, 0.4 * (oLen - 1 - hmaxR)), oLen + 1.01, cut, sm(0.05, 0.3, oLen - 1), a.w, a.h]);
    const r = ring[slot++ % RING], ts = opts.timestampWrites;
    device.queue.writeBuffer(r.buffer, 0, u);
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: a.colorView, loadOp: "clear", storeOp: "store", clearValue: [clear[0] / 255, clear[1] / 255, clear[2] / 255, 1] }],
      depthStencilAttachment: { view: a.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
      ...(ts ? { timestampWrites: { querySet: ts.querySet, beginningOfPassWriteIndex: ts.beginningOfPassWriteIndex } } : {}),
    });
    pass.setBindGroup(0, r.bind);
    pass.setPipeline(planetPipe); pass.draw(3);
    const n = carrying(cut) * RIVER_SUB;
    if (n > 0) { pass.setPipeline(riverPipe); pass.draw(6, n); }
    pass.end();
    const blit = enc.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp: "clear", storeOp: "store", clearValue: [clear[0] / 255, clear[1] / 255, clear[2] / 255, 1] }],
      ...(ts ? { timestampWrites: { querySet: ts.querySet, endOfPassWriteIndex: ts.endOfPassWriteIndex } } : {}),
    });
    blit.setPipeline(blitPipe); blit.setBindGroup(0, r.blit); blit.draw(3); blit.end();
  }
  return { meta: V.meta, landings: V.meta.landings, hmax, heightAt, draw };
}
