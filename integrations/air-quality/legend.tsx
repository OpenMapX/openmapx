"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Pollutant } from "@openmapx/air-quality";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";

import { useAirQualityStore } from "./store";

export const CONCENTRATION_LEVELS = [
  { label: "0", color: "#00204c" },
  { label: "10", color: "#193f63" },
  { label: "25", color: "#4f5f6d" },
  { label: "50", color: "#8d8567" },
  { label: "75", color: "#c8ad53" },
  { label: "100+", color: "#fee838" },
] as const;

const POLLUTANTS: readonly Pollutant[] = ["pm25", "pm10", "o3", "no2", "so2", "co", "nh3", "no"];

const POLLUTANT_KEYS: Record<Pollutant, string> = {
  pm25: "pollutant.pm25",
  pm10: "pollutant.pm10",
  o3: "pollutant.o3",
  no2: "pollutant.no2",
  so2: "pollutant.so2",
  co: "pollutant.co",
  nh3: "pollutant.nh3",
  no: "pollutant.no",
};

function controlSx() {
  return {
    width: "100%",
    minHeight: 36,
    borderRadius: 1,
    borderColor: "divider",
    bgcolor: "background.paper",
    color: "text.primary",
    px: 1,
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  } as const;
}

export function AirQualityLegend() {
  const t = useTranslations("airQualityMap");
  const panelOpen = useAirQualityStore((state) => state.panelOpen);
  const layerVisible = useAirQualityStore((state) => state.layerVisible);
  const mode = useAirQualityStore((state) => state.mode);
  const loading = useAirQualityStore((state) => state.loading);
  const error = useAirQualityStore((state) => state.error);
  const warnings = useAirQualityStore((state) => state.warnings);
  const truncated = useAirQualityStore((state) => state.truncated);
  const hasData = useAirQualityStore((state) => state.hasData);
  const stationCount = useAirQualityStore((state) => state.stationCount);
  const setMode = useAirQualityStore((state) => state.setMode);
  const setMonitorPollutant = useAirQualityStore((state) => state.setMonitorPollutant);
  const setLayerVisible = useOverlayVisibilitySetter("air-quality");

  let statusKey: string | null = null;
  if (loading) statusKey = "status.loading";
  else if (error === "quota") statusKey = "status.quota";
  else if (error === "unavailable" && hasData) statusKey = "status.refreshFailedRetained";
  else if (error === "unavailable") statusKey = "status.unavailable";
  else if (warnings.some((warning) => warning === "stale_cache" || warning === "stale_evidence"))
    statusKey = "status.stale";
  else if (truncated || warnings.includes("quota_truncated")) statusKey = "status.truncated";
  else if (
    warnings.some((warning) => warning === "partial_providers" || warning === "policy_excluded")
  )
    statusKey = "status.partial";
  else if (hasData && stationCount === 0) statusKey = "status.empty";
  else if (hasData) statusKey = "status.stationCount";

  const pollutant = mode.kind === "monitors" ? mode.pollutant : "pm25";

  return (
    <OverlayLegend
      title={t("title")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "92vw", sm: 460 }, minWidth: 280 }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mb: 1.25 }}>
        <Box component="label">
          <Typography component="span" sx={{ display: "block", fontSize: 10, mb: 0.25 }}>
            {t("mode.label")}
          </Typography>
          <Box
            component="select"
            aria-label={t("mode.label")}
            value={mode.kind}
            onChange={(event) => setMode(event.target.value as "monitors" | "eea-raster")}
            sx={controlSx()}
          >
            <option value="monitors">{t("mode.monitors")}</option>
            <option value="eea-raster" disabled>
              {t("mode.eeaRaster")}
            </option>
          </Box>
        </Box>
        <Box component="label">
          <Typography component="span" sx={{ display: "block", fontSize: 10, mb: 0.25 }}>
            {t("pollutant.label")}
          </Typography>
          <Box
            component="select"
            aria-label={t("pollutant.label")}
            value={pollutant}
            disabled={mode.kind !== "monitors"}
            onChange={(event) => setMonitorPollutant(event.target.value as Pollutant)}
            sx={controlSx()}
          >
            {POLLUTANTS.map((item) => (
              <option key={item} value={item}>
                {t(POLLUTANT_KEYS[item])}
              </option>
            ))}
          </Box>
        </Box>
      </Box>

      <Box data-testid="air-quality-concentration-scale">
        <Box sx={{ display: "flex", gap: 0.75, justifyContent: "space-between" }}>
          {CONCENTRATION_LEVELS.map((level) => (
            <Box key={level.label} sx={{ textAlign: "center", minWidth: 32 }}>
              <Box
                data-testid={`air-quality-level-${level.label}`}
                data-color={level.color}
                aria-hidden="true"
                sx={{ height: 14, borderRadius: 0.75, bgcolor: level.color }}
              />
              <Typography sx={{ fontSize: 10 }}>{level.label}</Typography>
            </Box>
          ))}
        </Box>
        <Typography sx={{ fontSize: 10, color: "text.secondary" }}>{t("unit.ugm3")}</Typography>
      </Box>

      {statusKey && (
        <Typography role="status" sx={{ fontSize: 11, mt: 0.75, color: "text.secondary" }}>
          {statusKey === "status.stationCount"
            ? t(statusKey, { count: stationCount })
            : t(statusKey)}
        </Typography>
      )}
      <Typography sx={{ fontSize: 10, mt: 0.5, color: "text.secondary" }}>
        {t("rawConcentrationNotice")}
      </Typography>
    </OverlayLegend>
  );
}

export default AirQualityLegend;
