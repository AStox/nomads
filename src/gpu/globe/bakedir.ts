// A directory of named raw arrays kept by the 75 m tier's bake: `<name>.i32`, `<name>.u32`, `<name>.f32`, `<name>.u16`, `<name>.u8`, `<name>.i16` and `<name>.json`. A tier-4 field is 403 MB
// (4 bytes a cell) and is read once, whole. No dependency on the globe's generator, so a picture or a viewer can read what was baked without loading it.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class BakeDir {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  path(name: string) { return join(this.dir, name); }
  has(name: string) { return existsSync(this.path(name)); }
  bytes(name: string) { return statSync(this.path(name)).size; }
  write(name: string, a: ArrayBufferView) { writeFileSync(this.path(name), new Uint8Array(a.buffer, a.byteOffset, a.byteLength)); }
  raw(name: string): ArrayBuffer {
    const b = readFileSync(this.path(name));
    return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  }
  i32(name: string) { return new Int32Array(this.raw(`${name}.i32`)); }
  u32(name: string) { return new Uint32Array(this.raw(`${name}.u32`)); }
  f32(name: string) { return new Float32Array(this.raw(`${name}.f32`)); }
  json<T>(name: string): T | null { return this.has(`${name}.json`) ? (JSON.parse(readFileSync(this.path(`${name}.json`), "utf8")) as T) : null; }
  putJson(name: string, v: unknown) { writeFileSync(this.path(`${name}.json`), JSON.stringify(v)); }
  remove(name: string) { rmSync(this.path(name), { force: true }); }
}

// The unit's one scratch and store directory (30 GB for the whole unit) and a seed's directory in it, named by the planet's key.
export const BAKE = process.env.NOMADS_BAKE ?? "/tmp/planet-75m";
export const bakeDir = (seed: number, key: string) => new BakeDir(join(BAKE, `${seed}-${key}`));

// A field file of a tier of the bake: `t<tier>-<name>` (name with its type: `height.i32`). The planet's finest tier is grid.ts PLANET_TIER; the 195.6 km planet's was 4.
export const tierFile = (tier: number, name: string) => `t${tier}-${name}`;
