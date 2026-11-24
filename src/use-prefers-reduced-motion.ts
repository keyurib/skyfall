"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

// Server render assumes reduced motion: the first paint never animates, and clients
// that allow motion switch on during hydration.
function getServerSnapshot(): boolean {
  return true;
}

/** Live `prefers-reduced-motion: reduce` preference; updates when the OS setting changes. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
