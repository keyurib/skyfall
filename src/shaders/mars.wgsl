// Shades the Mars sphere from the baked surface map: diffuse regolith lighting,
// a narrow terminator, bump relief from the height channel, (M1b) a thin butterscotch
// haze toward the limb, and (M3) the radar ice reveal.
//
// Radar (M3): the sweep is decided here, per surface point, in the planet's own frame.
// A planar front moves along `sweepAxis` (planet-local); a point is revealed once the
// front has passed it, and the separate ice map (not the surface or dust maps) says
// whether it holds subsurface ice. Revealed ice is drawn as a blue-white subsurface tint
// plus iso-contour lines and a survey grid, so the discovery never relies on colour
// alone. The pulse at the front is written as HDR glow to attachment 1 (the only scene
// bloom source besides the sun); everything in attachment 0 stays <= 0.7.

import {
  ATMOSPHERE_RIM,
  GLOW_SCALE,
  ICE_BRIGHT,
  ICE_DEEP,
  saturate,
  valueRemap,
} from "./mars-common.wgsl";

// Limb haze: Earth uses 0.1 + 0.5 * (1 - N.V)^3; Mars' atmosphere is ~1% of Earth's
// surface pressure, so the haze has no floor and a weaker, tighter falloff.
const LIMB_HAZE_STRENGTH: f32 = 0.45;
const LIMB_HAZE_EXPONENT: f32 = 3.5;

// Terminator band in N.L: Mars' thin atmosphere gives only a short twilight.
const TERMINATOR_START: f32 = -0.04;
const TERMINATOR_END: f32 = 0.10;
// Dusty regolith back-scatters, so the disk darkens toward the limb less than pure
// Lambert would; blend toward sqrt(N.L) to flatten the falloff.
const REGOLITH_FLATTENING: f32 = 0.35;
// Converts the 0..1 height channel to world units (planet radius = 1) for bump
// lighting. Real Mars relief is ~0.3% of its radius; 0.012 exaggerates it ~3x so
// craters and canyon walls read at globe scale without flipping normals.
const RELIEF_STRENGTH: f32 = 0.012;
const SUN_INTENSITY: f32 = 1.15;
// Keep the lit planet below the bloom bright-pass threshold (1.0), so only the sun and
// the radar pulse bloom.
const MAX_SURFACE_RADIANCE: f32 = 0.7;

// Radar reveal. Distances are along the sweep axis, in planet radii.
const REVEAL_SOFTNESS: f32 = 0.015;
// A thin scan line, not a bar: the glow (bloom) gives it presence.
const PULSE_WIDTH: f32 = 0.012;
// The swept band keeps a short fading afterglow behind the front.
const PULSE_TRAIL: f32 = 0.12;
const PULSE_TRAIL_STRENGTH: f32 = 0.10;
const PULSE_LDR_STRENGTH: f32 = 0.18;
// HDR glow at the front (bright-pass threshold is 1.0); ice echoes back brighter.
const PULSE_HDR: f32 = 1.7;
const PULSE_ICE_ECHO: f32 = 2.5;
// Ice below this map value is treated as absent (no tint, no contours).
const ICE_THRESHOLD: f32 = 0.12;
// Subsurface ice is shown *beneath* the regolith: the ground darkens (its texture stays
// visible) and a cyan glow comes through. It reads by radar, not sunlight, so it also
// shows on the night side.
const ICE_GROUND_DIMMING: f32 = 0.72;
const ICE_RADIANCE: f32 = 0.50;
const ICE_CONTOUR_LEVELS: f32 = 5.0;
const ICE_CONTOUR_STRENGTH: f32 = 0.20;
// Survey grid (lines every 10 degrees): strong just behind the moving front, leaving
// only a faint residue on swept ground once the pulse has passed.
const GRID_SPACING_DEG: f32 = 10.0;
const GRID_COLOR = vec3f(0.30, 0.62, 0.70);
const GRID_ACTIVE_OPACITY: f32 = 0.16;
const GRID_ACTIVE_REACH: f32 = 0.35;
const GRID_RESIDUAL_OPACITY: f32 = 0.035;
// Grid lines are fainter on the night side, where they would otherwise dominate.
const GRID_NIGHT_FACTOR: f32 = 0.35;
const DEGREES: f32 = 57.29577951308232;
// Click-to-ping: a ring at angular distance pingRadius from the clicked point (planet
// frame). Inside the ring, ice "echoes" back brighter while the ping lasts.
const PING_WIDTH: f32 = 0.012;
const PING_HDR: f32 = 1.6;
const PING_LDR_STRENGTH: f32 = 0.2;
const PING_ECHO_STRENGTH: f32 = 0.22;

struct MarsUniforms {
  viewProjection: mat4x4f,
  // Spin about the polar (+Y) axis (M2). Rotation only, so it also transforms normals.
  model: mat4x4f,
  cameraPosition: vec3f,
  lightDirection: vec3f,
  // Planet-local unit axis the radar front advances along, and the front's position
  // on it (-1..1 crosses the planet; > 1 = everything revealed, < -1 = nothing).
  sweepAxis: vec3f,
  sweepFront: f32,
  // 0..1 pulse intensity (0 when no scan is in progress).
  pulse: f32,
  // Click-to-ping: planet-local unit origin, ring radius (radians), 0..1 strength.
  pingOrigin: vec3f,
  pingRadius: f32,
  pingStrength: f32,
};

@group(0) @binding(0) var<uniform> mars: MarsUniforms;
@group(0) @binding(1) var surfaceMap: texture_2d<f32>;
@group(0) @binding(2) var mapSampler: sampler;
@group(0) @binding(3) var iceMap: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // Unrotated position: the planet's own frame, where the sweep is defined.
  @location(3) local: vec3f,
};

struct MarsOut {
  @location(0) color: vec4f,
  // r = HDR radar glow / GLOW_SCALE.
  @location(1) glow: vec4f,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = mars.model * vec4f(input.position, 1.0);
  out.world = world.xyz;
  out.normal = (mars.model * vec4f(input.normal, 0.0)).xyz;
  // UVs stay in the planet's own frame, so the surface and the ice mask turn with it.
  out.uv = input.uv;
  out.local = input.position;
  out.clip = mars.viewProjection * world;
  return out;
}

// Screen-space height slope (same technique as Earth's cloud bump).
fn heightSlope(uv: vec2f, center: f32) -> vec2f {
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  return vec2f(
    textureSample(surfaceMap, mapSampler, uv + dx).a - center,
    textureSample(surfaceMap, mapSampler, uv + dy).a - center,
  ) * RELIEF_STRENGTH;
}

// Morten Mikkelsen's surface-gradient bump mapping without tangents.
fn perturbNormal(surfacePosition: vec3f, surfaceNormal: vec3f, slope: vec2f) -> vec3f {
  let sigmaX = dpdx(surfacePosition);
  let sigmaY = dpdy(surfacePosition);
  let r1 = cross(sigmaY, surfaceNormal);
  let r2 = cross(surfaceNormal, sigmaX);
  let determinant = dot(sigmaX, r1);
  let gradient = sign(determinant) * (slope.x * r1 + slope.y * r2);
  return normalize(abs(determinant) * surfaceNormal - gradient);
}

// Anti-aliased line mask: 1 on lines where `coordinate` crosses an integer.
fn lineMask(coordinate: f32) -> f32 {
  let distance = abs(fract(coordinate + 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, max(fwidth(coordinate), 1.0e-5) * 1.2, distance);
}

@fragment
fn fs_main(input: VertexOut) -> MarsOut {
  let lightDirection = normalize(mars.lightDirection);
  let normal = normalize(input.normal);
  let surface = textureSample(surfaceMap, mapSampler, input.uv);
  let iceValue = textureSample(iceMap, mapSampler, input.uv).r;
  let bumped = perturbNormal(input.world, normal, heightSlope(input.uv, surface.a));

  // The geometric normal decides day/night; the bumped normal shades relief.
  let daylight = saturate(valueRemap(dot(normal, lightDirection), TERMINATOR_START, TERMINATOR_END, 0.0, 1.0));
  let diffuse = saturate(dot(bumped, lightDirection));
  let shade = mix(diffuse, sqrt(diffuse), REGOLITH_FLATTENING) * daylight;

  var radiance = surface.rgb * shade * SUN_INTENSITY;

  let viewDirection = normalize(mars.cameraPosition - input.world);
  let limb = pow(1.0 - saturate(dot(normal, viewDirection)), LIMB_HAZE_EXPONENT);
  radiance = mix(radiance, ATMOSPHERE_RIM * SUN_INTENSITY * 0.6, limb * LIMB_HAZE_STRENGTH * daylight);

  // --- Radar sweep (planet frame) ---------------------------------------------------
  let local = normalize(input.local);
  let behindFront = mars.sweepFront - dot(local, normalize(mars.sweepAxis));
  let revealed = smoothstep(-REVEAL_SOFTNESS, REVEAL_SOFTNESS, behindFront);

  let ice = smoothstep(ICE_THRESHOLD, 1.0, iceValue) * revealed;
  let iceColor = mix(ICE_DEEP, ICE_BRIGHT, iceValue * 0.35);
  radiance = radiance * (1.0 - ICE_GROUND_DIMMING * ice) + iceColor * ICE_RADIANCE * ice;

  // Non-colour cues: iso-contours of ice concentration, and a survey grid on swept ground.
  let contours = lineMask(iceValue * ICE_CONTOUR_LEVELS) * step(ICE_THRESHOLD, iceValue) * revealed;
  radiance = radiance + ICE_BRIGHT * contours * ICE_CONTOUR_STRENGTH;
  let latitude = asin(clamp(local.y, -1.0, 1.0)) * DEGREES;
  let longitude = atan2(local.z, local.x) * DEGREES;
  let grid = max(lineMask(latitude / GRID_SPACING_DEG), lineMask(longitude / GRID_SPACING_DEG) * saturate(cos(latitude / DEGREES) * 4.0));
  let gridActive = select(0.0, exp(-behindFront / GRID_ACTIVE_REACH), behindFront > 0.0) * mars.pulse;
  let gridOpacity = (GRID_RESIDUAL_OPACITY + GRID_ACTIVE_OPACITY * gridActive) * mix(GRID_NIGHT_FACTOR, 1.0, daylight);
  radiance = mix(radiance, GRID_COLOR, grid * revealed * gridOpacity);

  // Pulse: a gaussian band at the front plus a short afterglow behind it.
  let band = exp(-pow(behindFront / PULSE_WIDTH, 2.0));
  let trail = select(0.0, exp(-behindFront / PULSE_TRAIL) * PULSE_TRAIL_STRENGTH, behindFront > 0.0);
  let pulse = (band + trail) * mars.pulse;
  radiance = radiance + ICE_BRIGHT * pulse * PULSE_LDR_STRENGTH;

  // Ping ring and echo.
  let pingAngle = acos(clamp(dot(local, normalize(mars.pingOrigin)), -1.0, 1.0));
  let pingRing = exp(-pow((pingAngle - mars.pingRadius) / PING_WIDTH, 2.0)) * mars.pingStrength;
  let pingInside = (1.0 - smoothstep(mars.pingRadius - PING_WIDTH, mars.pingRadius, pingAngle)) * mars.pingStrength;
  radiance = radiance + ICE_BRIGHT * (pingRing * PING_LDR_STRENGTH + smoothstep(ICE_THRESHOLD, 1.0, iceValue) * pingInside * PING_ECHO_STRENGTH);

  var out: MarsOut;
  out.color = vec4f(min(radiance, vec3f(MAX_SURFACE_RADIANCE)), 1.0);
  let glow = band * mars.pulse * (PULSE_HDR + PULSE_ICE_ECHO * smoothstep(ICE_THRESHOLD, 1.0, iceValue)) + pingRing * PING_HDR;
  out.glow = vec4f(saturate(glow / GLOW_SCALE), 0.0, 0.0, 1.0);
  return out;
}
