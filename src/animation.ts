// Deterministic timeline: everything the renderer animates is a pure function of
// elapsed seconds, so any moment can be rendered headlessly and asserted on.
//
// Narrative (implementation.md): Mars distant and slowly rotating -> an entry vehicle
// streaks into the atmosphere -> three helicopters separate and fan outward -> the
// camera settles behind one helicopter -> (M3) a radar sweep reveals subsurface ice.
// Scale is stylised: the helicopters are deployment markers sized to read on screen,
// not to physical scale.
import {
  MARS_TUNING,
  cameraBasis,
  cameraRadiusForAspect,
  orbitPosition,
  rotateY,
  sunDirection,
  type OrbitState,
  type Vec3,
} from "./mars-planet";

export const TIMELINE = {
  // Camera dolly toward Mars (DESIGN.md: 8-12 s).
  dollyEnd: 10,
  entryStart: 1.2,
  separation: 4.4,
  // The entry streak fades out over this long after separation.
  entryFade: 0.8,
  // Helicopters fade in as they emerge, then fan out to their final stations.
  helicopterFadeIn: 0.5,
  fanEnd: 8.2,
  // From here on only ambient motion remains (planet rotation, gentle hover).
  settled: 10,
} as const;

// DESIGN.md: 0.02-0.05 rad/s. Rotation is zero at `settled`, where the canyon faces
// the camera (VALLEY_LONGITUDE), so the canyon rotates into view during the dolly.
export const PLANET_RADIANS_PER_SECOND = 0.03;

export const SCAN = {
  // Runs on its own shortly after the intro settles; M4's CTA can run it again.
  autoStart: 10.6,
  // DESIGN.md: radar sweep 2.5-4 s.
  duration: 3.2,
  // Front position along the sweep axis (planet radii). +-1 crosses the whole disk;
  // the extra 0.1 lets the pulse leave the limb before it fades.
  frontStart: -1.1,
  frontEnd: 1.1,
  // Fraction of the sweep over which the pulse ramps in and out.
  pulseRamp: 0.08,
} as const;
// DESIGN.md: the sweep moves diagonally across the visible surface. The front travels
// from the lower left (helicopter A's side) toward the upper right of the screen.
const SWEEP_SCREEN_ANGLE_RADIANS = (35 * Math.PI) / 180;
// Front values beyond the planet: everything revealed / nothing revealed.
export const FRONT_ALL_REVEALED = 2;
export const FRONT_NONE_REVEALED = -2;

// Click-to-ping (interaction): a radar ring expands from the clicked surface point.
export const PING = {
  durationSeconds: 1.6,
  // Angular radius the ring reaches (radians on the sphere, ~26 degrees).
  maxRadius: 0.45,
} as const;
// Cursor lean: how far the camera orbits toward the pointer at full deflection. Tiny on
// purpose: Mars stays centred, and the near helicopters (0.7 units from the camera)
// shift ~15 px, the far ones less: a subtle depth cue, not a camera move.
export const LEAN_RADIANS = 0.0015;
// Bounds for the user's vertical drag (camera tilt), in radians around the composed pitch.
export const USER_PITCH_LIMIT = 0.35;

const CAMERA = {
  start: { yawOffset: 0.4, pitch: 0.16, radius: 7.5 },
  // 4.2 keeps the whole disk (and the north cap) in frame, and keeps every desktop
  // stage (aspect >= 0.89) height-fitted, so the 16:9 poster matches it exactly.
  settled: { yawOffset: -0.12, pitch: 0.3, radius: 4.2 },
} as const;

// Stations in the current camera's frame: [forward, right, up] in world units.
// A is the foreground silhouette, low-left over the lit hemisphere; B and C recede.
// All three must sit over the lit side: dark silhouettes vanish against the night side.
const SEPARATION_POINT: Vec3 = [1.1, -0.06, 0.04];
const ENTRY_ORIGIN: Vec3 = [1.9, -1.25, 0.85];
const HELICOPTER_STATIONS: readonly Vec3[] = [
  [0.7, -0.09, -0.07],
  [1.45, 0.1, 0.0],
  [1.6, -0.02, 0.17],
];
// Each helicopter bows outward on its way to its station so the fan reads as a spread.
const FAN_ARC: readonly Vec3[] = [
  [-0.1, -0.06, -0.04],
  [0.05, 0.1, -0.02],
  [0.08, 0.0, 0.08],
];
export const HELICOPTER_SIZE = 0.035;
// Tail of the entry streak: where the vehicle was this much earlier in path progress.
const ENTRY_TAIL_LAG = 0.16;
const HOVER_AMPLITUDE = 0.0025;
const HOVER_PERIOD_SECONDS = 3.2;

export interface EntryState {
  readonly head: Vec3;
  readonly tail: Vec3;
  /** 0 = invisible, 1 = full plasma glow. */
  readonly intensity: number;
}

export interface HelicopterState {
  readonly position: Vec3;
  readonly size: number;
  /** 0..1 opacity; 0 before separation. */
  readonly visibility: number;
}

export type ScanPhase = "idle" | "scanning" | "complete";

export interface RadarState {
  /** Planet-local unit axis the front advances along (fixed to the ground once a scan starts). */
  readonly axis: Vec3;
  /** Front position along `axis`; see FRONT_ALL_REVEALED / FRONT_NONE_REVEALED. */
  readonly front: number;
  /** 0..1 pulse intensity. */
  readonly pulse: number;
  /** 0..1 scan progress. */
  readonly progress: number;
  readonly phase: ScanPhase;
  /** Click-to-ping ring: planet-local origin, angular radius, 0..1 strength (0 = none). */
  readonly ping: { readonly origin: Vec3; readonly radius: number; readonly strength: number };
}

export interface SceneState {
  /** Seconds driving ambient sway; constant under reduced motion. */
  readonly time: number;
  readonly orbit: OrbitState;
  readonly light: Vec3;
  readonly planetRotation: number;
  readonly entry: EntryState;
  readonly helicopters: readonly HelicopterState[];
  readonly radar: RadarState;
  /** World point on the entry vehicle's path, used to anchor the "Arrival" hotspot. */
  readonly entryAnchor: Vec3;
}

export interface UserView {
  /** Extra planet turn about its axis from horizontal drags (radians). */
  readonly yaw: number;
  /** Camera tilt from vertical drags (radians, clamped to +-USER_PITCH_LIMIT). */
  readonly pitch: number;
}

export interface SceneOptions {
  /** Canvas width / height; narrow canvases pull the camera back to keep Mars in frame. */
  readonly aspect: number;
  /** Reduced motion freezes the settled composition: no flight, dolly, or rotation,
   *  and the radar result is shown as already complete (no sweep). */
  readonly reducedMotion: boolean;
  /** When the radar scan starts, on the same clock; defaults to SCAN.autoStart.
   *  Scans never start before the intro settles. */
  readonly scanStart?: number;
  /** The user's drag state (user-initiated, so it applies under reduced motion too). */
  readonly user?: UserView;
  /** Planet turn from dragging at the moment the current scan started, so the swept
   *  ground stays pinned to the surface the user was looking at. */
  readonly scanUserYaw?: number;
  /** Pointer position over the canvas, -1..1 each axis. Ignored under reduced motion. */
  readonly lean?: { readonly x: number; readonly y: number };
  /** Active ping: planet-local origin and age in seconds (wall clock). */
  readonly ping?: { readonly origin: Vec3; readonly age: number };
}

export function sceneAt(
  seconds: number,
  { aspect, reducedMotion, scanStart, user, scanUserYaw = 0, lean, ping }: SceneOptions
): SceneState {
  const t = reducedMotion ? TIMELINE.settled : Math.max(0, seconds);
  const settledRadius = cameraRadiusForAspect(aspect, CAMERA.settled.radius);
  const startRadius = cameraRadiusForAspect(aspect, CAMERA.start.radius);
  const baseYaw = MARS_TUNING.poster.yaw;

  // Dolly in log space so the approach decelerates naturally as Mars fills the frame.
  const dolly = smootherstep(0, TIMELINE.dollyEnd, t);
  // The composed shot. The flight is staged in this frame, so when the camera leans or
  // tilts the near helicopters shift more than distant Mars: real depth parallax.
  const composed: OrbitState = {
    yaw: baseYaw + lerp(CAMERA.start.yawOffset, CAMERA.settled.yawOffset, dolly),
    pitch: lerp(CAMERA.start.pitch, CAMERA.settled.pitch, dolly),
    radius: Math.exp(lerp(Math.log(startRadius), Math.log(settledRadius), dolly)),
  };
  const leanX = reducedMotion ? 0 : clamp(lean?.x ?? 0, -1, 1);
  const leanY = reducedMotion ? 0 : clamp(lean?.y ?? 0, -1, 1);
  const orbit: OrbitState = {
    yaw: composed.yaw - leanX * LEAN_RADIANS,
    pitch: composed.pitch + clamp(user?.pitch ?? 0, -USER_PITCH_LIMIT, USER_PITCH_LIMIT) + leanY * LEAN_RADIANS,
    radius: composed.radius,
  };

  // The flight is staged in the *current* camera's frame: the camera travels with the
  // vehicle toward Mars, so the flight holds its place on screen over the lit hemisphere
  // while the planet grows behind it. (Staging it at the settled camera made it drift
  // off the disk through parallax while the camera was still far out.)
  // Flight offsets are authored for landscape. Narrow (portrait) canvases pull the camera
  // back, shrinking the disk on screen; the flight shrinks with it so the helicopters
  // stay over the same part of the planet. 1 on every landscape/desktop stage.
  const flightScale = diskScale(settledRadius) / diskScale(CAMERA.settled.radius);
  const frameOf = stationFrame(composed, flightScale);

  const entryProgress = clamp01((t - TIMELINE.entryStart) / (TIMELINE.separation - TIMELINE.entryStart));
  const entryOrigin = frameOf(ENTRY_ORIGIN);
  const separationPoint = frameOf(SEPARATION_POINT);
  // Ease-out: the vehicle decelerates as it aerobrakes, so the streak shortens.
  const entryAt = (p: number) => lerpVec(entryOrigin, separationPoint, easeOutCubic(clamp01(p)));
  const fadeIn = smootherstep(TIMELINE.entryStart, TIMELINE.entryStart + 0.5, t);
  const fadeOut = 1 - smootherstep(TIMELINE.separation, TIMELINE.separation + TIMELINE.entryFade, t);
  const entry: EntryState = {
    head: entryAt(entryProgress),
    tail: entryAt(entryProgress - ENTRY_TAIL_LAG),
    intensity: t < TIMELINE.entryStart ? 0 : fadeIn * fadeOut,
  };

  const fan = smootherstep(TIMELINE.separation, TIMELINE.fanEnd, t);
  const emerge = smootherstep(TIMELINE.separation, TIMELINE.separation + TIMELINE.helicopterFadeIn, t);
  const helicopters = HELICOPTER_STATIONS.map((station, index): HelicopterState => {
    const target = frameOf(station);
    const arc = frameOf(FAN_ARC[index]!, false);
    const bow = Math.sin(Math.PI * fan);
    const along = lerpVec(separationPoint, target, fan);
    const hover = reducedMotion
      ? 0
      : HOVER_AMPLITUDE * Math.sin((2 * Math.PI * t) / HOVER_PERIOD_SECONDS + index * 2.1) * smootherstep(TIMELINE.fanEnd - 1, TIMELINE.settled, t);
    return {
      position: [along[0] + arc[0] * bow, along[1] + arc[1] * bow + hover, along[2] + arc[2] * bow],
      size: HELICOPTER_SIZE * flightScale,
      visibility: t < TIMELINE.separation ? 0 : emerge,
    };
  });

  const rotationAt = (time: number) => (reducedMotion ? 0 : (time - TIMELINE.settled) * PLANET_RADIANS_PER_SECOND);
  const radar = radarAt(t, {
    reducedMotion,
    scanStart: Math.max(scanStart ?? SCAN.autoStart, TIMELINE.settled),
    settledOrbit: { yaw: baseYaw + CAMERA.settled.yawOffset, pitch: CAMERA.settled.pitch, radius: settledRadius },
    rotationAt: (time) => rotationAt(time) + scanUserYaw,
  });

  return {
    time: t,
    orbit,
    light: sunDirection(MARS_TUNING.poster.sunDegrees),
    planetRotation: rotationAt(t) + (user?.yaw ?? 0),
    entry,
    helicopters,
    radar: { ...radar, ping: pingAt(ping, reducedMotion) },
    entryAnchor: frameOf(lerpVec(ENTRY_ORIGIN, SEPARATION_POINT, ENTRY_ANCHOR_PROGRESS)),
  };
}

// Where along the entry path (0 = origin, 1 = separation) the "Arrival" hotspot sits.
const ENTRY_ANCHOR_PROGRESS = 0.72;

function pingAt(ping: SceneOptions["ping"], reducedMotion: boolean): RadarState["ping"] {
  const none = { origin: [1, 0, 0] as Vec3, radius: 0, strength: 0 };
  if (!ping || ping.age < 0 || ping.age >= PING.durationSeconds) return none;
  if (reducedMotion) {
    // No expanding ring: the reached area is marked at once, then simply cleared.
    return { origin: ping.origin, radius: PING.maxRadius, strength: 1 };
  }
  const progress = ping.age / PING.durationSeconds;
  return {
    origin: ping.origin,
    radius: PING.maxRadius * easeOutCubic(progress),
    strength: 1 - smootherstep(0.6, 1, progress),
  };
}

function radarAt(
  t: number,
  options: { reducedMotion: boolean; scanStart: number; settledOrbit: OrbitState; rotationAt: (time: number) => number }
): Omit<RadarState, "ping"> {
  // The sweep direction is chosen on screen (diagonal, from the settled camera), then
  // pinned to the ground: converted into the planet's frame as it was when the scan
  // started, so swept ground stays swept while the planet turns.
  const basis = cameraBasis(orbitPosition(options.settledOrbit), [0, 0, 0], MARS_TUNING.camera.fov);
  const cosA = Math.cos(SWEEP_SCREEN_ANGLE_RADIANS);
  const sinA = Math.sin(SWEEP_SCREEN_ANGLE_RADIANS);
  const axisWorld: Vec3 = [
    basis.right[0] * cosA + basis.up[0] * sinA,
    basis.right[1] * cosA + basis.up[1] * sinA,
    basis.right[2] * cosA + basis.up[2] * sinA,
  ];
  const axis = rotateY(axisWorld, -options.rotationAt(options.scanStart));

  type Sweep = Omit<RadarState, "ping">;
  if (options.reducedMotion) {
    return { axis, front: FRONT_ALL_REVEALED, pulse: 0, progress: 1, phase: "complete" } satisfies Sweep;
  }
  const progress = (t - options.scanStart) / SCAN.duration;
  if (progress < 0) return { axis, front: FRONT_NONE_REVEALED, pulse: 0, progress: 0, phase: "idle" } satisfies Sweep;
  if (progress >= 1) return { axis, front: FRONT_ALL_REVEALED, pulse: 0, progress: 1, phase: "complete" } satisfies Sweep;
  const pulse = smootherstep(0, SCAN.pulseRamp, progress) * (1 - smootherstep(1 - SCAN.pulseRamp, 1, progress));
  // Constant speed: a radar sweep, not an eased camera move.
  return { axis, front: lerp(SCAN.frontStart, SCAN.frontEnd, progress), pulse, progress, phase: "scanning" } satisfies Sweep;
}

/** Apparent size of the disk (tan of its angular radius) from a camera distance. */
function diskScale(cameraRadius: number): number {
  return Math.tan(Math.asin(MARS_TUNING.planet.radius / cameraRadius));
}

/** Maps [forward, right, up] offsets in the given orbit's camera frame to world space;
 *  the lateral (right, up) components are scaled by `lateralScale`. */
function stationFrame(orbit: OrbitState, lateralScale: number) {
  const position = orbitPosition(orbit);
  const basis = cameraBasis(position, [0, 0, 0], MARS_TUNING.camera.fov);
  return (offset: Vec3, fromCamera = true): Vec3 => {
    const f = offset[0];
    const r = offset[1] * lateralScale;
    const u = offset[2] * lateralScale;
    const origin = fromCamera ? position : ([0, 0, 0] as const);
    return [
      origin[0] + basis.forward[0] * f + basis.right[0] * r + basis.up[0] * u,
      origin[1] + basis.forward[1] * f + basis.right[1] * r + basis.up[1] * u,
      origin[2] + basis.forward[2] * f + basis.right[2] * r + basis.up[2] * u,
    ];
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smootherstep(edge0: number, edge1: number, value: number): number {
  const x = clamp01((value - edge0) / (edge1 - edge0));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function easeOutCubic(x: number): number {
  return 1 - (1 - x) ** 3;
}
