// Bakes the Mars surface into an equirectangular rgba16float map, once at startup.
//   rgb: regolith albedo (linear)
//   a:   relief height, 0.5 = datum, used by mars.wgsl for bump lighting
// The ice survey mask is deliberately NOT in this map; M3 adds a separate maps.ice.

import {
  POLAR_FROST,
  POLAR_ICE,
  REGOLITH_DARK,
  REGOLITH_LIGHT,
  REGOLITH_MID,
  angleDelta,
  belt,
  craterLayer,
  equirectDirection,
  fbm3,
  fbmVector,
  longitudeOf,
  ridged3,
  saturate,
  valueRemap,
} from "./mars-common.wgsl";

// Hemispheric dichotomy: cratered southern highlands vs smoother northern plains.
// Boundary sits a little north of the equator (sin(latitude) units).
const DICHOTOMY_LATITUDE: f32 = 0.10;

// Canyon system (Valles Marineris analogue): just south of the equator, spanning
// roughly 80 degrees of longitude. VALLEY_LONGITUDE must match the poster camera
// facing longitude in mars-planet.ts so the canyon reads in the hero composition.
const VALLEY_LONGITUDE: f32 = 1.30;
const VALLEY_LATITUDE: f32 = -0.14;
const VALLEY_HALF_SPAN: f32 = 0.70;
const VALLEY_HALF_WIDTH: f32 = 0.036;
// Dusky albedo halo around the canyon so it reads as a band at globe scale.
const VALLEY_HALO_WIDTH: f32 = 3.2;

// Broad dark equatorial albedo belt (Syrtis / Mare-like dusky terrain).
const DARK_BELT_LATITUDE: f32 = -0.06;
const DARK_BELT_HALF_WIDTH: f32 = 0.34;

// Polar caps, in degrees of angular distance from each cap's axis. The north residual
// cap is larger than the south one, and the south cap is offset from the pole, as on Mars.
const NORTH_CAP_RADIUS_DEG: f32 = 13.0;
const SOUTH_CAP_RADIUS_DEG: f32 = 9.0;
const SOUTH_CAP_AXIS = vec3f(0.06, -0.998, 0.0);
const CAP_SOFTNESS_DEG: f32 = 1.2;
const CAP_EDGE_NOISE_DEG: f32 = 2.5;
const FROST_FRINGE_DEG: f32 = 4.0;
// Spiral trough spacing (radians of colatitude per full turn of the sine).
const SPIRAL_FREQUENCY: f32 = 70.0;
const DEGREES: f32 = 57.29577951308232;

// Relief scale applied to the alpha channel around the 0.5 datum.
const CRATER_RELIEF: f32 = 0.16;
const VALLEY_DEPTH: f32 = 0.30;
const TERRAIN_RELIEF: f32 = 0.05;

struct Canyon {
  floor: f32,   // 0..1, 1 at the canyon floor
  wall: f32,    // 0..1, peaks on the canyon walls (layered, lighter)
  halo: f32,    // 0..1, broad dusky albedo band around the system
};

fn canyonSystem(direction: vec3f) -> Canyon {
  let dLon = angleDelta(longitudeOf(direction), VALLEY_LONGITUDE);
  let span = 1.0 - smoothstep(VALLEY_HALF_SPAN * 0.75, VALLEY_HALF_SPAN, abs(dLon));
  // Gentle meander plus fine ragged edges from ridged noise.
  let meander = sin(dLon * 3.2) * 0.018 + fbm3(direction * 7.0 + vec3f(3.1), 3) * 0.020;
  let ragged = (ridged3(direction * 38.0 + vec3f(-5.0), 3) - 0.5) * 0.010;
  // The trough widens toward the eastern end, like the Coprates / Eos chasmata.
  let widen = 1.0 + saturate(dLon / VALLEY_HALF_SPAN) * 0.9;
  let halfWidth = VALLEY_HALF_WIDTH * widen + ragged;
  let offset = abs(direction.y - (VALLEY_LATITUDE + meander));
  let main = (1.0 - smoothstep(halfWidth * 0.35, halfWidth, offset)) * span;

  // A parallel, shorter chasma to the north breaks the single-stroke look.
  let northSpan = 1.0 - smoothstep(0.10, 0.32, abs(dLon + 0.18));
  let northOffset = abs(direction.y - (VALLEY_LATITUDE + 0.055 + meander * 0.7));
  let north = (1.0 - smoothstep(halfWidth * 0.2, halfWidth * 0.6, northOffset)) * northSpan;

  let floorMask = max(main, north * 0.8);
  let wallMask = saturate(belt(offset, halfWidth * 0.8, halfWidth * 0.5) * span);
  let haloMask = (1.0 - smoothstep(halfWidth, halfWidth * VALLEY_HALO_WIDTH, offset))
    * (1.0 - smoothstep(VALLEY_HALF_SPAN * 0.85, VALLEY_HALF_SPAN * 1.15, abs(dLon)));
  return Canyon(floorMask, wallMask, haloMask);
}

// Coverage of one cap: 1 inside `radiusDeg` of `axis`, with a noisy soft edge.
//   x: ice, y: seasonal frost fringe just outside the ice edge.
fn capCoverage(direction: vec3f, axis: vec3f, radiusDeg: f32, edgeNoiseDeg: f32) -> vec2f {
  let distanceDeg = acos(clamp(dot(direction, axis), -1.0, 1.0)) * DEGREES + edgeNoiseDeg;
  let ice = 1.0 - smoothstep(radiusDeg - CAP_SOFTNESS_DEG, radiusDeg, distanceDeg);
  let frost = 1.0 - smoothstep(radiusDeg, radiusDeg + FROST_FRINGE_DEG, distanceDeg);
  return vec2f(ice, frost);
}

fn polarCap(direction: vec3f) -> vec2f {
  // Returns (ice coverage, seasonal frost fringe).
  let edgeNoise = fbm3(direction * 9.0 + vec3f(-31.0), 4) * 2.0 * CAP_EDGE_NOISE_DEG;
  // Spiral troughs cut dusty bands through the ice, as in the north polar layered deposits.
  let colatitude = acos(clamp(abs(direction.y), 0.0, 1.0));
  // Strong noise warp and a fragmenting mask keep the troughs from reading as rings.
  let spiral = sin(longitudeOf(direction) * 2.0 + colatitude * SPIRAL_FREQUENCY + fbm3(direction * 7.0, 4) * 7.0);
  let fragments = smoothstep(-0.05, 0.25, fbm3(direction * 14.0 + vec3f(17.0), 3));
  let troughs = smoothstep(0.75, 0.98, spiral) * fragments * 0.35;

  let north = capCoverage(direction, vec3f(0.0, 1.0, 0.0), NORTH_CAP_RADIUS_DEG, edgeNoise);
  let south = capCoverage(direction, normalize(SOUTH_CAP_AXIS), SOUTH_CAP_RADIUS_DEG, edgeNoise);
  let ice = max(north.x * (1.0 - troughs), south.x * (1.0 - troughs * 0.5));
  return vec2f(saturate(ice), saturate(max(north.y, south.y)));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let direction = equirectDirection(uv);
  let warp = fbmVector(direction * 1.4 + vec3f(4.7, -2.3, 8.1), 3) * 0.45;

  // 1. Dichotomy: 1 in the southern highlands, 0 in the northern lowlands.
  let boundaryNoise = fbm3(direction * 2.1 + warp, 4) * 0.30;
  let highlands = smoothstep(-0.10, 0.10, DICHOTOMY_LATITUDE - direction.y + boundaryNoise);

  // 2. Albedo provinces: bright dusty plains vs darker exposed basalt.
  let province = fbm3(direction * 1.7 + warp, 5);
  let dusty = smoothstep(-0.12, 0.22, province);
  let darkBelt = belt(direction.y, DARK_BELT_LATITUDE, DARK_BELT_HALF_WIDTH)
    * smoothstep(-0.02, 0.22, fbm3(direction * 2.6 + vec3f(11.0, -4.0, 2.0) + warp, 4) + 0.10);

  // 3. Craters at three scales; the highlands are far more heavily cratered.
  let density = mix(0.10, 0.55, highlands);
  let large = craterLayer(direction, 9.0, 11u, density * 0.7);
  let medium = craterLayer(direction, 24.0, 23u, density);
  let small = craterLayer(direction, 60.0, 47u, density * 0.9);
  let craterRelief = large.x * 1.0 + medium.x * 0.55 + small.x * 0.25;
  let craterRim = max(large.y, max(medium.y * 0.8, small.y * 0.5));
  let craterBowl = max(large.z, medium.z * 0.8);

  // 4. Canyon system.
  let canyon = canyonSystem(direction);

  // Fine regolith texture so no region reads as flat colour.
  let grain = fbm3(direction * 48.0 + vec3f(91.0), 4);
  let terrain = fbm3(direction * 6.0 + warp * 2.0, 5);

  var albedo = mix(REGOLITH_MID, REGOLITH_LIGHT, dusty);
  albedo = mix(albedo, REGOLITH_DARK, saturate(darkBelt * 0.75 + highlands * 0.15));
  albedo = albedo * (1.0 + grain * 0.22 + terrain * 0.18);
  albedo = mix(albedo, REGOLITH_DARK * 0.85, craterBowl * 0.35);
  albedo = mix(albedo, REGOLITH_LIGHT * 1.08, craterRim * 0.30);
  // Dusky halo, then dark canyon floors with slightly paler layered walls.
  albedo = mix(albedo, REGOLITH_DARK, canyon.halo * 0.55);
  albedo = mix(albedo, REGOLITH_LIGHT * 0.95, canyon.wall * 0.35);
  albedo = mix(albedo, REGOLITH_DARK * 0.7, canyon.floor * 0.85);

  // 5. Polar caps last so ice overrides everything beneath it.
  let cap = polarCap(direction);
  albedo = mix(albedo, POLAR_FROST, cap.y * 0.45);
  albedo = mix(albedo, POLAR_ICE, cap.x);

  let height = 0.5
    + craterRelief * CRATER_RELIEF * (1.0 - cap.x * 0.7)
    + terrain * TERRAIN_RELIEF
    - canyon.floor * VALLEY_DEPTH
    + canyon.wall * VALLEY_DEPTH * 0.15;

  return vec4f(max(albedo, vec3f(0.0)), saturate(height));
}
