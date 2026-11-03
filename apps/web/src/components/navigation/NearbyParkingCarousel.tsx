"use client";

import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import {
  type CategoryPlace,
  formatMeasurementDistance,
  haversineDistance,
  type LngLat,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef } from "react";
import { useDataSourceI18nResolver } from "@/components/panels/place/useDataSourceI18nResolver";
import { type NearbyParkingPlace, PARKING_SOURCE_ID } from "./nearbyParking";
import { getParkingCoords } from "./parkingCoords";

/** Scrolls a car park's card into view; false when there is no such card. */
function revealCard(scroller: HTMLElement, id: string | null): boolean {
  const card = id
    ? scroller.querySelector<HTMLElement>(`[data-parking-id="${CSS.escape(id)}"]`)
    : null;
  card?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return Boolean(card);
}

interface Props {
  places: NearbyParkingPlace[];
  selectedPlace: CategoryPlace | null;
  isLoading: boolean;
  onSelectPlace: (place: CategoryPlace | null) => void;
  onDriveToPlace: (place: CategoryPlace) => void;
  destinationCoords?: LngLat | null;
  disabled?: boolean;
}

export function NearbyParkingCarousel({
  places,
  selectedPlace,
  isLoading,
  onSelectPlace,
  onDriveToPlace,
  destinationCoords,
  disabled = false,
}: Props) {
  const t = useTranslations("navigation");
  const units = useSettingsStore((s) => s.units);
  const resolveToken = useDataSourceI18nResolver(PARKING_SOURCE_ID);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const order = places.map((place) => place.id).join("\n");
  const selectedId = selectedPlace?.id ?? null;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // Measuring the drive and walk reorders the cards. Scroll snapping would keep
  // the previously first card in view and hide the new best one to its left, so
  // a new order starts from the first card, unless one is selected.
  useLayoutEffect(() => {
    void order;
    const scroller = scrollerRef.current;
    if (scroller && !revealCard(scroller, selectedIdRef.current)) scroller.scrollLeft = 0;
  }, [order]);

  // A car park chosen on the map brings its card into view.
  useLayoutEffect(() => {
    if (scrollerRef.current) revealCard(scrollerRef.current, selectedId);
  }, [selectedId]);

  if (isLoading) {
    return (
      <Box sx={{ width: "100%", mt: 1 }} role="status" aria-busy="true">
        <Skeleton variant="text" width="40%" height={20} />
        <Box sx={{ display: "flex", gap: 1.5, py: 1, px: 0.5 }}>
          {[0, 1].map((i) => (
            <Skeleton key={i} variant="rounded" width={200} height={120} />
          ))}
        </Box>
      </Box>
    );
  }

  if (places.length === 0) return null;

  return (
    <Box sx={{ width: "100%", mt: 1 }}>
      <Typography variant="caption" sx={{ fontWeight: 600, color: "text.secondary", px: 0.5 }}>
        {t("nearbyParking")} · {t("parkingOptionsCount", { count: places.length })}
      </Typography>
      <Box
        ref={scrollerRef}
        sx={{
          display: "flex",
          gap: 1.5,
          overflowX: "auto",
          py: 1,
          px: 0.5,
          scrollSnapType: "x mandatory",
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
        }}
      >
        {places.map((place) => {
          const isSelected = selectedPlace?.id === place.id;
          const summary = place.summary ? resolveToken(place.summary) : "";

          const coords = getParkingCoords(place);
          const straightMeters =
            destinationCoords && coords ? haversineDistance(coords, destinationCoords) : null;

          return (
            <Paper
              key={place.id}
              data-parking-id={place.id}
              variant="outlined"
              component="article"
              sx={{
                flex: "0 0 200px",
                scrollSnapAlign: "start",
                p: 1.5,
                borderRadius: 2,
                borderColor: isSelected ? "primary.main" : "divider",
                borderWidth: isSelected ? 2 : 1,
                bgcolor: isSelected ? "action.selected" : "background.paper",
                display: "flex",
                flexDirection: "column",
                gap: 1,
              }}
            >
              <Button
                size="small"
                variant="text"
                disabled={disabled}
                aria-pressed={isSelected}
                aria-label={`${place.name || t("nearbyParking")} — ${t("previewOnMap")}`}
                startIcon={<LocalParkingIcon color="primary" fontSize="small" />}
                onClick={() => onSelectPlace(isSelected ? null : place)}
                sx={{ justifyContent: "flex-start", minWidth: 0, px: 0.5 }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                  {place.name || t("nearbyParking")}
                </Typography>
              </Button>
              <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", alignItems: "center" }}>
                {place.fee === "free" && (
                  <Chip
                    size="small"
                    label={t("parkingFeeFree")}
                    color="success"
                    variant="outlined"
                  />
                )}
                {place.fee === "paid" && (
                  <Chip
                    size="small"
                    label={t("parkingFeePaid")}
                    color="default"
                    variant="outlined"
                  />
                )}
                {place.access === "customers" && (
                  <Chip
                    size="small"
                    label={t("parkingCustomersOnly")}
                    color="warning"
                    variant="outlined"
                  />
                )}
                {summary && (
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {summary}
                  </Typography>
                )}
                {place.walk ? (
                  <Typography variant="caption" color="text.secondary">
                    {t("parkingWalkToDestination", {
                      minutes: Math.max(1, Math.round(place.walk.seconds / 60)),
                      dist: formatMeasurementDistance(place.walk.meters, units),
                    })}
                  </Typography>
                ) : (
                  straightMeters !== null && (
                    <Typography variant="caption" color="text.secondary">
                      {t("straightLineDistance", {
                        dist: formatMeasurementDistance(straightMeters, units),
                      })}
                    </Typography>
                  )
                )}
              </Box>
              <Button
                size="small"
                disabled={disabled}
                variant={isSelected ? "contained" : "outlined"}
                startIcon={<DirectionsCarIcon />}
                onClick={() => onDriveToPlace(place)}
              >
                {t("driveHere")}
              </Button>
            </Paper>
          );
        })}
      </Box>
    </Box>
  );
}
