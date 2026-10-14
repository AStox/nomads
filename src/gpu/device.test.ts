import { afterAll, expect, test } from "bun:test";
import { openGpu, releaseGpu, theGpu } from "./device";
import { cover, dispatch, pipeline, readback, storage } from "./kernel";

afterAll(releaseGpu);

const DOUBLE = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> v: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) n: vec3u) {
  let i = id.x + id.y * n.x * 256u;
  if (i < arrayLength(&v)) { v[i] = v[i] * 2u; }
}`;

test("a kernel over a million values runs on the GPU and reads back exactly", async () => {
  const g = await theGpu();
  const n = 1 << 20, data = new Uint32Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 2654435761) >>> 1;
  const buf = storage(g, data);
  dispatch(g, pipeline(g, DOUBLE), [buf], cover(g, n));
  const out = new Uint32Array(await readback(g, buf));
  for (let i = 0; i < n; i++) if (out[i] !== ((data[i] * 2) >>> 0)) throw new Error(`value ${i}: ${out[i]} against ${(data[i] * 2) >>> 0}`);
  buf.destroy();
});

test("two readbacks in flight at once each get their own data", async () => {
  const g = await theGpu();
  const a = storage(g, Uint32Array.from({ length: 1024 }, (_, i) => i)), b = storage(g, Uint32Array.from({ length: 1024 }, (_, i) => 5000 + i));
  const [ra, rb] = await Promise.all([readback(g, a), readback(g, b)]);
  expect(new Uint32Array(ra)[7]).toBe(7);
  expect(new Uint32Array(rb)[7]).toBe(5007);
  a.destroy();
  b.destroy();
});

test("without a matching adapter the world says WebGPU is required, with no other path", async () => {
  await expect(openGpu("no-such-gpu-anywhere")).rejects.toThrow(/WebGPU is required/);
});

test("collecting garbage while a large upload and a map are pending leaves the data intact", async () => {
  const g = await theGpu();
  for (let round = 0; round < 3; round++) {
    const n = (256 << 20) / 4, data = new Uint32Array(n);
    for (let i = 0; i < n; i += 4096) data[i] = i ^ round;
    const buf = storage(g, data), back = readback(g, buf, 64 << 10, (n / 2) * 4);
    Bun.gc(true);
    const got = new Uint32Array(await back);
    expect(got[0]).toBe((n / 2) ^ round);
    buf.destroy();
  }
});
