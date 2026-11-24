// M3 headless verification: radar sweep + subsurface-ice reveal, rendered with
// vgpu/node at the desktop stage size, with assertions on actual pixels, the bloom
// buffer, and the separate ice map.
// Run: npx tsx scripts/render-m3.ts
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { frame, init, target } from "vgpu/node";

import { SCAN, TIMELINE, sceneAt, type SceneState } from "../src/animation";
import { hudAt } from "../src/hud";
import { ICE_DEPOSIT } from "../src/mars-planet";
import {
  ICE_MAP_SIZE,
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
const SCAN_SAMPLES = [-0.03, 0.3, 0.6, 0.9, 1.15] as const; // fraction of SCAN.duration after start
// Sun is off-screen in the settled shot: outside a scan, nothing may bloom.
const MAX_IDLE_BLOOM = 0.02;

const { failures, check } = makeChecker();

function isIceBlue(r: number, g: number, b: number): boolean {
  return b > r + 25 && g > r && b > 110;
}

function iceBluePixels(pixels: Uint8Array) {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  // Position along the screen sweep direction (35 deg up-right; y grows downward).
  let sumAlong = 0;
  const along = [Math.cos((35 * Math.PI) / 180), -Math.sin((35 * Math.PI) / 180)];
  for (let y = 0; y < SIZE[1]; y++) {
    for (let x = 0; x < SIZE[0]; x++) {
      const i = (y * SIZE[0] + x) * 4;
      if (!isIceBlue(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)) continue;
      count++;
      sumX += x;
      sumY += y;
      sumAlong += x * along[0]! + y * along[1]!;
    }
  }
  const n = Math.max(1, count);
  return { count, meanX: sumX / n, meanY: sumY / n, meanAlong: sumAlong / n };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const shaders = await loadMarsShaders();
  const gpu = await init();
  const maps = createMaps(gpu);
  const scene = createScene(gpu, shaders);
  const targets = createTargets(gpu, SIZE);
  const output = target(gpu, { size: SIZE, format: OUTPUT_FORMAT });

  const renderState = async (state: SceneState) => {
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

    // --- The ice map is its own target, with ice only where intended -------------------
    const [iw, ih] = ICE_MAP_SIZE;
    const ice = new Uint8Array(await maps.ice.color.read({ mipLevel: 0, region: "all" }));
    const iceAt = (latDeg: number, lonRad: number) => {
      const u = (((lonRad / (2 * Math.PI)) % 1) + 1) % 1;
      const v = (90 - latDeg) / 180;
      // r8unorm: one byte per texel (rows are 1024 bytes, already 256-aligned).
      return ice[Math.min(ih - 1, Math.floor(v * ih)) * iw + Math.min(iw - 1, Math.floor(u * iw))]! / 255;
    };
    const iceBand = (lat0: number, lat1: number) => {
      let max = 0;
      for (let lat = lat0; lat <= lat1; lat += 0.5) for (let lon = 0; lon < 2 * Math.PI; lon += 0.02) max = Math.max(max, iceAt(lat, lon));
      return max;
    };
    const depositValue = iceAt((ICE_DEPOSIT.latitude * 180) / Math.PI, ICE_DEPOSIT.longitude);
    check(depositValue > 0.8, `ice map: deposit under the HUD anchor (value ${depositValue.toFixed(2)})`);
    check(iceBand(-20, 20) < 0.05, `ice map: no ice at low latitudes (max ${iceBand(-20, 20).toFixed(3)})`);
    check(iceBand(82, 90) < 0.05 && iceBand(-90, -82) < 0.05, "ice map: none under the polar caps (those are surface ice)");
    const icePng = new Uint8Array(iw * ih * 4);
    for (let i = 0; i < iw * ih; i++) {
      icePng[i * 4] = icePng[i * 4 + 1] = icePng[i * 4 + 2] = ice[i]!;
      icePng[i * 4 + 3] = 255;
    }
    savePng("m3-ice-map.png", iw, ih, icePng);

    // --- Sweep ------------------------------------------------------------------------
    const shots: { p: number; state: SceneState; blue: ReturnType<typeof iceBluePixels>; bloomMax: number; pixels: Uint8Array }[] = [];
    for (const p of SCAN_SAMPLES) {
      const state = sceneAt(SCAN.autoStart + p * SCAN.duration, { aspect: ASPECT, reducedMotion: false });
      const rendered = await renderState(state);
      savePng(`m3-scan-${Math.round(p * 100)}.png`, SIZE[0], SIZE[1], rendered.pixels);
      // The pulse line is itself blue-white; measure the revealed ice with it switched off.
      const measured = await renderState({ ...state, radar: { ...state.radar, pulse: 0 } });
      shots.push({ p, state, blue: iceBluePixels(measured.pixels), bloomMax: rendered.bloomMax, pixels: rendered.pixels });
      console.log(`p=${p}: phase ${state.radar.phase}, front ${state.radar.front.toFixed(2)}, pulse ${state.radar.pulse.toFixed(2)}, ice-blue px ${shots.at(-1)!.blue.count}, bloom max ${rendered.bloomMax.toFixed(3)}`);
    }
    const [before, early, mid, late, after] = shots;
    check(before!.state.radar.phase === "idle" && before!.blue.count === 0, `before the scan: nothing revealed (${before!.blue.count} ice-blue px)`);
    check(before!.bloomMax < MAX_IDLE_BLOOM, `before the scan: no bloom (${before!.bloomMax.toFixed(4)})`);
    check(early!.blue.count < mid!.blue.count && mid!.blue.count < late!.blue.count && late!.blue.count <= after!.blue.count, "reveal grows as the front advances");
    check(early!.blue.meanAlong < after!.blue.meanAlong, `sweep starts lower-left and moves up-right (mean position along sweep ${early!.blue.meanAlong.toFixed(0)} -> ${after!.blue.meanAlong.toFixed(0)})`);
    // Measured after the 4 blur passes, which spread the thin scan line and lower its
    // peak; any clearly non-zero value means the pulse crossed the bright-pass (idle and
    // complete frames measure exactly 0).
    check([early, mid, late].every((s) => s!.bloomMax > 0.05), `radar pulse blooms while scanning (${[early, mid, late].map((s) => s!.bloomMax.toFixed(2)).join(", ")})`);
    check(after!.state.radar.phase === "complete" && after!.bloomMax < MAX_IDLE_BLOOM, `after the scan: pulse gone, no bloom (${after!.bloomMax.toFixed(4)})`);
    check(after!.blue.count > 5000, `after the scan: subsurface ice revealed (${after!.blue.count} ice-blue px)`);
    check(after!.blue.meanY < SIZE[1] / 2, `revealed ice lies mostly in the northern hemisphere (mean y ${after!.blue.meanY.toFixed(0)} < ${SIZE[1] / 2})`);

    // --- HUD marker -------------------------------------------------------------------------
    const hudBefore = hudAt(before!.state, ASPECT);
    const hudAfter = hudAt(after!.state, ASPECT);
    check(!hudBefore.hotspots.ice.visible && hudAfter.hotspots.ice.visible, "HUD marker hidden before the sweep reaches the deposit, shown after");
    const mx = Math.round(hudAfter.hotspots.ice.x * SIZE[0]);
    const my = Math.round(hudAfter.hotspots.ice.y * SIZE[1]);
    let blueNearMarker = 0;
    for (let y = my - 8; y <= my + 8; y++) {
      for (let x = mx - 8; x <= mx + 8; x++) {
        const i = (y * SIZE[0] + x) * 4;
        if (isIceBlue(after!.pixels[i]!, after!.pixels[i + 1]!, after!.pixels[i + 2]!)) blueNearMarker++;
      }
    }
    check(blueNearMarker > 100, `HUD marker sits on revealed ice at (${mx}, ${my}) (${blueNearMarker}/289 px ice-blue)`);

    // --- Reduced motion: result shown, nothing moving or glowing ----------------------------
    const reducedA = sceneAt(0, { aspect: ASPECT, reducedMotion: true });
    const reducedB = sceneAt(50, { aspect: ASPECT, reducedMotion: true });
    check(JSON.stringify(reducedA) === JSON.stringify(reducedB) && reducedA.radar.phase === "complete", "reduced motion: scan shown complete and static");
    const reduced = await renderState(reducedA);
    const reducedBlue = iceBluePixels(reduced.pixels);
    check(reducedBlue.count > 5000 && reduced.bloomMax < MAX_IDLE_BLOOM, `reduced motion: ice visible (${reducedBlue.count} px), no pulse bloom (${reduced.bloomMax.toFixed(4)})`);
    check(hudAt(reducedA, ASPECT).hotspots.ice.visible, "reduced motion: HUD marker shown");
    savePng("m3-reduced.png", SIZE[0], SIZE[1], reduced.pixels);

    // --- Contact sheet ------------------------------------------------------------------------
    const scale = 0.3;
    const tileW = Math.round(SIZE[0] * scale);
    const tileH = Math.round(SIZE[1] * scale);
    const tiles = await Promise.all(
      shots.map(async (shot, index) => ({
        input: await sharp(Buffer.from(shot.pixels), { raw: { width: SIZE[0], height: SIZE[1], channels: 4 } }).resize(tileW, tileH).png().toBuffer(),
        left: index * tileW,
        top: 0,
      }))
    );
    await sharp({ create: { width: tileW * shots.length, height: tileH, channels: 4, background: "#05060a" } })
      .composite(tiles)
      .png()
      .toFile(`${OUT_DIR}m3-contact-sheet.png`);
    console.log(`\nsaved ${OUT_DIR}m3-contact-sheet.png, m3-scan-*.png, m3-reduced.png, m3-ice-map.png`);
    console.log(`(intro settles at t=${TIMELINE.settled}s; scan auto-starts at t=${SCAN.autoStart}s for ${SCAN.duration}s)`);
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
  console.log("\nM3 headless verification passed");
}

await main();
