"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution, useIntegrationRegistry } from "@openmapx/core";
import { useTranslations } from "next-intl";
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
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-air-quality");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const panelOpen = useAirQualityStore((s) => s.panelOpen);
  const layerVisible = useAirQualityStore((s) => s.layerVisible);
  const loading = useAirQualityStore((s) => s.loading);
  const setLayerVisible = useAirQualityStore((s) => s.setLayerVisible);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {loading && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("airQualityIndex")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>

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

      {/* Attribution (from manifest dataSources, trusted static config) */}
      {attributionHtml && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 1 }}
          dangerouslySetInnerHTML={{ __html: attributionHtml }}
        />
      )}
    </Paper>
  );
}
