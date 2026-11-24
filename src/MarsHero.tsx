"use client";

// SkyFall hero: a static poster (the settled composition, scan complete) paints
// immediately, then the WebGPU canvas fades in over it once its first frame is
// presented and plays the intro and the radar scan. Reduced motion shows the settled
// composition with the scan already complete, without animation. If WebGPU is
// unavailable or fails at any point, the poster simply stays.
//
// Interactive layer: four hotspots (real buttons, so keyboard and screen readers reach
// them) pinned to the scene, each opening one info card; dragging turns Mars; clicking
// the planet pings it with radar; clicking a helicopter opens its card. The hero copy is
// passed as children: left third on desktop, below Mars on narrow screens.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import type { MarsRenderer, PingReading, ScanRequest } from "./renderer";

import { sceneAt, type ScanPhase } from "./animation";
import { HOTSPOT_ORDER, hudAt, type HotspotId, type HudState } from "./hud";
import styles from "./MarsHero.module.css";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import { detectWebGpu } from "./webgpu-support";

export type HeroRenderState = "loading" | "webgpu" | "fallback";

// One description for both the canvas and the poster: they show the same scene.
// The hero is an illustration, so the label says so explicitly (not live NASA data).
export const HERO_DESCRIPTION =
  "Conceptual mission visualization, not live data: Mars seen from orbit, a rust-red " +
  "planet with a white north polar ice cap and a dark canyon system near the equator, " +
  "lit by the sun from the left. Three small mission helicopters hover in the " +
  "foreground after separating from an entry vehicle, and a radar sweep marks areas " +
  "of possible subsurface ice in the northern mid-latitudes in pale blue, outlined " +
  "with contour lines.";

export const CONCEPT_TAG = "Conceptual visualization · not live data";

// Every statement comes from MISSION_FACTS.md.
export const HOTSPOTS: Readonly<Record<HotspotId, { label: string; shortLabel?: string; title: string; body: string }>> = {
  entry: {
    label: "Arrival",
    title: "Arrival",
    body: "SkyFall launches in late 2028 and reaches Mars in fall 2030, after a second Mars approach.",
  },
  helicopters: {
    label: "Helicopters",
    title: "Three autonomous helicopters",
    body: "Released mid-air during descent, they study terrain, weather, radiation, and subsurface ice.",
  },
  canyon: {
    label: "Terrain",
    title: "Mapping the terrain",
    body: "The mission's purpose: survey Mars, map its terrain, and search for subsurface ice.",
  },
  ice: {
    label: "Subsurface ice · ≈0.5–3 m · conceptual",
    // Phones: the depth stays in the card and the telemetry line.
    shortLabel: "Subsurface ice · conceptual",
    title: "Subsurface ice",
    body: "Radar searches approximately 0.5–3 meters below the surface. Subsurface ice could support future oxygen and rocket-fuel production.",
  },
};

export const PING_TEXT: Record<PingReading, string> = {
  likely: "Radar return · ice likely",
  possible: "Radar return · ice possible",
  none: "Radar return · no ice detected",
};

export const POSTER_SOURCES = {
  landscapeWebp: "/mars-poster-landscape.webp",
  landscapeJpeg: "/mars-poster-landscape.jpg",
  portraitWebp: "/mars-poster-portrait.webp",
  // The portrait (width-fitted) poster is used exactly where the live camera is
  // width-fitted: stage aspect below ~0.9 (MarsHero.module.css sets the stage size).
  //   < 1024 px: stage = full width x 62svh, so stage aspect = viewport aspect / 0.62,
  //              and 0.9 x 0.62 ~ 0.55 = 11/20.
  //   >= 1024 px: stage = two-thirds width x full height: 0.9 x 3/2 = 27/20.
  portraitMedia: "(max-width: 1023.98px) and (max-aspect-ratio: 11/20), (min-width: 1024px) and (max-aspect-ratio: 27/20)",
} as const;

// Fraction of the stage width beyond which labels and cards open to the left.
const FLIP_X = 0.55;
// Hotspots stay at least this far inside the stage (a point in space, such as the
// arrival path, can project near the edge on narrow screens).
const EDGE_MARGIN = 0.04;
// Within this fraction of a stage edge, phone labels align to the edge, not centre.
const LABEL_EDGE = 0.25;
const clampToStage = (value: number) => Math.min(1 - EDGE_MARGIN, Math.max(EDGE_MARGIN, value));
// Without live animation (reduced motion, no WebGPU) a scan request replays the result
// in text only: "sweeping" for this long, then the result again. Nothing moves.
const STATIC_REPLAY_MS = 1200;
// How long a ping readout stays after the ring has faded.
const PING_READOUT_MS = 2600;

export interface MarsHeroHandle {
  /** Runs the radar scan again (the scan CTA). Returns what happened. */
  scan(): ScanRequest;
  /** Reveals and labels every hotspot, then focuses the first one ("Explore Mars"). */
  explore(): void;
}

export interface MarsHeroProps {
  readonly ref?: Ref<MarsHeroHandle>;
  /** Page header: logo top-left, scan CTA top-right. */
  readonly header?: ReactNode;
  /** Hero copy: headline, CTAs, facts. */
  readonly children?: ReactNode;
  readonly onScanPhaseChange?: (phase: ScanPhase) => void;
  /** Every rendered frame while scanning: 0..1 sweep progress. */
  readonly onScanProgress?: (progress: number) => void;
}

export function MarsHero({ ref, header, children, onScanPhaseChange, onScanProgress }: MarsHeroProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardTitleRef = useRef<HTMLHeadingElement>(null);
  const pingRef = useRef<HTMLDivElement>(null);
  const hotspotRefs = useRef<Partial<Record<HotspotId, HTMLButtonElement | null>>>({});
  const [state, setState] = useState<HeroRenderState>("loading");
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [openCard, setOpenCard] = useState<HotspotId | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [pingText, setPingText] = useState("");
  const phaseRef = useRef<ScanPhase>("idle");
  const openCardRef = useRef<HotspotId | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // Read by the async init below, which outlives the render that started it.
  const reducedMotionRef = useRef(reducedMotion);
  const rendererRef = useRef<MarsRenderer | undefined>(undefined);
  const liveHudRef = useRef(false);
  const lastHudRef = useRef<HudState | undefined>(undefined);
  const stateRef = useRef<HeroRenderState>("loading");
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onPhaseRef = useRef(onScanPhaseChange);
  const onProgressRef = useRef(onScanProgress);
  onPhaseRef.current = onScanPhaseChange;
  onProgressRef.current = onScanProgress;
  stateRef.current = state;
  openCardRef.current = openCard;

  const setScanPhase = useCallback((next: ScanPhase) => {
    if (next === phaseRef.current) return;
    phaseRef.current = next;
    setPhase(next);
    onPhaseRef.current?.(next);
  }, []);

  // Positions the card next to its hotspot (desktop; phones use a bottom sheet in CSS).
  const placeCard = useCallback((hud: HudState) => {
    const card = cardRef.current;
    const id = openCardRef.current;
    if (!card || !id) return;
    const anchor = hud.hotspots[id];
    card.style.setProperty("--x", `${(clampToStage(anchor.x) * 100).toFixed(3)}%`);
    card.style.setProperty("--y", `${(clampToStage(anchor.y) * 100).toFixed(3)}%`);
    card.dataset.side = anchor.x > FLIP_X ? "left" : "right";
  }, []);

  // Applied every rendered frame: positions via styles, React state only on changes.
  const applyHud = useCallback(
    (hud: HudState) => {
      lastHudRef.current = hud;
      for (const id of HOTSPOT_ORDER) {
        const button = hotspotRefs.current[id];
        const spot = hud.hotspots[id];
        if (!button) continue;
        button.style.left = `${(clampToStage(spot.x) * 100).toFixed(3)}%`;
        button.style.top = `${(clampToStage(spot.y) * 100).toFixed(3)}%`;
        button.dataset.side = spot.x > FLIP_X ? "left" : "right";
        // Phones centre labels above the dot; near an edge they align to it instead.
        button.dataset.align = spot.x < LABEL_EDGE ? "start" : spot.x > 1 - LABEL_EDGE ? "end" : "center";
        const visible = spot.visible ? "true" : "false";
        if (button.dataset.visible !== visible) {
          button.dataset.visible = visible;
          // Hidden hotspots leave the tab order and the accessibility tree.
          button.tabIndex = spot.visible ? 0 : -1;
          button.setAttribute("aria-hidden", spot.visible ? "false" : "true");
        }
      }
      const ping = pingRef.current;
      if (ping && hud.ping.visible) {
        ping.style.left = `${(hud.ping.x * 100).toFixed(3)}%`;
        ping.style.top = `${(hud.ping.y * 100).toFixed(3)}%`;
        ping.dataset.side = hud.ping.x > FLIP_X ? "left" : "right";
      }
      placeCard(hud);
      if (hud.phase === "scanning") onProgressRef.current?.(hud.progress);
      setScanPhase(hud.phase);
    },
    [placeCard, setScanPhase]
  );

  const staticHud = useCallback(() => {
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage || stage.width <= 0 || stage.height <= 0) return undefined;
    const aspect = stage.width / stage.height;
    return hudAt(sceneAt(0, { aspect, reducedMotion: true }), aspect);
  }, []);

  const closeCard = useCallback((returnFocus: boolean) => {
    const id = openCardRef.current;
    setOpenCard(null);
    if (returnFocus && id) hotspotRefs.current[id]?.focus();
  }, []);

  const runScan = useCallback((): ScanRequest => {
    const renderer = rendererRef.current;
    if (renderer && stateRef.current === "webgpu" && !reducedMotionRef.current) {
      return renderer.scan();
    }
    // Static replay: announce the sweep, then the (unchanged) result.
    clearTimeout(replayTimerRef.current);
    setScanPhase("scanning");
    onProgressRef.current?.(1);
    replayTimerRef.current = setTimeout(() => setScanPhase("complete"), STATIC_REPLAY_MS);
    return "static";
  }, [setScanPhase]);

  useImperativeHandle(
    ref,
    () => ({
      scan: runScan,
      explore: () => {
        setRevealed(true);
        const first = HOTSPOT_ORDER.map((id) => hotspotRefs.current[id]).find((button) => button?.dataset.visible === "true");
        first?.focus();
      },
    }),
    [runScan]
  );

  useEffect(
    () => () => {
      clearTimeout(replayTimerRef.current);
      clearTimeout(pingTimerRef.current);
    },
    []
  );

  // Esc closes the open card and returns focus to its hotspot.
  useEffect(() => {
    if (!openCard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCard(true);
    };
    document.addEventListener("keydown", onKey);
    if (lastHudRef.current) placeCard(lastHudRef.current);
    cardTitleRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [openCard, closeCard, placeCard]);

  // Until the live canvas drives it (and always in the fallback), the HUD matches the
  // poster: the settled composition with the scan complete.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      if (liveHudRef.current) return;
      const hud = staticHud();
      if (hud) applyHud(hud);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [applyHud, staticHud]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
    rendererRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;

    void (async () => {
      const support = await detectWebGpu();
      if (cancelled) return;
      if (!support.supported) {
        setState("fallback");
        return;
      }
      try {
        // Loaded only after detection, so unsupported browsers never download vgpu.
        const { createMarsRenderer } = await import("./renderer");
        if (cancelled) return;
        const renderer = createMarsRenderer({
          canvas,
          stage: stageRef.current ?? undefined,
          reducedMotion: reducedMotionRef.current,
          onReady: () => {
            if (!cancelled) setState("webgpu");
          },
          onHud: (hud) => {
            if (cancelled) return;
            liveHudRef.current = true;
            applyHud(hud);
          },
          onSelect: (target) => {
            if (cancelled) return;
            if (target) setOpenCard(target);
            else if (openCardRef.current) closeCard(false);
          },
          onPing: (reading) => {
            if (cancelled) return;
            setPingText(PING_TEXT[reading]);
            clearTimeout(pingTimerRef.current);
            pingTimerRef.current = setTimeout(() => setPingText(""), PING_READOUT_MS);
          },
          onError: (error) => {
            console.warn("SkyFall hero: WebGPU rendering failed; showing the static poster.", error);
            if (cancelled) return;
            liveHudRef.current = false;
            setState("fallback");
            const hud = staticHud();
            if (hud) applyHud(hud);
          },
        });
        rendererRef.current = renderer;
        dispose = renderer.dispose;
      } catch (error) {
        console.warn("SkyFall hero: could not load the WebGPU renderer; showing the static poster.", error);
        if (!cancelled) setState("fallback");
      }
    })();

    return () => {
      cancelled = true;
      rendererRef.current = undefined;
      liveHudRef.current = false;
      dispose?.();
    };
  }, [applyHud, closeCard, staticHud]);

  const card = openCard ? HOTSPOTS[openCard] : undefined;

  return (
    <section
      className={styles.hero}
      data-render-state={state}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-scan-phase={phase}
    >
      {/* Header and copy first in the DOM: Tab reaches the CTAs before the hotspots. CSS
          order keeps Mars above the copy on narrow screens. */}
      {header ? <header className={styles.header}>{header}</header> : null}
      {children ? <div className={styles.copy}>{children}</div> : null}
      {/* Full-bleed: stars across the whole hero; Mars is framed inside the stage box. */}
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-visible={state === "webgpu" ? "true" : "false"}
        aria-hidden="true"
      />
      <div ref={stageRef} className={styles.stage}>
        <div className={styles.media} role="img" aria-label={HERO_DESCRIPTION}>
          {/* The planet with a transparent sky, over the page's static starfield until the
              live canvas takes over (and for good without WebGPU). */}
          <picture>
            <source media={POSTER_SOURCES.portraitMedia} srcSet={POSTER_SOURCES.portraitWebp} type="image/webp" />
            <source srcSet={POSTER_SOURCES.landscapeWebp} type="image/webp" />
            {/* Decorative here: the media wrapper carries the description for poster and canvas alike. */}
            <img className={styles.poster} src={POSTER_SOURCES.landscapeJpeg} alt="" fetchPriority="high" />
          </picture>
        </div>
        {/* Outside role="img": assistive tech ignores the children of an image role. */}
        <div className={styles.hud} data-revealed={revealed ? "true" : "false"} data-card-open={openCard ? "true" : "false"}>
          {HOTSPOT_ORDER.map((id) => (
            <button
              key={id}
              ref={(element) => {
                hotspotRefs.current[id] = element;
              }}
              type="button"
              className={styles.hotspot}
              data-hotspot={id}
              data-visible="false"
              tabIndex={-1}
              aria-hidden="true"
              aria-expanded={openCard === id}
              aria-controls="hero-info-card"
              aria-label={`${HOTSPOTS[id].title}: show details`}
              onClick={() => setOpenCard((current) => (current === id ? null : id))}
            >
              <span className={styles.hotspotDot} />
              <span className={styles.hotspotLabel}>
                <span className={styles.labelFull}>{HOTSPOTS[id].label}</span>
                {HOTSPOTS[id].shortLabel ? <span className={styles.labelShort}>{HOTSPOTS[id].shortLabel}</span> : null}
              </span>
            </button>
          ))}

          <div ref={pingRef} className={styles.ping} data-visible={pingText ? "true" : "false"} aria-hidden="true">
            <span className={styles.pingLabel}>
              {pingText}
              {pingText ? <span className={styles.pingTag}> · conceptual</span> : null}
            </span>
          </div>

          {card && openCard ? (
            <div
              ref={cardRef}
              id="hero-info-card"
              className={styles.card}
              role="dialog"
              aria-modal="false"
              aria-labelledby="hero-info-card-title"
              data-hotspot={openCard}
            >
              <h2 id="hero-info-card-title" ref={cardTitleRef} className={styles.cardTitle} tabIndex={-1}>
                {card.title}
              </h2>
              <p className={styles.cardBody}>{card.body}</p>
              {openCard === "ice" ? (
                <button type="button" className={styles.cardAction} onClick={() => runScan()}>
                  Scan again
                </button>
              ) : null}
              <p className={styles.cardTag}>{CONCEPT_TAG}</p>
              <button type="button" className={styles.cardClose} aria-label="Close details" onClick={() => closeCard(true)}>
                ×
              </button>
            </div>
          ) : null}
        </div>
        {/* Ping results for screen readers (the on-canvas readout is visual only). */}
        <p className={styles.visuallyHidden} aria-live="polite">
          {pingText ? `${pingText}, conceptual.` : ""}
        </p>
      </div>
    </section>
  );
}

export default MarsHero;
