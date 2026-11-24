# SkyFall Hero — Implementation Plan

## Objective
Build a cinematic, interactive Mars hero for NASA’s SkyFall mission:
three autonomous helicopters deploy during atmospheric descent and scan for
subsurface ice.

## Visual narrative
1. Mars is distant, partially lit, and slowly rotating.
2. An entry vehicle enters the atmosphere.
3. Three helicopters separate and fan outward.
4. A radar sweep reveals blue-white subsurface ice beneath red regolith.
5. The camera settles behind one helicopter; users can orbit or trigger a scan.

## Technical approach
- Reuse vgpu Earth’s procedural planet, atmosphere, and bloom architecture.
- Replace Earth’s surface, clouds, night lights, and color grading with Mars.
- Build the planet as a sphere with procedural albedo, normal variation, and polar caps.
- Use a screen-space atmosphere shader for the thin butterscotch Martian sky.
- Add a subtle high-altitude dust layer.
- Use a post-processing radar overlay for the subsurface-ice reveal.
- Keep bloom limited to the sun, rotor highlights, and radar pulse.

## Milestones
### M1 — Static Mars
- Procedural Mars sphere
- Sun direction and terminator
- Rust-red surface variation
- Polar ice caps
- Basic atmosphere

### M2 — Cinematic motion
- Slow planet rotation
- Camera dolly toward Mars
- Entry-vehicle streak
- Three helicopter deployment markers

### M3 — Discovery reveal
- Radar sweep across the planet
- Subsurface ice mask
- Blue-white glow beneath the surface
- HUD telemetry labels

### M4 — UI and polish
- Headline, subheadline, CTAs
- Mission facts
- Scroll-triggered sequence
- Reduced-motion fallback
- WebGPU-unsupported fallback

## Explicitly out of scope
- Real NASA telemetry
- Photorealistic Mars terrain
- Full helicopter 3D models
- A complete landing page