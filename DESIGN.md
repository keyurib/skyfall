# SkyFall Hero — Design Direction

## Concept
“Beneath the Red, a Future Awaits.”

The hero should feel like the opening scene of a mission:
humanity arrives at Mars, releases autonomous scouts, and discovers the
hidden resource that could make a human future possible.

## Composition
- Mars occupies the right two-thirds on desktop.
- Text occupies the left third with generous negative space.
- The sun creates a hard rim light along Mars’s limb.
- The radar sweep moves diagonally across the visible surface.
- The final camera position keeps one helicopter silhouette in the foreground.

## Color system
- Deep space: #05060A
- Martian regolith: #7A2E18, #A84525, #C86A38
- Dust haze: #D9A273
- Atmosphere rim: #E8B08A
- Ice reveal: #7FD8FF, #BFEFFF
- Mission accent: #FF5A36
- Text: #F4F1EC
- Muted text: #A8A29A

## Typography
- Display: Space Grotesk, Inter Tight, or Sora
- Body: Inter
- Mono telemetry: JetBrains Mono or IBM Plex Mono

## Motion
- Planet rotation: 0.02–0.05 rad/sec
- Camera dolly: 8–12 seconds
- Radar sweep: 2.5–4 seconds
- UI reveal: staggered 120–180 ms
- Respect `prefers-reduced-motion`

## Accessibility
- Minimum 4.5:1 contrast for primary text.
- Do not rely on color alone to communicate the ice discovery.
- Provide descriptive alt text for the canvas.
- Provide a static poster fallback.