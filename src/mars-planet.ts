// Device-free camera, sun, and sizing math for the Mars renderer.
// Adapted from the vgpu Earth example's planet.ts.

type Vec3 = readonly [number, number, number];

// Longitude (radians, sphere() convention) of the canyon system baked by
// bake-mars-surface.wgsl (VALLEY_LONGITUDE). The poster camera faces it.
export const VALLEY_LONGITUDE = 1.3;

// sphere() places longitude phi at (cos phi, 0, sin phi); orbitPosition() places
// yaw at (sin yaw, 0, cos yaw). Facing longitude phi therefore needs yaw = PI/2 - phi.
function yawFacingLongitude(longitude: number): number {
  return Math.PI / 2 - longitude;
}

const RADIANS_TO_DEGREES = 180 / Math.PI;

export const MARS_TUNING = {
  camera: { fov: 38, near: 0.1, far: 200 },
  // 257 x 129 vertices stays under the uint16 index limit of vgpu/scene sphere().
  planet: { radius: 1, widthSegments: 256, heightSegments: 128 },
  // Shell height matches Earth (1.02) so the rim stays legible at globe scale; Mars' thin
  // atmosphere shows up as a softer falloff and lower strength (Earth 1.0) instead.
  atmosphere: { radius: 1.022, widthSegments: 128, heightSegments: 64, strength: 0.85 },
  maps: { size: [2048, 1024] as const },
  // Bloom runs at 360 px tall; the second blur pair widens the halo (Earth values).
  bloom: { height: 360, radii: [1.4, 3.4] as const },
  // Mars' axial tilt is 25.19 degrees; the sun rides this far above the equator plane.
  sun: { tiltDegrees: 25.19 },
  poster: {
    yaw: yawFacingLongitude(VALLEY_LONGITUDE),
    // Looking slightly down shows the north polar cap and keeps the canyon in view.
    pitch: 0.42,
    // At fov 38 this makes the disk fill roughly 70% of the frame height.
    radius: 4.3,
    // Sun ~72 degrees to the viewer's left of the facing meridian: a gibbous disk with
    // a clear terminator on the right, leaving room for the M1b limb rim light.
    sunDegrees: (VALLEY_LONGITUDE + 1.25) * RADIANS_TO_DEGREES,
    // On narrow (portrait) canvases the disk may span at most this fraction of the width;
    // the camera backs off instead of letting the vertical fov crop the planet's sides.
    maxDiskWidthFraction: 0.8,
  },
} as const;

/**
 * Camera distance that keeps a framing at any canvas aspect (width / height).
 * The fov is vertical, so on wide canvases the disk keeps the same fraction of the
 * height as at `baseRadius`; on narrow ones the camera pulls back until the disk
 * fits `maxDiskWidthFraction` of the width.
 */
export function cameraRadiusForAspect(aspect: number, baseRadius: number = MARS_TUNING.poster.radius): number {
  const { camera, planet, poster } = MARS_TUNING;
  const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
  const posterTan = Math.tan(Math.asin(planet.radius / baseRadius));
  const fitTan = poster.maxDiskWidthFraction * Math.max(aspect, 1e-3) * tanHalfFov;
  const angularRadius = Math.atan(Math.min(posterTan, fitTan));
  return planet.radius / Math.sin(angularRadius);
}

export function posterOrbitForAspect(aspect: number): OrbitState {
  const { yaw, pitch } = MARS_TUNING.poster;
  return { yaw, pitch, radius: cameraRadiusForAspect(aspect) };
}

// Concentrated conceptual ice deposit baked by bake-ice.wgsl (DEPOSIT_LATITUDE /
// DEPOSIT_LONGITUDE must match). The HUD marker pins to it. Northern mid-latitudes,
// a little right of the settled camera's facing meridian.
export const ICE_DEPOSIT = { latitude: (40 * Math.PI) / 180, longitude: 1.07 } as const;

export function iceDepositDirection(): Vec3 {
  const ring = Math.cos(ICE_DEPOSIT.latitude);
  return [ring * Math.cos(ICE_DEPOSIT.longitude), Math.sin(ICE_DEPOSIT.latitude), ring * Math.sin(ICE_DEPOSIT.longitude)];
}

/**
 * Rotates `v` about +Y by `radians`; the same rotation as the planet's model matrix
 * (column-major [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]).
 */
export function rotateY(v: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

export function rotationYMatrix(radians: number): Float32Array {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

export function sunDirection(degrees: number): Vec3 {
  const tilt = (MARS_TUNING.sun.tiltDegrees * Math.PI) / 180;
  const angle = (degrees * Math.PI) / 180;
  const ring = Math.cos(tilt);
  return [ring * Math.cos(angle), Math.sin(tilt), ring * Math.sin(angle)];
}

export interface OrbitState {
  readonly yaw: number;
  readonly pitch: number;
  readonly radius: number;
}

export function orbitPosition(state: OrbitState): Vec3 {
  const limit = Math.PI * 0.49;
  const pitch = Math.max(-limit, Math.min(limit, state.pitch));
  const cosPitch = Math.cos(pitch);
  return [
    state.radius * cosPitch * Math.sin(state.yaw),
    state.radius * Math.sin(pitch),
    state.radius * cosPitch * Math.cos(state.yaw),
  ];
}

export function normalizeSize(size: readonly [number, number]): [number, number] {
  return [Math.max(1, Math.floor(size[0])), Math.max(1, Math.floor(size[1]))];
}

export function bloomSize(size: readonly [number, number]): [number, number] {
  const height = Math.max(1, Math.min(MARS_TUNING.bloom.height, size[1]));
  return [Math.max(1, Math.round((height * size[0]) / size[1])), height];
}

// Rebuilds sky view rays without inverting the view-projection matrix (from Earth).
export function cameraBasis(position: Vec3, target: Vec3, fovDegrees: number, up: Vec3 = [0, 1, 0]) {
  const back = normalize(subtract(position, target));
  const right = normalize(cross(up, back));
  const screenUp = cross(back, right);
  return {
    right,
    up: screenUp,
    forward: negate(back),
    tanHalfFov: Math.tan(((fovDegrees * Math.PI) / 180) * 0.5),
  };
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

export type { Vec3 };
