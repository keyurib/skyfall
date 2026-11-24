# Agent instructions

## Role
You are implementing a cinematic Mars hero section for NASA’s SkyFall mission
using vgpu, TypeScript, React/Next.js, and WGSL.

## Non-negotiable rules
1. Read `implementation.md`, `DESIGN.md`, and `MISSION_FACTS.md` before coding.
2. Use the vgpu Earth example as the technical baseline. Do not invent vgpu APIs.
3. Before writing code, run:
   - `npx vgpu docs cat getting-started.md`
   - `npx vgpu docs cat concepts-wgsl-modules.md`
   - `npx vgpu docs cat concepts-effects.md`
   - `npx vgpu docs cat concepts-passes.md`
   - `npx vgpu docs cat concepts-frames.md`
4. Validate every WGSL file with:
   `npx vgpu check ./src/shaders/<file>.wgsl`
5. Run `npx vgpu doctor --pretty` before browser testing.
6. Render deterministic headless frames with `vgpu/node`; inspect actual pixels and save PNGs.
7. Use `agent-browser --webgpu --headed` for browser screenshots on Linux.
8. Do not claim a visual effect works unless a screenshot or pixel assertion proves it.
9. Implement in small commits:
   1. Mars sphere and lighting
   2. Atmosphere
   3. Dust/cloud layer
   4. Camera and animation
   5. Radar overlay
   6. Bloom/composite
   7. UI and responsive behavior
   8. Accessibility and reduced-motion fallback

## Coding standards
- TypeScript strict mode.
- No placeholder TODOs in shipped code.
- No hardcoded magic numbers without a named constant or explanation.
- Keep shaders modular: surface, atmosphere, clouds/dust, radar, post-processing.
- Preserve 60 FPS on a mid-range GPU; degrade gracefully on unsupported devices.
- Provide a static poster image fallback when WebGPU is unavailable.

## Definition of done
- All WGSL files pass `npx vgpu check`.
- `npx vgpu doctor --pretty` reports healthy.
- Headless render produces expected non-black, non-empty pixels.
- Browser screenshot shows Mars, atmosphere, dust, radar sweep, and UI.
- No console errors or WebGPU validation warnings.
- Lighthouse mobile performance is acceptable.
- Reduced-motion and no-WebGPU fallbacks work.