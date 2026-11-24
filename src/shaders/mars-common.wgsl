// Deterministic procedural helpers and palette shared by the Mars bake and live shaders.
// Pure module: functions, structs, and constants only (no @group/@binding).
// Noise helpers are ported unchanged from the vgpu Earth example's planet-common.wgsl.

import { pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

export const PI: f32 = 3.141592653589793;
export const TAU: f32 = 6.283185307179586;

// Palette from DESIGN.md, converted from sRGB hex to linear values: shading happens
// in linear space and the sRGB planet target re-encodes on write.
export const REGOLITH_DARK = vec3f(0.195, 0.027, 0.009);  // #7A2E18
export const REGOLITH_MID = vec3f(0.392, 0.060, 0.019);   // #A84525
export const REGOLITH_LIGHT = vec3f(0.578, 0.144, 0.040); // #C86A38
export const DUST_HAZE = vec3f(0.694, 0.361, 0.171);      // #D9A273
export const ATMOSPHERE_RIM = vec3f(0.807, 0.434, 0.254); // #E8B08A
export const ICE_DEEP = vec3f(0.212, 0.687, 1.000);       // #7FD8FF
export const ICE_BRIGHT = vec3f(0.521, 0.863, 1.000);     // #BFEFFF

// The radar pulse is the only scene element besides the sun allowed to bloom. The
// planet's 8-bit MSAA target cannot hold HDR, so mars.wgsl writes the pulse to a second
// r8unorm attachment as glow / GLOW_SCALE and mars-overlay.wgsl restores it to HDR.
export const GLOW_SCALE: f32 = 8.0;
// Polar ice is not pure white: the residual caps carry a faint dust tint.
export const POLAR_ICE = vec3f(0.800, 0.770, 0.735);
export const POLAR_FROST = vec3f(0.640, 0.470, 0.380);

fn latticeGradient(cell: vec3i) -> vec3f {
  let index = pcg3d(bitcast<vec3u>(cell)).x % 12u;
  switch (index) {
    case 0u: { return vec3f(1.0, 1.0, 0.0); }
    case 1u: { return vec3f(-1.0, 1.0, 0.0); }
    case 2u: { return vec3f(1.0, -1.0, 0.0); }
    case 3u: { return vec3f(-1.0, -1.0, 0.0); }
    case 4u: { return vec3f(1.0, 0.0, 1.0); }
    case 5u: { return vec3f(-1.0, 0.0, 1.0); }
    case 6u: { return vec3f(1.0, 0.0, -1.0); }
    case 7u: { return vec3f(-1.0, 0.0, -1.0); }
    case 8u: { return vec3f(0.0, 1.0, 1.0); }
    case 9u: { return vec3f(0.0, -1.0, 1.0); }
    case 10u: { return vec3f(0.0, 1.0, -1.0); }
    default: { return vec3f(0.0, -1.0, -1.0); }
  }
}

fn quinticFade(t: vec3f) -> vec3f {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

export fn perlin3(position: vec3f) -> f32 {
  let base = floor(position);
  let cell = vec3i(base);
  let f = position - base;
  let w = quinticFade(f);

  let n000 = dot(latticeGradient(cell + vec3i(0, 0, 0)), f - vec3f(0.0, 0.0, 0.0));
  let n100 = dot(latticeGradient(cell + vec3i(1, 0, 0)), f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(latticeGradient(cell + vec3i(0, 1, 0)), f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(latticeGradient(cell + vec3i(1, 1, 0)), f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(latticeGradient(cell + vec3i(0, 0, 1)), f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(latticeGradient(cell + vec3i(1, 0, 1)), f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(latticeGradient(cell + vec3i(0, 1, 1)), f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(latticeGradient(cell + vec3i(1, 1, 1)), f - vec3f(1.0, 1.0, 1.0));

  let x00 = mix(n000, n100, w.x);
  let x10 = mix(n010, n110, w.x);
  let x01 = mix(n001, n101, w.x);
  let x11 = mix(n011, n111, w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

fn octaveRotation() -> mat3x3f {
  return mat3x3f(
    vec3f(0.00, 0.80, 0.60),
    vec3f(-0.80, 0.36, -0.48),
    vec3f(-0.60, -0.48, 0.64),
  );
}

export fn fbm3(position: vec3f, octaves: i32) -> f32 {
  let rotation = octaveRotation();
  var point = position;
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i = i + 1) {
    sum = sum + amplitude * perlin3(point);
    total = total + amplitude;
    amplitude = amplitude * 0.5;
    point = rotation * point * 2.0;
  }
  return sum / max(total, 1.0e-6);
}

export fn ridged3(position: vec3f, octaves: i32) -> f32 {
  let rotation = octaveRotation();
  var point = position;
  var sum = 0.0;
  var amplitude = 0.5;
  var total = 0.0;
  for (var i = 0; i < octaves; i = i + 1) {
    let ridge = 1.0 - abs(perlin3(point));
    sum = sum + amplitude * ridge * ridge;
    total = total + amplitude;
    amplitude = amplitude * 0.5;
    point = rotation * point * 2.0;
  }
  return sum / max(total, 1.0e-6);
}

export fn fbmVector(position: vec3f, octaves: i32) -> vec3f {
  return vec3f(
    fbm3(position, octaves),
    fbm3(position + vec3f(37.19, 11.73, 5.41), octaves),
    fbm3(position + vec3f(-13.07, 71.31, 29.83), octaves),
  );
}

// Matches vgpu/scene sphere(): u -> longitude phi, v = 0 at the north pole (+Y).
export fn equirectDirection(uv: vec2f) -> vec3f {
  let theta = uv.y * PI;
  let phi = uv.x * TAU;
  let ring = sin(theta);
  return vec3f(ring * cos(phi), cos(theta), ring * sin(phi));
}

// Longitude in radians, in the same convention as equirectDirection().
export fn longitudeOf(direction: vec3f) -> f32 {
  return atan2(direction.z, direction.x);
}

// Shortest signed angle from `origin` to `angle`, in (-PI, PI].
export fn angleDelta(angle: f32, origin: f32) -> f32 {
  return atan2(sin(angle - origin), cos(angle - origin));
}

export fn valueRemap(value: f32, inMin: f32, inMax: f32, outMin: f32, outMax: f32) -> f32 {
  let span = inMax - inMin;
  if (span == 0.0) {
    return outMin;
  }
  return outMin + (outMax - outMin) * (value - inMin) / span;
}

export fn saturate(value: f32) -> f32 {
  return clamp(value, 0.0, 1.0);
}

export fn belt(value: f32, center: f32, width: f32) -> f32 {
  return 1.0 - smoothstep(0.0, width, abs(value - center));
}

// One octave of impact craters scattered through 3D cells around the unit sphere.
//   x: signed relief (-1 bowl floor .. 0 plains .. + raised rim)
//   y: rim/ejecta mask (0..1), used to brighten fresh crater rims
//   z: bowl mask (0..1), used to darken dust-filled floors
// Craters are spheres of influence in cell space, so a crater whose center sits off
// the unit sphere simply intersects it as a smaller circle; no projection is needed
// and the 3x3x3 neighbour search is always sufficient (max radius < 0.5 cell).
export fn craterLayer(direction: vec3f, cellsPerUnit: f32, seed: u32, density: f32) -> vec3f {
  let point = direction * cellsPerUnit;
  let base = vec3i(floor(point));
  var relief = 0.0;
  var rim = 0.0;
  var bowl = 0.0;
  for (var x = -1; x <= 1; x = x + 1) {
    for (var y = -1; y <= 1; y = y + 1) {
      for (var z = -1; z <= 1; z = z + 1) {
        let cell = base + vec3i(x, y, z);
        let hash = pcg3d(bitcast<vec3u>(cell) ^ vec3u(seed, seed * 3u + 1u, seed * 7u + 2u));
        if (unitFloat(hash.x ^ (hash.y >> 7u)) > density) {
          continue;
        }
        let jitter = vec3f(unitFloat(hash.x), unitFloat(hash.y), unitFloat(hash.z));
        // Cubic skew yields a power-law size distribution: many small, few large.
        let sizeRoll = unitFloat(hash.z ^ (hash.x << 5u));
        let radius = 0.10 + 0.36 * sizeRoll * sizeRoll * sizeRoll;
        let d = distance(point, vec3f(cell) + jitter) / radius;
        if (d > 1.8) {
          continue;
        }
        // Flat-floored bowl, sharp raised rim, ejecta fading out to 1.8 radii.
        let bowlDepth = select(0.0, max(d * d - 1.0, -0.72), d < 1.0);
        let rimHeight = exp(-pow((d - 1.0) * 5.0, 2.0)) * 0.42;
        let ejecta = select(0.0, (1.0 - smoothstep(1.0, 1.8, d)) * 0.10, d >= 1.0);
        relief = relief + bowlDepth + rimHeight + ejecta;
        rim = max(rim, exp(-pow((d - 1.0) * 4.0, 2.0)));
        bowl = max(bowl, 1.0 - smoothstep(0.55, 1.0, d));
      }
    }
  }
  return vec3f(relief, saturate(rim), saturate(bowl));
}
