// M1b headless verification: full pipeline (sky, planet + atmosphere, overlay,
// bright-pass, 4x blur, composite) rendered with vgpu/node, compared against the
// frozen M1a baseline, with pixel assertions on the final image and the bloom buffer.
// Run: npx tsx scripts/render-m1b.ts
import { mkdirSync } from "node:fs";
import { frame, init, target } from "vgpu/node";

import { MARS_TUNING, cameraBasis, normalize, orbitPosition, sunDirection, type Vec3 } from "../src/mars-planet";
import {
  bakeMaps,
  createMaps,
  createScene,
  createTargets,
  destroyMaps,
  destroyScene,
  destroyTargets,
  prewarm,
  render,
  setFrameUniforms,
  setStaticBindings,
  staticFrameState,
  type Scene,
  type Targets,
} from "../src/mars-scene";
import { OUT_DIR, decodeHalfRgba, loadMarsShaders, loadPng, luminance, makeChecker, savePng } from "./lib";

const SIZE = [1280, 720] as const;
// Composite applies display gamma itself, so the final target is plain (non-sRGB) 8-bit,
// matching the non-sRGB canvas formats the browser surface uses.
const OUTPUT_FORMAT: GPUTextureFormat = "rgba8unorm";
const M1A_BASELINE = "m1a-approved/m1a-mars-poster.png";
// Arrival view: sun just beyond the planet's upper-right limb (planet radius ~13.4 deg).
const SUN_OFFSET_DEGREES = 16;
const SUN_SCREEN_ANGLE_DEGREES = 35;
// Fraction of bloom energy that must fall within this radius of the sun (bloom px).
const SUN_BLOOM_RADIUS_FRACTION = 0.22;

interface Frame8 {
  pixels: Uint8Array;
  bloom: Float32Array;
  bloomSize: [number, number];
}

async function renderView(
  gpu: Awaited<ReturnType<typeof init>>,
  scene: Scene,
  targets: Targets,
  output: ReturnType<typeof target>,
  light: Vec3
): Promise<Frame8> {
  setFrameUniforms(scene, SIZE, staticFrameState(MARS_TUNING.poster, light));
  frame(gpu, (f) => render(f, scene, targets, output));
  const pixels = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
  const bloomSize: [number, number] = [targets.bloomA.size[0], targets.bloomA.size[1]];
  const bloomRaw = new Uint8Array(await targets.bloomA.color.read({ mipLevel: 0, region: "all" }));
  return { pixels, bloom: decodeHalfRgba(bloomRaw, bloomSize[0] * bloomSize[1]), bloomSize };
}

function diskRadiusPx(height: number): number {
  const tanHalf = Math.tan((MARS_TUNING.camera.fov * Math.PI) / 360);
  const angularRadius = Math.asin(MARS_TUNING.planet.radius / MARS_TUNING.poster.radius);
  return (Math.tan(angularRadius) / tanHalf) * (height / 2);
}

// Pixels in a ring [r0, r1] x disk radius, optionally only on the left (sunlit) half.
function annulus(pixels: Uint8Array, width: number, height: number, r0: number, r1: number, leftOnly: boolean) {
  const radius = diskRadiusPx(height);
  const values: [number, number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sun-facing band only: the rim fades toward the top/bottom of the limb by design.
      if (leftOnly && x > width / 2 - radius * 0.75) continue;
      const d = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / radius;
      if (d < r0 || d > r1) continue;
      const i = (y * width + x) * 4;
      values.push([pixels[i]!, pixels[i + 1]!, pixels[i + 2]!]);
    }
  }
  const lum = values.map(([r, g, b]) => luminance(r, g, b)).sort((a, b) => a - b);
  const mean = values.reduce((acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b], [0, 0, 0]);
  const n = Math.max(1, values.length);
  return {
    median: lum[Math.floor(lum.length / 2)] ?? 0,
    meanRgb: [mean[0] / n, mean[1] / n, mean[2] / n].map(Math.round) as [number, number, number],
  };
}

function meanLitDisk(pixels: Uint8Array, width: number, height: number): [number, number, number] {
  const radius = diskRadiusPx(height) * 0.95;
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > radius) continue;
      const i = (y * width + x) * 4;
      if (luminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 24) continue;
      sum[0] += pixels[i]!;
      sum[1] += pixels[i + 1]!;
      sum[2] += pixels[i + 2]!;
      n++;
    }
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n].map(Math.round) as [number, number, number];
}

function countStars(pixels: Uint8Array, width: number, height: number): number {
  const radius = diskRadiusPx(height);
  let stars = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) < radius * 1.2) continue;
      const i = (y * width + x) * 4;
      if (luminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) > 60) stars++;
    }
  }
  return stars;
}

function bloomStats(bloom: Float32Array, size: [number, number], center?: [number, number]) {
  const [w, h] = size;
  const diskCenterRadius = diskRadiusPx(h) * 0.6;
  let max = 0;
  let total = 0;
  let nearCenter = 0;
  let overPlanetCore = 0;
  let planetCorePixels = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const value = luminance(bloom[i]!, bloom[i + 1]!, bloom[i + 2]!);
      max = Math.max(max, value);
      total += value;
      if (center && Math.hypot(x - center[0], y - center[1]) < h * SUN_BLOOM_RADIUS_FRACTION) nearCenter += value;
      if (Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) < diskCenterRadius) {
        overPlanetCore += value;
        planetCorePixels++;
      }
    }
  }
  return {
    max,
    total,
    concentration: total > 0 ? nearCenter / total : 1,
    meanOverPlanetCore: overPlanetCore / Math.max(1, planetCorePixels),
  };
}

// Where a direction at infinity lands on screen, in pixels of a [w, h] image.
function projectDirection(direction: Vec3, w: number, h: number): [number, number] {
  const position = orbitPosition(MARS_TUNING.poster);
  const basis = cameraBasis(position, [0, 0, 0], MARS_TUNING.camera.fov);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(direction, basis.forward);
  const ndcX = dot(direction, basis.right) / (depth * basis.tanHalfFov * (SIZE[0] / SIZE[1]));
  const ndcY = dot(direction, basis.up) / (depth * basis.tanHalfFov);
  return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
}

function arrivalSunDirection(): Vec3 {
  const position = orbitPosition(MARS_TUNING.poster);
  const basis = cameraBasis(position, [0, 0, 0], MARS_TUNING.camera.fov);
  const a = (SUN_OFFSET_DEGREES * Math.PI) / 180;
  const b = (SUN_SCREEN_ANGLE_DEGREES * Math.PI) / 180;
  const sideways: Vec3 = [
    basis.right[0] * Math.cos(b) + basis.up[0] * Math.sin(b),
    basis.right[1] * Math.cos(b) + basis.up[1] * Math.sin(b),
    basis.right[2] * Math.cos(b) + basis.up[2] * Math.sin(b),
  ];
  return normalize([
    basis.forward[0] * Math.cos(a) + sideways[0] * Math.sin(a),
    basis.forward[1] * Math.cos(a) + sideways[1] * Math.sin(a),
    basis.forward[2] * Math.cos(a) + sideways[2] * Math.sin(a),
  ]);
}

function sideBySide(left: Uint8Array, right: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * 2 * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(left.subarray(y * width * 4, (y + 1) * width * 4), y * width * 8);
    out.set(right.subarray(y * width * 4, (y + 1) * width * 4), y * width * 8 + width * 4);
  }
  return out;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const shaders = await loadMarsShaders();
  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  const targets = createTargets(gpu, SIZE);
  const output = target(gpu, { size: SIZE, format: OUTPUT_FORMAT });
  const { failures, check } = makeChecker();

  try {
    setStaticBindings(scene, maps, targets);
    await Promise.all([bakeMaps(gpu, maps, shaders), prewarm(scene, targets, OUTPUT_FORMAT)]);

    const poster = await renderView(gpu, scene, targets, output, sunDirection(MARS_TUNING.poster.sunDegrees));
    savePng("m1b-mars-poster.png", SIZE[0], SIZE[1], poster.pixels);
    const sunLight = arrivalSunDirection();
    const arrival = await renderView(gpu, scene, targets, output, sunLight);
    savePng("m1b-mars-arrival.png", SIZE[0], SIZE[1], arrival.pixels);

    const m1a = loadPng(M1A_BASELINE);
    savePng("m1b-vs-m1a-poster.png", SIZE[0] * 2, SIZE[1], sideBySide(m1a.data, poster.pixels, SIZE[0], SIZE[1]));

    // --- M1a vs M1b comparison --------------------------------------------------
    const [w, h] = SIZE;
    const rimA = annulus(m1a.data, w, h, 1.0, 1.03, true);
    const rimB = annulus(poster.pixels, w, h, 1.0, 1.03, true);
    const farB = annulus(poster.pixels, w, h, 1.12, 1.25, true);
    const skyB = annulus(poster.pixels, w, h, 1.6, 2.2, false);
    const litA = meanLitDisk(m1a.data, w, h);
    const litB = meanLitDisk(poster.pixels, w, h);
    const starsA = countStars(m1a.data, w, h);
    const starsB = countStars(poster.pixels, w, h);
    const posterBloom = bloomStats(poster.bloom, poster.bloomSize);
    console.log(JSON.stringify({ rimA, rimB, farB, skyB, litA, litB, starsA, starsB, posterBloom }));

    // M1a had no tone mapping, so compare the rim against M1b's own sky, not M1a's.
    check(
      rimB.median > skyB.median + 10 && rimB.median > rimA.median,
      `atmosphere rim visible outside the lit limb (rim ${rimB.median.toFixed(1)} vs sky ${skyB.median.toFixed(1)}; M1a ${rimA.median.toFixed(1)})`
    );
    check(rimB.median < 120, `atmosphere rim not overpowering (median ${rimB.median.toFixed(1)} < 120)`);
    check(
      rimB.meanRgb[0] > rimB.meanRgb[1] && rimB.meanRgb[1] > rimB.meanRgb[2],
      `rim is butterscotch, r > g > b (rgb ${rimB.meanRgb.join(",")})`
    );
    check(farB.median < skyB.median + 4, `rim is thin: gone by 1.12 R (median ${farB.median.toFixed(1)} vs sky ${skyB.median.toFixed(1)})`);
    check(starsB > 20 && starsA === 0, `starfield added (${starsA} -> ${starsB} star px)`);
    check(litB[0] > litB[1] * 1.6 && litB[1] > litB[2], `planet still rust-red after ACES (rgb ${litA.join(",")} -> ${litB.join(",")})`);
    const lumA = luminance(...litA);
    const lumB = luminance(...litB);
    check(Math.abs(lumB - lumA) / lumA < 0.25, `planet brightness within 25% of M1a (${lumA.toFixed(1)} -> ${lumB.toFixed(1)})`);
    check(posterBloom.max < 0.02, `no bloom on planet or atmosphere with the sun off-screen (max ${posterBloom.max.toFixed(4)})`);

    // --- Bloom limited to the sun -------------------------------------------------
    const sunInBloom = projectDirection(sunLight, arrival.bloomSize[0], arrival.bloomSize[1]);
    const sunBloom = bloomStats(arrival.bloom, arrival.bloomSize, sunInBloom);
    console.log(JSON.stringify({ sunInBloom: sunInBloom.map(Math.round), sunBloom }));
    check(sunBloom.max > 1.0, `sun blooms in the arrival view (bloom max ${sunBloom.max.toFixed(2)})`);
    check(sunBloom.concentration > 0.9, `bloom energy concentrated around the sun (${(sunBloom.concentration * 100).toFixed(1)}%)`);
    check(sunBloom.meanOverPlanetCore < 0.005, `no bloom over the planet core (${sunBloom.meanOverPlanetCore.toFixed(5)})`);

    console.log(`\nsaved ${OUT_DIR}m1b-mars-poster.png\nsaved ${OUT_DIR}m1b-mars-arrival.png\nsaved ${OUT_DIR}m1b-vs-m1a-poster.png`);
  } finally {
    (output as { destroy?: () => void }).destroy?.();
    destroyTargets(targets);
    destroyScene(scene);
    destroyMaps(maps);
    gpu.dispose();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nM1b headless verification passed");
}

await main();
