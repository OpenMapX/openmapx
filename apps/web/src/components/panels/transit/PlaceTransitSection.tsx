"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SubwayIcon from "@mui/icons-material/Subway";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  useLinkedTransitAlerts,
  useLinkedTransitDepartures,
  useLinkedTransitFacilities,
  useLinkedTransitRoutes,
} from "@openmapx/core";
import type { MergedDeparture, MergedRoute, TransportMode } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import { useMemo } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { TEAL } from "@/lib/theme";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { AlertsBanner } from "./AlertsBanner";
import { DepartureRow } from "./DepartureRow";
import { FacilitiesSection } from "./FacilitiesSection";
import { RouteBadge } from "./RouteBadge";

const MAX_BADGES_PER_MODE = 8;

const MODE_ICONS: Partial<Record<TransportMode, SvgIconComponent>> = {
  rail: TrainIcon,
  subway: SubwayIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
  ferry: DirectionsBoatIcon,
};

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
};

function groupByMode(routes: MergedRoute[]): Map<TransportMode, MergedRoute[]> {
  const map = new Map<TransportMode, MergedRoute[]>();
  for (const route of routes) {
    const group = map.get(route.mode) ?? [];
    group.push(route);
    map.set(route.mode, group);
  }
  return map;
}

interface PlaceTransitSectionProps {
  place: Place;
  onOpenDepartures: (mode?: TransportMode) => void;
  onOpenLineDetail?: (route: MergedRoute) => void;
  onOpenTripDetail?: (dep: MergedDeparture) => void;
}

export function PlaceTransitSection({
  place,
  onOpenDepartures,
  onOpenLineDetail,
  onOpenTripDetail,
}: PlaceTransitSectionProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const routesQuery = useLinkedTransitRoutes(place);
  const { data: routes, isLoading } = routesQuery;
  const alertsQuery = useLinkedTransitAlerts(place);
  const { data: alerts } = alertsQuery;
  const departuresQuery = useLinkedTransitDepartures(place);
  const { data: departures, isLoading: depsLoading } = departuresQuery;
  const facilitiesQuery = useLinkedTransitFacilities(place);
  const { data: facilities } = facilitiesQuery;
  const mergedAttributions = useAttributionFromHooks(
    routesQuery,
    alertsQuery,
    departuresQuery,
    facilitiesQuery,
  );

  const alertRouteIds = useMemo(
    () =>
      new Set(
        (alerts ?? [])
          .filter((a) => a.severity === "severe" || a.severity === "critical")
          .flatMap((a) => a.affectedRouteIds),
      ),
    [alerts],
  );

  // Show skeleton while loading only if we haven't confirmed there are no routes
  if (isLoading && !routes) {
    return (
      <Box sx={{ px: 2, py: 1 }}>
        <Divider sx={{ mb: 1.5 }} />
        <Skeleton variant="text" width="40%" height={16} sx={{ mb: 1 }} />
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} variant="rounded" width={36} height={24} />
          ))}
        </Box>
      </Box>
    );
  }

  // No transit data for this place — render nothing
  if (!routes || routes.length === 0) return null;

  const grouped = groupByMode(routes);

  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Divider sx={{ mb: 1.5 }} />

      {/* Section header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1.25 }}>
        <DirectionsTransitIcon sx={{ fontSize: 20, color: TEAL }} />
        <Typography variant="subtitle2" fontWeight={600} color="text.primary">
          {t("transit")}
        </Typography>
      </Box>

      {alerts && alerts.length > 0 && (
        <Box sx={{ mb: 1.25 }}>
          <AlertsBanner alerts={alerts} />
        </Box>
      )}

      {/* Routes grouped by mode */}
      {Array.from(grouped.entries()).map(([mode, modeRoutes]) => {
        const Icon = MODE_ICONS[mode] ?? DirectionsBusIcon;
        const labelKey = MODE_LABEL_KEYS[mode];
        const label = labelKey ? t(labelKey) : mode;
        return (
          <Box key={mode} sx={{ mb: 1.25 }}>
            <ButtonBase
              aria-label={t("viewDepartures", { mode: label })}
              onClick={() => onOpenDepartures(mode)}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 0.5,
                mb: 0.75,
                width: "calc(100% + 8px)",
                mx: -0.5,
                px: 0.5,
                py: "2px",
                borderRadius: 1,
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Icon sx={{ fontSize: 16, color: "text.secondary" }} />
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={500}
                sx={{ flex: 1, textAlign: "left" }}
              >
                {label}
              </Typography>
              <ChevronRightIcon sx={{ fontSize: 14, color: "text.disabled" }} />
            </ButtonBase>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center" }}>
              {modeRoutes.slice(0, MAX_BADGES_PER_MODE).map((route) => {
                const tooltipTitle = route.providers
                  .map((p) => {
                    const matched = mergedAttributions.find((a) => a.sourceId === p);
                    return matched?.name ?? p;
                  })
                  .join(" · ");
                return (
                  <Tooltip key={route.id} title={tooltipTitle} placement="top" arrow>
                    <span>
                      <RouteBadge
                        shortName={route.shortName}
                        color={route.color}
                        textColor={route.textColor}
                        mode={route.mode}
                        onClick={onOpenLineDetail ? () => onOpenLineDetail(route) : undefined}
                      />
                    </span>
                  </Tooltip>
                );
              })}
              {modeRoutes.length > MAX_BADGES_PER_MODE && (
                <Typography
                  component="span"
                  role="button"
                  tabIndex={0}
                  variant="caption"
                  color={TEAL}
                  onClick={() => onOpenDepartures(mode)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenDepartures(mode);
                    }
                  }}
                  sx={{ cursor: "pointer", "&:hover": { textDecoration: "underline" } }}
                >
                  {t("moreRoutes", { count: modeRoutes.length - MAX_BADGES_PER_MODE })}
                </Typography>
              )}
            </Box>
          </Box>
        );
      })}

      {/* Departures preview */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 1.25, mb: 0.5 }}>
        <ScheduleIcon sx={{ fontSize: 16, color: "text.secondary" }} />
        <Typography variant="caption" color="text.secondary" fontWeight={500}>
          {t("nextDepartures")}
        </Typography>
      </Box>
      {depsLoading && !departures && (
        <Box sx={{ mt: 1 }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={48} />
          ))}
        </Box>
      )}
      {departures && departures.length > 0 ? (
        <Box sx={{ mt: 0.5, mb: 0.5 }}>
          {departures.slice(0, 5).map((dep) => (
            <DepartureRow
              key={`${dep.tripId}-${dep.scheduledAt}-${dep.route.id}`}
              departure={dep}
              onClick={
                onOpenTripDetail ? (dep) => onOpenTripDetail(dep as MergedDeparture) : undefined
              }
              hasAlert={alertRouteIds.has(dep.route.id)}
            />
          ))}
        </Box>
      ) : !depsLoading && departures ? (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {t("noDeparturesInNext60")}
        </Typography>
      ) : null}

      {/* Facilities */}
      {facilities && facilities.length > 0 && (
        <>
          <Divider sx={{ my: 1 }} />
          <Box sx={{ mx: -2 }}>
            <FacilitiesSection facilities={facilities} />
          </Box>
        </>
      )}

      {/* Open departures button */}
      <Button
        variant="outlined"
        size="small"
        startIcon={<ScheduleIcon />}
        onClick={() => onOpenDepartures()}
        sx={{
          mt: 1,
          textTransform: "none",
          borderColor: TEAL,
          color: TEAL,
          "&:hover": { borderColor: "var(--omx-teal-hover)", bgcolor: "var(--omx-hover-bg)" },
        }}
      >
        {t("viewDeparturesArrivals")}
      </Button>
      <AttributionStrip
        attributions={mergedAttributions}
        variant="inline"
        label={tc("dataSources")}
      />
    </Box>
  );
}
