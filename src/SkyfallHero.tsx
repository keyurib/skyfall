"use client";

// The SkyFall hero: Mars stage + copy (headline, subheadline, CTAs, radar telemetry,
// key facts). Copy uses only MISSION_FACTS.md. Everything lives in this one fold; the
// rest of the mission information opens from hotspots on the scene.
import { useRef, useState } from "react";

import type { ScanPhase } from "./animation";
import { MarsHero, type MarsHeroHandle } from "./MarsHero";
import type { ScanRequest } from "./renderer";
import styles from "./SkyfallHero.module.css";

export const HERO_COPY = {
  eyebrow: "NASA · Mars helicopter mission",
  headline: "Beneath the Red, a Future Awaits.",
  subheadline:
    "Three autonomous helicopters, released mid-air during descent, will map the terrain of " +
    "Mars and search for ice about 0.5–3 meters below the surface — ice that could one day " +
    "support oxygen and rocket-fuel production.",
  scanCta: "Initiate radar scan",
  exploreCta: "Explore Mars",
  hint: "Drag to turn Mars · click the surface to ping it",
} as const;

// Radar telemetry under the CTAs. Radar depth from MISSION_FACTS.md.
export const TELEMETRY: Record<ScanPhase, string> = {
  idle: "Radar standby",
  scanning: "Radar sweep · 0.5–3 m below the surface",
  complete: "Subsurface ice indicated",
};
export const TELEMETRY_DISCLAIMER = "Conceptual telemetry · not live data";

export const KEY_FACTS = [
  { label: "Launch", value: "Late 2028" },
  { label: "Mars arrival", value: "Fall 2030" },
  { label: "Scouts", value: "3 helicopters" },
  { label: "Radar depth", value: "≈ 0.5–3 m" },
] as const;

export function SkyfallHero() {
  const heroRef = useRef<MarsHeroHandle>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const [request, setRequest] = useState<ScanRequest | undefined>(undefined);

  const scanning = phase === "scanning";
  // "Queued" until the scan actually begins (pressed during the intro).
  const queued = request === "queued" && phase !== "scanning";
  const label = scanning ? "Scanning…" : queued ? "Scan queued" : HERO_COPY.scanCta;

  const header = (
    <>
      <p className={styles.brand}>
        <span className={styles.wordmark}>SkyFall</span>
        <span className={styles.eyebrowText}>{HERO_COPY.eyebrow}</span>
      </p>
      <div className={styles.scanBlock}>
        <button
          type="button"
          data-cta="scan"
          className={styles.primary}
          aria-disabled={scanning || queued}
          onClick={() => {
            if (scanning || queued) return;
            setRequest(heroRef.current?.scan());
          }}
        >
          {label}
        </button>
        {/* The scan's status lives with the button that drives it. */}
        <div className={styles.telemetry} data-phase={phase}>
          <p className={styles.telemetryLine}>
            <span role="status" aria-live="polite">
              {TELEMETRY[phase]}
            </span>
            {scanning ? <span ref={progressRef} aria-hidden="true" /> : null}
          </p>
          <p className={styles.telemetryNote}>{TELEMETRY_DISCLAIMER}</p>
        </div>
      </div>
    </>
  );

  return (
    <MarsHero
      ref={heroRef}
      header={header}
      onScanPhaseChange={(next) => {
        setPhase(next);
        if (next === "scanning") setRequest(undefined);
      }}
      onScanProgress={(progress) => {
        // Per-frame, so written directly: no re-render, and not announced (aria-hidden).
        if (progressRef.current) progressRef.current.textContent = ` · ${Math.round(progress * 100)}%`;
      }}
    >
      <h1 className={styles.headline} style={{ animationDelay: "150ms" }}>
        {HERO_COPY.headline}
      </h1>
      <p className={styles.subheadline} style={{ animationDelay: "300ms" }}>
        {HERO_COPY.subheadline}
      </p>
      <div className={styles.actions} style={{ animationDelay: "450ms" }}>
        <button type="button" data-cta="explore" className={styles.secondary} onClick={() => heroRef.current?.explore()}>
          {HERO_COPY.exploreCta}
        </button>
      </div>
      <dl className={styles.facts} style={{ animationDelay: "600ms" }}>
        {KEY_FACTS.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.hint} style={{ animationDelay: "750ms" }}>
        {HERO_COPY.hint}
      </p>
    </MarsHero>
  );
}

export default SkyfallHero;
