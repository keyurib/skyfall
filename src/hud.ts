// HUD and interaction geometry derived from a scene state: where each hotspot sits on
// screen, whether it should show, helicopter hit circles, and picking a surface point
// under the pointer. Pure, so the WebGPU renderer and the static fallback (which has no
// renderer) agree exactly, and tests can assert on it without a GPU.
import type { ScanPhase, SceneState } from "./animation";
import {
  MARS_TUNING,
  VALLEY_LONGITUDE,
  cameraBasis,
  iceDepositDirection,
  orbitPosition,
  rotateY,
  type Vec3,
} from "./mars-planet";

// Planet-anchored markers hide as their point turns toward the limb.
const MIN_FACING = 0.25;
// The ice marker appears just after the radar front has passed the deposit.
const REVEAL_MARGIN = 0.02;
// Helicopters are hotspots only once they are clearly visible.
const MIN_HELICOPTER_VISIBILITY = 0.5;
// The canyon hotspot: the canyon system's centre (bake-mars-surface.wgsl VALLEY_*).
const CANYON_SIN_LATITUDE = -0.14;

export type HotspotId = "entry" | "helicopters" | "canyon" | "ice";
/** Story order (arrival -> release -> terrain -> discovery); also the Tab order. */
export const HOTSPOT_ORDER: readonly HotspotId[] = ["entry", "helicopters", "canyon", "ice"];

export interface HudMarker {
  /** 0..1 across the canvas, from the left. */
  readonly x: number;
  /** 0..1 down the canvas, from the top. */
  readonly y: number;
  readonly visible: boolean;
}

export interface HelicopterHit extends HudMarker {
  /** Hit radius as a fraction of the canvas height. */
  readonly radius: number;
}

export interface HudState {
  readonly phase: ScanPhase;
  readonly progress: number;
  readonly hotspots: Readonly<Record<HotspotId, HudMarker>>;
  readonly helicopters: readonly HelicopterHit[];
  /** Where the active ping started (for its readout), if any. */
  readonly ping: HudMarker;
}

export function canyonDirection(): Vec3 {
  const ring = Math.sqrt(1 - CANYON_SIN_LATITUDE * CANYON_SIN_LATITUDE);
  return [ring * Math.cos(VALLEY_LONGITUDE), CANYON_SIN_LATITUDE, ring * Math.sin(VALLEY_LONGITUDE)];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function viewOf(state: SceneState, aspect: number) {
  const camera = orbitPosition(state.orbit);
  const basis = cameraBasis(camera, [0, 0, 0], MARS_TUNING.camera.fov);
  const project = (world: Vec3) => {
    const rel: Vec3 = [world[0] - camera[0], world[1] - camera[1], world[2] - camera[2]];
    const depth = dot(rel, basis.forward);
    const ndcX = dot(rel, basis.right) / (depth * basis.tanHalfFov * aspect);
    const ndcY = dot(rel, basis.up) / (depth * basis.tanHalfFov);
    return { x: (ndcX + 1) / 2, y: (1 - ndcY) / 2, depth, rel };
  };
  return { camera, basis, project };
}

export function hudAt(state: SceneState, aspect: number): HudState {
  const { basis, project } = viewOf(state, aspect);

  const surfaceMarker = (local: Vec3, extraVisible = true): HudMarker => {
    const world = rotateY(local, state.planetRotation);
    const p = project(world);
    const distance = Math.hypot(p.rel[0], p.rel[1], p.rel[2]) || 1;
    // On a unit sphere the surface normal is the position itself.
    const facing = -dot(world, p.rel) / distance;
    return { x: p.x, y: p.y, visible: extraVisible && facing > MIN_FACING && p.depth > 0 };
  };

  const deposit = iceDepositDirection();
  const iceRevealed = dot(deposit, state.radar.axis) < state.radar.front - REVEAL_MARGIN;

  const helicopters = state.helicopters.map((h): HelicopterHit => {
    const p = project(h.position);
    return {
      x: p.x,
      y: p.y,
      visible: h.visibility > MIN_HELICOPTER_VISIBILITY && p.depth > 0,
      radius: h.size / (p.depth * basis.tanHalfFov) / 2,
    };
  });

  const entry = project(state.entryAnchor);
  const ping = state.radar.ping;

  return {
    phase: state.radar.phase,
    progress: state.radar.progress,
    hotspots: {
      // Arrival: shown once the helicopters have separated (the story has "arrived").
      entry: { x: entry.x, y: entry.y, visible: entry.depth > 0 && (state.helicopters[0]?.visibility ?? 0) > MIN_HELICOPTER_VISIBILITY },
      // Release: anchored on the foreground helicopter (A).
      helicopters: helicopters[0] ?? { x: 0, y: 0, visible: false },
      canyon: surfaceMarker(canyonDirection()),
      ice: surfaceMarker(deposit, iceRevealed),
    },
    helicopters,
    ping: ping.strength > 0 ? surfaceMarker(ping.origin) : { x: 0, y: 0, visible: false },
  };
}

/**
 * The planet-local surface point under a canvas position (0..1 from the top left), or
 * null when the pointer is off the planet. Exact ray-sphere intersection (radius 1).
 */
export function pickPlanet(state: SceneState, aspect: number, x: number, y: number): Vec3 | null {
  const { camera, basis } = viewOf(state, aspect);
  const ndcX = x * 2 - 1;
  const ndcY = 1 - y * 2;
  const direction: Vec3 = [
    basis.forward[0] + basis.right[0] * ndcX * basis.tanHalfFov * aspect + basis.up[0] * ndcY * basis.tanHalfFov,
    basis.forward[1] + basis.right[1] * ndcX * basis.tanHalfFov * aspect + basis.up[1] * ndcY * basis.tanHalfFov,
    basis.forward[2] + basis.right[2] * ndcX * basis.tanHalfFov * aspect + basis.up[2] * ndcY * basis.tanHalfFov,
  ];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  const d: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  // |camera + s d|^2 = 1  ->  s^2 + 2 s (c.d) + (c.c - 1) = 0
  const b = dot(camera, d);
  const c = dot(camera, camera) - MARS_TUNING.planet.radius ** 2;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const s = -b - Math.sqrt(discriminant);
  if (s <= 0) return null;
  const hit: Vec3 = [camera[0] + d[0] * s, camera[1] + d[1] * s, camera[2] + d[2] * s];
  return rotateY(hit, -state.planetRotation);
}

/** The helicopter under a canvas position, if any (index), using the HUD hit circles. */
export function pickHelicopter(hud: HudState, aspect: number, x: number, y: number): number | null {
  for (let i = 0; i < hud.helicopters.length; i++) {
    const h = hud.helicopters[i]!;
    if (!h.visible) continue;
    // Compare in canvas-height units so the circle stays round.
    const dx = (x - h.x) * aspect;
    const dy = y - h.y;
    if (Math.hypot(dx, dy) <= h.radius) return i;
  }
  return null;
}

/** Equirect texture coordinates for a planet-local direction (sphere() convention). */
export function directionToUv(local: Vec3): [number, number] {
  const longitude = Math.atan2(local[2], local[0]);
  const u = (((longitude / (2 * Math.PI)) % 1) + 1) % 1;
  const v = Math.acos(Math.max(-1, Math.min(1, local[1]))) / Math.PI;
  return [u, v];
}
