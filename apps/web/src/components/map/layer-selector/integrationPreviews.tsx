"use client";

import type { ReactNode } from "react";
import {
  airQualityPreview,
  buildingsPreview,
  cyclingMapPreview,
  earthquakesPreview,
  environmentPreview,
  hikingPreview,
  liveTrainsPreview,
  measurePreview,
  naturalEventsPreview,
  streetViewPreview,
  trafficPreview,
  transitPreview,
  travelTimePreview,
  weatherPreview,
  wildfirePreview,
  winterSportsPreview,
} from "./layerPreviewSvgs";

/**
 * Maps overlay IDs (used in OVERLAY_REGISTRY) to their layer selector preview SVGs.
 * New integrations can provide their own preview via a preview.tsx file in the
 * integration directory, or add an entry here for built-in integrations.
 */
export const INTEGRATION_PREVIEWS: Record<string, ReactNode> = {
  traffic: trafficPreview,
  transit: transitPreview,
  hiking: hikingPreview,
  "street-view": streetViewPreview,
  wildfires: wildfirePreview,
  "air-quality": airQualityPreview,
  "winter-sports": winterSportsPreview,
  earthquakes: earthquakesPreview,
  "natural-events": naturalEventsPreview,
  cycling: cyclingMapPreview,
  "live-trains": liveTrainsPreview,
  "3d-buildings": buildingsPreview,
  "travel-time": travelTimePreview,
  measurement: measurePreview,
  weather: weatherPreview,
  environment: environmentPreview,
};

/** Generic fallback preview for integrations without a custom preview. */
export const genericPreview: ReactNode = (
  <svg
    viewBox="0 0 80 80"
    xmlns="http://www.w3.org/2000/svg"
    width="100%"
    height="100%"
    role="img"
    aria-hidden="true"
  >
    <rect width="80" height="80" fill="#e8edf2" rx="4" />
    <circle cx="40" cy="32" r="14" fill="#b0c4d8" opacity="0.5" />
    <rect x="20" y="52" width="40" height="4" rx="2" fill="#b0c4d8" opacity="0.4" />
    <rect x="26" y="60" width="28" height="3" rx="1.5" fill="#b0c4d8" opacity="0.3" />
  </svg>
);
