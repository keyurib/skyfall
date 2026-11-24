// Deep-space background seen from Mars orbit: sparse stars, a very faint galactic
// band, and an HDR sun. Adapted from the vgpu Earth example's sky.wgsl: deeper black,
// dimmer stars so they never compete with the planet, and a whiter, smaller sun.

import { fbm3, saturate } from "./mars-common.wgsl";
import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

// #05060A in linear: the deep-space base colour from DESIGN.md.
const SPACE_BLACK = vec3f(0.0015, 0.0018, 0.0030);
const GALAXY_AXIS = vec3f(-0.3227, 0.7561, 0.5670);
const GALAXY_WIDTH: f32 = 0.22;
const GALAXY_COLOR = vec3f(0.060, 0.058, 0.066);
const GALAXY_INTENSITY: f32 = 0.030;
const STAR_COOL = vec3f(0.72, 0.82, 1.00);
const STAR_WARM = vec3f(1.00, 0.84, 0.62);
const STAR_INTENSITY: f32 = 0.22;
// From Mars the sun subtends ~0.35 deg; the disc is drawn at ~1 deg so it stays legible.
const SUN_COLOR = vec3f(1.00, 0.88, 0.72);
const SUN_INTENSITY: f32 = 6.0;
const SUN_DISC_EDGE_OUTER: f32 = 0.99982;
const SUN_DISC_EDGE_INNER: f32 = 0.99994;
const SUN_CORONA_SHARPNESS: f32 = 2600.0;
const SUN_CORONA_STRENGTH: f32 = 0.15;

struct SkyUniforms {
  right: vec3f,
  up: vec3f,
  forward: vec3f,
  lightDirection: vec3f,
  // View-ray extents at the canvas edges, in tan units: (left, right, bottom, top).
  // Centred cameras have (-t*a, t*a, -t, t); an off-centre stage shifts them, so the
  // full-bleed canvas shows sky around a planet framed in only part of it.
  frustum: vec4f,
};

@group(0) @binding(0) var<uniform> sky: SkyUniforms;

fn faceCoords(direction: vec3f) -> vec3f {
  let magnitude = abs(direction);
  if (magnitude.x >= magnitude.y && magnitude.x >= magnitude.z) {
    return vec3f(direction.yz / magnitude.x, select(1.0, 0.0, direction.x > 0.0));
  }
  if (magnitude.y >= magnitude.z) {
    return vec3f(direction.xz / magnitude.y, select(3.0, 2.0, direction.y > 0.0));
  }
  return vec3f(direction.xy / magnitude.z, select(5.0, 4.0, direction.z > 0.0));
}

fn starLayer(direction: vec3f, cells: f32, density: f32, size: f32, seed: i32) -> vec3f {
  let face = faceCoords(direction);
  let grid = face.xy * cells;
  let cell = floor(grid);
  let hashed = pcg3d(bitcast<vec3u>(vec3i(vec2i(cell), i32(face.z) * 131 + seed)));
  let presence = unitFloat(hashed.x);
  if (presence > density) {
    return vec3f(0.0);
  }

  let jitter = vec2f(unitFloat(hashed.y), unitFloat(hashed.z)) - vec2f(0.5);
  let center = cell + vec2f(0.5) + jitter * 0.8;
  let radius = size * (0.45 + unitFloat(hashed.z) * 0.85);
  let falloff = 1.0 - smoothstep(0.0, radius, length(grid - center));
  let bias = presence / max(density, 1.0e-4);
  let magnitude = 0.10 + bias * bias * bias * 1.9;
  let tint = mix(STAR_COOL, STAR_WARM, unitFloat(hashed.y));
  return tint * falloff * falloff * magnitude;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let tanX = mix(sky.frustum.x, sky.frustum.y, uv.x);
  let tanY = mix(sky.frustum.w, sky.frustum.z, uv.y);
  let direction = normalize(
    sky.forward
      + sky.right * tanX
      + sky.up * tanY,
  );

  let band = 1.0 - smoothstep(0.0, GALAXY_WIDTH, abs(dot(direction, GALAXY_AXIS)));
  let galaxyNoise = saturate(fbm3(direction * 4.2 + vec3f(11.0, -4.0, 23.0), 4) * 0.5 + 0.5);
  var color = SPACE_BLACK + GALAXY_COLOR * band * galaxyNoise * GALAXY_INTENSITY;

  color = color + (
    starLayer(direction, 34.0, 0.22, 0.16, 17) * 1.35
      + starLayer(direction, 92.0, 0.12, 0.20, 71) * 0.85
      + starLayer(direction, 210.0, 0.05, 0.26, 149) * 0.30
  ) * STAR_INTENSITY;

  let sunAngle = dot(direction, normalize(sky.lightDirection));
  let disc = smoothstep(SUN_DISC_EDGE_OUTER, SUN_DISC_EDGE_INNER, sunAngle);
  let corona = pow(saturate(sunAngle), SUN_CORONA_SHARPNESS);
  color = color + SUN_COLOR * SUN_INTENSITY * (disc + corona * SUN_CORONA_STRENGTH);

  return vec4f(color, 1.0);
}
