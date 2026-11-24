// Isolates only true HDR highlights for bloom: the sun now, the radar pulse in M3.
// Adapted from the vgpu Earth example's bright-pass.wgsl. Earth used threshold 0.71
// with a 0.35 knee, which starts admitting light at 0.36 and lets ~12% of a fully lit
// planet bloom. Mars keeps every surface and rim term <= ~0.81, so a 1.0 threshold
// with a 0.15 knee (soft start at 0.85) gives the planet and atmosphere zero bloom.

import { luminance } from "@vgpu/wgsl-std/color";

const THRESHOLD: f32 = 1.0;
const KNEE: f32 = 0.15;

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(src, samp, uv, 0.0).rgb;
  let brightness = luminance(color);
  let soft = clamp((brightness - THRESHOLD + KNEE) / (2.0 * KNEE), 0.0, 1.0);
  let contribution = max(soft * soft * KNEE, brightness - THRESHOLD);
  return vec4f(color * max(contribution / max(brightness, 0.0001), 0.0), 1.0);
}
