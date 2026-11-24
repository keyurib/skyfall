// Static assets for the loading state and the no-WebGPU fallback:
//   - Planet posters with a transparent sky (WebP alpha), rendered through the exact live
//     pipeline and camera fit, so they match the WebGPU canvas inside the stage.
//   - A seamless star tile for the page background, so stars cover the whole hero even
//     before (or without) the full-bleed canvas.
//   - A legacy JPEG (opaque, with stars) for browsers without WebP.
// Run: npx tsx scripts/render-posters.ts   -> public/mars-poster-*.{webp,jpg}, mars-stars.webp
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { frame, init, target } from "vgpu/node";

import { sceneAt } from "../src/animation";
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
} from "../src/mars-scene";
import { loadMarsShaders } from "./lib";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const OUTPUT_FORMAT: GPUTextureFormat = "rgba8unorm";
// Grain and stars are high-frequency, so PNG would be several MB; lossy formats at
// these qualities are visually indistinguishable at hero size.
const WEBP_QUALITY = 82;
const JPEG_QUALITY = 84;
// composite.wgsl's display floor (#05060A): the colour of empty space.
const DISPLAY_BLACK = [5, 6, 10] as const;

const POSTERS = [
  { name: "mars-poster-landscape", size: [1920, 1080] as const, jpeg: true },
  // Narrowest supported phone aspect (19.5:9). On portrait screens the camera fits Mars
  // to the width; a poster at least this narrow is always cover-scaled by width too,
  // so its planet matches the live render on every portrait aspect up to the breakpoint.
  { name: "mars-poster-portrait", size: [1080, 2340] as const, jpeg: false },
];

// Star tile: matches the shader sky's look (sparse, small, warm/cool, power-law bright).
const STAR_TILE = 1024;
const STAR_COUNT = 900;
const STAR_SEED = 20301;
const STAR_COOL = [0.72, 0.82, 1.0] as const;
const STAR_WARM = [1.0, 0.84, 0.62] as const;

/**
 * Straight-alpha poster from a render over black (`rgb`, display values with the
 * DISPLAY_BLACK floor) and the planet target's coverage (`alpha`). Chosen so that over a
 * plain DISPLAY_BLACK background it reproduces the render exactly; over the starfield,
 * stars show through the sky and (attenuated) through the thin atmosphere rim.
 */
function withAlpha(rgb: Uint8Array, alpha: Uint8Array, texels: number): Uint8Array {
  const out = new Uint8Array(texels * 4);
  for (let t = 0; t < texels; t++) {
    const i = t * 4;
    const a = alpha[i + 3]! / 255;
    for (let c = 0; c < 3; c++) {
      out[i + c] = a > 0 ? Math.round(Math.min(255, Math.max(0, (rgb[i + c]! - DISPLAY_BLACK[c]! * (1 - a)) / a))) : DISPLAY_BLACK[c]!;
    }
    out[i + 3] = alpha[i + 3]!;
  }
  return out;
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seamless (wrap-around) star tile over the DISPLAY_BLACK floor. */
function starTile(): Uint8Array {
  const random = mulberry32(STAR_SEED);
  const light = new Float32Array(STAR_TILE * STAR_TILE * 3);
  for (let s = 0; s < STAR_COUNT; s++) {
    const cx = random() * STAR_TILE;
    const cy = random() * STAR_TILE;
    const roll = random();
    const brightness = 0.12 + roll * roll * roll * 0.95;
    const radius = 0.55 + random() * 0.9;
    const warmth = random();
    const tint = STAR_COOL.map((cool, c) => cool + (STAR_WARM[c]! - cool) * warmth);
    const reach = Math.ceil(radius * 2.5);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const px = Math.floor(cx) + dx;
        const py = Math.floor(cy) + dy;
        const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / radius;
        const falloff = Math.exp(-d * d * 1.6) * brightness;
        if (falloff < 0.004) continue;
        const x = ((px % STAR_TILE) + STAR_TILE) % STAR_TILE;
        const y = ((py % STAR_TILE) + STAR_TILE) % STAR_TILE;
        const i = (y * STAR_TILE + x) * 3;
        for (let c = 0; c < 3; c++) light[i + c] = light[i + c]! + tint[c]! * falloff;
      }
    }
  }
  const out = new Uint8Array(STAR_TILE * STAR_TILE * 3);
  for (let i = 0; i < light.length; i++) {
    const floor = DISPLAY_BLACK[i % 3]! / 255;
    out[i] = Math.round(Math.min(1, floor + light[i]! * (1 - floor)) * 255);
  }
  return out;
}

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true });

  const starsPath = `${PUBLIC_DIR}mars-stars.webp`;
  await sharp(Buffer.from(starTile()), { raw: { width: STAR_TILE, height: STAR_TILE, channels: 3 } })
    .webp({ quality: WEBP_QUALITY })
    .toFile(starsPath);
  console.log(`saved ${starsPath} (${(statSync(starsPath).size / 1024).toFixed(0)} KB)`);

  const shaders = await loadMarsShaders();
  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  try {
    await bakeMaps(gpu, maps, shaders);
    for (const poster of POSTERS) {
      const [width, height] = poster.size;
      const targets = createTargets(gpu, poster.size);
      const output = target(gpu, { size: poster.size, format: OUTPUT_FORMAT });
      try {
        setStaticBindings(scene, maps, targets);
        await prewarm(scene, targets, OUTPUT_FORMAT);
        const aspect = width / height;
        // The settled composition: what reduced-motion users see, and where the intro ends.
        setFrameUniforms(scene, poster.size, sceneAt(0, { aspect, reducedMotion: true }));

        // Transparent sky: planet over black, alpha from the planet target's coverage.
        frame(gpu, (f) => render(f, scene, targets, output, { sky: false }));
        const planetOnly = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
        const coverage = new Uint8Array(await targets.planet.color.read({ mipLevel: 0, region: "all" }));
        const webpPath = `${PUBLIC_DIR}${poster.name}.webp`;
        await sharp(Buffer.from(withAlpha(planetOnly, coverage, width * height)), { raw: { width, height, channels: 4 } })
          .webp({ quality: WEBP_QUALITY, alphaQuality: 90 })
          .toFile(webpPath);
        console.log(`saved ${webpPath} (${(statSync(webpPath).size / 1024).toFixed(0)} KB, transparent sky)`);

        if (poster.jpeg) {
          frame(gpu, (f) => render(f, scene, targets, output));
          const withSky = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
          const jpegPath = `${PUBLIC_DIR}${poster.name}.jpg`;
          await sharp(Buffer.from(withSky), { raw: { width, height, channels: 4 } })
            .removeAlpha()
            .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
            .toFile(jpegPath);
          console.log(`saved ${jpegPath} (${(statSync(jpegPath).size / 1024).toFixed(0)} KB, legacy, opaque)`);
        }
      } finally {
        (output as { destroy?: () => void }).destroy?.();
        destroyTargets(targets);
      }
    }
  } finally {
    destroyScene(scene);
    destroyMaps(maps);
    gpu.dispose();
  }
}

await main();
