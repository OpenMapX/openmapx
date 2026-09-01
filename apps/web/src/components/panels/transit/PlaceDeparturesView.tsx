"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  useLinkedTransitAlerts,
  useLinkedTransitArrivals,
  useLinkedTransitDepartures,
} from "@openmapx/core";
import type { MergedDeparture, TransportMode } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { useAttributionFromHooks } from "@/integration-api/overlay/useAttributionFromHooks";
import { DepartureRow } from "./DepartureRow";

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
};

interface PlaceDeparturesViewProps {
  place: Place;
  onBack: () => void;
  clearSearchBar?: boolean;
  modeFilter?: TransportMode | null;
  onDepartureClick: (dep: MergedDeparture) => void;
}

export function PlaceDeparturesView({
  place,
  onBack,
  clearSearchBar = false,
  modeFilter,
  onDepartureClick,
}: PlaceDeparturesViewProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const departuresQuery = useLinkedTransitDepartures(place);
  const { data: departures, isLoading: depsLoading } = departuresQuery;
  const [tab, setTab] = useState<"departures" | "arrivals">("departures");
  const arrivalsQuery = useLinkedTransitArrivals(place);
  const { data: arrivals, isLoading: arrivalsLoading } = arrivalsQuery;

  const alertsQuery = useLinkedTransitAlerts(place);
  const { data: alerts } = alertsQuery;
  const mergedAttributions = useAttributionFromHooks(departuresQuery, arrivalsQuery, alertsQuery);

  const alertRouteIds = useMemo(
    () =>
      new Set(
        (alerts ?? [])
          .filter((a) => a.severity === "severe" || a.severity === "critical")
          .flatMap((a) => a.affectedRouteIds),
      ),
    [alerts],
  );

  const items = tab === "departures" ? departures : arrivals;
  const isLoading = tab === "departures" ? depsLoading : arrivalsLoading;
  const filtered = modeFilter ? items?.filter((d) => d.route.mode === modeFilter) : items;
  const hasArrivals = arrivals && arrivals.length > 0;

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        // On desktop: match panel height so only the list area scrolls (not the Paper)
        height: { xs: "auto", sm: "100dvh" },
      }}
    >
      {/* Header with back button — sticky on mobile (Paper scrolls), static on desktop (flex layout) */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          pb: 1,
          // Clear the floating search bar via top padding instead of a spacer element
          pt: clearSearchBar ? { xs: 1, sm: "72px" } : 1,
          flexShrink: 0,
          position: { xs: "sticky", sm: "static" },
          top: { xs: 0, sm: "auto" },
          bgcolor: "background.paper",
          zIndex: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <IconButton onClick={onBack} size="small" aria-label={tc("back")}>
          <ArrowBackIcon sx={{ fontSize: 20 }} />
        </IconButton>
        <Box>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
            }}
          >
            {place.name}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {modeFilter
              ? `${MODE_LABEL_KEYS[modeFilter] ? t(MODE_LABEL_KEYS[modeFilter] as string) : modeFilter} ${t(tab)}`
              : t(tab)}
          </Typography>
        </Box>
      </Box>
      {hasArrivals && (
        <Box sx={{ px: 1.5, pt: 1, pb: 1 }}>
          <ToggleButtonGroup
            value={tab}
            exclusive
            onChange={(_, v) => v && setTab(v)}
            size="small"
            fullWidth
          >
            <ToggleButton value="departures" sx={{ textTransform: "none" }}>
              {t("departures")}
            </ToggleButton>
            <ToggleButton value="arrivals" sx={{ textTransform: "none" }}>
              {t("arrivals")}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
      )}
      <AttributionStrip
        attributions={mergedAttributions}
        variant="panel-header"
        label={tc("dataSources")}
      />
      {/* Scrollable list area — on desktop this is the only thing that scrolls */}
      <Box sx={{ flex: 1, overflowY: { xs: "visible", sm: "auto" } }}>
        {isLoading ? (
          /* Loading skeletons */
          <Box>
            {[1, 2, 3, 4, 5].map((i) => (
              <Box
                key={i}
                sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 1.25 }}
              >
                <Box sx={{ flex: 1 }}>
                  <Skeleton variant="text" width="60%" height={16} />
                  <Skeleton variant="rounded" width={36} height={20} sx={{ mt: 0.5 }} />
                </Box>
                <Skeleton variant="text" width={40} height={16} />
              </Box>
            ))}
          </Box>
        ) : filtered && filtered.length > 0 ? (
          /* Transit list */
          <Box>
            {filtered.map((dep) => (
              <Box key={`${dep.tripId}-${dep.scheduledAt}`}>
                <DepartureRow
                  departure={dep}
                  showPlatform
                  onClick={(dep) => onDepartureClick(dep as MergedDeparture)}
                  hasAlert={alertRouteIds.has(dep.route.id)}
                />
              </Box>
            ))}
          </Box>
        ) : (
          /* Empty state */
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {modeFilter
                ? t("noDeparturesMode", {
                    mode: MODE_LABEL_KEYS[modeFilter]
                      ? t(MODE_LABEL_KEYS[modeFilter] as string)
                      : modeFilter,
                    tab: t(tab),
                  })
                : t("noDeparturesGeneric", { tab: t(tab) })}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
