"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { relativeTime, useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { SEVERITY_COLORS } from "./map-layer";
import { ALL_SEVERITIES, useWeatherAlertStore } from "./store";

export function WeatherAlertLegend() {
  const t = useTranslations("weatherAlerts");
  const panelOpen = useWeatherAlertStore((s) => s.panelOpen);
  const layerVisible = useWeatherAlertStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("weather-alerts");
  const loading = useWeatherAlertStore((s) => s.loading);
  const activeSeverities = useWeatherAlertStore((s) => s.activeSeverities);
  const toggleSeverity = useWeatherAlertStore((s) => s.toggleSeverity);
  const alertCount = useWeatherAlertStore((s) => s.alertCount);
  const lastUpdated = useWeatherAlertStore((s) => s.lastUpdated);

  return (
    <OverlayLegend
      title={t("weatherAlerts")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 420 }, minWidth: 260 }}
      headerSx={{ mb: 0.5 }}
    >
      {/* Severity chips */}
      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
          {t("severity")}
        </Typography>
        <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
          {ALL_SEVERITIES.map((sev) => {
            const active = activeSeverities.has(sev);
            const color = SEVERITY_COLORS[sev] || "#6b7280";
            return (
              <Chip
                key={sev}
                label={t(sev)}
                size="small"
                variant={active ? "filled" : "outlined"}
                onClick={() => toggleSeverity(sev)}
                sx={{
                  fontSize: 11,
                  height: 24,
                  ...(active
                    ? {
                        bgcolor: color,
                        color: "#fff",
                        "&:hover": { bgcolor: color, opacity: 0.9 },
                      }
                    : {
                        borderColor: color,
                        color: color,
                      }),
                }}
                icon={
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: color,
                      ml: "4px !important",
                      mr: "-2px !important",
                      display: active ? "none" : "block",
                    }}
                  />
                }
              />
            );
          })}
        </Box>
      </Box>

      {/* Alert count + last updated */}
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
        {alertCount > 0
          ? t("alertsShowing", { count: alertCount })
          : loading
            ? t("loading")
            : t("noAlerts")}
      </Typography>

      {lastUpdated && (
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.25 }}>
          {t("lastUpdated", { time: relativeTime(Date.now() - lastUpdated) })}
        </Typography>
      )}
    </OverlayLegend>
  );
}
