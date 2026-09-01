"use client";

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  routeColor,
  useLinkedTransitStops,
  useRouteAlerts,
  useRouteStops,
  useTransitRoute,
} from "@openmapx/core";
import type { MergedRoute, TransitRoute, TransitStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { useAttributionFromHooks } from "@/integration-api/overlay/useAttributionFromHooks";
import { PRIMARY_BLUE } from "@/integration-api/runtime/theme";
import { PanelDetailHeader } from "../shared/PanelDetailHeader";
import { AlertsBanner } from "./AlertsBanner";
import { RouteBadge } from "./RouteBadge";

interface LineDetailProps {
  routeId: string;
  /** Already-fetched route data — used immediately for the header without a loading flash. */
  routeHint?: MergedRoute;
  /** Place the user came from — used to derive a hint stop for the stop sequence query. */
  place?: Place;
  /** When omitted, no stop is highlighted and stop clicks are no-ops. */
  currentStop?: TransitStop;
  onBack: () => void;
  /** Requires `currentStop` to be provided — no-op without it. */
  onSelectStop?: (stop: TransitStop) => void;
  clearSearchBar?: boolean;
}

export function LineDetail({
  routeId,
  routeHint,
  place,
  currentStop,
  onBack,
  onSelectStop,
  clearSearchBar = false,
}: LineDetailProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const routeQuery = useTransitRoute(routeId);
  const { data: routeData, isLoading: routeLoading } = routeQuery;
  // Fall back to the already-fetched hint so the header is never empty.
  // routeData is TransitRoute (no providers), routeHint is MergedRoute (has providers).
  const route: (TransitRoute & { providers?: string[] }) | null = routeData ?? routeHint ?? null;
  const providersList = routeHint?.providers ?? (route as MergedRoute)?.providers ?? [];

  // Derive a hint stop for providers without a route-stops endpoint.
  // Prefer route-specific hint from backend, otherwise pick a stop from the
  // same provider as the route.
  const linkedStopsQuery = useLinkedTransitStops(place ?? null);
  const { data: linkedStops } = linkedStopsQuery;
  const hintStopId = useMemo(() => {
    if (routeHint?.hintStopId) return routeHint.hintStopId;
    if (!linkedStops?.length) return undefined;
    const provider = providersList[0];
    if (provider) {
      const match = linkedStops.find((s) => s.provider === provider);
      if (match) return match.id;
    }
    return linkedStops[0].id;
  }, [linkedStops, providersList, routeHint?.hintStopId]);

  const stopsQuery = useRouteStops(routeId, hintStopId);
  const { data: stops, isLoading: stopsLoading } = stopsQuery;
  const alertsQuery = useRouteAlerts(routeId);
  const { data: alerts } = alertsQuery;
  // Attribute only the line's displayed data (route, stop sequence, alerts).
  // linkedStopsQuery is plumbing for hintStopId and carries the unfiltered
  // stop-search fan-out, so it is intentionally excluded here.
  const mergedAttributions = useAttributionFromHooks(routeQuery, stopsQuery, alertsQuery);

  const lineColor = routeColor(route, PRIMARY_BLUE);

  return (
    <Box>
      {/* Header */}
      <PanelDetailHeader onBack={onBack} clearSearchBar={clearSearchBar}>
        {routeLoading && !routeHint ? (
          <Skeleton width={120} height={28} />
        ) : route ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <RouteBadge
              shortName={route.shortName}
              color={route.color}
              textColor={route.textColor}
              mode={route.mode}
              size="medium"
            />
            <Typography
              variant="subtitle1"
              noWrap
              sx={{
                fontWeight: 600,
              }}
            >
              {route.longName}
            </Typography>
          </Box>
        ) : null}
      </PanelDetailHeader>
      {/* Operator */}
      {route?.operatorName && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            px: 2,
            pt: 1,
            display: "block",
          }}
        >
          {route.operatorName}
        </Typography>
      )}
      {/* Alerts */}
      {alerts && alerts.length > 0 && (
        <Box sx={{ px: 2, pt: 1 }}>
          <AlertsBanner alerts={alerts} />
        </Box>
      )}
      {/* Stop sequence */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="subtitle2" gutterBottom>
          {t("stops")}
        </Typography>
        {stopsLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
            <Skeleton key={i} height={36} />
          ))
        ) : stops && stops.length > 0 ? (
          <Box sx={{ position: "relative", pl: 2.5 }}>
            {/* Vertical connecting line */}
            <Box
              sx={{
                position: "absolute",
                left: 8,
                top: 8,
                bottom: 8,
                width: 3,
                bgcolor: lineColor,
                borderRadius: 1,
              }}
            />
            {stops.map((s, idx) => {
              const isCurrent = currentStop ? s.id === currentStop.id : false;
              return (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: stops may contain the same stop multiple times (circular routes)
                  key={`${s.id}-${idx}`}
                  onClick={() => {
                    if (!onSelectStop || !currentStop) return;
                    onSelectStop({
                      id: s.id,
                      name: s.name,
                      lat: s.lat,
                      lng: s.lng,
                      modes: route?.mode ? [route.mode] : currentStop.modes,
                      provider: providersList[0] ?? currentStop.provider,
                    });
                  }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    py: 0.75,
                    cursor: onSelectStop && currentStop ? "pointer" : "default",
                    position: "relative",
                    "&:hover": { bgcolor: "action.hover" },
                    borderRadius: 1,
                  }}
                >
                  {/* Stop dot */}
                  <Box
                    sx={{
                      position: "absolute",
                      left: -16,
                      width: isCurrent ? 14 : 10,
                      height: isCurrent ? 14 : 10,
                      borderRadius: "50%",
                      bgcolor: isCurrent ? lineColor : "background.paper",
                      border: `3px solid ${lineColor}`,
                      zIndex: 1,
                    }}
                  />
                  <Typography
                    variant="body2"
                    color={isCurrent ? "text.primary" : "text.secondary"}
                    sx={{
                      fontWeight: isCurrent ? 700 : 400,
                    }}
                  >
                    {s.name}
                  </Typography>
                  {s.platformCode && (
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.disabled",
                      }}
                    >
                      {t("platform")} {s.platformCode}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("stopDataNotAvailable")}
          </Typography>
        )}
      </Box>
      {/* Attribution */}
      <AttributionStrip
        attributions={mergedAttributions}
        variant="panel-header"
        label={tc("dataSources")}
        maxVisible={3}
      />
    </Box>
  );
}
