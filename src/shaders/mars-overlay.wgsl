// Composites the premultiplied MSAA planet over the HDR sky.
// From the vgpu Earth example's overlay.wgsl, plus (M3) the radar pulse: mars.wgsl
// stores it as glow / GLOW_SCALE in the planet target's r8unorm attachment 1; here it
// is restored to HDR and added on top, so the bright-pass can bloom it.

import { GLOW_SCALE, ICE_BRIGHT } from "./mars-common.wgsl";

@group(0) @binding(0) var planetTexture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var glowTexture: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let planet = textureSampleLevel(planetTexture, samp, uv, 0.0);
  let glow = textureSampleLevel(glowTexture, samp, uv, 0.0).r * GLOW_SCALE;
  // Premultiplied blend: alpha 0 for the glow term means it is purely additive.
  return planet + vec4f(ICE_BRIGHT * glow, 0.0);
}
