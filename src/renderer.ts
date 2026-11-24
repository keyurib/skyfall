// Browser lifecycle for the Mars hero canvas.
// Adapted from the vgpu Earth example's renderer.ts: same init / resource-graph /
// prewarm / dispose ordering and the same 0.05 s delta cap, minus lil-gui. The scene is
// driven by the deterministic timeline in animation.ts.
//   - Motion allowed: the intro plays, the radar scan runs, then ambient motion
//     (rotation, hover) continues. scan() re-runs the radar sweep (the scan CTA).
//   - Reduced motion: the settled composition with the completed scan, redrawn only
//     when something changes (resize, the user's own drag, a ping).
//   - Off screen: time stops and nothing is encoded until the hero is visible again.
//
// Interaction (vgpu has no built-in input adapter by design; pointer input is the
// app's, fed into the scene state, as the Earth example does for its orbit):
//   - Drag: horizontal turns the planet, vertical tilts the camera (clamped). After
//     IDLE_RETURN_MS without input the view eases back to the composed shot.
//   - Hover (mouse): the camera leans slightly toward the pointer.
//   - Click/tap: a helicopter opens its info card; the planet gets a radar ping with an
//     ice readout; empty space closes any open card.
//   - Touch: vertical swipes keep scrolling the page (touch-action: pan-y).
import type { Gpu, Surface } from "vgpu";
import { clock, frameLoop, surface } from "vgpu";

import { SCAN, TIMELINE, sceneAt, type UserView } from "./animation";
import { directionToUv, hudAt, pickHelicopter, pickPlanet, type HudState } from "./hud";
import { ICE_MAP_SIZE } from "./mars-scene";
import type { Vec3 } from "./mars-planet";
import {
  bakeMaps,
  createMaps,
  createScene,
  createTargets,
  prewarm,
  render,
  resizeTargets,
  setFrameUniforms,
  setSizeBindings,
  setStaticBindings,
  type MarsShaders,
  type Scene,
  type StageRect,
  type Targets,
} from "./mars-scene";

import atmosphereWgsl from "./shaders/mars-atmosphere.wgsl";
import bakeIceWgsl from "./shaders/bake-ice.wgsl";
import bakeSurfaceWgsl from "./shaders/bake-mars-surface.wgsl";
import blurWgsl from "./shaders/blur.wgsl";
import brightPassWgsl from "./shaders/bright-pass.wgsl";
import compositeWgsl from "./shaders/composite.wgsl";
import entryVehicleWgsl from "./shaders/entry-vehicle.wgsl";
import helicopterWgsl from "./shaders/helicopter.wgsl";
import marsWgsl from "./shaders/mars.wgsl";
import overlayWgsl from "./shaders/mars-overlay.wgsl";
import skyWgsl from "./shaders/mars-sky.wgsl";

const SHADERS: MarsShaders = {
  bakeSurface: bakeSurfaceWgsl,
  bakeIce: bakeIceWgsl,
  mars: marsWgsl,
  atmosphere: atmosphereWgsl,
  sky: skyWgsl,
  overlay: overlayWgsl,
  brightPass: brightPassWgsl,
  blur: blurWgsl,
  composite: compositeWgsl,
  helicopter: helicopterWgsl,
  entryVehicle: entryVehicleWgsl,
};

// Render at most 2x device pixels, as in Earth: sharper than 1x, far cheaper than 3x.
const DPR_RANGE: readonly [number, number] = [1, 2];
// Earth's cap: a stalled or backgrounded frame never jumps the timeline forward.
const MAX_FRAME_SECONDS = 0.05;

// Drag sensitivity, in radians per CSS pixel (the Earth example maps a full canvas
// width to one turn; this is gentler so the composition is not lost by accident).
const DRAG_YAW_PER_PX = 0.006;
const DRAG_PITCH_PER_PX = 0.003;
const USER_PITCH_LIMIT = 0.35;
// Movement beyond this many CSS pixels makes a press a drag rather than a click.
const CLICK_SLOP_PX = 5;
// Earth's smoothing rate: blend = 1 - exp(-dt * rate).
const VIEW_SMOOTHING_RATE = 9;
const LEAN_SMOOTHING_RATE = 4;
// The view returns to the composed shot after this long without input.
const IDLE_RETURN_MS = 6000;
// Ping length on the wall clock (matches animation.ts PING.durationSeconds).
const PING_SECONDS = 1.6;

export type ScanRequest = "started" | "queued" | "static";

/** Radar readout for a ping: conceptual ice likelihood at the clicked point. */
export type PingReading = "likely" | "possible" | "none";

export interface MarsRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** The element marking where Mars is framed inside the (full-bleed) canvas. Defaults to
   *  the whole canvas. Picking, hotspots, and helicopter hits are all relative to it. */
  readonly stage?: HTMLElement;
  readonly reducedMotion: boolean;
  /** Called once, after the first frame has been presented. */
  readonly onReady?: () => void;
  /** Called after every rendered frame with hotspot placement and scan phase. */
  readonly onHud?: (hud: HudState) => void;
  /** Called when the user clicks a helicopter (open its card) or empty space (close). */
  readonly onSelect?: (target: "helicopters" | null) => void;
  /** Called when a click on the planet starts a radar ping. */
  readonly onPing?: (reading: PingReading) => void;
  /** Called once if initialization or rendering fails; the renderer has disposed itself. */
  readonly onError?: (error: unknown) => void;
}

export interface MarsRenderer {
  readonly ready: Promise<void>;
  setReducedMotion(reduced: boolean): void;
  /** Runs the radar sweep again (from the start). Before the intro settles, it is
   *  scheduled for the moment it settles ("queued"). Under reduced motion nothing
   *  animates ("static"): the result is already shown complete. */
  scan(): ScanRequest;
  dispose(): void;
}

export function createMarsRenderer({
  canvas,
  stage: stageElement,
  reducedMotion: initialReducedMotion,
  onReady,
  onHud,
  onSelect,
  onPing,
  onError,
}: MarsRendererOptions): MarsRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let scene: Scene | undefined;
  let targets: Targets | undefined;
  let observer: IntersectionObserver | undefined;
  let removeInput: (() => void) | undefined;
  let reducedMotion = initialReducedMotion;
  let onScreen = true;
  let elapsed = 0;
  let scanStart: number | undefined;
  let needsRender = true;
  let readyReported = false;
  let iceMap: Uint8Array | undefined;
  let lastHud: HudState | undefined;
  let lastAspect = 1;
  let stageObserver: ResizeObserver | undefined;
  // The stage rectangle relative to the canvas, in CSS pixels; re-measured on layout changes.
  let stageCss: StageRect | undefined;
  const measureStage = () => {
    if (!stageElement) return;
    const canvasRect = canvas.getBoundingClientRect();
    const rect = stageElement.getBoundingClientRect();
    stageCss = { x: rect.left - canvasRect.left, y: rect.top - canvasRect.top, width: rect.width, height: rect.height };
    needsRender = true;
  };

  // --- Interaction state -------------------------------------------------------------
  const view = { yaw: 0, pitch: 0 };
  const viewTarget = { yaw: 0, pitch: 0 };
  const lean = { x: 0, y: 0 };
  const leanTarget = { x: 0, y: 0 };
  let lastInputAt = 0;
  let dragging = false;
  let dragPointer: number | undefined;
  let pressX = 0;
  let pressY = 0;
  let lastX = 0;
  let lastY = 0;
  let dragMoved = false;
  let ping: { origin: Vec3; startedAt: number } | undefined;
  // Planet turn from dragging when the current scan began (keeps the sweep on the ground).
  let scanUserYaw = 0;
  let scanAnchoredFor: number | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    stageObserver?.disconnect();
    if (typeof window !== "undefined") window.removeEventListener("resize", measureStage);
    removeInput?.();
    // Disposing the gpu stops the frame loop and releases every resource it owns.
    gpu?.dispose();
  };

  const fail = (error: unknown) => {
    const firstFailure = !disposed;
    dispose();
    if (firstFailure) onError?.(error);
  };

  const setReducedMotion = (reduced: boolean) => {
    if (reduced === reducedMotion) return;
    reducedMotion = reduced;
    needsRender = true;
  };

  const scan = (): ScanRequest => {
    if (reducedMotion || disposed) return "static";
    scanStart = Math.max(elapsed, TIMELINE.settled);
    scanAnchoredFor = undefined;
    needsRender = true;
    return scanStart > elapsed ? "queued" : "started";
  };

  const sampleIce = (local: Vec3): number => {
    if (!iceMap) return 0;
    const [u, v] = directionToUv(local);
    const [width, height] = ICE_MAP_SIZE;
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    return iceMap[y * width + x]! / 255;
  };

  // Pointer position as 0..1 fractions of the stage (where Mars is framed).
  const canvasPoint = (event: PointerEvent) => {
    const rect = (stageElement ?? canvas).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / Math.max(1, rect.width), y: (event.clientY - rect.top) / Math.max(1, rect.height) };
  };

  const handleClick = (event: PointerEvent) => {
    if (!lastHud) return;
    const { x, y } = canvasPoint(event);
    if (pickHelicopter(lastHud, lastAspect, x, y) !== null) {
      onSelect?.("helicopters");
      return;
    }
    const state = currentState(lastAspect);
    const local = pickPlanet(state, lastAspect, x, y);
    if (!local) {
      onSelect?.(null);
      return;
    }
    onSelect?.(null);
    ping = { origin: local, startedAt: performance.now() };
    needsRender = true;
    const ice = sampleIce(local);
    onPing?.(ice > 0.6 ? "likely" : ice > 0.25 ? "possible" : "none");
  };

  const installInput = () => {
    const previousTouchAction = canvas.style.touchAction;
    const previousCursor = canvas.style.cursor;
    // Vertical swipes keep scrolling the page; horizontal drags turn the planet.
    canvas.style.touchAction = "pan-y";
    canvas.style.cursor = "grab";

    const down = (event: PointerEvent) => {
      if (!event.isPrimary || dragPointer !== undefined) return;
      dragPointer = event.pointerId;
      dragging = true;
      dragMoved = false;
      pressX = lastX = event.clientX;
      pressY = lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const move = (event: PointerEvent) => {
      if (dragging && event.pointerId === dragPointer) {
        if (!dragMoved && Math.hypot(event.clientX - pressX, event.clientY - pressY) > CLICK_SLOP_PX) dragMoved = true;
        if (dragMoved) {
          viewTarget.yaw += (event.clientX - lastX) * DRAG_YAW_PER_PX;
          viewTarget.pitch = Math.max(-USER_PITCH_LIMIT, Math.min(USER_PITCH_LIMIT, viewTarget.pitch + (event.clientY - lastY) * DRAG_PITCH_PER_PX));
          lastInputAt = performance.now();
          needsRender = true;
        }
        lastX = event.clientX;
        lastY = event.clientY;
        return;
      }
      if (event.pointerType === "mouse") {
        const { x, y } = canvasPoint(event);
        leanTarget.x = x * 2 - 1;
        leanTarget.y = 1 - y * 2;
      }
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== dragPointer) return;
      if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      dragPointer = undefined;
      dragging = false;
      canvas.style.cursor = "grab";
      if (!dragMoved && event.type === "pointerup") handleClick(event);
      lastInputAt = performance.now();
    };
    const leave = () => {
      leanTarget.x = 0;
      leanTarget.y = 0;
    };

    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      if (dragPointer !== undefined && canvas.hasPointerCapture?.(dragPointer)) canvas.releasePointerCapture(dragPointer);
      canvas.style.touchAction = previousTouchAction;
      canvas.style.cursor = previousCursor;
    };
  };

  /** Eases the user view and lean; returns true while anything is still settling. */
  const stepInteraction = (deltaSeconds: number): boolean => {
    const now = performance.now();
    if (!dragging && now - lastInputAt > IDLE_RETURN_MS && (viewTarget.yaw !== 0 || viewTarget.pitch !== 0)) {
      // Return to the composed shot by the shortest way round.
      const wrapped = Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw));
      view.yaw = wrapped;
      viewTarget.yaw = 0;
      viewTarget.pitch = 0;
    }
    if (reducedMotion) {
      // Snap: the user's own drag still applies, but nothing glides or leans.
      const changed = view.yaw !== viewTarget.yaw || view.pitch !== viewTarget.pitch || lean.x !== 0 || lean.y !== 0;
      view.yaw = viewTarget.yaw;
      view.pitch = viewTarget.pitch;
      lean.x = 0;
      lean.y = 0;
      return changed;
    }
    const viewBlend = 1 - Math.exp(-deltaSeconds * VIEW_SMOOTHING_RATE);
    const leanBlend = 1 - Math.exp(-deltaSeconds * LEAN_SMOOTHING_RATE);
    view.yaw += (viewTarget.yaw - view.yaw) * viewBlend;
    view.pitch += (viewTarget.pitch - view.pitch) * viewBlend;
    lean.x += (leanTarget.x - lean.x) * leanBlend;
    lean.y += (leanTarget.y - lean.y) * leanBlend;
    return Math.abs(viewTarget.yaw - view.yaw) > 1e-4 || Math.abs(viewTarget.pitch - view.pitch) > 1e-4;
  };

  const currentState = (aspect: number) => {
    const pingAge = ping ? (performance.now() - ping.startedAt) / 1000 : undefined;
    const user: UserView = { yaw: view.yaw, pitch: view.pitch };
    return sceneAt(elapsed, {
      aspect,
      reducedMotion,
      scanStart,
      user,
      scanUserYaw,
      lean,
      ping: ping && pingAge !== undefined ? { origin: ping.origin, age: pingAge } : undefined,
    });
  };

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, canvas, { dpr: DPR_RANGE });
    const maps = createMaps(gpu);
    scene = createScene(gpu, SHADERS);
    targets = createTargets(gpu, canvasSurface.size);
    setStaticBindings(scene, maps, targets);
    await Promise.all([bakeMaps(gpu, maps, SHADERS), prewarm(scene, targets, canvasSurface.format)]);
    if (disposed) return;
    // One small CPU copy of the ice map (512 KB) for ping readouts.
    iceMap = await maps.ice.color.read({ mipLevel: 0, region: "all" });
    if (disposed) return;

    // Fires now and after every resize the surface applies (CSS size or DPR changes).
    canvasSurface.onResize(({ width, height }) => {
      if (disposed || !scene || !targets) return;
      try {
        resizeTargets(targets, [width, height]);
        setSizeBindings(scene, targets);
        measureStage();
        needsRender = true;
      } catch (error) {
        fail(error);
      }
    });

    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        if (onScreen) needsRender = true;
      });
      observer.observe(canvas);
    }
    removeInput = installInput();
    if (stageElement) {
      measureStage();
      // The stage can move without the canvas resizing (e.g. the header reflows above it).
      stageObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureStage);
      stageObserver?.observe(stageElement);
      stageObserver?.observe(canvas);
      window.addEventListener("resize", measureStage);
    }

    const time = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (disposed || !canvasSurface || !scene || !targets) return;
      const delta = Math.min(MAX_FRAME_SECONDS, time.deltaTime);
      const settling = stepInteraction(delta);
      const pingActive = ping !== undefined && (performance.now() - ping.startedAt) / 1000 < PING_SECONDS;
      // One more frame after a ping ends, to clear its ring.
      if (ping && !pingActive) {
        ping = undefined;
        needsRender = true;
      }
      const animating = !reducedMotion && onScreen;
      if (!animating && !needsRender && !settling && !pingActive) return;
      try {
        if (animating) elapsed += delta;
        // Pin the sweep to the ground the user was looking at when it began.
        const effectiveScanStart = Math.max(scanStart ?? SCAN.autoStart, TIMELINE.settled);
        if (scanAnchoredFor !== effectiveScanStart && elapsed >= effectiveScanStart) {
          scanUserYaw = view.yaw;
          scanAnchoredFor = effectiveScanStart;
        }
        const size = canvasSurface.size;
        // CSS -> device pixels: the canvas backing store may be scaled by the DPR.
        const cssWidth = canvas.clientWidth || size[0];
        const pixelScale = size[0] / Math.max(1, cssWidth);
        const stagePx: StageRect = stageCss
          ? { x: stageCss.x * pixelScale, y: stageCss.y * pixelScale, width: stageCss.width * pixelScale, height: stageCss.height * pixelScale }
          : { x: 0, y: 0, width: size[0], height: size[1] };
        const aspect = stagePx.width / Math.max(1, stagePx.height);
        const state = currentState(aspect);
        setFrameUniforms(scene, size, state, stagePx);
        render(currentFrame, scene, targets, canvasSurface);
        lastAspect = aspect;
        lastHud = hudAt(state, aspect);
        onHud?.(lastHud);
        needsRender = false;
        if (!readyReported) {
          readyReported = true;
          onReady?.();
        }
      } catch (error) {
        fail(error);
      }
    });
  };

  const ready = initialize().catch((error: unknown) => {
    fail(error);
  });

  return { ready, setReducedMotion, scan, dispose };
}
