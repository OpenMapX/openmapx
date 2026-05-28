"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { useEarthquakeStore } from "./store";

const TIME_RANGES = ["hour", "day", "week", "month"] as const;
const MAG_PRESETS = [
  { label: "M2.5+", value: 2.5 },
  { label: "M4.5+", value: 4.5 },
  { label: "M6+", value: 6.0 },
  { label: "All", value: 0 },
] as const;

const DEPTH_LEGEND = [
  { label: "0–33 km", color: "#ff4500" },
  { label: "33–70", color: "#ff8c00" },
  { label: "70–150", color: "#ffd700" },
  { label: "150–300", color: "#32cd32" },
  { label: "300–500", color: "#1e90ff" },
  { label: "500+", color: "#8b00ff" },
] as const;

const RECENCY_LEGEND = [
  { labelKey: "lessThan1h", color: "#ef4444" },
  { labelKey: "1to24h", color: "#f97316" },
  { labelKey: "1to7d", color: "#eab308" },
  { labelKey: "7to30d", color: "#94a3b8" },
] as const;

const MAG_SIZES = [
  { label: "M2", size: 6 },
  { label: "M5", size: 16 },
  { label: "M7+", size: 30 },
] as const;

export function EarthquakeLegend() {
  const t = useTranslations("earthquakes");
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-earthquakes");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const panelOpen = useEarthquakeStore((s) => s.panelOpen);
  const layerVisible = useEarthquakeStore((s) => s.layerVisible);
  const loading = useEarthquakeStore((s) => s.loading);
  const timeRange = useEarthquakeStore((s) => s.timeRange);
  const minMagnitude = useEarthquakeStore((s) => s.minMagnitude);
  const colorMode = useEarthquakeStore((s) => s.colorMode);
  const showHeatmap = useEarthquakeStore((s) => s.showHeatmap);
  const lastUpdated = useEarthquakeStore((s) => s.lastUpdated);
  const setLayerVisible = useEarthquakeStore((s) => s.setLayerVisible);
  const setTimeRange = useEarthquakeStore((s) => s.setTimeRange);
  const setMinMagnitude = useEarthquakeStore((s) => s.setMinMagnitude);
  const setColorMode = useEarthquakeStore((s) => s.setColorMode);
  const setShowHeatmap = useEarthquakeStore((s) => s.setShowHeatmap);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        overflow: "hidden",
        maxWidth: "calc(100vw - 24px)",
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
      <Box
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.75 }}
      >
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("earthquakes")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>
      <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("timeRange")}
          </Typography>
          <ToggleButtonGroup
            value={timeRange}
            exclusive
            onChange={(_, val) => val && setTimeRange(val)}
            size="small"
            sx={{ height: 26 }}
          >
            {TIME_RANGES.map((r) => (
              <ToggleButton
                key={r}
                value={r}
                sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
              >
                {t(r)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("magnitude")}
          </Typography>
          <ToggleButtonGroup
            value={minMagnitude}
            exclusive
            onChange={(_, val) => val !== null && setMinMagnitude(val)}
            size="small"
            sx={{ height: 26 }}
          >
            {MAG_PRESETS.map((p) => (
              <ToggleButton
                key={p.value}
                value={p.value}
                sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
              >
                {p.label === "All" ? t("all") : p.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("colorBy")}
          </Typography>
          <ToggleButtonGroup
            value={colorMode}
            exclusive
            onChange={(_, val) => val && setColorMode(val)}
            size="small"
            sx={{ height: 26 }}
          >
            <ToggleButton
              value="depth"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t("depth")}
            </ToggleButton>
            <ToggleButton
              value="recency"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t("recency")}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", pt: 1.5 }}>
          <FormControlLabel
            label={<Typography sx={{ fontSize: 10.5 }}>{t("heatmap")}</Typography>}
            control={
              <Switch
                size="small"
                checked={showHeatmap}
                onChange={(e) => setShowHeatmap(e.target.checked)}
                sx={{ mr: 0.5 }}
              />
            }
            sx={{ m: 0 }}
          />
        </Box>
      </Box>
      <Box sx={{ display: "flex", gap: 2, mt: 0.75, alignItems: "flex-start" }}>
        <Box>
          <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
            {colorMode === "depth" ? t("depthScale") : t("recencyScale")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.75 }}>
            {colorMode === "depth"
              ? DEPTH_LEGEND.map((d) => (
                  <Box
                    key={d.label}
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 0.25,
                    }}
                  >
                    <Box
                      sx={{
                        width: 20,
                        height: 10,
                        borderRadius: "2px",
                        bgcolor: d.color,
                      }}
                    />
                    <Typography sx={{ fontSize: 9, lineHeight: 1.2 }}>{d.label}</Typography>
                  </Box>
                ))
              : RECENCY_LEGEND.map((r) => (
                  <Box
                    key={r.labelKey}
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 0.25,
                    }}
                  >
                    <Box
                      sx={{
                        width: 20,
                        height: 10,
                        borderRadius: "2px",
                        bgcolor: r.color,
                      }}
                    />
                    <Typography sx={{ fontSize: 9, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                      {t(r.labelKey)}
                    </Typography>
                  </Box>
                ))}
          </Box>
        </Box>

        <Box>
          <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
            {t("magnitudeSize")}
          </Typography>
          <Box sx={{ display: "flex", gap: 1, alignItems: "flex-end" }}>
            {MAG_SIZES.map((m) => (
              <Box
                key={m.label}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.25,
                }}
              >
                <Box
                  sx={{
                    width: m.size,
                    height: m.size,
                    borderRadius: "50%",
                    bgcolor: "#ef4444",
                    border: "1.5px solid var(--omx-overlay-bg)",
                    boxShadow: "0 0 0 0.5px var(--omx-shadow-soft)",
                  }}
                />
                <Typography sx={{ fontSize: 9, lineHeight: 1.2 }}>{m.label}</Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
      <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.75 }}>
        {lastUpdated &&
          t("lastUpdated", {
            time: new Date(lastUpdated).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
      </Typography>
      {attributionHtml && (
        <Typography
          variant="caption"
          dangerouslySetInnerHTML={{ __html: attributionHtml }}
          sx={{
            color: "text.secondary",
            mt: 0.5,
          }}
        />
      )}
    </Paper>
  );
}
