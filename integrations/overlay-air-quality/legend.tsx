"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useAirQualityStore } from "./store";

const AQI_LEVEL_KEYS = [
  { key: "good" as const, color: "#009966" },
  { key: "moderate" as const, color: "#ffde33" },
  { key: "unhealthyForSome" as const, color: "#ff9933" },
  { key: "unhealthy" as const, color: "#cc0033" },
  { key: "veryUnhealthy" as const, color: "#660099" },
  { key: "hazardous" as const, color: "#7e0023" },
];

export function AirQualityLegend() {
  const t = useTranslations("airQuality");
  const panelOpen = useAirQualityStore((s) => s.panelOpen);
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const loading = useAirQualityStore((s) => s.loading);
  const setLayerVisible = useOverlayVisibilitySetter("air-quality");

  return (
    <OverlayLegend
      title={t("airQualityIndex")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ whiteSpace: "nowrap" }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5 }}>
        {AQI_LEVEL_KEYS.map((level) => (
          <Box
            key={level.key}
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
          >
            <Box sx={{ width: 32, height: 16, borderRadius: "3px", bgcolor: level.color }} />
            <Typography
              sx={{ fontSize: 10, textAlign: "center", lineHeight: 1.25, whiteSpace: "pre-line" }}
            >
              {t(level.key)}
            </Typography>
          </Box>
        ))}
      </Box>
    </OverlayLegend>
  );
}
