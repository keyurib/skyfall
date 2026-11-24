// Applies bloom, ACES tone mapping, vignette, and deterministic grain.
// Adapted from the vgpu Earth example's composite.wgsl with restrained bloom and a
// lighter vignette (Mars sits off-centre in the final layout, so heavy edge darkening
// would eat into it).

import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";

const BLOOM_STRENGTH: f32 = 1.2;   // Earth: 1.8
const EXPOSURE: f32 = 1.05;
const VIGNETTE_STRENGTH: f32 = 0.30; // Earth: 0.45
const GRAIN_AMPLITUDE: f32 = 0.018;
const DISPLAY_GAMMA: f32 = 2.2;
// DESIGN.md deep space #05060A in display (sRGB) values. ACES crushes the sky's
// linear #05060A to near-black, which left a visible seam against the page's #05060A
// background. Lifting the display floor makes empty space render exactly #05060A;
// everything else shifts by at most ~4%.
const DISPLAY_BLACK = vec3f(5.0, 6.0, 10.0) / 255.0;

@group(0) @binding(0) var beauty: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct FragmentIn {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

fn rrtAndOdtFit(value: vec3f) -> vec3f {
  let a = value * (value + vec3f(0.0245786)) - vec3f(0.000090537);
  let b = value * (vec3f(0.983729) * value + vec3f(0.4329510)) + vec3f(0.238081);
  return a / b;
}

fn acesFilmicToneMapping(value: vec3f) -> vec3f {
  let acesInput = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777),
  );
  let acesOutput = mat3x3f(
    vec3f(1.60475, -0.10208, -0.00327),
    vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602),
  );

  let transformed = acesInput * (value / 0.6);
  return acesOutput * rrtAndOdtFit(transformed);
}

@fragment
fn fs_main(input: FragmentIn) -> @location(0) vec4f {
  let scene = textureSampleLevel(beauty, samp, input.uv, 0.0).rgb;
  let glow = textureSampleLevel(bloom, samp, input.uv, 0.0).rgb;
  var color = (scene + glow * BLOOM_STRENGTH) * EXPOSURE;

  let falloff = smoothstep(0.5, 1.0, length(input.uv - vec2f(0.5)) * 1.6);
  color = color * (1.0 - falloff * VIGNETTE_STRENGTH);

  color = acesFilmicToneMapping(color);
  var display = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / DISPLAY_GAMMA));
  display = DISPLAY_BLACK + display * (vec3f(1.0) - DISPLAY_BLACK);

  let hashed = pcg2d(vec2u(input.position.xy));
  display = display + vec3f((unitFloat(hashed.x) - 0.5) * GRAIN_AMPLITUDE);

  return vec4f(clamp(display, vec3f(0.0), vec3f(1.0)), 1.0);
}
