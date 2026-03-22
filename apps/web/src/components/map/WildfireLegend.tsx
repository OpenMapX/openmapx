"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useWildfireStore } from "@openmapx/core";
import { useTranslations } from "next-intl";

const DAY_RANGES = [1, 2, 3] as const;

const RECENCY_LEGEND = [
  { labelKey: "lessThan1h", color: "#ef4444" },
  { labelKey: "1to6h", color: "#f97316" },
  { labelKey: "6to12h", color: "#fb923c" },
  { labelKey: "12to24h", color: "#fbbf24" },
  { labelKey: "1to2d", color: "#fcd34d" },
  { labelKey: "2to3d", color: "#fde68a" },
] as const;

const FRP_SIZES = [
  { label: "< 10", size: 5 },
  { label: "50", size: 10 },
  { label: "500+", size: 20 },
] as const;

export function WildfireLegend() {
  const t = useTranslations("wildfires");
  const panelOpen = useWildfireStore((s) => s.panelOpen);
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const loading = useWildfireStore((s) => s.loading);
  const dayRange = useWildfireStore((s) => s.dayRange);
  const source = useWildfireStore((s) => s.source);
  const showHeatmap = useWildfireStore((s) => s.showHeatmap);
  const lastUpdated = useWildfireStore((s) => s.lastUpdated);
  const setLayerVisible = useWildfireStore((s) => s.setLayerVisible);
  const setDayRange = useWildfireStore((s) => s.setDayRange);
  const setSource = useWildfireStore((s) => s.setSource);
  const setShowHeatmap = useWildfireStore((s) => s.setShowHeatmap);

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
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("wildfires")}</Typography>
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
            {t("dayRange")}
          </Typography>
          <ToggleButtonGroup
            value={dayRange}
            exclusive
            onChange={(_, val) => val !== null && setDayRange(val)}
            size="small"
            sx={{ height: 26 }}
          >
            {DAY_RANGES.map((d) => (
              <ToggleButton
                key={d}
                value={d}
                sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
              >
                {t("nDays", { count: d })}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
            {t("sensor")}
          </Typography>
          <ToggleButtonGroup
            value={source}
            exclusive
            onChange={(_, val) => val && setSource(val)}
            size="small"
            sx={{ height: 26 }}
          >
            <ToggleButton
              value="VIIRS_SNPP_NRT"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              VIIRS 375m
            </ToggleButton>
            <ToggleButton
              value="MODIS_NRT"
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              MODIS 1km
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
            {t("recencyScale")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.75 }}>
            {RECENCY_LEGEND.map((r) => (
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
            {t("frpSize")}
          </Typography>
          <Box sx={{ display: "flex", gap: 1, alignItems: "flex-end" }}>
            {FRP_SIZES.map((f) => (
              <Box
                key={f.label}
                sx={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.25,
                }}
              >
                <Box
                  sx={{
                    width: f.size,
                    height: f.size,
                    borderRadius: "50%",
                    bgcolor: "#ef4444",
                    border: "1.5px solid #fff",
                    boxShadow: "0 0 0 0.5px rgba(0,0,0,0.15)",
                  }}
                />
                <Typography sx={{ fontSize: 9, lineHeight: 1.2 }}>{f.label}</Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.75 }}>
        {t("attribution")} ·{" "}
        {lastUpdated &&
          t("lastUpdated", {
            time: new Date(lastUpdated).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}{" "}
        ·{" "}
        <a
          href="https://firms.modaps.eosdis.nasa.gov/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          NASA FIRMS
        </a>
      </Typography>
    </Paper>
  );
}
