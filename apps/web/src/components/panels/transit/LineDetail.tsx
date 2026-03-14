"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { MergedRoute, Place, TransitRoute, TransitStop } from "@openmapx/core";
import {
  MODE_COLORS,
  resolveProvider,
  useLinkedTransitStops,
  useProviders,
  useRouteAlerts,
  useRouteStops,
  useTransitRoute,
} from "@openmapx/core";
import { useMemo } from "react";
import { PRIMARY_BLUE } from "@/lib/theme";
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
  const { data: routeData, isLoading: routeLoading } = useTransitRoute(routeId);
  // Fall back to the already-fetched hint so the header is never empty.
  // routeData is TransitRoute (no providers), routeHint is MergedRoute (has providers).
  const route: (TransitRoute & { providers?: string[] }) | null = routeData ?? routeHint ?? null;
  const providersList = routeHint?.providers ?? (route as MergedRoute)?.providers ?? [];

  // Derive a hint stop for providers without a route-stops endpoint.
  // Pick a stop from the same provider as the route.
  const { data: linkedStops } = useLinkedTransitStops(place ?? null);
  const hintStopId = useMemo(() => {
    if (!linkedStops?.length) return undefined;
    const provider = providersList[0];
    if (provider) {
      const match = linkedStops.find((s) => s.provider === provider);
      if (match) return match.id;
    }
    return linkedStops[0].id;
  }, [linkedStops, providersList]);

  const { data: stops, isLoading: stopsLoading } = useRouteStops(routeId, hintStopId);
  const { data: alerts } = useRouteAlerts(routeId);
  const { data: providers } = useProviders();

  const lineColor = route?.color
    ? `#${route.color.replace("#", "")}`
    : route?.mode
      ? MODE_COLORS[route.mode]
      : PRIMARY_BLUE;

  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          pt: clearSearchBar ? { xs: 1.5, sm: "72px" } : 1.5,
          pb: 1.5,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <IconButton size="small" onClick={onBack} aria-label="Back">
          <ArrowBackIcon />
        </IconButton>
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
            <Typography variant="subtitle1" fontWeight={600} noWrap>
              {route.longName}
            </Typography>
          </Box>
        ) : null}
      </Box>

      {/* Operator */}
      {route?.operatorName && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ px: 2, pt: 1, display: "block" }}
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
          Stops
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
                      bgcolor: isCurrent ? lineColor : "#fff",
                      border: `3px solid ${lineColor}`,
                      zIndex: 1,
                    }}
                  />
                  <Typography
                    variant="body2"
                    fontWeight={isCurrent ? 700 : 400}
                    color={isCurrent ? "text.primary" : "text.secondary"}
                  >
                    {s.name}
                  </Typography>
                  {s.platformCode && (
                    <Typography variant="caption" color="text.disabled">
                      Pl. {s.platformCode}
                    </Typography>
                  )}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Stop data not available.
          </Typography>
        )}
      </Box>

      {/* Attribution */}
      {route && providersList.length > 0 && (
        <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>
            Data:{" "}
            {providersList.map((p, i) => {
              const attr = resolveProvider(providers, p);
              return (
                <span key={p}>
                  {i > 0 && " · "}
                  {attr.url ? (
                    <Link
                      href={attr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      color="inherit"
                      underline="hover"
                    >
                      {attr.label}
                    </Link>
                  ) : (
                    attr.label
                  )}
                </span>
              );
            })}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
