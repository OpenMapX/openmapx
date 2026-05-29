"use client";

import AirlineSeatReclineNormalIcon from "@mui/icons-material/AirlineSeatReclineNormal";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { MODE_COLORS, useRouteAlerts, useVehicleJourney } from "@openmapx/core";
import type { MergedDeparture, TripRemark } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { formatTime } from "@/lib/formatTime";
import { TEAL } from "@/lib/theme";
import { OCCUPANCY_COLOR, OCCUPANCY_KEY } from "@/lib/transitOccupancy";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { PanelDetailHeader } from "../shared/PanelDetailHeader";
import { AlertsBanner } from "./AlertsBanner";
import { RemarkChip } from "./RemarkChip";
import { RouteBadge } from "./RouteBadge";

interface TripDetailViewProps {
  departure: MergedDeparture;
  onBack: () => void;
  clearSearchBar?: boolean;
}

export function TripDetailView({ departure, onBack, clearSearchBar = false }: TripDetailViewProps) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  const locale = useLocale();
  const journeyQuery = useVehicleJourney(departure.tripId || null, departure.tripIds);
  const { data: journey, isLoading, isError, refetch } = journeyQuery;
  const alertsQuery = useRouteAlerts(departure.route.id);
  const { data: alerts } = alertsQuery;
  const mergedAttributions = useAttributionFromHooks(journeyQuery, alertsQuery);

  const isDelayed = (departure.delaySeconds ?? 0) > 60;
  const isCanceled = departure.canceled === true;
  const lineColor = departure.route.color
    ? `#${departure.route.color.replace("#", "")}`
    : (MODE_COLORS[departure.route.mode] ?? TEAL);
  const serviceInfo = journey?.serviceInfo;
  const formationDetails = journey?.formationDetails;

  return (
    <Box>
      {/* Header */}
      <PanelDetailHeader onBack={onBack} clearSearchBar={clearSearchBar}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            <RouteBadge
              shortName={departure.route.shortName}
              color={departure.route.color}
              mode={departure.route.mode}
            />
            <Typography
              variant="subtitle1"
              noWrap
              sx={{
                fontWeight: 600,
                flex: 1,
              }}
            >
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
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: "error.main",
                }}
              >
                {formatTime(departure.expectedAt, locale)}
              </Typography>
            )}
            {isCanceled && (
              <Typography
                variant="caption"
                sx={{
                  color: "error.main",
                  fontWeight: 600,
                }}
              >
                {t("canceled")}
              </Typography>
            )}
            {departure.platform && (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                · {t("platform")} {departure.platform}
              </Typography>
            )}
          </Box>
        </Box>
      </PanelDetailHeader>
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
      {(serviceInfo || formationDetails) && (
        <Box sx={{ px: 2, pt: 1.5, display: "flex", flexDirection: "column", gap: 1.5 }}>
          {serviceInfo && (
            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 2,
                p: 1.5,
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                gap: 1,
              }}
            >
              {serviceInfo.operatorName && (
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("operator")}
                  </Typography>
                  <Typography variant="body2">{serviceInfo.operatorName}</Typography>
                </Box>
              )}
              {serviceInfo.trainNumber && (
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("trainNumber")}
                  </Typography>
                  <Typography variant="body2">{serviceInfo.trainNumber}</Typography>
                </Box>
              )}
              {serviceInfo.operatorParticipantRef && (
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("operatorCode")}
                  </Typography>
                  <Typography variant="body2">{serviceInfo.operatorParticipantRef}</Typography>
                </Box>
              )}
              {serviceInfo.occupancySource === "opentransportdata.swiss/occupancy-forecast" && (
                <Box>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {t("occupancy")}
                  </Typography>
                  <Typography variant="body2">{t("occupancyForecast")}</Typography>
                </Box>
              )}
            </Box>
          )}

          {formationDetails && (
            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 2,
                p: 1.5,
                display: "flex",
                flexDirection: "column",
                gap: 1.25,
              }}
            >
              <Typography variant="subtitle2">{t("formation")}</Typography>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                  gap: 1,
                }}
              >
                {formationDetails.shortFormation && (
                  <Box>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("formationShort")}
                    </Typography>
                    <Typography variant="body2">{formationDetails.shortFormation}</Typography>
                  </Box>
                )}
                {formationDetails.vehicleCount != null && (
                  <Box>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("vehicleCount")}
                    </Typography>
                    <Typography variant="body2">{formationDetails.vehicleCount}</Typography>
                  </Box>
                )}
                {formationDetails.seats != null && (
                  <Box>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("seats")}
                    </Typography>
                    <Typography variant="body2">{formationDetails.seats}</Typography>
                  </Box>
                )}
                {formationDetails.operatorCode && (
                  <Box>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("operatorCode")}
                    </Typography>
                    <Typography variant="body2">{formationDetails.operatorCode}</Typography>
                  </Box>
                )}
              </Box>

              {formationDetails.vehicles?.length ? (
                <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {formationDetails.vehicles.map((vehicle, index) => (
                    <Box
                      key={vehicle.id ?? index}
                      sx={{
                        borderTop: "1px solid",
                        borderColor: "divider",
                        pt: 1,
                        display: "flex",
                        flexDirection: "column",
                        gap: 0.5,
                      }}
                    >
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: 600,
                        }}
                      >
                        {vehicle.typeCode || vehicle.typeName || t("vehicle")}{" "}
                        {vehicle.order != null ? `#${vehicle.order}` : ""}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {[
                          vehicle.seatsFirstClass != null
                            ? `${vehicle.seatsFirstClass} ${t("firstClassSeats")}`
                            : null,
                          vehicle.seatsSecondClass != null
                            ? `${vehicle.seatsSecondClass} ${t("secondClassSeats")}`
                            : null,
                          vehicle.bikeSpaces != null
                            ? `${vehicle.bikeSpaces} ${t("bikeSpaces")}`
                            : null,
                          vehicle.wheelchairSpaces != null
                            ? `${vehicle.wheelchairSpaces} ${t("wheelchairSpaces")}`
                            : null,
                          vehicle.hasAirConditioning ? t("airConditioning") : null,
                          vehicle.hasLowFloorAccess ? t("lowFloorAccess") : null,
                          vehicle.hasToilet ? t("toilet") : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              ) : null}
            </Box>
          )}
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
            <Typography
              variant="body2"
              gutterBottom
              sx={{
                color: "text.secondary",
              }}
            >
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
                        sx={{
                          color: "error.main",
                          display: "block",
                          fontSize: "0.6rem",
                          fontWeight: 600,
                        }}
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
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.disabled",
                        flexShrink: 0,
                      }}
                    >
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
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            {departure.tripId ? t("stopDetailsLater") : t("stopSequenceNotAvailable")}
          </Typography>
        )}
      </Box>
      {/* Attribution */}
      <AttributionStrip
        attributions={mergedAttributions}
        variant="panel-header"
        label={tc("dataSources")}
      />
    </Box>
  );
}
