"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { type EnvironmentSensorType, useEnvironmentStore } from "./store";

interface GradientDef {
  colors: string[];
  labels: string[];
}

const GRADIENTS: Record<EnvironmentSensorType, GradientDef> = {
  temperature: {
    colors: ["#2196F3", "#4FC3F7", "#66BB6A", "#FFA726", "#E53935"],
    labels: ["-10°C", "0°C", "15°C", "25°C", "35°C"],
  },
  humidity: {
    colors: ["#FDD835", "#66BB6A", "#1E88E5"],
    labels: ["20%", "50%", "90%"],
  },
  pm25: {
    colors: ["#66BB6A", "#FDD835", "#FF9800", "#E53935"],
    labels: ["0", "35", "75", "150+"],
  },
  pm10: {
    colors: ["#66BB6A", "#FDD835", "#FF9800", "#E53935"],
    labels: ["0", "50", "100", "250+"],
  },
  pressure: {
    colors: ["#42A5F5", "#66BB6A", "#A5D6A7", "#FFA726", "#FF7043"],
    labels: ["980", "1000", "1013", "1030", "1040+"],
  },
  uv: {
    colors: ["#66BB6A", "#FDD835", "#FF9800", "#E53935", "#7B1FA2"],
    labels: ["0", "3", "6", "8", "11+"],
  },
  noise: {
    colors: ["#66BB6A", "#FDD835", "#FF9800", "#E53935"],
    labels: ["30 dB", "50 dB", "70 dB", "85+ dB"],
  },
};

const SENSOR_CHIPS: { key: EnvironmentSensorType }[] = [
  { key: "temperature" },
  { key: "humidity" },
  { key: "pm25" },
  { key: "pm10" },
  { key: "pressure" },
  { key: "uv" },
  { key: "noise" },
];

export function EnvironmentLegend() {
  const t = useTranslations("environment");
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-environment");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const panelOpen = useEnvironmentStore((s) => s.panelOpen);
  const layerVisible = useEnvironmentStore((s) => s.layerVisible);
  const setLayerVisible = useEnvironmentStore((s) => s.setLayerVisible);
  const loading = useEnvironmentStore((s) => s.loading);
  const sensorType = useEnvironmentStore((s) => s.sensorType);
  const setSensorType = useEnvironmentStore((s) => s.setSensorType);
  const stationCount = useEnvironmentStore((s) => s.stationCount);

  if (!panelOpen) return null;

  const gradient = GRADIENTS[sensorType];
  const gradientCss = `linear-gradient(to right, ${gradient.colors.join(", ")})`;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        overflow: "hidden",
        maxWidth: { xs: "90vw", sm: 420 },
        minWidth: 260,
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
      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.5 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("environmentalSensors")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>
      {/* Sensor type chips */}
      <Box
        sx={{
          display: "flex",
          gap: 0.75,
          flexWrap: { xs: "nowrap", sm: "wrap" },
          overflowX: { xs: "auto", sm: "visible" },
          mb: 1.5,
          pb: 0.5,
          "&::-webkit-scrollbar": { height: 0 },
        }}
      >
        {SENSOR_CHIPS.map(({ key }) => (
          <Chip
            key={key}
            label={t(key)}
            size="small"
            variant={sensorType === key ? "filled" : "outlined"}
            color={sensorType === key ? "primary" : "default"}
            onClick={() => setSensorType(key)}
            sx={{ fontSize: 12 }}
          />
        ))}
      </Box>
      {/* Gradient bar */}
      <Box sx={{ mb: 0.75 }}>
        <Box
          sx={{
            height: 10,
            borderRadius: "4px",
            background: gradientCss,
          }}
        />
        <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.25 }}>
          {gradient.labels.map((label) => (
            <Typography key={label} sx={{ fontSize: 10, color: "text.secondary" }}>
              {label}
            </Typography>
          ))}
        </Box>
      </Box>
      {/* Station count */}
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
        {stationCount > 0
          ? t("stationsInView", { count: stationCount })
          : loading
            ? t("loading")
            : t("noStations")}
      </Typography>
      {/* Attribution (from manifest dataSources, trusted HTML) */}
      {attributionHtml && (
        <Typography
          variant="caption"
          dangerouslySetInnerHTML={{ __html: attributionHtml }}
          sx={{
            color: "text.secondary",
            mt: 0.5,
            display: "block",
            fontSize: 10.5,
          }}
        />
      )}
    </Paper>
  );
}
