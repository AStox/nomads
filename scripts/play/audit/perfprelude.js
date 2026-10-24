// perf audit prelude (scratch copy of the site only): wraps the WebGPU API in the render worker and posts what it saw every 500 ms.
const T0 = performance.now();
const now = () => performance.now();
const W = (self.__perf = { ev: [], bufLive: 0, bufPeak: 0, bufCreated: 0, bufDestroyed: 0, bufCollected: 0, bufBytesCreated: 0, texLive: 0, texPeak: 0, texCreated: 0, texDestroyed: 0, texCollected: 0, nBuf: 0, nTex: 0, wbBytes: 0, wbN: 0, wbMs: 0, wtBytes: 0, wtN: 0, wtMs: 0, subN: 0, subMs: 0, mapN: 0, mapMs: 0, mapBytes: 0, pipeN: 0, pipeMs: 0, smN: 0, smMs: 0, bgN: 0, lag: [], bigBuf: [], errors: [], byLabel: {} });
const ev = (kind, ms, info) => { if (ms >= 2 || kind === "error" || kind === "big") W.ev.push({ t: +now().toFixed(1), kind, ms: +ms.toFixed(1), ...info }); };
const TEXB = { r8: 1, rg8: 2, rgba8: 4, bgra8: 4, r16: 2, rg16: 4, rgba16: 8, r32: 4, rg32: 8, rgba32: 16, rgb10a2: 4, rg11b10: 4, depth32: 4, depth24: 4, depth16: 2, stencil8: 1 };
const texBytesPerTexel = (f) => { const m = /^(r|rg|rgba|bgra|rgb10a2|rg11b10|depth\d+|stencil8)(\d*)/.exec(f); if (!m) return 4; const key = m[1].startsWith("depth") || m[1] === "stencil8" ? m[0].replace(/float.*/, "") : m[1] + m[2]; return TEXB[key] ?? 4; };
const sizeOfTex = (d) => { const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, l = s.depthOrArrayLayers ?? s[2] ?? 1; return w * h * (d.dimension === "3d" ? l : l) * texBytesPerTexel(d.format) * (d.sampleCount ?? 1) * ((d.mipLevelCount ?? 1) > 1 ? 1.34 : 1); };
const bufSz = new WeakMap(), texSz = new WeakMap();
const bySize = new Map();
const sizeAdd = (s, d) => { const e = bySize.get(s) ?? { n: 0, bytes: 0 }; e.n += d; e.bytes += d * s; if (e.n <= 0) bySize.delete(s); else bySize.set(s, e); };
const stackOf = () => (new Error().stack || '').split('\n').slice(2, 7).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' < ');
const regB = new FinalizationRegistry((b) => { W.bufCollected++; if (!b.d) W.bufLive -= b.s; });
const regT = new FinalizationRegistry((b) => { W.texCollected++; if (!b.d) W.texLive -= b.s; });
const wrap = (proto, name, fn) => { const o = proto[name]; if (!o) return; proto[name] = function (...a) { return fn.call(this, o, a); }; };

wrap(GPUDevice.prototype, "createBuffer", function (o, a) {
  const b = o.apply(this, a), s = a[0].size, rec = { s, d: false };
  bufSz.set(b, rec); regB.register(b, rec);
  sizeAdd(s, 1); rec.st = s >= 64 * 1024 * 1024 ? stackOf() : null; W.bufLive += s; W.bufCreated++; W.bufBytesCreated += s; W.nBuf++; if (W.bufLive > W.bufPeak) W.bufPeak = W.bufLive;
  const lab = (a[0].label || "?"); const L = (W.byLabel[lab] ??= { n: 0, bytes: 0, live: 0 }); L.n++; L.bytes += s; L.live += s; rec.l = lab;
  if (s >= 64 * 1024 * 1024) { ev("big", 0, { what: "buffer", mb: Math.round(s / 1048576), label: a[0].label || "", st: rec.st }); }
  return b;
});
wrap(GPUBuffer.prototype, "destroy", function (o, a) { const r = bufSz.get(this); if (r && !r.d) { r.d = true; sizeAdd(r.s, -1); W.bufLive -= r.s; W.bufDestroyed++; const L = W.byLabel[r.l]; if (L) L.live -= r.s; } return o.apply(this, a); });
wrap(GPUDevice.prototype, "createTexture", function (o, a) {
  const t = o.apply(this, a), s = sizeOfTex(a[0]), rec = { s, d: false, l: a[0].label || "?" };
  texSz.set(t, rec); regT.register(t, rec);
  W.texLive += s; W.texCreated++; W.nTex++; if (W.texLive > W.texPeak) W.texPeak = W.texLive;
  const lab = "tex:" + rec.l; const L = (W.byLabel[lab] ??= { n: 0, bytes: 0, live: 0 }); L.n++; L.bytes += s; L.live += s; rec.l = lab;
  if (s >= 64 * 1024 * 1024) ev("big", 0, { what: "texture", mb: Math.round(s / 1048576), label: a[0].label || "", fmt: a[0].format });
  return t;
});
wrap(GPUTexture.prototype, "destroy", function (o, a) { const r = texSz.get(this); if (r && !r.d) { r.d = true; W.texLive -= r.s; W.texDestroyed++; const L = W.byLabel[r.l]; if (L) L.live -= r.s; } return o.apply(this, a); });
wrap(GPUDevice.prototype, "createShaderModule", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; W.smN++; W.smMs += ms; ev("shaderModule", ms, { label: a[0].label || "", chars: a[0].code?.length }); return r; });
wrap(GPUDevice.prototype, "createComputePipeline", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; W.pipeN++; W.pipeMs += ms; ev("computePipelineSync", ms, { label: a[0].label || "" }); return r; });
wrap(GPUDevice.prototype, "createRenderPipeline", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; W.pipeN++; W.pipeMs += ms; ev("renderPipelineSync", ms, { label: a[0].label || "" }); return r; });
wrap(GPUDevice.prototype, "createComputePipelineAsync", function (o, a) { const t = now(); const p = o.apply(this, a); return p.then((r) => { ev("computePipelineAsync", now() - t, { label: a[0].label || "" }); return r; }); });
wrap(GPUDevice.prototype, "createRenderPipelineAsync", function (o, a) { const t = now(); const p = o.apply(this, a); return p.then((r) => { ev("renderPipelineAsync", now() - t, { label: a[0].label || "" }); return r; }); });
wrap(GPUDevice.prototype, "createBindGroup", function (o, a) { W.bgN++; return o.apply(this, a); });
wrap(GPUQueue.prototype, "submit", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; W.subN++; W.subMs += ms; ev("submit", ms, { n: a[0].length }); return r; });
wrap(GPUQueue.prototype, "writeBuffer", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; const bytes = a[4] ?? (a[2]?.byteLength ?? 0) - (a[3] ?? 0); W.wbN++; W.wbBytes += bytes; W.wbMs += ms; ev("writeBuffer", ms, { mb: +(bytes / 1048576).toFixed(2) }); return r; });
wrap(GPUQueue.prototype, "writeTexture", function (o, a) { const t = now(); const r = o.apply(this, a); const ms = now() - t; const bytes = a[1]?.byteLength ?? 0; W.wtN++; W.wtBytes += bytes; W.wtMs += ms; ev("writeTexture", ms, { mb: +(bytes / 1048576).toFixed(2) }); return r; });
wrap(GPUBuffer.prototype, "mapAsync", function (o, a) { const t = now(), sz = this.size; const p = o.apply(this, a); return p.then((r) => { const ms = now() - t; W.mapN++; W.mapMs += ms; W.mapBytes += sz; ev("mapAsync", ms, { kb: Math.round(sz / 1024) }); return r; }); });
wrap(GPUAdapter.prototype, "requestDevice", function (o, a) {
  return o.apply(this, a).then((d) => {
    d.addEventListener("uncapturederror", (e) => { W.errors.push({ t: +now().toFixed(1), msg: String(e.error?.message).slice(0, 400), kind: e.error?.constructor?.name }); ev("error", 0, { msg: String(e.error?.message).slice(0, 200), kind: e.error?.constructor?.name }); });
    d.lost.then((i) => { W.errors.push({ t: +now().toFixed(1), lost: i.reason, msg: i.message }); postMessage({ type: "__perf", lost: { reason: i.reason, msg: i.message, t: +now().toFixed(1) } }); });
    W.limits = { maxBufferSize: d.limits.maxBufferSize, maxStorageBufferBindingSize: d.limits.maxStorageBufferBindingSize, maxTextureArrayLayers: d.limits.maxTextureArrayLayers, maxTextureDimension2D: d.limits.maxTextureDimension2D };
    return d;
  });
});
// event loop lag: a 4 ms timer's lateness
let last = now();
setInterval(() => { const t = now(), late = t - last - 10; last = t; if (late > 10) W.lag.push({ t: +t.toFixed(1), ms: +late.toFixed(1) }); }, 10);
setInterval(() => {
  const ev2 = W.ev.splice(0), lag = W.lag.splice(0), heap = performance.memory ? performance.memory.usedJSHeapSize : 0, hl = performance.memory ? performance.memory.totalJSHeapSize : 0;
  postMessage({ type: "__perf", origin: performance.timeOrigin, t: +now().toFixed(1), heap, heapTotal: hl, bufLive: W.bufLive, bufPeak: W.bufPeak, texLive: W.texLive, texPeak: W.texPeak, nBuf: W.nBuf, nTex: W.nTex, bufDestroyed: W.bufDestroyed, bufCollected: W.bufCollected, texDestroyed: W.texDestroyed, texCollected: W.texCollected, wbBytes: W.wbBytes, wbN: W.wbN, wbMs: +W.wbMs.toFixed(1), wtBytes: W.wtBytes, wtN: W.wtN, wtMs: +W.wtMs.toFixed(1), subN: W.subN, subMs: +W.subMs.toFixed(1), mapN: W.mapN, mapMs: +W.mapMs.toFixed(1), pipeN: W.pipeN, pipeMs: +W.pipeMs.toFixed(1), smN: W.smN, smMs: +W.smMs.toFixed(1), bgN: W.bgN, sizes: [...bySize.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([k, v]) => [k, v.n, Math.round(v.bytes / 1e6)]), ev: ev2, lag, errors: W.errors.splice(0) });
}, 500);
self.__perfLabels = () => Object.entries(W.byLabel).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.live - a.live).slice(0, 40);
setInterval(() => { postMessage({ type: "__perfLabels", labels: self.__perfLabels() }); }, 2000);
