"use client";

import ConfirmationNumberOutlinedIcon from "@mui/icons-material/ConfirmationNumberOutlined";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  formatDuration,
  formatOverviewDistance,
  geocodeStopAsPlace,
  makeSyntheticStopPlace,
  PANEL,
  parseId,
  resolveStopAsPlace,
  tzOffsetLabel,
  usePlaceStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MergedDeparture, TransitStop, TripItinerary } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { DirectionsDetailHeader } from "@/components/panels/directions/DirectionsDetailHeader";
import { TransitLegChain } from "@/components/panels/directions/TransitLegChain";
import {
  itineraryContributors,
  TransitLegTimeline,
} from "@/components/panels/directions/TransitLegTimeline";
import { TransitEmissionsBadge } from "@/components/panels/directions/TransitRouteView";
import { TripDetailView } from "@/components/panels/transit/TripDetailView";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import { useMap } from "@/integration-api/map/MapContext";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { extractFareSummary, formatFare } from "@/lib/fareUtils";
import { legToMergedDeparture } from "./legDeparture";

export function TransitDetailsView({
  itinerary,
  isLowestCo2 = false,
  originLabel,
  destinationLabel,
  provider,
  attributions,
  originTimeZone = null,
  destinationTimeZone = null,
  onBack,
  onSelectItinerary,
}: {
  itinerary: TripItinerary;
  isLowestCo2?: boolean;
  originLabel: string;
  destinationLabel: string;
  /** Provider id (e.g. "motis", "otp") — kept for legToMergedDeparture context. */
  provider?: string;
  /** Trip-plan envelope attributions, rendered at the bottom of the details. */
  attributions?: Attribution[];
  /**
   * Set only when the origin's zone differs from the viewer's; renders the
   * departure in that zone instead of the viewer's, keeping the pair
   * internally consistent. No offset chip — see the identical prop on
   * `TransitItineraryCard`.
   */
  originTimeZone?: string | null;
  /** Set only when the trip crosses a time-zone boundary; renders the arrival in that zone with an offset chip. */
  destinationTimeZone?: string | null;
  onBack: () => void;
  onSelectItinerary?: (parent: TripItinerary, candidate: TripItinerary) => void;
}) {
  const selectedAttributions = itineraryContributors(itinerary, attributions);
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  const fmt = useDateTimeFormat();
  const units = useSettingsStore((s) => s.units);
  const [activeLegDep, setActiveLegDep] = useState<MergedDeparture | null>(null);
  const { setSelectedPlace } = usePlaceStore();
  const { selectWithEnrichment } = usePlaceEnrichment();
  const { flyTo } = useMap();

  /**
   * Open the stop a leg uses. With its source id it opens as that transit stop,
   * like a stop chosen in search, so its board treats it as the main stop.
   */
  function handleStopClick(name: string, lat: number, lng: number, stopId?: string) {
    flyTo([lng, lat], 16);
    if (stopId) {
      const stop: TransitStop = {
        id: stopId,
        name,
        lat,
        lng,
        modes: [],
        provider: parseId(stopId)?.scheme ?? "",
      };
      // Opening the place card replaces this view, so let the enrichment finish.
      selectWithEnrichment(makeSyntheticStopPlace(stop), () => resolveStopAsPlace(stop), {
        continueOnUnmount: true,
      });
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
      return;
    }
    // Without a source id the stop can only be found by name.
    void geocodeStopAsPlace({ id: "", name, lat, lng, modes: [], provider: "" }).then((place) => {
      setSelectedPlace(
        place ??
          ({
            id: `place:${name}`,
            name,
            address: name,
            coordinates: [lng, lat],
          } as Place),
      );
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    });
  }
  // Resolve each offset label before formatting the time it gates: unlike
  // these helpers, `fmt.time({ timeZone })` throws (rather than degrading)
  // for a zone id the platform doesn't recognise, so the label doubles as
  // the validity check that keeps the call below from taking the panel down.
  const originOffsetLabel = originTimeZone
    ? tzOffsetLabel(new Date(itinerary.startTime), originTimeZone)
    : null;
  const startTime = fmt.time(
    itinerary.startTime,
    originOffsetLabel ? { timeZone: originTimeZone as string } : undefined,
  );
  const destinationOffsetLabel = destinationTimeZone
    ? tzOffsetLabel(new Date(itinerary.endTime), destinationTimeZone)
    : null;
  const endTime = fmt.time(
    itinerary.endTime,
    destinationOffsetLabel ? { timeZone: destinationTimeZone as string } : undefined,
  );
  const summaryBits: string[] = [];
  if (itinerary.transfers > 0) summaryBits.push(t("transfers", { count: itinerary.transfers }));
  if (itinerary.walkDistance > 0) {
    summaryBits.push(
      t("walkDistance", { distance: formatOverviewDistance(itinerary.walkDistance, units) }),
    );
  }

  if (activeLegDep) {
    return <TripDetailView departure={activeLegDep} onBack={() => setActiveLegDep(null)} />;
  }

  return (
    <Box>
      <DirectionsDetailHeader
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        onBack={onBack}
      />
      <Divider />
      {/* Summary */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography
          variant="h6"
          component="span"
          sx={{
            fontWeight: 600,
          }}
        >
          {startTime} – {endTime}{" "}
        </Typography>
        {destinationOffsetLabel && (
          <Typography component="span" sx={{ fontSize: 11, color: "text.secondary", ml: 0.5 }}>
            {destinationOffsetLabel}
          </Typography>
        )}
        <Typography
          variant="body1"
          component="span"
          sx={{
            color: "text.secondary",
          }}
        >
          ({formatDuration(itinerary.duration, locale)})
        </Typography>
        {/* This view is an early return from the itinerary list, so the
            explanatory line the list renders below its cards never reaches
            the screen here — without it, the chip above is unexplained. Gate
            on the resolved label, matching the chip above: destinationTimeZone
            alone can be set while tzOffsetLabel fails to resolve it (a stale
            or unrecognised tzid), in which case endTime already fell back to
            the viewer's zone and this caption would otherwise claim a
            re-zoning that didn't happen. */}
        {destinationOffsetLabel && (
          <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.5, display: "block" }}>
            {t("arrivalInDestinationTime")}
          </Typography>
        )}
        {/* Leg badges summary */}
        <TransitLegChain legs={itinerary.legs} sx={{ mt: 0.75 }} />
        {summaryBits.length > 0 && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              mt: 0.75,
              display: "block",
            }}
          >
            {summaryBits.join(" · ")}
          </Typography>
        )}
        {itinerary.invalidRequirements && itinerary.invalidRequirements.length > 0 && (
          <Typography role="alert" variant="body2" sx={{ color: "error.main", mt: 1 }}>
            {t("requirementsContradicted", {
              requirements: itinerary.invalidRequirements.join(", "),
            })}
          </Typography>
        )}
        {itinerary.co2Grams !== undefined && (
          <Box sx={{ mt: summaryBits.length > 0 ? 0.75 : 1 }}>
            <TransitEmissionsBadge co2Grams={itinerary.co2Grams} isLowest={isLowestCo2} />
          </Box>
        )}
      </Box>
      <Divider />
      <TransitLegTimeline
        itinerary={itinerary}
        originLabel={originLabel}
        destinationLabel={destinationLabel}
        selectedAttributions={selectedAttributions}
        originTimeZone={originTimeZone}
        destinationTimeZone={destinationTimeZone}
        onStopClick={(place) => handleStopClick(place.name, place.lat, place.lng, place.stopId)}
        onOpenLeg={(leg) => setActiveLegDep(legToMergedDeparture(leg, provider))}
        onSelectItinerary={onSelectItinerary}
      />
      {/* Fare */}
      {(() => {
        const fareSummary = extractFareSummary(itinerary.fare);
        if (!fareSummary) return null;
        const mediaNames = [
          ...new Set(
            fareSummary.products.map((p) => p.media?.name).filter((n): n is string => Boolean(n)),
          ),
        ];
        return (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 1.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <ConfirmationNumberOutlinedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    flex: 1,
                  }}
                >
                  {t("fare")}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                  }}
                >
                  {t("fareApprox", {
                    amount: formatFare(fareSummary.amount, fareSummary.currency, locale),
                  })}
                </Typography>
              </Box>
              {fareSummary.byCategory.length > 1 && (
                <Box sx={{ mt: 0.75, display: "flex", flexDirection: "column", gap: 0.25 }}>
                  {fareSummary.byCategory.map((cat) => (
                    <Box key={cat.name} sx={{ display: "flex", justifyContent: "space-between" }}>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {cat.name}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {formatFare(cat.amount, fareSummary.currency, locale)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              )}
              {mediaNames.length > 0 && (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.disabled",
                    mt: 0.5,
                    display: "block",
                  }}
                >
                  {mediaNames.join(", ")}
                </Typography>
              )}
            </Box>
          </>
        );
      })()}
      {/* Data source attribution */}
      <AttributionStrip
        attributions={selectedAttributions}
        variant="panel-header"
        label={tc("dataSources")}
      />
    </Box>
  );
}
