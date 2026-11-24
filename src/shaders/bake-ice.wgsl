// Bakes the conceptual subsurface-ice map (maps.ice, r8unorm, equirectangular), once
// at startup. This is a separate target from the surface map and from any future dust
// haze: it only drives the M3 radar reveal in mars.wgsl.
//
// It is an illustration, not data: ice likelihood rises poleward of the mid-latitudes
// (stronger in the north), is patchy, and stops short of the polar caps, which are
// surface ice and already drawn by the surface bake. One concentrated deposit faces the
// settled camera so the HUD marker has something to point at.

import { equirectDirection, fbm3, fbmVector, saturate } from "./mars-common.wgsl";

const DEGREES: f32 = 57.29577951308232;
const BAND_START_DEG: f32 = 32.0;
const BAND_FULL_DEG: f32 = 48.0;
// Ends before the residual caps (13 deg north / 9 deg south of the poles).
const BAND_FADE_START_DEG: f32 = 70.0;
const BAND_END_DEG: f32 = 78.0;
const SOUTH_STRENGTH: f32 = 0.7;

// Must match ICE_DEPOSIT in src/mars-planet.ts (the HUD anchor).
const DEPOSIT_LATITUDE: f32 = 0.6981317; // 40 deg N
const DEPOSIT_LONGITUDE: f32 = 1.07;
const DEPOSIT_RADIUS_DEG: f32 = 9.0;
// Irregular outline: the radius wobbles with noise so contours are not a bullseye.
const DEPOSIT_RADIUS_NOISE: f32 = 0.45;

fn depositDirection() -> vec3f {
  let ring = cos(DEPOSIT_LATITUDE);
  return vec3f(ring * cos(DEPOSIT_LONGITUDE), sin(DEPOSIT_LATITUDE), ring * sin(DEPOSIT_LONGITUDE));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direction = equirectDirection(uv);
  let latitude = abs(asin(clamp(direction.y, -1.0, 1.0))) * DEGREES;
  let band = smoothstep(BAND_START_DEG, BAND_FULL_DEG, latitude) * (1.0 - smoothstep(BAND_FADE_START_DEG, BAND_END_DEG, latitude));
  let hemisphere = select(SOUTH_STRENGTH, 1.0, direction.y > 0.0);

  let warp = fbmVector(direction * 2.0 + vec3f(-9.0, 3.0, 14.0), 3) * 0.4;
  let patches = smoothstep(-0.05, 0.25, fbm3(direction * 3.2 + warp, 5));
  let detail = 0.75 + 0.25 * fbm3(direction * 14.0 + vec3f(5.0), 3);

  let depositAngle = acos(clamp(dot(direction, depositDirection()), -1.0, 1.0)) * DEGREES;
  let radius = DEPOSIT_RADIUS_DEG * (1.0 + DEPOSIT_RADIUS_NOISE * fbm3(direction * 9.0 + vec3f(21.0, -3.0, 7.0), 4));
  let deposit = exp(-pow(depositAngle / max(radius, 1.0), 2.0)) * (0.85 + 0.15 * detail);

  let ice = max(band * hemisphere * patches * detail, deposit);
  return vec4f(saturate(ice), 0.0, 0.0, 1.0);
}
