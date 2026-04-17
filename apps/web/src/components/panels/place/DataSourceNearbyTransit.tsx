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
import type { LngLat, TransitStop, TransportMode } from "@openmapx/core";
import {
  haversineMeters,
  PANEL,
  usePlaceStore,
  useSidebarStore,
  useStopsNearby,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { useMap } from "@/lib/MapContext";
import { TEAL } from "@/lib/theme";

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

/**
 * Map a transit mode to OpenMapTiles-style `class/subclass` values so the
 * resulting place passes `isTransitRawCategory` and renders the full place
 * panel (not the minimal stop-mode fallback).
 */
function placeCategoryForMode(mode: TransportMode | undefined): {
  category: string;
  rawCategory: string;
} {
  switch (mode) {
    case "rail":
      return { category: "station", rawCategory: "railway/station" };
    case "subway":
      return { category: "subway", rawCategory: "railway/subway" };
    case "tram":
      return { category: "tram_stop", rawCategory: "railway/tram_stop" };
    case "bus":
      return { category: "bus_stop", rawCategory: "highway/bus_stop" };
    case "ferry":
      return { category: "ferry_terminal", rawCategory: "amenity/ferry_terminal" };
    default:
      return { category: "station", rawCategory: "public_transport/stop_position" };
  }
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
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
    // Use a synthetic `style-poi-*` id (same shape as a map-click on a style
    // POI) so PlaceDetailContent renders the full place view — reverse
    // geocoding fills in the address, operator, plus-code etc. A `stop:` id
    // would trigger the minimal stop-only panel.
    const { category, rawCategory } = placeCategoryForMode(primaryMode(stop.modes));
    setSelectedPlace({
      id: `style-poi-stop-${stop.id}`,
      name: stop.name,
      address: stop.name,
      coordinates: [stop.lng, stop.lat],
      category,
      rawCategory,
    });
    // Match the map-click behaviour in MapStylePoiClickHandler: if the sidebar
    // is empty or already showing a place, take it over; otherwise (category
    // results, directions …) keep that panel and show the floating detail card
    // only, so we never render the same place twice.
    const sidebarId = useSidebarStore.getState().activeSidebarId;
    if (!sidebarId || sidebarId === PANEL.PLACE) {
      useSidebarStore.getState().closeDetail();
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    } else {
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    }
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
        <DirectionsTransitIcon sx={{ fontSize: 20, color: TEAL }} />
        <Typography variant="subtitle2" fontWeight={600} color="text.primary">
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
                color="text.secondary"
                sx={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}
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
