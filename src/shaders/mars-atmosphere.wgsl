// Draws the back-facing atmosphere shell around Mars as a thin butterscotch rim.
// Adapted from the vgpu Earth example's atmosphere.wgsl: same back-face fresnel
// technique, Mars colours, and a tighter falloff for the much thinner atmosphere.

import { ATMOSPHERE_RIM, saturate, valueRemap } from "./mars-common.wgsl";

// When the sun is behind the planet, forward-scattering dust brightens the rim
// toward a pale warm white rather than Earth's red sunset.
const BACKLIT_RIM = vec3f(0.950, 0.760, 0.560);
// Fresnel falloff: how far past the limb the haze reaches (in -N.V), and how sharply
// it fades. Larger exponent = thinner, crisper rim.
const RIM_REACH: f32 = 0.30;
const RIM_EXPONENT: f32 = 2.5;
// Light wraps slightly past the terminator because the shell sits above the surface.
const RIM_LIGHT_START: f32 = -0.08;
const RIM_LIGHT_END: f32 = 0.18;
const BACKLIT_ALIGNMENT_START: f32 = 0.90;

struct AtmosphereUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  strength: f32,
  lightDirection: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> atmosphere: AtmosphereUniforms;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
};

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.world = input.position;
  out.normal = input.normal;
  out.clip = atmosphere.viewProjection * vec4f(input.position, 1.0);
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let normal = normalize(input.normal);
  let viewDirection = normalize(atmosphere.cameraPosition - input.world);
  // Only the far side of the shell is drawn; the planet depth-occludes the rest,
  // leaving a ring just outside the limb.
  if (dot(normal, viewDirection) > 0.0) {
    discard;
  }

  let lightDirection = normalize(atmosphere.lightDirection);
  let sunLight = saturate(valueRemap(dot(normal, lightDirection), RIM_LIGHT_START, RIM_LIGHT_END, 0.0, 1.0));

  var fresnel = saturate(valueRemap(dot(-normal, viewDirection), 0.0, RIM_REACH, 0.0, 1.0));
  fresnel = pow(fresnel, RIM_EXPONENT);

  let backlit = saturate(valueRemap(dot(-lightDirection, viewDirection), BACKLIT_ALIGNMENT_START, 1.0, 0.0, 1.0));
  let color = mix(ATMOSPHERE_RIM, BACKLIT_RIM, backlit);
  return vec4f(color, fresnel * sunLight * atmosphere.strength);
}
