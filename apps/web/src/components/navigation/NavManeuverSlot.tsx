"use client";

import {
  countryAtMeters,
  guidanceApproachMeters,
  shouldPreviewNextStep,
  stepStartMeters,
  upcomingManeuverIndex,
  useCountryFromCoordinates,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useMemo } from "react";
import { ManeuverBanner } from "./ManeuverBanner";

/**
 * The only piece of nav chrome that needs the upcoming-maneuver arithmetic on
 * every accepted fix. Subscribes to `progress` directly so re-computing it
 * re-renders just this banner, not the cold controls around it.
 */
export function NavManeuverSlot() {
  const route = useNavigationStore((s) => s.route);
  const progress = useNavigationStore((s) => s.progress);
  const mode = useNavigationStore((s) => s.mode);
  const units = useSettingsStore((s) => s.units);
  const routeCountries = useNavigationStore((s) => s.routeCountries);

  // Show the nav chrome from the static route immediately on Start; live
  // position (progress) refines it once GPS fixes arrive. Without this, the
  // overlay is blank until the first fix — which never comes on devices that
  // deny or can't provide geolocation, so Start would appear to do nothing.
  const stepIndex = progress?.currentStepIndex ?? 0;
  // Surface the UPCOMING maneuver (at the end of the step you're driving), which
  // is what distanceToNextManeuver counts down to — not the one already done at
  // the start of the current step. `nextStep` is the one after that ("Then …").
  const upcomingIndex = route ? upcomingManeuverIndex(stepIndex, route.steps.length) : 0;
  const step = route ? route.steps[upcomingIndex] : null;
  const nextStep = route ? route.steps[upcomingIndex + 1] : undefined;
  const distanceToManeuver = progress?.distanceToNextManeuver ?? step?.distance ?? 0;
  const speedMps = progress?.speedMps ?? 0;
  // Detailed guidance becomes relevant only inside the approach window (a lead
  // time before the maneuver that stretches on the motorway) — so on a long
  // stretch neither the lanes nor the "Then …" preview clutter the banner.
  const approaching = distanceToManeuver <= guidanceApproachMeters(mode, speedMps);
  const showLanes = !!step?.lanes && approaching;
  // Preview the maneuver after this one only when it's both relevant (approaching)
  // and follows closely (a short gap), so back-to-back turns chain but far-apart
  // ones don't.
  const showNextStep =
    !!nextStep &&
    shouldPreviewNextStep(mode, speedMps, distanceToManeuver, nextStep.duration, nextStep.distance);

  // Signs take the colours of the country they stand in: the countries along
  // the route come from its map-match, and one reverse geocode of the origin
  // covers engines without them. A route without signage never pays it.
  const hasSign = !!step?.sign;
  const signCountry = useMemo(
    () =>
      route && routeCountries && hasSign
        ? countryAtMeters(routeCountries, stepStartMeters(route.steps, upcomingIndex))
        : undefined,
    [route, routeCountries, hasSign, upcomingIndex],
  );
  const { data: originCountry } = useCountryFromCoordinates(route?.geometry[0] ?? null, hasSign);
  const country = signCountry ?? originCountry;

  if (!step) return null;

  return (
    <ManeuverBanner
      instruction={step.instruction}
      distanceToManeuver={distanceToManeuver}
      maneuver={step.maneuver}
      nextInstruction={showNextStep ? nextStep?.instruction : undefined}
      nextManeuver={showNextStep ? nextStep?.maneuver : undefined}
      lanes={showLanes ? step.lanes : undefined}
      sign={step.sign}
      country={country}
      units={units}
    />
  );
}
