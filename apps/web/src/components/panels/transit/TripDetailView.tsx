"use client";

import AirlineSeatReclineNormalIcon from "@mui/icons-material/AirlineSeatReclineNormal";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { MergedDeparture, TripRemark } from "@openmapx/core";
import {
  MODE_COLORS,
  resolveProvider,
  useProviders,
  useRouteAlerts,
  useVehicleJourney,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { formatTime } from "@/lib/formatTime";
import { TEAL } from "@/lib/theme";
import { AlertsBanner } from "./AlertsBanner";
import { RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

interface TripDetailViewProps {
  departure: MergedDeparture;
  onBack: () => void;
  clearSearchBar?: boolean;
}

import { OCCUPANCY_COLOR, OCCUPANCY_KEY } from "@/lib/transitOccupancy";

export function TripDetailView({ departure, onBack, clearSearchBar = false }: TripDetailViewProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const locale = useLocale();
  const {
    data: journey,
    isLoading,
    isError,
    refetch,
  } = useVehicleJourney(departure.tripId || null, departure.tripIds);
  const { data: alerts } = useRouteAlerts(departure.route.id);
  const { data: providers } = useProviders();

  const isDelayed = (departure.delaySeconds ?? 0) > 60;
  const isCanceled = departure.canceled === true;
  const lineColor = departure.route.color
    ? `#${departure.route.color.replace("#", "")}`
    : (MODE_COLORS[departure.route.mode] ?? TEAL);

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
        <IconButton size="small" onClick={onBack} aria-label={tc("back")}>
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            <Typography variant="subtitle1" fontWeight={600} noWrap sx={{ flex: 1 }}>
              {departure.headsign}
            </Typography>
            {departure.occupancy && (
              <Tooltip title={t(OCCUPANCY_KEY[departure.occupancy])}>
                <AirlineSeatReclineNormalIcon
                  sx={{ fontSize: 18, color: OCCUPANCY_COLOR[departure.occupancy] }}
                />
              </Tooltip>
            )}
          </Box>
          <Box
            sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.25, flexWrap: "wrap" }}
          >
            <Typography
              variant="body2"
              sx={{
                textDecoration: isCanceled || isDelayed ? "line-through" : "none",
                color: isCanceled ? "text.disabled" : "text.secondary",
              }}
            >
              {formatTime(departure.scheduledAt, locale)}
            </Typography>
            {isDelayed && !isCanceled && departure.expectedAt && (
              <Typography variant="body2" fontWeight={600} color="error.main">
                {formatTime(departure.expectedAt, locale)}
              </Typography>
            )}
            {isCanceled && (
              <Typography variant="caption" color="error.main" fontWeight={600}>
                {t("canceled")}
              </Typography>
            )}
            {departure.platform && (
              <Typography variant="body2" color="text.secondary">
                · {t("platform")} {departure.platform}
              </Typography>
            )}
          </Box>
        </Box>
      </Box>

      {/* Route alerts */}
      {alerts && alerts.length > 0 && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <AlertsBanner alerts={alerts} />
        </Box>
      )}

      {/* Trip remarks (all of them — list view shows only the top one) */}
      {departure.remarks && departure.remarks.length > 0 && (
        <Box sx={{ px: 2, pt: 1, display: "flex", flexDirection: "column", gap: 0.5 }}>
          {departure.remarks.map((remark: TripRemark, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static ordered remark list
            <RemarkChip key={i} remark={remark} />
          ))}
        </Box>
      )}

      {/* Stop sequence */}
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="subtitle2" gutterBottom>
          {t("stops")}
        </Typography>
        {isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
            <CircularProgress size={20} sx={{ color: TEAL }} />
          </Box>
        ) : isError ? (
          <Box sx={{ textAlign: "center", py: 2 }}>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {t("couldNotLoadStops")}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => refetch()}
              sx={{
                textTransform: "none",
                borderColor: TEAL,
                color: TEAL,
                "&:hover": { borderColor: "var(--omx-teal-hover)", bgcolor: "var(--omx-hover-bg)" },
              }}
            >
              {tc("retry")}
            </Button>
          </Box>
        ) : journey ? (
          <Box sx={{ position: "relative", pl: 2.5 }}>
            {/* Vertical timeline line */}
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
            {journey.stops.map((stop, i) => {
              // Show realtime (delay-adjusted) time when available, fall back to scheduled
              const time =
                stop.expectedDeparture ??
                stop.expectedArrival ??
                stop.scheduledDeparture ??
                stop.scheduledArrival;
              const timeStr = time ? formatTime(time, locale) : "";
              // Only treat as realtime when delaySeconds is explicitly provided (not undefined)
              const isRealtime = stop.delaySeconds !== undefined;
              const delaySec = stop.delaySeconds ?? 0;
              const delayMin = Math.round(delaySec / 60);
              const isCanceledStop = stop.canceled ?? false;
              const isDeparted = stop.departed ?? false;

              return (
                <Box
                  // biome-ignore lint/suspicious/noArrayIndexKey: stops have no stable key
                  key={i}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    py: 0.75,
                    opacity: isDeparted ? 0.45 : 1,
                    position: "relative",
                  }}
                >
                  {/* Stop dot */}
                  <Box
                    sx={{
                      position: "absolute",
                      left: -16,
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      bgcolor: isCanceledStop
                        ? "error.main"
                        : isDeparted
                          ? "text.disabled"
                          : "background.paper",
                      border: `2.5px solid ${isCanceledStop ? "#f44336" : isDeparted ? "#9e9e9e" : lineColor}`,
                      zIndex: 1,
                    }}
                  />
                  {/* Time + delay */}
                  <Box sx={{ width: 62, textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontVariantNumeric: "tabular-nums",
                        color: delayMin > 0 ? "error.main" : "text.primary",
                      }}
                    >
                      {timeStr}
                    </Typography>
                    {delayMin > 0 && !isCanceledStop && (
                      <Typography
                        variant="caption"
                        color="error.main"
                        sx={{ display: "block", fontSize: "0.6rem", fontWeight: 600 }}
                      >
                        +{delayMin} min
                      </Typography>
                    )}
                  </Box>
                  {/* Name + platform */}
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="body2"
                      sx={{ textDecoration: isCanceledStop ? "line-through" : "none" }}
                      noWrap
                    >
                      {stop.name}
                    </Typography>
                  </Box>
                  {stop.platform && (
                    <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
                      {t("platform")} {stop.platform}
                    </Typography>
                  )}
                  {!isDeparted && !isCanceledStop && (
                    <Box
                      sx={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        bgcolor: isRealtime ? "#4caf50" : "#bdbdbd",
                        flexShrink: 0,
                      }}
                    />
                  )}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {departure.tripId ? t("stopDetailsLater") : t("stopSequenceNotAvailable")}
          </Typography>
        )}
      </Box>

      {/* Attribution */}
      {departure.providers.length > 0 && (
        <Box sx={{ px: 2, py: 1, borderTop: "1px solid", borderColor: "divider" }}>
          <Typography variant="caption" color="text.disabled" sx={{ fontSize: "0.65rem" }}>
            {tc("data")}:{" "}
            {departure.providers.map((p, i) => {
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
                  {attr.license &&
                    (attr.licenseUrl ? (
                      <>
                        {" ("}
                        <Link
                          href={attr.licenseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          color="inherit"
                          underline="hover"
                        >
                          {attr.license}
                        </Link>
                        {")"}
                      </>
                    ) : (
                      ` (${attr.license})`
                    ))}
                </span>
              );
            })}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
