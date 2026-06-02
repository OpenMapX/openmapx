"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NotificationImportantIcon from "@mui/icons-material/NotificationImportant";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import {
  formatDuration,
  stopsUntilAlight,
  type TransitProgress,
  useNavigationStore,
  useSidebarStore,
  useVehicleJourney,
} from "@openmapx/core";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";
import { haptics } from "@/lib/haptics";
import { useTransitNavigationEngine } from "@/lib/navigation/useTransitNavigationEngine";
import { TEAL_HEX } from "@/lib/theme";
import { useWakeLock } from "@/lib/useWakeLock";
import { ArrivalCard } from "./ArrivalCard";

/**
 * Slice the full vehicle journey down to the stops for this leg, between the
 * board and alight stop ids. Mirrors the logic in TransitLegStops so the
 * countdown matches what the itinerary detail view shows.
 */
function legStopsFor(
  stops: { stopId: string; name: string; lat: number; lng: number }[],
  leg: TripLeg,
): { lat: number; lng: number; name: string }[] {
  const fromId = leg.from.stopId;
  const toId = leg.to.stopId;
  const fromIdx = fromId ? stops.findIndex((s) => s.stopId === fromId) : -1;
  const toIdx =
    fromIdx !== -1 && toId
      ? stops.findIndex((s, i) => i > fromIdx && s.stopId === toId)
      : toId
        ? stops.findIndex((s) => s.stopId === toId)
        : -1;
  const sliced =
    fromIdx !== -1 && toIdx !== -1 && toIdx > fromIdx ? stops.slice(fromIdx, toIdx + 1) : stops;
  return sliced.map((s) => ({ lat: s.lat, lng: s.lng, name: s.name }));
}

/** Next-stop / alight countdown for a transit leg, backed by the live journey. */
function NextStopPanel({
  leg,
  transitProgress,
}: {
  leg: TripLeg;
  transitProgress: TransitProgress;
}) {
  const t = useTranslations("navigation");
  const { data: journey } = useVehicleJourney(leg.tripId ?? null);
  const alertedRef = useRef(false);

  const legStops = journey?.stops ? legStopsFor(journey.stops, leg) : [];
  const { nextStopName, stopsRemaining } = stopsUntilAlight(
    leg.geometry.coordinates,
    legStops,
    transitProgress.snapped,
  );

  const alightSoon = legStops.length > 0 && stopsRemaining > 0 && stopsRemaining <= 1;

  // Fire the haptic pulse once per entry into the alight window; reset when we
  // leave it so a re-entry can buzz again.
  useEffect(() => {
    if (alightSoon && !alertedRef.current) {
      alertedRef.current = true;
      haptics.warn();
    } else if (!alightSoon) {
      alertedRef.current = false;
    }
  }, [alightSoon]);

  return (
    <Box
      sx={{
        pointerEvents: "auto",
        bgcolor: "background.paper",
        borderRadius: 3,
        px: 2,
        py: 1.5,
        boxShadow: 2,
      }}
    >
      {alightSoon ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <NotificationImportantIcon sx={{ color: "error.main", fontSize: 32 }} />
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: "error.main" }}>
              {t("alightSoon")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("alightAt", { place: leg.to.name })}
            </Typography>
          </Box>
        </Box>
      ) : (
        <>
          {nextStopName && (
            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
              {t("nextStop", { stop: nextStopName })}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {legStops.length > 0 && stopsRemaining > 0
              ? t("alightAtCount", { place: leg.to.name, count: stopsRemaining })
              : t("alightAt", { place: leg.to.name })}
          </Typography>
        </>
      )}
    </Box>
  );
}

export function TransitNavigationView() {
  const status = useNavigationStore((s) => s.status);
  const kind = useNavigationStore((s) => s.kind);
  const itinerary = useNavigationStore((s) => s.itinerary);
  const transitProgress = useNavigationStore((s) => s.transitProgress);
  const keepScreenOn = useNavigationStore((s) => s.keepScreenOn);
  const stopNavigation = useNavigationStore((s) => s.stopNavigation);

  const t = useTranslations("navigation");
  const locale = useLocale();
  const active = status !== "idle" && status !== "arrived" && kind === "transit";

  // Hooks must run before any early return.
  useTransitNavigationEngine();
  useWakeLock(active && keepScreenOn);

  // Collapse the route-planning sidebar while navigating; restore on exit.
  useEffect(() => {
    if (!active) return;
    const prevCollapsed = useSidebarStore.getState().collapsed;
    useSidebarStore.getState().setCollapsed(true);
    return () => useSidebarStore.getState().setCollapsed(prevCollapsed);
  }, [active]);

  if (status === "idle" || kind !== "transit" || !itinerary) return null;

  const legs = itinerary.legs;
  const currentLegIndex = Math.min(transitProgress?.currentLegIndex ?? 0, legs.length - 1);
  const currentLeg = legs[currentLegIndex] as TripLeg | undefined;

  const arrivalTime = new Date(itinerary.endTime).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        p: 2,
        pt: "calc(var(--omx-safe-top) + 8px)",
        pb: "calc(var(--omx-safe-bottom) + 8px)",
      }}
    >
      {status === "arrived" ? (
        <Box
          sx={{ pointerEvents: "auto", m: "auto", bgcolor: "background.paper", borderRadius: 3 }}
        >
          <ArrivalCard onClose={stopNavigation} />
        </Box>
      ) : (
        <>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {currentLeg && (
              <Box
                sx={{
                  pointerEvents: "auto",
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  p: 2,
                  bgcolor: TEAL_HEX,
                  color: "#fff",
                  borderRadius: 3,
                }}
              >
                {currentLeg.mode === "walking" ? (
                  <DirectionsWalkIcon sx={{ fontSize: 40 }} />
                ) : currentLeg.route ? (
                  <RouteBadge
                    shortName={currentLeg.route.shortName}
                    color={currentLeg.route.color}
                    mode={currentLeg.mode}
                    size="medium"
                  />
                ) : (
                  <DirectionsWalkIcon sx={{ fontSize: 40 }} />
                )}
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h6" sx={{ lineHeight: 1.15 }} noWrap>
                    {currentLeg.mode === "walking"
                      ? t("walkTo", { place: currentLeg.to.name })
                      : t("ride", {
                          line: currentLeg.route?.shortName ?? currentLeg.route?.longName ?? "",
                          to: currentLeg.to.name,
                        })}
                  </Typography>
                  <Typography variant="caption" sx={{ opacity: 0.85 }}>
                    {t("legCounter", { current: currentLegIndex + 1, total: legs.length })}
                  </Typography>
                </Box>
              </Box>
            )}
            {currentLeg && currentLeg.mode !== "walking" && transitProgress && (
              <NextStopPanel leg={currentLeg} transitProgress={transitProgress} />
            )}
          </Box>

          <Box
            sx={{
              pointerEvents: "auto",
              mb: 5,
              display: "flex",
              alignItems: "center",
              gap: 2,
              p: 2,
              bgcolor: "background.paper",
              borderRadius: 3,
              boxShadow: 3,
            }}
          >
            <Box sx={{ flexGrow: 1 }}>
              <Typography variant="h6">{formatDuration(itinerary.duration)}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t("arriveAt", { time: arrivalTime })}
              </Typography>
            </Box>
            <Button
              variant="contained"
              color="error"
              startIcon={<CloseIcon />}
              onClick={stopNavigation}
              sx={{ borderRadius: 99 }}
            >
              {t("end")}
            </Button>
          </Box>
        </>
      )}
    </Box>
  );
}
