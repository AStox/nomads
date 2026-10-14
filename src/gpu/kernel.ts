// Running WGSL on the world's GPU: compute pipelines made once per source and entry point, storage buffers, dispatches,
// and reading results back through a small ring of staging buffers, each mapped right after the copy into it is
// submitted, so one readback never waits on another's buffer.
import type { Gpu } from "./device";

const pipelines = new WeakMap<GPUDevice, Map<string, GPUComputePipeline>>();

// The compute pipeline for an entry point of a WGSL source on a device, compiled the first time it is asked for.
export function pipeline(g: Gpu, wgsl: string, entry = "main"): GPUComputePipeline {
  let byKey = pipelines.get(g.device);
  if (!byKey) pipelines.set(g.device, (byKey = new Map()));
  const key = `${entry}\u0000${wgsl}`;
  let p = byKey.get(key);
  if (!p) {
    const module = g.device.createShaderModule({ code: wgsl });
    p = g.device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: entry } });
    byKey.set(key, p);
  }
  return p;
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

// Workgroups of a given size needed to cover n invocations, split over two dimensions when one would pass the limit.
export function cover(g: Gpu, n: number, size = 256): [number, number] {
  const groups = Math.ceil(n / size), most = g.device.limits.maxComputeWorkgroupsPerDimension;
  return groups <= most ? [groups, 1] : [most, Math.ceil(groups / most)];
}

// ---------- reading back ----------
type Slot = { buf: GPUBuffer; size: number; busy: boolean };
const rings = new WeakMap<GPUDevice, Slot[]>();

// A copy of bytes [offset, offset + bytes) of a buffer, read back through the next free staging buffer of the ring.
export async function readback(g: Gpu, src: GPUBuffer, bytes = src.size, offset = 0): Promise<ArrayBuffer> {
  let ring = rings.get(g.device);
  if (!ring) rings.set(g.device, (ring = []));
  const size = Math.ceil(bytes / 4) * 4;
  let slot = ring.find((s) => !s.busy && s.size >= size);
  if (!slot) {
    slot = { buf: g.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), size, busy: false };
    ring.push(slot);
  }
  slot.busy = true;
  const enc = g.device.createCommandEncoder();
  enc.copyBufferToBuffer(src, offset, slot.buf, 0, size);
  g.device.queue.submit([enc.finish()]);
  try {
    await slot.buf.mapAsync(GPUMapMode.READ, 0, size);
    const out = slot.buf.getMappedRange(0, size).slice(0, bytes);
    slot.buf.unmap();
    return out;
  } finally {
    slot.busy = false;
  }
}
