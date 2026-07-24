"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DirectionsBoatIcon from "@mui/icons-material/DirectionsBoat";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import SubwayIcon from "@mui/icons-material/Subway";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import {
  formatDistance,
  haversineMeters,
  PANEL,
  resolveStopAsPlace,
  usePlaceStore,
  useSidebarStore,
  useStopsNearby,
} from "@openmapx/core";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { BRAND } from "@/lib/theme";

const DEFAULT_RADIUS_M = 500;
const MAX_STOPS = 6;

/** Priority order for picking the primary mode icon when a stop serves several modes. */
const MODE_PRIORITY: TransportMode[] = [
  "rail",
  "subway",
  "tram",
  "bus",
  "ferry",
  "gondola",
  "funicular",
  "cable_car",
  "monorail",
];

const MODE_ICONS: Partial<Record<TransportMode, SvgIconComponent>> = {
  rail: TrainIcon,
  subway: SubwayIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
  ferry: DirectionsBoatIcon,
};

function primaryMode(modes: TransportMode[]): TransportMode | undefined {
  for (const m of MODE_PRIORITY) {
    if (modes.includes(m)) return m;
  }
  return modes[0];
}

interface DataSourceNearbyTransitProps {
  coordinates: LngLat;
  radiusMeters?: number;
}

/**
 * Renders a "Nearby Transit" section listing stops within walking distance,
 * ordered by distance. Each row is clickable and opens the stop as a place.
 *
 * Silently renders nothing during the initial load or when no stops are
 * found — avoids a dead section for parking far from any transit.
 */
export function DataSourceNearbyTransit({
  coordinates,
  radiusMeters = DEFAULT_RADIUS_M,
}: DataSourceNearbyTransitProps) {
  const t = useTranslations();
  const { data: stops, isLoading } = useStopsNearby(coordinates, radiusMeters);
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo } = useMap();

  const rows = useMemo(() => {
    if (!stops) return [];
    const [lng, lat] = coordinates;
    const seen = new Set<string>();
    return stops
      .map((s) => ({
        stop: s,
        distance: haversineMeters(lat, lng, s.lat, s.lng),
      }))
      .filter((r) => {
        if (r.distance > radiusMeters) return false;
        // Dedup by name + rounded coord cell — providers often report the same
        // physical stop under multiple ids (per-platform entries, mirror feeds).
        const key = `${r.stop.name.toLowerCase()}|${r.stop.lat.toFixed(4)}|${r.stop.lng.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_STOPS);
  }, [stops, coordinates, radiusMeters]);

  const handleOpen = (stop: TransitStop) => {
    flyTo([stop.lng, stop.lat], 16);
    // Resolve the stop to a Place via OSM reverse geocoding when available
    // (ids.osm), falling back to a synthetic stop-backed Place. Matches the
    // pattern used by SearchBar's transit result handler.
    void resolveStopAsPlace(stop).then((place) => {
      setSelectedPlace(place);
      // Match the map-click behaviour in MapStylePoiClickHandler: if the
      // sidebar is empty or already showing a place, take it over; otherwise
      // (category results, directions …) keep that panel and show the
      // floating detail card only, so we never render the same place twice.
      const sidebarId = useSidebarStore.getState().activeSidebarId;
      if (!sidebarId || sidebarId === PANEL.PLACE) {
        useSidebarStore.getState().closeDetail();
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      } else {
        useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      }
    });
  };

  if (isLoading && !stops) {
    return (
      <Box sx={{ px: 2, py: 1 }}>
        <Divider sx={{ mb: 1.5 }} />
        <Skeleton variant="text" width="40%" height={16} sx={{ mb: 1 }} />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} variant="rectangular" height={36} sx={{ mb: 0.5, borderRadius: 1 }} />
        ))}
      </Box>
    );
  }

  if (rows.length === 0) return null;

  return (
    <Box sx={{ px: 2, py: 1 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1 }}>
        <DirectionsTransitIcon sx={{ fontSize: 20, color: BRAND }} />
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: "text.primary",
          }}
        >
          {t("dataSources.sectionNearbyTransit")}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
        {rows.map(({ stop, distance }) => {
          const mode = primaryMode(stop.modes);
          const Icon = (mode && MODE_ICONS[mode]) ?? DirectionsBusIcon;
          return (
            <ButtonBase
              key={stop.id}
              onClick={() => handleOpen(stop)}
              aria-label={t("dataSources.openStop", { name: stop.name })}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                width: "calc(100% + 8px)",
                mx: -0.5,
                px: 1,
                py: 0.75,
                borderRadius: 1,
                justifyContent: "flex-start",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Icon sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0 }} />
              <Typography
                variant="body2"
                sx={{
                  flex: 1,
                  textAlign: "left",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "text.primary",
                }}
              >
                {stop.name}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  flexShrink: 0,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatDistance(distance)}
              </Typography>
              <ChevronRightIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
}
