"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useAirQualityStore } from "./store";

const PM25_LEVELS = [
  { value: "0", color: "#2c7bb6" },
  { value: "10", color: "#00a6ca" },
  { value: "25", color: "#00ccbc" },
  { value: "50", color: "#90eb9d" },
  { value: "75", color: "#f9d057" },
  { value: "100+", color: "#f29e2e" },
];

export function AirQualityLegend() {
  const t = useTranslations("airQuality");
  const panelOpen = useAirQualityStore((s) => s.panelOpen);
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const loading = useAirQualityStore((s) => s.loading);
  const error = useAirQualityStore((s) => s.error);
  const setLayerVisible = useOverlayVisibilitySetter("air-quality");

  return (
    <OverlayLegend
      title={t("pm25Concentration")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ whiteSpace: "nowrap" }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5 }}>
        {PM25_LEVELS.map((level) => (
          <Box
            key={level.value}
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
          >
            <Box sx={{ width: 32, height: 16, borderRadius: "3px", bgcolor: level.color }} />
            <Typography
              sx={{ fontSize: 10, textAlign: "center", lineHeight: 1.25, whiteSpace: "pre-line" }}
            >
              {level.value}
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography sx={{ fontSize: 10, mt: 0.5, color: "text.secondary" }}>
        {t("microgramsPerCubicMeter")}
      </Typography>
      {error ? (
        <Typography role="status" sx={{ fontSize: 11, mt: 0.75, color: "warning.main" }}>
          {t(
            error === "quota"
              ? "quotaUnavailable"
              : error === "coverage"
                ? "coverageLimited"
                : "temporarilyUnavailable",
          )}
        </Typography>
      ) : null}
    </OverlayLegend>
  );
}
