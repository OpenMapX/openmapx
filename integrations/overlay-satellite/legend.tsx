"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useEnv } from "@/lib/EnvProvider";
import { GIBS_LAYERS, today, useSatelliteStore, yesterday } from "./store";

export function SatelliteLegend() {
  const t = useTranslations("satelliteImagery");
  const env = useEnv();
  const panelOpen = useSatelliteStore((s) => s.panelOpen);
  const layerVisible = useSatelliteStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("satellite");
  const activeLayer = useSatelliteStore((s) => s.activeLayer);
  const setActiveLayer = useSatelliteStore((s) => s.setActiveLayer);
  const date = useSatelliteStore((s) => s.date);
  const setDate = useSatelliteStore((s) => s.setDate);
  const opacity = useSatelliteStore((s) => s.opacity);
  const setOpacity = useSatelliteStore((s) => s.setOpacity);
  const capabilities = useSatelliteStore((s) => s.capabilities);

  const layerCap = capabilities?.[activeLayer];
  const maxDate = layerCap?.defaultDate ?? today();
  const minDate = layerCap?.startDate ?? "2000-01-01";
  const todayAvailable = maxDate === today();
  const yesterdayInRange = yesterday() >= minDate && yesterday() <= maxDate;

  return (
    <OverlayLegend
      title={t("satelliteImagery")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 420 }, minWidth: 260 }}
      headerSx={{ mb: 1 }}
    >
      {/* Layer picker */}
      <Box sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
          {t("layer")}
        </Typography>
        <Box
          sx={{
            display: "flex",
            gap: 0.75,
            flexWrap: { xs: "nowrap", sm: "wrap" },
            overflowX: { xs: "auto", sm: "visible" },
            pb: 0.5,
            "&::-webkit-scrollbar": { height: 0 },
          }}
        >
          {GIBS_LAYERS.map((layer) => (
            <Chip
              key={layer.id}
              label={t(layer.labelKey)}
              size="small"
              variant={activeLayer === layer.id ? "filled" : "outlined"}
              color={activeLayer === layer.id ? "primary" : "default"}
              onClick={() => setActiveLayer(layer.id)}
              sx={{ fontSize: 11 }}
            />
          ))}
        </Box>
      </Box>
      {/* Date controls */}
      <Box sx={{ mb: 1.5 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>{t("date")}</Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {todayAvailable && (
            <Chip
              label={t("today")}
              size="small"
              variant={date === today() ? "filled" : "outlined"}
              color={date === today() ? "primary" : "default"}
              onClick={() => setDate(today())}
              sx={{ fontSize: 11 }}
            />
          )}
          {yesterdayInRange && (
            <Chip
              label={t("yesterday")}
              size="small"
              variant={date === yesterday() ? "filled" : "outlined"}
              color={date === yesterday() ? "primary" : "default"}
              onClick={() => setDate(yesterday())}
              sx={{ fontSize: 11 }}
            />
          )}
          <TextField
            type="date"
            size="small"
            value={date}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value);
            }}
            slotProps={{
              input: { sx: { fontSize: 12, py: 0.25 } },
              htmlInput: { max: maxDate, min: minDate },
            }}
            sx={{ flex: 1, minWidth: 120 }}
          />
        </Box>
      </Box>
      {/* Colorbar legend (data layers only) */}
      {layerCap?.legend && (
        <Box sx={{ mb: 1.5 }}>
          <Box
            component="img"
            src={`${env.apiUrl}/api/integrations/overlay-satellite/legends/${layerCap.legend}`}
            alt={t(GIBS_LAYERS.find((l) => l.id === activeLayer)?.labelKey ?? "layer")}
            sx={{ width: "100%", height: "auto", borderRadius: "4px" }}
          />
        </Box>
      )}
      {/* Opacity slider */}
      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.25 }}>
          {t("opacity")} {Math.round(opacity * 100)}%
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={(_, v) => setOpacity(v as number)}
          sx={{ py: 0.5 }}
        />
      </Box>
    </OverlayLegend>
  );
}
