// Shared helpers for the headless verification scripts.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { prepareShader } from "@vgpu/wgsl/prepare";
import { resolveShader } from "@vgpu/wgsl/runtime";

import type { MarsShaders } from "../src/mars-scene";

export const OUT_DIR = fileURLToPath(new URL("../renders/", import.meta.url));

async function loadShader(name: string) {
  const entry = fileURLToPath(new URL(`../src/shaders/${name}.wgsl`, import.meta.url));
  const resolved = await resolveShader({ entry });
  return prepareShader(resolved, entry);
}

export async function loadMarsShaders(): Promise<MarsShaders> {
  const [bakeSurface, bakeIce, mars, atmosphere, sky, overlay, brightPass, blur, composite, helicopter, entryVehicle] = await Promise.all([
    loadShader("bake-mars-surface"),
    loadShader("bake-ice"),
    loadShader("mars"),
    loadShader("mars-atmosphere"),
    loadShader("mars-sky"),
    loadShader("mars-overlay"),
    loadShader("bright-pass"),
    loadShader("blur"),
    loadShader("composite"),
    loadShader("helicopter"),
    loadShader("entry-vehicle"),
  ]);
  return { bakeSurface, bakeIce, mars, atmosphere, sky, overlay, brightPass, blur, composite, helicopter, entryVehicle };
}

export function savePng(name: string, width: number, height: number, rgba: Uint8Array): string {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  const path = `${OUT_DIR}${name}`;
  writeFileSync(path, PNG.sync.write(png));
  return path;
}

export function loadPng(name: string): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(readFileSync(`${OUT_DIR}${name}`));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

// Decodes an rgba16float readback into linear floats.
export function decodeHalfRgba(raw: Uint8Array, texelCount: number): Float32Array {
  const halves = new Uint16Array(raw.buffer, raw.byteOffset, texelCount * 4);
  const out = new Float32Array(texelCount * 4);
  for (let i = 0; i < out.length; i++) out[i] = halfToFloat(halves[i]!);
  return out;
}

export function linearToSrgbByte(value: number): number {
  const v = Math.min(1, Math.max(0, value));
  const encoded = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function makeChecker() {
  const failures: string[] = [];
  return {
    failures,
    check(condition: boolean, message: string) {
      console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
      if (!condition) failures.push(message);
    },
  };
}
