// M2 headless verification: render the intro timeline at the desktop stage size,
// build a contact sheet, and assert on actual pixels.
// Run: npx tsx scripts/render-m2.ts
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { frame, init, target } from "vgpu/node";

import { TIMELINE, sceneAt, type SceneState } from "../src/animation";
import { MARS_TUNING, cameraBasis, orbitPosition, type Vec3 } from "../src/mars-planet";
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
import { OUT_DIR, decodeHalfRgba, loadMarsShaders, luminance, makeChecker, savePng } from "./lib";

// The desktop stage at a 1920 x 1080 viewport (right two-thirds).
const SIZE = [1280, 1080] as const;
const ASPECT = SIZE[0] / SIZE[1];
const OUTPUT_FORMAT: GPUTextureFormat = "rgba8unorm";
const SHEET_TIMES = [0, 2, 3, 4.4, 5.5, 7, 10, 16] as const;
const SHEET_SCALE = 0.3;
// A pixel counts as changed by a flight element when any channel moves this much.
const DIFF_THRESHOLD = 12;
// Sun is off-screen in the intro, so any bloom at all means something else is glowing.
const MAX_INTRO_BLOOM = 0.02;

const { failures, check } = makeChecker();

interface Rendered {
  pixels: Uint8Array;
  bloomMax: number;
}

function hideFlight(state: SceneState): SceneState {
  return {
    ...state,
    entry: { ...state.entry, intensity: 0 },
    helicopters: state.helicopters.map((h) => ({ ...h, visibility: 0 })),
  };
}

function project(state: SceneState, point: Vec3): [number, number, number] {
  const position = orbitPosition(state.orbit);
  const basis = cameraBasis(position, [0, 0, 0], MARS_TUNING.camera.fov);
  const rel: Vec3 = [point[0] - position[0], point[1] - position[1], point[2] - position[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(rel, basis.forward);
  const x = dot(rel, basis.right) / (depth * basis.tanHalfFov * ASPECT);
  const y = dot(rel, basis.up) / (depth * basis.tanHalfFov);
  return [((x + 1) / 2) * SIZE[0], ((1 - y) / 2) * SIZE[1], depth];
}

/** Sprite half-size in pixels for a world-space half-size at a given depth. */
function spritePx(size: number, depth: number): number {
  const tanHalf = Math.tan((MARS_TUNING.camera.fov * Math.PI) / 360);
  return (size / depth) * (SIZE[1] / 2 / tanHalf);
}

function diffStats(a: Uint8Array, b: Uint8Array, box?: { x0: number; y0: number; x1: number; y1: number }) {
  let changed = 0;
  let darker = 0;
  let brighter = 0;
  let warmRim = 0;
  let maxLuminance = 0;
  let luminanceWith = 0;
  let luminanceWithout = 0;
  const sum: [number, number, number] = [0, 0, 0];
  const [w, h] = SIZE;
  const x0 = Math.max(0, Math.floor(box?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(box?.y0 ?? 0));
  const x1 = Math.min(w, Math.ceil(box?.x1 ?? w));
  const y1 = Math.min(h, Math.ceil(box?.y1 ?? h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const delta = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
      if (delta < DIFF_THRESHOLD) continue;
      changed++;
      const r = a[i]!;
      const g = a[i + 1]!;
      const bl = a[i + 2]!;
      sum[0] += r;
      sum[1] += g;
      sum[2] += bl;
      const lum = luminance(r, g, bl);
      const behind = luminance(b[i]!, b[i + 1]!, b[i + 2]!);
      maxLuminance = Math.max(maxLuminance, lum);
      luminanceWith += lum;
      luminanceWithout += behind;
      if (lum < behind) darker++;
      else {
        brighter++;
        if (r > g && g > bl) warmRim++;
      }
    }
  }
  const n = Math.max(1, changed);
  return {
    changed,
    darker,
    brighter,
    warmRim,
    // How much the element darkens what is behind it (1 = no change, < 1 = darker).
    luminanceRatio: Number((luminanceWith / Math.max(1, luminanceWithout)).toFixed(3)),
    maxLuminance: Math.round(maxLuminance),
    meanRgb: [sum[0] / n, sum[1] / n, sum[2] / n].map(Math.round),
  };
}

function marsPixels(pixels: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!;
    const g = pixels[i + 1]!;
    if (r > 60 && r > g * 1.4) count++;
  }
  return count;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const shaders = await loadMarsShaders();
  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  const targets = createTargets(gpu, SIZE);
  const output = target(gpu, { size: SIZE, format: OUTPUT_FORMAT });

  const renderState = async (state: SceneState): Promise<Rendered> => {
    setFrameUniforms(scene, SIZE, state);
    frame(gpu, (f) => render(f, scene, targets, output));
    const pixels = new Uint8Array(await output.color.read({ mipLevel: 0, region: "all" }));
    const bloomSize = targets.bloomA.size;
    const bloom = decodeHalfRgba(await targets.bloomA.color.read({ mipLevel: 0, region: "all" }), bloomSize[0] * bloomSize[1]);
    let bloomMax = 0;
    for (let i = 0; i < bloom.length; i += 4) bloomMax = Math.max(bloomMax, luminance(bloom[i]!, bloom[i + 1]!, bloom[i + 2]!));
    return { pixels, bloomMax };
  };

  try {
    setStaticBindings(scene, maps, targets);
    await Promise.all([bakeMaps(gpu, maps, shaders), prewarm(scene, targets, OUTPUT_FORMAT)]);

    // --- Timeline purity and reduced motion ------------------------------------------
    const reducedEarly = sceneAt(0, { aspect: ASPECT, reducedMotion: true });
    const reducedLate = sceneAt(37, { aspect: ASPECT, reducedMotion: true });
    check(JSON.stringify(reducedEarly) === JSON.stringify(reducedLate), "reduced motion: scene is identical at t=0 and t=37 (no flight, dolly, rotation, or hover)");
    check(reducedEarly.planetRotation === 0 && reducedEarly.helicopters.every((h) => h.visibility === 1), "reduced motion: settled composition with all three helicopters on station");
    check(sceneAt(TIMELINE.separation - 0.01, { aspect: ASPECT, reducedMotion: false }).helicopters.every((h) => h.visibility === 0), "helicopters hidden before separation");
    const settledMotion = sceneAt(TIMELINE.settled, { aspect: ASPECT, reducedMotion: false });
    check(Math.abs(settledMotion.planetRotation) < 1e-9, "canyon faces the camera when the intro settles (rotation 0 at t=10)");
    const rate = sceneAt(TIMELINE.settled + 10, { aspect: ASPECT, reducedMotion: false }).planetRotation / 10;
    check(rate >= 0.02 && rate <= 0.05, `planet rotation ${rate.toFixed(3)} rad/s is within DESIGN.md's 0.02-0.05`);

    // --- Flight stays over the disk at every supported stage aspect --------------------
    for (const aspect of [0.46, 0.56, 0.75, 0.89, 1.07, 1.19, 1.78]) {
      const state = sceneAt(TIMELINE.settled, { aspect, reducedMotion: false });
      const position = orbitPosition(state.orbit);
      const basis = cameraBasis(position, [0, 0, 0], MARS_TUNING.camera.fov);
      const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const diskTan = Math.tan(Math.asin(1 / state.orbit.radius));
      const worst = Math.max(
        ...state.helicopters.map((h) => {
          const rel: Vec3 = [h.position[0] - position[0], h.position[1] - position[1], h.position[2] - position[2]];
          const depth = dot(rel, basis.forward);
          // Angular offset from the disk centre, in units of the disk's angular radius.
          return Math.hypot(dot(rel, basis.right), dot(rel, basis.up)) / depth / diskTan;
        })
      );
      check(worst < 0.8, `aspect ${aspect}: all helicopters over the disk (outermost at ${(worst * 100).toFixed(0)}% of its radius)`);
    }

    // --- Contact sheet ----------------------------------------------------------------
    const frames = new Map<number, Rendered>();
    for (const t of SHEET_TIMES) {
      const rendered = await renderState(sceneAt(t, { aspect: ASPECT, reducedMotion: false }));
      frames.set(t, rendered);
      savePng(`m2-t${String(t).replace(".", "_")}.png`, SIZE[0], SIZE[1], rendered.pixels);
    }
    const tileW = Math.round(SIZE[0] * SHEET_SCALE);
    const tileH = Math.round(SIZE[1] * SHEET_SCALE);
    const tiles = await Promise.all(
      SHEET_TIMES.map(async (t, index) => ({
        input: await sharp(Buffer.from(frames.get(t)!.pixels), { raw: { width: SIZE[0], height: SIZE[1], channels: 4 } })
          .resize(tileW, tileH)
          .png()
          .toBuffer(),
        left: (index % 4) * tileW,
        top: Math.floor(index / 4) * tileH,
      }))
    );
    await sharp({ create: { width: tileW * 4, height: tileH * 2, channels: 4, background: "#05060a" } })
      .composite(tiles)
      .png()
      .toFile(`${OUT_DIR}m2-contact-sheet.png`);

    // --- Dolly ------------------------------------------------------------------------
    // Lit-Mars coverage must grow at every sampled moment of the dolly. (Its exact ratio
    // is not a pure function of distance: the camera also swings toward the lit side.)
    const dollyTimes = SHEET_TIMES.filter((t) => t <= TIMELINE.dollyEnd);
    const coverage = dollyTimes.map((t) => marsPixels(frames.get(t)!.pixels));
    const monotonic = coverage.every((value, index) => index === 0 || value > coverage[index - 1]!);
    const growth = coverage[coverage.length - 1]! / coverage[0]!;
    check(monotonic && growth > 2.5, `camera dollies in: lit Mars px ${coverage.join(" < ")} (x${growth.toFixed(2)})`);

    // --- Bloom stays on the sun only (sun is off-screen throughout the intro) ----------
    const bloomPeak = Math.max(...[...frames.values()].map((f) => f.bloomMax));
    check(bloomPeak < MAX_INTRO_BLOOM, `no bloom from planet, streak, or helicopters (peak ${bloomPeak.toFixed(4)})`);

    // --- Entry streak -------------------------------------------------------------------
    const entryState = sceneAt(3, { aspect: ASPECT, reducedMotion: false });
    const entryWithout = await renderState(hideFlight(entryState));
    const entry = diffStats(frames.get(3)!.pixels, entryWithout.pixels);
    const [er, eg, eb] = entry.meanRgb as [number, number, number];
    console.log("entry @3s:", JSON.stringify(entry));
    check(entry.changed > 40, `entry streak visible at t=3 (${entry.changed} px)`);
    check(er > eg && eg > eb, `entry streak is warm plasma (rgb ${entry.meanRgb.join(",")})`);
    const beforeEntry = await renderState(hideFlight(sceneAt(0, { aspect: ASPECT, reducedMotion: false })));
    check(diffStats(frames.get(0)!.pixels, beforeEntry.pixels).changed === 0, "nothing in flight at t=0");

    // --- Helicopters ----------------------------------------------------------------------
    const settled = sceneAt(TIMELINE.settled, { aspect: ASPECT, reducedMotion: false });
    const settledWithout = await renderState(hideFlight(settled));
    const sizes: number[] = [];
    settled.helicopters.forEach((helicopter, index) => {
      const [x, y, depth] = project(settled, helicopter.position);
      const half = spritePx(helicopter.size, depth);
      sizes.push(half * 2);
      const stats = diffStats(frames.get(10)!.pixels, settledWithout.pixels, { x0: x - half, y0: y - half, x1: x + half, y1: y + half });
      const name = "ABC"[index];
      console.log(`helicopter ${name}: sprite ${Math.round(half * 2)} px at (${Math.round(x)}, ${Math.round(y)})`, JSON.stringify(stats));
      check(stats.changed > half * 0.8, `helicopter ${name} visible on station (${stats.changed} px changed)`);
      // Judged against the ground it covers: anti-aliased edges and translucent rotor
      // blur over bright regolith are legitimately mid-tone, so absolute darkness misleads.
      check(
        // Ratio < 0.7, not lower: smaller sprites carry a larger share of anti-aliased
        // edge and rotor-blur pixels, which caps how far their average can drop.
        stats.luminanceRatio < 0.7 && stats.darker >= stats.changed * 0.85,
        `helicopter ${name} is a dark silhouette (darkens ground to ${stats.luminanceRatio}; ${stats.darker}/${stats.changed} px darker)`
      );
      check(stats.brighter <= stats.changed * 0.1, `helicopter ${name} rim stays subtle (${stats.brighter}/${stats.changed} px brighter than ground)`);
      check(stats.maxLuminance < 200, `helicopter ${name} does not glow (max luminance ${stats.maxLuminance})`);
      if (index === 0) check(stats.warmRim > 0, `helicopter ${name} has a warm rim on its sun side (${stats.warmRim} warm px brighter than ground)`);
    });
    check(sizes[0]! > sizes[1]! * 1.6 && sizes[0]! > sizes[2]! * 1.6, `helicopter A reads as the foreground silhouette (${sizes.map(Math.round).join(" / ")} px)`);

    console.log(`\nsaved ${OUT_DIR}m2-contact-sheet.png and m2-t*.png`);
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
  console.log("\nM2 headless verification passed");
}

await main();
