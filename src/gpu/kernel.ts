// Running WGSL on the world's GPU: compute pipelines made once per source and entry point, storage buffers, dispatches,
// and reading results back through a small ring of staging buffers, each mapped right after the copy into it is
// submitted, so one readback never waits on another's buffer.
import type { Gpu } from "./device";

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();
const making = new WeakMap<GPUDevice, Map<string, Promise<GPUComputePipeline>>>();
function made(g: Gpu): Map<string, GPUComputePipeline> {
  let byKey = pipelines.get(g.device);
  if (!byKey) pipelines.set(g.device, (byKey = new Map()));
  return byKey;
}

// The compute pipeline for an entry point of a WGSL source on a device, compiled the first time it is asked for. The
// browser's GPU process compiles it before it runs any other command of any queue, every frame waiting meanwhile
// (a large kernel takes it 100 to 300 ms: bench-r9c.json compileStalls), so the play page makes its kernels with
// pipelineSoon instead.
export function pipeline(g: Gpu, wgsl: string, entry = "main"): GPUComputePipeline {
  const byKey = made(g), key = `${entry}\u0000${wgsl}`;
  let p = byKey.get(key);
  if (!p) {
    const module = g.device.createShaderModule({ code: wgsl });
    p = g.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: entry } });
    byKey.set(key, p);
  }
  return p;
}

// The same pipeline made asynchronously (createComputePipelineAsync), which the GPU process compiles on threads of its
// own while the queues go on: the pipeline when it is made, else the promise of it. A source the browser refuses is
// made as pipeline makes it, so it fails the same way.
export function pipelineSoon(g: Gpu, wgsl: string, entry = "main"): GPUComputePipeline | Promise<GPUComputePipeline> {
  const byKey = made(g), key = `${entry}\u0000${wgsl}`, p = byKey.get(key);
  if (p) return p;
  const soon = making.get(g.device) ?? new Map<string, Promise<GPUComputePipeline>>();
  making.set(g.device, soon);
  let q = soon.get(key);
  if (!q) {
    const module = g.device.createShaderModule({ code: wgsl });
    q = g.device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: entry } }).then(
      (ready) => {
        if (!byKey.has(key)) byKey.set(key, ready);
        return byKey.get(key)!;
      },
      () => pipeline(g, wgsl, entry),
    );
    soon.set(key, q);
    void q.then(() => soon.delete(key));
  }
  return q;
}

// A storage buffer of so many bytes (rounded up to 4), or holding a copy of the data given.
export function storage(g: Gpu, data: number | ArrayBufferView, extra: number = 0): GPUBuffer {
  const bytes = typeof data === "number" ? data : data.byteLength;
  const buf = g.device.createBuffer({ size: Math.max(4, Math.ceil(bytes / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | extra });
  if (typeof data !== "number") g.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
  return buf;
}

// A uniform buffer holding the data given.
export function uniform(g: Gpu, data: ArrayBufferView): GPUBuffer {
  const buf = g.device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  g.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
  return buf;
}

// Dispatch an entry point over so many workgroups, its buffers bound in group 0 at bindings 0, 1, 2... in order.
export function dispatch(g: Gpu, p: GPUComputePipeline, buffers: GPUBuffer[], groups: [number, number?, number?]) {
  const bind = g.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass();
  pass.setPipeline(p);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(groups[0], groups[1] ?? 1, groups[2] ?? 1);
  pass.end();
  g.device.queue.submit([enc.finish()]);
}

// A dispatch of `groups` workgroups made as submits of at most `per`, never more than two on the queue at once, so a frame (and the browser's own drawing, which shares the GPU) waits behind at most two
// slices instead of one kernel of tens of milliseconds, and the GPU is not left idle between slices (one in flight would). `before(first, n)` is called ahead of each slice to tell the kernel where it
// starts: the kernels read it (an index added to their global invocation id), as a dispatch has no base of its own; a write the queue takes in order with the submits, so a slice already submitted
// still reads its own. The result is the same as one dispatch's: each thread's own, whatever the order the slices run in.
const IN_FLIGHT = 2;
export async function dispatchSliced(g: Gpu, p: GPUComputePipeline, binds: [number, GPUBuffer][], groups: number, per: number, before: (first: number, n: number) => void) {
  const bind = g.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: binds.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
  const queued: Promise<undefined>[] = [];
  for (let first = 0; first < groups; first += per) {
    if (queued.length >= IN_FLIGHT) await queued.shift();
    const n = Math.min(per, groups - first);
    before(first, n);
    const enc = g.device.createCommandEncoder(), pass = enc.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(n);
    pass.end();
    g.device.queue.submit([enc.finish()]);
    queued.push(g.device.queue.onSubmittedWorkDone());
  }
  await Promise.all(queued);
}

// Workgroups of a given size needed to cover n invocations, split over two dimensions when one would pass the limit.
export function cover(g: Gpu, n: number, size = 256): [number, number] {
  const groups = Math.ceil(n / size), most = g.device.limits.maxComputeWorkgroupsPerDimension;
  return groups <= most ? [groups, 1] : [most, Math.ceil(groups / most)];
}

// ---------- reading back ----------
type Slot = { buf: GPUBuffer; size: number; busy: boolean; last: number };
type Ring = { slots: Slot[]; reads: number };
const rings = new WeakMap<GPUDevice, Ring>();
// The largest staging buffer the ring keeps once read [design: a landing's copy, some 10 MB on seed 1, read every
// landing]; a larger one (a save's or a hash's chunks of 64 MB) is let go as soon as it is read, and one no read has
// used in the last RING_AGE [design] is let go too, so the CPU's copies don't stay on the GPU.
const RING_KEEP = 16 << 20, RING_AGE = 64;

// A copy of bytes [offset, offset + bytes) of a buffer, read back through the next free staging buffer of the ring.
// keep, given the bytes as mapped, says how many of them the copy needs (a landing's: as far as its gather wrote), so
// the rest is not copied out of the mapping.
export async function readback(g: Gpu, src: GPUBuffer, bytes = src.size, offset = 0, keep?: (mapped: ArrayBuffer) => number): Promise<ArrayBuffer> {
  let ring = rings.get(g.device);
  if (!ring) rings.set(g.device, (ring = { slots: [], reads: 0 }));
  const size = Math.ceil(bytes / 4) * 4, slots = ring.slots;
  let slot = slots.find((s) => !s.busy && s.size >= size);
  if (!slot) {
    slot = { buf: g.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), size, busy: false, last: 0 };
    slots.push(slot);
  }
  slot.busy = true;
  slot.last = ++ring.reads;
  const enc = g.device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, slot.buf, 0, size);
  g.device.queue.submit([enc.finish()]);
  try {
    await slot.buf.mapAsync(GPUMapMode.READ, 0, size);
    const mapped = slot.buf.getMappedRange(0, size), out = mapped.slice(0, keep ? Math.min(bytes, keep(mapped)) : bytes);
    slot.buf.unmap();
    return out;
  } finally {
    slot.busy = false;
    for (const s of slots.filter((x) => !x.busy && (x.size > RING_KEEP || ring.reads - x.last > RING_AGE))) {
      slots.splice(slots.indexOf(s), 1);
      s.buf.destroy();
    }
  }
}
