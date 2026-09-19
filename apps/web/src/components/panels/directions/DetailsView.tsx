"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { Route, RouteCountrySpan, RouteStep } from "@openmapx/core";
import {
  countryAtMeters,
  formatDistance,
  formatDuration,
  useCountryFromCoordinates,
  useNavigationStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ElevationProfile } from "@/components/elevation/ElevationProfile";
import { DirectionsDetailHeader } from "@/components/panels/directions/DirectionsDetailHeader";
import { StepRow } from "@/components/panels/directions/StepRow";

/**
 * The sign-palette country for each step, where the step's maneuver sits
 * along the route. Only the route being navigated has countries from its
 * map-match; any other route, and any stretch not matched yet, falls back to
 * the origin's.
 */
function stepCountries(
  steps: readonly RouteStep[],
  startMeters: number,
  spans: RouteCountrySpan[] | null,
  fallback: string | null | undefined,
): (string | null | undefined)[] {
  let along = startMeters;
  return steps.map((step) => {
    const country = spans ? countryAtMeters(spans, along) : undefined;
    along += step.distance;
    return country ?? fallback;
  });
}

export function DetailsView({
  route,
  originLabel,
  destinationLabel,
  waypointLabels,
  units,
  onBack,
}: {
  route: Route;
  originLabel: string;
  destinationLabel: string;
  waypointLabels?: string[];
  units: "metric" | "imperial";
  onBack: () => void;
}) {
  const t = useTranslations("directions");
  const hasLegs = route.legs && route.legs.length > 1;
  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const intermediateLabels = waypointLabels ? waypointLabels.slice(1, -1).filter(Boolean) : [];

  // One reverse geocode for the sign palette, only when some step carries
  // signage — a plain route pays no lookup.
  const countryEnabled = route.steps.some((step) => !!step.sign);
  const { data: country } = useCountryFromCoordinates(route.geometry[0] ?? null, countryEnabled);
  const routeCountries = useNavigationStore((s) => (s.route === route ? s.routeCountries : null));
  const countries = stepCountries(route.steps, 0, routeCountries, country);

  return (
    <Box>
      <DirectionsDetailHeader
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        viaLabels={intermediateLabels}
        onBack={onBack}
      />
      <Divider />
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="h6"
          component="span"
          sx={{
            fontWeight: 600,
            color: "success.main",
          }}
        >
          {formatDuration(route.duration)}{" "}
        </Typography>
        <Typography
          variant="body1"
          component="span"
          sx={{
            color: "text.secondary",
          }}
        >
          ({dist})
        </Typography>
        {route.summary && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {route.summary}
          </Typography>
        )}
      </Box>
      <Divider />
      {hasLegs ? (
        <LegByLegView
          route={route}
          waypointLabels={waypointLabels ?? [originLabel, destinationLabel]}
          units={units}
          country={country}
          routeCountries={routeCountries}
          t={t}
        />
      ) : (
        <>
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 700,
              }}
            >
              {originLabel || t("origin")}
            </Typography>
          </Box>
          {route.steps.map((step, i) => (
            <StepRow
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
              key={i}
              instruction={step.instruction}
              distance={step.distance}
              duration={step.duration}
              units={units}
              lanes={step.lanes}
              maneuver={step.maneuver}
              sign={step.sign}
              country={countries[i]}
            />
          ))}
          <Box sx={{ px: 2, py: 1.5 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 700,
              }}
            >
              {destinationLabel || t("destination")}
            </Typography>
          </Box>
        </>
      )}
      {route.mode !== "transit" && <ElevationProfile route={route} units={units} />}
    </Box>
  );
}

function LegByLegView({
  route,
  waypointLabels,
  units,
  country,
  routeCountries,
  t,
}: {
  route: Route;
  waypointLabels: string[];
  units: "metric" | "imperial";
  country: string | null | undefined;
  routeCountries: RouteCountrySpan[] | null;
  t: ReturnType<typeof useTranslations>;
}) {
  const [expandedLegs, setExpandedLegs] = useState<Set<number>>(
    () => new Set(route.legs.map((_, i) => i)),
  );

  const toggleLeg = (index: number) => {
    setExpandedLegs((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <>
      {route.legs.map((leg, i) => {
        const legStartMeters = route.legs
          .slice(0, i)
          .reduce((sum, previous) => sum + previous.steps.reduce((m, s) => m + s.distance, 0), 0);
        const legCountries = stepCountries(leg.steps, legStartMeters, routeCountries, country);
        const fromLabel = waypointLabels[i] || t("origin");
        const toLabel = waypointLabels[i + 1] || t("destination");
        const legDist =
          units === "imperial"
            ? `${(leg.distance / 1609.34).toFixed(1)} mi`
            : formatDistance(leg.distance);
        const isExpanded = expandedLegs.has(i);

        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: legs have no stable id
          <Box key={i}>
            <Box
              onClick={() => toggleLeg(i)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                px: 2,
                py: 1.25,
                cursor: "pointer",
                bgcolor: "action.hover",
                "&:hover": { bgcolor: "action.selected" },
                transition: "background-color 0.15s",
                borderTop: "1px solid",
                borderColor: "divider",
              }}
            >
              <ExpandMoreIcon
                sx={{
                  fontSize: 20,
                  transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 0.2s",
                  color: "text.secondary",
                  flexShrink: 0,
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="body2"
                  noWrap
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {fromLabel} → {toLabel}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {formatDuration(leg.duration)} · {legDist}
                </Typography>
              </Box>
            </Box>
            <Collapse in={isExpanded}>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                  }}
                >
                  {fromLabel}
                </Typography>
              </Box>
              {leg.steps.map((step, j) => (
                <StepRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps have no stable id
                  key={j}
                  instruction={step.instruction}
                  distance={step.distance}
                  duration={step.duration}
                  units={units}
                  lanes={step.lanes}
                  maneuver={step.maneuver}
                  sign={step.sign}
                  country={legCountries[j]}
                />
              ))}
              <Box sx={{ px: 2, py: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                  }}
                >
                  {toLabel}
                </Typography>
              </Box>
            </Collapse>
          </Box>
        );
      })}
    </>
  );
}
