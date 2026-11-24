// Interaction verification (headless): picking, helicopter hit circles, drag, lean
// parallax, and the click-to-ping ring rendered with vgpu/node.
// Run: npx tsx scripts/render-interaction.ts
import { mkdirSync } from "node:fs";
import { frame, init, target } from "vgpu/node";

import { PING, TIMELINE, USER_PITCH_LIMIT, sceneAt, type SceneState } from "../src/animation";
import { hudAt, pickHelicopter, pickPlanet } from "../src/hud";
import { MARS_TUNING, cameraBasis, orbitPosition, rotateY, type Vec3 } from "../src/mars-planet";
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

const SIZE = [1280, 1080] as const;
const ASPECT = SIZE[0] / SIZE[1];
const OUTPUT_FORMAT: GPUTextureFormat = "rgba8unorm";
const SETTLED = TIMELINE.settled + 8; // after the auto scan

const { failures, check } = makeChecker();

function project(state: SceneState, world: Vec3): [number, number] {
  const camera = orbitPosition(state.orbit);
  const basis = cameraBasis(camera, [0, 0, 0], MARS_TUNING.camera.fov);
  const rel: Vec3 = [world[0] - camera[0], world[1] - camera[1], world[2] - camera[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = dot(rel, basis.forward);
  return [(dot(rel, basis.right) / (depth * basis.tanHalfFov * ASPECT) + 1) / 2, (1 - dot(rel, basis.up) / (depth * basis.tanHalfFov)) / 2];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // --- Picking: click -> surface point -> back to the same screen position -------------
  const base = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false });
  let worstError = 0;
  for (const [x, y] of [[0.5, 0.5], [0.4, 0.35], [0.62, 0.6], [0.45, 0.7]] as const) {
    const local = pickPlanet(base, ASPECT, x, y);
    if (!local) {
      worstError = Infinity;
      continue;
    }
    const [px, py] = project(base, rotateY(local, base.planetRotation));
    worstError = Math.max(worstError, Math.hypot((px - x) * SIZE[0], (py - y) * SIZE[1]));
  }
  check(worstError < 0.5, `click on Mars picks the exact surface point (worst round-trip error ${worstError.toFixed(3)} px)`);
  check(pickPlanet(base, ASPECT, 0.03, 0.03) === null, "click on empty space picks nothing");

  // --- Helicopter hit circles land on the sprites -----------------------------------
  const hud = hudAt(base, ASPECT);
  const hits = hud.helicopters.map((h) => pickHelicopter(hud, ASPECT, h.x, h.y));
  check(hits.every((hit, index) => hit === index), `each helicopter is clickable at its centre (${hits.join(", ")})`);
  const a = hud.helicopters[0]!;
  check(pickHelicopter(hud, ASPECT, a.x + (a.radius * 3) / ASPECT, a.y) === null, "clicks beside a helicopter fall through to the planet");

  // --- Drag turns the planet (surface hotspots move, helicopters stay) ----------------
  const turned = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false, user: { yaw: 0.4, pitch: 0 } });
  const before = hud.hotspots.canyon;
  const after = hudAt(turned, ASPECT).hotspots.canyon;
  const movedPx = Math.hypot((after.x - before.x) * SIZE[0], (after.y - before.y) * SIZE[1]);
  const heliMovedPx = Math.hypot((hudAt(turned, ASPECT).helicopters[0]!.x - a.x) * SIZE[0], 0);
  check(movedPx > 50 && heliMovedPx < 0.5, `horizontal drag turns Mars (canyon moves ${movedPx.toFixed(0)} px; helicopters ${heliMovedPx.toFixed(1)} px)`);
  const tilted = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false, user: { yaw: 0, pitch: 9 } });
  check(Math.abs(tilted.orbit.pitch - base.orbit.pitch - USER_PITCH_LIMIT) < 1e-9, "vertical drag tilt is clamped");

  // --- Lean: a subtle depth parallax. The camera orbits Mars, so Mars stays centred; the
  // near helicopter shifts a little, and more than the farther ones.
  const leaning = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false, lean: { x: 1, y: 0 } });
  const leanHud = hudAt(leaning, ASPECT);
  const shift = (index: number) => Math.abs(leanHud.helicopters[index]!.x - hud.helicopters[index]!.x) * SIZE[0];
  const marsShift = Math.abs(project(leaning, [0, 0, 0])[0] - project(base, [0, 0, 0])[0]) * SIZE[0];
  check(
    shift(0) >= 6 && shift(0) <= 30 && shift(0) > shift(1) && shift(0) > shift(2) && marsShift < 0.5,
    `cursor lean: subtle depth parallax (A ${shift(0).toFixed(1)} px > B ${shift(1).toFixed(1)}, C ${shift(2).toFixed(1)}; Mars ${marsShift.toFixed(1)} px)`
  );
  const leaningReduced = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: true, lean: { x: 1, y: 1 } });
  check(JSON.stringify(leaningReduced.orbit) === JSON.stringify(sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: true }).orbit), "reduced motion ignores cursor lean");

  // --- Ping ring (rendered) ---------------------------------------------------------------
  const origin = pickPlanet(base, ASPECT, 0.42, 0.62)!;
  const shaders = await loadMarsShaders();
  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  const targets = createTargets(gpu, SIZE);
  const output = target(gpu, { size: SIZE, format: OUTPUT_FORMAT });
  const renderState = async (state: SceneState) => {
    setFrameUniforms(scene, SIZE, state);
    frame(gpu, (f) => render(f, scene, targets, output));
    // Copy: readbacks may share a staging buffer that a later read reuses.
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
    const quiet = await renderState(base);
    const midPing = sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false, ping: { origin, age: PING.durationSeconds * 0.4 } });
    const pinged = await renderState(midPing);
    savePng("interaction-ping.png", SIZE[0], SIZE[1], pinged.pixels);
    const ended = await renderState(sceneAt(SETTLED, { aspect: ASPECT, reducedMotion: false, ping: { origin, age: PING.durationSeconds + 0.1 } }));

    // Changed pixels should sit on a ring of the expected radius around the click point.
    const [cx, cy] = [0.42 * SIZE[0], 0.62 * SIZE[1]];
    let changed = 0;
    let nearRing = 0;
    for (let y = 0; y < SIZE[1]; y++) {
      for (let x = 0; x < SIZE[0]; x++) {
        const i = (y * SIZE[0] + x) * 4;
        const delta = Math.abs(pinged.pixels[i]! - quiet.pixels[i]!) + Math.abs(pinged.pixels[i + 2]! - quiet.pixels[i + 2]!);
        if (delta < 30) continue;
        changed++;
        if (Math.hypot(x - cx, y - cy) < 0.45 * SIZE[1]) nearRing++;
      }
    }
    check(changed > 300 && nearRing / changed > 0.95, `ping ring drawn around the clicked point (${changed} px changed, ${((nearRing / changed) * 100).toFixed(0)}% near it)`);
    check(quiet.bloomMax < 0.02 && pinged.bloomMax > 0.05, `ping ring blooms; nothing else does (${quiet.bloomMax.toFixed(4)} -> ${pinged.bloomMax.toFixed(3)})`);
    let residual = 0;
    for (let i = 0; i < quiet.pixels.length; i++) residual = Math.max(residual, Math.abs(ended.pixels[i]! - quiet.pixels[i]!));
    check(residual === 0, `ping clears completely when it ends (max residual ${residual})`);
    // Full-bleed framing: Mars framed in the right two-thirds of a 1920 x 1080 canvas must
    // look exactly like a standalone 1280 x 1080 render of that stage (sky continues left).
    const wide = [1920, 1080] as const;
    const wideTargets = createTargets(gpu, wide);
    const wideOutput = target(gpu, { size: wide, format: OUTPUT_FORMAT });
    try {
      setStaticBindings(scene, maps, wideTargets);
      await prewarm(scene, wideTargets, OUTPUT_FORMAT);
      setFrameUniforms(scene, wide, base, { x: 640, y: 0, width: 1280, height: 1080 });
      frame(gpu, (f) => render(f, scene, wideTargets, wideOutput));
      const widePixels = new Uint8Array(await wideOutput.color.read({ mipLevel: 0, region: "all" }));
      savePng("interaction-fullbleed.png", wide[0], wide[1], widePixels);
      // Compare the planet's core (central half of the stage), away from vignette edges.
      let sum = 0;
      let n = 0;
      for (let y = 270; y < 810; y++) {
        for (let x = 320; x < 960; x++) {
          const a = (y * SIZE[0] + x) * 4;
          const b = (y * wide[0] + x + 640) * 4;
          for (let c = 0; c < 3; c++) sum += Math.abs(quiet.pixels[a + c]! - widePixels[b + c]!);
          n += 3;
        }
      }
      const meanDiff = sum / n;
      check(meanDiff < 3, `full-bleed canvas frames Mars exactly as the stage render (mean diff ${meanDiff.toFixed(2)} over the planet core)`);
    } finally {
      (wideOutput as { destroy?: () => void }).destroy?.();
      destroyTargets(wideTargets);
      setStaticBindings(scene, maps, targets);
    }

    const reducedPing = sceneAt(0, { aspect: ASPECT, reducedMotion: true, ping: { origin, age: 0.1 } }).radar.ping;
    const reducedPingLater = sceneAt(0, { aspect: ASPECT, reducedMotion: true, ping: { origin, age: 1.0 } }).radar.ping;
    check(
      reducedPing.radius === PING.maxRadius && JSON.stringify(reducedPing) === JSON.stringify(reducedPingLater),
      "reduced motion: ping marks its area at once, without expanding"
    );
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
  console.log("\nInteraction verification passed");
}

await main();
