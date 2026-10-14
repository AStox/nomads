// The GPU the world runs on: WebGPU, through Google's Dawn bindings (the `webgpu` package) under Bun and in tests,
// and through navigator.gpu in a browser. There is no other path: without a WebGPU adapter the world can't run, and
// asking for one says so.
//
// Which adapter: NOMADS_GPU names a power preference ("high-performance", the default, or "low-power") or a piece of
// the adapter's description; the name of the one chosen goes in every ledger, since float drawing differs between
// GPUs even where the world's integer arithmetic does not.
//
// Dawn frees its instance when the JavaScript object create() returned is collected, even with work still pending on a
// device it made, and the next map or submit then reads freed memory (a segfault in Bun and Node alike). The instance
// is therefore held by the device itself for as long as the device lives.

export type Gpu = { device: GPUDevice; adapter: string };

const NEEDS = "WebGPU is required: the world's objects live and run on the GPU";

// Dawn's own GPU object under Bun, made once per process with its globals (GPUBufferUsage and the rest) installed.
let dawn: GPU | null = null;
async function dawnGpu(): Promise<GPU> {
  if (dawn) return dawn;
  const { create, globals } = await import("webgpu");
  Object.assign(globalThis, globals);
  return (dawn = create([]) as unknown as GPU);
}

function wanted() {
  const v = typeof process !== "undefined" ? process.env.NOMADS_GPU : undefined;
  return v && v.length ? v : "high-performance";
}

// A new device on the adapter asked for (choice: as NOMADS_GPU reads); throws, naming WebGPU, when there is none.
export async function openGpu(choice = wanted()): Promise<Gpu> {
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { gpu?: GPU }).gpu : undefined;
  const gpu = nav ?? (await dawnGpu());
  const pref = choice === "high-performance" || choice === "low-power" ? choice : undefined;
  let adapter = await gpu.requestAdapter(pref ? { powerPreference: pref } : { powerPreference: "high-performance" });
  if (!pref && adapter && !describe(adapter).toLowerCase().includes(choice.toLowerCase())) {
    const other = await gpu.requestAdapter({ powerPreference: "low-power" });
    adapter = other && describe(other).toLowerCase().includes(choice.toLowerCase()) ? other : null;
  }
  if (!adapter) throw new Error(`${NEEDS}; no adapter matches "${choice}"`);
  const device = await adapter.requestDevice({
    requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
  });
  Object.defineProperty(device, "instance", { value: gpu });
  device.lost.then((info) => { if (info.reason !== "destroyed") console.error(`GPU device lost: ${info.message}`); });
  return { device, adapter: describe(adapter) };
}
const describe = (a: GPUAdapter) => [a.info.vendor, a.info.architecture, a.info.description].filter(Boolean).join(" ") || "unknown adapter";

// The process's GPU: opened on first use, the same one after.
let current: Promise<Gpu> | null = null;
export const theGpu = () => (current ??= openGpu());

// Let the process exit: destroys the process's device.
export async function releaseGpu() {
  if (!current) return;
  const g = await current.catch(() => null);
  current = null;
  g?.device.destroy();
}
