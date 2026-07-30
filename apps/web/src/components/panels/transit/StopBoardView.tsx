"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Skeleton from "@mui/material/Skeleton";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useArrivals, useDepartures, useStopAlerts } from "@openmapx/core";
import type { Departure, MergedDeparture } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { AlertsBanner } from "./AlertsBanner";
import { DepartureRow } from "./DepartureRow";

interface StopBoardViewProps {
  stopId: string;
  title: string;
  onBack: () => void;
  clearSearchBar?: boolean;
  onDepartureClick: (departure: MergedDeparture) => void;
}

function toMergedDeparture(departure: Departure): MergedDeparture {
  // Prefer the explicit provenance instance: opaque route ids (e.g. MOTIS
  // ms:ln references) carry a codec prefix, not the originating provider.
  const provider = departure.provenance?.instance ?? (departure.route.id.split(":")[0] || "entur");
  return {
    ...departure,
    providers: [provider],
  };
}

export function StopBoardView({
  stopId,
  title,
  onBack,
  clearSearchBar = false,
  onDepartureClick,
}: StopBoardViewProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const [tab, setTab] = useState<"departures" | "arrivals">("departures");
  const departuresQuery = useDepartures(stopId);
  const { data: departures, isLoading: departuresLoading } = departuresQuery;
  const arrivalsQuery = useArrivals(stopId);
  const { data: arrivals, isLoading: arrivalsLoading } = arrivalsQuery;
  const alertsQuery = useStopAlerts(stopId);
  const { data: alerts } = alertsQuery;
  const mergedAttributions = useAttributionFromHooks(departuresQuery, arrivalsQuery, alertsQuery);

  const alertRouteIds = useMemo(
    () =>
      new Set(
        (alerts ?? [])
          .filter((alert) => alert.severity === "severe" || alert.severity === "critical")
          .flatMap((alert) => alert.affectedRouteIds),
      ),
    [alerts],
  );

  const items = tab === "departures" ? departures : arrivals;
  const isLoading = tab === "departures" ? departuresLoading : arrivalsLoading;
  const hasArrivals = Boolean(arrivals?.length);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: { xs: "auto", sm: "100dvh" },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1,
          pb: 1,
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
            {title}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t(tab)}
          </Typography>
        </Box>
      </Box>
      {hasArrivals && (
        <Box sx={{ px: 1.5, pt: 1, pb: 1 }}>
          <ToggleButtonGroup
            value={tab}
            exclusive
            onChange={(_, value) => value && setTab(value)}
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
      <Box sx={{ flex: 1, overflowY: { xs: "visible", sm: "auto" } }}>
        {alerts && alerts.length > 0 && (
          <Box sx={{ px: 1.5, pt: 1, pb: 0.5 }}>
            <AlertsBanner alerts={alerts} />
          </Box>
        )}
        {isLoading ? (
          <Box>
            {[1, 2, 3, 4, 5].map((index) => (
              <Box
                key={index}
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
        ) : items && items.length > 0 ? (
          <Box>
            {items.map((departure) => (
              <Box key={`${departure.tripId}-${departure.scheduledAt}-${departure.route.id}`}>
                <DepartureRow
                  departure={departure}
                  showPlatform
                  onClick={(item) => onDepartureClick(toMergedDeparture(item))}
                  hasAlert={alertRouteIds.has(departure.route.id)}
                />
              </Box>
            ))}
          </Box>
        ) : (
          <Box sx={{ px: 2, py: 3, textAlign: "center" }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("noDeparturesGeneric", { tab: t(tab) })}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
