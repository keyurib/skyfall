// M1a headless verification: bake the Mars surface, render a static sphere with
// vgpu/node (Dawn), save PNGs, and assert on the actual pixels.
// Run: npx tsx scripts/render-m1a.ts
// The approved M1a baseline is frozen in renders/m1a-approved/; since M1b, mars.wgsl
// includes limb haze, so re-running this script reproduces M1a plus that haze.
import { mkdirSync } from "node:fs";
import { frame, init } from "vgpu/node";

import { MARS_TUNING, VALLEY_LONGITUDE, sunDirection } from "../src/mars-planet";
import {
  bakeMaps,
  createMaps,
  createScene,
  createTargets,
  destroyMaps,
  destroyScene,
  destroyTargets,
  renderPlanet,
  setFrameUniforms,
  setStaticBindings,
  staticFrameState,
} from "../src/mars-scene";
import { OUT_DIR, halfToFloat, linearToSrgbByte, loadMarsShaders, luminance, makeChecker, savePng } from "./lib";

const POSTER_SIZE = [1280, 720] as const;
const INSPECT_SIZE = [900, 900] as const;
// #05060A converted to linear; the sRGB target re-encodes it to 5,6,10 on store.
const SPACE_BLACK = [0.0015, 0.0018, 0.003, 1] as const;
// sRGB byte luminance below which a disk pixel counts as night side.
const NIGHT_LUMINANCE = 4;

type Rgba = Uint8Array;

// Decodes the rgba16float surface map into sRGB albedo bytes and linear height bytes.
function decodeSurfaceMap(raw: Uint8Array, texelCount: number) {
  const halves = new Uint16Array(raw.buffer, raw.byteOffset, texelCount * 4);
  const albedo = new Uint8Array(texelCount * 4);
  const height = new Uint8Array(texelCount * 4);
  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;
  for (let t = 0; t < texelCount; t++) {
    const i = t * 4;
    albedo[i] = linearToSrgbByte(halfToFloat(halves[i]!));
    albedo[i + 1] = linearToSrgbByte(halfToFloat(halves[i + 1]!));
    albedo[i + 2] = linearToSrgbByte(halfToFloat(halves[i + 2]!));
    albedo[i + 3] = 255;
    const h = halfToFloat(halves[i + 3]!);
    heightMin = Math.min(heightMin, h);
    heightMax = Math.max(heightMax, h);
    height[i] = height[i + 1] = height[i + 2] = Math.round(Math.min(1, Math.max(0, h)) * 255);
    height[i + 3] = 255;
  }
  return { albedo, height, heightMin, heightMax };
}

interface ViewStats {
  diskPixels: number;
  diskCoverage: number;
  litPixels: number;
  darkSidePixels: number;
  meanLit: [number, number, number];
  icePixels: number;
  backgroundCorner: [number, number, number];
}

function analyzeView(pixels: Rgba, width: number, height: number): ViewStats {
  const corner: [number, number, number] = [pixels[0]!, pixels[1]!, pixels[2]!];
  let disk = 0;
  let lit = 0;
  let darkSide = 0;
  let ice = 0;
  const sum: [number, number, number] = [0, 0, 0];
  // Geometric disk test from the projection: the planet is centred on screen.
  const tanHalf = Math.tan(((MARS_TUNING.camera.fov * Math.PI) / 180) / 2);
  const angularRadius = Math.asin(MARS_TUNING.planet.radius / MARS_TUNING.poster.radius);
  const diskRadiusPx = (Math.tan(angularRadius) / tanHalf) * (height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = pixels[i]!;
      const g = pixels[i + 1]!;
      const b = pixels[i + 2]!;
      const insideDisk = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) < diskRadiusPx * 0.97;
      if (!insideDisk) continue;
      disk++;
      // The night side is unlit planet (near 0,0,0), darker than the #05060A sky.
      if (luminance(r, g, b) < NIGHT_LUMINANCE) {
        darkSide++;
        continue;
      }
      if (luminance(r, g, b) > 24) {
        lit++;
        sum[0] += r;
        sum[1] += g;
        sum[2] += b;
        // Ice: bright and close to neutral, unlike any regolith tone.
        if (Math.min(r, g, b) > 140 && r - b < 45) ice++;
      }
    }
  }
  return {
    diskPixels: disk,
    diskCoverage: disk / (Math.PI * diskRadiusPx * diskRadiusPx),
    litPixels: lit,
    darkSidePixels: darkSide,
    meanLit: [sum[0] / Math.max(1, lit), sum[1] / Math.max(1, lit), sum[2] / Math.max(1, lit)].map(
      (v) => Math.round(v)
    ) as [number, number, number],
    icePixels: ice,
    backgroundCorner: corner,
  };
}

// Mean map luminance over a latitude/longitude box (degrees; longitude in sphere() phi).
function mapRegionLuminance(
  pixels: Rgba,
  width: number,
  height: number,
  latMin: number,
  latMax: number,
  lonCenterRad: number,
  lonHalfDeg: number
): number {
  let sum = 0;
  let count = 0;
  const lonCenterDeg = (lonCenterRad * 180) / Math.PI;
  for (let lat = latMin; lat <= latMax; lat += 0.25) {
    const v = (90 - lat) / 180;
    const y = Math.min(height - 1, Math.floor(v * height));
    for (let lon = lonCenterDeg - lonHalfDeg; lon <= lonCenterDeg + lonHalfDeg; lon += 0.25) {
      const u = (((lon / 360) % 1) + 1) % 1;
      const x = Math.min(width - 1, Math.floor(u * width));
      const i = (y * width + x) * 4;
      sum += luminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
      count++;
    }
  }
  return sum / Math.max(1, count);
}

function localContrast(pixels: Rgba, width: number, height: number, latMin: number, latMax: number): number {
  // Mean absolute luminance difference between horizontal neighbours: crater density proxy.
  let sum = 0;
  let count = 0;
  const y0 = Math.floor(((90 - latMax) / 180) * height);
  const y1 = Math.floor(((90 - latMin) / 180) * height);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      sum += Math.abs(
        luminance(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) -
          luminance(pixels[i + 4]!, pixels[i + 5]!, pixels[i + 6]!)
      );
      count++;
    }
  }
  return sum / Math.max(1, count);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const shaders = await loadMarsShaders();

  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  const poster = createTargets(gpu, POSTER_SIZE);
  const inspect = createTargets(gpu, INSPECT_SIZE);
  const { failures, check } = makeChecker();

  try {
    setStaticBindings(scene, maps, poster);
    const bakeStart = performance.now();
    await bakeMaps(gpu, maps, shaders);
    await Promise.all([scene.mars.compile(poster.planet), scene.mars.compile(inspect.planet)]);

    // --- Baked surface map -------------------------------------------------------
    const [mapW, mapH] = MARS_TUNING.maps.size;
    const raw = new Uint8Array(await maps.surface.color.read({ mipLevel: 0, region: "all" }));
    console.log(`bake + readback: ${(performance.now() - bakeStart).toFixed(0)} ms`);
    const decoded = decodeSurfaceMap(raw, mapW * mapH);
    const surface = decoded.albedo;
    console.log(`height range: ${decoded.heightMin.toFixed(3)} .. ${decoded.heightMax.toFixed(3)}`);
    savePng("m1a-surface-albedo.png", mapW, mapH, decoded.albedo);
    savePng("m1a-surface-height.png", mapW, mapH, decoded.height);

    // --- Poster view: side-lit, terminator visible ----------------------------
    const posterOrbit = MARS_TUNING.poster;
    setFrameUniforms(scene, POSTER_SIZE, staticFrameState(posterOrbit, sunDirection(posterOrbit.sunDegrees)));
    frame(gpu, (f) => renderPlanet(f, scene, poster, SPACE_BLACK));
    const posterPixels = new Uint8Array(await poster.planet.color.read({ mipLevel: 0, region: "all" }));
    const posterPath = savePng("m1a-mars-poster.png", POSTER_SIZE[0], POSTER_SIZE[1], posterPixels);

    // --- Inspection view: sun behind the camera, shows albedo across the disk ---
    const facingDegrees = (VALLEY_LONGITUDE * 180) / Math.PI;
    setFrameUniforms(scene, INSPECT_SIZE, staticFrameState(posterOrbit, sunDirection(facingDegrees)));
    frame(gpu, (f) => renderPlanet(f, scene, inspect, SPACE_BLACK));
    const inspectPixels = new Uint8Array(await inspect.planet.color.read({ mipLevel: 0, region: "all" }));
    const inspectPath = savePng("m1a-mars-frontlit.png", INSPECT_SIZE[0], INSPECT_SIZE[1], inspectPixels);

    // --- Pixel assertions -------------------------------------------------------
    const posterStats = analyzeView(posterPixels, POSTER_SIZE[0], POSTER_SIZE[1]);
    const inspectStats = analyzeView(inspectPixels, INSPECT_SIZE[0], INSPECT_SIZE[1]);
    console.log("poster stats:", JSON.stringify(posterStats));
    console.log("front-lit stats:", JSON.stringify(inspectStats));

    const [r, g, b] = inspectStats.meanLit;
    check(posterStats.backgroundCorner.every((v, i) => Math.abs(v - [5, 6, 10][i]!) <= 2), "background is #05060A deep space");
    check(posterStats.litPixels > posterStats.diskPixels * 0.35, "poster: planet is lit and non-black (>35% of disk)");
    check(posterStats.darkSidePixels > posterStats.diskPixels * 0.08, "poster: night side present (terminator visible)");
    check(inspectStats.litPixels > inspectStats.diskPixels * 0.9, "front-lit: nearly the whole disk is lit");
    check(r > g * 1.6 && g > b, `front-lit: mean lit colour is rust-red (rgb ${r},${g},${b})`);
    check(inspectStats.icePixels > 150, `front-lit: polar ice visible (${inspectStats.icePixels} near-white px)`);

    const valley = mapRegionLuminance(surface, mapW, mapH, -10, -6, VALLEY_LONGITUDE, 25);
    const besideValley = mapRegionLuminance(surface, mapW, mapH, 2, 6, VALLEY_LONGITUDE, 25);
    check(valley < besideValley * 0.8, `map: equatorial valley darker than surroundings (${valley.toFixed(1)} vs ${besideValley.toFixed(1)})`);
    const southContrast = localContrast(surface, mapW, mapH, -60, -20);
    const northContrast = localContrast(surface, mapW, mapH, 30, 60);
    check(southContrast > northContrast, `map: cratered south rougher than northern plains (${southContrast.toFixed(2)} vs ${northContrast.toFixed(2)})`);
    const northCap = mapRegionLuminance(surface, mapW, mapH, 84, 89, 0, 180);
    check(northCap > 150, `map: north polar cap bright (${northCap.toFixed(1)})`);

    console.log(`\nsaved ${posterPath}\nsaved ${inspectPath}\nsaved ${OUT_DIR}m1a-surface-albedo.png\nsaved ${OUT_DIR}m1a-surface-height.png`);
  } finally {
    destroyTargets(inspect);
    destroyTargets(poster);
    destroyScene(scene);
    destroyMaps(maps);
    gpu.dispose();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nM1a headless verification passed");
}

await main();
