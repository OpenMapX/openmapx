"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
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
  const panelOpen = useEnvironmentStore((s) => s.panelOpen);
  const layerVisible = useEnvironmentStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("environment");
  const loading = useEnvironmentStore((s) => s.loading);
  const sensorType = useEnvironmentStore((s) => s.sensorType);
  const setSensorType = useEnvironmentStore((s) => s.setSensorType);
  const stationCount = useEnvironmentStore((s) => s.stationCount);

  const gradient = GRADIENTS[sensorType];
  const gradientCss = `linear-gradient(to right, ${gradient.colors.join(", ")})`;

  return (
    <OverlayLegend
      title={t("environmentalSensors")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 420 }, minWidth: 260 }}
      headerSx={{ mb: 0.5 }}
    >
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
    </OverlayLegend>
  );
}
