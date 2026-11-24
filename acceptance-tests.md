# Acceptance tests

## Functional
- [ ] Page loads without JavaScript console errors.
- [ ] WebGPU canvas initializes when supported.
- [ ] Static poster fallback appears when WebGPU is unavailable.
- [ ] Hero renders correctly at 360, 768, 1280, and 1920 px widths.
- [ ] Radar CTA triggers the scan sequence.
- [ ] Reduced-motion preference disables flight and camera animation.
- [ ] Keyboard users can reach and activate both CTAs.

## Visual
- [ ] Mars has a recognizable rust-red surface and polar ice.
- [ ] Atmosphere rim is visible but not overpowering.
- [ ] Sun bloom is limited to the sun and selected highlights.
- [ ] Radar sweep reveals a blue-white subsurface layer.
- [ ] Text remains readable over the canvas.

## Technical
- [ ] Every `.wgsl` file passes `npx vgpu check`.
- [ ] `npx vgpu doctor --pretty` reports healthy.
- [ ] Headless render produces a non-black PNG.
- [ ] Browser screenshot is checked at actual pixel level.
- [ ] No shader compilation warnings.
- [ ] Frame rate remains smooth during radar animation.