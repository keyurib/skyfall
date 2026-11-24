// Mars scene resources shared by the browser renderer (M1c) and headless scripts.
// Environment-agnostic: callers pass prepared shaders, because the browser gets them
// from the bundler's .wgsl loader and Node gets them from resolveShader().
// Pass structure, resource ownership, and rollback follow the vgpu Earth example's
// renderer.ts: sky -> planet (MSAA) -> overlay -> bright-pass -> 4x blur -> composite.
import type { ClearColor, Frame, Gpu, ShaderSource, Surface, Target } from "vgpu";
import { draw, effect, frame, geometry, sampler, target } from "vgpu";
import { FRONT_NONE_REVEALED, type SceneState } from "./animation";
import { sphere } from "vgpu/scene";

import { cameraMatrices } from "./camera";
import {
  MARS_TUNING,
  bloomSize,
  cameraBasis,
  normalizeSize,
  orbitPosition,
  rotationYMatrix,
  type OrbitState,
  type Vec3,
} from "./mars-planet";

export interface MarsShaders {
  readonly bakeSurface: ShaderSource;
  readonly bakeIce: ShaderSource;
  readonly mars: ShaderSource;
  readonly atmosphere: ShaderSource;
  readonly sky: ShaderSource;
  readonly overlay: ShaderSource;
  readonly brightPass: ShaderSource;
  readonly blur: ShaderSource;
  readonly composite: ShaderSource;
  readonly helicopter: ShaderSource;
  readonly entryVehicle: ShaderSource;
}

// Sprites are blended over the planet and depth-tested against it (a helicopter behind
// Mars is hidden), but never write depth: their soft edges must not cut holes.
const SPRITE_DEPTH = { write: false, compare: "less-equal" } as const;
// Quad = two triangles; the shaders build corners from vertex_index.
const QUAD_VERTICES = 6;
export const HELICOPTER_COUNT = 3;
// Draws that only output colour (location 0) leave the radar-glow attachment untouched.
const COLOR_ONLY = [null, { writeMask: [] }] as const;

type Output = Surface | Target;
export type Maps = ReturnType<typeof createMaps>;
export type Scene = ReturnType<typeof createScene>;
export type Targets = ReturnType<typeof createTargets>;

const HDR_FORMAT: GPUTextureFormat = "rgba16float";
// The lit planet caps at 0.7, so an 8-bit sRGB MSAA target is sufficient (as in Earth).
const PLANET_FORMAT: GPUTextureFormat = "rgba8unorm-srgb";
// Unlike Earth, the surface alpha carries relief height for bump lighting. At 8 bits
// the screen-space slope spikes at every 1/255 step and draws contour lines, so the
// Mars surface map is half-float (linear albedo + smooth height).
export const SURFACE_MAP_FORMAT: GPUTextureFormat = "rgba16float";
// Conceptual subsurface-ice likelihood (M3), kept separate from the surface map and from
// any dust haze. Smooth, low-frequency data: half the surface map's resolution suffices.
export const ICE_MAP_FORMAT: GPUTextureFormat = "r8unorm";
export const ICE_MAP_SIZE = [1024, 512] as const;
// Planet target attachment 1: radar glow / GLOW_SCALE (see mars-common.wgsl). r8unorm,
// because MSAA rgba16float is unsupported on Dawn compatibility-mode devices.
const GLOW_FORMAT: GPUTextureFormat = "r8unorm";
const OPAQUE_BLACK = [0, 0, 0, 1] as const;
const TRANSPARENT = [0, 0, 0, 0] as const;

export function createMaps(gpu: Gpu) {
  return createResourceGraph((own) => ({
    surface: own(target(gpu, { size: MARS_TUNING.maps.size, format: SURFACE_MAP_FORMAT })),
    ice: own(target(gpu, { size: ICE_MAP_SIZE, format: ICE_MAP_FORMAT })),
  }));
}

export function createScene(gpu: Gpu, shaders: MarsShaders) {
  return createResourceGraph((own) => {
    const marsGeometry = own(geometry(gpu, sphere(MARS_TUNING.planet)));
    const atmosphereGeometry = own(geometry(gpu, sphere(MARS_TUNING.atmosphere)));
    return {
      marsGeometry,
      atmosphereGeometry,
      mars: draw(gpu, { shader: shaders.mars, geometry: marsGeometry, cull: "back" }),
      // Alpha blending turns the shell's fresnel into a rim glow (as in Earth).
      atmosphere: draw(gpu, {
        shader: shaders.atmosphere,
        geometry: atmosphereGeometry,
        blend: "alpha",
        colors: COLOR_ONLY,
      }),
      helicopters: draw(gpu, {
        shader: shaders.helicopter,
        vertices: QUAD_VERTICES,
        instances: HELICOPTER_COUNT,
        blend: "alpha",
        depth: SPRITE_DEPTH,
      }),
      entryVehicle: draw(gpu, {
        shader: shaders.entryVehicle,
        vertices: QUAD_VERTICES,
        blend: "alpha",
        depth: SPRITE_DEPTH,
        colors: COLOR_ONLY,
      }),
      sky: effect(gpu, shaders.sky),
      overlay: effect(gpu, shaders.overlay, { blend: "premultiplied" }),
      bright: effect(gpu, shaders.brightPass),
      // Each encoded blur needs its own uniform buffer.
      blur: [
        effect(gpu, shaders.blur),
        effect(gpu, shaders.blur),
        effect(gpu, shaders.blur),
        effect(gpu, shaders.blur),
      ] as const,
      composite: effect(gpu, shaders.composite),
      mapSampler: sampler(gpu, {
        minFilter: "linear",
        magFilter: "linear",
        // Longitude wraps, latitude does not.
        addressModeU: "repeat",
        addressModeV: "clamp-to-edge",
      }),
      linearSampler: sampler(gpu, { minFilter: "linear", magFilter: "linear" }),
    };
  });
}

export function createTargets(gpu: Gpu, size: readonly [number, number]) {
  return createResourceGraph((own) => {
    const full = normalizeSize(size);
    const bloom = bloomSize(full);
    return {
      beauty: own(target(gpu, { size: full, format: HDR_FORMAT })),
      planet: own(
        target(gpu, {
          size: full,
          colors: [{ format: PLANET_FORMAT }, { format: GLOW_FORMAT }],
          msaa: true,
          depth: true,
        })
      ),
      bloomA: own(target(gpu, { size: bloom, format: HDR_FORMAT })),
      bloomB: own(target(gpu, { size: bloom, format: HDR_FORMAT })),
    };
  });
}

export function setStaticBindings(scene: Scene, maps: Maps, targets: Targets): void {
  const { bloom } = MARS_TUNING;
  scene.mars.set({ surfaceMap: maps.surface, iceMap: maps.ice, mapSampler: scene.mapSampler });
  scene.overlay.set({ samp: scene.linearSampler });
  scene.bright.set({ samp: scene.linearSampler });
  const directions = [
    [1, 0],
    [0, 1],
  ] as const;
  scene.blur.forEach((pass, index) => {
    pass.set({
      samp: scene.linearSampler,
      blur: {
        texelSize: (index % 2 === 0 ? targets.bloomA : targets.bloomB).texelSize,
        direction: directions[index % 2]!,
        radius: bloom.radii[Math.floor(index / 2)],
      },
    });
  });
  scene.composite.set({ samp: scene.linearSampler, bloom: targets.bloomA });
  setSizeBindings(scene, targets);
}

export function setSizeBindings(scene: Scene, targets: Targets): void {
  // Re-bound after every resize: resizing recreates the planet target's attachments.
  scene.overlay.set({ planetTexture: targets.planet, glowTexture: targets.planet.colors[1]! });
  scene.bright.set({ src: targets.beauty });
  const sources = [targets.bloomA, targets.bloomB] as const;
  scene.blur.forEach((pass, index) => {
    const src = sources[index % 2]!;
    pass.set({ src, blur: { texelSize: src.texelSize } });
  });
  scene.composite.set({ beauty: targets.beauty, bloom: targets.bloomA });
}

export function resizeTargets(targets: Targets, size: readonly [number, number]): void {
  const full = normalizeSize(size);
  const bloom = bloomSize(full);
  targets.beauty.resize(full);
  targets.planet.resize(full);
  targets.bloomA.resize(bloom);
  targets.bloomB.resize(bloom);
}

// The procedural maps are baked once, in a single submit.
export async function bakeMaps(gpu: Gpu, maps: Maps, shaders: MarsShaders): Promise<void> {
  const surfacePass = effect(gpu, shaders.bakeSurface);
  const icePass = effect(gpu, shaders.bakeIce);
  await Promise.all([surfacePass.compile(maps.surface), icePass.compile(maps.ice)]);
  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: maps.surface, clear: TRANSPARENT }, (pass) => pass.draw(surfacePass));
    currentFrame.pass({ target: maps.ice, clear: TRANSPARENT }, (pass) => pass.draw(icePass));
  });
}

export async function prewarm(scene: Scene, targets: Targets, outputFormat: GPUTextureFormat): Promise<void> {
  await Promise.all([
    scene.sky.compile(targets.beauty),
    scene.mars.compile(targets.planet),
    scene.atmosphere.compile(targets.planet),
    scene.helicopters.compile(targets.planet),
    scene.entryVehicle.compile(targets.planet),
    scene.overlay.compile(targets.beauty),
    scene.bright.compile(targets.bloomA),
    ...scene.blur.map((pass, index) => pass.compile(index % 2 === 0 ? targets.bloomB : targets.bloomA)),
    scene.composite.compile({ colors: [outputFormat] }),
  ]);
}

/** A still frame: camera and sun only, no flight elements, planet unrotated. */
export function staticFrameState(orbit: OrbitState, light: Vec3): SceneState {
  const hidden = { position: [0, 0, 0] as Vec3, size: 0, visibility: 0 };
  return {
    time: 0,
    orbit,
    light,
    planetRotation: 0,
    entry: { head: [0, 0, 0], tail: [0, 0, 0], intensity: 0 },
    radar: {
      axis: [1, 0, 0],
      front: FRONT_NONE_REVEALED,
      pulse: 0,
      progress: 0,
      phase: "idle",
      ping: { origin: [1, 0, 0], radius: 0, strength: 0 },
    },
    entryAnchor: [0, 0, 0],
    helicopters: Array.from({ length: HELICOPTER_COUNT }, () => hidden),
  };
}

/** A sub-rectangle of the canvas, in canvas pixels, that the camera frames. */
export interface StageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Sets every per-frame uniform. With `stage`, the camera frames Mars inside that part of
 * the canvas (an off-centre projection) while sky and stars fill the whole canvas: the
 * full-bleed hero keeps Mars in the right two-thirds on desktop. Without it, the whole
 * canvas is the stage (headless renders).
 */
export function setFrameUniforms(
  scene: Scene,
  size: readonly [number, number],
  state: SceneState,
  stage: StageRect = { x: 0, y: 0, width: size[0], height: size[1] }
): void {
  const { camera, atmosphere } = MARS_TUNING;
  const { light: lightDirection } = state;
  const aspect = stage.width / Math.max(1, stage.height);
  const position = orbitPosition(state.orbit);
  const centred = cameraMatrices({
    fov: camera.fov,
    aspect,
    near: camera.near,
    far: camera.far,
    position,
    target: [0, 0, 0],
  });
  // Clip-space remap of the stage's [-1, 1] NDC square onto its rectangle in the canvas.
  const scaleX = stage.width / size[0];
  const scaleY = stage.height / size[1];
  const offsetX = ((stage.x + stage.width / 2) / size[0]) * 2 - 1;
  const offsetY = 1 - ((stage.y + stage.height / 2) / size[1]) * 2;
  const view = { viewProjection: stageRemap(centred.viewProjection, scaleX, scaleY, offsetX, offsetY) };
  const basis = cameraBasis(position, [0, 0, 0], camera.fov);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const screenLight = [dot(lightDirection, basis.right), dot(lightDirection, basis.up)] as const;
  const screenLightLength = Math.hypot(screenLight[0], screenLight[1]) || 1;

  scene.mars.set({
    mars: {
      viewProjection: view.viewProjection,
      model: rotationYMatrix(state.planetRotation),
      cameraPosition: position,
      lightDirection,
      sweepAxis: state.radar.axis,
      sweepFront: state.radar.front,
      pulse: state.radar.pulse,
      pingOrigin: state.radar.ping.origin,
      pingRadius: state.radar.ping.radius,
      pingStrength: state.radar.ping.strength,
    },
  });
  scene.atmosphere.set({
    atmosphere: {
      viewProjection: view.viewProjection,
      cameraPosition: position,
      strength: atmosphere.strength,
      lightDirection,
      _pad: 0,
    },
  });
  scene.helicopters.set({
    helicopters: {
      viewProjection: view.viewProjection,
      cameraRight: basis.right,
      time: state.time,
      cameraUp: basis.up,
      lightScreen: [screenLight[0] / screenLightLength, screenLight[1] / screenLightLength],
      instances: state.helicopters.map((h) => [h.position[0], h.position[1], h.position[2], h.size]),
      visibility: [
        state.helicopters[0]?.visibility ?? 0,
        state.helicopters[1]?.visibility ?? 0,
        state.helicopters[2]?.visibility ?? 0,
        0,
      ],
    },
  });
  scene.entryVehicle.set({
    entry: {
      viewProjection: view.viewProjection,
      head: state.entry.head,
      intensity: state.entry.intensity,
      tail: state.entry.tail,
      viewport: [size[0], size[1]],
    },
  });
  // Canvas edges in the stage's NDC, then in tan units of the stage camera.
  const tanX = basis.tanHalfFov * aspect;
  const tanY = basis.tanHalfFov;
  scene.sky.set({
    sky: {
      right: basis.right,
      up: basis.up,
      forward: basis.forward,
      lightDirection,
      frustum: [
        ((-1 - offsetX) / scaleX) * tanX,
        ((1 - offsetX) / scaleX) * tanX,
        ((-1 - offsetY) / scaleY) * tanY,
        ((1 - offsetY) / scaleY) * tanY,
      ],
    },
  });
}

/** S * M for S = [sx 0 0 ox; 0 sy 0 oy; 0 0 1 0; 0 0 0 1], M column-major 4x4. */
function stageRemap(m: ArrayLike<number>, sx: number, sy: number, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    const x = m[column * 4]!;
    const y = m[column * 4 + 1]!;
    const z = m[column * 4 + 2]!;
    const w = m[column * 4 + 3]!;
    out[column * 4] = sx * x + ox * w;
    out[column * 4 + 1] = sy * y + oy * w;
    out[column * 4 + 2] = z;
    out[column * 4 + 3] = w;
  }
  return out;
}

// Planet only, into its MSAA target (used by the M1a surface check).
export function renderPlanet(
  currentFrame: Frame,
  scene: Scene,
  targets: Targets,
  clear: ClearColor = TRANSPARENT
): void {
  currentFrame.pass({ target: targets.planet, clear }, (pass) => pass.draw(scene.mars));
}

export function render(
  currentFrame: Frame,
  scene: Scene,
  targets: Targets,
  output: Output,
  { sky = true }: { readonly sky?: boolean } = {}
): void {
  // Sky first, then the planet into its own MSAA target, then lay it over the sky.
  // sky: false renders the planet over black (transparent-sky posters).
  currentFrame.pass({ target: targets.beauty, clear: OPAQUE_BLACK }, (pass) => {
    if (sky) pass.draw(scene.sky);
  });
  currentFrame.pass({ target: targets.planet, clear: TRANSPARENT }, (pass) => {
    pass.draw(scene.mars);
    pass.draw(scene.atmosphere);
    pass.draw(scene.entryVehicle);
    pass.draw(scene.helicopters);
  });
  currentFrame.pass({ target: targets.beauty, clear: false }, (pass) => pass.draw(scene.overlay));

  currentFrame.pass({ target: targets.bloomA, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.bright));
  const bloomTargets = [targets.bloomB, targets.bloomA] as const;
  scene.blur.forEach((blurPass, index) => {
    currentFrame.pass({ target: bloomTargets[index % 2]!, clear: OPAQUE_BLACK }, (pass) => {
      pass.draw(blurPass);
    });
  });

  currentFrame.pass({ target: output, clear: OPAQUE_BLACK }, (pass) => pass.draw(scene.composite));
}

export function destroyScene(scene: Scene): void {
  destroyResources([scene.marsGeometry, scene.atmosphereGeometry]);
}

export function destroyTargets(targets: Targets): void {
  destroyResources([targets.beauty, targets.planet, targets.bloomA, targets.bloomB]);
}

export function destroyMaps(maps: Maps): void {
  destroyResources([maps.surface, maps.ice]);
}

function createResourceGraph<T>(build: (own: <R extends object>(resource: R) => R) => T): T {
  const resources: object[] = [];
  try {
    return build((resource) => {
      resources.push(resource);
      return resource;
    });
  } catch (error) {
    try {
      destroyResources(resources);
    } catch {
      // Preserve the construction failure after attempting every rollback.
    }
    throw error;
  }
}

function destroyResources(resources: readonly object[]): void {
  let firstError: unknown;
  let failed = false;
  for (let i = resources.length - 1; i >= 0; i--) {
    try {
      (resources[i] as { destroy?: () => void }).destroy?.();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}
