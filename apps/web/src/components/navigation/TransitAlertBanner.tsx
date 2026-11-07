"use client";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { type TransitProgress, useNavigationStore } from "@openmapx/core";
import { changedFromPlatform, collectActiveAlerts } from "@openmapx/core/navigation";
import type { ServiceAlert, TripItinerary } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { SEVERITY_CONFIG } from "@/components/panels/transit/AlertCard";

export function collectTransitNavigationAlerts(
  itinerary: TripItinerary,
  currentLegIndex: number,
  transitProgress: TransitProgress | null,
  t: (key: string, values?: Record<string, string | number>) => string,
): ServiceAlert[] {
  const legs = itinerary.legs;
  const alerts = collectActiveAlerts(legs, currentLegIndex);

  const cards: ServiceAlert[] = [];

  // A cancelled ride is the most urgent thing to say — synthesize a severe card
  // when the feed doesn't already carry an explicit alert for it.
  const cancelledLeg = legs.slice(Math.max(0, currentLegIndex)).find((l) => l.cancelled && l.route);
  if (cancelledLeg?.route) {
    cards.push({
      id: `cancel:${cancelledLeg.tripId ?? cancelledLeg.route.shortName}`,
      providers: [],
      severity: "severe",
      title: t("legCancelled", {
        line: cancelledLeg.route.shortName || cancelledLeg.route.longName || "",
      }),
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [],
    });
  }

  // Boarding platform changed for the ride you're about to catch: prominent while
  // you haven't boarded yet (it's moot once under way).
  const currentLeg = legs[currentLegIndex];
  const departed = transitProgress?.phase === "riding";
  const wasPlatform = currentLeg ? changedFromPlatform(currentLeg.from) : undefined;
  if (currentLeg?.route && !departed && wasPlatform && currentLeg.from.platformCode) {
    cards.push({
      id: `platform:${currentLeg.tripId ?? currentLeg.route.shortName}`,
      providers: [],
      severity: "warning",
      title: t("platformChanged", {
        line: currentLeg.route.shortName || currentLeg.route.longName || "",
        platform: currentLeg.from.platformCode,
        scheduled: wasPlatform,
      }),
      affectedRouteIds: [],
      affectedStopIds: [],
      activePeriods: [],
    });
  }

  cards.push(...alerts);

  return cards;
}

/** Flat, readable service notices inside the journey sheet. */
export function TransitAlertBanner({
  itinerary,
  currentLegIndex,
  transitProgress,
  expanded = true,
  onExpand,
}: {
  itinerary: TripItinerary;
  currentLegIndex: number;
  transitProgress: TransitProgress | null;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  const t = useTranslations("navigation");
  const voiceEnabled = useNavigationStore((s) => s.voiceEnabled);
  const cards = collectTransitNavigationAlerts(itinerary, currentLegIndex, transitProgress, t);
  const shown = expanded ? cards : cards.slice(0, 1);
  if (!shown.length) return null;
  return (
    <Box role={!voiceEnabled && !expanded ? "status" : undefined}>
      {shown.map((alert) => {
        const config = SEVERITY_CONFIG[alert.severity];
        const Icon = config.icon;
        return (
          <Box
            key={alert.id}
            sx={{
              display: "flex",
              alignItems: "flex-start",
              gap: 1,
              px: 2,
              py: 1,
              bgcolor: config.bg,
              color: config.color,
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Icon sx={{ fontSize: 20, mt: 0.1, flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  overflowWrap: "anywhere",
                  ...(!expanded
                    ? {
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }
                    : {}),
                }}
              >
                {alert.title}
              </Typography>
              {expanded && alert.description && (
                <Typography
                  variant="caption"
                  sx={{ display: "block", mt: 0.5, color: "text.primary" }}
                >
                  {alert.description}
                </Typography>
              )}
            </Box>
          </Box>
        );
      })}
      {!expanded && cards.length > 1 && (
        <Button onClick={onExpand} sx={{ minHeight: 44, mx: 2, borderRadius: "999px" }}>
          {t("moreTransitAlerts", { count: cards.length - 1 })}
        </Button>
      )}
    </Box>
  );
}
